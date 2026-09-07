/**
 * Framing a 2D scatter on its own coordinates.
 *
 * The 2D spatial camera is normally fitted to the IMAGE, because the observations are recorded in
 * that image's pixel space — frame the image and they come with it. A dataset with no reference
 * image has coordinates in whatever units its source used: seqFISH's span about 5 x 7. Left with
 * the previous image's framing, such a dataset lands as a handful of pixels far off-centre, which
 * looks exactly like nothing having loaded rather than like a framing problem.
 *
 * Pure, like `spatial-density.ts` and the rest of this directory — the renderer applies the result.
 */

/** Fraction of the viewport the coordinates are fitted into, so the outermost markers are not
 *  flush against the edge. Matches napari-js's own fit margin. */
export const SPATIAL_FIT_MARGIN = 0.95;

export interface SpatialFraming {
  /** World point to put at the centre of the viewport. */
  center: [number, number];
  /** World units per pixel, inverted — the camera's `zoom`. */
  zoom: number;
}

/**
 * Camera centre and zoom that fit `positions` into a `viewportW` x `viewportH` box.
 *
 * `positions` is interleaved `[x0, y0, x1, y1, …]`, the layout the points layer takes.
 *
 * Null when there is nothing to fit — no points, a viewport with no area, or coordinates that are
 * entirely non-finite. Null means LEAVE THE CAMERA ALONE: a caller that substituted a default
 * would move the view for a dataset it cannot frame, which is worse than not moving it.
 *
 * A degenerate extent — one point, or every point on a line — yields a centre but no zoom, since
 * there is no span to divide by. The caller keeps its current zoom and just recentres, rather than
 * dividing by zero into an infinite one.
 */
export function framePositions(
  positions: Float32Array,
  viewportW: number,
  viewportH: number,
  margin = SPATIAL_FIT_MARGIN,
): SpatialFraming | { center: [number, number]; zoom: null } | null {
  if (positions.length < 2 || viewportW <= 0 || viewportH <= 0) return null;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const x = positions[i];
    const y = positions[i + 1];
    // A NaN coordinate is a hole in the data, not a position — including it would
    // poison the extent and frame on nothing.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return null;

  const center: [number, number] = [(xMin + xMax) / 2, (yMin + yMax) / 2];
  const spanX = xMax - xMin;
  const spanY = yMax - yMin;
  if (spanX <= 0 || spanY <= 0) return { center, zoom: null };
  return { center, zoom: margin * Math.min(viewportW / spanX, viewportH / spanY) };
}
