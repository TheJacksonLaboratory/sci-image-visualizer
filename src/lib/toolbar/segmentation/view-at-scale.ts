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

/** The view on screen, read once: its pixels (RGBA) over the image area they cover. */
export interface ViewCapture {
  /** RGBA screen pixels of the view, clipped to the image. */
  screen: Uint8ClampedArray;
  width: number;
  height: number;
  /** The image area the screen pixels cover (full-resolution image pixels). */
  rect: ImageRect;
}

/**
 * Read the view on screen, clipped to the image so the margins of a zoomed-out view
 * are dropped (the window is whole screen pixels, so the mapping stays exact). Null
 * when nothing is on screen or the view does not overlap the image.
 */
export function captureView(viz: ViewSource): ViewCapture | null {
  const pixels = viz.getDisplayedPixelData?.();
  if (!pixels || pixels.width <= 0 || pixels.height <= 0) return null;
  const view = viz.getDisplayedSourceRect?.() ?? wholeImage(viz) ?? { x: 0, y: 0, ...size(pixels) };
  if (!(view.width > 0) || !(view.height > 0)) return null;
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
  return {
    screen: cropRgba(toRgba(pixels), pixels.width, px0, py0, cw, ch),
    width: cw,
    height: ch,
    rect: { x: view.x + px0 / sx, y: view.y + py0 / sy, width: cw / sx, height: ch / sy },
  };
}

/** Options of {@link sampleCaptureRect}. */
export interface SampleRectOptions {
  /** Server-side crop, used when the screen is coarser than the scale asked for. */
  tileAccess?: TileAccessPort | null;
  /** Slice of a stack to crop from. Default 0. */
  zIndex?: number;
  /** Status line while the server crop is fetched. */
  onStatus?: (status: string) => void;
}

/**
 * Part of a captured view (`rect`, inside `capture.rect`) at `factor` image pixels per
 * output pixel: re-cropped on the server when the screen is coarser (when a tile access
 * port is given and the crop succeeds; else the screen pixels, flagged `coarse`), area-
 * averaged down when the screen is finer, else the screen pixels as they are.
 */
export async function sampleCaptureRect(
  capture: ViewCapture,
  rect: ImageRect,
  factor: number,
  opts: SampleRectOptions = {},
): Promise<ViewSample> {
  const c = capture.rect;
  const sx = capture.width / c.width;
  const sy = capture.height / c.height;
  // The screen window over `rect`, in whole screen pixels.
  const px0 = clamp(Math.floor((rect.x - c.x) * sx), 0, capture.width);
  const py0 = clamp(Math.floor((rect.y - c.y) * sy), 0, capture.height);
  const px1 = clamp(Math.ceil((rect.x + rect.width - c.x) * sx), px0 + 1, capture.width);
  const py1 = clamp(Math.ceil((rect.y + rect.height - c.y) * sy), py0 + 1, capture.height);
  const cw = Math.max(1, px1 - px0);
  const ch = Math.max(1, py1 - py0);
  const screenRect: ImageRect = { x: c.x + px0 / sx, y: c.y + py0 / sy, width: cw / sx, height: ch / sy };
  const screenFactor = c.width / capture.width;
  const crop = () =>
    px0 === 0 && py0 === 0 && cw === capture.width && ch === capture.height
      ? capture.screen
      : cropRgba(capture.screen, capture.width, px0, py0, cw, ch);

  const sample = (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    at: ImageRect,
    origin: ViewSample['origin'],
  ): ViewSample => ({
    data,
    width,
    height,
    rect: at,
    factorX: at.width / width,
    factorY: at.height / height,
    origin,
    coarse: at.width / width > factor * (1 + SCALE_TOLERANCE),
  });

  if (factor < screenFactor * (1 - SCALE_TOLERANCE)) {
    // Zoomed out past the scale asked for: the detail is on the server, not on screen.
    if (opts.tileAccess) {
      opts.onStatus?.('Fetching the view at model resolution…');
      const w = Math.max(1, Math.round(rect.width / factor));
      const h = Math.max(1, Math.round(rect.height / factor));
      const hi = await fetchCrop(opts.tileAccess, rect, w, h, opts.zIndex ?? 0);
      if (hi) return sample(hi.data, hi.width, hi.height, rect, 'fetched');
    }
    return sample(crop(), cw, ch, screenRect, 'displayed');
  }
  if (factor > screenFactor * (1 + SCALE_TOLERANCE)) {
    // Zoomed in past it: average the screen down.
    const w = Math.max(1, Math.round(screenRect.width / factor));
    const h = Math.max(1, Math.round(screenRect.height / factor));
    return sample(downsampleRgba(crop(), cw, ch, w, h), w, h, screenRect, 'resampled');
  }
  return sample(crop(), cw, ch, screenRect, 'displayed');
}

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
  const capture = captureView(viz);
  if (!capture) return null;
  const rect = capture.rect;
  const screenFactor = rect.width / capture.width;
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
  const sample = await sampleCaptureRect(capture, rect, rect.width / w, opts);
  return { ...sample, coarse: sample.factorX > requested * (1 + SCALE_TOLERANCE) };
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

/**
 * A readback as RGBA. Backends return 1 channel (Plotly's grayscale heatmap trace),
 * 3 (Plotly's RGB image trace) or 4 (OSD and napari canvases): grayscale is
 * replicated across R, G and B, and RGB gets an opaque alpha.
 */
export function toRgba(pixels: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
}): Uint8ClampedArray {
  const n = pixels.width * pixels.height;
  const ch = pixels.channels || Math.round(pixels.data.length / Math.max(1, n)) || 4;
  if (ch === 4) return pixels.data;
  const out = new Uint8ClampedArray(n * 4);
  const src = pixels.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (ch >= 3) {
      out[o] = src[i * ch];
      out[o + 1] = src[i * ch + 1];
      out[o + 2] = src[i * ch + 2];
    } else {
      const v = src[i * ch];
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
    }
    out[o + 3] = 255;
  }
  return out;
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
