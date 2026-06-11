import { bt601Luminance, maxRgb, histogram256 } from './intensity';

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
