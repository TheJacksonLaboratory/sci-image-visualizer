import { MAX_DEFER_MS, OsdTileRecolorer, TileRecolorHost } from './tile-recolor';
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

describe('OsdTileRecolorer.attach', () => {
  it('hooks the viewer and its navigator without invalidating any tile', () => {
    // attach() runs before the viewer opens its source, so each tile is recoloured by its own
    // first load. An invalidation here (it used to run on `open`, with tiles already loading)
    // outdated those first loads, and OpenSeadragon then drew raw tiles: "Attempt to draw tile
    // cache … with unsupported type 'rasterBlob' for the target drawer!".
    const world = { requestInvalidate: jest.fn() };
    const navigator = { addHandler: jest.fn(), world: { requestInvalidate: jest.fn() } };
    const viewer = { addHandler: jest.fn(), world, navigator };
    const host: TileRecolorHost = {
      viewer: () => viewer as never,
      isGrayscale: () => true,
      isMultiChannel: () => true,
      isSimpleMultichannel: () => false,
      currentZ: () => 0,
      revealChannelSlice: () => undefined,
      invalidateChannelDisplay: () => undefined,
      recomposite: () => undefined,
    };
    const r = new OsdTileRecolorer(host, new VisualizerStore());
    r.colorLut = [];
    r.attach(viewer as never);
    expect(viewer.addHandler).toHaveBeenCalledWith('tile-invalidated', expect.any(Function));
    expect(navigator.addHandler).toHaveBeenCalledWith('tile-invalidated', expect.any(Function));
    expect(world.requestInvalidate).not.toHaveBeenCalled();
    expect(navigator.world.requestInvalidate).not.toHaveBeenCalled();
  });
});

describe('OsdTileRecolorer.invalidateDisplay while tiles first load', () => {
  function setup() {
    const handlers: Record<string, ((e: unknown) => void)[]> = {};
    const world = { requestInvalidate: jest.fn() };
    const viewer = {
      world,
      navigator: null,
      addHandler: (name: string, fn: (e: unknown) => void) => {
        (handlers[name] ??= []).push(fn);
      },
    };
    const host: TileRecolorHost = {
      viewer: () => viewer as never,
      isGrayscale: () => true,
      isMultiChannel: () => false,
      isSimpleMultichannel: () => false,
      currentZ: () => 0,
      revealChannelSlice: () => undefined,
      invalidateChannelDisplay: () => undefined,
      recomposite: () => undefined,
    };
    const r = new OsdTileRecolorer(host, new VisualizerStore());
    r.attach(viewer as never);
    const fire = (name: string, e: unknown) => (handlers[name] ?? []).forEach((fn) => fn(e));
    return { r, world, fire };
  }

  afterEach(() => jest.useRealTimers());

  it('holds the invalidation until the tiles in their first load are ready', async () => {
    const { r, world, fire } = setup();
    const tile = { loading: true };
    // A first load's tile-invalidated run (no LUT yet: it returns before reading pixels).
    await r.recolorTile({ tile, getData: jest.fn(), setData: jest.fn() });
    r.invalidateDisplay();
    expect(world.requestInvalidate).not.toHaveBeenCalled();
    fire('tile-loaded', { tile });
    expect(world.requestInvalidate).toHaveBeenCalledTimes(1);
  });

  it('invalidates at once when nothing is loading, and runs a held one after MAX_DEFER_MS', async () => {
    jest.useFakeTimers();
    const { r, world } = setup();
    r.invalidateDisplay();
    expect(world.requestInvalidate).toHaveBeenCalledTimes(1);

    await r.recolorTile({ tile: { loading: true }, getData: jest.fn(), setData: jest.fn() });
    r.invalidateDisplay();
    expect(world.requestInvalidate).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(MAX_DEFER_MS);
    expect(world.requestInvalidate).toHaveBeenCalledTimes(2);
  });

  it('a tile that failed or was unloaded during its first load does not hold it', async () => {
    const { r, world, fire } = setup();
    const a = { loading: true };
    const b = { loading: true };
    await r.recolorTile({ tile: a, getData: jest.fn(), setData: jest.fn() });
    await r.recolorTile({ tile: b, getData: jest.fn(), setData: jest.fn() });
    r.invalidateDisplay();
    fire('tile-load-failed', { tile: a });
    expect(world.requestInvalidate).not.toHaveBeenCalled();
    fire('tile-unloaded', { tile: b });
    expect(world.requestInvalidate).toHaveBeenCalledTimes(1);
  });
});
