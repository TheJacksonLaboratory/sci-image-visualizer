import type { Layer, SurfaceLayer, Viewer } from 'napari-js';

import type { Cells3dStatus } from '../../contracts/display-types';
import type { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import type { CellsMesh } from '../../geometry/cell-meshes';
import type { RegionSource } from '../../region-source/region-source';
import { regionTilesInRect } from '../../region-source/region-tiles';
import { reconstructCellsInWorker } from '../../region-source/worker-region-source';
import { cellOutlinesFromTiles, observationIndex } from '../../spatial/plane-cells';
import { typicalCellDiameter } from '../../spatial/lod';
import { datasetRegionSet } from '../../visualizer/spatial-region-set';
import { PlanePlacement, toWorld } from './napari-volume-region-meshes';

/**
 * A 3D segmentation's cells in the spatial 3D view, each reconstructed by itself (see
 * `geometry/cell-meshes`), where the region classes are otherwise one merged surface per class.
 *
 * Built to stay out of the way of the UI thread and the GPU:
 *  - the space is cut into chunks (a grid over the region set's bounds); each chunk is one surface
 *    layer of its cells, meshed in the cells' own worker, a few hundred cells per call, so the
 *    work is cancelled between calls when the view moves on (and the region tiles the 2D view
 *    reads never wait behind it);
 *  - level of detail by chunk: a coarse mesh everywhere first, then the chunks on screen are meshed
 *    finer as the camera comes close, within a triangle budget for the whole scene; the region
 *    set's tiles are read at the level of detail that mesh needs;
 *  - at most {@link CELLS_3D_MAX_CELLS} cells, the chunks nearest the centre of the view first;
 *    the status says when cells are left out, so the view never claims to show them all;
 *  - colour and visibility change no geometry: colours are per vertex (each vertex's cell), and a
 *    hidden cell's triangles are left out of what is drawn.
 * Builds report on the canvas's loading badge.
 */

/** The most cells drawn at once. */
export const CELLS_3D_MAX_CELLS = 20_000;
/** The most triangles every chunk together may have. */
export const CELLS_3D_TRIANGLE_BUDGET = 3_000_000;
/** Chunks across the longer side of the region set's bounds. */
const CHUNKS_ACROSS = 8;
/** Cells per worker call: the build can be dropped between calls. */
const BATCH = 400;
/** A pause in the camera's movement this long re-plans the detail. */
const CAMERA_IDLE_MS = 250;
/** A voxel at least this many screen pixels across is detail enough. */
const MIN_VOXEL_PX = 3;
/** Each tier's voxel edge, as a fraction of a cell's diameter: coarse to fine. */
const TIER_FRACTIONS = [1 / 4, 1 / 8, 1 / 16] as const;
/** A first guess at a coarse cell's triangles, before any chunk was built. */
const COARSE_TRIANGLES_PER_CELL = 300;

export interface Cells3dHost {
  readonly viewer: Viewer;
  readonly port: SpatialDataPort | null;
  /** Show the cells loading on the canvas until the returned function is called. */
  beginTask(label: 'Cells'): () => void;
  status(status: Cells3dStatus | null): void;
}

interface Chunk {
  key: string;
  /** Image px. */
  box: [number, number, number, number];
  /** The tier built (-1: none), and wanted by the last plan (-1: none, out of the cap). */
  tier: number;
  want: number;
  /** Cells it has (-1 until built), and its triangles by tier built. */
  cells: number;
  triangles: Map<number, number>;
  mesh: CellsMesh | null;
  /** Each meshed cell's class. */
  labels: Map<number, string | null>;
  world: Float32Array | null;
  /** The triangles drawn (the visible cells'), as indices into the mesh's vertices. */
  drawn: Uint32Array | null;
  layer: SurfaceLayer | null;
}

export type { Cells3dStatus };

export class Spatial3dCells {
  private dataset: SpatialDataset | null = null;
  private source: { id: string; open: Promise<RegionSource> } | null = null;
  private classes: ReadonlySet<string> | null = null;
  private hidden: ReadonlySet<string> = new Set();
  private colors: Float32Array | null = null;
  private visible: Uint8Array | null = null;
  private opacity = 1;
  private placement: PlanePlacement | null = null;
  private zScale = 1;
  private chunks: Chunk[] = [];
  private readonly byLayer = new Map<Layer, Chunk>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cameraOff: (() => void) | null;

  constructor(private readonly host: Cells3dHost) {
    this.cameraOff = host.viewer.camera3d.changed.connect(() => this.schedule(CAMERA_IDLE_MS));
  }

  /** The dataset whose region set the cells are read from. */
  setDataset(dataset: SpatialDataset | null): void {
    if (dataset === this.dataset) return;
    const id = datasetRegionSet(dataset);
    const sameSet = !!id && id === this.source?.id && dataset?.id === this.dataset?.id;
    this.dataset = dataset;
    if (sameSet) return;
    this.reset();
    this.closeSource();
    if (id && this.host.port?.openRegionSet) {
      const open = this.host.port.openRegionSet(id);
      this.source = { id, open };
      open.catch(() => {
        if (this.source?.open === open) this.source = null;
      });
    }
    this.schedule(0);
  }

  /** The classes drawn as cells (none: the cells are not drawn). */
  setClasses(classes: ReadonlySet<string> | null): void {
    const next = classes?.size ? classes : null;
    if (sameSet(next, this.classes)) return;
    this.classes = next;
    this.reset();
    this.schedule(0);
  }

  /** Classes hidden (the Region Editor's eyes): their cells are left out of what is drawn. */
  setHiddenClasses(classes: readonly string[]): void {
    const next = new Set(classes);
    if (sameSet(next, this.hidden)) return;
    this.hidden = next;
    this.redraw();
  }

  /**
   * Each observation's colour (RGBA 0..1) and whether it is shown (null: all), and the surfaces'
   * opacity: the panel's Cell Color, groups and selection. Changes no geometry.
   */
  setStyle(colors: Float32Array | null, visible: Uint8Array | null, opacity: number): void {
    this.colors = colors;
    this.visible = visible;
    this.opacity = opacity;
    this.redraw();
  }

  /** Where the planes are among the observations (null: nowhere, nothing drawn), and the Z stretch. */
  setPlacement(placement: PlanePlacement | null, zScale: number): void {
    const moved = !samePlacement(placement, this.placement);
    this.placement = placement;
    this.zScale = zScale;
    for (const c of this.chunks) if (c.layer) c.layer.scale3d = [1, 1, zScale];
    if (!moved) return;
    for (const c of this.chunks) c.world = null;
    if (!placement) {
      for (const c of this.chunks) this.dropLayer(c);
    } else {
      this.redraw();
    }
    this.schedule(0);
  }

  /** The observation of the cell drawn under canvas point (`x`, `y`) (CSS px), or -1. */
  pick(x: number, y: number): number {
    if (!this.byLayer.size) return -1;
    const hit = this.host.viewer.pickSurface(x, y, { pickable: (l) => this.byLayer.has(l) });
    const chunk = hit ? this.byLayer.get(hit.layer) : undefined;
    if (!hit || !chunk?.drawn || !chunk.mesh) return -1;
    const vertex = chunk.drawn[hit.face * 3];
    return vertex === undefined ? -1 : chunk.mesh.vertexCell[vertex];
  }

  /** Whether `layer` is one of the cells' surfaces. */
  owns(layer: Layer): boolean {
    return this.byLayer.has(layer);
  }

  dispose(): void {
    this.cameraOff?.();
    this.cameraOff = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.reset();
    this.closeSource();
    this.emit(null);
  }

  // ── planning ──────────────────────────────────────────────────────────────────────

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.plan();
    }, delay);
  }

  /** Drop every chunk (their layers) and any build in flight. */
  private reset(): void {
    this.generation++;
    for (const c of this.chunks) this.dropLayer(c);
    this.chunks = [];
  }

  private closeSource(): void {
    const s = this.source;
    this.source = null;
    void s?.open.then(
      (src) => src.dispose(),
      () => undefined,
    );
  }

  /** Decide each chunk's detail (and whether it is drawn at all), then build what changed. */
  private async plan(): Promise<void> {
    const dataset = this.dataset;
    const index = dataset ? observationIndex(dataset.observations) : null;
    if (!this.classes || !this.source || !dataset || !index || !this.placement) {
      if (this.chunks.length) this.reset();
      this.emit(null);
      return;
    }
    const generation = this.generation;
    let source: RegionSource;
    try {
      source = await this.source.open;
    } catch (err) {
      console.warn("[napari-js] the cells' region set could not be opened", err);
      this.emit(null);
      return;
    }
    if (generation !== this.generation) return;
    if (!this.chunks.length) this.chunks = makeChunks(source);
    const steps = this.steps(dataset);
    const order = this.priority();
    this.assignTiers(order, steps);
    for (const c of this.chunks) if (c.want < 0) this.dropLayer(c);
    this.report(false);
    if (!this.running) void this.run(source, index, steps);
  }

  /** Voxel edge of each tier, image px: fractions of a typical cell's diameter. */
  private steps(dataset: SpatialDataset): number[] {
    const sx = dataset.imageRef?.scale?.[0] ?? 1;
    const d = Math.max(4, typicalCellDiameter(dataset.observations.radius) * Math.abs(sx || 1));
    return TIER_FRACTIONS.map((f) => Math.max(1, d * f));
  }

  /**
   * The chunks, nearest the centre of the view first, with how many screen pixels an image pixel
   * of each takes (0 off screen).
   */
  private priority(): { chunk: Chunk; ppi: number; onScreen: boolean; d2: number }[] {
    const viewer = this.host.viewer;
    const [vw, vh] = viewer.viewportSize();
    const pts = new Float32Array(this.chunks.length * 6);
    const zMid = this.placement ? midZ(this.placement) : 0;
    this.chunks.forEach((c, i) => {
      const [x0, y0, x1, y1] = c.box;
      const cy = (y0 + y1) / 2;
      const a = this.toWorldPoint((x0 + x1) / 2, cy, zMid);
      const b = this.toWorldPoint(x1, cy, zMid);
      pts.set(a, i * 6);
      pts.set(b, i * 6 + 3);
    });
    const proj = vw > 0 && vh > 0 ? viewer.projectPoints(pts) : null;
    const out = this.chunks.map((chunk, i) => {
      const sx = proj?.screen[i * 4] ?? NaN;
      const sy = proj?.screen[i * 4 + 1] ?? NaN;
      const ex = proj?.screen[i * 4 + 2] ?? NaN;
      const ey = proj?.screen[i * 4 + 3] ?? NaN;
      const half = Math.hypot(ex - sx, ey - sy);
      const width = (chunk.box[2] - chunk.box[0]) / 2;
      const ppi = Number.isFinite(half) && width > 0 ? half / width : 0;
      const onScreen =
        Number.isFinite(sx) && sx > -half && sx < vw + half && sy > -half && sy < vh + half && ppi > 0;
      const d2 = Number.isFinite(sx) ? (sx - vw / 2) ** 2 + (sy - vh / 2) ** 2 : Number.MAX_VALUE;
      return { chunk, ppi: onScreen ? ppi : 0, onScreen, d2 };
    });
    return out.sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.d2 - b.d2);
  }

  /** Each chunk's tier: in order, within the cell cap, as fine as the screen asks within the budget. */
  private assignTiers(order: { chunk: Chunk; ppi: number }[], steps: number[]): void {
    const known = this.chunks.filter((c) => c.cells >= 0);
    const avgCells = known.length ? known.reduce((s, c) => s + c.cells, 0) / known.length : 200;
    let cells = 0;
    const included: { chunk: Chunk; tier: number }[] = [];
    for (const { chunk, ppi } of order) {
      const n = chunk.cells >= 0 ? chunk.cells : avgCells;
      if (cells + n > CELLS_3D_MAX_CELLS && included.length) {
        chunk.want = -1;
        continue;
      }
      cells += n;
      let tier = 0;
      for (let t = steps.length - 1; t > 0; t--) {
        if (ppi * steps[t] >= MIN_VOXEL_PX) {
          tier = t;
          break;
        }
      }
      included.push({ chunk, tier });
    }
    // The budget: the chunks last in order give up their detail first.
    let total = included.reduce((s, e) => s + this.trianglesAt(e.chunk, e.tier, steps, avgCells), 0);
    for (let i = included.length - 1; i >= 0 && total > CELLS_3D_TRIANGLE_BUDGET; i--) {
      const e = included[i];
      while (e.tier > 0 && total > CELLS_3D_TRIANGLE_BUDGET) {
        total -=
          this.trianglesAt(e.chunk, e.tier, steps, avgCells) -
          this.trianglesAt(e.chunk, e.tier - 1, steps, avgCells);
        e.tier--;
      }
    }
    for (const e of included) e.chunk.want = e.tier;
  }

  /** A chunk's triangles at `tier`: as built, else scaled from a tier built (by the step's square). */
  private trianglesAt(chunk: Chunk, tier: number, steps: number[], avgCells: number): number {
    const at = chunk.triangles.get(tier);
    if (at !== undefined) return at;
    for (const [t, n] of chunk.triangles) return n * (steps[t] / steps[tier]) ** 2;
    const cells = chunk.cells >= 0 ? chunk.cells : avgCells;
    return cells * COARSE_TRIANGLES_PER_CELL * (steps[0] / steps[tier]) ** 2;
  }

  // ── building ──────────────────────────────────────────────────────────────────────

  /** Build every chunk whose tier changed, nearest first, one at a time, until none is left. */
  private async run(source: RegionSource, index: ReadonlyMap<string, number>, steps: number[]): Promise<void> {
    this.running = true;
    const end = this.host.beginTask('Cells');
    try {
      for (;;) {
        const generation = this.generation;
        const next = this.priority()
          .map((e) => e.chunk)
          .find((c) => c.want >= 0 && c.want !== c.tier);
        if (!next) break;
        this.report(true);
        try {
          await this.build(next, next.want, source, index, steps, generation);
        } catch (err) {
          console.warn('[napari-js] cells could not be built in 3D', err);
          next.want = next.tier; // not retried until the view asks again
        }
        if (generation !== this.generation) break;
      }
    } finally {
      end();
      this.running = false;
      this.report(false);
    }
  }

  private async build(
    chunk: Chunk,
    tier: number,
    source: RegionSource,
    index: ReadonlyMap<string, number>,
    steps: number[],
    generation: number,
  ): Promise<void> {
    const info = source.info;
    const step = steps[tier];
    const level = Math.max(0, Math.min(info.levels - 1, Math.floor(Math.log2(step))));
    // Tiles around the chunk: a cell crossing its edge is the chunk's its centre is in.
    const margin = steps[0] * 8;
    const [x0, y0, x1, y1] = chunk.box;
    const keys = regionTilesInRect(
      [x0 - margin, y0 - margin, x1 + margin, y1 + margin],
      level,
      info.tileSize,
      info.bounds,
    );
    const planes = await Promise.all(
      info.planes.map(async (z, slice) => ({
        slice,
        tiles: await Promise.all(keys.map((k) => source.getTile(z, k))),
      })),
    );
    if (generation !== this.generation) return;
    const cells = cellOutlinesFromTiles(planes, index, this.classes, chunk.box);
    const labels = new Map(cells.map((c) => [c.cell, c.label] as [number, string | null]));
    const parts: CellsMesh[] = [];
    for (let i = 0; i < cells.length; i += BATCH) {
      const batch = cells.slice(i, i + BATCH).map((c) => ({ cell: c.cell, slices: c.slices }));
      parts.push(await reconstructCellsInWorker(batch, { pixelStep: step }));
      if (generation !== this.generation) return;
    }
    const mesh = concatMeshes(parts);
    chunk.mesh = mesh;
    chunk.labels = labels;
    chunk.tier = tier;
    chunk.cells = mesh.cells.length;
    chunk.triangles.set(tier, mesh.faces.length / 3);
    chunk.world = null;
    this.draw(chunk);
  }

  // ── drawing ───────────────────────────────────────────────────────────────────────

  private redraw(): void {
    for (const c of this.chunks) if (c.mesh) this.draw(c);
    this.host.viewer.requestRender();
  }

  /** Draw a chunk's visible cells, in their colours: its layer updated in place, or added. */
  private draw(chunk: Chunk): void {
    const mesh = chunk.mesh;
    const placement = this.placement;
    if (!mesh || !placement || chunk.want < 0) {
      this.dropLayer(chunk);
      return;
    }
    chunk.world ??= toWorld(mesh.vertices, { size: [1, 1, 1], world: [1, 1, 1], planes: placement });
    const drawn = this.visibleFaces(chunk);
    chunk.drawn = drawn;
    const colors = this.vertexColors(mesh);
    if (!drawn.length) {
      if (chunk.layer) chunk.layer.visible = false;
      return;
    }
    if (chunk.layer) {
      chunk.layer.setData(chunk.world, drawn);
      chunk.layer.vertexColors = colors;
      chunk.layer.opacity = this.opacity;
      chunk.layer.visible = true;
    } else {
      const layer = this.host.viewer.addSurface(chunk.world, drawn, undefined, {
        name: `cells ${chunk.key}`,
        vertexColors: colors,
        opacity: this.opacity,
        blending: 'translucent',
        scale3d: [1, 1, this.zScale],
        fit: 'never',
      });
      chunk.layer = layer;
      this.byLayer.set(layer, chunk);
    }
  }

  /** The triangles of the cells shown: their class not hidden, the observation shown. */
  private visibleFaces(chunk: Chunk): Uint32Array {
    const mesh = chunk.mesh!;
    const { faces, vertexCell } = mesh;
    const visible = this.visible;
    const hidden = this.hidden;
    const shown = new Map<number, boolean>();
    const isShown = (cell: number) => {
      let s = shown.get(cell);
      if (s === undefined) {
        const label = chunk.labels.get(cell) ?? null;
        s = !(label !== null && hidden.has(label)) && (!visible || !!visible[cell]);
        shown.set(cell, s);
      }
      return s;
    };
    if (!hidden.size && !visible) return faces;
    const out = new Uint32Array(faces.length);
    let n = 0;
    for (let f = 0; f < faces.length; f += 3) {
      if (!isShown(vertexCell[faces[f]])) continue;
      out[n++] = faces[f];
      out[n++] = faces[f + 1];
      out[n++] = faces[f + 2];
    }
    return n === faces.length ? faces : out.slice(0, n);
  }

  /** Each vertex its cell's colour (white without colours). */
  private vertexColors(mesh: CellsMesh): Float32Array {
    const out = new Float32Array(mesh.vertexCell.length * 4);
    const colors = this.colors;
    for (let v = 0; v < mesh.vertexCell.length; v++) {
      const o = mesh.vertexCell[v] * 4;
      if (colors && o + 3 < colors.length) {
        out[v * 4] = colors[o];
        out[v * 4 + 1] = colors[o + 1];
        out[v * 4 + 2] = colors[o + 2];
        out[v * 4 + 3] = colors[o + 3];
      } else {
        out.fill(1, v * 4, v * 4 + 4);
      }
    }
    return out;
  }

  private dropLayer(chunk: Chunk): void {
    if (!chunk.layer) return;
    this.byLayer.delete(chunk.layer);
    this.host.viewer.layers.remove(chunk.layer);
    chunk.layer = null;
  }

  private report(building: boolean): void {
    if (!this.classes) {
      this.emit(null);
      return;
    }
    const drawn = this.chunks.filter((c) => c.layer && c.want >= 0);
    const shown = drawn.reduce((s, c) => s + Math.max(0, c.cells), 0);
    const capped = this.chunks.some((c) => c.want < 0);
    this.emit({ shown, capped, building: building || this.running });
  }

  /** Tell the host how the cells stand, only when that changed (the camera re-plans often). */
  private lastStatus = 'null';
  private emit(status: Cells3dStatus | null): void {
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.host.status(status);
  }

  private toWorldPoint(x: number, y: number, z: number): Float32Array {
    return this.placement
      ? toWorld(Float32Array.of(x, y, z), { size: [1, 1, 1], world: [1, 1, 1], planes: this.placement })
      : Float32Array.of(x, y, z);
  }
}

