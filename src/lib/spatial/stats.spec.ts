import { percentileWindow, quantile, quantiles } from './stats';

describe('quantiles', () => {
  it('takes the nearest rank, round(p * (n - 1)), and clamps p', () => {
    const v = Float32Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantiles(v, [0, 0.5, 0.95, 1])).toEqual([1, 51, 95, 100]);
    expect(quantiles(v, [-1, 2])).toEqual([1, 100]);
  });

  it('sorts numerically, negatives included', () => {
    expect(quantiles([10, -5, 2, -20, 3], [0, 0.5, 1])).toEqual([-20, 2, 10]);
  });

  it('counts only finite values by default, or only positive ones', () => {
    const v = [NaN, 0, -1, 4, Infinity, 2];
    expect(quantiles(v, [0, 1])).toEqual([-1, 4]);
    expect(quantiles(v, [0, 1], { filter: 'positive' })).toEqual([2, Infinity]);
  });

  it('counts only where `where` is positive', () => {
    // An unmeasured pixel's zero must not drag the low percentile down.
    const mean = Float32Array.from([0, 0, 5, 7, 9]);
    const support = Float32Array.from([0, 0, 1, 1, 1]);
    expect(quantiles(mean, [0, 1], { where: support })).toEqual([5, 9]);
  });

  it('returns null when nothing qualifies', () => {
    expect(quantiles([], [0.5])).toBeNull();
    expect(quantiles([NaN], [0.5])).toBeNull();
    expect(quantile([0, -1], 0.5, { filter: 'positive' })).toBeNull();
  });

  it('samples a large vector and stays close to the exact answer', () => {
    const n = 1_000_000;
    // Scrambled so a strided sample is not trivially ordered.
    const v = Float32Array.from({ length: n }, (_, i) => (i * 7919) % n);
    const [lo, hi] = quantiles(v, [0.01, 0.99], { sampleSize: 4096 })!;
    expect(Math.abs(lo - 0.01 * n)).toBeLessThan(0.005 * n);
    expect(Math.abs(hi - 0.99 * n)).toBeLessThan(0.005 * n);
  });

  it('does not sample below twice the sample size', () => {
    const v = Float32Array.from({ length: 100 }, (_, i) => i);
    expect(quantile(v, 1, { sampleSize: 60 })).toBe(99);
  });
});

describe('percentileWindow', () => {
  it('widens a flat window and falls back to [0, 1] for no data', () => {
    expect(percentileWindow([7, 7, 7], 0.01, 0.99)).toEqual([7, 8]);
    expect(percentileWindow([], 0.01, 0.99)).toEqual([0, 1]);
  });
});
