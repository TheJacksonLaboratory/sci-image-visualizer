import { Region } from '../../models/region';
import { SpatialImageRef, SpatialObservations } from '../../contracts/spatial-dataset.contract';

/**
 * Which observations fall inside a set of drawn regions.
 *
 * Pure, like `spatial-encoding.ts` — no store, no renderer — so the geometry is
 * testable on its own.
 *
 * WHY THIS IS THE WHOLE SELECTION MECHANISM
 * -----------------------------------------
 * Regions already come from every on-canvas tool the library has: rectangle,
 * polygon, freehand, magic wand, brush. Testing observations against them turns
 * all of those into spatial-omics selection tools without adding a single new
 * canvas interaction — which is why there is no bespoke marquee here.
 *
 * COORDINATE FRAMES
 * -----------------
 * Regions are drawn in WORLD (image) coordinates. Observations live in the
 * dataset's own frame and reach the world through `imageRef` — so they are
 * transformed forward before testing, matching exactly what the renderer draws.
 */

/** A selection over N observations: `mask[i] === 1` when i is selected. */
export interface SpatialSelectionMask {
  mask: Uint8Array;
  count: number;
}

/** An empty selection over `count` observations. */
export function emptySelection(count = 0): SpatialSelectionMask {
  return { mask: new Uint8Array(count), count: 0 };
}

/** Number of set entries in a mask. */
export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** Selected indices, for export or a downstream query. */
export function maskToIndices(mask: Uint8Array): Uint32Array {
  const out = new Uint32Array(countMask(mask));
  let at = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[at++] = i;
  return out;
}

/**
 * Renderer-facing inverse: which observations to MUTE. With nothing selected
 * nothing is muted (the whole tissue reads normally); with a selection, every
 * unselected observation is muted — the CosMx highlight-vs-mute rule.
 */
export function mutedFromSelection(selection: SpatialSelectionMask): Uint8Array | null {
  if (selection.count === 0) return null;
  const muted = new Uint8Array(selection.mask.length);
  for (let i = 0; i < muted.length; i++) muted[i] = selection.mask[i] ? 0 : 1;
  return muted;
}

/** Even-odd ray cast: is (px, py) inside the closed ring xs/ys? */
export function pointInRing(xs: readonly number[], ys: readonly number[], px: number, py: number): boolean {
  let inside = false;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = ys[i];
    const yj = ys[j];
    // Half-open comparison so a vertex on the ray is counted once, not twice.
    if ((yi > py) !== (yj > py)) {
      const t = (py - yi) / (yj - yi);
      if (px < xs[i] + t * (xs[j] - xs[i])) inside = !inside;
    }
  }
  return inside;
}

/** Axis-aligned bounds of a ring, for a cheap reject before the ray cast. */
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

