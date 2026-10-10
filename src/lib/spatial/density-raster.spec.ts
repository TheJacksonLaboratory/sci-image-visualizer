import { lutFor } from './spatial-encoding';
import { INFERNO_SCALE, discreteColormapStops } from './density-raster';

describe('discreteColormapStops', () => {
  const rgb: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

  it('gives each category a band and samples at its centre', () => {
    const { valueOf } = discreteColormapStops(rgb, [128, 128, 128]);
    // 3 categories + 1 missing band = 4 bands.
    expect(valueOf(0)).toBeCloseTo(0.125, 9);
    expect(valueOf(2)).toBeCloseTo(0.625, 9);
  });

  it('routes a missing or out-of-range code to the grey band', () => {
    const { valueOf } = discreteColormapStops(rgb, [128, 128, 128]);
    expect(valueOf(-1)).toBeCloseTo(0.875, 9);
    expect(valueOf(99)).toBeCloseTo(0.875, 9);
  });

  it('stops are piecewise constant — a band never blends into its neighbour', () => {
    const { stops, valueOf } = discreteColormapStops(rgb, [128, 128, 128]);
    const at = (t: number) => {
      // Linear interpolation between the bracketing stops, as the colormap does.
      const i = stops.findIndex((s) => s.t >= t);
      if (stops[i].t === t || i === 0) return stops[i].color;
      const [a, b] = [stops[i - 1], stops[i]];
      const f = (t - a.t) / (b.t - a.t);
      return a.color.map((c, k) => c + f * (b.color[k] - c));
    };
    expect(at(valueOf(1))).toEqual([0, 1, 0]);
    expect(at(valueOf(-1))).toEqual([128 / 255, 128 / 255, 128 / 255]);
  });
});

describe('INFERNO_SCALE', () => {
  it('resolves through the LUT factory from black-purple to pale yellow', () => {
    const lut = lutFor(INFERNO_SCALE);
    expect(lut[0]).toEqual([0, 0, 4]);
    expect(lut[lut.length - 1]).toEqual([252, 255, 164]);
  });
});
