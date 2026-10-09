import type { CachedImageData } from '../wand/wand-tool.service';
import { MatrixFrame } from '../tool-kit/matrix-frame';

/** A client-side crop of the loaded image — the browser equivalent of the JIT
 *  server slide-crop, taken from the pixels already in the viewer. */
export interface CroppedImage {
  /** RGBA pixels of the crop, row-major. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Crop origin in image (matrix) coords — lets masks map back to the frame. */
  matrixX0: number;
  matrixY0: number;
}

/** A box in image *data* coordinates (as stored on a Rectangle region). */
export interface DataBox { x0: number; y0: number; x1: number; y1: number; }

/**
 * Browser "slide crop": extract the box region (data coords) from a cached image
 * frame as an RGBA image, clamped to the image bounds. Returns null when the box
 * is empty/outside the image.
 *
 * The output feeds an automatic segmenter (e.g. cellpose-SAM): run it on the
 * crop, then offset the resulting masks by (matrixX0, matrixY0) to place them
 * back on the full frame.
 */
export function cropImageRegion(
  cached: CachedImageData, frameIndex: number, box: DataBox,
): CroppedImage | null {
  const frame = MatrixFrame.from(cached);
  // data -> image (matrix) coords, normalized + clamped to the frame.
  const clampX = (v: number) => Math.max(0, Math.min(cached.width, v));
  const clampY = (v: number) => Math.max(0, Math.min(cached.height, v));
  const mx0 = clampX(Math.round(frame.toMatrixX(Math.min(box.x0, box.x1))));
  const my0 = clampY(Math.round(frame.toMatrixY(Math.min(box.y0, box.y1))));
  const mx1 = clampX(Math.round(frame.toMatrixX(Math.max(box.x0, box.x1))));
  const my1 = clampY(Math.round(frame.toMatrixY(Math.max(box.y0, box.y1))));
  const cw = mx1 - mx0;
  const ch = my1 - my0;
  if (cw <= 0 || ch <= 0) return null;
  const data = frameRegionToRgba(cached, frameIndex, mx0, my0, cw, ch);
  return { data, width: cw, height: ch, matrixX0: mx0, matrixY0: my0 };
}

/**
 * RGBA pixels of the `w`×`h` matrix window at (x0, y0) of a cached frame.
 * Grayscale frames are replicated across R/G/B; RGB tuples are copied through.
 * Missing pixels become opaque black.
 */
export function frameRegionToRgba(
  cached: CachedImageData, frameIndex: number, x0: number, y0: number, w: number, h: number,
): Uint8ClampedArray {
  const frame = cached.frames[frameIndex] ?? cached.frames[0];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = frame?.[y0 + y];
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const px = row?.[x0 + x];
      if (px == null) { data[o + 3] = 255; continue; }
      if (cached.isGrayscale) {
        const v = px as number;
        data[o] = v; data[o + 1] = v; data[o + 2] = v;
      } else {
        const t = px as number[];
        data[o] = t[0]; data[o + 1] = t[1]; data[o + 2] = t[2];
      }
      data[o + 3] = 255;
    }
  }
  return data;
}
