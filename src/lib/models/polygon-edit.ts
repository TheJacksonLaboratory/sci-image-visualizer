/**
 * Copy-on-write polygon edits (review RT-13, RegionStore split "polygon-edit").
 *
 * Every function takes a polygon and returns a NEW {@link Polygon} with the
 * edit applied — or null when the edit does not apply (an index out of range,
 * a vertex delete that would degenerate the ring, …), so a caller can skip its
 * undo step. The input is never mutated: arrays the edit does not touch are
 * shared with it (structural sharing), arrays it does touch are copied. That
 * is what lets `RegionStore` keep shallow undo snapshots instead of deep
 * clones: an instance in a snapshot is never changed after the fact.
 *
 * Pure: no DOM, no store. Coordinates are image pixels; bézier handle offsets
 * are relative to their anchor, as on {@link Polygon}.
 */
import { MultiPolygon, Polygon, Rectangle } from './region';
import { defaultHandleOffsets } from './bezier';

/** A shallow copy of `p` with `patch` applied (untouched arrays are shared). */
function withPolygon(p: Polygon, patch: Partial<Polygon>): Polygon {
  return Object.assign(new Polygon(), p, patch);
}

/** `xs` with `value` inserted at `at`. */
function inserted<T>(xs: readonly T[], at: number, value: T): T[] {
  return [...xs.slice(0, at), value, ...xs.slice(at)];
}

/** `xs` without the element at `at`. */
function removed<T>(xs: readonly T[], at: number): T[] {
  return [...xs.slice(0, at), ...xs.slice(at + 1)];
}

/** `xs` with the element at `at` replaced. */
function replaced<T>(xs: readonly T[], at: number, value: T): T[] {
  const out = xs.slice();
  out[at] = value;
  return out;
}

function coordinatesOf(xs: number[], ys: number[]): number[][] {
  return xs.map((x, i) => [x, ys[i]]);
}

// ── exterior vertices ───────────────────────────────────────────────────

/** Move exterior vertex `index` to (x, y). Null when `index` is out of range. */
export function moveVertex(p: Polygon, index: number, x: number, y: number): Polygon | null {
  if (index < 0 || index >= p.xpoints.length) return null;
  return withPolygon(p, {
    xpoints: replaced(p.xpoints, index, x),
    ypoints: replaced(p.ypoints, index, y),
    coordinates: replaced(p.coordinates, index, [x, y]),
  });
}

/**
 * Insert a vertex at (x, y) after `segIndex` (the start vertex of the edge),
 * clamped to the ring. A bézier polygon with stored handles gives the new
 * vertex smooth handles from its neighbours and keeps the others' (possibly
 * hand-edited) handles.
 */
export function addVertex(p: Polygon, segIndex: number, x: number, y: number): Polygon {
  const at = Math.max(0, Math.min(segIndex + 1, p.xpoints.length));
  const xpoints = inserted(p.xpoints, at, x);
  const ypoints = inserted(p.ypoints, at, y);
  const patch: Partial<Polygon> = {
    xpoints, ypoints, coordinates: coordinatesOf(xpoints, ypoints), npoints: xpoints.length,
  };
  if (p.bezier && p.handlesIn && p.handlesOut) {
    const n = xpoints.length;
    const closed = p.closed !== false;
    const prev = closed ? (at - 1 + n) % n : Math.max(0, at - 1);
    const next = closed ? (at + 1) % n : Math.min(n - 1, at + 1);
    const tx = (xpoints[next] - xpoints[prev]) / 6;
    const ty = (ypoints[next] - ypoints[prev]) / 6;
    patch.handlesIn = inserted(p.handlesIn, at, [-tx, -ty]);
    patch.handlesOut = inserted(p.handlesOut, at, [tx, ty]);
  }
  return withPolygon(p, patch);
}

/**
 * Delete exterior vertex `index`. Null when out of range, or when it would
 * leave fewer than 3 vertices (2 for an open polyline).
 */
