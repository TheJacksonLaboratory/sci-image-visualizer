import { MultiPolygon, Polygon, Rectangle, Region } from './region';

/**
 * Polygon / Region construction and cloning in one place, so callers stop
 * hand-filling `npoints`, `xpoints`, `ypoints`, `coordinates` and `closed`
 * (three redundant views of one ring that every mutator must keep in sync).
 */

/** Options for {@link makePolygon}. */
export interface MakePolygonOptions {
  /** false for an open polyline; default true. */
  closed?: boolean;
  /** Interior rings; omitted when absent or empty. */
  holes?: number[][][];
  bezier?: boolean;
}

/** A Polygon over the given vertex arrays (taken by reference). */
export function makePolygon(xs: number[], ys: number[], opts: MakePolygonOptions = {}): Polygon {
  const poly = new Polygon();
  poly.npoints = xs.length;
  poly.xpoints = xs;
  poly.ypoints = ys;
  poly.coordinates = xs.map((x, i) => [x, ys[i]]);
  poly.closed = opts.closed ?? true;
  if (opts.bezier) poly.bezier = true;
  if (opts.holes && opts.holes.length) poly.holes = opts.holes;
  return poly;
}

/** The four corners of a rectangle as a closed ring (clockwise from top-left). */
export function rectToRing(r: Pick<Rectangle, 'x' | 'y' | 'width' | 'height'>): { xs: number[]; ys: number[] } {
  return {
    xs: [r.x, r.x + r.width, r.x + r.width, r.x],
    ys: [r.y, r.y, r.y + r.height, r.y + r.height],
  };
}

/** A deep copy of a polygon: vertices, holes and every bézier handle. */
export function clonePolygon(p: Polygon): Polygon {
  const poly = new Polygon();
  poly.npoints = p.npoints;
  poly.xpoints = p.xpoints.slice();
  poly.ypoints = p.ypoints.slice();
  poly.coordinates = p.coordinates.map((c) => c.slice());
  poly.closed = p.closed;
  poly.bezier = p.bezier;
  if (p.handlesIn) poly.handlesIn = p.handlesIn.map((o) => o.slice());
  if (p.handlesOut) poly.handlesOut = p.handlesOut.map((o) => o.slice());
  if (p.holes) poly.holes = p.holes.map((ring) => ring.map((pt) => pt.slice()));
  if (p.holeHandlesIn) poly.holeHandlesIn = p.holeHandlesIn.map((r) => r.map((o) => o.slice()));
  if (p.holeHandlesOut) poly.holeHandlesOut = p.holeHandlesOut.map((r) => r.map((o) => o.slice()));
  return poly;
}

/** A deep copy of any region geometry. */
export function cloneBounds(bounds: Rectangle | Polygon | MultiPolygon): Rectangle | Polygon | MultiPolygon {
  if (bounds instanceof Rectangle) {
    const rect = new Rectangle();
    rect.x = bounds.x; rect.y = bounds.y; rect.width = bounds.width; rect.height = bounds.height;
    return rect;
  }
  if (bounds instanceof MultiPolygon) {
    const mp = new MultiPolygon();
    mp.polygons = bounds.polygons.map((p) => clonePolygon(p));
    return mp;
  }
  return clonePolygon(bounds);
}

/**
 * A copy of `existing` (id, name, label, colour, colour override, source,
 * file name, kind, z, …) with new geometry and optional extra fields. Use it
 * whenever a tool edits a region's shape, so the edit never drops metadata and
 * never mutates the store's instance.
 */
export function replaceBounds(existing: Region, bounds: Region['bounds'], patch: Partial<Region> = {}): Region {
  return Object.assign(new Region(), existing, patch, { bounds });
}
