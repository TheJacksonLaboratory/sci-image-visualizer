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

describe('OsdTileRecolorer: a channel change during a first load', () => {
  it('repaints the last tile once OpenSeadragon has marked it loaded, so it shows the new channel colour', async () => {
    // OpenSeadragon's order: the tile's first tile-invalidated run (it decodes, then writes),
    // then tile-loaded, awaited while the tile is still `loading`, then the tile is marked
    // loaded and the event's promise resolves. Its invalidation skips a tile that is neither
    // loaded nor processing, as World.requestTileInvalidateEvent does.
    const handlers: Record<string, ((e: unknown) => unknown)[]> = {};
    const viewer = {
      world: { requestInvalidate: jest.fn() },
      navigator: null,
      addHandler: (name: string, fn: (e: unknown) => unknown) => {
        (handlers[name] ??= []).push(fn);
      },
    };
    const tile = { loading: true, loaded: false, processing: false, getUrl: () => '/tile?channel=0' };
    const original = [100, 100, 100, 255];
    let shown = [...original];
    let releaseDecode: () => void = () => undefined;
    const decoded = new Promise<void>((resolve) => (releaseDecode = resolve));
    const event = (firstLoad: boolean) => {
      const img = { data: new Uint8ClampedArray(original) };
      const ctx = { canvas: { width: 1, height: 1 }, getImageData: () => img, putImageData: jest.fn() };
      return {
        tile,
        getData: jest.fn(async () => {
          if (firstLoad) await decoded;
          return ctx;
        }),
        setData: jest.fn(async () => {
          shown = Array.from(img.data);
        }),
      };
    };
    const repaints: Promise<void>[] = [];
    const host: TileRecolorHost = {
      viewer: () => viewer as never,
      isGrayscale: () => false,
      isMultiChannel: () => true,
      isSimpleMultichannel: () => false,
      currentZ: () => 0,
      revealChannelSlice: () => undefined,
      invalidateChannelDisplay: () => {
        if (!tile.loaded && !tile.processing) return; // the engine's gate
        repaints.push(r.recolorTile(event(false)));
      },
      recomposite: () => undefined,
    };
    const r = new OsdTileRecolorer(host, new VisualizerStore());
    const channel = (color: string): IChannelState => ({
      index: 0,
      name: 'c0',
      color,
      min: 0,
      max: 255,
      gamma: 1,
      visible: true,
    });
    r.channelStates = [channel('#ff0000')];
    r.attach(viewer as never);

    const firstPass = r.recolorTile(event(true)); // starts with red, waits on the decode
    r.channelStates = [channel('#00ff00')]; // the user picks green meanwhile
    r.invalidateDisplay(); // held: the tile is in its first load
    releaseDecode();
    await firstPass;
    expect(shown[0]).toBeGreaterThan(0); // the first pass painted the old colour
    expect(shown[1]).toBe(0);

    let markLoaded: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => (markLoaded = resolve));
    for (const h of handlers['tile-loaded'] ?? []) await h({ tile, promise }); // still loading here
    expect(repaints).toHaveLength(0);
    tile.loading = false;
    tile.loaded = true;
    markLoaded();
    await promise;
    await Promise.resolve();
    await Promise.all(repaints);

    expect(repaints).toHaveLength(1);
    expect(shown[0]).toBe(0);
    expect(shown[1]).toBeGreaterThan(0);
  });
});
