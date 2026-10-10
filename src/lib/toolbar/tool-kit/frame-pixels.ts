/**
 * The pixel frames a backend hands the canvas tools (`CachedImageData.frames`),
 * and the one accessor every tool reads them through (wand patch extraction,
 * SAM encoder input, Cellpose crop).
 *
 * A frame is either
 * - **nested** — `[y][x]` rows of grayscale values or `[r, g, b]` tuples, which
 *   is what the Plotly backend caches (its frames double as the heatmap data and
 *   may hold raw, non-8-bit intensities), or
 * - **packed** — a row-major RGBA `Uint8ClampedArray`, which is what a canvas or
 *   GPU readback already is. OpenSeadragon and napari-js hand theirs over as-is
 *   instead of building one JS array per pixel (RT-17, OSD-PLOTLY-12,
 *   NAPARI-SVC-23).
 */

/** A row-major RGBA readback (alpha is ignored). */
export interface PackedFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly channels: 4;
}

/** `[y][x]` grayscale values, or `[y][x]` `[r, g, b]` tuples. */
export type NestedFrame = number[][] | number[][][];

/** One frame of `CachedImageData.frames`. */
export type CachedFrame = NestedFrame | PackedFrame;

/** Whether `frame` is the packed RGBA form. */
export function isPackedFrame(frame: unknown): frame is PackedFrame {
  return !!frame && !Array.isArray(frame) && (frame as PackedFrame).data instanceof Uint8ClampedArray;
}

/** Wrap a row-major RGBA readback as a frame, without copying it. */
export function packedFrame(data: Uint8ClampedArray, width: number, height: number): PackedFrame {
  return { data, width, height, channels: 4 };
}

/** Reads one frame's pixels whatever its form. */
export interface FramePixels {
  /**
   * Pixel (x, y) as RGB in `out[0..2]` (a grayscale value is replicated, and
   * kept unclamped). False — `out` untouched — outside the frame or for a
   * missing pixel. A packed frame always reads as RGB.
   */
  rgb(x: number, y: number, out: number[]): boolean;
  /**
   * `w` pixels of row `y` from column `x0`, as opaque RGBA into `dst` from
   * offset `o`. Missing pixels become opaque black.
   */
  rgbaRow(y: number, x0: number, w: number, dst: Uint8ClampedArray, o: number): void;
}

/** The accessor for `frame`; `isGrayscale` describes a nested frame's cells. */
export function framePixels(frame: CachedFrame | undefined, isGrayscale: boolean): FramePixels {
  if (isPackedFrame(frame)) return packedPixels(frame);
  return isGrayscale
    ? nestedGrayPixels(frame as number[][] | undefined)
    : nestedRgbPixels(frame as number[][][] | undefined);
}

function packedPixels(frame: PackedFrame): FramePixels {
  const { data, width, height } = frame;
  return {
    rgb(x, y, out) {
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      const s = (y * width + x) * 4;
      out[0] = data[s];
      out[1] = data[s + 1];
      out[2] = data[s + 2];
      return true;
    },
    rgbaRow(y, x0, w, dst, o) {
      const inRow = y >= 0 && y < height;
      for (let x = 0; x < w; x++, o += 4) {
        const ix = x0 + x;
        if (inRow && ix >= 0 && ix < width) {
          const s = (y * width + ix) * 4;
          dst[o] = data[s];
          dst[o + 1] = data[s + 1];
          dst[o + 2] = data[s + 2];
        }
        dst[o + 3] = 255;
      }
    },
  };
}

function nestedGrayPixels(frame: number[][] | undefined): FramePixels {
  return {
    rgb(x, y, out) {
      const v = frame?.[y]?.[x];
      if (v == null) return false;
      out[0] = v;
      out[1] = v;
      out[2] = v;
      return true;
    },
    rgbaRow(y, x0, w, dst, o) {
      const row = frame?.[y];
      for (let x = 0; x < w; x++, o += 4) {
        const v = row?.[x0 + x];
        if (v != null) {
          dst[o] = v;
          dst[o + 1] = v;
          dst[o + 2] = v;
        }
        dst[o + 3] = 255;
      }
    },
  };
}

function nestedRgbPixels(frame: number[][][] | undefined): FramePixels {
  return {
    rgb(x, y, out) {
      const t = frame?.[y]?.[x];
      if (t == null) return false;
      out[0] = t[0];
      out[1] = t[1];
      out[2] = t[2];
      return true;
    },
    rgbaRow(y, x0, w, dst, o) {
      const row = frame?.[y];
      for (let x = 0; x < w; x++, o += 4) {
        const t = row?.[x0 + x];
        if (t != null) {
          dst[o] = t[0];
          dst[o + 1] = t[1];
          dst[o + 2] = t[2];
        }
        dst[o + 3] = 255;
      }
    },
  };
}
