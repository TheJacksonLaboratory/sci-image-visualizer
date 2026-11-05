import type { Layer, SurfaceLayer, Viewer } from 'napari-js';

import type { Cells3dStatus } from '../../contracts/display-types';
import type { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import type { CellsMesh } from '../../geometry/cell-meshes';
import type { RegionSource } from '../../region-source/region-source';
import { regionTilesInRect } from '../../region-source/region-tiles';
import { placeInWorker, reconstructCellsInWorker } from '../../region-source/worker-region-source';
import { cellOutlinesFromTiles, observationIndex } from '../../spatial/plane-cells';
import { typicalCellDiameter } from '../../spatial/lod';
import { datasetRegionSet } from '../../visualizer/spatial-region-set';
import { PlanePlacement, REGION_MESH_DIMMED_OPACITY, toWorld } from './napari-volume-region-meshes';

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
 *  - at most {@link CELLS_3D_MAX_CELLS} cells and {@link CELLS_3D_TRIANGLE_BUDGET} triangles, the
 *    chunks nearest the centre of the view first (one chunk over either by itself is meshed in
 *    part), planned again as each chunk's real size is learnt; the status says when cells are left
 *    out, so the view never claims to show them all;
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
/** A redraw yields the main thread after this long. */
const REDRAW_SLICE_MS = 8;
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
  /** The most cells it may mesh (the cap, or the budget, left for it; Infinity: all). */
  limit: number;
  /** The limit it was built with, and the cells it meshed (-1 until built). */
  builtLimit: number;
  meshed: number;
  mesh: CellsMesh | null;
  /** Each meshed cell's class. */
  labels: Map<number, string | null>;
  world: Float32Array | null;
  /**
   * The triangles drawn in {@link layer} (the visible cells', or with a selection those it leaves
   * out), as indices into the mesh's vertices.
   */
  drawn: Uint32Array | null;
  layer: SurfaceLayer | null;
  /**
   * With a selection, its cells' triangles, drawn in {@link selectedLayer}: an opaque surface of
   * their own, so the faded cells in front of them (a translucent surface draws only its nearest
   * faces) show them through rather than hide them.
   */
  drawnSelected: Uint32Array | null;
  selectedLayer: SurfaceLayer | null;
  /** The placement in flight (its mesh and where it places it), if any. */
  placing?: { mesh: CellsMesh; placement: PlanePlacement } | null;
}

export type { Cells3dStatus };

export class Spatial3dCells {
  private dataset: SpatialDataset | null = null;
  private source: { id: string; open: Promise<RegionSource> } | null = null;
  private classes: ReadonlySet<string> | null = null;
  private hidden: ReadonlySet<string> = new Set();
  private colors: Float32Array | null = null;
  private visible: Uint8Array | null = null;
  /** The selection (null: none): the cells it leaves out fade, keeping their colours. */
  private selected: Uint8Array | null = null;
  private opacity = 1;
  private placement: PlanePlacement | null = null;
  private zScale = 1;
  private chunks: Chunk[] = [];
  private readonly byLayer = new Map<Layer, Chunk>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  /** Each surface's geometry as last set: a recolour that leaves it so uploads none again. */
  private readonly installed = new WeakMap<SurfaceLayer, { world: Float32Array; faces: Uint32Array }>();
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
  setStyle(
    colors: Float32Array | null,
    visible: Uint8Array | null,
    opacity: number,
    selected: Uint8Array | null = null,
  ): void {
    this.colors = colors;
    this.visible = visible;
    this.opacity = opacity;
    this.selected = selected;
    this.redraw();
  }

  /** Where the planes are among the observations (null: nowhere, nothing drawn), and the Z stretch. */
  setPlacement(placement: PlanePlacement | null, zScale: number): void {
    const moved = !samePlacement(placement, this.placement);
    // The same placement kept as it was (a scene passes a new object each time): a placement in
    // flight for it is still good when it lands.
    if (moved) this.placement = placement;
    this.zScale = zScale;
    for (const c of this.chunks) {
      if (c.layer) c.layer.scale3d = [1, 1, zScale];
      if (c.selectedLayer) c.selectedLayer.scale3d = [1, 1, zScale];
    }
    if (!moved) return;
    for (const c of this.chunks) {
      c.world = null;
      c.placing = null; // one in flight was for the old placement: it is dropped when it lands
    }
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
    const faces = hit && chunk && hit.layer === chunk.selectedLayer ? chunk.drawnSelected : chunk?.drawn;
    if (!hit || !faces || !chunk?.mesh) return -1;
    const vertex = faces[hit.face * 3];
    return vertex === undefined ? -1 : chunk.mesh.vertexCell[vertex];
  }

