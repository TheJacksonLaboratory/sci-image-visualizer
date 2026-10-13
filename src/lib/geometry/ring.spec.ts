import { eraseRingWithinRadius } from './ring';

describe('eraseRingWithinRadius', () => {
  const square = { xs: [0, 10, 10, 0], ys: [0, 0, 10, 10] };

  it('leaves a ring with no vertex in the disc unchanged, even where an edge crosses it', () => {
    const r = eraseRingWithinRadius(square.xs, square.ys, 5, 0, 2);
    expect(r).toEqual({ xpoints: square.xs, ypoints: square.ys, removed: 0 });
  });

  it("drops the vertices in the disc and rejoins the ring on the disc's edge", () => {
    const r = eraseRingWithinRadius(square.xs, square.ys, 10, 10, 3);
    expect(r.removed).toBe(1);
    expect(r.xpoints).toEqual([0, 10, 10, 7, 0]);
    expect(r.ypoints).toEqual([0, 0, 7, 10, 10]);
  });

  it('wraps a closed ring: a dropped first vertex is rejoined across the closing edge', () => {
    const r = eraseRingWithinRadius(square.xs, square.ys, 0, 0, 4);
    expect(r.xpoints).toEqual([4, 10, 10, 0, 0]);
    expect(r.ypoints).toEqual([0, 0, 10, 10, 4]);
  });

  it('does not wrap an open polyline', () => {
    const r = eraseRingWithinRadius([0, 10, 20], [0, 0, 0], 0, 0, 4, false);
    expect(r.xpoints).toEqual([4, 10, 20]);
    expect(r.ypoints).toEqual([0, 0, 0]);
  });

  it('is stable: erasing again at the same spot changes nothing', () => {
    const once = eraseRingWithinRadius(square.xs, square.ys, 10, 10, 3);
    const twice = eraseRingWithinRadius(once.xpoints, once.ypoints, 10, 10, 3);
    expect(twice.removed).toBe(0);
    expect(twice.xpoints).toEqual(once.xpoints);
  });

  it('does not duplicate a vertex lying exactly on the disc', () => {
    // (10, 0) is 2 from the centre: it stays, and the cut there is that vertex.
    const r = eraseRingWithinRadius([0, 10, 10, 10, 0], [0, 0, 3, 10, 10], 10, 2, 2);
    expect(r.removed).toBe(1);
    expect(r.xpoints).toEqual([0, 10, 10, 10, 0]);
    expect(r.ypoints).toEqual([0, 0, 4, 10, 10]);
  });

  it('removes a ring whose every vertex is in the disc', () => {
    const r = eraseRingWithinRadius(square.xs, square.ys, 5, 5, 100);
    expect(r).toEqual({ xpoints: [], ypoints: [], removed: 4 });
  });
});
