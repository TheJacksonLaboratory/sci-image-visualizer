import { firstValueFrom } from 'rxjs';

import type { IVisualizer } from '../../contracts/visualizer.contract';
import type { TileAccessPort } from '../../contracts/ports/tile-access.port';
import type { Rectangle } from '../../models/region';

/** An image rectangle in full-resolution image pixels. */
export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The current view as RGBA pixels at a chosen scale, and where it sits on the image. */
export interface ViewSample {
  /** RGBA pixels, row-major. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** The image area the pixels cover, in full-resolution image pixels (clipped to the image). */
  rect: ImageRect;
  /** Full-resolution image pixels per sample pixel, per axis: `image = rect.x + px * factorX`. */
  factorX: number;
  factorY: number;
  /** Where the pixels came from: the screen as is, the screen resampled, or a server re-crop. */
  origin: 'displayed' | 'resampled' | 'fetched';
  /** Coarser than the requested scale: the size cap was hit, or the screen pixels were all
   *  there was. The caller can suggest zooming in. */
  coarse: boolean;
}

export interface ViewSampleOptions {
  /**
   * Full-resolution image pixels per output pixel the caller wants (1 = full
   * resolution, 4 = a quarter). Omitted or not positive: the view as displayed.
   */
  targetFactor?: number;
  /** Output size cap in pixels. Default 2048² (about 4.2 MP). */
  maxPixels?: number;
  /** Server-side crop, used when the screen is coarser than the target. Without it the
   *  screen pixels are used as they are, which is correct but coarser than asked. */
  tileAccess?: TileAccessPort | null;
  /** Slice of a stack to crop from. Default 0. */
  zIndex?: number;
  /** Status line while the server crop is fetched. */
  onStatus?: (status: string) => void;
}

/** The view pixels this helper reads (a partial visualizer reads as "no source rect / no image size"). */
export type ViewSource = Pick<
  IVisualizer,
  'getDisplayedPixelData' | 'getDisplayedSourceRect' | 'getTrueImageSize'
>;

/** Default output cap: 2048² pixels. */
export const DEFAULT_VIEW_SAMPLE_MAX_PIXELS = 2048 * 2048;

/** Within this ratio of the target the screen pixels are used as they are. */
const SCALE_TOLERANCE = 0.02;

/**
 * The current view as pixels at the scale a model wants (sci-image-visualizer#98).
 *
 * The extent is what the user sees, clipped to the image, so the margins of a
 * zoomed-out view are not segmented. The resolution is the caller's, not the
 * viewer's: a model trained on objects of a given size in pixels does well only
 * when it gets them at that size, whatever the zoom.
 *
 * - The screen is coarser than the target (zoomed out): the view is re-cropped
 *   on the server at the target scale, when a tile access port is supplied and
 *   the crop succeeds. Otherwise the screen pixels are used.
 * - The screen is finer than the target (zoomed in): the screen pixels are
 *   area-averaged down to the target.
 * - Otherwise: the screen pixels as they are.
 *
 * The output is capped at `maxPixels`. A sample coarser than the target (the
 * cap, or no server crop) sets `coarse`, so the caller can tell the user to zoom in.
 *
 * Returns null when nothing is on screen or the view does not overlap the image.
 */