  /** Whether `layer` is one of the cells' surfaces. */
  owns(layer: Layer): boolean {
    return this.byLayer.has(layer);
  }

  dispose(): void {
    this.disposed = true;
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
    if (this.disposed) return;
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
    this.replanTiers(steps);
    this.report(false);
    if (!this.running) void this.run(source, index, steps);
  }

  /** {@link assignTiers} from the view as it is now, taking down what it leaves out. */
  private replanTiers(steps: number[]): void {
    this.assignTiers(this.priority(), steps);
    for (const c of this.chunks) if (c.want < 0) this.dropLayer(c);
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

  /**
   * Each chunk's tier: in order, within the cell cap, as fine as the screen asks within the
   * triangle budget. The chunks last in order give up their detail first, then are left out; the
   * first is never left out, but one over the cap or the budget by itself meshes only the cells
   * that fit (its {@link Chunk.limit}).
   */
  private assignTiers(order: { chunk: Chunk; ppi: number }[], steps: number[]): void {
    const known = this.chunks.filter((c) => c.cells >= 0);
    const avgCells = known.length ? known.reduce((s, c) => s + c.cells, 0) / known.length : 200;
    let cells = 0;
    const included: { chunk: Chunk; tier: number; take: number; room: number }[] = [];
    for (const { chunk, ppi } of order) {
      const n = chunk.cells >= 0 ? chunk.cells : avgCells;
      const room = CELLS_3D_MAX_CELLS - cells;
      if (n > room && included.length) {
        chunk.want = -1;
        continue;
      }
      const take = Math.min(n, room);
      cells += take;
      let tier = 0;
      for (let t = steps.length - 1; t > 0; t--) {
        if (ppi * steps[t] >= MIN_VOXEL_PX) {
          tier = t;
          break;
        }
      }
      included.push({ chunk, tier, take, room });
    }
    const triangles = (e: { chunk: Chunk; tier: number }) => this.trianglesAt(e.chunk, e.tier, steps, avgCells);
    // The budget: the chunks last in order give up their detail first, then their place.
    let total = included.reduce((s, e) => s + triangles(e), 0);
    for (let i = included.length - 1; i >= 0 && total > CELLS_3D_TRIANGLE_BUDGET; i--) {
      const e = included[i];
      while (e.tier > 0 && total > CELLS_3D_TRIANGLE_BUDGET) {
        total -= triangles(e) - triangles({ chunk: e.chunk, tier: e.tier - 1 });
        e.tier--;
      }
    }
    while (included.length > 1 && total > CELLS_3D_TRIANGLE_BUDGET) {
      const e = included.pop()!;
      total -= triangles(e);
      e.chunk.want = -1;
    }
    for (const e of included) {
      const n = e.chunk.cells >= 0 ? e.chunk.cells : avgCells;
      let take = e.take;
      // The first chunk alone over the budget, at its coarsest: as many cells as fit in it.
      const all = triangles(e);
      if (all > CELLS_3D_TRIANGLE_BUDGET) {
        const perCell = all / Math.max(1, e.chunk.meshed > 0 ? e.chunk.meshed : n);
        take = Math.min(take, CELLS_3D_TRIANGLE_BUDGET / perCell);
      }
      e.chunk.want = e.tier;
      // Cut short when over; and one not built yet, which may have more cells than the guess, to
      // the room the cap leaves it.
      const most = take < n ? take : e.chunk.cells < 0 ? e.room : Infinity;
      e.chunk.limit = Number.isFinite(most) ? Math.max(1, Math.floor(most)) : Infinity;
    }
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
    let stale = false;
    const end = this.host.beginTask('Cells');
    try {
      for (;;) {
        const generation = this.generation;
        const next = this.priority()
          .map((e) => e.chunk)
          .find((c) => needsBuild(c));
        if (!next) break;
        this.report(true);
        try {
          await this.build(next, next.want, source, index, steps, generation);
        } catch (err) {
          console.warn('[napari-js] cells could not be built in 3D', err);
          next.want = next.tier; // not retried until the view asks again
        }
        if (generation !== this.generation) {
          // Superseded (other classes, another dataset): the plan made for those found this run
          // still going and started none of its own. Plan again, now that it has stopped.
          stale = true;
          break;
        }
        // The chunk's real size is known now, where the plan guessed: plan again by it.
        this.replanTiers(steps);
      }
    } finally {
      end();
      this.running = false;
      this.report(false);
      if (stale) this.schedule(0);
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
    const found = cellOutlinesFromTiles(planes, index, this.classes, chunk.box);
    const limit = chunk.limit;
    const cells = found.length > limit ? found.slice(0, limit) : found;
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
    chunk.cells = found.length;
    chunk.meshed = mesh.cells.length;
    chunk.builtLimit = limit;
    chunk.triangles.set(tier, mesh.faces.length / 3);
    chunk.world = null;
    this.draw(chunk);
  }

  // ── drawing ───────────────────────────────────────────────────────────────────────

  /**
   * Draw every chunk again (a recolour, a hidden class, a selection): a few at a time, yielding the
   * main thread between them so that a click selecting a cell never holds a frame; a newer redraw
   * takes over from this one.
   */
  private redraw(): void {
    const generation = ++this.redrawGeneration;
    const chunks = this.chunks.filter((c) => c.mesh);
    void (async () => {
      let start = performance.now();
      for (const c of chunks) {
        if (generation !== this.redrawGeneration) return;
        this.draw(c);
        if (performance.now() - start > REDRAW_SLICE_MS) {
          this.host.viewer.requestRender();
          await new Promise((r) => setTimeout(r));
          start = performance.now();
        }
      }
      this.host.viewer.requestRender();
    })();
  }
  private redrawGeneration = 0;

  /** Place a chunk's vertices in the world, in the cells' worker, then draw it (unless superseded). */
  private placeChunk(chunk: Chunk, placement: PlanePlacement): void {
    const mesh = chunk.mesh;
    if (!mesh || (chunk.placing?.mesh === mesh && chunk.placing.placement === placement)) return;
    // This request's own token: one superseded (another mesh, or placement) is dropped when it
    // lands, without dropping the request that replaced it.
    const placing = { mesh, placement };
    chunk.placing = placing;
    placeInWorker(mesh.vertices, { size: [1, 1, 1], world: [1, 1, 1], planes: placement }).then(
      (world) => {
        if (chunk.placing !== placing) return;
        chunk.placing = null;
        if (chunk.mesh !== mesh || this.placement !== placement) return;
        chunk.world = world;
        this.draw(chunk);
        this.host.viewer.requestRender();
      },
      (err) => {
        if (chunk.placing === placing) chunk.placing = null;
        console.warn('[napari-js] cells could not be placed in 3D', err);
      },
    );
  }

  /** Draw a chunk's visible cells, in their colours: its layer updated in place, or added. */
  private draw(chunk: Chunk): void {
    const mesh = chunk.mesh;
    const placement = this.placement;
    if (!mesh || !placement || chunk.want < 0) {
      this.dropLayer(chunk);
      return;
    }
    if (!chunk.world) {
      // Placed off the main thread; drawn when it lands.
      this.placeChunk(chunk, placement);
      return;
    }
    const visible = this.visibleFaces(chunk);
    // With a selection, its cells in a surface of their own (see Chunk.selectedLayer).
    const [selected, rest] = this.selected
      ? splitFaces(visible, mesh.vertexCell, this.selected)
      : [new Uint32Array(0), visible];
    chunk.drawn = rest;
    chunk.drawnSelected = selected;
    chunk.layer = this.drawSurface(chunk, chunk.layer, rest, this.vertexColors(mesh), this.opacity, 'cells');
    chunk.selectedLayer = this.drawSurface(
      chunk,
      chunk.selectedLayer,
      selected,
      selected.length ? this.vertexColors(mesh, true) : null,
      1,
      'selected cells',
    );
  }

  /**
   * One of a chunk's surfaces with these triangles and colours: updated in place, added, or hidden
   * when it has none. Returns the layer (null: none was ever needed).
   */
  private drawSurface(
    chunk: Chunk,
    layer: SurfaceLayer | null,
    faces: Uint32Array,
    colors: Float32Array | null,
    opacity: number,
    name: string,
  ): SurfaceLayer | null {
    if (!faces.length || !colors || !chunk.world) {
      if (layer) layer.visible = false;
      return layer;
    }
    if (layer) {
      // A recolour, a new opacity: the geometry stays as uploaded.
      const had = this.installed.get(layer);
      if (!had || had.world !== chunk.world || !sameFaces(had.faces, faces)) {
        layer.setData(chunk.world, faces);
        this.installed.set(layer, { world: chunk.world, faces });
      }
      layer.vertexColors = colors;
      layer.opacity = opacity;
      layer.visible = true;
      return layer;
    }
    const added = this.host.viewer.addSurface(chunk.world, faces, undefined, {
      name: `${name} ${chunk.key}`,
      vertexColors: colors,
      opacity,
      blending: 'translucent',
      scale3d: [1, 1, this.zScale],
      fit: 'never',
    });
    this.byLayer.set(added, chunk);
    this.installed.set(added, { world: chunk.world, faces });
    return added;
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

  /**
   * Each vertex its cell's colour (white without colours). With a selection, a cell it leaves out
   * keeps its colour and fades, as a picked region fades the others: its alpha brought down to the
   * dimmed regions' opacity. `solid`: the selected cells' own surface, every vertex opaque.
   */
  private vertexColors(mesh: CellsMesh, solid = false): Float32Array {
    const out = new Float32Array(mesh.vertexCell.length * 4);
    const colors = this.colors;
    const selected = this.selected;
    const o = this.opacity > 0 ? this.opacity : 1;
    const dim = Math.min(1, REGION_MESH_DIMMED_OPACITY / o);
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
      if (solid) out[v * 4 + 3] = 1;
      else if (selected && !selected[mesh.vertexCell[v]]) out[v * 4 + 3] *= dim;
    }
    return out;
  }

  private dropLayer(chunk: Chunk): void {
    for (const layer of [chunk.layer, chunk.selectedLayer]) {
      if (!layer) continue;
      this.byLayer.delete(layer);
      this.host.viewer.layers.remove(layer);
    }
    chunk.layer = null;
    chunk.selectedLayer = null;
  }

  private report(building: boolean): void {
    if (!this.classes) {
      this.emit(null);
      return;
    }
    const drawn = this.chunks.filter((c) => c.layer && c.want >= 0);
    const shown = drawn.reduce((s, c) => s + Math.max(0, c.meshed), 0);
    const capped = this.chunks.some((c) => c.want < 0 || (c.want >= 0 && c.builtLimit < c.cells));
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
        limit: Infinity,
        builtLimit: Infinity,
        meshed: -1,
        mesh: null,
        labels: new Map(),
        world: null,
        drawn: null,
        drawnSelected: null,
        selectedLayer: null,
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

/**
 * Whether a chunk is to be built (again): its tier changed, or it was meshed in part and the plan
 * now lets it have more of its cells, or fewer.
 */
function needsBuild(c: Chunk): boolean {
  if (c.want < 0) return false;
  if (c.want !== c.tier) return true;
  return c.cells >= 0 && Math.min(c.builtLimit, c.cells) !== Math.min(c.limit, c.cells);
}

/** Whether two face lists are the same triangles. */
function sameFaces(a: Uint32Array, b: Uint32Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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

/**
 * Triangles `faces` split by whether their cell (`vertexCell` of their first vertex) is selected:
 * the selected cells' triangles, then the others'.
 */
export function splitFaces(
  faces: Uint32Array,
  vertexCell: Uint32Array,
  selected: Uint8Array,
): [Uint32Array, Uint32Array] {
  const sel = new Uint32Array(faces.length);
  const rest = new Uint32Array(faces.length);
  let s = 0;
  let r = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const out = selected[vertexCell[faces[f]]] ? sel : rest;
    const at = out === sel ? s : r;
    out[at] = faces[f];
    out[at + 1] = faces[f + 1];
    out[at + 2] = faces[f + 2];
    if (out === sel) s += 3;
    else r += 3;
  }
  return [sel.slice(0, s), rest.slice(0, r)];
}
