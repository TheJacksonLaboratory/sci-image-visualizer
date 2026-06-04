import {
  BBoxMask,
  masksOverlap,
  parseSvgPathPolygon,
  polygonToSvgPath,
  shapesEqual,
  unionMasks,
  verticesToSvgPath,
} from './geometry';

describe('geometry helpers', () => {

  // ── parseSvgPathPolygon ─────────────────────────────────────────────

  describe('parseSvgPathPolygon', () => {
    it('parses a closed M…L…Z path', () => {
      const r = parseSvgPathPolygon('M10,20L30,40L50,60Z');
      expect(r).not.toBeNull();
      expect(r!.xpoints).toEqual([10, 30, 50]);
      expect(r!.ypoints).toEqual([20, 40, 60]);
    });

    it('parses an open polyline (no Z) with at least 3 vertices', () => {
      const r = parseSvgPathPolygon('M10,20L30,40L50,60');
      expect(r).not.toBeNull();
      expect(r!.xpoints.length).toBe(3);
    });

    it('rejects multi-subpath strings', () => {
      expect(parseSvgPathPolygon('M0,0L1,0L1,1Z M5,5L6,5L6,6Z')).toBeNull();
    });

    it('rejects polygons with fewer than 3 vertices', () => {
      expect(parseSvgPathPolygon('M0,0L1,0Z')).toBeNull();
    });

    it('rejects strings missing the M prefix', () => {
      expect(parseSvgPathPolygon('10,20L30,40Z')).toBeNull();
    });

    it('rejects strings with non-numeric coords', () => {
      expect(parseSvgPathPolygon('Mfoo,barL30,40L50,60Z')).toBeNull();
    });
  });

  // ── polygonToSvgPath ────────────────────────────────────────────────

  describe('polygonToSvgPath', () => {
    it('builds a closed M…L…Z string', () => {
      expect(polygonToSvgPath([10, 30, 50], [20, 40, 60])).toBe('M10,20L30,40L50,60Z');
    });

    it('returns "" for fewer than 3 vertices', () => {
      expect(polygonToSvgPath([0, 1], [0, 1])).toBe('');
    });

    it('round-trips through parseSvgPathPolygon', () => {
      const xs = [10, 30, 50];
      const ys = [20, 40, 60];
      const path = polygonToSvgPath(xs, ys);
      const parsed = parseSvgPathPolygon(path);
      expect(parsed!.xpoints).toEqual(xs);
      expect(parsed!.ypoints).toEqual(ys);
    });
  });

  // ── verticesToSvgPath ───────────────────────────────────────────────

  describe('verticesToSvgPath', () => {
    it('emits Z-suffix when closed=true', () => {
      expect(verticesToSvgPath([0, 1, 2], [0, 1, 2], true)).toBe('M0,0L1,1L2,2Z');
    });

    it('omits Z-suffix when closed=false (polyline)', () => {
      expect(verticesToSvgPath([0, 1, 2], [0, 1, 2], false)).toBe('M0,0L1,1L2,2');
    });

    it('returns "" for fewer than 2 vertices', () => {
      expect(verticesToSvgPath([0], [0], true)).toBe('');
    });
  });

  // ── shapesEqual ─────────────────────────────────────────────────────

  describe('shapesEqual', () => {
    it('compares paths by string', () => {
      expect(shapesEqual({ path: 'M0,0L1,1Z' }, { path: 'M0,0L1,1Z' })).toBe(true);
      expect(shapesEqual({ path: 'M0,0L1,1Z' }, { path: 'M0,0L2,2Z' })).toBe(false);
    });

    it('compares rectangles by their corners', () => {
      const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
      const b = { x0: 0, y0: 0, x1: 10, y1: 10 };
      const c = { x0: 0, y0: 0, x1: 11, y1: 10 };
      expect(shapesEqual(a, b)).toBe(true);
      expect(shapesEqual(a, c)).toBe(false);
    });

    it('returns false when neither shape descriptor matches', () => {
      expect(shapesEqual({ foo: 1 }, { bar: 2 })).toBe(false);
    });
  });

  // ── masksOverlap / unionMasks ───────────────────────────────────────

  function rectMask(bx: number, by: number, bw: number, bh: number): BBoxMask {
    const mask = new Uint8Array(bw * bh).fill(1);
    return { bx, by, bw, bh, mask };
  }

  describe('masksOverlap', () => {
    it('returns false for disjoint bboxes', () => {
      const a = rectMask(0, 0, 5, 5);
      const b = rectMask(10, 10, 5, 5);
      expect(masksOverlap(a, b)).toBe(false);
    });

    it('returns true when bboxes overlap and at least one pixel is set in both', () => {
      const a = rectMask(0, 0, 10, 10);
      const b = rectMask(5, 5, 10, 10);
      expect(masksOverlap(a, b)).toBe(true);
    });

    it('returns false when bboxes overlap but masks have no set pixel in common', () => {
      const a = rectMask(0, 0, 10, 10);
      // bbox overlaps a but every mask cell is zero
      const b: BBoxMask = { bx: 5, by: 5, bw: 5, bh: 5, mask: new Uint8Array(25) };
      expect(masksOverlap(a, b)).toBe(false);
    });
  });

  describe('unionMasks', () => {
    it('produces a bbox covering both inputs and ORs the pixels', () => {
      const a = rectMask(0, 0, 4, 4);
      const b = rectMask(3, 3, 4, 4);
      const u = unionMasks(a, b);
      expect(u.bx).toBe(0);
      expect(u.by).toBe(0);
      expect(u.bw).toBe(7);
      expect(u.bh).toBe(7);
      // every cell of `a` and `b` should be 1 in the union.
      const at = (x: number, y: number) => u.mask[(y - u.by) * u.bw + (x - u.bx)];
      expect(at(0, 0)).toBe(1);
      expect(at(3, 3)).toBe(1);
      expect(at(6, 6)).toBe(1);
      // a corner outside both should be 0.
      expect(at(6, 0)).toBe(0);
    });
  });
});
