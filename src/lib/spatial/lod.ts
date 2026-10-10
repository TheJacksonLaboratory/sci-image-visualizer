/**
 * Level-of-detail planning for tiled spatial geometry — cell outlines and transcripts.
 *
 * The renderer knows its camera (a world-space centre, a zoom in canvas pixels per world
 * unit, a canvas size); a tiled dataset knows its grids (one per level, in observation
 * units). This module is the bridge: which level the zoom calls for and which tiles are on
 * screen. Everything here is pure, so the policy — the part that decides whether the view
 * is fast and legible — is testable without a GPU.
 *
 * Observation units map onto world units through the dataset's `imageRef` affine
 * (`world = data · scale + translate`), so "pixels per observation unit" is
 * `zoom · scale`. For a Xenium bundle the data unit is the micron and the world unit the
 * morphology pixel.
 */

import type {
  SpatialBounds,
  SpatialDataset,
  SpatialImageRef,
  SpatialTileLevel,
} from '../contracts/spatial-dataset.contract';
import type { SpatialViewState } from '../contracts/display-types';
import { quantile } from './stats';

/** A rectangle in observation coordinates. */
export interface DataRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Tile address. */
export interface TileKey {
  level: number;
  gx: number;
  gy: number;
}

// ── What the view draws ───────────────────────────────────────────────────────────────

/** Whether cell outlines are drawn: the user's choice, else on when the dataset has any. */
export function cellsShown(
  dataset: Pick<SpatialDataset, 'polygonTiles' | 'polygons'> | null,
  view: Pick<SpatialViewState, 'showCells'>,
): boolean {
  const available = !!(dataset?.polygonTiles || dataset?.polygons);
  return available && (view.showCells ?? true);
}

/** A column holding a hand-curated cell-type annotation, by naming convention. */
export function isCuratedColumn(name: string): boolean {
  return /curated/i.test(name);
}

/**
 * The categorical column that names each cell's type: the view's choice when it is a
 * column of this dataset, else the first categorical column that is not a curated
 * annotation (a pipeline's clustering is the default; curation is opted into), else
 * any categorical column.
 */
export function cellTypeColumnFor(
  dataset: SpatialDataset,
  view: Pick<SpatialViewState, 'cellTypeColumn'>,
): string | null {
  const categorical = dataset.columns.filter((c) => c.kind === 'categorical');
  if (view.cellTypeColumn && categorical.some((c) => c.name === view.cellTypeColumn)) {
    return view.cellTypeColumn;
  }
  return (categorical.find((c) => !isCuratedColumn(c.name)) ?? categorical[0])?.name ?? null;
}

// ── Tiles in view ─────────────────────────────────────────────────────────────────────

/** A stable string id for a tile key, `level/gx/gy` — usable as a Map key. */
export function tileId(k: TileKey): string {
  return `${k.level}/${k.gx}/${k.gy}`;
}

/** Canvas pixels per observation unit along x, for a camera zoom and a data→world affine. */
export function pixelsPerDataUnit(zoom: number, ref?: SpatialImageRef | null): number {
  return zoom * Math.abs(ref?.scale?.[0] ?? 1);
}

/**
 * The part of observation space the camera shows, padded by `margin` (a fraction of the
 * viewport) so tiles just off screen are already there when a pan brings them in.
 */
export function visibleDataRect(
  center: readonly [number, number],
  zoom: number,
  canvasW: number,
  canvasH: number,
  ref?: SpatialImageRef | null,
  margin = 0.15,
): DataRect | null {
  if (!(zoom > 0) || !(canvasW > 0) || !(canvasH > 0)) return null;
  const sx = ref?.scale?.[0] ?? 1;
  const sy = ref?.scale?.[1] ?? 1;
  const tx = ref?.translate?.[0] ?? 0;
  const ty = ref?.translate?.[1] ?? 0;
  const halfW = (canvasW / zoom / 2) * (1 + 2 * margin);
  const halfH = (canvasH / zoom / 2) * (1 + 2 * margin);
  const wx0 = center[0] - halfW;
  const wx1 = center[0] + halfW;
  const wy0 = center[1] - halfH;
  const wy1 = center[1] + halfH;
  const ax = (wx0 - tx) / sx;
  const bx = (wx1 - tx) / sx;
  const ay = (wy0 - ty) / sy;
  const by = (wy1 - ty) / sy;
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/**
 * Tiles of one level intersecting `rect`, clipped to the dataset's `bounds` (so zooming
 * out over empty canvas does not ask for tiles that cannot exist). Ordered from the
 * rectangle's centre outward, so the middle of the screen fills in first.
 */
export function tilesInRect(
  rect: DataRect,
  level: number,
  levels: readonly SpatialTileLevel[],
  bounds?: SpatialBounds | null,
  limit = Infinity,
): TileKey[] {
  const size = levels[level]?.tileSize;
  if (!(size > 0)) return [];
  let { x0, y0, x1, y1 } = rect;
  if (bounds) {
    x0 = Math.max(x0, bounds[0]);
    y0 = Math.max(y0, bounds[1]);
    x1 = Math.min(x1, bounds[2]);
    y1 = Math.min(y1, bounds[3]);
    if (x1 < x0 || y1 < y0) return [];
  }
  const gx0 = Math.floor(x0 / size);
  const gx1 = Math.floor(x1 / size);
  const gy0 = Math.floor(y0 / size);
  const gy1 = Math.floor(y1 / size);
  const cx = (rect.x0 + rect.x1) / 2 / size;
  const cy = (rect.y0 + rect.y1) / 2 / size;
  const out: TileKey[] = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) out.push({ level, gx, gy });
  }
  out.sort(
    (a, b) => (a.gx + 0.5 - cx) ** 2 + (a.gy + 0.5 - cy) ** 2 - ((b.gx + 0.5 - cx) ** 2 + (b.gy + 0.5 - cy) ** 2),
  );
  return out.length > limit ? out.slice(0, limit) : out;
}

