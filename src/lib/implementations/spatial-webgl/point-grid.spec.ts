import { PointGrid } from './point-grid';

const at = (...xy: number[]) => new Float32Array(xy);
const radius = (r: number) => () => r;

describe('PointGrid', () => {
  it('picks a marker anywhere on its disc', () => {
    const grid = new PointGrid(at(0, 0, 100, 100), 2);
    expect(grid.pick(3, 4, radius(5), 5, 0)).toBe(0);
    expect(grid.pick(97, 100, radius(5), 5, 0)).toBe(1);
    expect(grid.pick(50, 50, radius(5), 5, 0)).toBe(-1);
  });

  it('picks a marker smaller than the slack within the slack of its centre', () => {
    const grid = new PointGrid(at(10, 10), 1);
    expect(grid.pick(18, 10, radius(1), 1, 10)).toBe(0);
    expect(grid.pick(21, 10, radius(1), 1, 10)).toBe(-1);
  });

  it('picks the nearest centre of several hits, not the last drawn', () => {
    const grid = new PointGrid(at(0, 0, 6, 0, 3.5, 0), 3);
    expect(grid.pick(1, 0, radius(10), 10, 0)).toBe(0);
    expect(grid.pick(5, 0, radius(10), 10, 0)).toBe(1);
  });

  it('gives an exact tie to the marker drawn on top', () => {
    const grid = new PointGrid(at(0, 0, 4, 0), 2);
    expect(grid.pick(2, 0, radius(5), 5, 0)).toBe(1);
  });

  it('never picks a hidden marker', () => {
    const grid = new PointGrid(at(0, 0, 4, 0), 2);
    expect(grid.pick(1, 0, radius(5), 5, 0, (i) => i !== 0)).toBe(1);
    expect(grid.pick(1, 0, radius(5), 5, 0, () => false)).toBe(-1);
  });

  it('uses each marker’s own radius', () => {
    const grid = new PointGrid(at(0, 0, 100, 0), 2);
    const radii = [2, 50];
    expect(grid.pick(60, 0, (i) => radii[i], 50, 0)).toBe(1);
    expect(grid.pick(5, 0, (i) => radii[i], 50, 0)).toBe(-1);
  });

  it('skips markers that are not placed', () => {
    const grid = new PointGrid(at(NaN, NaN, 5, 5), 2);
    expect(grid.pick(5, 5, radius(1), 1, 0)).toBe(1);
    expect(grid.pick(NaN, 0, radius(1), 1, 0)).toBe(-1);
  });

  it('agrees with a brute-force scan over a random field', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
    const n = 5000;
    const xy = new Float32Array(n * 2).map(() => rand());
    const grid = new PointGrid(xy, n);
    const r = 3;
    const slack = 6;
    for (let q = 0; q < 200; q++) {
      const x = rand();
      const y = rand();
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(xy[2 * i] - x, xy[2 * i + 1] - y);
        if (d > Math.max(r, slack)) continue;
        if (d < bestD || (d === bestD && i > best)) {
          best = i;
          bestD = d;
        }
      }
      expect(grid.pick(x, y, radius(r), r, slack)).toBe(best);
    }
  });

  it('copes with no markers at all', () => {
    expect(new PointGrid(new Float32Array(0), 0).pick(0, 0, radius(1), 1, 1)).toBe(-1);
  });
});
