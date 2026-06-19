import { Region, Rectangle, Polygon, MultiPolygon } from '../models/region';

/** A single closed ring (+ optional holes) in image-pixel coordinates. A region
 *  rasterizes as the union of its parts. Plain data so it survives a
 *  `postMessage` structured clone into the mask worker. */
export interface MaskPart {
  xpoints: number[];
  ypoints: number[];
  holes?: number[][][];
}

/** A bbox-relative binary mask, as returned by `WandService.rasterizePolygon`. */
export interface BBoxMask {
  bx: number;
  by: number;
  bw: number;
  bh: number;
  mask: Uint8Array;
}

/** Polygon-fill function (the wand's scanline rasterizer), injected so this
 *  module stays free of Angular/DOM and can run inside a worker. */
export type RasterizeFn = (
  xpoints: number[],
  ypoints: number[],
  imageWidth: number,
  imageHeight: number,
  holes?: number[][][],
) => BBoxMask | null;

/**
 * The largest mask we will allocate, in pixels. A single-channel 8-bit mask is
 * one byte per pixel, so this is also its byte size. Whole-slide level-0 images
 * (e.g. 119040×90112 ≈ 1.07e10 px) blow past both the JS typed-array length cap
 * (~4.29e9) and available memory, so masks for images larger than this are
 * rasterized at a proportionally downscaled resolution. ~100 MP ≈ 100 MB.
 */
export const MAX_MASK_PIXELS = 100_000_000;

/** Downscale factor (≤ 1) to keep `width * height` within {@link MAX_MASK_PIXELS}.
 *  1 when the image already fits. */
export function maskScaleFor(width: number, height: number): number {
  const total = width * height;
  if (!Number.isFinite(total) || total <= MAX_MASK_PIXELS) return 1;
  return Math.sqrt(MAX_MASK_PIXELS / total);
}

/** Multiply every coordinate (and hole coordinate) of a region's parts by
 *  `scale`, for rasterizing into a downscaled mask. Returns the parts unchanged
 *  when `scale` is 1. */
export function scaleParts(parts: MaskPart[], scale: number): MaskPart[] {
  if (scale === 1) return parts;
  return parts.map((p) => ({
    xpoints: p.xpoints.map((x) => x * scale),
    ypoints: p.ypoints.map((y) => y * scale),
    holes: p.holes?.map((ring) => ring.map(([x, y]) => [x * scale, y * scale])),
  }));
}

/** Flatten a region's geometry to plain rings. Rectangles become a 4-point ring;
 *  polygons keep their points + holes; multi-polygons expand to one part each. */
export function regionToParts(region: Region): MaskPart[] {
  const b = region.bounds;
  if (b instanceof Rectangle) {
    return [{
      xpoints: [b.x, b.x + b.width, b.x + b.width, b.x],
      ypoints: [b.y, b.y, b.y + b.height, b.y + b.height],
    }];
  }
  if (b instanceof Polygon) {
    return [{ xpoints: b.xpoints, ypoints: b.ypoints, holes: b.holes }];
  }
  if (b instanceof MultiPolygon) {
    return b.polygons.map((p) => ({ xpoints: p.xpoints, ypoints: p.ypoints, holes: p.holes }));
  }
  return [];
}

/** A rasterized label mask plus the PNG bit depth it should be encoded at. */
export interface LabelMask {
  data: Uint8Array | Uint16Array;
  /** 8 for ≤255 distinct values, 16 for a multi-class mask with >255 regions. */
  bitDepth: 8 | 16;
}

/**
 * Rasterize regions (as plain parts) to a full image-size label mask (row-major,
 * `W * H` samples; pixel `(x, y)` at `y * W + x`). Background is 0.
 *
 * - `'binary'` — every region pixel is 255 (standard 8-bit black/white mask:
 *   `> 0` = foreground; also directly viewable).
 * - `'multiclass'` — each region gets a distinct 1-based id (its index + 1).
 *   Stays 8-bit for ≤255 regions; promotes to a 16-bit mask beyond that so ids
 *   never collide (up to 65535 regions).
 *
 * Later regions paint over earlier ones where they overlap. `onProgress` is
 * called after each region (1-based) so a caller can drive a progress bar.
 * Returns null when nothing rasterises (no regions, zero/insane size).
 */
export function regionsToMask(
  regions: MaskPart[][],
  imageWidth: number,
  imageHeight: number,
  mode: 'binary' | 'multiclass',
  rasterize: RasterizeFn,
  onProgress?: (done: number, total: number) => void,
): LabelMask | null {
  const W = Math.round(imageWidth);
  const H = Math.round(imageHeight);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0 || !regions?.length) {
    return null;
  }

  const multiclass = mode === 'multiclass';
  const bitDepth: 8 | 16 = multiclass && regions.length > 255 ? 16 : 8;
  const out: Uint8Array | Uint16Array =
    bitDepth === 16 ? new Uint16Array(W * H) : new Uint8Array(W * H);
  let painted = false;
  for (let i = 0; i < regions.length; i++) {
    // Binary → 255 (viewable, standard). Multi-class → 1-based class id.
    const value = multiclass ? i + 1 : 255;
    for (const part of regions[i]) {
      const m = rasterize(part.xpoints, part.ypoints, W, H, part.holes);
      if (!m) continue;
      painted = true;
      for (let y = 0; y < m.bh; y++) {
        const srcRow = y * m.bw;
        const dstRow = (m.by + y) * W + m.bx;
        for (let x = 0; x < m.bw; x++) {
          if (m.mask[srcRow + x]) out[dstRow + x] = value;
        }
      }
    }
    onProgress?.(i + 1, regions.length);
  }
  return painted ? { data: out, bitDepth } : null;
}
