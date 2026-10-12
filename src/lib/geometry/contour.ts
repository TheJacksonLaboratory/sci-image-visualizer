import { traceContours } from 'napari-js/geometry';
import type { Contour } from 'napari-js/geometry';

import { Polygon } from '../models/region';
import { makePolygon } from '../models/polygon-factory';

/**
 * Pure contour tracing: binary mask / label map → polygons with holes, through
 * napari-js's `traceContours`. No DOM, no Angular.
 *
 * Pixel (x, y) of a mask covers `[x, x + 1) × [y, y + 1)` of its frame, and the
 * outlines run along pixel EDGES (vertices on whole pixel corners, straight runs
 * merged into one edge), so `rasterizePolygon` (`geometry/raster`, the pixel-centre
 * rule) gives back exactly the traced pixels: a region the wand or brush adopts
 * again after a zoom, pan or undo comes back unchanged. Each blob's holes are its
 * own interior rings, never a gap that blobs enclose only together. Vertices are
 * translated by the caller's origin and never clamped: a mask may sit partly
 * outside the readback window it was painted in (jit-ui#102).
 */

/** A traced contour as a closed Polygon, holes as `[[x, y], …]` rings. */
function toPolygon(c: Contour): Polygon {
  const ring = (flat: number[]) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      xs.push(flat[i]);
      ys.push(flat[i + 1]);
    }
    return { xs, ys };
  };
  const outer = ring(c.outer);
  const holes = c.holes.map((h) => {
    const r = ring(h);
    return r.xs.map((x, k) => [x, r.ys[k]]);
  });
  return makePolygon(outer.xs, outer.ys, { holes });
}

/**
 * Trace EVERY 4-connected blob in `mask` (sized w*h) whose area is at least
 * `minSize` pixels, returning one Polygon per blob translated via
 * (originX, originY), ordered largest-first (ties in raster order). A blob's
 * interior rings enclosing at least `minHoleSize` pixels become its
 * {@link Polygon.holes}. An erase that cuts a region in two therefore yields
 * both pieces, and a donut keeps its hole.
 *
 * The mask is labelled once and each blob traced inside its own bounding box
 * (RT-16), so the cost is O(w·h + Σ bbox areas).
 */
export function maskToPolygons(
  mask: Uint8Array,
  w: number,
  h: number,
  originX: number,
  originY: number,
  minSize = 4,
  minHoleSize = minSize,
): Polygon[] {
  return traceContours(
    { data: mask, width: w, height: h },
    { minSize, minHoleSize, origin: [originX, originY] },
  ).map(toPolygon);
}

/**
 * Trace each instance in an integer label map (0 = background) into polygons —
 * used to turn a cellpose-style segmentation into region outlines. Pieces with
 * area below `minSize` are skipped (and holes below it dropped); a label made of
 * several blobs yields one polygon per blob. Ordered by label, then largest
 * piece first. Coords are translated via originX/originY (not clamped).
 *
 * One labelling pass finds every label's pieces; each is traced inside its own
 * bounding box (RT-16), instead of rescanning the whole map per label.
 */
export function labelsToPolygons(
  labels: Uint32Array,
  w: number,
  h: number,
  originX: number,
  originY: number,
  minSize = 10,
): Polygon[] {
  return traceContours(
    { data: labels, width: w, height: h },
    { minSize, minHoleSize: minSize, origin: [originX, originY] },
  )
    .sort((a, b) => a.value - b.value) // stable: largest first within a label
    .map(toPolygon);
}
