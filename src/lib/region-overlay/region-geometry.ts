/**
 * Region-overlay geometry shared by the OpenSeadragon and napari overlays
 * (review NAPARI-BOUNDARY-13, OSD-PLOTLY-16).
 *
 * Both overlays used to carry their own copy of this code, and the copies had
 * drifted: napari's hit test ignored holes, multi-part regions and open
 * polylines, its bézier path drew straight edges without stored handles, and it
 * rendered nothing for a MultiPolygon. Everything here is pure — no DOM, no
 * viewer — so the overlays are left with gestures and DOM.
 *
 * Coordinates: regions are in WORLD (image-pixel) space. Functions that need a
 * screen-space tolerance (an open polyline's hit width, a handle's grab
 * radius) take a {@link ToScreen} projection and measure in its pixels, so they
 * stay usable at any zoom. Point-in-ring and ring bounds come from
 * `geometry/ring`.
 */
import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { AnchorHandle, resolveHandles } from '../models/bezier';
import { pointInPolygonWithHoles } from '../geometry/ring';

/** World → screen projection, e.g. image → element pixels. */
export type ToScreen = (x: number, y: number) => readonly [number, number];

/** The identity projection: path data stays in world coordinates. */
export const WORLD: ToScreen = (x, y) => [x, y];

/** An axis-aligned box (inclusive corners). */
export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Screen-px distance from an open polyline within which a point is on it. */
export const OPEN_PATH_TOL_PX = 6;

type AnyBounds = Region['bounds'] | Record<string, unknown>;

/**
 * Discriminate a region's bounds. Class instances first; plain objects with the
 * right fields too, so a region that skipped the store's hydration (JSON from a
 * host) still draws and hit-tests (jit-ui#124).
 */
export function boundsKind(b: AnyBounds | null | undefined): 'rect' | 'poly' | 'multi' | null {
  if (!b) return null;
  if (b instanceof Rectangle) return 'rect';
  if (b instanceof Polygon) return 'poly';
  if (b instanceof MultiPolygon) return 'multi';
  if (Array.isArray((b as { polygons?: unknown }).polygons)) return 'multi';
  if ('xpoints' in b || 'npoints' in b) return 'poly';
  if ('width' in b && 'x' in b) return 'rect';
  return null;
}

/** A polygon's ring as parallel arrays: the exterior for `ring` -1, else hole `ring`. */
export function ringOf(p: Polygon, ring: number): { xs: number[]; ys: number[] } {
  if (ring < 0) return { xs: p.xpoints, ys: p.ypoints };
  const pts = p.holes?.[ring] ?? [];
  return { xs: pts.map((q) => q[0]), ys: pts.map((q) => q[1]) };
}

/**
 * A polygon ring's bézier handles (absolute, world space): the stored offsets
 * when present, else the Catmull-Rom default the curve is drawn with. Holes are
 * always closed.
 */
export function ringHandles(p: Polygon, ring: number): AnchorHandle[] {
  const { xs, ys } = ringOf(p, ring);
  return ring < 0
    ? resolveHandles(xs, ys, p.closed !== false, p.handlesIn, p.handlesOut)
    : resolveHandles(xs, ys, true, p.holeHandlesIn?.[ring], p.holeHandlesOut?.[ring]);
}

/** The rings of a polygon, exterior first: -1, then each hole index. */
function ringIndices(p: Polygon): number[] {
  return [-1, ...(p.holes ?? []).map((_, i) => i)];
}

// ── bounds and containment ───────────────────────────────────────────────

/**
 * A region's axis-aligned bounding box in world coordinates (every part of a
 * multi-polygon), or null for empty geometry. Loops rather than
 * `Math.min(...spread)`, which throws on a large imported annotation.
 */
