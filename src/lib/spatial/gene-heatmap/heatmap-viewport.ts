/**
 * The gene heatmap's viewport: which columns and rows are on screen, how wheel, drag and
 * reset change that, and which level of detail and tiles draw it.
 *
 * Data units throughout: a column is one heatmap column (a cell, or a group in the grouped
 * view) and a row is one gene. The window is half-open, `[x0, x1) × [y0, y1)`, and may cut
 * through a column or row. Pure, so the interaction rules are tested without a canvas.
 */

/** The columns and rows on screen. */
export interface HeatmapWindow {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** What can be shown, and the closest zoom allowed on each axis. */
export interface HeatmapExtent {
  cols: number;
  rows: number;
  /** Fewest columns the window may span. */
  minCols: number;
  /** Fewest rows the window may span. */
  minRows: number;
}

/** Which axes a zoom changes. */
export type ZoomAxes = 'both' | 'x' | 'y';

/** The whole matrix. */
export function fitWindow(extent: HeatmapExtent): HeatmapWindow {
  return { x0: 0, x1: Math.max(1, extent.cols), y0: 0, y1: Math.max(1, extent.rows) };
}

/** Each span between its axis's smallest and the whole, then moved inside the matrix. */
export function clampWindow(w: HeatmapWindow, extent: HeatmapExtent): HeatmapWindow {
  const [x0, x1] = clampSpan(w.x0, w.x1, Math.max(1, extent.cols), extent.minCols);
  const [y0, y1] = clampSpan(w.y0, w.y1, Math.max(1, extent.rows), extent.minRows);
  return { x0, x1, y0, y1 };
}

function clampSpan(a: number, b: number, full: number, min: number): [number, number] {
  const span = Math.min(full, Math.max(Math.min(min, full), b - a));
  const mid = (a + b) / 2;
  let lo = mid - span / 2;
  lo = Math.max(0, Math.min(full - span, lo));
  return [lo, lo + span];
}

/**
 * Zoom by `factor` (below 1 zooms in) about the data point `at`, which stays under the
 * pointer, on the axes asked for.
 */
export function zoomWindow(
  w: HeatmapWindow,
  extent: HeatmapExtent,
  factor: number,
  at: { x: number; y: number },
  axes: ZoomAxes = 'both',
): HeatmapWindow {
  const next = { ...w };
  if (axes !== 'y') {
    next.x0 = at.x - (at.x - w.x0) * factor;
    next.x1 = at.x + (w.x1 - at.x) * factor;
  }
  if (axes !== 'x') {
    next.y0 = at.y - (at.y - w.y0) * factor;
    next.y1 = at.y + (w.y1 - at.y) * factor;
  }
  return clampZoom(next, w, extent, at);
}

/** As {@link clampWindow}, but a span stopped at its limit keeps `at` where it was on screen. */
function clampZoom(
  next: HeatmapWindow,
  prev: HeatmapWindow,
  extent: HeatmapExtent,
  at: { x: number; y: number },
): HeatmapWindow {
  const [x0, x1] = limitSpan(next.x0, next.x1, prev.x0, prev.x1, at.x, Math.max(1, extent.cols), extent.minCols);
  const [y0, y1] = limitSpan(next.y0, next.y1, prev.y0, prev.y1, at.y, Math.max(1, extent.rows), extent.minRows);
  return { x0, x1, y0, y1 };
}

function limitSpan(
  a: number,
  b: number,
  pa: number,
  pb: number,
  at: number,
  full: number,
  min: number,
): [number, number] {
  const span = Math.min(full, Math.max(Math.min(min, full), b - a));
  // Where `at` sat across the previous span, so a zoom stopped at a limit does not jump.
  const t = pb > pa ? (at - pa) / (pb - pa) : 0.5;
  let lo = at - t * span;
  lo = Math.max(0, Math.min(full - span, lo));
  return [lo, lo + span];
}

/** Move by `dx` columns and `dy` rows, staying inside the matrix. */
export function panWindow(w: HeatmapWindow, extent: HeatmapExtent, dx: number, dy: number): HeatmapWindow {
  return clampWindow({ x0: w.x0 + dx, x1: w.x1 + dx, y0: w.y0 + dy, y1: w.y1 + dy }, extent);
}

/** A window of `rows` rows centred on `row`, the columns as they are. */
export function revealRow(w: HeatmapWindow, extent: HeatmapExtent, row: number, rows = 24): HeatmapWindow {
  const span = Math.min(Math.max(1, extent.rows), Math.max(extent.minRows, rows));
  return clampWindow({ ...w, y0: row + 0.5 - span / 2, y1: row + 0.5 + span / 2 }, extent);
}

/** The level whose pixels are just larger than a screen pixel: `floor(log2(units per pixel))`. */
export function levelFor(span: number, pixels: number, finest: number, coarsest: number): number {
  const perPixel = pixels > 0 ? span / pixels : Infinity;
  const level = perPixel > 1 ? Math.floor(Math.log2(perPixel)) : 0;
  return Math.max(finest, Math.min(coarsest, level));
}

/** The coarsest level worth having for `n` units: one where they all fit one pixel. */
export function maxLevel(n: number): number {
  return Math.max(0, Math.ceil(Math.log2(Math.max(1, n))));
}

/** A tile of a level, by its column and row among the level's tiles. */
export interface HeatmapTileRef {
  cx: number;
  gy: number;
  tx: number;
  ty: number;
}

/** The tiles of level (`cx`, `gy`) that the window touches, rows nearest its centre first. */
export function tilesFor(
  w: HeatmapWindow,
  cx: number,
  gy: number,
  tileSize: number,
  cols: number,
  rows: number,
): HeatmapTileRef[] {
  const colSpan = tileSize * 2 ** cx;
  const rowSpan = tileSize * 2 ** gy;
  const lastTx = Math.max(0, Math.ceil(cols / colSpan) - 1);
  const lastTy = Math.max(0, Math.ceil(rows / rowSpan) - 1);
  const tx0 = clampInt(Math.floor(w.x0 / colSpan), 0, lastTx);
  const tx1 = clampInt(Math.ceil(w.x1 / colSpan) - 1, 0, lastTx);
  const ty0 = clampInt(Math.floor(w.y0 / rowSpan), 0, lastTy);
  const ty1 = clampInt(Math.ceil(w.y1 / rowSpan) - 1, 0, lastTy);
  const cxm = (w.x0 + w.x1) / 2 / colSpan;
  const cym = (w.y0 + w.y1) / 2 / rowSpan;
  const out: HeatmapTileRef[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push({ cx, gy, tx, ty });
  // The middle of the screen first: what the eye is on arrives first.
  out.sort((a, b) => dist(a, cxm, cym) - dist(b, cxm, cym));
  return out;
}

function dist(t: HeatmapTileRef, x: number, y: number): number {
  return Math.abs(t.tx + 0.5 - x) + Math.abs(t.ty + 0.5 - y);
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** The data rectangle a tile covers, clipped to the matrix. */
export function tileRect(
  t: HeatmapTileRef,
  tileSize: number,
  cols: number,
  rows: number,
): { x0: number; x1: number; y0: number; y1: number } {
  const cw = tileSize * 2 ** t.cx;
  const rh = tileSize * 2 ** t.gy;
  return {
    x0: t.tx * cw,
    x1: Math.min(cols, (t.tx + 1) * cw),
    y0: t.ty * rh,
    y1: Math.min(rows, (t.ty + 1) * rh),
  };
}

/** The group whose columns include `col`, by binary search over the groups' starts. */
export function groupAt(starts: readonly number[], col: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  if (hi < 0 || col < starts[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= col) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
