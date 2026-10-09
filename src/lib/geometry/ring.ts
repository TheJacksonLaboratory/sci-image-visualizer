/**
 * Pure ring (closed polyline) helpers: bounds, containment, vertex dropping and
 * simplification. No DOM, no Angular, no `this` — usable from workers.
 *
 * A ring is a pair of parallel `xs`/`ys` arrays without a repeated closing
 * vertex; hole rings use the `[[x, y], …]` convention of {@link Polygon.holes}.
 */

/** Axis-aligned bounds of a ring. Infinite (min > max) for an empty ring. */
export interface RingBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The axis-aligned bounds of a ring's vertices. */
export function ringBounds(xs: ArrayLike<number>, ys: ArrayLike<number>): RingBounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Standard ray-cast (even-odd) point-in-ring test. (px, py) and the ring
 * vertices must be in the same coordinate system. Rings with fewer than three
 * vertices contain nothing.
 */
export function pointInRing(px: number, py: number, xs: ArrayLike<number>, ys: ArrayLike<number>): boolean {
  const n = xs.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ys[i], yj = ys[j];
    const xi = xs[i], xj = xs[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Point-in-region test that honours interior rings (holes): inside the
 * exterior AND outside every hole. Coordinates must share the polygon's frame.
 * With no holes this is exactly {@link pointInRing}.
 */
export function pointInPolygonWithHoles(px: number, py: number, xs: ArrayLike<number>, ys: ArrayLike<number>,
                                        holes?: number[][][]): boolean {
  if (!pointInRing(px, py, xs, ys)) return false;
  if (holes) {
    for (const ring of holes) {
      if (pointInRing(px, py, ring.map((p) => p[0]), ring.map((p) => p[1]))) return false;
    }
  }
  return true;
}

/**
 * Drop every vertex whose Euclidean distance to (cx, cy) is less than
 * `radius`. Returns trimmed parallel arrays plus how many vertices were
 * removed (so the caller can detect a no-op tick and skip the relayout).
 */
export function dropVerticesWithinRadius(xpoints: number[], ypoints: number[],
                                         cx: number, cy: number, radius: number)
  : { xpoints: number[]; ypoints: number[]; removed: number } {
  const r2 = radius * radius;
  const xs: number[] = [];
  const ys: number[] = [];
  let removed = 0;
  for (let i = 0; i < xpoints.length; i++) {
    const dx = xpoints[i] - cx;
    const dy = ypoints[i] - cy;
    if (dx * dx + dy * dy < r2) {
      removed++;
      continue;
    }
    xs.push(xpoints[i]);
    ys.push(ypoints[i]);
  }
  return { xpoints: xs, ypoints: ys, removed };
}

/** Perpendicular distance from (px,py) to the segment (ax,ay)–(bx,by). */
function perpDistance(px: number, py: number,
                      ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Simplify a closed ring with the Douglas–Peucker algorithm (jit-ui#85):
 * drop every vertex that lies within `epsilon` pixels (the "altitude
 * threshold") of the line between its kept neighbours. Anchored at vertex 0
 * (the ring is closed by appending it). Rings of ≤ 3 vertices, or a
 * non-positive epsilon, are returned unchanged. Output keeps the closed-ring
 * convention (no repeated closing point).
 */
export function simplifyRing(xs: number[], ys: number[], epsilon: number)
  : { xs: number[]; ys: number[] } {
  const n = xs.length;
  if (n <= 3 || !(epsilon > 0)) return { xs: xs.slice(), ys: ys.slice() };

  // Close the ring so both endpoints of the DP run are vertex 0.
  const px = [...xs, xs[0]];
  const py = [...ys, ys[0]];
  const m = px.length;
  const keep = new Array<boolean>(m).fill(false);
  keep[0] = true;
  keep[m - 1] = true;

  const stack: Array<[number, number]> = [[0, m - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDistance(px[i], py[i], px[a], py[a], px[b], py[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx > a) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }

  const outX: number[] = [], outY: number[] = [];
  for (let i = 0; i < m - 1; i++) {      // drop the duplicated closing vertex
    if (keep[i]) { outX.push(px[i]); outY.push(py[i]); }
  }
  return { xs: outX, ys: outY };
}
