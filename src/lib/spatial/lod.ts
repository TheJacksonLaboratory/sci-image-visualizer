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

import { worldViewport } from 'napari-js';

import type {
  CategoricalColumnMeta,
  SpatialBounds,
  SpatialDataset,
  SpatialImageRef,
  SpatialPolygonTilesMeta,
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

/**
 * The boundary sets drawn for the view's `cellSet`: that set when the dataset has it, else the
 * dataset's default, else its first; for "both", that one with the other set beside it. Null when
 * the dataset has no set. The renderer and the Cells panel's switches both read it, so a set kept
 * from another dataset shows as what is actually drawn.
 */
export function drawnCellSets(
  tiled: Pick<SpatialPolygonTilesMeta, 'sets' | 'defaultSet'> | null | undefined,
  cellSet: string | null | undefined,
): { set: string; nucleusSet?: string } | null {
  if (!tiled) return null;
  const both = cellSet === 'both';
  const set =
    !both && cellSet && tiled.sets.some((s) => s.name === cellSet)
      ? cellSet
      : (tiled.defaultSet ?? tiled.sets[0]?.name);
  if (!set) return null;
  const nucleusSet = both ? tiled.sets.find((s) => s.name !== set)?.name : undefined;
  return nucleusSet ? { set, nucleusSet } : { set };
}

/** A column holding a hand-curated cell-type annotation, by naming convention. */
export function isCuratedColumn(name: string): boolean {
  return /curated/i.test(name);
}

/**
 * The categorical column that names each cell's type: the view's choice when it is a
 * column of this dataset, else the first categorical column that is not a curated
 * annotation (a pipeline's clustering is the default; curation is opted into), else
 * any categorical column. A column of one category, such as the `region` a SpatialData
 * table links its cells to their shapes with, names no type and is only used when chosen;
 * a dataset with nothing else has no cell types (null).
 */
export function cellTypeColumnFor(
  dataset: SpatialDataset,
  view: Pick<SpatialViewState, 'cellTypeColumn'>,
): string | null {
  const categorical = dataset.columns.filter((c): c is CategoricalColumnMeta => c.kind === 'categorical');
  if (view.cellTypeColumn && categorical.some((c) => c.name === view.cellTypeColumn)) {
    return view.cellTypeColumn;
  }
  const typed = categorical.filter((c) => c.categories.length > 1);
  return (typed.find((c) => !isCuratedColumn(c.name)) ?? typed[0])?.name ?? null;
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
 * viewport) so tiles just off screen are already there when a pan brings them in: napari-js's
 * `worldViewport`, mapped back through the inverse of the data→world affine.
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
  // The world rect of a canvas grown by the margin on each side (napari-js's worldViewport).
  const v = worldViewport(center[0], center[1], zoom, canvasW * (1 + 2 * margin), canvasH * (1 + 2 * margin));
  const wx0 = v.x;
  const wx1 = v.x + v.width;
  const wy0 = v.y;
  const wy1 = v.y + v.height;
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
 *
 * Tile `g` covers `[g·s, (g+1)·s)`. The view's far edge is open — a tile starting exactly
 * at `rect.x1` shows nothing — but the bounds' far edge is closed: the bounds are the
 * extreme observations' coordinates, so one sits exactly on `bounds[2]`, in the tile
 * starting there.
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
  let { x0, y0 } = rect;
  // Last tile along an axis: the one before the open view edge, at most the closed bound's.
  let gx1 = Math.ceil(rect.x1 / size) - 1;
  let gy1 = Math.ceil(rect.y1 / size) - 1;
  if (bounds) {
    x0 = Math.max(x0, bounds[0]);
    y0 = Math.max(y0, bounds[1]);
    if (Math.min(rect.x1, bounds[2]) < x0 || Math.min(rect.y1, bounds[3]) < y0) return [];
    gx1 = Math.min(gx1, Math.floor(bounds[2] / size));
    gy1 = Math.min(gy1, Math.floor(bounds[3] / size));
  }
  const gx0 = Math.floor(x0 / size);
  const gy0 = Math.floor(y0 / size);
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
