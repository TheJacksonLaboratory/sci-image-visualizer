import type { Points3DLayer, Viewer } from 'napari-js';

import { ALL_GENES, type SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../contracts/display-types';
import {
  NO_CATEGORY,
  NO_OBSERVATION,
  isCategoricalColumn,
  type SpatialDataset,
  type SpatialTranscriptTile,
} from '../../contracts/spatial-dataset.contract';
import {
  DEFAULT_CATEGORICAL_PALETTE,
  DEFAULT_MUTED_OPACITY,
  categoryColorsFor,
  parseHex,
} from '../../spatial/spatial-encoding';
import type { SpatialSelectionMask } from '../../spatial/spatial-selection';
import { allGeneShownBy, allGenesHidden } from '../../spatial/spatial-tile-merge';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import { clusterColorMap, clusterOfGene } from '../../spatial/transcript-grouping';
import { DataRect, tilesInRect, transcriptLevelFor } from '../../spatial/lod';
import { Supersede } from '../../util/supersede';

/** Most transcripts drawn in the 3D view: past it, every k-th one is drawn (and the console says so). */
export const TRANSCRIPTS_3D_MAX = 2_000_000;
/** Most level-0 tiles read for the 3D view: a dataset needing more is too large to draw whole. */
export const TRANSCRIPTS_3D_MAX_TILES = 4096;
/** Tile reads in flight at once. */
const CONCURRENCY = 8;
/** The camera resting this long plans the transcripts' detail again. */
const CAMERA_REST_MS = 300;
/** Transcript tiles kept read. */
const TILE_CACHE_SIZE = 1024;
/** Most tiles read for one view: past them, a coarser level. */
const VIEW_TILES_MAX = 256;
/** How far along a ray that never meets the section's plane its reach is taken (world units). */
const HORIZON = 1e6;
/** A transcript's marker in the 3D view, in screen pixels at a transcript scale of 1. */
export const TRANSCRIPT_3D_BASE_SIZE = 2;
/** A transcript with no colour by cell type (in no cell, or a cell in no group), as the 2D markers. */
const UNASSIGNED_RGBA = [0.62, 0.62, 0.62, 0.55] as const;

/** What the 3D transcripts need of the scene: where the cloud sits and how Z is stretched. */
export interface Transcripts3dFrame {
  /** Offset applied to observation coordinates to sit them in the scene's box. */
  origin: readonly [number, number, number];
  zScale: number;
}

/** The genes a view draws in 3D, as the tile query takes them, or null when it draws none. */
export function transcripts3dGenes(
  dataset: SpatialDataset,
  view: SpatialViewState,
): { query: string[]; allGenes: boolean } | null {
  if (view.transcriptMode === 'off') return null;
  if (view.transcriptAllGenes) {
    if (allGenesHidden(view)) return null;
    return { query: [ALL_GENES], allGenes: true };
  }
  const hidden = new Set(view.transcriptHiddenGenes);
  const genes = view.transcriptGenes.filter((g) => !hidden.has(g));
  return genes.length ? { query: genes, allGenes: false } : null;
}

/**
 * Each loaded transcript's colour, packed RGBA, as the 2D markers colour them by gene: a gene's
 * chosen colour, else the palette's by its slot (the selection's order, or with "All genes" the
 * dataset's gene code).
 */
export function transcripts3dColors(
  view: SpatialViewState,
  names: readonly string[] | null,
  gene: Uint16Array,
  count: number,
): Float32Array {
  const n = names ? names.length : DEFAULT_CATEGORICAL_PALETTE.length;
  const table = Array.from({ length: n }, (_g, i) =>
    rgba01(
      (names && view.transcriptGeneColors[names[i]]) ||
        DEFAULT_CATEGORICAL_PALETTE[i % DEFAULT_CATEGORICAL_PALETTE.length],
    ),
  );
  return packed(count, (i) => table[names ? gene[i] : gene[i] % n]);
}

/**
 * How the panel's "Colour by" applies in 3D, as it does to the 2D markers (`colorViewFor`): by
 * cell type when the dataset has one (else by gene), by cluster for the selected genes (with "All
 * genes" a cluster is its gene), by gene otherwise.
 */
export function transcripts3dColorBy(
  dataset: SpatialDataset,
  view: SpatialViewState,
  allGenes: boolean,
): 'cellType' | 'cluster' | 'gene' {
  const by = view.transcriptColorBy;
  if (by === 'cellType') return cellTypeColumnFor(dataset, view) ? 'cellType' : 'gene';
  if (by === 'cluster' && !allGenes) return 'cluster';
  return 'gene';
}

/** The colours the cells' grouping gives its groups, by name (none without a grouping). */
async function cellGroupColors(
  dataset: SpatialDataset,
  view: SpatialViewState,
  port: SpatialDataPort,
): Promise<{ codes: Uint16Array; colors: (readonly number[])[]; byName: Map<string, string> } | null> {
  const name = cellTypeColumnFor(dataset, view);
  if (!name) return null;
  const column = await port.getColumn(name);
  if (!isCategoricalColumn(column)) return null;
  const hex = categoryColorsFor(name, column.meta, view.groupColors);
  const byName = new Map(column.meta.categories.map((c, k) => [c, hex[k]] as const));
  return { codes: column.codes, colors: hex.map(rgba01), byName };
}

/** `#rrggbb` as an opaque 0..1 RGBA. */
function rgba01(hex: string): readonly number[] {
  const [r, g, b] = parseHex(hex);
  return [r / 255, g / 255, b / 255, 1];
}

/** `count` colours packed RGBA, unassigned where `at` has none. */
function packed(count: number, at: (i: number) => readonly number[] | undefined): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) out.set(at(i) ?? UNASSIGNED_RGBA, i * 4);
  return out;
}

