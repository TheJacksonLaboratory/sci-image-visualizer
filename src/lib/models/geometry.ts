/**
 * Pure geometry helpers extracted from PlotlyService.
 *
 * No DOM access, no service state, no `this` — every function is testable
 * in isolation. Keep it that way: this module is the dumping ground for
 * shape/mask/SVG-path utilities the wand, vertex eraser, and region editor
 * share. If a helper grows a `this.shapes` reference, it doesn't belong here.
 */

/** A bbox-relative binary mask (1 = filled, 0 = empty). */
export interface BBoxMask {
  bx: number;
  by: number;
  bw: number;
  bh: number;
  mask: Uint8Array;
}

/** Parsed single-subpath polygon vertices. */
export interface PolygonVertices {
  xpoints: number[];
  ypoints: number[];
}

// ── SVG path parsing / building ──────────────────────────────────────

/**
 * Parse a single-subpath `M x,y L x,y ... Z` path into vertex arrays.
 *
 * Returns null for paths we can't safely round-trip (multi-subpath, curves,
 * fewer than three vertices). The wand only adopts shapes it produced or
 * that Plotly's drawclosedpath produces, both of which are single-subpath
 * polygons.
 */
export function parseSvgPathPolygon(path: string): PolygonVertices | null {
  if (!path || path[0] !== 'M') return null;
  if (path.indexOf('M', 1) !== -1) return null; // multi-subpath
  const trimmed = path.endsWith('Z') ? path.slice(1, -1) : path.slice(1);
  const segs = trimmed.split('L');
  const xpoints: number[] = [];
  const ypoints: number[] = [];
  for (const seg of segs) {
    const [sx, sy] = seg.split(',');
    const x = parseFloat(sx);
    const y = parseFloat(sy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    xpoints.push(x);
    ypoints.push(y);
  }
  if (xpoints.length < 3) return null;
  return { xpoints, ypoints };
}

/**
 * Build a closed SVG path string `M x,y L x,y L ... Z` from vertex arrays.
 * Returns '' for fewer than three vertices (degenerate).
 */
export function polygonToSvgPath(xpoints: number[], ypoints: number[]): string {
  if (xpoints.length < 3) return '';
  let path = 'M';
  for (let i = 0; i < xpoints.length; i++) {
    path += `${xpoints[i]},${ypoints[i]}`;
    path += i < xpoints.length - 1 ? 'L' : 'Z';
  }
  return path;
}

/**
 * Build an SVG path string from vertex arrays. Closed polygons end with `Z`,
 * open polylines do not. Returns '' for fewer than two vertices (degenerate).
 */
export function verticesToSvgPath(xs: number[], ys: number[], closed: boolean): string {
  if (xs.length < 2) return '';
  let path = 'M';
  for (let i = 0; i < xs.length; i++) {
    path += `${xs[i]},${ys[i]}`;
    if (i < xs.length - 1) path += 'L';
  }
  if (closed) path += 'Z';
  return path;
}

// ── Region equality ──────────────────────────────────────────────────

/**
 * Compare two Plotly shape objects for "same region" — used by the wand to
 * avoid appending duplicates when the user pushes the same find result more
 * than once. Polygons compare by SVG path string, rectangles compare by
 * (x0, y0, x1, y1).
 */
export function shapesEqual(a: any, b: any): boolean {
  if (a.path && b.path) {
    return a.path === b.path;
  }
  if (
    a.x0 !== undefined && a.y0 !== undefined &&
    a.x1 !== undefined && a.y1 !== undefined &&
    b.x0 !== undefined && b.y0 !== undefined &&
    b.x1 !== undefined && b.y1 !== undefined
  ) {
    return a.x0 === b.x0 &&
           a.y0 === b.y0 &&
           a.x1 === b.x1 &&
           a.y1 === b.y1;
  }
  return false;
}

// ── BBox-mask operations (used by the wand stroke accumulator) ───────

/** Returns true if the two bbox-relative masks share at least one set pixel. */
export function masksOverlap(a: BBoxMask, b: BBoxMask): boolean {
  const ix0 = Math.max(a.bx, b.bx);
  const iy0 = Math.max(a.by, b.by);
  const ix1 = Math.min(a.bx + a.bw, b.bx + b.bw);
  const iy1 = Math.min(a.by + a.bh, b.by + b.bh);
  if (ix0 >= ix1 || iy0 >= iy1) return false;
  for (let y = iy0; y < iy1; y++) {
    const ar = (y - a.by) * a.bw;
    const br = (y - b.by) * b.bw;
    for (let x = ix0; x < ix1; x++) {
      if (a.mask[ar + (x - a.bx)] && b.mask[br + (x - b.bx)]) return true;
    }
  }
  return false;
}

/**
 * Allocate a fresh accumulator covering both masks and OR them in. The
 * resulting mask's bbox is the smallest rectangle containing both inputs.
 */
export function unionMasks(a: BBoxMask, b: BBoxMask): BBoxMask {
  const ux0 = Math.min(a.bx, b.bx);
  const uy0 = Math.min(a.by, b.by);
  const ux1 = Math.max(a.bx + a.bw, b.bx + b.bw);
  const uy1 = Math.max(a.by + a.bh, b.by + b.bh);
  const ubw = ux1 - ux0;
  const ubh = uy1 - uy0;
  const umask = new Uint8Array(ubw * ubh);

  const dax = a.bx - ux0;
  const day = a.by - uy0;
  for (let row = 0; row < a.bh; row++) {
    const src = row * a.bw;
    const dst = (row + day) * ubw + dax;
    umask.set(a.mask.subarray(src, src + a.bw), dst);
  }
  const dbx = b.bx - ux0;
  const dby = b.by - uy0;
  for (let row = 0; row < b.bh; row++) {
    const srcRow = row * b.bw;
    const dstRow = (row + dby) * ubw;
    for (let col = 0; col < b.bw; col++) {
      if (b.mask[srcRow + col]) umask[dstRow + (dbx + col)] = 1;
    }
  }
  return { bx: ux0, by: uy0, bw: ubw, bh: ubh, mask: umask };
}

// ── Ring simplification (Douglas–Peucker) ───────────────────────────────

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