export function deleteVertex(p: Polygon, index: number): Polygon | null {
  if (index < 0 || index >= p.xpoints.length) return null;
  const min = p.closed === false ? 2 : 3;
  if (p.xpoints.length <= min) return null;
  const xpoints = removed(p.xpoints, index);
  const ypoints = removed(p.ypoints, index);
  const patch: Partial<Polygon> = {
    xpoints, ypoints, coordinates: coordinatesOf(xpoints, ypoints), npoints: xpoints.length,
  };
  if (p.bezier && p.handlesIn && p.handlesOut) {
    patch.handlesIn = removed(p.handlesIn, index);
    patch.handlesOut = removed(p.handlesOut, index);
  }
  return withPolygon(p, patch);
}

// ── hole (interior ring) vertices — jit-ui#85 ───────────────────────────

function hasHole(p: Polygon, holeIndex: number): boolean {
  return !!p.holes && holeIndex >= 0 && holeIndex < p.holes.length;
}

/** Move vertex `index` of hole `holeIndex` to (x, y). Null when either is out of range. */
export function moveHoleVertex(p: Polygon, holeIndex: number, index: number, x: number, y: number,
): Polygon | null {
  if (!hasHole(p, holeIndex)) return null;
  const ring = p.holes![holeIndex];
  if (index < 0 || index >= ring.length) return null;
  return withPolygon(p, { holes: replaced(p.holes!, holeIndex, replaced(ring, index, [x, y])) });
}

/**
 * Insert a vertex at (x, y) on hole `holeIndex`, after `segIndex`. A bézier
 * polygon re-seeds its hole handles so they stay parallel to the rings. Null
 * for an out-of-range hole.
 */
export function addHoleVertex(p: Polygon, holeIndex: number, segIndex: number, x: number, y: number,
): Polygon | null {
  if (!hasHole(p, holeIndex)) return null;
  const ring = p.holes![holeIndex];
  const at = Math.max(0, Math.min(segIndex + 1, ring.length));
  const holes = replaced(p.holes!, holeIndex, inserted(ring, at, [x, y]));
  return withPolygon(p, { holes, ...(p.bezier ? seededHoleHandles(holes) : {}) });
}

/**
 * Delete vertex `index` of hole `holeIndex`. Taking a ring below 3 vertices
 * drops the whole hole (it would bound no area). Null when out of range.
 */
export function deleteHoleVertex(p: Polygon, holeIndex: number, index: number): Polygon | null {
  if (!hasHole(p, holeIndex)) return null;
  const ring = p.holes![holeIndex];
  if (index < 0 || index >= ring.length) return null;
  let holes: number[][][] | undefined = ring.length <= 3
    ? removed(p.holes!, holeIndex)
    : replaced(p.holes!, holeIndex, removed(ring, index));
  if (holes.length === 0) holes = undefined;
  return withPolygon(p, { holes, ...(p.bezier ? seededHoleHandles(holes) : {}) });
}

// ── bézier ──────────────────────────────────────────────────────────────

/**
 * Per-hole bézier handles seeded from the Catmull-Rom default, parallel to
 * `holes` (both undefined without holes).
 */
export function seededHoleHandles(holes: number[][][] | undefined):
  Pick<Polygon, 'holeHandlesIn' | 'holeHandlesOut'> {
  if (!holes || !holes.length) return { holeHandlesIn: undefined, holeHandlesOut: undefined };
  const ins: number[][][] = [];
  const outs: number[][][] = [];
  for (const ring of holes) {
    const off = defaultHandleOffsets(ring.map((q) => q[0]), ring.map((q) => q[1]), true);
    ins.push(off.in);
    outs.push(off.out);
  }
  return { holeHandlesIn: ins, holeHandlesOut: outs };
}

/**
 * Turn bézier on — seeding editable handles (holes included) from the smooth
 * default — or off, dropping every handle. The anchors never move. Null when
 * the polygon is already in that state.
 */