/**
 * The transcripts of the 3D spatial view: the molecules of the genes the Transcripts panel draws
 * (its selected genes, or "All genes"), at their own x, y and z, in the cloud's box and Z stretch.
 *
 * By level of detail, as the 2D view reads them: the pyramid level the camera's distance calls for
 * (`transcriptLevelFor`, the markers per screen kept about constant: aggregates far out, every
 * molecule close in on a cell), and only the tiles of the part of the section in view (the canvas's
 * corners cast onto the section's plane). Planned again when the camera rests; tiles are cached, so
 * coming back reads nothing. "Loading transcripts…" shows on the canvas while they load and draw.
 * Drawn only for a dataset whose transcripts carry z.
 */
export class Spatial3dTranscripts {
  private layer: Points3DLayer | null = null;
  /** What {@link layer} was loaded from (dataset, genes, quality), and styled with. */
  private loadKey: string | null = null;
  private styleKey: string | null = null;
  private loaded: { tiles: SpatialTranscriptTile[]; names: readonly string[] | null } | null = null;
  private readonly loads = new Supersede();
  /** Each drawn transcript's cell ({@link NO_OBSERVATION} for none), for fading by the selection. */
  private drawnCells: Uint32Array | null = null;
  /** The selection the layer's alphas fade by (null: none, every transcript as it is). */
  private fadedBy: SpatialSelectionMask | null = null;
  /** The last sync's inputs: the camera resting plans the detail again from them. */
  private last: {
    dataset: SpatialDataset;
    view: SpatialViewState;
    port: SpatialDataPort | null;
    frame: Transcripts3dFrame;
    selection: SpatialSelectionMask | null;
  } | null = null;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraOff: (() => void) | null = null;
  /** Tiles read, by genes, quality, level and tile (least recently used dropped first). */
  private readonly tileCache = new Map<string, Promise<SpatialTranscriptTile>>();

  constructor(
    private readonly viewer: Viewer,
    private readonly begin: (message: string) => () => void,
  ) {
    this.cameraOff = viewer.camera3d?.changed?.connect(() => this.cameraMoved()) ?? null;
  }

  /** The camera moved: once it rests, read the level and tiles it now calls for. */
  private cameraMoved(): void {
    if (!this.last) return;
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.cameraTimer = setTimeout(() => {
      this.cameraTimer = null;
      const last = this.last;
      if (last) void this.sync(last.dataset, last.view, last.port, last.frame, last.selection);
    }, CAMERA_REST_MS);
  }

