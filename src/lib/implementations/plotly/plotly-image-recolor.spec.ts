import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import * as Plotly from 'plotly.js-dist-min';

import { HttpClient } from '@angular/common/http';

import { PlotlyService, PlotType } from './plotly.service';
import { PlotlyImageLoader } from './plotly-image-loader';
import { channelPlaneUrls, matrixToRgba, recolorKind } from './plotly-image-recolor';
import { DisplayPipeline } from '../osd/display-pipeline';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { CanvasToolHost } from '../../toolbar/tool-kit/canvas-tool';

/**
 * The Plotly image's channel display (#46 browser testing): a colour image's `image` trace has no
 * colour scale, so the Channels & Histogram dialog's per-channel window, gamma, invert, tint and
 * visibility must be composited into its `z` — by OSD's own DisplayPipeline, from the RAW pixels
 * — while the pixel tools and the histograms keep reading the raw ones.
 */

const multichannelInfo = (): IImageInfo =>
  ({
    fileName: 'mc.tif',
    urls: ['comp0', 'comp1'],
    channelUrls: [
      ['z0c0', 'z0c1', 'z0c2'],
      ['z1c0', 'z1c1', 'z1c2'],
    ],
    isGrayscale: false,
    isStack: true,
    showStack: false,
    trueImageSize: [2, 1],
    imageMeta: [{ channelCount: 3, rgbChannels: 1, x: 2, y: 1, z: 2, mppX: null, mppY: null }],
    tiled: false,
  }) as unknown as IImageInfo;

const rgbInfo = (): IImageInfo =>
  ({
    fileName: 'rgb.png',
    urls: ['rgb.png'],
    isGrayscale: false,
    isStack: false,
    showStack: false,
    trueImageSize: [2, 1],
    imageMeta: [{ channelCount: 3, rgbChannels: 3, x: 2, y: 1, z: 1, mppX: null, mppY: null }],
  }) as unknown as IImageInfo;

/** Each channel plane of the fake stack: pixel values per URL. */
const PLANES: Record<string, number[]> = {
  z0c0: [10, 200],
  z0c1: [20, 100],
  z0c2: [30, 50],
  z1c0: [40, 41],
  z1c1: [50, 51],
  z1c2: [60, 61],
};
/** The host's own composite (`urls[z]`) — NOT what the trace must show. */
const HOST_COMPOSITE = [
  [
    [7, 7, 7],
    [7, 7, 7],
  ],
];
/** The RGB image's one row of pixels. */
const RGB_FRAME = [
  [
    [200, 100, 30],
    [10, 20, 250],
  ],
];

function pipeline(states: IChannelState[], invert = false): DisplayPipeline {
  return new DisplayPipeline({
    isGrayscale: () => false,
    colorLut: () => null,
    channelStates: () => states,
    invertBg: () => invert,
  });
}

describe('recolorKind / channelPlaneUrls', () => {
  it('recomposites a stack with channel planes, recolours an RGB image, and leaves the rest', () => {
    expect(channelPlaneUrls(multichannelInfo())).toHaveLength(2);
    expect(channelPlaneUrls(rgbInfo())).toBeNull();
    expect(recolorKind(multichannelInfo(), true)).toBe('multichannel');
    expect(recolorKind(rgbInfo(), false)).toBe('rgb');
    // A tiled multichannel image is plotted from the server's flat composite: nothing per channel.
    expect(recolorKind({ ...multichannelInfo(), channelUrls: undefined }, false)).toBeNull();
    expect(recolorKind({ ...rgbInfo(), isGrayscale: true }, false)).toBeNull();
  });

  it('matrixToRgba packs rows of [r, g, b] cells into opaque RGBA', () => {
    expect(Array.from(matrixToRgba(RGB_FRAME, 2, 1))).toEqual([200, 100, 30, 255, 10, 20, 250, 255]);
  });
});

/** A stand-in for the browser's PNG encoder (jsdom has none): the RGBA bytes, base64'd. */
const fakeEncode = async (rgba: Uint8ClampedArray) =>
  `data:image/png;base64,${Buffer.from(rgba).toString('base64')}`;
/** The RGBA bytes a `source` from {@link fakeEncode} carries. */
const pixelsOf = (source: string) => Array.from(Buffer.from(source.split(',')[1], 'base64'));
/** Let the encodes and restyles queued so far settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The PlotlyService internals these specs drive. */
type Internals = {
  recolor: { encode: (rgba: Uint8ClampedArray) => Promise<string> };
  loader: { loadImage(url: string): Promise<unknown> };
  renderZoomCrop(
    frame: number[][][],
    ratios: number[],
    size: [number, number],
    imageSize: number[],
  ): { rendered: Promise<unknown> };
};

