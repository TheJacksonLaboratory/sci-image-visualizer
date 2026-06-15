import { TestBed } from '@angular/core/testing';

import { RegionOpsService } from './region-ops.service';
import { WandService } from './toolbar/wand/wand.service';
import { Region, Rectangle, Polygon, MultiPolygon } from './models/region';

/** A rectangle region in image-pixel coords. */
function rect(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const b = new Rectangle();
  b.x = x; b.y = y; b.width = w; b.height = h;
  r.bounds = b;
  return r;
}

/** A closed polygon region from parallel coord arrays. */
function poly(xs: number[], ys: number[], holes?: number[][][]): Region {
  const r = new Region();
  const p = new Polygon();
  p.xpoints = xs.slice(); p.ypoints = ys.slice(); p.npoints = xs.length;
  p.coordinates = xs.map((x, i) => [x, ys[i]]);
  p.closed = true;
  if (holes) p.holes = holes;
  r.bounds = p;
  return r;
}

/** Total pixel area of a region's bounds (exterior − holes, summed over parts),
 *  via the same shoelace the editor uses — to assert merge/inverse results. */
function area(region: Region): number {
  const ring = (xs: number[], ys: number[]) => {
    let a = 0;
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) a += (xs[j] + xs[i]) * (ys[j] - ys[i]);
    return Math.abs(a / 2);
  };
  const polyArea = (p: Polygon) => {
    let a = ring(p.xpoints, p.ypoints);
    if (p.holes) for (const h of p.holes) a -= ring(h.map(q => q[0]), h.map(q => q[1]));
    return a;
  };
  const b = region.bounds;
  if (b instanceof Polygon) return polyArea(b);
  if (b instanceof MultiPolygon) return b.polygons.reduce((s, p) => s + polyArea(p), 0);
  if (b instanceof Rectangle) return b.width * b.height;
  return 0;
}

describe('RegionOpsService', () => {
  let ops: RegionOpsService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [RegionOpsService, WandService] });
    ops = TestBed.inject(RegionOpsService);
  });

  describe('merge', () => {
    it('two overlapping rectangles merge into one connected Polygon', () => {
      const merged = ops.merge([rect(0, 0, 20, 20), rect(10, 10, 20, 20)], 100, 100)!;
      expect(merged).not.toBeNull();
      expect(merged.bounds).toBeInstanceOf(Polygon); // connected → single part
      // Union area = 400 + 400 − 100 overlap = 700 (raster ≈, allow slack).
      expect(area(merged)).toBeGreaterThan(650);
      expect(area(merged)).toBeLessThan(760);
    });

    it('two disjoint rectangles merge into a 2-part MultiPolygon', () => {
      const merged = ops.merge([rect(0, 0, 10, 10), rect(50, 50, 10, 10)], 100, 100)!;
      expect(merged.bounds).toBeInstanceOf(MultiPolygon);
      expect((merged.bounds as MultiPolygon).polygons.length).toBe(2);
    });

    it('inherits colour/label from the first region', () => {
      const a = rect(0, 0, 10, 10); a.color = '#abcdef'; a.label = 'Tumor';
      const merged = ops.merge([a, rect(50, 50, 10, 10)], 100, 100)!;
      expect(merged.color).toBe('#abcdef');
      expect(merged.label).toBe('Tumor');
    });

    it('returns null when nothing rasterises', () => {
      expect(ops.merge([poly([0, 10], [0, 10])], 100, 100)).toBeNull(); // 2-pt = degenerate
    });
  });

  describe('inverse', () => {
    it('inverts a centred blob into the image rect with the blob as a hole', () => {
      const inv = ops.inverse([rect(20, 20, 20, 20)], 80, 80)!;
      expect(inv).not.toBeNull();
      // Exterior ≈ the 80×80 image, one hole ≈ the 20×20 blob → area ≈ 6400 − 400.
      expect(area(inv)).toBeGreaterThan(5500);
      expect(area(inv)).toBeLessThan(6400);
      const b = inv.bounds;
      const hasHole = b instanceof Polygon ? !!b.holes?.length
        : b instanceof MultiPolygon ? b.polygons.some(p => !!p.holes?.length) : false;
      expect(hasHole).toBe(true);
    });

    it('refuses an oversized image (memory guard)', () => {
      expect(ops.inverse([rect(0, 0, 10, 10)], 100000, 100000)).toBeNull();
    });
  });

  describe('ungroup', () => {
    it('splits a MultiPolygon into one region per part', () => {
      const merged = ops.merge([rect(0, 0, 10, 10), rect(50, 50, 10, 10)], 100, 100)!;
      const parts = ops.ungroup(merged);
      expect(parts.length).toBe(2);
      expect(parts.every(p => p.bounds instanceof Polygon)).toBe(true);
    });

    it('is a no-op (single-element) for a connected polygon', () => {
      const r = poly([0, 10, 10, 0], [0, 0, 10, 10]);
      expect(ops.ungroup(r)).toEqual([r]);
    });

    it('canUngroup is true only for a multi-part region', () => {
      const merged = ops.merge([rect(0, 0, 10, 10), rect(50, 50, 10, 10)], 100, 100)!;
      expect(ops.canUngroup(merged)).toBe(true);
      expect(ops.canUngroup(rect(0, 0, 10, 10))).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('merge then ungroup recovers the same number of disjoint parts', () => {
      const merged = ops.merge(
        [rect(0, 0, 10, 10), rect(30, 0, 10, 10), rect(60, 0, 10, 10)], 100, 100)!;
      expect((merged.bounds as MultiPolygon).polygons.length).toBe(3);
      expect(ops.ungroup(merged).length).toBe(3);
    });
  });
});
