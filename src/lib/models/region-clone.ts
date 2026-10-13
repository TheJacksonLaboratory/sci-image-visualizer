import { MultiPolygon, Polygon, Rectangle, Region } from './region';

/**
 * Copy-on-write region copies and geometry equality (RT-13). Stored regions
 * are shared with the undo history, so a change is always a copy; these
 * helpers return the input unchanged when the patch would not change it.
 * (Deep geometry copies are `cloneBounds` / `clonePolygon` in `polygon-factory`.)
 */

/** A shallow copy of `r` with `patch` applied; `r` itself is never changed. */
export function withRegionPatch(r: Region, patch: Partial<Region>): Region {
  return Object.assign(new Region(), r, patch);
}

/** `r` tagged with slice `z`: itself when it already is, else a copy. */
export function withRegionZ(r: Region, z: number): Region {
  return r.z === z ? r : withRegionPatch(r, { z });
}

/**
 * True when two regions have the same geometry: equal rectangles, or polygons
 * (each part of a multi-polygon, in order) with the same vertices, open/closed
 * state and holes. Bézier handles, labels and colours are not compared. Mixed
 * kinds are never equal.
 */
export function regionsEqual(a: Region, b: Region): boolean {
  const ba = a.bounds,
    bb = b.bounds;
  if (ba instanceof Rectangle && bb instanceof Rectangle) {
    return ba.x === bb.x && ba.y === bb.y && ba.width === bb.width && ba.height === bb.height;
  }
  if (ba instanceof MultiPolygon && bb instanceof MultiPolygon) {
    if (ba.polygons.length !== bb.polygons.length) return false;
    for (let i = 0; i < ba.polygons.length; i++) {
      if (!polygonsEqual(ba.polygons[i], bb.polygons[i])) return false;
    }
    return true;
  }
  if (ba instanceof Polygon && bb instanceof Polygon) {
    return polygonsEqual(ba, bb);
  }
  return false;
}

/** Same vertices, open/closed state and holes (see {@link regionsEqual}). */
export function polygonsEqual(pa: Polygon, pb: Polygon): boolean {
  if ((pa.closed !== false) !== (pb.closed !== false)) return false;
  if (pa.xpoints.length !== pb.xpoints.length) return false;
  for (let i = 0; i < pa.xpoints.length; i++) {
    if (pa.xpoints[i] !== pb.xpoints[i] || pa.ypoints[i] !== pb.ypoints[i]) return false;
  }
  return holesEqual(pa.holes, pb.holes);
}

function holesEqual(a: number[][][] | undefined, b: number[][][] | undefined): boolean {
  const na = a?.length ?? 0,
    nb = b?.length ?? 0;
  if (na !== nb) return false;
  for (let h = 0; h < na; h++) {
    const ra = (a as number[][][])[h],
      rb = (b as number[][][])[h];
    if (ra.length !== rb.length) return false;
    for (let i = 0; i < ra.length; i++) {
      if (ra[i][0] !== rb[i][0] || ra[i][1] !== rb[i][1]) return false;
    }
  }
  return true;
}
