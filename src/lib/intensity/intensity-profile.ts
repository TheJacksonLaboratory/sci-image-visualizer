import { IntensityProfile } from '../contracts/visualizer.contract';
import { IImageMetadata } from '../contracts/image.contract';
import { bt601Luminance } from '../contracts/intensity';
import { Region } from '../models/region';

/**
 * Pure intensity-profile math: sampling a line through a pixel frame, placing a
 * new profile line, and the image's physical pixel size. Frames are row-major
 * matrices: grayscale cells are numbers, RGB cells are `[r, g, b]`.
 */

/** Bright, well-separated colours cycled as the user adds profile lines.
 *  The matching inset trace is drawn in the same colour. */
export const PROFILE_PALETTE: readonly string[] = [
  '#FFD400', // yellow
  '#00E5FF', // cyan
  '#FF2D95', // magenta
  '#39FF14', // green
  '#FF9500', // orange
  '#7C4DFF', // violet
  '#FF3B30', // red
  '#18FFFF', // aqua
];

/** A sampling line in image (data) coordinates. */
export interface ProfileLine { x0: number; y0: number; x1: number; y1: number; }

/** One frame to sample and how it maps onto the image. */
export interface SamplingFrame {
  /** The pixel matrix (row-major). */
  frame: any[];
  /** [xRatio, yRatio]: image units per frame pixel. */
  ratios: number[];
  /** Image coordinate of the frame's pixel (0,0): [0,0] for the full image, a
   *  crop's top-left for a zoom crop. */
  origin: [number, number];
}

/** Physical pixel size (microns/pixel), if known. mpp is constant across
 *  frames/channels, so the first metadata entry with a positive mppX wins. */
export function imageMpp(meta: IImageMetadata[] | undefined): { mppX: number | null; mppY: number | null } {
  const m = Array.isArray(meta) ? (meta.find((e) => e && (e.mppX ?? 0) > 0) ?? meta[0]) : undefined;
  const mppX = m && (m.mppX ?? 0) > 0 ? (m.mppX as number) : null;
  const mppY = m && (m.mppY ?? 0) > 0 ? (m.mppY as number) : null;
  return { mppX, mppY };
}

/**
 * Sample a frame's intensity (grayscale value or RGB luminance) along `line`.
 * Positions are the distance along the line, in microns when `mpp` is known
 * (anisotropic mppX/mppY applied per axis, so diagonals measure their true
 * length), otherwise in image pixels. One sample per frame pixel along the line.
 */
export function sampleLine(src: SamplingFrame, line: ProfileLine,
                           mpp: { mppX: number | null; mppY: number | null }): IntensityProfile {
  const frame = src.frame;
  if (!frame?.length) return { positions: [], values: [] };
  const rx = src.ratios[0] || 1;
  const ry = src.ratios[1] || rx;
  const [ox, oy] = src.origin;
  const x0 = +line.x0, y0 = +line.y0, x1 = +line.x1, y1 = +line.y1;
  const dxData = x1 - x0, dyData = y1 - y0;
  const { mppX, mppY } = mpp;
  const useMicrons = mppX != null;
  const lenData = useMicrons
    ? Math.hypot(dxData * mppX, dyData * (mppY ?? mppX))
    : Math.hypot(dxData, dyData);
  const lenPx = Math.hypot(dxData / rx, dyData / ry);
  const n = Math.max(2, Math.round(lenPx));
  const h = frame.length;
  const w = frame[0].length;
  const positions: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Data coords → the frame's pixel grid, offset by its origin (a zoom crop).
    const px = Math.round((x0 + t * dxData - ox) / rx);
    const py = Math.round((y0 + t * dyData - oy) / ry);
    let v = 0;
    if (px >= 0 && px < w && py >= 0 && py < h) {
      const cell = frame[py][px];
      v = Array.isArray(cell) ? bt601Luminance(cell[0], cell[1], cell[2]) : cell;
    }
    positions.push(t * lenData);
    values.push(v);
  }
  return { positions, values, unit: useMicrons ? 'µm' : 'px' };
}

/** A profile-line region's two endpoints, or null when it has no polyline.
 *  Duck-typed (not `instanceof Polygon`): after a drag round-trips through the
 *  store the bounds can be a plain object, so this matches on the point arrays. */
export function profileLineOf(region: Region): ProfileLine | null {
  const poly = region.bounds as { xpoints?: unknown; ypoints?: unknown } | undefined;
  if (!poly || !Array.isArray(poly.xpoints) || !Array.isArray(poly.ypoints) ||
      poly.xpoints.length < 2 || poly.ypoints.length < 2) {
    return null;
  }
  return { x0: poly.xpoints[0], y0: poly.ypoints[0], x1: poly.xpoints[1], y1: poly.ypoints[1] };
}

/** An image-pixel rectangle. */
export interface PixelRect { x: number; y: number; width: number; height: number; }

/**
 * Where the `count`-th profile line goes: a horizontal line spanning 2/3 of
 * the visible part of the image (`roi`, when it overlaps the image extent
 * `[x0, x1, y0, y1]`; else the whole image), centred, staggered down the visible
 * band so successive lines stay distinct.
 */
export function placeProfileLine(extent: number[], roi: PixelRect | null, count: number):
  { x0: number; x1: number; y: number } {
  const [imgX0, imgX1, imgTop, imgBottom] = extent;
  const overlaps = !!roi && roi.width > 0 && roi.height > 0
    && roi.x < imgX1 && roi.x + roi.width > imgX0
    && roi.y < imgBottom && roi.y + roi.height > imgTop;
  const x0v = overlaps ? Math.max(imgX0, roi!.x) : imgX0;
  const x1v = overlaps ? Math.min(imgX1, roi!.x + roi!.width) : imgX1;
  const topV = overlaps ? Math.max(imgTop, roi!.y) : imgTop;
  const bottomV = overlaps ? Math.min(imgBottom, roi!.y + roi!.height) : imgBottom;
  const cx = (x0v + x1v) / 2;
  const half = ((x1v - x0v) * (2 / 3)) / 2;
  const bandH = bottomV - topV;
  const midY = (topV + bottomV) / 2;
  const y = Math.min(bottomV, Math.max(topV, midY + count * bandH * 0.12));
  return { x0: cx - half, x1: cx + half, y };
}
