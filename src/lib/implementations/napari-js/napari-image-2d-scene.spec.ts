import { ImageLayer, additiveComposite, mapScalar, tintColormap } from 'napari-js';
import type { RGB, TiledSource, Viewer } from 'napari-js';
import { HeadlessViewer } from 'napari-js/testing';

import { Image2dScene } from './napari-image-2d-scene';
import { NapariDisplayState } from './napari-display-state';
import { NapariTileClient } from './napari-tile-client';
import type { SceneContext } from './napari-scene';
import { DisplayPipeline } from '../osd/display-pipeline';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { TileDescriptor } from '../tile-server';

/**
 * The 2D image's channel display (#46 browser testing): a serverless multichannel stack and an
 * RGB image must follow the Channels & Histogram dialog as OSD does — per-channel window, gamma,
 * invert, tint and visibility — with each channel's histogram from its own raw pixels. Runs the
 * real napari-js (`HeadlessViewer`): the layers are napari-js's own, with a fake tile client.
 */

type Plane = { data: Uint8Array; width: number; height: number };

const W = 4;
const H = 2;
/** A W×H plane filled with `v`. */
const plane = (v: number): Plane => ({ data: new Uint8Array(W * H).fill(v), width: W, height: H });

/** A serverless 4-channel hyperstack as the example host emits it: per-channel plane URLs plus a
 *  composite per slice, no tile server. */
const serverlessMc = (): IImageInfo =>
  ({
    isGrayscale: false,
    trueImageSize: [W, H],
    urls: ['comp0', 'comp1', 'comp2'],
    channelUrls: [0, 1, 2].map((z) => [0, 1, 2, 3].map((c) => `z${z}c${c}`)),
    isStack: true,
    showStack: false,
    scaleRatio: true,
    fileName: 'mc.tif',
    imageMeta: [{ channelCount: 4, rgbChannels: 1, x: W, y: H, z: 3, mppX: null, mppY: null }],
    tiled: false,
  }) as unknown as IImageInfo;

/** A serverless RGB image (002_img.png). */
const serverlessRgb = (): IImageInfo =>
  ({
    isGrayscale: false,
    trueImageSize: [W, H],
    urls: ['rgb.png'],
    isStack: false,
    showStack: false,
    scaleRatio: true,
    fileName: 'rgb.png',
    imageMeta: [{ channelCount: 3, rgbChannels: 3, x: W, y: H, z: 1, mppX: null, mppY: null }],
    tiled: false,
  }) as unknown as IImageInfo;

/** RGB pixel of the fake RGB image: R=200, G=100, B=30 everywhere. */
const RGB_PIXEL = [200, 100, 30];

/** What a test drives: the scene, its viewer and store, and the fake tile client's spies. */
interface Rig {
  scene: Image2dScene;
  viewer: Viewer;
  store: VisualizerStore;
  tiles: Record<string, jest.Mock>;
  imageLayers(): ImageLayer[];
}