export function setBezier(p: Polygon, bezier: boolean): Polygon | null {
  if (p.bezier === bezier) return null;
  if (!bezier) {
    return withPolygon(p, {
      bezier: false, handlesIn: undefined, handlesOut: undefined,
      holeHandlesIn: undefined, holeHandlesOut: undefined,
    });
  }
  const off = defaultHandleOffsets(p.xpoints, p.ypoints, p.closed !== false);
  return withPolygon(p, { bezier: true, handlesIn: off.in, handlesOut: off.out, ...seededHoleHandles(p.holes) });
}

/**
 * Move the `side` control point of exterior vertex `index` to the absolute
 * point (x, y). Handles missing from a bézier polygon are seeded from the
 * default first. Null for a non-bézier polygon or an out-of-range index.
 */
export function moveBezierHandle(p: Polygon, index: number, side: 'in' | 'out', x: number, y: number,
): Polygon | null {
  if (!p.bezier || index < 0 || index >= p.xpoints.length) return null;
  let handlesIn = p.handlesIn, handlesOut = p.handlesOut;
  if (!handlesIn || !handlesOut) {
    const off = defaultHandleOffsets(p.xpoints, p.ypoints, p.closed !== false);
    handlesIn = off.in;
    handlesOut = off.out;
  }
  const offset = [x - p.xpoints[index], y - p.ypoints[index]];
  return side === 'in'
    ? withPolygon(p, { handlesIn: replaced(handlesIn, index, offset), handlesOut })
    : withPolygon(p, { handlesIn, handlesOut: replaced(handlesOut, index, offset) });
}

/**
 * Move the `side` control point of vertex `index` on hole `holeIndex` to the
 * absolute point (x, y), seeding the hole handles first when missing. Null for
 * a non-bézier polygon or an out-of-range hole/index.
 */
export function moveHoleBezierHandle(p: Polygon, holeIndex: number, index: number, side: 'in' | 'out',
                                     x: number, y: number): Polygon | null {
  if (!p.bezier || !hasHole(p, holeIndex)) return null;
  const ring = p.holes![holeIndex];
  if (index < 0 || index >= ring.length) return null;
  let ins = p.holeHandlesIn, outs = p.holeHandlesOut;
  if (!ins || !outs) {
    const seeded = seededHoleHandles(p.holes);
    ins = seeded.holeHandlesIn!;
    outs = seeded.holeHandlesOut!;
  }
  const offset = [x - ring[index][0], y - ring[index][1]];
  return side === 'in'
    ? withPolygon(p, { holeHandlesIn: replaced(ins, holeIndex, replaced(ins[holeIndex], index, offset)),
      holeHandlesOut: outs })
    : withPolygon(p, { holeHandlesIn: ins,
      holeHandlesOut: replaced(outs, holeIndex, replaced(outs[holeIndex], index, offset)) });
}

// ── translation ─────────────────────────────────────────────────────────

/**
 * A polygon moved by (dx, dy): its vertices and holes (bézier offsets are
 * relative, so they carry over). `round` snaps the moved coordinates.
 */
export function translatePolygon(p: Polygon, dx: number, dy: number, round?: (v: number) => number): Polygon {
  const f = round ?? ((v: number) => v);
  const xpoints = p.xpoints.map((x) => f(x + dx));
  const ypoints = p.ypoints.map((y) => f(y + dy));
  return withPolygon(p, {
    xpoints, ypoints, coordinates: coordinatesOf(xpoints, ypoints),
    holes: p.holes?.map((ring) => ring.map(([x, y]) => [f(x + dx), f(y + dy)])),
  });
}

/** Any region geometry moved by (dx, dy) (see {@link translatePolygon}). */
export function translateBounds(b: Rectangle | Polygon | MultiPolygon, dx: number, dy: number,
                                round?: (v: number) => number): Rectangle | Polygon | MultiPolygon {
  const f = round ?? ((v: number) => v);
  if (b instanceof Rectangle) {
    return Object.assign(new Rectangle(), b, { x: f(b.x + dx), y: f(b.y + dy) });
  }
  if (b instanceof MultiPolygon) {
    const polygons = b.polygons.map((p) => translatePolygon(p, dx, dy, round));
    return Object.assign(new MultiPolygon(), { polygons });
  }
  return translatePolygon(b, dx, dy, round);
}
