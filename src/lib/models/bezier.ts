/**
 * Bezier-curve helpers (no external dependency).
 *
 * JIT supports true bezier regions: a polygon's vertices are the editable
 * *anchors*, and the smooth curve through them is derived here with the
 * Catmull-Rom construction — the same algorithm paper.js uses in
 * `path.smooth()`. The curve interpolates every anchor and
 * each anchor's two handles are colinear (a smooth tangent).
 *
 * The OSD overlay renders the curve as a true cubic SVG path + draggable handles
 * (see {@link bezierAnchorHandles}); GeoJSON export flattens the *same* cubics
 * into a dense point list (see {@link bezierCurve}) so a viewer without bezier
 * support (e.g. QuPath, which just draws the coordinate list) still shows the
 * smooth shape. Using one algorithm for both keeps what JIT draws identical to
 * what it exports.
 *
 * Pure functions: no DOM, no service state. Coordinates are image pixels.
 */

export interface CurvePoints {
  xs: number[];
  ys: number[];
}

/** A vertex's two cubic-bezier control points (absolute coords) plus whether
 *  each side has a handle (open-path endpoints have only one). */
export interface AnchorHandle {
  in: [number, number];
  out: [number, number];
  hasIn: boolean;
  hasOut: boolean;
}

/** How many points to sample per cubic segment when flattening for export. */
const SAMPLES_PER_SEGMENT = 16;

/**
 * Per-anchor cubic-bezier control points using the Catmull-Rom construction
 * (tension 1: control = anchor ± (next − prev) / 6). Matches paper.js
 * `path.smooth()`: the resulting cubic interpolates every anchor and the two
 * handles of each anchor are colinear. Coordinates are in the input space.
 */
export function bezierAnchorHandles(xs: number[], ys: number[], closed: boolean): AnchorHandle[] {
  const n = Math.min(xs.length, ys.length);
  const out: AnchorHandle[] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const next = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const tx = (xs[next] - xs[prev]) / 6;
    const ty = (ys[next] - ys[prev]) / 6;
    out.push({
      out: [xs[i] + tx, ys[i] + ty],
      in: [xs[i] - tx, ys[i] - ty],
      hasOut: closed || i < n - 1,
      hasIn: closed || i > 0,
    });
  }
  return out;
}

/** The Catmull-Rom handles as **relative** offsets `[dx, dy]` per anchor — used
 *  to initialise a region's editable handles when bezier is turned on. */
export function defaultHandleOffsets(xs: number[], ys: number[], closed: boolean):
  { in: number[][]; out: number[][] } {
  const h = bezierAnchorHandles(xs, ys, closed);
  return {
    in: h.map((a, i) => [a.in[0] - xs[i], a.in[1] - ys[i]]),
    out: h.map((a, i) => [a.out[0] - xs[i], a.out[1] - ys[i]]),
  };
}

/** Absolute handles from stored relative offsets (anchor + offset). */
export function handlesFromOffsets(xs: number[], ys: number[],
                                   inOff: number[][], outOff: number[][], closed: boolean): AnchorHandle[] {
  const n = Math.min(xs.length, ys.length);
  const out: AnchorHandle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      in: [xs[i] + (inOff[i]?.[0] ?? 0), ys[i] + (inOff[i]?.[1] ?? 0)],
      out: [xs[i] + (outOff[i]?.[0] ?? 0), ys[i] + (outOff[i]?.[1] ?? 0)],
      hasOut: closed || i < n - 1,
      hasIn: closed || i > 0,
    });
  }
  return out;
}

/** A region's handles: from its stored (editable) offsets when present, else the
 *  Catmull-Rom default. The single source of truth for both rendering and export. */
export function resolveHandles(xs: number[], ys: number[], closed: boolean,
                               inOff?: number[][], outOff?: number[][]): AnchorHandle[] {
  if (inOff && outOff && inOff.length === xs.length && outOff.length === xs.length) {
    return handlesFromOffsets(xs, ys, inOff, outOff, closed);
  }
  return bezierAnchorHandles(xs, ys, closed);
}

/**
 * Flatten a cubic bezier (defined by explicit per-anchor handles) into a dense
 * point list by sampling each segment. The curve passes through every anchor; a
 * closed ring returns to its first point.
 */
export function bezierCurveFromHandles(xs: number[], ys: number[],
                                       handles: AnchorHandle[], closed: boolean): CurvePoints {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { xs: xs.slice(), ys: ys.slice() };

  const outX: number[] = [];
  const outY: number[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const p0x = xs[i], p0y = ys[i];
    const c1 = handles[i].out, c2 = handles[j].in;
    const p3x = xs[j], p3y = ys[j];
    for (let s = 0; s < SAMPLES_PER_SEGMENT; s++) {
      const t = s / SAMPLES_PER_SEGMENT;
      const u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      outX.push(w0 * p0x + w1 * c1[0] + w2 * c2[0] + w3 * p3x);
      outY.push(w0 * p0y + w1 * c1[1] + w2 * c2[1] + w3 * p3y);
    }
  }
  if (closed) {
    outX.push(xs[0]); outY.push(ys[0]);
  } else {
    outX.push(xs[n - 1]); outY.push(ys[n - 1]);
  }
  return { xs: outX, ys: outY };
}

/**
 * Flatten the smooth Catmull-Rom bezier through the anchors (no custom handles).
 * Falls back to the anchors when there are too few to form a curve.
 */
export function bezierCurve(xs: number[], ys: number[], closed: boolean): CurvePoints {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { xs: xs.slice(), ys: ys.slice() };
  return bezierCurveFromHandles(xs, ys, bezierAnchorHandles(xs, ys, closed), closed);
}
