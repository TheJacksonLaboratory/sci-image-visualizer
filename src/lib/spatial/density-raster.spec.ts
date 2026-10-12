import { INFERNO_LUT } from 'napari-js/colormaps';

import { lutFor } from './spatial-encoding';
import { densityColorBarCss } from './spatial-panel-model';

describe('the density map default colormap', () => {
  it("is matplotlib's exact inferno, every entry", () => {
    const lut = lutFor(INFERNO_LUT);
    expect(lut).toHaveLength(256);
    for (let i = 0; i < 256; i++) {
      expect(lut[i]).toEqual([INFERNO_LUT[i * 3], INFERNO_LUT[i * 3 + 1], INFERNO_LUT[i * 3 + 2]]);
    }
    // Black-purple to pale yellow.
    expect(lut[0]).toEqual([0, 0, 3]);
    expect(lut[255]).toEqual([252, 254, 164]);
  });

  it('colours the density colour bar when no colormap is picked', () => {
    // The bar's middle stop is inferno at 0.5; the old 9-anchor scale drew #a52c60 there.
    const css = densityColorBarCss(null);
    const mid = `rgb(${INFERNO_LUT[128 * 3]}, ${INFERNO_LUT[128 * 3 + 1]}, ${INFERNO_LUT[128 * 3 + 2]})`;
    expect(css.replace(/\s/g, '')).toContain(mid.replace(/\s/g, ''));
  });
});
