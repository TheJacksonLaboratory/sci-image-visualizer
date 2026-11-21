import { simplifyRing } from './ring';

/**
 * Smooth a closed ring traced along pixel edges (`traceContours`: vertices on pixel
 * corners) into the outline the pixels approximate, so a traced mask does not show
 * its pixel staircase when zoomed in.
 *
 * 1. The ring is split back into one-pixel edges (the tracer merges straight runs),
 *    and each is replaced by its midpoint: a one-pixel staircase becomes a 45° line,
 *    a straight run stays straight, and a corner is cut by half a pixel only.
 * 2. Chaikin corner cutting (`iterations` rounds, each cutting every corner at ¼
 *    and ¾) rounds what is left.
 * 3. Douglas-Peucker at `epsilon` (ring units) drops the near-collinear vertices the
 *    first two steps add, keeping the vertex count close to the input's.
 *
 * Along straight runs and gentle curves the result stays within about half a pixel of
 * the traced edge; sharp corners are rounded off by a pixel or two, which a cell's
 * outline never has at full resolution. Rings of fewer than 4 vertices come back as
 * they are.
 */
export function smoothPixelRing(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  iterations = 2,
  epsilon = 0.2,
): { xs: number[]; ys: number[] } {
  const n = xs.length;
  if (n < 4) return { xs: Array.from(xs), ys: Array.from(ys) };
  // Midpoints of the one-pixel pieces of every edge.
  let px: number[] = [];
  let py: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = xs[j] - xs[i];
    const dy = ys[j] - ys[i];
    const steps = Math.max(1, Math.round(Math.hypot(dx, dy)));
    for (let k = 0; k < steps; k++) {
      px.push(xs[i] + (dx * (k + 0.5)) / steps);
      py.push(ys[i] + (dy * (k + 0.5)) / steps);
    }
  }
  for (let it = 0; it < iterations; it++) {
    const m = px.length;
    const qx: number[] = new Array(m * 2);
    const qy: number[] = new Array(m * 2);
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      qx[2 * i] = 0.75 * px[i] + 0.25 * px[j];
      qy[2 * i] = 0.75 * py[i] + 0.25 * py[j];
      qx[2 * i + 1] = 0.25 * px[i] + 0.75 * px[j];
      qy[2 * i + 1] = 0.25 * py[i] + 0.75 * py[j];
    }
    px = qx;
    py = qy;
  }
  const simplified = simplifyRing(px, py, epsilon);
  return simplified.xs.length >= 3 ? simplified : { xs: px, ys: py };
}
