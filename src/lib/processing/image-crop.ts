import { ProcessingImage } from './processing-image';

/** Crop options in source-image pixels. Out-of-range values are clamped. */
export interface CropImageOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Power-of-two downsample level applied to the crop (0 = full resolution). */
  level?: number;
}

/** Copy a clamped rectangle of an RGBA source into a fresh, tightly-packed buffer. */
function cropRgba(
  src: Uint8ClampedArray, srcWidth: number, srcHeight: number,
  x: number, y: number, w: number, h: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  // Clamp the rectangle to the image so bad params snap to the valid region
  // instead of reading out of bounds.
  const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(y)));
  const width = Math.max(1, Math.min(srcWidth - x0, Math.floor(w)));
  const height = Math.max(1, Math.min(srcHeight - y0, Math.floor(h)));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const srcRow = (y0 + row) * srcWidth + x0;
    const dstRow = row * width;
    for (let col = 0; col < width; col++) {
      const si = (srcRow + col) * 4;
      const di = (dstRow + col) * 4;
      out[di]     = src[si]     as number;
      out[di + 1] = src[si + 1] as number;
      out[di + 2] = src[si + 2] as number;
      out[di + 3] = src[si + 3] as number;
    }
  }
  return { data: out, width, height };
}

/** Nearest-neighbour downsample by an integer factor (≥1). factor=1 is a no-op. */
function downsampleRgba(
  src: Uint8ClampedArray, srcWidth: number, srcHeight: number, factor: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  if (factor <= 1) return { data: src, width: srcWidth, height: srcHeight };
  const width = Math.max(1, Math.floor(srcWidth / factor));
  const height = Math.max(1, Math.floor(srcHeight / factor));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sy = Math.min(srcHeight - 1, row * factor);
    for (let col = 0; col < width; col++) {
      const sx = Math.min(srcWidth - 1, col * factor);
      const si = (sy * srcWidth + sx) * 4;
      const di = (row * width + col) * 4;
      out[di]     = src[si]     as number;
      out[di + 1] = src[si + 1] as number;
      out[di + 2] = src[si + 2] as number;
      out[di + 3] = src[si + 3] as number;
    }
  }
  return { data: out, width, height };
}

/**
 * Crop a rectangular region out of a {@link ProcessingImage} (browser-side, the
 * counterpart of the JIT server's Slide Crop), optionally downsampling the crop
 * by `2^level`. The rectangle is in source pixels and clamped to the image, so
 * out-of-range values snap to the valid region rather than throwing. Always
 * returns a 4-channel (RGBA) image.
 */
export function cropImage(image: ProcessingImage, opts: CropImageOptions = {}): ProcessingImage {
  // Work on RGBA so the crop is channel-count agnostic.
  const src = image.channels === 4 ? image.data : image.toImageData().data;
  const cropped = cropRgba(
    src, image.width, image.height,
    Number(opts.x ?? 0), Number(opts.y ?? 0),
    Number(opts.width ?? image.width), Number(opts.height ?? image.height),
  );
  const level = Math.max(0, Math.floor(Number(opts.level ?? 0)));
  const factor = level > 0 ? 2 ** level : 1;
  const final = downsampleRgba(cropped.data, cropped.width, cropped.height, factor);
  return new ProcessingImage(final.width, final.height, 4, final.data);
}
