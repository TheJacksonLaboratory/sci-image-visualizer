import type { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { ALL_GENES } from '../contracts/ports/spatial-data.port';
import {
  NO_OBSERVATION,
  type SpatialBounds,
  type SpatialImageRef,
  type SpatialObservations,
  type SpatialTileLevel,
  type SpatialTranscriptTile,
} from '../contracts/spatial-dataset.contract';
import type { TileKey } from './lod';
import { inBand } from './spatial-planes';
import { inBounds, type Shape } from './spatial-selection';

/**
 * The transcripts of a selection, by gene: the molecules of the selected cells (each transcript
 * tile names the cell every molecule lies in), or those inside drawn regions — over the whole depth
 * (spatial 3D) or on one plane (the 2D view of a sliced dataset).
 *
 * Read from the finest level of the transcript pyramid, every gene (`ALL_GENES`), and only the
 * tiles the selection touches: a cell's transcripts lie near it, a region's inside its bounds.
 * Pure but for the port; the facade decides what is selected.
 */

/** At most this many tiles are read for one list; a selection spanning more is counted in part. */
export const TRANSCRIPT_LIST_MAX_TILES = 2048;
/** About this many transcripts at most are read for one list (estimated from the dataset's mean). */
export const TRANSCRIPT_LIST_MAX_TRANSCRIPTS = 20_000_000;
/** Tiles read at once. */
const CONCURRENCY = 8;
/**
 * How far from a cell's centre its transcripts are looked for, in microns: past the largest cells'
 * reach (a cell's molecules lie inside its outline; Baysor cells of the ileum are up to ~25 µm).
 */
export const CELL_REACH_MICRONS = 30;

/**
 * How many level-0 tiles one list may read: {@link TRANSCRIPT_LIST_MAX_TILES}, fewer when the
 * dataset's tiles are dense (its transcripts over the tiles of its bounds), so that about
 * {@link TRANSCRIPT_LIST_MAX_TRANSCRIPTS} are read at most — a whole cell type of a sparse section
 * is read whole, of a dense one in part.
 */
export function tileBudget(meta: {
  bounds: SpatialBounds;
  count?: number;
  levels: readonly SpatialTileLevel[];
}): number {
  const size = meta.levels[0]?.tileSize;
  if (!(size > 0) || !meta.count) return TRANSCRIPT_LIST_MAX_TILES;
  const [x0, y0, x1, y1] = meta.bounds;
  const tiles =
    (Math.floor(x1 / size) - Math.floor(x0 / size) + 1) * (Math.floor(y1 / size) - Math.floor(y0 / size) + 1);
  const perTile = meta.count / Math.max(1, tiles);
  return Math.max(16, Math.min(TRANSCRIPT_LIST_MAX_TILES, Math.floor(TRANSCRIPT_LIST_MAX_TRANSCRIPTS / perTile)));
}

/** One gene's transcripts in the selection. */
export interface GeneCount {
  name: string;
  count: number;
}

/** What {@link countTranscripts} found. */
export interface TranscriptCount {
  total: number;
  /** Distinct cells the counted transcripts lie in (those in no cell are not counted here). */
  cells: number;
  /** Genes by count, most first. */
  genes: GeneCount[];
  /** Some tiles could not be read (or were left out): the counts are a lower bound. */
  partial: boolean;
}

/** Which transcripts count: those of these cells, or those inside these shapes (image px). */
export type TranscriptFilter =
  { kind: 'cells'; mask: Uint8Array } | { kind: 'shapes'; shapes: readonly Shape[]; imageRef?: SpatialImageRef };

/**
 * Level-0 tiles within `reach` of the selected cells' centres (observation units), clipped to
 * `bounds`. When there are more than `max`, those holding the most selected cells are kept and
 * `partial` says so.
 */
export function tilesAroundCells(
  obs: SpatialObservations,
  mask: Uint8Array,
  reach: number,
  levels: readonly SpatialTileLevel[],
  bounds: SpatialBounds | null | undefined,
  max = TRANSCRIPT_LIST_MAX_TILES,
): { tiles: TileKey[]; partial: boolean } {
  const size = levels[0]?.tileSize;
  if (!(size > 0)) return { tiles: [], partial: false };
  const weight = new Map<string, number>();
  const n = Math.min(obs.count, mask.length);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const x = obs.x[i];
    const y = obs.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const [gx0, gx1] = span(x - reach, x + reach, size, bounds?.[0], bounds?.[2]);
    const [gy0, gy1] = span(y - reach, y + reach, size, bounds?.[1], bounds?.[3]);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const key = `${gx},${gy}`;
        weight.set(key, (weight.get(key) ?? 0) + 1);
      }
    }
  }
  return pick(weight, max);
}

/**
 * Level-0 tiles under `shapes` (image px, mapped to observation units through `imageRef`), clipped
 * to `bounds`; at most `max`, the most covered first.
 */
