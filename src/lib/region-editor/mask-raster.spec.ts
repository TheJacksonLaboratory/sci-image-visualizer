import { regionToParts, regionsToMask } from './mask-raster';
import { WandService } from '../toolbar/wand/wand.service';
import { Region, Rectangle, Polygon, MultiPolygon } from '../models/region';

const wand = new WandService();
const raster = (xs: number[], ys: number[], w: number, h: number, holes?: number[][][]) =>
  wand.rasterizePolygon(xs, ys, w, h, holes);

function rectRegion(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const b = new Rectangle();
  b.x = x; b.y = y; b.width = w; b.height = h;
  r.bounds = b;
  return r;
}

describe('mask-raster (jit-ui#95)', () => {
  describe('regionToParts', () => {
    it('expands a rectangle into a single 4-point ring', () => {
      const parts = regionToParts(rectRegion(2, 3, 4, 5));
      expect(parts).toHaveLength(1);
      expect(parts[0].xpoints).toEqual([2, 6, 6, 2]);
      expect(parts[0].ypoints).toEqual([3, 3, 8, 8]);
    });

    it('keeps a polygon points + holes', () => {
      const r = new Region();
      const p = new Polygon();
      p.xpoints = [0, 4, 4, 0]; p.ypoints = [0, 0, 4, 4]; p.npoints = 4;
      p.holes = [[[1, 1], [2, 1], [2, 2], [1, 2]]];
      r.bounds = p;
      const parts = regionToParts(r);
      expect(parts).toHaveLength(1);
      expect(parts[0].holes).toEqual(p.holes);
    });

    it('expands a multi-polygon into one part per polygon', () => {
      const r = new Region();
      const mp = new MultiPolygon();
      const a = new Polygon(); a.xpoints = [0, 2, 2, 0]; a.ypoints = [0, 0, 2, 2];
      const b = new Polygon(); b.xpoints = [5, 7, 7, 5]; b.ypoints = [5, 5, 7, 7];
      mp.polygons = [a, b];
      r.bounds = mp;
      expect(regionToParts(r)).toHaveLength(2);
    });
  });

  describe('regionsToMask', () => {
    const at = (mask: Uint8Array | Uint16Array, x: number, y: number, w: number) => mask[y * w + x];

    it('binary mode paints region pixels as 255 (viewable), background 0, 8-bit', () => {
      const parts = [regionToParts(rectRegion(2, 2, 4, 4))];
      const mask = regionsToMask(parts, 8, 8, 'binary', raster)!;
      expect(mask.bitDepth).toBe(8);
      expect(mask.data).toBeInstanceOf(Uint8Array);
      expect(mask.data.length).toBe(64);
      expect(at(mask.data, 3, 3, 8)).toBe(255);
      expect(at(mask.data, 0, 0, 8)).toBe(0);
      expect(Array.from(mask.data).every((v) => v === 0 || v === 255)).toBe(true);
    });

    it('multiclass mode gives each region a distinct 1-based id (8-bit for ≤255)', () => {
      const parts = [regionToParts(rectRegion(1, 1, 2, 2)), regionToParts(rectRegion(5, 5, 2, 2))];
      const mask = regionsToMask(parts, 8, 8, 'multiclass', raster)!;
      expect(mask.bitDepth).toBe(8);
      expect(at(mask.data, 1, 1, 8)).toBe(1);
      expect(at(mask.data, 5, 5, 8)).toBe(2);
    });

    it('promotes multiclass to 16-bit with non-colliding ids beyond 255 regions', () => {
      // 300 non-overlapping 2×2 rectangles laid out in a row across a wide image.
      const parts = Array.from({ length: 300 }, (_, i) => regionToParts(rectRegion(i * 3, 0, 2, 2)));
      const mask = regionsToMask(parts, 900, 4, 'multiclass', raster)!;
      expect(mask.bitDepth).toBe(16);
      expect(mask.data).toBeInstanceOf(Uint16Array);
      // The 300th region (id 300) sits at x≈897 — an id no 8-bit mask could hold.
      expect(at(mask.data, 898, 0, 900)).toBe(300);
      expect(Math.max(...Array.from(mask.data))).toBe(300);
    });

    it('reports per-region progress', () => {
      const parts = [regionToParts(rectRegion(0, 0, 2, 2)), regionToParts(rectRegion(4, 4, 2, 2))];
      const progress: Array<[number, number]> = [];
      regionsToMask(parts, 8, 8, 'binary', raster, (done, total) => progress.push([done, total]));
      expect(progress).toEqual([[1, 2], [2, 2]]);
    });

    it('returns null for no regions or a zero/invalid size', () => {
      expect(regionsToMask([], 8, 8, 'binary', raster)).toBeNull();
      expect(regionsToMask([regionToParts(rectRegion(0, 0, 2, 2))], 0, 8, 'binary', raster)).toBeNull();
      expect(regionsToMask([regionToParts(rectRegion(0, 0, 2, 2))], NaN, 8, 'binary', raster)).toBeNull();
    });
  });
});
