/**
 * Pure binary-mask helpers: polygon rasterization and bbox-relative mask
 * set operations. No DOM, no Angular — the mask-export worker imports this.
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

/**
 * Rasterize a closed polygon (minus its holes) into a bbox-relative mask, e.g.
 * as the starting point for a wand/brush stroke accumulator.
 *
 * Returns the bbox origin plus the filled mask, or null if the polygon is
 * degenerate. The polygon's full extent is kept even where it is negative or
 * exceeds `imageWidth`×`imageHeight`; only a bbox larger than
 * {@link MAX_RASTER_PIXELS} is clipped to that window.
 */
export function rasterizePolygon(xpoints: number[], ypoints: number[],
                                 imageWidth: number, imageHeight: number,
                                 holes?: number[][][]): BBoxMask | null {
  const n = xpoints.length;
  if (n < 3) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xpoints[i] < minX) minX = xpoints[i];
    if (xpoints[i] > maxX) maxX = xpoints[i];
    if (ypoints[i] < minY) minY = ypoints[i];
    if (ypoints[i] > maxY) maxY = ypoints[i];
  }
  // Rasterize the polygon's FULL extent (not clamped to the viewport), so a region that's
  // partially off the visible/zoomed area keeps its off-screen part when the wand/brush extends
  // it — the coords here are viewport-matrix units and may be negative or exceed the viewport
  // (jit-ui#102). Memory guard: a region that's enormous at the current zoom would allocate a
  // giant mask, so only then fall back to the viewport window (rare; accepts the clip).
  let bx = Math.floor(minX);
  let by = Math.floor(minY);
  let bx1 = Math.ceil(maxX) + 1;
  let by1 = Math.ceil(maxY) + 1;
  if ((bx1 - bx) * (by1 - by) > MAX_RASTER_PIXELS) {
    bx = Math.max(0, bx);
    by = Math.max(0, by);
    bx1 = Math.min(imageWidth, bx1);
    by1 = Math.min(imageHeight, by1);
  }
  const bw = bx1 - bx;
  const bh = by1 - by;
  if (bw <= 0 || bh <= 0) return null;

  const mask = new Uint8Array(bw * bh);
  // Scanline ring fill — sample each row at its pixel centre, writing `value`
  // (1 to fill the exterior, 0 to punch a hole back out).
  const fillRing = (rx: number[], ry: number[], value: number) => {
    const m = rx.length;
    if (m < 3) return;
    for (let py = 0; py < bh; py++) {
      const y = by + py + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const yi = ry[i], yj = ry[j];
        if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
          const t = (y - yi) / (yj - yi);
          xs.push(rx[i] + t * (rx[j] - rx[i]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xStart = Math.max(0, Math.ceil(xs[k] - bx));
        const xEnd = Math.min(bw - 1, Math.floor(xs[k + 1] - bx));
        for (let x = xStart; x <= xEnd; x++) mask[py * bw + x] = value;
      }
    }
  };
  fillRing(xpoints, ypoints, 1);
  if (holes) {
    for (const ring of holes) {
      fillRing(ring.map((p) => p[0]), ring.map((p) => p[1]), 0);
    }
  }
  return { bx, by, bw, bh, mask };
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