describe('PlotlyService channel display of a colour image', () => {
  let service: PlotlyService;
  const internals = () => service as unknown as Internals;
  let loadImage: jest.SpyInstance;
  let store: VisualizerStore;
  let traces: Array<{ z?: unknown; source?: string }>;
  let gd: HTMLElement & { _fullLayout?: object; data?: unknown[]; on?: unknown };
  let restyle: jest.SpyInstance;
  let handlers: Record<string, (e: unknown) => void>;
  let frames: FrameRequestCallback[];
  /** Run the animation frames requested so far (a dialog edit recolours on the next one), and
   *  let the recolours they start settle. */
  const flushFrames = async () => {
    frames.splice(0).forEach((cb) => cb(0));
    await settle();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(PlotlyService);
    internals().recolor.encode = fakeEncode;
    store = TestBed.inject(VisualizerStore);
    document.body.innerHTML = '<div id="plot"></div>';
    handlers = {};
    // The image-js decode of each URL: the host composite, the RGB frame, or a channel plane.
    loadImage = jest.spyOn(internals().loader, 'loadImage').mockImplementation(async (url: unknown) => {
      const u = url as string;
      if (PLANES[u]) return { width: 2, height: 1, grey: () => ({ data: PLANES[u], bitDepth: 8 }) };
      const pixels = u === 'rgb.png' ? RGB_FRAME[0] : HOST_COMPOSITE[0];
      return { width: 2, height: 1, getPixelsArray: () => pixels };
    });
    const draw = (div: string, data: typeof traces) => {
      gd = document.getElementById(div)!;
      gd._fullLayout = {};
      gd.data = data;
      gd.on = (name: string, fn: (e: unknown) => void) => (handlers[name] = fn);
      traces = data;
      return Promise.resolve(gd);
    };
    jest.spyOn(Plotly, 'newPlot').mockImplementation(draw as never);
    jest.spyOn(Plotly, 'react').mockImplementation(draw as never);
    jest.spyOn(Plotly, 'purge').mockImplementation(() => undefined as never);
    restyle = jest.spyOn(Plotly, 'restyle').mockResolvedValue(undefined as never);
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => frames.push(cb));
  });

  afterEach(() => jest.restoreAllMocks());

  /** Load and plot `info` as a heatmap with its channels derived as the host would. */
  async function plot(info: IImageInfo, z = 0) {
    store.setImageMeta(info.imageMeta ?? [], info.fileName);
    const loaded = await service.load(info, z);
    await service.plot('plot', loaded, info, 600, PlotType.HEATMAP);
    restyle.mockClear();
    return loaded;
  }
  /** The recolours drawn so far: [trace index, RGBA bytes]. */
  const recolours = () =>
    restyle.mock.calls.filter((c) => c[1]?.source).map((c) => [c[2][0], pixelsOf(c[1].source[0])]);
  const planes = (z: number) => [0, 1, 2].map((c) => Uint8Array.from(PLANES[`z${z}c${c}`]));

  describe('a serverless multichannel stack (channelUrls)', () => {
    it("composites the slice's own channel planes, not the host's composite", async () => {
      const loaded = await plot(multichannelInfo(), 1);
      expect(loaded.channelPlanes).toEqual([planes(1)]);
      const states = store.currentChannelStates();
      const expected = Array.from(pipeline(states).compositeChannels(planes(1), states, 1));
      expect(traces[0].z).toBeUndefined();
      expect(pixelsOf(traces[0].source!)).toEqual(expected);
      expect(expected.slice(0, 3)).not.toEqual(HOST_COMPOSITE[0][0]);
    });

    it('recomposites the trace on every channel edit, from the raw planes', async () => {
      await plot(multichannelInfo());
      store.setChannelState(1, { min: 10, max: 40, gamma: 2, color: '#ff00ff' });
      store.setChannelState(2, { visible: false });
      store.setInvert(true);
      expect(recolours()).toHaveLength(0); // on the next frame...
      await flushFrames();
      const states = store.currentChannelStates();
      const expected = Array.from(pipeline(states, true).compositeChannels(planes(0), states, 1));
      // ...once for the three edits.
      expect(recolours()).toEqual([[0, expected]]);
      expect(restyle.mock.calls[0][0]).toBe(gd);
      // No colour-scale window on an image trace.
      expect(restyle.mock.calls.some((c) => 'zmin' in (c[1] ?? {}))).toBe(false);
    });

    it("bins each channel's histogram from its own raw plane", async () => {
      await plot(multichannelInfo());
      store.setChannelState(0, { max: 5 });
      expect(service.getHistogram(0, 256)!.counts[200]).toBe(1);
      expect(service.getHistogram(1, 256)!.counts[100]).toBe(1);
      expect(service.getHistogram(2, 256)!.counts[50]).toBe(1);
    });

    it('recolours a stack slice when the slider brings it on screen', async () => {
      const info = { ...multichannelInfo(), showStack: true };
      service.setStackLoading(true);
      await plot(info);
      expect(traces).toHaveLength(2);
      store.setChannelState(0, { max: 100 });
      await flushFrames();
      expect(recolours().map((c) => c[0])).toEqual([0]);
      handlers['plotly_sliderchange']({ slider: { active: 1 } });
      await settle();
      const states = store.currentChannelStates();
      const expected = Array.from(pipeline(states).compositeChannels(planes(1), states, 1));
      expect(recolours()[1]).toEqual([1, expected]);
      // Shown again with nothing changed: no work.
      handlers['plotly_sliderchange']({ slider: { active: 1 } });
      await settle();
      expect(recolours()).toHaveLength(2);
    });

    it('draws an edit made while a recolour encodes after it, in the state current by then', async () => {
      await plot(multichannelInfo());
      const encodes: Array<() => void> = [];
      internals().recolor.encode = (rgba: Uint8ClampedArray) =>
        new Promise((resolve) => encodes.push(() => resolve(fakeEncode(rgba))));
      store.setChannelState(0, { max: 100 });
      await flushFrames();
      store.setChannelState(0, { max: 50 });
      await flushFrames();
      expect(encodes).toHaveLength(1); // the second waits for the first
      encodes.shift()!();
      await settle();
      expect(encodes).toHaveLength(1);
      encodes.shift()!();
      await settle();
      const states = store.currentChannelStates();
      expect(recolours().map((c) => c[1])).toEqual([
        expect.anything(),
        Array.from(pipeline(states).compositeChannels(planes(0), states, 1)),
      ]);
    });
  });

  describe('an RGB image', () => {
    it('plots the raw frame at the default channel states', async () => {
      await plot(rgbInfo());
      expect(pixelsOf(traces[0].source!)).toEqual([200, 100, 30, 255, 10, 20, 250, 255]);
    });

    it('recolours the trace per band, keeping the tools and the histogram on the raw pixels', async () => {
      const loaded = await plot(rgbInfo());
      store.setChannelState(0, { max: 100, gamma: 2 });
      store.setChannelState(2, { color: '#ffff00' });
      await flushFrames();
      const states = store.currentChannelStates();
      const rgba = new Uint8ClampedArray([200, 100, 30, 255, 10, 20, 250, 255]);
      pipeline(states).applyToRgba(rgba);
      expect(recolours().pop()).toEqual([0, Array.from(rgba)]);

      const tools = (service as unknown as { toolHost: CanvasToolHost }).toolHost.getCachedImageData()!;
      expect(tools.frames[0]).toBe(loaded.data[0]);
      expect(service.getHistogram(0, 256)!.counts[200]).toBe(1);
      // The readback is what is on screen.
      gd.data = [{ type: 'image', source: 'x' }];
      expect(Array.from(service.getDisplayedPixelData()!.data)).toEqual([
        ...Array.from(rgba.slice(0, 3)),
        ...Array.from(rgba.slice(4, 7)),
      ]);

      // Back at the defaults: the raw frame again.
      store.setChannelStates(store.currentChannelStates().map((c, i) => ({ ...c, ...rgbDefaults[i] })));
      await flushFrames();
      expect(recolours().pop()).toEqual([0, [200, 100, 30, 255, 10, 20, 250, 255]]);
    });

    it('recolours a high-def zoom crop as it lands', async () => {
      await plot(rgbInfo());
      store.setInvert(true);
      const crop = [[[0, 128, 255]]];
      await internals().renderZoomCrop(crop, [1, 1], [1, 1], [0, 1, 0, 1]).rendered;
      expect(pixelsOf(traces[0].source!)).toEqual([255, 127, 0, 255]);
    });

    it('draws the raw frame when the picture cannot be encoded', async () => {
      internals().recolor.encode = () => Promise.reject(new Error('no canvas'));
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const loaded = await plot(rgbInfo());
      expect(traces[0].z).toBe(loaded.data[0]);
      expect(traces[0].source).toBeUndefined();
    });
  });

  it('leaves a grayscale heatmap on its colour-scale window', async () => {
    const info = { ...rgbInfo(), isGrayscale: true, imageMeta: [{ channelCount: 1, rgbChannels: 1 }] };
    loadImage.mockResolvedValue({ width: 2, height: 1, grey: () => ({ data: [1, 2] }) });
    await plot(info as unknown as IImageInfo);
    store.setChannelState(0, { min: 3, max: 9 });
    await flushFrames();
    expect(restyle).toHaveBeenCalledWith(gd, expect.objectContaining({ zmin: 3, zmax: 9 }));
    expect(recolours()).toHaveLength(0);
  });
});

describe('PlotlyImageLoader colour frames', () => {
  it("keeps a 16-bit RGB image's high byte, the 0..255 an image trace draws", async () => {
    const loader = new PlotlyImageLoader({} as HttpClient);
    jest.spyOn(loader, 'loadImage').mockResolvedValue({
      width: 1,
      height: 1,
      bitDepth: 16,
      getPixelsArray: () => [[65535, 32768, 256]],
    } as never);
    const loaded = await loader.load(
      rgbInfo(),
      0,
      undefined,
      () => undefined,
      () => true,
    );
    expect(loaded.data).toEqual([[[[255, 128, 1]]]]);
  });
});

const rgbDefaults: Array<Partial<IChannelState>> = ['#ff0000', '#00ff00', '#0000ff'].map((color) => ({
  color,
  min: 0,
  max: 255,
  gamma: 1,
  visible: true,
}));
