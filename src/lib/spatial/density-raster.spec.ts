import { lutFor } from './spatial-encoding';
import { INFERNO_SCALE } from './density-raster';

describe('INFERNO_SCALE', () => {
  it('resolves through the LUT factory from black-purple to pale yellow', () => {
    const lut = lutFor(INFERNO_SCALE);
    expect(lut[0]).toEqual([0, 0, 4]);
    expect(lut[lut.length - 1]).toEqual([252, 255, 164]);
  });
});
