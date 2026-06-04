import { bezierCurve, bezierAnchorHandles } from './bezier';

describe('bezierCurve (Catmull-Rom flattening)', () => {
  it('returns a denser, smooth sampling of the anchors', () => {
    const xs = [0, 30, 30, 0];
    const ys = [0, 0, 30, 30];
    const curve = bezierCurve(xs, ys, true);
    // The spline samples many more points than the 4 anchors.
    expect(curve.xs.length).toBeGreaterThan(xs.length);
    expect(curve.xs.length).toBe(curve.ys.length);
  });

  it('closes the ring (first point == last point) for a closed shape', () => {
    const xs = [0, 30, 15];
    const ys = [0, 0, 30];
    const curve = bezierCurve(xs, ys, true);
    const n = curve.xs.length;
    expect(curve.xs[0]).toBeCloseTo(curve.xs[n - 1], 5);
    expect(curve.ys[0]).toBeCloseTo(curve.ys[n - 1], 5);
  });

  it('starts and ends at the first/last anchor for an open path', () => {
    const xs = [0, 10, 20];
    const ys = [0, 10, 0];
    const curve = bezierCurve(xs, ys, false);
    const n = curve.xs.length;
    expect(curve.xs[0]).toBeCloseTo(0, 5);
    expect(curve.ys[0]).toBeCloseTo(0, 5);
    expect(curve.xs[n - 1]).toBeCloseTo(20, 5);
    expect(curve.ys[n - 1]).toBeCloseTo(0, 5);
  });

  it('returns the anchors unchanged when there are too few to spline', () => {
    const curve = bezierCurve([0, 10], [0, 10], false);
    expect(curve.xs).toEqual([0, 10]);
    expect(curve.ys).toEqual([0, 10]);
  });
});

describe('bezierAnchorHandles (Catmull-Rom control points)', () => {
  it('gives every closed-ring anchor a colinear in/out handle pair', () => {
    const xs = [0, 10, 10, 0];
    const ys = [0, 0, 10, 10];
    const h = bezierAnchorHandles(xs, ys, true);
    expect(h.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(h[i].hasIn).toBe(true);
      expect(h[i].hasOut).toBe(true);
      // in and out are reflections of the anchor (smooth tangent): their
      // midpoint is the anchor.
      expect((h[i].in[0] + h[i].out[0]) / 2).toBeCloseTo(xs[i], 6);
      expect((h[i].in[1] + h[i].out[1]) / 2).toBeCloseTo(ys[i], 6);
    }
  });

  it('clamps handles at open-path endpoints', () => {
    const h = bezierAnchorHandles([0, 10, 20], [0, 10, 0], false);
    expect(h[0].hasIn).toBe(false);
    expect(h[0].hasOut).toBe(true);
    expect(h[2].hasIn).toBe(true);
    expect(h[2].hasOut).toBe(false);
  });
});
