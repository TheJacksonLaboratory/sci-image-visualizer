import { polylabel, signedDistance } from './polylabel';

const flat = (pts: number[][]) => Float64Array.from(pts.flat());

describe('polylabel', () => {
  it('puts a square label at its centre, with half its side as room', () => {
    const p = polylabel([
      flat([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ])!;
    expect(p.x).toBeCloseTo(5, 0);
    expect(p.y).toBeCloseTo(5, 0);
    expect(p.distance).toBeCloseTo(5, 0);
  });

  it('keeps a U shape label inside, where the centroid is not', () => {
    // A U: two 10-wide arms joined by a 10-high base; the centroid (15, ~12) is in the gap.
    const u = flat([
      [0, 0],
      [10, 0],
      [10, 30],
      [20, 30],
      [20, 0],
      [30, 0],
      [30, 40],
      [0, 40],
    ]);
    const p = polylabel([u])!;
    expect(signedDistance(p.x, p.y, [u])).toBeGreaterThan(0);
    expect(signedDistance(15, 12, [u])).toBeLessThan(0);
  });

  it('avoids a hole', () => {
    const outer = flat([
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ]);
    const hole = flat([
      [5, 5],
      [25, 5],
      [25, 25],
      [5, 25],
    ]);
    const p = polylabel([outer, hole])!;
    expect(signedDistance(p.x, p.y, [outer, hole])).toBeGreaterThan(0);
    // A 5 px frame: at most ~2.9 px of room (in a corner, against the hole’s corner).
    expect(p.distance).toBeLessThan(3);
  });

  it('has nothing for a degenerate ring', () => {
    expect(
      polylabel([
        flat([
          [0, 0],
          [1, 1],
        ]),
      ]),
    ).toBeNull();
  });
});