function rig(info: IImageInfo, opts: { desc?: TileDescriptor | null; z?: number } = {}): Rig {
  const viewer = new HeadlessViewer() as unknown as Viewer;
  const store = new VisualizerStore();
  store.setImageMeta(info.imageMeta ?? [], info.fileName);
  const simple = info.tiled === false;
  const tiles: Record<string, jest.Mock> = {
    isSimple: jest.fn(() => simple),
    ensureDescriptor: jest.fn(async () => opts.desc ?? null),
    currentDescriptor: jest.fn(() => opts.desc ?? null),
    mppX: jest.fn(() => 0),
    // Channel c of slice z: every pixel 10·(z+1) + c, so each plane is told apart.
    fetchChannelData: jest.fn(async (_info: unknown, z: number, c?: number) => plane(10 * (z + 1) + (c ?? 0))),
    fetchImage: jest.fn(async () => ({ width: W, height: H, close: () => undefined })),
    readRgbBands: jest.fn(async () => RGB_PIXEL.map(plane)),
    overviewImage: jest.fn(async () => ({ width: W, height: H })),
    tiledSource: jest.fn((desc: TileDescriptor, _c: number | undefined, channels: 1 | 4): TiledSource => ({
      kind: 'tiled',
      width: desc.width,
      height: desc.height,
      tileSize: 512,
      levels: 1,
      depth: 1,
      channels,
      dtype: 'uint8',
      fetchTile: async () => ({ width: 1, height: 1, data: new Uint8Array(channels) }),
    })),
  };
  tiles['rgbBandSources'] = jest.fn((desc: TileDescriptor) =>
    [0, 1, 2].map(() => tiles['tiledSource'](desc, undefined, 1)),
  );
  let size = { width: 0, height: 0 };
  const ctx = {
    viewer,
    host: document.createElement('div'),
    canvas: document.createElement('canvas'),
    signal: new AbortController().signal,
    loading: () => new AbortController().signal,
    info: () => info,
    z: () => opts.z ?? 0,
    tiles: tiles as unknown as NapariTileClient,
    display: new NapariDisplayState(store),
    badge: { begin: () => () => undefined },
    tools: { install2dInteraction: jest.fn(), scheduleReadback: jest.fn() },
    store,
    regionStore: {},
    settings: { navigatorVisible: false, imageSmoothing: false },
    stack: { loading: () => undefined, progress: () => undefined },
    imageSize: () => size,
    setImageSize: (width: number, height: number) => (size = { width, height }),
    fitCameraSoon: () => undefined,
    outsideZone: <T>(fn: () => T) => fn(),
    inZone: <T>(fn: () => T) => fn(),
  } as unknown as SceneContext;
  const scene = new Image2dScene(ctx);
  const imageLayers = () => viewer.layers.items.filter((l): l is ImageLayer => l instanceof ImageLayer);
  return { scene, viewer, store, tiles, imageLayers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** napari-js's composite of one pixel over the visible additive `layers` (each sampling `values[k]`),
 *  through each layer's own window, gamma, invert and colormap — the CPU ground truth its shader
 *  is tested against; as 0..255 bytes. */
function napariPixel(layers: ImageLayer[], values: number[]): number[] {
  const colors: RGB[] = layers
    .map((layer, k) => ({ layer, v: values[k] }))
    .filter(({ layer }) => layer.visible)
    .map(({ layer, v }) =>
      mapScalar(v, {
        climLo: layer.contrastLimits[0],
        climHi: layer.contrastLimits[1],
        gamma: layer.gamma,
        invert: layer.invert,
        colormap: layer.colormap!,
      }),
    );
  return additiveComposite(colors).map((c) => Math.round(c * 255));
}

function osd(states: IChannelState[], invert: boolean): DisplayPipeline {
  return new DisplayPipeline({
    isGrayscale: () => false,
    colorLut: () => null,
    channelStates: () => states,
    invertBg: () => invert,
  });
}

function expectWithinOne(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((a, i) => expect(Math.abs(a - expected[i])).toBeLessThanOrEqual(1));
}

describe('Image2dScene channel display', () => {
  // decodeImageRGBA draws the RGB bitmap into a 2D canvas, which jsdom lacks: serve the
  // fake image's pixels.
  beforeEach(() => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage: () => undefined,
          fillRect: () => undefined,
          clearRect: () => undefined,
          putImageData: () => undefined,
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < data.length; i += 4) data.set([...RGB_PIXEL, 255], i);
            return { data };
          },
        }) as unknown as CanvasRenderingContext2D,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  describe('a serverless multichannel stack (channelUrls)', () => {
    it("draws one tinted additive layer per channel from the slice's own planes", async () => {
      const { scene, tiles, imageLayers, store } = rig(serverlessMc(), { z: 1 });
      await scene.mount();
      expect(scene.imageMode).toBe('multichannel');
      // Each channel's own plane of slice 1, not the composite.
      expect(tiles['fetchChannelData'].mock.calls.map((c) => [c[1], c[2]])).toEqual([
        [1, 0],
        [1, 1],
        [1, 2],
        [1, 3],
      ]);
      expect(tiles['fetchImage']).not.toHaveBeenCalled();
      const layers = imageLayers();
      expect(layers).toHaveLength(4);
      layers.forEach((layer, c) =>
        expect(layer.colormap).toEqual(tintColormap(store.currentChannelStates()[c].color)),
      );
    });

    it('follows every channel edit live, without re-fetching', async () => {
      const { scene, tiles, imageLayers, store } = rig(serverlessMc());
      await scene.mount();
      tiles['fetchChannelData'].mockClear();
      store.setChannelState(1, { min: 5, max: 20, gamma: 2, color: '#ff00ff' });
      store.setChannelState(3, { visible: false });
      store.setInvert(true);
      const [, ch1, , ch3] = imageLayers();
      expect(ch1.contrastLimits).toEqual([5, 20]);
      expect(ch1.gamma).toBe(0.5); // ImageJ γ 2 → napari-js γ ½
      expect(ch1.colormap).toEqual(tintColormap('#ff00ff'));
      expect(ch3.visible).toBe(false);
      expect(imageLayers().every((l) => l.invert)).toBe(true);
      expect(tiles['fetchChannelData']).not.toHaveBeenCalled();
    });

    it("bins each channel's histogram from its own plane", async () => {
      const { scene } = rig(serverlessMc());
      await scene.mount();
      // Channel c of slice 0 is all 10 + c.
      [0, 1, 2, 3].forEach((c) => {
        const h = scene.histogram(c, 256)!;
        expect(h.counts[10 + c]).toBe(W * H);
      });
    });

    it('re-renders a scrubbed slice from its planes, a superseded slice never landing last', async () => {
      const { scene, tiles, imageLayers } = rig(serverlessMc());
      await scene.mount();
      const held: Array<() => void> = [];
      const serve = tiles['fetchChannelData'].getMockImplementation()!;
      tiles['fetchChannelData'].mockImplementation(
        (info: unknown, z: number, c?: number) =>
          new Promise((resolve) => held.push(() => resolve(serve(info, z, c)))),
      );
      scene.setZ(1);
      scene.setZ(2);
      await flush();
      // Slice 2's planes land first, then the stale slice 1's.
      held.splice(4).forEach((go) => go());
      await flush();
      held.forEach((go) => go());
      await flush();
      expect(imageLayers()).toHaveLength(4);
      const h = scene.histogram(0, 256)!;
      expect(h.counts[30]).toBe(W * H); // slice 2, channel 0
    });

    it('matches OSD for the same channel states (cross-backend)', async () => {
      const { scene, imageLayers, store } = rig(serverlessMc());
      await scene.mount();
      store.setChannelState(0, { min: 20, max: 180, gamma: 0.6, color: '#ff00ff' });
      store.setChannelState(1, { min: 50, max: 250, gamma: 1.8 });
      store.setChannelState(2, { visible: false });
      store.setChannelState(3, { color: '#00ffff', gamma: 1.4 });
      for (const invert of [false, true]) {
        store.setInvert(invert);
        const states = store.currentChannelStates();
        const values = [40, 150, 220, 90];
        const planes = values.map((v) => new Uint8ClampedArray([v, v, v, 255]));
        const out = osd(states, invert).compositeChannels(planes, states);
        expectWithinOne(napariPixel(imageLayers(), values), [out[0], out[1], out[2]]);
      }
    });
  });

  it('leaves a grayscale image on its colormap layer', async () => {
    const info = { ...serverlessRgb(), isGrayscale: true, imageMeta: [{ channelCount: 1, rgbChannels: 1 }] };
    const { scene, imageLayers, store } = rig(info as unknown as IImageInfo);
    await scene.mount();
    expect(scene.imageMode).toBe('grayscale');
    store.setChannelState(0, { max: 100 });
    expect(imageLayers()).toHaveLength(1);
    expect(imageLayers()[0].contrastLimits).toEqual([0, 100]);
  });
});