  /** Stop following the camera (the scene went away). */
  dispose(): void {
    this.cameraOff?.();
    this.cameraOff = null;
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.cameraTimer = null;
    this.last = null;
    this.remove();
  }

  /**
   * The level and the tiles the camera calls for: the level whose tiles come out about 512 screen
   * pixels across at the target's depth, the tiles of the section in view (whole, when a corner of
   * the canvas looks past the section's plane).
   */
  private plan(meta: NonNullable<SpatialDataset['transcriptTiles']>, frame: Transcripts3dFrame) {
    const [vw, vh] = this.viewer.viewportSize?.() ?? [0, 0];
    const camera = this.viewer.camera3d;
    const wpp = camera && vh > 0 ? camera.worldPerPixel(vh) : 0;
    let level = wpp > 0 ? transcriptLevelFor(1 / wpp, meta.levels) : meta.levels.length - 1;
    const [x0, y0, x1, y1] = meta.bounds;
    let rect: DataRect = { x0, y0, x1: x1 + 1e-6, y1: y1 + 1e-6 };
    const seen = vw > 0 && vh > 0 ? this.footprint(vw, vh, frame) : null;
    if (seen) rect = seen;
    // Close in but looking far across the section: coarser, until the tiles in view are few enough.
    let keys = tilesInRect(rect, level, meta.levels, meta.bounds);
    while (keys.length > VIEW_TILES_MAX && level < meta.levels.length - 1) {
      level++;
      keys = tilesInRect(rect, level, meta.levels, meta.bounds);
    }
    return { level, keys };
  }

  /**
   * The part of the section the canvas sees, in observation units: its corners and centre cast onto
   * the plane through the camera's target, widened by a quarter. A corner looking past the plane
   * (towards the horizon) reaches far along its ray instead (the tiles are clipped to the section).
   */
  private footprint(vw: number, vh: number, frame: Transcripts3dFrame): DataRect | null {
    const z = this.viewer.camera3d?.target?.[2];
    if (z === undefined || !this.viewer.canvasRay) return null;
    const [ox, oy] = frame.origin;
    let xa = Infinity,
      ya = Infinity,
      xb = -Infinity,
      yb = -Infinity;
    for (const [cx, cy] of [
      [0, 0],
      [vw, 0],
      [0, vh],
      [vw, vh],
      [vw / 2, vh / 2],
    ]) {
      const ray = this.viewer.canvasRay(cx, cy);
      if (!ray) return null;
      const hit = Math.abs(ray.dir[2]) > 1e-6 ? (z - ray.origin[2]) / ray.dir[2] : -1;
      const t = hit > 0 ? hit : HORIZON;
      const x = ray.origin[0] + ray.dir[0] * t - ox;
      const y = ray.origin[1] + ray.dir[1] * t - oy;
      xa = Math.min(xa, x);
      ya = Math.min(ya, y);
      xb = Math.max(xb, x);
      yb = Math.max(yb, y);
    }
    const mx = (xb - xa) / 4;
    const my = (yb - ya) / 4;
    return { x0: xa - mx, y0: ya - my, x1: xb + mx, y1: yb + my };
  }

  /** A tile, read once (and again only once dropped from the cache). */
  private tile(key: string, read: () => Promise<SpatialTranscriptTile>): Promise<SpatialTranscriptTile> {
    let hit = this.tileCache.get(key);
    if (hit) {
      this.tileCache.delete(key);
      this.tileCache.set(key, hit);
      return hit;
    }
    hit = read();
    hit.catch(() => this.tileCache.delete(key));
    this.tileCache.set(key, hit);
    while (this.tileCache.size > TILE_CACHE_SIZE)
      this.tileCache.delete(this.tileCache.keys().next().value as string);
    return hit;
  }

  /** The layer drawn, if any (for tests and the scene's Z stretch). */
  get drawn(): Points3DLayer | null {
    return this.layer;
  }