export async function sampleViewAtScale(
  viz: ViewSource,
  opts: ViewSampleOptions = {},
): Promise<ViewSample | null> {
  const pixels = viz.getDisplayedPixelData?.();
  if (!pixels || pixels.width <= 0 || pixels.height <= 0) return null;
  const view = viz.getDisplayedSourceRect?.() ?? wholeImage(viz) ?? { x: 0, y: 0, ...size(pixels) };
  if (!(view.width > 0) || !(view.height > 0)) return null;

  // The screen window over the image: whole screen pixels, so the mapping stays exact.
  const sx = pixels.width / view.width;
  const sy = pixels.height / view.height;
  const image = viz.getTrueImageSize?.() ?? null;
  const ix0 = image ? Math.max(0, view.x) : view.x;
  const iy0 = image ? Math.max(0, view.y) : view.y;
  const ix1 = image ? Math.min(image.width, view.x + view.width) : view.x + view.width;
  const iy1 = image ? Math.min(image.height, view.y + view.height) : view.y + view.height;
  const px0 = clamp(Math.floor((ix0 - view.x) * sx), 0, pixels.width);
  const py0 = clamp(Math.floor((iy0 - view.y) * sy), 0, pixels.height);
  const px1 = clamp(Math.ceil((ix1 - view.x) * sx), 0, pixels.width);
  const py1 = clamp(Math.ceil((iy1 - view.y) * sy), 0, pixels.height);
  const cw = px1 - px0;
  const ch = py1 - py0;
  if (cw <= 0 || ch <= 0) return null;
  const rect: ImageRect = {
    x: view.x + px0 / sx,
    y: view.y + py0 / sy,
    width: cw / sx,
    height: ch / sy,
  };
  const screen = cropRgba(pixels.data, pixels.width, px0, py0, cw, ch);
  const screenFactor = rect.width / cw;

  // The output size the target asks for, then the cap.
  const requested = opts.targetFactor && opts.targetFactor > 0 ? opts.targetFactor : screenFactor;
  let w = Math.max(1, Math.round(rect.width / requested));
  let h = Math.max(1, Math.round(rect.height / requested));
  const maxPixels = opts.maxPixels && opts.maxPixels > 0 ? opts.maxPixels : DEFAULT_VIEW_SAMPLE_MAX_PIXELS;
  if (w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  const factor = rect.width / w;

  const sample = (data: Uint8ClampedArray, width: number, height: number, origin: ViewSample['origin']) => ({
    data,
    width,
    height,
    rect,
    factorX: rect.width / width,
    factorY: rect.height / height,
    origin,
    coarse: rect.width / width > requested * (1 + SCALE_TOLERANCE),
  });

  if (factor < screenFactor * (1 - SCALE_TOLERANCE)) {
    // Zoomed out past the target: the detail is on the server, not on screen.
    if (opts.tileAccess) {
      opts.onStatus?.('Fetching the view at model resolution…');
      const hi = await fetchCrop(opts.tileAccess, rect, w, h, opts.zIndex ?? 0);
      if (hi) return sample(hi.data, hi.width, hi.height, 'fetched');
    }
    return sample(screen, cw, ch, 'displayed');
  }
  if (factor > screenFactor * (1 + SCALE_TOLERANCE)) {
    // Zoomed in past the target: average the screen down to it.
    return sample(downsampleRgba(screen, cw, ch, w, h), w, h, 'resampled');
  }
  return sample(screen, cw, ch, 'displayed');
}

/**
 * The image's physical pixel size in µm (X axis), or null when the image reports none.
 * Read synchronously from the visualizer's current image metadata.
 */
export function currentMicronsPerPixel(viz: Pick<IVisualizer, 'getImageMeta'>): number | null {
  let mpp: number | null = null;
  // The metadata stream replays the current value on subscribe (a BehaviorSubject),
  // so this reads it without waiting; a stream that does not replay leaves null.
  const sub = viz.getImageMeta?.()?.subscribe((meta) => {
    const m = (meta ?? []).find((e) => (e?.mppX ?? 0) > 0);
    mpp = m ? (m.mppX as number) : null;
  });
  sub?.unsubscribe();
  return mpp;
}

/** Number of z slices of the current image (1 when unknown). */
export function currentSliceCount(viz: Pick<IVisualizer, 'getImageMeta'>): number {
  let z = 1;
  const sub = viz.getImageMeta?.()?.subscribe((meta) => {
    z = Math.max(1, ...(meta ?? []).map((e) => e?.z ?? 1));
  });
  sub?.unsubscribe();
  return z;
}

/** Copy a `w`×`h` window at (x0, y0) out of an RGBA buffer `srcW` wide. */
export function cropRgba(
  src: Uint8ClampedArray,
  srcW: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * srcW + x0) * 4;
    out.set(src.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}

/**
 * Area-average an RGBA image down to `dw`×`dh` (box filter with fractional
 * coverage), so fine texture averages out instead of aliasing as it would with
 * nearest-neighbour sampling.
 */
export function downsampleRgba(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;
  const acc = new Float64Array(4);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * fy;
    const y1 = y0 + fy;
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * fx;
      const x1 = x0 + fx;
      acc.fill(0);
      let total = 0;
      for (let y = Math.floor(y0); y < Math.min(sh, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(sw, Math.ceil(x1)); x++) {
          const wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const i = (y * sw + x) * 4;
          acc[0] += src[i] * wgt;
          acc[1] += src[i + 1] * wgt;
          acc[2] += src[i + 2] * wgt;
          acc[3] += src[i + 3] * wgt;
          total += wgt;
        }
      }
      const o = (dy * dw + dx) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = total > 0 ? acc[c] / total : 0;
    }
  }
  return out;
}

/** Re-crop `rect` on the server at `w`×`h`. Null on any failure, so the caller falls back
 *  to the screen pixels — a coarser view beats a failed run. */
async function fetchCrop(
  tiles: TileAccessPort,
  rect: ImageRect,
  w: number,
  h: number,
  zIndex: number,
): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  if (w < 16 || h < 16) return null;
  try {
    const roi = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    } as Rectangle;
    const screen = { x: 0, y: 0, width: w, height: h } as Rectangle;
    const bytes = await firstValueFrom(tiles.zoomOnRegion(roi, screen, zIndex));
    if (!bytes || bytes.byteLength === 0) return null;
    const bitmap = await createImageBitmap(new Blob([bytes]));
    // Read the size BEFORE close(): closing an ImageBitmap zeroes it.
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const out = ctx.getImageData(0, 0, width, height);
    return { data: out.data, width, height };
  } catch {
    return null;
  }
}

function wholeImage(viz: ViewSource): ImageRect | null {
  const s = viz.getTrueImageSize?.();
  return s && s.width > 0 && s.height > 0 ? { x: 0, y: 0, width: s.width, height: s.height } : null;
}

function size(p: { width: number; height: number }): { width: number; height: number } {
  return { width: p.width, height: p.height };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