export function regionBBox(region: Pick<Region, 'bounds'>): BBox | null {
  const b = region.bounds;
  const kind = boundsKind(b);
  if (kind === 'rect') {
    const r = b as Rectangle;
    return { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
  }
  if (!kind) return null;
  const parts = kind === 'poly' ? [b as Polygon] : (b as MultiPolygon).polygons;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) {
    const xs = p.xpoints ?? [], ys = p.ypoints ?? [];
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < x0) x0 = xs[i];
      if (xs[i] > x1) x1 = xs[i];
      if (ys[i] < y0) y0 = ys[i];
      if (ys[i] > y1) y1 = ys[i];
    }
  }
  return x1 >= x0 ? { x0, y0, x1, y1 } : null;
}

/** Shortest distance from (px,py) to the segment (ax,ay)–(bx,by), in the units given. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Options for {@link regionContains}. */
export interface ContainsOptions {
  /** Projection the open-polyline tolerance is measured in. Default: world units. */
  toScreen?: ToScreen;
  /** Open-polyline hit width, in `toScreen` pixels. Default {@link OPEN_PATH_TOL_PX}. */
  tolPx?: number;
}

/**
 * Whether world point (x, y) lands on `region`: a rectangle by its (inclusive)
 * box; a closed polygon by its exterior minus its holes; a multi-polygon by any
 * part (minus that part's holes); an open polyline — which has no interior —
 * within `tolPx` screen pixels of its line.
 */
export function regionContains(region: Pick<Region, 'bounds'>, x: number, y: number,
                               opts: ContainsOptions = {}): boolean {
  const b = region.bounds;
  switch (boundsKind(b)) {
    case 'rect': {
      const r = b as Rectangle;
      return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    }
    case 'multi':
      return (b as MultiPolygon).polygons.some((p) => closedContains(p, x, y));
    case 'poly': {
      const p = b as Polygon;
      if (p.closed !== false) return closedContains(p, x, y);
      return nearPolyline(p.xpoints, p.ypoints, x, y, opts.toScreen ?? WORLD, opts.tolPx ?? OPEN_PATH_TOL_PX);
    }
    default:
      return false;
  }
}

function closedContains(p: Polygon, x: number, y: number): boolean {
  return pointInPolygonWithHoles(x, y, p.xpoints ?? [], p.ypoints ?? [], p.holes);
}

function nearPolyline(xs: number[], ys: number[], x: number, y: number, toScreen: ToScreen, tol: number): boolean {
  if (xs.length < 2) return false;
  const [px, py] = toScreen(x, y);
  let [ax, ay] = toScreen(xs[0], ys[0]);
  for (let i = 1; i < xs.length; i++) {
    const [bx, by] = toScreen(xs[i], ys[i]);
    if (segmentDistance(px, py, ax, ay, bx, by) <= tol) return true;
    ax = bx;
    ay = by;
  }
  return false;
}

/** Index of the topmost (last) region containing (x, y), or -1. */
export function topmostRegionAt(regions: ReadonlyArray<Pick<Region, 'bounds'>>, x: number, y: number,
                                opts: ContainsOptions & { skip?: (r: Pick<Region, 'bounds'>) => boolean } = {},
): number {
  for (let i = regions.length - 1; i >= 0; i--) {
    if (opts.skip?.(regions[i])) continue;
    if (regionContains(regions[i], x, y, opts)) return i;
  }
  return -1;
}

/**
 * Indices of every region whose bounding box intersects the world box
 * [x0,y0]–[x1,y1] (rubber-band selection). `skipProfiles` leaves out
 * intensity-profile lines.
 */
export function regionsInRect(regions: ReadonlyArray<Region>, x0: number, y0: number, x1: number, y1: number,
                              opts: { skipProfiles?: boolean } = {}): number[] {
  const out: number[] = [];
  regions.forEach((r, i) => {
    if (opts.skipProfiles && r.isProfile?.()) return;
    const bb = regionBBox(r);
    if (bb && bb.x0 <= x1 && bb.x1 >= x0 && bb.y0 <= y1 && bb.y1 >= y0) out.push(i);
  });
  return out;
}

// ── SVG path data ────────────────────────────────────────────────────────

/** The handle offsets a bézier ring is drawn with; absent arrays fall back to the default. */
export interface RingHandleOffsets {
  in?: number[][];
  out?: number[][];
}