  /**
   * Draw what `view` asks for, loading the molecules when the genes changed. With a `selection`
   * (a cell, or a cell type's cells), the transcripts of the selected cells keep their colour and
   * the others fade, as the cells do.
   */
  async sync(
    dataset: SpatialDataset,
    view: SpatialViewState,
    port: SpatialDataPort | null,
    frame: Transcripts3dFrame,
    selection: SpatialSelectionMask | null = null,
  ): Promise<void> {
    const meta = dataset.transcriptTiles;
    const genes = meta?.hasZ && port?.getTranscriptTile ? transcripts3dGenes(dataset, view) : null;
    if (!meta || !genes || !port) {
      this.remove();
      return;
    }
    this.last = { dataset, view, port, frame, selection };
    const quality = view.transcriptQuality === 'all' ? 'all' : 'high';
    const { level, keys } = this.plan(meta, frame);
    const genesKey = `${dataset.id}|${genes.query.join('\u0001')}|${quality}`;
    const loadKey = `${genesKey}|${level}|${keys.map((k) => `${k.gx},${k.gy}`).join(';')}`;
    let end: (() => void) | null = null;
    if (loadKey !== this.loadKey) {
      const task = this.loads.next();
      if (keys.length > TRANSCRIPTS_3D_MAX_TILES) {
        console.warn(`[napari-js] ${keys.length} transcript tiles are too many to read for the 3D view`);
        this.remove();
        return;
      }
      end = this.begin('Loading transcripts…');
      let tiles: SpatialTranscriptTile[];
      try {
        tiles = await pooled(keys, CONCURRENCY, (k) =>
          this.tile(`${genesKey}|${level}/${k.gx}/${k.gy}`, () =>
            port.getTranscriptTile!(level, k.gx, k.gy, { genes: genes.query, quality }),
          ),
        );
      } catch (err) {
        console.warn('[napari-js] transcripts for the 3D view could not be read', err);
        // The panel asked for other transcripts than those drawn: take them down rather than leave
        // the old selection up as if it were the new one; the next change reads again. Only the
        // current load may: a superseded one must not tear down what a newer one drew.
        if (task()) this.clearLayer();
        end();
        return;
      }
      if (!task()) {
        end();
        return;
      }
      this.loadKey = loadKey;
      this.styleKey = null;
      this.loaded = { tiles, names: genes.allGenes ? (meta.genes ?? null) : genes.query };
    }
    try {
      await this.draw(dataset, view, port, frame, genes.allGenes);
      // The newest sync's selection: an older draw finishing late must not fade by a stale one.
      if (this.last?.selection === selection) this.fade(selection);
    } finally {
      end?.();
    }
  }

  /** Follow the scene's Z stretch (nothing is re-uploaded). */
  setZScale(s: number): void {
    if (this.layer) this.layer.scale3d = [1, 1, s];
  }

  /** Take the layer down and forget what it showed. */
  remove(): void {
    this.loads.cancel();
    this.clearLayer();
  }

  private clearLayer(): void {
    if (this.layer) this.viewer.layers.remove(this.layer);
    this.layer = null;
    this.loadKey = null;
    this.styleKey = null;
    this.loaded = null;
    this.drawnCells = null;
    this.fadedBy = null;
  }