function ringBounds(xs: readonly number[], ys: readonly number[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  return { minX, minY, maxX, maxY };
}

function inBounds(b: Bounds, px: number, py: number): boolean {
  return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY;
}

/** A region flattened to something testable: bounds + a hit test. */
interface Shape {
  bounds: Bounds;
  hit(px: number, py: number): boolean;
}

/** Polygon-with-holes: inside the exterior and outside every hole. */
function polygonShape(
  xs: number[], ys: number[], holes?: number[][][],
): Shape | null {
  if (xs.length < 3) return null;
  const bounds = ringBounds(xs, ys);
  return {
    bounds,
    hit: (px, py) => {
      if (!pointInRing(xs, ys, px, py)) return false;
      // The region model is explicit: a point inside the exterior AND inside a
      // hole is OUTSIDE the region.
      for (const ring of holes ?? []) {
        if (ring.length >= 3
          && pointInRing(ring.map((p) => p[0]), ring.map((p) => p[1]), px, py)) {
          return false;
        }
      }
      return true;
    },
  };
}

/**
 * Flatten a region to testable shapes. Returns an empty array for anything that
 * encloses no area — an open polyline, an intensity-profile line, a degenerate
 * rectangle — so those never contribute to a selection.
 */
export function regionShapes(region: Region): Shape[] {
  // Profile lines belong to the intensity tool, not the annotation set.
  if ((region as unknown as { kind?: string })?.kind === 'profile') return [];
  const b = region?.bounds as unknown as {
    x?: number; y?: number; width?: number; height?: number;
    xpoints?: number[]; ypoints?: number[]; closed?: boolean; holes?: number[][][];
    polygons?: { xpoints: number[]; ypoints: number[]; closed?: boolean; holes?: number[][][] }[];
  } | null | undefined;
  if (!b) return [];

  if (Array.isArray(b.polygons)) {
    return b.polygons.flatMap((p) =>
      p.closed === false ? [] : (polygonShape(p.xpoints ?? [], p.ypoints ?? [], p.holes) ?? []));
  }
  if (Array.isArray(b.xpoints)) {
    if (b.closed === false) return []; // open polyline encloses nothing
    const shape = polygonShape(b.xpoints, b.ypoints ?? [], b.holes);
    return shape ? [shape] : [];
  }
  if (typeof b.width === 'number' && typeof b.height === 'number') {
    const x = b.x ?? 0;
    const y = b.y ?? 0;
    // Normalise a rectangle dragged right-to-left / bottom-to-top.
    const minX = Math.min(x, x + b.width);
    const maxX = Math.max(x, x + b.width);
    const minY = Math.min(y, y + b.height);
    const maxY = Math.max(y, y + b.height);
    if (maxX === minX || maxY === minY) return [];
    const bounds = { minX, minY, maxX, maxY };
    return [{ bounds, hit: (px, py) => inBounds(bounds, px, py) }];
  }
  return [];
}

/**
 * Observations inside ANY of `regions` (union). Coordinates are transformed by
 * `imageRef` first, so the test happens in the same world space the regions were
 * drawn in.
 */
export function selectInRegions(
  observations: SpatialObservations,
  imageRef: SpatialImageRef | undefined,
  regions: readonly Region[],
): SpatialSelectionMask {
  const n = observations.count;
  const mask = new Uint8Array(n);
  const shapes = regions.flatMap((r) => regionShapes(r));
  if (shapes.length === 0) return { mask, count: 0 };

  const [sx, sy] = imageRef?.scale ?? [1, 1];
  const [tx, ty] = imageRef?.translate ?? [0, 0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const px = observations.x[i] * sx + tx;
    const py = observations.y[i] * sy + ty;
    for (const shape of shapes) {
      // Bounds first: a ray cast per observation per region would dominate at
      // 10^5 observations, and most points miss most regions.
      if (!inBounds(shape.bounds, px, py)) continue;
      if (shape.hit(px, py)) {
        mask[i] = 1;
        count++;
        break;
      }
    }
  }
  return { mask, count };
}

/**
 * Select observations whose SCREEN projection falls inside the drawn regions.
 *
 * This is how a region selection works in the 3D cloud. There is no data-space
 * affine to map a drawn shape through, because the shape was drawn on a 2D screen
 * against a perspective camera — so the observations come the other way, already
 * projected to canvas pixels by the renderer (which owns the camera), and the
 * regions are tested in that same screen space.
 *
 * The consequence is worth being explicit about: a screen-space lasso selects
 * through the WHOLE DEPTH of the cloud, like a cookie cutter, not a slab at some
 * chosen z. That is inherent to drawing on a flat screen, and it is what napari
 * and every other orbit-camera point picker do. Orbit and draw again to cut from
 * another angle.
 *
 * `screen` is `[x0, y0, x1, y1, …]` in canvas pixels, `count` entries long. An
 * observation the camera puts behind the eye is given NaN by the projector and
 * never selected.
 */
export function selectInRegionsProjected(
  screen: Float32Array,
  count: number,
  regions: readonly Region[],
): SpatialSelectionMask {
  const mask = new Uint8Array(count);
  const shapes = regions.flatMap((r) => regionShapes(r));
  if (shapes.length === 0) return { mask, count: 0 };

  let hits = 0;
  for (let i = 0; i < count; i++) {
    const px = screen[i * 2];
    const py = screen[i * 2 + 1];
    // Behind the camera, or otherwise unprojectable.
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    for (const shape of shapes) {
      if (!inBounds(shape.bounds, px, py)) continue;
      if (shape.hit(px, py)) {
        mask[i] = 1;
        hits++;
        break;
      }
    }
  }
  return { mask, count: hits };
}

/** Every observation whose categorical code equals `code` — the legend click. */
export function selectByCategory(codes: Uint16Array, code: number): SpatialSelectionMask {
  const mask = new Uint8Array(codes.length);
  let count = 0;
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] === code) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}