export function tilesUnderShapes(
  shapes: readonly Shape[],
  imageRef: SpatialImageRef | undefined,
  levels: readonly SpatialTileLevel[],
  bounds: SpatialBounds | null | undefined,
  max = TRANSCRIPT_LIST_MAX_TILES,
): { tiles: TileKey[]; partial: boolean } {
  const size = levels[0]?.tileSize;
  if (!(size > 0)) return { tiles: [], partial: false };
  const [sx, sy] = imageRef?.scale ?? [1, 1];
  const [tx, ty] = imageRef?.translate ?? [0, 0];
  const weight = new Map<string, number>();
  for (const shape of shapes) {
    const b = shape.bounds;
    const ax = (b.minX - tx) / sx;
    const bx = (b.maxX - tx) / sx;
    const ay = (b.minY - ty) / sy;
    const by = (b.maxY - ty) / sy;
    const [gx0, gx1] = span(Math.min(ax, bx), Math.max(ax, bx), size, bounds?.[0], bounds?.[2]);
    const [gy0, gy1] = span(Math.min(ay, by), Math.max(ay, by), size, bounds?.[1], bounds?.[3]);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const key = `${gx},${gy}`;
        weight.set(key, (weight.get(key) ?? 0) + 1);
      }
    }
  }
  return pick(weight, max);
}

/** The tile indices `[g0, g1]` covering `[a, b]` along one axis, within the bounds' tiles. */
function span(a: number, b: number, size: number, lo?: number, hi?: number): [number, number] {
  let g0 = Math.floor(a / size);
  let g1 = Math.floor(b / size);
  if (lo !== undefined && Number.isFinite(lo)) g0 = Math.max(g0, Math.floor(lo / size));
  if (hi !== undefined && Number.isFinite(hi)) g1 = Math.min(g1, Math.floor(hi / size));
  return [g0, g1];
}

/** The `max` heaviest tiles of `weight` (`"gx,gy"` → weight), and whether any were left out. */
function pick(weight: Map<string, number>, max: number): { tiles: TileKey[]; partial: boolean } {
  let entries = [...weight.entries()];
  const partial = entries.length > max;
  if (partial) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, max);
  const tiles = entries.map(([key]) => {
    const [gx, gy] = key.split(',').map(Number);
    return { level: 0, gx, gy };
  });
  return { tiles, partial };
}

/**
 * Count the transcripts of `tiles` (level 0, every gene) that pass `filter` and, when given, lie in
 * the z `band`, by gene (`names` are the dataset's genes by code, `transcriptTiles.genes`).
 * Resolves null once `cancelled()` says so; a tile that fails to load leaves the count partial.
 */
export async function countTranscripts(opts: {
  port: SpatialDataPort;
  tiles: readonly TileKey[];
  quality: 'high' | 'all';
  filter: TranscriptFilter;
  band?: readonly [number, number] | null;
  names?: readonly string[] | null;
  cancelled?: () => boolean;
  /** Tiles left out before counting (see {@link tilesAroundCells}). */
  partial?: boolean;
}): Promise<TranscriptCount | null> {
  const { port, tiles, filter, band } = opts;
  const getTile = port.getTranscriptTile?.bind(port);
  if (!getTile) return null;
  const byGene = new Map<number, number>();
  const cells = new Set<number>();
  let total = 0;
  let failed = 0;
  let next = 0;
  const accept = acceptor(filter);

  const add = (tile: SpatialTranscriptTile) => {
    const { x, y, z, gene, weight, observation } = tile;
    for (let i = 0; i < tile.count; i++) {
      if (band && !inBand(z[i], band)) continue;
      const o = observation[i];
      if (!accept(x[i], y[i], o)) continue;
      const w = weight[i] || 1;
      total += w;
      byGene.set(gene[i], (byGene.get(gene[i]) ?? 0) + w);
      if (o !== NO_OBSERVATION) cells.add(o);
    }
  };

  const worker = async () => {
    while (next < tiles.length) {
      if (opts.cancelled?.()) return;
      const k = tiles[next++];
      try {
        add(await getTile(0, k.gx, k.gy, { genes: [ALL_GENES], quality: opts.quality }));
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker));
  if (opts.cancelled?.()) return null;
  if (tiles.length > 0 && failed === tiles.length) throw new Error('the transcripts could not be read');

  const names = opts.names;
  const genes = [...byGene.entries()]
    .map(([code, count]) => ({ name: names?.[code] || `gene ${code}`, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { total, cells: cells.size, genes, partial: !!opts.partial || failed > 0 };
}

/** Whether a transcript at (x, y), in cell `o`, passes `filter`. */
function acceptor(filter: TranscriptFilter): (x: number, y: number, o: number) => boolean {
  if (filter.kind === 'cells') {
    const mask = filter.mask;
    return (_x, _y, o) => o !== NO_OBSERVATION && o < mask.length && mask[o] === 1;
  }
  const shapes = filter.shapes;
  const [sx, sy] = filter.imageRef?.scale ?? [1, 1];
  const [tx, ty] = filter.imageRef?.translate ?? [0, 0];
  return (x, y) => {
    const px = x * sx + tx;
    const py = y * sy + ty;
    for (const shape of shapes) {
      if (inBounds(shape.bounds, px, py) && shape.hit(px, py)) return true;
    }
    return false;
  };
}

/** The cells of `categories` (names) in a categorical column's `codes`, as a selection mask. */
export function cellsOfCategories(
  codes: ArrayLike<number>,
  categories: readonly string[],
  names: readonly string[],
): { mask: Uint8Array; count: number } {
  const wanted = new Set(names);
  const hit = new Uint8Array(categories.length);
  categories.forEach((c, k) => (hit[k] = wanted.has(c) ? 1 : 0));
  const mask = new Uint8Array(codes.length);
  let count = 0;
  for (let i = 0; i < codes.length; i++) {
    if (hit[codes[i]]) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}
