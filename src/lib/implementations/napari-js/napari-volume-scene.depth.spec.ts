import { VolumeScene } from './napari-volume-scene';

/** The scene with only what setRegionsThroughVolume reads (its constructor needs a whole viewer). */
function scene(multichannel: boolean, blending = multichannel ? 'additive' : 'translucent') {
  const layers = [{ blending }, { blending }];
  const requestRender = jest.fn();
  const s = Object.assign(Object.create(VolumeScene.prototype), {
    view: { layers },
    multichannel,
    ctx: { viewer: { requestRender } },
  }) as VolumeScene;
  return { s, layers, requestRender };
}

describe('VolumeScene regions through the volume', () => {
  it('lets a grayscale volume hide the regions behind it, or none', () => {
    const { s, layers, requestRender } = scene(false);
    s.setRegionsThroughVolume(true);
    expect(layers.map((l) => l.blending)).toEqual(['translucent_no_depth', 'translucent_no_depth']);
    expect(requestRender).toHaveBeenCalled();
    s.setRegionsThroughVolume(false);
    expect(layers.map((l) => l.blending)).toEqual(['translucent', 'translucent']);
  });

  it("leaves a multichannel volume's additive channels as they are (they hide nothing)", () => {
    const { s, layers } = scene(true);
    s.setRegionsThroughVolume(true);
    expect(layers.map((l) => l.blending)).toEqual(['additive', 'additive']);
  });
});