/** {@link tilesInRect} for a grid whose tile (0, 0) starts at `origin`. */
export function tilesInRectFrom(
  origin: readonly [number, number],
  rect: DataRect,
  level: number,
  levels: readonly SpatialTileLevel[],
  bounds?: SpatialBounds | null,
  limit = Infinity,
): TileKey[] {
  const [ox, oy] = origin;
  const shifted = { x0: rect.x0 - ox, y0: rect.y0 - oy, x1: rect.x1 - ox, y1: rect.y1 - oy };
  const b: SpatialBounds | null = bounds ? [bounds[0] - ox, bounds[1] - oy, bounds[2] - ox, bounds[3] - oy] : null;
  return tilesInRect(shifted, level, levels, b, limit);
}

/** Area of `rect` inside `bounds` (the whole rect when there are none). */
export function visibleArea(rect: DataRect, bounds?: SpatialBounds | null): number {
  const x0 = bounds ? Math.max(rect.x0, bounds[0]) : rect.x0;
  const y0 = bounds ? Math.max(rect.y0, bounds[1]) : rect.y0;
  const x1 = bounds ? Math.min(rect.x1, bounds[2]) : rect.x1;
  const y1 = bounds ? Math.min(rect.y1, bounds[3]) : rect.y1;
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

// ── Levels ────────────────────────────────────────────────────────────────────────────

/**
 * Typical cell diameter, in observation units, used to judge how large cells appear.
 * Derived from the per-observation radius when there is one; 12 µm otherwise.
 */
export function typicalCellDiameter(radius: Float32Array | number | undefined, fallback = 12): number {
  if (typeof radius === 'number') return radius > 0 ? radius * 2 : fallback;
  if (!radius?.length) return fallback;
  // The median of a sample is plenty — this sets a threshold, not a measurement.
  const median = quantile(radius, 0.5, { filter: 'positive', sampleSize: 2048 });
  return median === null ? fallback : median * 2;
}

/**
 * On-screen cell diameter (px) at or above which each polygon level is used. A level
 * halves the vertices of the one below, so each should take over when the cell is about
 * half as large on screen. Below the last finite threshold outlines are not drawn at
 * all — a cell a few pixels wide is a dot, and the observation markers already draw it
 * as one.
 *
 * Xenium's fourth level (3 vertices per cell) is deliberately never used: seen on
 * screen it is a field of triangles, which reads as an artefact rather than as cells.
 * The dots below 8 px say the same thing more honestly.
 */
export const POLYGON_LEVEL_MIN_CELL_PX = [36, 18, 8, Infinity];

/**
 * Which polygon level suits this zoom, or -1 for "too small to outline".
 * `detail` > 1 prefers finer levels (sharper, slower); < 1 coarser.
 */
export function polygonLevelFor(pxPerUnit: number, cellDiameter: number, levelCount: number, detail = 1): number {
  const cellPx = pxPerUnit * cellDiameter * detail;
  const table = POLYGON_LEVEL_MIN_CELL_PX;
  for (let l = 0; l < levelCount; l++) {
    // Past the table, keep halving: each level still halves the vertices.
    const min = table[l] ?? table[table.length - 1] / 2 ** (l - table.length + 1);
    if (cellPx >= min) return l;
  }
  return -1;
}

/**
 * Which transcript level suits this zoom: the one whose tiles come out closest to
 * `targetTilePx` on screen. Coarser levels aggregate more, so this keeps the number of
 * markers per screen roughly constant however far out the camera is — the property that
 * keeps the view fast.
 */
export function transcriptLevelFor(
  pxPerUnit: number,
  levels: readonly SpatialTileLevel[],
  targetTilePx = 512,
): number {
  if (!levels.length || !(pxPerUnit > 0)) return 0;
  let best = 0;
  let bestErr = Infinity;
  for (let l = 0; l < levels.length; l++) {
    const err = Math.abs(Math.log2((levels[l].tileSize * pxPerUnit) / targetTilePx));
    if (err < bestErr) {
      bestErr = err;
      best = l;
    }
  }
  return best;
}
