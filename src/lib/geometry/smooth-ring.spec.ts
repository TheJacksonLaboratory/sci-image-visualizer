import { smoothPixelRing } from './smooth-ring';

describe('smoothPixelRing', () => {
  it('turns a one-pixel staircase into a near-straight diagonal', () => {
    // A right triangle whose hypotenuse is a staircase of 1-px steps from (0,0) to (10,10).
    const xs = [0];
    const ys = [0];
    for (let i = 0; i < 10; i++) {
      xs.push(i + 1, i + 1);
      ys.push(i, i + 1);
    }
    xs.push(0);
    ys.push(10);
    const r = smoothPixelRing(xs, ys);
    // The staircase collapses to a few vertices (a straight run needs none in between)…
    expect(r.xs.length).toBeLessThanOrEqual(8);
    // …each within half a pixel of the true triangle's hypotenuse or its two legs, away
    // from its three sharp corners (which are rounded off).
    const corners = [
      [0, 0],
      [10, 10],
      [0, 10],
    ];
    for (let i = 0; i < r.xs.length; i++) {
      const [x, y] = [r.xs[i], r.ys[i]];
      if (corners.some(([cx, cy]) => Math.hypot(x - cx, y - cy) < 3)) continue;
      const d = Math.min(Math.abs(x - y) / Math.SQRT2, Math.abs(x), Math.abs(10 - y));
      expect(d).toBeLessThanOrEqual(0.6);
    }
  });

  it('stays within half a pixel of the traced square', () => {
    const r = smoothPixelRing([0, 10, 10, 0], [0, 0, 10, 10]);
    for (let i = 0; i < r.xs.length; i++) {
      expect(r.xs[i]).toBeGreaterThanOrEqual(0);
      expect(r.xs[i]).toBeLessThanOrEqual(10);
      expect(r.ys[i]).toBeGreaterThanOrEqual(0);
      expect(r.ys[i]).toBeLessThanOrEqual(10);
    }
  });

  it('keeps the corners of long straight runs (merged edges are split first)', () => {
    // The tracer merges straight runs: a 10-px side is one edge, and halving it would
    // cut each corner by 5 px.
    const r = smoothPixelRing([0, 10, 10, 0], [0, 0, 10, 10]);
    for (const [cx, cy] of [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]) {
      const nearest = Math.min(...r.xs.map((x, i) => Math.hypot(x - cx, r.ys[i] - cy)));
      expect(nearest).toBeLessThan(1.2);
    }
  });

  it('leaves a degenerate ring alone', () => {
    expect(smoothPixelRing([0, 1, 1], [0, 0, 1])).toEqual({ xs: [0, 1, 1], ys: [0, 0, 1] });
  });
});