/**
 * SVG path `d` for one ring or polyline, projected through `toScreen`.
 * Straight edges without `handles`; with `handles`, cubic segments through the
 * stored offsets, or the Catmull-Rom default when they are missing or do not
 * match the ring (via `resolveHandles`). Closed rings end in `Z`. '' for fewer
 * than two vertices.
 */
export function ringPathD(xs: number[], ys: number[], closed: boolean, toScreen: ToScreen,
                          handles?: RingHandleOffsets): string {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return '';
  const pt = (x: number, y: number) => { const q = toScreen(x, y); return `${q[0]},${q[1]}`; };
  let d = `M ${pt(xs[0], ys[0])}`;
  if (handles) {
    const h = resolveHandles(xs, ys, closed, handles.in, handles.out);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      d += ` C ${pt(h[i].out[0], h[i].out[1])} ${pt(h[j].in[0], h[j].in[1])} ${pt(xs[j], ys[j])}`;
    }
  } else {
    for (let i = 1; i < n; i++) d += ` L ${pt(xs[i], ys[i])}`;
  }
  return closed ? d + ' Z' : d;
}

/**
 * SVG path `d` for a whole region: a rectangle's four corners; a polygon's
 * exterior (curved for a bézier region) followed by one subpath per hole
 * (curved too for a bézier donut); a multi-polygon's parts with their holes.
 * Holes need `fill-rule: evenodd` (see {@link regionHasHoles}).
 */
export function regionPathD(region: Pick<Region, 'bounds'>, toScreen: ToScreen = WORLD): string {
  const b = region.bounds;
  switch (boundsKind(b)) {
    case 'rect': {
      const r = b as Rectangle;
      return ringPathD([r.x, r.x + r.width, r.x + r.width, r.x], [r.y, r.y, r.y + r.height, r.y + r.height],
        true, toScreen);
    }
    case 'poly':
      return polygonPathD(b as Polygon, toScreen, true);
    case 'multi':
      return (b as MultiPolygon).polygons
        .filter((p) => (p.xpoints?.length ?? 0) >= 3)
        .map((p) => polygonPathD(p, toScreen, false))
        .join(' ');
    default:
      return '';
  }
}

function polygonPathD(p: Polygon, toScreen: ToScreen, allowBezier: boolean): string {
  const closed = p.closed !== false;
  const bezier = allowBezier && !!p.bezier && (p.xpoints?.length ?? 0) >= 2;
  let d = ringPathD(p.xpoints ?? [], p.ypoints ?? [], closed, toScreen,
    bezier ? { in: p.handlesIn, out: p.handlesOut } : undefined);
  if (!closed) return d;
  (p.holes ?? []).forEach((ring, hi) => {
    if (ring.length < 3) return;
    const { xs, ys } = ringOf(p, hi);
    d += ' ' + ringPathD(xs, ys, true, toScreen,
      bezier ? { in: p.holeHandlesIn?.[hi], out: p.holeHandlesOut?.[hi] } : undefined);
  });
  return d;
}

/** True when the region draws as several subpaths that need `fill-rule: evenodd`. */
export function regionHasHoles(region: Pick<Region, 'bounds'>): boolean {
  const b = region.bounds;
  const kind = boundsKind(b);
  if (kind === 'multi') return true;
  if (kind !== 'poly') return false;
  const p = b as Polygon;
  return p.closed !== false && !!p.holes?.length;
}

// ── handle hit testing (screen space) ────────────────────────────────────

/** What a pointer grabbed on the selected region (see {@link hitHandle}). */
export type HandleHit =
  /** A rectangle corner; `anchor` is the opposite (fixed) corner for a resize. */
  | { kind: 'corner'; index: number; anchor: [number, number] }
  /** A polygon vertex: `ring` -1 for the exterior, else the hole index. */
  | { kind: 'vertex'; ring: number; index: number }
  /** A bézier control point of vertex `index` on `ring`. */
  | { kind: 'bezier'; ring: number; index: number; side: 'in' | 'out' };

