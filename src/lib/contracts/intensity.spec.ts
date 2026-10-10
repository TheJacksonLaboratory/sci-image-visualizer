import { autoWindowFromHistogram, bt601Luminance, maxRgb, histogram256 } from './intensity';

describe('intensity helpers (shared by both backends)', () => {
  it('bt601Luminance matches the ITU weights (Plotly scalar projection)', () => {
    expect(bt601Luminance(255, 255, 255)).toBeCloseTo(255);
    expect(bt601Luminance(0, 0, 0)).toBe(0);
    expect(bt601Luminance(255, 0, 0)).toBeCloseTo(76.245);
    expect(bt601Luminance(0, 255, 0)).toBeCloseTo(149.685);
    expect(bt601Luminance(0, 0, 255)).toBeCloseTo(29.07);
  });

  it('maxRgb picks the channel maximum (OSD scalar projection)', () => {
    expect(maxRgb(10, 20, 30)).toBe(30);
    expect(maxRgb(30, 20, 10)).toBe(30);
    expect(maxRgb(10, 30, 20)).toBe(30);
    expect(maxRgb(7, 7, 7)).toBe(7); // single-band tiles: r=g=b → exact
  });

  it('histogram256 wraps counts with 0..255 left edges and the max count', () => {
    const counts = new Array(256).fill(0);
    counts[5] = 3;
    counts[200] = 9;
    const h = histogram256(counts);
    expect(h.bins).toHaveLength(256);
    expect(h.bins[0]).toBe(0);
    expect(h.bins[255]).toBe(255);
    expect(h.counts).toBe(counts);
    expect(h.max).toBe(9);
  });
});

describe('autoWindowFromHistogram (router and channel histogram)', () => {
  const hist = (counts: number[], bins = counts.map((_, i) => i)) => ({
    bins,
    counts,
    max: Math.max(0, ...counts),
  });

  it('clips about `saturation` of the pixels at each end', () => {
    // 100 pixels spread evenly over bins 0..9; 10% saturation clips one bin each side.
    const h = hist(new Array(10).fill(10));
    expect(autoWindowFromHistogram(h, 0.1, [0, 255])).toEqual([1, 8]);
    expect(autoWindowFromHistogram(h, 0, [0, 255])).toEqual([0, 9]);
  });

  it('drops a dominant first or last bin before saturating', () => {
    const h = hist([1000, 10, 10, 10, 10, 1000]);
    expect(autoWindowFromHistogram(h, 0, [0, 255])).toEqual([1, 4]);
  });

  it('returns values from the bins (native units), not indices', () => {
    const h = hist([5, 5, 5], [100, 200, 300]);
    expect(autoWindowFromHistogram(h, 0, [0, 255])).toEqual([100, 300]);
  });

  it("returns the caller's fallback for an empty or all-zero histogram", () => {
    expect(autoWindowFromHistogram(hist([]), 0.01, [0, 255])).toEqual([0, 255]);
    expect(autoWindowFromHistogram(hist([0, 0, 0]), 0.01, [12, 4000])).toEqual([12, 4000]);
  });

  it('clamps saturation to [0, 0.5] and leaves the histogram untouched', () => {
    const counts = [9, 1, 1, 1, 9];
    const h = hist(counts);
    expect(autoWindowFromHistogram(h, 2, [0, 255])).toEqual(autoWindowFromHistogram(h, 0.5, [0, 255]));
    expect(h.counts).toEqual([9, 1, 1, 1, 9]);
  });
});
