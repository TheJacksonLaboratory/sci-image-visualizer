import { rasterizePolygon as rasterizeRing } from 'napari-js/geometry';

/**
 * Pure binary-mask helpers: polygon rasterization (napari-js's `rasterizePolygon`)
 * and bbox-relative mask set operations. No DOM, no Angular — the mask-export
 * worker imports this.
 */

/** A bbox-relative binary mask (1 = filled, 0 = empty) whose pixel (0,0) sits
 *  at (bx, by) in the frame it was rasterized in. */
export interface BBoxMask {
  bx: number;
  by: number;
  bw: number;
  bh: number;
  mask: Uint8Array;
}

/**
 * The largest bbox (in pixels) {@link rasterizePolygon} allocates before it
 * falls back to clipping at the window. Also the cap the wand/brush use to
 * decide whether a region can be edited at the current zoom.
 */
export const MAX_RASTER_PIXELS = 4096 * 4096;

/** `[x0, y0, x1, y1, …]` from parallel arrays, the ring layout napari-js takes. */
function flatRing(xs: ArrayLike<number>, ys: ArrayLike<number>): number[] {
  const out = new Array<number>(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    out[i * 2] = xs[i];
    out[i * 2 + 1] = ys[i];
  }
  return out;
}

/**
 * Rasterize a closed polygon (minus its holes) into a bbox-relative mask, e.g.
 * as the starting point for a wand/brush stroke accumulator.
 *
 * Pixel (px, py) covers `[px, px + 1) × [py, py + 1)` and is set when its centre
 * is inside — the rule under which the pixel-edge outlines `geometry/contour`
 * traces come back as exactly the pixels they were traced from.
 *
 * Returns the bbox origin plus the filled mask, or null if the polygon is
 * degenerate (covers no pixel centre). The polygon's full extent is kept even
 * where it is negative or exceeds `imageWidth`×`imageHeight` (jit-ui#102); only
 * a bbox larger than {@link MAX_RASTER_PIXELS} is clipped to that window (rare:
 * a region enormous at the current zoom; accepts the clip).
 */
export function rasterizePolygon(
  xpoints: number[],
  ypoints: number[],
  imageWidth: number,
  imageHeight: number,
  holes?: number[][][],
): BBoxMask | null {
  if (xpoints.length < 3) return null;
  const outer = flatRing(xpoints, ypoints);
  const inner = holes?.map((ring) =>
    flatRing(
      ring.map((p) => p[0]),
      ring.map((p) => p[1]),
    ),
  );
  const bounds = { x: 0, y: 0, width: imageWidth, height: imageHeight };
  let m: ReturnType<typeof rasterizeRing>;
  try {
    m = rasterizeRing(outer, inner, { bounds, maxPixels: MAX_RASTER_PIXELS });
  } catch (err) {
    // Still over the cap once clipped to the window (a large export mask): allocate the clip.
    if (!(err instanceof RangeError)) throw err;
    m = rasterizeRing(outer, inner, { bounds, clip: true, maxPixels: Infinity });
  }
  return m && { bx: m.x, by: m.y, bw: m.width, bh: m.height, mask: m.data };
}

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