/** The chunk grid over a region set's bounds, {@link CHUNKS_ACROSS} along its longer side. */
function makeChunks(source: RegionSource): Chunk[] {
  const b = source.info.bounds;
  if (!b) return [];
  const size = Math.max(b[2] - b[0], b[3] - b[1]) / CHUNKS_ACROSS || 1;
  const out: Chunk[] = [];
  for (let y = b[1]; y < b[3]; y += size) {
    for (let x = b[0]; x < b[2]; x += size) {
      // The last chunk of a row (column) reaches past the bounds: a cell centred on them is in it.
      const x1 = x + size >= b[2] ? b[2] + 1 : x + size;
      const y1 = y + size >= b[3] ? b[3] + 1 : y + size;
      out.push({
        key: `${Math.round(x)},${Math.round(y)}`,
        box: [x, y, x1, y1],
        tier: -1,
        want: -1,
        cells: -1,
        triangles: new Map(),
        mesh: null,
        labels: new Map(),
        world: null,
        drawn: null,
        layer: null,
      });
    }
  }
  return out;
}

/** Meshes concatenated, each vertex keeping its cell. */
function concatMeshes(parts: readonly CellsMesh[]): CellsMesh {
  if (parts.length === 1) return parts[0];
  const nv = parts.reduce((s, p) => s + p.vertexCell.length, 0);
  const nf = parts.reduce((s, p) => s + p.faces.length, 0);
  const nc = parts.reduce((s, p) => s + p.cells.length, 0);
  const out: CellsMesh = {
    vertices: new Float32Array(nv * 3),
    faces: new Uint32Array(nf),
    vertexCell: new Uint32Array(nv),
    cells: new Uint32Array(nc),
  };
  let v = 0;
  let f = 0;
  let c = 0;
  for (const p of parts) {
    out.vertices.set(p.vertices, v * 3);
    out.vertexCell.set(p.vertexCell, v);
    for (let i = 0; i < p.faces.length; i++) out.faces[f + i] = p.faces[i] + v;
    out.cells.set(p.cells, c);
    v += p.vertexCell.length;
    f += p.faces.length;
    c += p.cells.length;
  }
  return out;
}

/** The middle of the planes' slice range (slice units). */
function midZ(p: PlanePlacement): number {
  return (p.z.length - 1) / 2;
}

function sameSet(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function samePlacement(a: PlanePlacement | null, b: PlanePlacement | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.z.length !== b.z.length) return false;
  return (
    a.z.every((v, i) => v === b.z[i]) &&
    a.scale.every((v, i) => v === b.scale[i]) &&
    a.offset.every((v, i) => v === b.offset[i])
  );
}
