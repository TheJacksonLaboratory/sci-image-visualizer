import { OsdTileRecolorer, TileRecolorHost } from './tile-recolor';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';

/** A tile event over one opaque RGBA pixel, recording what is written back. */
function tileEvent(pixel: number[]) {
  const img = { data: new Uint8ClampedArray(pixel) };
  const ctx = {
    canvas: { width: 1, height: 1 },
    getImageData: () => img,
    putImageData: jest.fn(),
  };
  return {
    img,
    event: {
      getData: jest.fn(async () => ctx),
      setData: jest.fn(async () => undefined),
    },
  };
}

function recolorer(simpleMultichannel: boolean): OsdTileRecolorer {
  const host: TileRecolorHost = {
    viewer: () => null,
    isGrayscale: () => false,
    isMultiChannel: () => false,
    isSimpleMultichannel: () => simpleMultichannel,
    currentZ: () => 0,
    revealChannelSlice: () => undefined,
    invalidateChannelDisplay: () => undefined,
    recomposite: () => undefined,
  };
  const r = new OsdTileRecolorer(host, new VisualizerStore());
  const ch = (index: number, color: string): IChannelState => ({
    index,
    name: `c${index}`,
    color,
    min: 0,
    max: 100,
    gamma: 2,
    visible: true,
  });
  r.channelStates = [ch(0, '#ff0000'), ch(1, '#00ff00'), ch(2, '#0000ff'), ch(3, '#ffffff')];
  r.invertBg = true;
  return r;
}

describe('OsdTileRecolorer.recolorTile', () => {
  it('recolours an RGB tile through the channel states', async () => {
    const { event, img } = tileEvent([40, 80, 120, 255]);
    await recolorer(false).recolorTile(event);
    expect(event.setData).toHaveBeenCalled();
    expect(Array.from(img.data)).not.toEqual([40, 80, 120, 255]);
  });

  it("leaves a serverless multichannel composite's tiles alone: it is in the display colours already", async () => {
    // Recolouring them as RGB applied the window, gamma and invert twice — an inverted
    // composite drew black (#46 browser testing).
    const { event, img } = tileEvent([40, 80, 120, 255]);
    await recolorer(true).recolorTile(event);
    expect(event.getData).not.toHaveBeenCalled();
    expect(event.setData).not.toHaveBeenCalled();
    expect(Array.from(img.data)).toEqual([40, 80, 120, 255]);
  });
});
