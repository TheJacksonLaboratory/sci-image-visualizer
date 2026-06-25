import { TestBed } from '@angular/core/testing';
import { WandService, WandImage } from './wand.service';

describe('WandService', () => {
  let service: WandService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [WandService] });
    service = TestBed.inject(WandService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // Helpers ------------------------------------------------------------

  function makeGrayImage(width: number, height: number,
                        valueAt: (x: number, y: number) => number): WandImage {
    const data: number[][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[] = [];
      for (let x = 0; x < width; x++) row.push(valueAt(x, y));
      data.push(row);
    }
    return { data, width, height, isGrayscale: true };
  }

  function makeRgbImage(width: number, height: number,
                       valueAt: (x: number, y: number) => [number, number, number]): WandImage {
    const data: number[][][] = [];
    for (let y = 0; y < height; y++) {
      const row: number[][] = [];
      for (let x = 0; x < width; x++) row.push(valueAt(x, y));
      data.push(row);
    }
    return { data, width, height, isGrayscale: false };
  }

  function bbox(poly: { xpoints: number[]; ypoints: number[] }) {
    return {
      x0: Math.min(...poly.xpoints),
      x1: Math.max(...poly.xpoints),
      y0: Math.min(...poly.ypoints),
      y1: Math.max(...poly.ypoints),
    };
  }

  // -------------------------------------------------------------------

  it('grows a region inside a flat-colour bright square (simple mode)', () => {
    // A 60×60 bright square embedded in a 200×200 dark image.
    const img = makeGrayImage(200, 200, (x, y) => {
      const inside = x >= 70 && x < 130 && y >= 70 && y < 130;
      return inside ? 200 : 20;
    });
    const poly = service.computeRegion(img, 100, 100, { simpleMode: true, patchSize: 81 });
    expect(poly).not.toBeNull();
    const b = bbox(poly!);
    // Selection should cover roughly the bright square.
    expect(b.x0).toBeGreaterThanOrEqual(69);
    expect(b.x1).toBeLessThanOrEqual(131);
    expect(b.y0).toBeGreaterThanOrEqual(69);
    expect(b.y1).toBeLessThanOrEqual(131);
    expect(b.x1 - b.x0).toBeGreaterThan(50);
    expect(b.y1 - b.y0).toBeGreaterThan(50);
  });

  it('does not bleed into a dark surround in standard (threshold) mode', () => {
    const img = makeGrayImage(200, 200, (x, y) => {
      const inside = x >= 70 && x < 130 && y >= 70 && y < 130;
      return inside ? 200 : 20;
    });
    const poly = service.computeRegion(img, 100, 100, { patchSize: 81, sigma: 1, sensitivity: 4 });
    expect(poly).not.toBeNull();
    const b = bbox(poly!);
    // Must stay strictly within the bright square, allowing for blur edge softening.
    expect(b.x0).toBeGreaterThanOrEqual(65);
    expect(b.x1).toBeLessThanOrEqual(135);
    expect(b.y0).toBeGreaterThanOrEqual(65);
    expect(b.y1).toBeLessThanOrEqual(135);
  });

  it('handles a centre near the image border without overflowing', () => {
    const img = makeGrayImage(50, 50, () => 128);
    const poly = service.computeRegion(img, 5, 5, { simpleMode: true, patchSize: 31 });
    expect(poly).not.toBeNull();
    for (const x of poly!.xpoints) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(49);
    }
    for (const y of poly!.ypoints) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(49);
    }
  });

  it('returns a polygon on a uniform grayscale patch (simple mode → fills patch)', () => {
    const img = makeGrayImage(100, 100, () => 90);
    const poly = service.computeRegion(img, 50, 50, { simpleMode: true, patchSize: 31 });
    expect(poly).not.toBeNull();
    expect(poly!.npoints).toBeGreaterThan(3);
    // The polygon should enclose the click point.
    const b = bbox(poly!);
    expect(b.x0).toBeLessThanOrEqual(50);
    expect(b.x1).toBeGreaterThanOrEqual(50);
    expect(b.y0).toBeLessThanOrEqual(50);
    expect(b.y1).toBeGreaterThanOrEqual(50);
  });

  it('a 1-pixel mask traces to a 4-vertex unit square (not a single degenerate vertex)', () => {
    // Grayscale image where exactly one pixel matches the seed in simple mode.
    const img = makeGrayImage(40, 40, (x, y) => (x === 20 && y === 20 ? 200 : 0));
    const poly = service.computeRegion(img, 20, 20, { simpleMode: true, patchSize: 21 });
    expect(poly).not.toBeNull();
    expect(poly!.npoints).toBe(4);
    const b = bbox(poly!);
    // Pixel (20,20) → patch-local (10,10) → image-coords corners (20..21, 20..21).
    expect(b.x0).toBe(20);
    expect(b.x1).toBe(21);
    expect(b.y0).toBe(20);
    expect(b.y1).toBe(21);
  });

  it('LAB_DISTANCE mode runs the 3-channel pipeline and produces a sensible polygon', () => {
    // Red square in green field.
    const img = makeRgbImage(120, 120, (x, y) => {
      const inside = x >= 40 && x < 80 && y >= 40 && y < 80;
      return inside ? [220, 30, 30] : [30, 220, 30];
    });
    const poly = service.computeRegion(img, 60, 60, {
      patchSize: 51, type: 'LAB_DISTANCE', sigma: 1, sensitivity: 4,
    });
    expect(poly).not.toBeNull();
    const b = bbox(poly!);
    // Selection should hug the red square — well clear of the far-green corners.
    expect(b.x0).toBeGreaterThanOrEqual(35);
    expect(b.x1).toBeLessThanOrEqual(85);
    expect(b.y0).toBeGreaterThanOrEqual(35);
    expect(b.y1).toBeLessThanOrEqual(85);
  });

  it('LAB_DISTANCE in simple mode flood-fills with exact-match (multi-channel)', () => {
    const img = makeRgbImage(80, 80, (x, y) => {
      const inside = x >= 30 && x < 50 && y >= 30 && y < 50;
      return inside ? [200, 100, 50] : [10, 10, 10];
    });
    const poly = service.computeRegion(img, 40, 40, {
      patchSize: 41, type: 'LAB_DISTANCE', simpleMode: true,
    });
    expect(poly).not.toBeNull();
    const b = bbox(poly!);
    expect(b.x0).toBeGreaterThanOrEqual(29);
    expect(b.x1).toBeLessThanOrEqual(50);
    expect(b.y0).toBeGreaterThanOrEqual(29);
    expect(b.y1).toBeLessThanOrEqual(50);
  });

  it('selects an RGB blob in RGB mode', () => {
    // Red square in green field.
    const img = makeRgbImage(120, 120, (x, y) => {
      const inside = x >= 40 && x < 80 && y >= 40 && y < 80;
      return inside ? [220, 30, 30] : [30, 220, 30];
    });
    const poly = service.computeRegion(img, 60, 60, { simpleMode: true, patchSize: 51, type: 'RGB' });
    expect(poly).not.toBeNull();
    const b = bbox(poly!);
    expect(b.x0).toBeGreaterThanOrEqual(39);
    expect(b.x1).toBeLessThanOrEqual(80);
    expect(b.y0).toBeGreaterThanOrEqual(39);
    expect(b.y1).toBeLessThanOrEqual(80);
  });

  it('rejects even patch sizes', () => {
    const img = makeGrayImage(20, 20, () => 0);
    expect(() => service.computeRegion(img, 10, 10, { patchSize: 50 })).toThrowError(/patchSize/);
  });

  it('union of two patch masks expands the polygon to cover both clicks', () => {
    // Uniform image so both clicks flood-fill the entire patch.
    const img = makeGrayImage(300, 300, () => 100);
    const W = 31;

    // Build accumulated stroke mask covering both patch bboxes.
    const half = (W - 1) / 2;
    // Clicks must be close enough that the patches overlap, otherwise the
    // largest connected component is just one of the two patches.
    const cx1 = 80, cy1 = 80;
    const cx2 = 100, cy2 = 80;
    const x0 = Math.min(cx1, cx2) - half;
    const y0 = Math.min(cy1, cy2) - half;
    const x1 = Math.max(cx1, cx2) + half + 1;
    const y1 = Math.max(cy1, cy2) + half + 1;
    const bw = x1 - x0, bh = y1 - y0;
    const accum = new Uint8Array(bw * bh);

    for (const [cx, cy] of [[cx1, cy1], [cx2, cy2]]) {
      const patch = service.computePatchMask(img, cx, cy, { simpleMode: true, patchSize: W });
      expect(patch).not.toBeNull();
      const px0 = cx - half;
      const py0 = cy - half;
      for (let py = 0; py < W; py++) {
        for (let px = 0; px < W; px++) {
          if (!patch!.mask[py * W + px]) continue;
          const mx = (px0 + px) - x0;
          const my = (py0 + py) - y0;
          accum[my * bw + mx] = 1;
        }
      }
    }

    const poly = service.maskToPolygon(accum, bw, bh, img.width, img.height, x0, y0);
    expect(poly).not.toBeNull();
    const b = bbox(poly!);
    // Boundary should span the union of both patches horizontally.
    expect(b.x0).toBeLessThanOrEqual(cx1 - half + 1);
    expect(b.x1).toBeGreaterThanOrEqual(cx2 + half - 1);
    // And the height of a single patch vertically.
    expect(b.y1 - b.y0).toBeGreaterThanOrEqual(W - 2);
  });

  it('dropVerticesWithinRadius keeps vertices outside radius and drops those inside', () => {
    const xs = [10, 50, 50, 10, 100];
    const ys = [10, 10, 50, 50, 100];
    const r = service.dropVerticesWithinRadius(xs, ys, 30, 30, 25);
    expect(r.removed).toBe(0);
    expect(r.xpoints.length).toBe(5);
  });

  it('dropVerticesWithinRadius removes vertices clearly inside the circle', () => {
    const xs = [0, 10, 20, 100];
    const ys = [0, 10, 20, 100];
    const r = service.dropVerticesWithinRadius(xs, ys, 10, 10, 15);
    // (0,0) d≈14.14 inside; (10,10) d=0 inside; (20,20) d≈14.14 inside; (100,100) far.
    expect(r.removed).toBe(3);
    expect(r.xpoints).toEqual([100]);
    expect(r.ypoints).toEqual([100]);
  });

  it('dropVerticesWithinRadius reports removed=0 on a complete miss', () => {
    const xs = [50, 60, 70];
    const ys = [50, 60, 70];
    const r = service.dropVerticesWithinRadius(xs, ys, 0, 0, 10);
    expect(r.removed).toBe(0);
    expect(r.xpoints.length).toBe(3);
  });

  it('dropVerticesWithinRadius can return an empty polygon when all vertices are inside', () => {
    const xs = [1, 2, 3];
    const ys = [1, 2, 3];
    const r = service.dropVerticesWithinRadius(xs, ys, 2, 2, 100);
    expect(r.removed).toBe(3);
    expect(r.xpoints.length).toBe(0);
  });

  it('point-in-polygon detects inside vs outside for a simple square', () => {
    const xs = [10, 30, 30, 10];
    const ys = [10, 10, 30, 30];
    expect(service.pointInPolygon(20, 20, xs, ys)).toBe(true);
    expect(service.pointInPolygon(5, 5, xs, ys)).toBe(false);
    expect(service.pointInPolygon(40, 20, xs, ys)).toBe(false);
  });

  it('rasterizePolygon fills a square exactly', () => {
    const xs = [10, 20, 20, 10];
    const ys = [10, 10, 20, 20];
    const r = service.rasterizePolygon(xs, ys, 50, 50);
    expect(r).not.toBeNull();
    // Every pixel strictly inside the square should be set.
    for (let y = 11; y < 20; y++) {
      for (let x = 11; x < 20; x++) {
        const mx = x - r!.bx;
        const my = y - r!.by;
        expect(r!.mask[my * r!.bw + mx]).toBe(1);
      }
    }
    // A pixel clearly outside should not be set.
    expect(service.pointInPolygon(0, 0, xs, ys)).toBe(false);
  });

  it('rasterizePolygon keeps a polygon partly outside the window (no viewport clip)', () => {
    // jit-ui#102: the mask must span the polygon's FULL extent (bx/by may be negative) so the
    // wand/brush don't lose a region's off-screen part when extending it after a pan/zoom.
    const xs = [-5, 5, 5, -5];
    const ys = [-5, -5, 5, 5];
    const r = service.rasterizePolygon(xs, ys, 50, 50);
    expect(r).not.toBeNull();
    expect(r!.bx).toBe(-5);
    expect(r!.by).toBe(-5);
  });

  it('rasterizePolygon falls back to the window for a polygon that is huge at this zoom', () => {
    // Memory guard: beyond 4096² it clamps to the window rather than allocate a giant mask.
    const xs = [-1, 9000, 9000, -1];
    const ys = [-1, -1, 9000, 9000];
    const r = service.rasterizePolygon(xs, ys, 50, 50);
    expect(r).not.toBeNull();
    expect(r!.bx).toBe(0);
    expect(r!.by).toBe(0);
    expect(r!.bw).toBeLessThanOrEqual(50);
    expect(r!.bh).toBeLessThanOrEqual(50);
  });

  // ── Holes / donuts (jit-ui#85) ────────────────────────────────────────

  /** A solid w×h square mask with a rectangular hole punched in the centre. */
  const donutMask = (w: number, h: number, hx0: number, hy0: number, hx1: number, hy1: number) => {
    const mask = new Uint8Array(w * h);
    mask.fill(1);
    for (let y = hy0; y < hy1; y++) for (let x = hx0; x < hx1; x++) mask[y * w + x] = 0;
    return mask;
  };

  it('maskToPolygons traces an enclosed hole as an interior ring', () => {
    const mask = donutMask(20, 20, 7, 7, 13, 13);
    const polys = service.maskToPolygons(mask, 20, 20, 20, 20, 0, 0, 4, 4);
    expect(polys.length).toBe(1);
    expect(polys[0].holes?.length).toBe(1);
    expect(polys[0].holes![0].length).toBeGreaterThanOrEqual(4);
  });

  it('maskToPolygons drops a hole smaller than minHoleSize', () => {
    const mask = donutMask(20, 20, 9, 9, 11, 11); // 2×2 = 4px hole
    const polys = service.maskToPolygons(mask, 20, 20, 20, 20, 0, 0, 4, 50);
    expect(polys.length).toBe(1);
    expect(polys[0].holes).toBeUndefined();
  });

  it('a background indentation open to the border is NOT a hole', () => {
    // Square with a notch cut from the right edge — open to the outside.
    const w = 20, h = 20;
    const mask = new Uint8Array(w * h);
    mask.fill(1);
    for (let y = 8; y < 12; y++) for (let x = 15; x < 20; x++) mask[y * w + x] = 0;
    const polys = service.maskToPolygons(mask, w, h, w, h, 0, 0, 4, 4);
    expect(polys[0].holes).toBeUndefined();
  });

  it('pointInPolygonWithHoles is false inside a hole, true in the solid ring', () => {
    const xs = [0, 19, 19, 0], ys = [0, 0, 19, 19];
    const holes = [[[7, 7], [12, 7], [12, 12], [7, 12]]];
    expect(service.pointInPolygonWithHoles(10, 10, xs, ys, holes)).toBe(false); // in hole
    expect(service.pointInPolygonWithHoles(2, 2, xs, ys, holes)).toBe(true);    // solid ring
    expect(service.pointInPolygonWithHoles(50, 50, xs, ys, holes)).toBe(false); // outside
  });

  it('rasterizePolygon punches holes back out', () => {
    const xs = [0, 19, 19, 0], ys = [0, 0, 19, 19];
    const holes = [[[7, 7], [12, 7], [12, 12], [7, 12]]];
    const r = service.rasterizePolygon(xs, ys, 20, 20, holes);
    expect(r).not.toBeNull();
    const at = (x: number, y: number) => r!.mask[(y - r!.by) * r!.bw + (x - r!.bx)];
    expect(at(10, 10)).toBe(0); // inside the hole
    expect(at(2, 2)).toBe(1);   // solid ring
  });

  it('returns coordinates as a 2-D array matching xpoints/ypoints', () => {
    const img = makeGrayImage(60, 60, () => 128);
    const poly = service.computeRegion(img, 30, 30, { simpleMode: true, patchSize: 21 });
    expect(poly).not.toBeNull();
    expect(poly!.coordinates.length).toBe(poly!.npoints);
    for (let i = 0; i < poly!.npoints; i++) {
      expect(poly!.coordinates[i][0]).toBe(poly!.xpoints[i]);
      expect(poly!.coordinates[i][1]).toBe(poly!.ypoints[i]);
    }
  });
});