  /**
   * Fade the drawn transcripts outside the selection (their alpha only: the colours stay
   * uploaded), or bring them all back without one. A no-op for the selection already applied.
   */
  private fade(selection: SpatialSelectionMask | null): void {
    const live = selection && selection.count > 0 ? selection : null;
    const layer = this.layer;
    const cells = this.drawnCells;
    if (!layer || !cells || live === this.fadedBy) return;
    this.fadedBy = live;
    if (!live) {
      layer.alphas = null;
      return;
    }
    const alphas = new Float32Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const o = cells[i];
      alphas[i] = o !== NO_OBSERVATION && o < live.mask.length && live.mask[o] ? 1 : DEFAULT_MUTED_OPACITY;
    }
    layer.alphas = alphas;
  }

  private async draw(
    dataset: SpatialDataset,
    view: SpatialViewState,
    port: SpatialDataPort,
    frame: Transcripts3dFrame,
    allGenes: boolean,
  ): Promise<void> {
    const loaded = this.loaded;
    if (!loaded) return;
    const by = transcripts3dColorBy(dataset, view, allGenes);
    const styleKey = [
      frame.origin.join(','),
      by,
      by === 'gene' ? JSON.stringify(view.transcriptGeneColors) : '',
      by !== 'gene' ? `${cellTypeColumnFor(dataset, view)}|${JSON.stringify(view.groupColors)}` : '',
      by === 'cluster' ? JSON.stringify(view.transcriptGeneGroups) : '',
      allGenes ? view.transcriptAllGenesHidden.join(',') : '',
    ].join('|');
    const size = TRANSCRIPT_3D_BASE_SIZE * (view.transcriptScale > 0 ? view.transcriptScale : 1);
    if (this.layer && styleKey === this.styleKey) {
      this.layer.size = size;
      this.layer.opacity = view.transcriptOpacity;
      this.layer.scale3d = [1, 1, frame.zScale];
      return;
    }
    const { names } = loaded;
    const shown = allGenes && names ? allGeneShownBy(view.transcriptAllGenesHidden) : null;
    const keep = shown && names ? (g: number) => !!names[g] && shown(names[g]) : () => true;
    const total = loaded.tiles.reduce((n, t) => n + t.count, 0);
    const stride = Math.max(1, Math.ceil(total / TRANSCRIPTS_3D_MAX));
    if (stride > 1) console.warn(`[napari-js] drawing every ${stride}th of ${total} transcripts in 3D`);

    const [ox, oy, oz] = frame.origin;
    const positions: number[] = [];
    const genes: number[] = [];
    const cells: number[] = [];
    let seen = 0;
    for (const t of loaded.tiles) {
      for (let i = 0; i < t.count; i++) {
        if (!keep(t.gene[i]) || seen++ % stride) continue;
        positions.push(t.x[i] + ox, t.y[i] + oy, t.z[i] + oz);
        genes.push(t.gene[i]);
        cells.push(t.observation[i]);
      }
    }
    const count = genes.length;
    let colors: Float32Array;
    if (by === 'gene') {
      colors = transcripts3dColors(view, names, Uint16Array.from(genes), count);
    } else {
      const groups = await cellGroupColors(dataset, view, port).catch((err) => {
        console.warn('[napari-js] the cells grouping for the 3D transcripts could not be read', err);
        return null;
      });
      // A newer draw (another style, or the layer taken down) won while the column loaded.
      if (this.loaded !== loaded) return;
      if (by === 'cellType') {
        colors = packed(count, (i) => {
          const o = cells[i];
          const code = !groups || o === NO_OBSERVATION ? NO_CATEGORY : groups.codes[o];
          return code === NO_CATEGORY ? undefined : groups!.colors[code];
        });
      } else {
        // A cluster named like a group of the cells' grouping takes that group's colour, as in 2D.
        const byCluster = clusterColorMap(
          view.transcriptGenes,
          view.transcriptGeneGroups,
          groups?.byName ?? new Map(),
          DEFAULT_CATEGORICAL_PALETTE,
        );
        const table = (names ?? []).map((gene) => {
          const hex = byCluster.get(clusterOfGene(gene, view.transcriptGeneGroups));
          return hex ? rgba01(hex) : undefined;
        });
        colors = packed(count, (i) => table[genes[i]]);
      }
    }
    if (this.layer) this.viewer.layers.remove(this.layer);
    this.layer = null;
    this.drawnCells = null;
    this.fadedBy = null;
    this.styleKey = styleKey;
    if (!count) return;
    this.drawnCells = Uint32Array.from(cells);
    this.layer = this.viewer.addPoints3D(Float32Array.from(positions), new Float32Array(count), {
      name: 'transcripts',
      size,
      opacity: view.transcriptOpacity,
      scale3d: [1, 1, frame.zScale],
      colors,
    });
  }
}

/** `work` over `items`, at most `limit` at once, results in order. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}