/**
 * The handle of `region` under screen point (sx, sy) within `radius` screen
 * pixels, or null. Rectangles have four corners. Polygons: every bézier
 * control point first (exterior, then each hole; they sit off the anchors, so
 * they must win), then the vertices (exterior, then each hole). Pass
 * `{ bezier: false }` to test vertices only.
 */
export function hitHandle(region: Pick<Region, 'bounds'>, sx: number, sy: number, toScreen: ToScreen,
                          radius: number, opts: { bezier?: boolean } = {}): HandleHit | null {
  const b = region.bounds;
  const near = (x: number, y: number) => {
    const q = toScreen(x, y);
    return Math.hypot(sx - q[0], sy - q[1]) <= radius;
  };
  const kind = boundsKind(b);
  if (kind === 'rect') {
    const r = b as Rectangle;
    const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
    const corners: Array<[number, number, [number, number]]> = [
      [x0, y0, [x1, y1]], [x1, y0, [x0, y1]], [x0, y1, [x1, y0]], [x1, y1, [x0, y0]],
    ];
    for (let i = 0; i < corners.length; i++) {
      if (near(corners[i][0], corners[i][1])) return { kind: 'corner', index: i, anchor: corners[i][2] };
    }
    return null;
  }
  if (kind !== 'poly') return null;
  const p = b as Polygon;
  const rings = ringIndices(p);
  if (opts.bezier !== false && p.bezier) {
    for (const ring of rings) {
      const handles = ringHandles(p, ring);
      for (let i = 0; i < handles.length; i++) {
        const h = handles[i];
        if (h.hasOut && near(h.out[0], h.out[1])) return { kind: 'bezier', ring, index: i, side: 'out' };
        if (h.hasIn && near(h.in[0], h.in[1])) return { kind: 'bezier', ring, index: i, side: 'in' };
      }
    }
  }
  for (const ring of rings) {
    const { xs, ys } = ringOf(p, ring);
    for (let i = 0; i < xs.length; i++) {
      if (near(xs[i], ys[i])) return { kind: 'vertex', ring, index: i };
    }
  }
  return null;
}

/**
 * The polygon edge nearest screen point (sx, sy), across the exterior and every
 * hole: its ring (-1 = exterior), the index of its start vertex, and the
 * distance in screen pixels. Null when the region is not a polygon.
 */
export function nearestEdge(region: Pick<Region, 'bounds'>, sx: number, sy: number,
                            toScreen: ToScreen): { ring: number; segIndex: number; dist: number } | null {
  const b = region.bounds;
  if (boundsKind(b) !== 'poly') return null;
  const p = b as Polygon;
  let best: { ring: number; segIndex: number; dist: number } | null = null;
  for (const ring of ringIndices(p)) {
    const { xs, ys } = ringOf(p, ring);
    const n = xs.length;
    const segs = ring >= 0 || p.closed !== false ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const a = toScreen(xs[i], ys[i]);
      const c = toScreen(xs[j], ys[j]);
      const dist = segmentDistance(sx, sy, a[0], a[1], c[0], c[1]);
      if (!best || dist < best.dist) best = { ring, segIndex: i, dist };
    }
  }
  return best;
}

/**
 * The polygon vertex nearest world point (x, y), across the exterior and every
 * hole, with its distance in world units. Null when the region is not a
 * polygon or has no vertices.
 */
export function nearestVertex(region: Pick<Region, 'bounds'>, x: number, y: number,
): { ring: number; index: number; dist: number } | null {
  const b = region.bounds;
  if (boundsKind(b) !== 'poly') return null;
  const p = b as Polygon;
  let best: { ring: number; index: number; dist: number } | null = null;
  for (const ring of ringIndices(p)) {
    const { xs, ys } = ringOf(p, ring);
    for (let i = 0; i < xs.length; i++) {
      const dist = Math.hypot(xs[i] - x, ys[i] - y);
      if (!best || dist < best.dist) best = { ring, index: i, dist };
    }
  }
  return best;
}
