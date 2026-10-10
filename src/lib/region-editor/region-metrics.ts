import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { IImageMetadata } from '../contracts/image.contract';

/** Physical pixel size (µm/pixel); both undefined when the image is unscaled. */
export interface PixelSize {
  mppX?: number;
  mppY?: number;
}

/**
 * Choose the physical pixel size for area display from the image meta. The
 * calibration may sit on any channel entry, not necessarily [0], so take the
 * first entry with a positive mppX (as PlotlyService.currentMpp does). With
 * only one axis reported, pixels are square (mppY = mppX), so a scaled image
 * shows µm²/mm² rather than px².
 */
export function pickMpp(meta: IImageMetadata[] | undefined): PixelSize {
  const m = Array.isArray(meta)
    ? (meta.find((e) => e && (e.mppX ?? 0) > 0) ?? meta[0])
    : undefined;
  const mx = m && (m.mppX ?? 0) > 0 ? (m.mppX as number) : undefined;
  const my = m && (m.mppY ?? 0) > 0 ? (m.mppY as number) : undefined;
  return { mppX: mx, mppY: my ?? mx };
}

/**
 * A region's area in px²: width·height for a rectangle, shoelace for a polygon
 * with each interior ring (hole) subtracted (a donut reports the annulus), and
 * the sum of the parts for a multi-polygon (jit-ui#85). 0 for anything else.
 */
export function regionAreaPx(region: Pick<Region, 'bounds'>): number {
  const b = region.bounds;
  if (b instanceof Rectangle) return Math.abs(b.width * b.height);
  if (b instanceof Polygon) return polygonArea(b);
  if (b instanceof MultiPolygon) return b.polygons.reduce((sum, p) => sum + polygonArea(p), 0);
  return 0;
}

/**
 * An area for display: µm² (mm² from 1e6 µm²) when the pixel size is known,
 * otherwise px². Empty for a degenerate (non-positive) area.
 */
export function formatArea(px: number, mpp: PixelSize = {}): string {
  if (!(px > 0)) return '';
  const { mppX, mppY } = mpp;
  if (mppX && mppY && mppX > 0 && mppY > 0) {
    const um2 = px * mppX * mppY;
    return um2 >= 1e6 ? `${fmt(um2 / 1e6)} mm²` : `${fmt(um2)} µm²`;
  }
  return `${fmt(px)} px²`;
}

/** Exterior shoelace minus each hole, never negative. */
function polygonArea(p: Polygon): number {
  if ((p.xpoints?.length ?? 0) < 3) return 0;
  let a = ringArea(p.xpoints, p.ypoints);
  if (p.holes) {
    for (const ring of p.holes) a -= ringArea(ring.map((pt) => pt[0]), ring.map((pt) => pt[1]));
  }
  return Math.max(0, a);
}

/** Absolute shoelace area of one ring. */
function ringArea(xs: number[], ys: number[]): number {
  const n = xs?.length ?? 0;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (xs[j] + xs[i]) * (ys[j] - ys[i]);
  return Math.abs(a / 2);
}

function fmt(n: number): string {
  return (n >= 1000 ? Math.round(n) : Math.round(n * 100) / 100).toLocaleString();
}
