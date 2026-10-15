import { volumeRamp } from './napari-display-state';

describe('volumeRamp', () => {
  const display = (colormap: any, reverse = false) => ({ colormap, reverse, invert: false });

  it("ramps black to the channel's colour under a grayscale colormap, reversed for reverse-scale", () => {
    const ramp = volumeRamp('#ff8000', display(null));
    expect(ramp).toHaveLength(256);
    expect(ramp[0]).toEqual([0, 0, 0]);
    expect(ramp[255]).toEqual([255, 128, 0]);
    expect(volumeRamp('#ff8000', display({ label: 'Greys', data: { value: 'Greys' } }))[255]).toEqual([
      255, 128, 0,
    ]);
    expect(volumeRamp('#ff8000', display(null, true))[0]).toEqual([255, 128, 0]);
  });

  it("follows a coloured colormap, as the 3D view does, not the channel's colour", () => {
    const viridis = display({ label: 'Viridis', data: { value: 'Viridis' } });
    const ramp = volumeRamp('#ffffff', viridis);
    expect(ramp[0]).not.toEqual([0, 0, 0]);
    expect(ramp[0]).not.toEqual(ramp[255]);
    expect(volumeRamp('#ffffff', { ...viridis, reverse: true })[0]).toEqual(ramp[255]);
  });
});
