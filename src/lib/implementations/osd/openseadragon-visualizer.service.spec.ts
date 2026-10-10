import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { EMPTY, firstValueFrom } from 'rxjs';

import { OpenSeadragonVisualizerService } from './openseadragon-visualizer.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { saveAs } from 'file-saver';
import { OsdCoordinateTransform } from './osd-coordinate-transform';
import * as tileClient from './tile-client';
import { VisualizerStore } from '../../store/visualizer-store.service';
import type { CachedImageData } from '../../toolbar/wand/wand-tool.service';
import { isPackedFrame, PackedFrame } from '../../toolbar/tool-kit/frame-pixels';

jest.mock('file-saver', () => ({ saveAs: jest.fn() }));

/**
 * CHARACTERIZATION TESTS (refactoring plan, Step 0) — instantiation beachhead.
 *
 * The OSD backend never had a spec; mounting a real viewer needs a live DOM +
 * canvas, so this suite pins only the *unmounted* surface: construction, the
 * IVisualizer stubs, the histogram fallbacks, and the no-image guards. The
 * extraction steps (slice cache, display pipeline, tile client) will grow real
 * unit coverage from here.
 */
describe('OpenSeadragonVisualizerService (characterization, unmounted)', () => {
  let service: OpenSeadragonVisualizerService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [OpenSeadragonVisualizerService, ...VIZ_PORT_STUBS],
    });
    service = TestBed.inject(OpenSeadragonVisualizerService);
    http = TestBed.inject(HttpTestingController);
    // The real loadImageEl decodes via an <img> that never fires load in jsdom
    // (hanging the simple-mode tests). Default it to a decode failure so
    // toFullResUrl is a no-op (its catch returns the preview URL unchanged)
    // unless a test overrides it — decoupling the load() tests from the resample
    // (which now resizes to EXACTLY trueImageSize, up or down; jit-ui#93).
    (service as unknown as { loadImageEl: (u: string) => Promise<unknown> }).loadImageEl =
      jest.fn().mockRejectedValue(new Error('no <img> decode in jsdom'));
  });

  afterEach(() => {
    service.unsubscribe();
    // The construction chain lazily fetches the colormap LUT asset — that one
    // request is expected; anything else from an unmounted service is not.
    http.match((req) => req.url.includes('colormap-luts')).forEach((r) => r.flush({}));
    http.verify();
  });

  it('hands the pixel tools the canvas readback as a packed frame, without per-pixel arrays (RT-17)', () => {
    // A 2560×1440 device-pixel readback: the old path built 3.7 M [r,g,b] arrays from it.
    const w = 2560;
    const h = 1440;
    const data = new Uint8ClampedArray(w * h * 4);
    const getImageData = jest.fn(() => ({ data }));
    (service as unknown as { viewer: unknown }).viewer = {
      destroy: () => undefined,
      drawer: { canvas: { width: w, height: h, clientWidth: w / 2, clientHeight: h / 2,
        getContext: () => ({ getImageData }) } },
      viewport: {
        viewerElementToImageCoordinates: (p: { x: number; y: number }) => ({ x: 100 + p.x * 4, y: 50 + p.y * 2 }),
      },
    };
    const cached = (service as unknown as { readbackViewport(): CachedImageData | null }).readbackViewport()!;
    const frame = cached.frames[0];
    expect(isPackedFrame(frame)).toBe(true);
    expect((frame as PackedFrame).data).toBe(data); // the readback itself, not a copy
    expect(cached).toMatchObject({ width: w, height: h, isGrayscale: false, originX: 100, originY: 50 });
    expect(cached.ratios).toEqual([(w / 2 * 4) / w, (h / 2 * 2) / h]);
  });

  it('setActiveTool: mouse-nav is off while a canvas tool holds the pointer, on otherwise', () => {
    const setMouseNavEnabled = jest.fn();
    type Internals = { viewer: unknown; viewportPixels: unknown; canvasTools: { activeId: string | null } };
    const internals = service as unknown as Internals;
    internals.viewer = { setMouseNavEnabled, destroy: () => undefined };

    internals.viewportPixels = {};
    service.setActiveTool('wand', { sensitivity: 2 });
    expect(setMouseNavEnabled).toHaveBeenLastCalledWith(false);
    expect(internals.viewportPixels).toBeNull(); // re-read the viewport on first use
    expect(internals.canvasTools.activeId).toBe('wand');

    internals.viewportPixels = {};
    service.setActiveTool('zoomToBox');
    expect(setMouseNavEnabled).toHaveBeenLastCalledWith(false);
    expect(internals.viewportPixels).not.toBeNull(); // the box reads no pixels

    // A region draw mode (armed on the overlay) or nothing: no canvas tool, nav back on.
    service.setActiveTool('drawrect');
    expect(setMouseNavEnabled).toHaveBeenLastCalledWith(true);
    expect(internals.canvasTools.activeId).toBeNull();
  });

  it('constructs against the port stubs (no viewer, no DOM)', () => {
    expect(service).toBeTruthy();
    expect(service.capabilities).toBeDefined();
  });

  it('load() resolves an empty descriptor when no image is selected (info port returns null)', async () => {
    const loaded = await service.load({ fileName: 'x.tif' } as any, 0);
    expect(loaded.descriptor).toBeNull();
    expect(loaded.infoB64).toBe('');
  });

  it('load() simple (tiled:false) skips the tile server and returns the URL + a one-level descriptor', async () => {
    const port = TestBed.inject(TILE_ACCESS_PORT);
    const infoSpy = jest.spyOn(port, 'getSelectedInfoB64');
    const loaded = await service.load({
      fileName: 'pipe.png',
      tiled: false,
      isGrayscale: false,
      urls: ['blob:abc', 'blob:def'],
      trueImageSize: [10, 20],
      imageMeta: [{ rgbChannels: 3, channelCount: 3, x: 10, y: 20, z: 1, mppX: 0.5 }],
    } as any, 1);
    // No tile-server consultation at all (the afterEach http.verify() also
    // asserts no /tiles/info request was issued).
    expect(infoSpy).not.toHaveBeenCalled();
    expect(loaded.simple).toBe(true);
    expect(loaded.url).toBe('blob:def');          // urls[zIndex=1]
    expect(loaded.infoB64).toBe('');
    expect(loaded.descriptor).toMatchObject({
      width: 10, height: 20, z: 1, realLevels: 1, channels: 3, multichannel: false, mppX: 0.5,
    });
    expect(loaded.descriptor!.levels).toHaveLength(1);
  });

  /**
   * Regression: a numbered image series (jit-ui folder-stack feature) is
   * tiled:false with REAL server /preview URLs, not blob:/data: URLs (the
   * processing-pipeline's original tiled:false use case, unaffected — see
   * above). OSD's `type:'image'` source loads via a plain `<img src>`, which
   * cannot carry the Bearer auth header — behind an OAuth2-proxied
   * deployment that 302s to the login page and then CORS-fails. The fix
   * fetches through HttpClient (auth interceptor applies) and hands OSD a
   * blob: URL instead.
   */
  it('load() simple (tiled:false) fetches a real server URL via HttpClient, not directly', async () => {
    const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-1');
    const loadPromise = service.load({
      fileName: 'case1_014.dcm',
      tiled: false,
      isGrayscale: true,
      urls: ['/api/preview?info=abc', '/api/preview?info=def'],
      trueImageSize: [10, 20],
      imageMeta: [{ rgbChannels: 1, channelCount: 1, x: 10, y: 20, z: 1 }],
    } as any, 1);

    const req = http.expectOne('/api/preview?info=def'); // urls[zIndex=1]
    expect(req.request.method).toBe('GET');
    const blob = new Blob(['x']);
    req.flush(blob);

    const loaded = await loadPromise;
    expect(loaded.simple).toBe(true);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(loaded.url).toBe('blob:mock-1');
    createObjectURL.mockRestore();
  });

  it('load() simple infers a single channel for a grayscale image and falls back to urls[0]', async () => {
    const loaded = await service.load({
      fileName: 'g.png',
      tiled: false,
      isGrayscale: true,
      urls: ['blob:gray'],
      trueImageSize: [4, 4],
      imageMeta: [],                              // no meta → channels from isGrayscale
    } as any, 0);
    expect(loaded.simple).toBe(true);
    expect(loaded.url).toBe('blob:gray');
    expect(loaded.descriptor!.channels).toBe(1);
  });

  /**
   * Regression: when a simple stack has no loadable URL (empty urls[], or the
   * slice fetch fails), load() must return a null descriptor — the same
   * "couldn't load" signal as the tiled path — so plot()'s `if (!d)` guard
   * returns false and the router falls back, instead of handing plot() a
   * simple source with an undefined src that throws when mounted.
   */
  it('load() simple returns a null descriptor when no slice URL can be resolved', async () => {
    const loaded = await service.load({
      fileName: 'empty.png',
      tiled: false,
      isGrayscale: true,
      urls: [],                     // nothing to load
      trueImageSize: [4, 4],
      imageMeta: [{ rgbChannels: 1, channelCount: 1, x: 4, y: 4, z: 1 }],
    } as any, 0);
    expect(loaded.descriptor).toBeNull();
    // plot() bails on a null descriptor rather than mounting an undefined src.
    expect(await service.plot('nope', loaded, {} as any, 600, {} as any)).toBe(false);
  });

  it('load() simple detects MULTICHANNEL from channelUrls + channelCount>1', async () => {
    const loadPlanes = jest.spyOn(
      service as unknown as { loadSimpleChannelPlanes(u: string[]): Promise<unknown[]> },
      'loadSimpleChannelPlanes',
    );
    const loaded = await service.load({
      fileName: 'hyper.tif',
      tiled: false,
      isGrayscale: false,
      urls: ['blob:z0'],
      channelUrls: [['blob:z0c0', 'blob:z0c1', 'blob:z0c2', 'blob:z0c3']],
      trueImageSize: [8, 8],
      imageMeta: [{ rgbChannels: 1, channelCount: 4, x: 8, y: 8, z: 1 }],
    } as any, 0);
    // The MULTICHANNEL branch was taken. jsdom can't decode <img>, so the planes
    // are empty and no composite builds → null descriptor — detection is what we
    // pin here; the real composite is covered by the headless example test.
    expect(loadPlanes).toHaveBeenCalledWith(['blob:z0c0', 'blob:z0c1', 'blob:z0c2', 'blob:z0c3']);
    expect(loaded.descriptor).toBeNull();
    // load() only computes: the service state changes when plot() mounts it.
    expect((service as unknown as { simpleMultichannel: boolean }).simpleMultichannel).toBe(false);
  });

  it('load() simple stays single-image (NOT multichannel) for a plain grayscale image', async () => {
    const loadPlanes = jest.spyOn(
      service as unknown as { loadSimpleChannelPlanes(u: string[]): Promise<unknown[]> },
      'loadSimpleChannelPlanes',
    );
    const loaded = await service.load({
      fileName: 'g.png', tiled: false, isGrayscale: true,
      urls: ['blob:gray'], trueImageSize: [4, 4],
      imageMeta: [{ rgbChannels: 1, channelCount: 1, x: 4, y: 4, z: 1 }],
    } as any, 0);
    expect(loadPlanes).not.toHaveBeenCalled();
    expect(loaded.channelPlanes).toBeUndefined();
  });

  it('fetches a slice\'s channel planes in parallel, keeping channel order (OSD-PLOTLY-31)', async () => {
    const simpleStack = (service as any).simpleStack;
    const pending: Record<string, (u: string) => void> = {};
    jest.spyOn(simpleStack, 'fetchAsBlobUrl').mockImplementation(
      (u: unknown) => new Promise<string>((resolve) => { pending[u as string] = resolve; }),
    );
    const decode = jest.spyOn(service as any, 'decodeUrlToRgba').mockImplementation(async (u: unknown) =>
      ({ data: new Uint8ClampedArray([Number((u as string).slice(-1)), 0, 0, 255]), width: 1, height: 1 }));
    const run = (service as any).loadSimpleChannelPlanes(['c0', 'c1', 'c2']);
    await Promise.resolve();
    expect(Object.keys(pending)).toEqual(['c0', 'c1', 'c2']); // all requested up front
    pending['c2']('blob:2'); pending['c0']('blob:0'); pending['c1']('blob:1');
    const planes = await run;
    expect(planes.map((p: { data: Uint8ClampedArray }) => p.data[0])).toEqual([0, 1, 2]);
    decode.mockRestore();
  });

  /**
   * Regression: the initial fit-to-home must not depend on WHEN the render
   * started. If the container is still zero-size (diagram view mid-switch from
   * a folder view — e.g. "Load as Stack" with no image open), the timed goHome
   * retries all miss and preserveViewport leaves the image partial ("a tile").
   * fitWhenContainerSized fits the instant the container first gains a size,
   * then stops observing (jit-ui#106).
   */
  describe('fitWhenContainerSized (initial fit is layout-timing-independent)', () => {
    const call = (el: HTMLElement | null, refit: () => void) =>
      (service as unknown as {
        chrome: { fitWhenContainerSized: (e: HTMLElement | null, r: () => void) => void };
      }).chrome.fitWhenContainerSized(el, refit);

    let observers: Array<{ cb: () => void; observe: jest.Mock; disconnect: jest.Mock }>;
    let originalRO: unknown;

    const setSize = (el: HTMLElement, w: number, h: number) => {
      Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
    };

    beforeEach(() => {
      observers = [];
      originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe = jest.fn();
        disconnect = jest.fn();
        constructor(public cb: () => void) { observers.push(this as never); }
      };
    });
    afterEach(() => {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
    });

    it('does not observe when the container already has a size (timed refits handle it)', () => {
      const el = document.createElement('div');
      setSize(el, 800, 600);
      call(el, jest.fn());
      expect(observers.length).toBe(0);
    });

    it('fits once the container first gains a non-zero size, then disconnects', () => {
      const el = document.createElement('div'); // clientWidth/Height default to 0
      const refit = jest.fn();
      call(el, refit);

      expect(observers.length).toBe(1);
      expect(observers[0].observe).toHaveBeenCalledWith(el);

      // Observer fires while still zero-size → no fit yet.
      observers[0].cb();
      expect(refit).not.toHaveBeenCalled();

      // Container laid out → fit exactly once, and stop observing.
      setSize(el, 1024, 768);
      observers[0].cb();
      expect(refit).toHaveBeenCalledTimes(1);
      expect(observers[0].disconnect).toHaveBeenCalled();
    });

    it('no-ops without a container', () => {
      const refit = jest.fn();
      call(null, refit);
      expect(observers.length).toBe(0);
      expect(refit).not.toHaveBeenCalled();
    });
  });

  /**
   * Regression: a folder-stack slice is a downscaled server /preview, so OSD's
   * ImageTileSource world would be smaller than the full-res image and full-res
   * geojson ROIs render oversized. toFullResUrl upscales the preview to
   * trueImageSize so the world matches the ROI coordinate space (jit-ui#93).
   */
  describe('toFullResUrl (upscale preview so OSD world = full-res)', () => {
    const call = (u: string, w: number, h: number): Promise<string> =>
      (service as unknown as {
        toFullResUrl: (u: string, w: number, h: number) => Promise<string>;
      }).toFullResUrl(u, w, h);

    let createObjectURL: jest.SpyInstance;
    let toBlobSpy: jest.SpyInstance;

    // A real <img> (drawImage requires one) with a controllable natural size.
    const fakeImg = (w: number, h: number): HTMLImageElement => {
      const img = document.createElement('img');
      Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
      return img;
    };
    const stubDecode = (w: number, h: number) => {
      (service as unknown as { loadImageEl: (u: string) => Promise<unknown> }).loadImageEl =
        jest.fn().mockResolvedValue(fakeImg(w, h));
    };

    beforeEach(() => {
      createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:upscaled');
      // jsdom canvas toBlob may be absent — provide one that yields a Blob.
      toBlobSpy = jest
        .spyOn(HTMLCanvasElement.prototype, 'toBlob')
        .mockImplementation((cb: BlobCallback) => cb(new Blob(['x'])));
      stubDecode(512, 230); // preview smaller than full-res
    });
    afterEach(() => {
      createObjectURL.mockRestore();
      toBlobSpy.mockRestore();
    });

    it('upscales a downscaled preview to trueImageSize and caches the result', async () => {
      const out = await call('blob:preview', 1000, 450); // preview 512x230 < 1000x450
      expect(out).toBe('blob:upscaled');
      expect(createObjectURL).toHaveBeenCalledTimes(1);

      // Second call for the same preview reuses the cache (no re-upscale).
      const again = await call('blob:preview', 1000, 450);
      expect(again).toBe('blob:upscaled');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('returns the preview unchanged when it is already full-res', async () => {
      stubDecode(512, 512); // preview == full-res
      const out = await call('blob:preview', 512, 512);
      expect(out).toBe('blob:preview');
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('downscales a preview LARGER than full-res so the world matches ROI coords — jit-ui#93', async () => {
      // A /preview bigger than the dimensions /metadata reports would leave OSD's
      // world larger than the ROI coordinate space, rendering regions too small.
      // Resample DOWN to exactly trueImageSize so the world matches.
      stubDecode(2048, 2048); // preview larger than full-res
      const out = await call('blob:preview', 1000, 450);
      expect(out).toBe('blob:upscaled'); // resized (createObjectURL stub label)
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('returns the preview unchanged when the full-res dims are unknown', async () => {
      const out = await call('blob:preview', 0, 0);
      expect(out).toBe('blob:preview');
      expect(createObjectURL).not.toHaveBeenCalled();
    });
  });

  it('getHistogram returns null before any slice has been sampled', () => {
    expect(service.getHistogram(0, 256)).toBeNull();
  });

  it('getHistogram$ falls back to the (null) 8-bit client histogram without a descriptor', async () => {
    const h = await firstValueFrom(service.getHistogram$(0, 256));
    expect(h).toBeNull();
  });

  it('exportData is a no-op without a loaded image (no export HTTP request issued)', async () => {
    await service.exportData();
    http.expectNone((req) => req.url.includes('export'));
  });

  it('Plotly-only IVisualizer methods are safe no-ops on the unmounted service', () => {
    expect(() => {
      service.reloadAndPlot();
      service.setPlotType('heatmap' as any);
      service.setSurfaceDragMode('orbit');
      service.resetSurfaceCamera();
      service.setShowStack(true);
      service.resetAxes();
      service.autoscale();
      service.zoomIn();
      service.zoomOut();
      service.reset(); // destroyViewer with no viewer
    }).not.toThrow();
  });

  it('only the displayed slice\'s auto-window seeds the Intensity channel (OSD-PLOTLY-13)', () => {
    const store = TestBed.inject(VisualizerStore);
    store.setChannelStates([{ index: 0, name: 'Intensity', color: '#ffffff', min: 0, max: 255,
      gamma: 1, visible: true }]);
    const host = (service as any).sampler.host;
    (service as any).currentZ = 2;
    host.onGrayWindowSampled(10, 90, 5); // a background-preloaded slice
    expect(store.currentChannelStates()[0]).toMatchObject({ min: 0, max: 255 });
    host.onGrayWindowSampled(10, 90, 2);
    expect(store.currentChannelStates()[0]).toMatchObject({ min: 10, max: 90 });
  });

  // ── characterization ahead of the god-class split (review §6, proposal A) ──

  it('resizeNavigator sizes the minimap from the settled container and pins it to the corner', () => {
    const corner = document.createElement('div');
    const wrapper = document.createElement('div');
    const stray = document.createElement('div'); // anything else OSD left in the corner
    const navEl = document.createElement('div');
    const wrapperExtra = document.createElement('span');
    corner.append(wrapper, stray);
    wrapper.append(navEl, wrapperExtra);
    const nav = {
      element: navEl,
      setWidth: jest.fn((w: number) => { navEl.style.width = `${w}px`; }),
      setHeight: jest.fn((h: number) => { navEl.style.height = `${h}px`; }),
    };
    const svc = service as any;
    svc.viewer = { navigator: nav, element: { clientWidth: 1000, clientHeight: 500 }, destroy: () => undefined };
    svc.chrome.resizeNavigator();
    expect(nav.setWidth).toHaveBeenCalledWith(160);
    expect(nav.setHeight).toHaveBeenCalledWith(80);
    expect(wrapper.style).toMatchObject({ display: 'block', height: 'auto', width: 'auto' });
    expect(stray.style.display).toBe('none');
    expect(wrapperExtra.style.display).toBe('none');
    expect(corner.style).toMatchObject({ bottom: '12px', right: '12px' });
    expect(navEl.style).toMatchObject({ position: 'relative', margin: '0px' });
    // Already that size: not resized again.
    svc.chrome.resizeNavigator();
    expect(nav.setWidth).toHaveBeenCalledTimes(1);
    // A container without a size yet: left alone.
    svc.viewer.element = { clientWidth: 0, clientHeight: 0 };
    svc.chrome.resizeNavigator();
    expect(nav.setWidth).toHaveBeenCalledTimes(1);
  });

  describe('display-state subscription → invalidation', () => {
    const channel = { index: 0, name: 'c', color: '#ff0000', min: 5, max: 200, gamma: 1, visible: true };

    it('a channel change on a multichannel image reveals the slice, then schedules one invalidation', () => {
      const svc = service as any;
      svc.isMultiChannel = true;
      svc.currentZ = 3;
      const order: string[] = [];
      jest.spyOn(svc.cache, 'revealChannelSlice').mockImplementation((z: unknown) => { order.push(`reveal:${z}`); });
      jest.spyOn(svc, 'scheduleInvalidate').mockImplementation(() => { order.push('invalidate'); });
      TestBed.inject(VisualizerStore).setChannelStates([channel]);
      expect(order).toEqual(['reveal:3', 'invalidate']);
      expect(svc.channelStates).toEqual([channel]);
    });

    it('any other image only schedules the invalidation, with the LUT and invert picked up', () => {
      const svc = service as any;
      const reveal = jest.spyOn(svc.cache, 'revealChannelSlice');
      const schedule = jest.spyOn(svc, 'scheduleInvalidate').mockImplementation(() => undefined);
      TestBed.inject(VisualizerStore).setInvert(true);
      expect(reveal).not.toHaveBeenCalled();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(svc.invertBg).toBe(true);
      expect(Array.isArray(svc.colorLut)).toBe(true);
    });

    it('invalidateDisplay picks the round by image kind and supersedes the previous one', () => {
      const svc = service as any;
      const world = { requestInvalidate: jest.fn() };
      const navWorld = { requestInvalidate: jest.fn() };
      svc.viewer = { world, navigator: { world: navWorld }, destroy: () => undefined };
      const recomposite = jest.spyOn(svc, 'recompositeAndOpen').mockResolvedValue(undefined);
      const channelInvalidate = jest.spyOn(svc.cache, 'invalidateChannelDisplay').mockImplementation(() => undefined);
      svc.currentZ = 4;

      const before = svc.displayToken;
      svc.invalidateDisplay(); // composite / grayscale: the whole world + navigator
      expect(svc.displayToken).toBe(before + 1);
      expect(world.requestInvalidate).toHaveBeenCalledWith(true);
      expect(navWorld.requestInvalidate).toHaveBeenCalledWith(true);

      svc.isMultiChannel = true; // per-channel: only the visible slice's images
      svc.invalidateDisplay();
      expect(channelInvalidate).toHaveBeenCalledWith(4);
      expect(world.requestInvalidate).toHaveBeenCalledTimes(1);

      svc.simpleMultichannel = true; // serverless: re-composite the cached planes
      svc.invalidateDisplay();
      expect(recomposite).toHaveBeenCalledWith(svc.displayToken);
      expect(channelInvalidate).toHaveBeenCalledTimes(1);
    });
  });

  it('nudges the toolbar at most every 100 ms during an animation, looking it up once (OSD-PLOTLY-30)', () => {
    document.body.innerHTML =
      '<visualization><div class="toolbar-dock"></div><div id="osdplot"></div></visualization>';
    const svc = service as any;
    svc.plotDiv = 'osdplot';
    const dock = document.querySelector('.toolbar-dock') as HTMLElement;
    let reflows = 0;
    Object.defineProperty(dock, 'offsetHeight', { get: () => { reflows++; return 0; } });
    const lookup = jest.spyOn(document, 'getElementById');
    const now = jest.spyOn(performance, 'now').mockReturnValue(1000);
    svc.chrome.nudgeToolbarRepaint(true);
    svc.chrome.nudgeToolbarRepaint(true); // same frame burst
    now.mockReturnValue(1050);
    svc.chrome.nudgeToolbarRepaint(true);
    expect(reflows).toBe(1);
    now.mockReturnValue(1200);
    svc.chrome.nudgeToolbarRepaint(true);
    svc.chrome.nudgeToolbarRepaint(); // animation-finish: always
    expect(reflows).toBe(3);
    expect(lookup).toHaveBeenCalledTimes(1);
    now.mockRestore();
    lookup.mockRestore();
    document.body.innerHTML = '';
  });

  it('getCurrentImage resolves null (Plotly-only readback)', async () => {
    await expect(service.getCurrentImage()).resolves.toBeNull();
  });

  describe('downloadImage (current-view snapshot)', () => {
    beforeEach(() => (saveAs as unknown as jest.Mock).mockClear());

    it('no-ops without a viewer (nothing saved)', () => {
      expect(() => service.downloadImage()).not.toThrow();
      expect(saveAs).not.toHaveBeenCalled();
    });

    it('saves the rendered OSD canvas as <stem>.png', () => {
      const blob = {} as Blob;
      const canvas = { width: 120, height: 90, toBlob: (cb: (b: Blob) => void) => cb(blob) };
      // Stand in a minimal viewer exposing the drawer canvas; destroy() lets the
      // afterEach teardown (unsubscribe → destroyViewer) run cleanly.
      (service as any).viewer = { drawer: { canvas }, destroy: jest.fn() };
      (service as any).currentFileName = 'sample.tif';

      service.downloadImage();

      expect(saveAs).toHaveBeenCalledWith(blob, 'sample.png');
    });
  });

  it('capability-gated 3D controls are null (OSD renders the image type only)', () => {
    expect(service.getSurface3dControls()).toBeNull();
    expect(service.getIsosurfaceControls()).toBeNull();
  });

  it('getRegionOverlay is null until a viewer is mounted', () => {
    expect(service.getRegionOverlay()).toBeNull();
  });

  it('getTrueImageSize is null before any descriptor is loaded', () => {
    expect(service.getTrueImageSize()).toBeNull();
  });

  // ── display-invalidation race (white-canvas regression guard) ──────────
  // A window/gamma slider emits continuously while dragged. Each invalidation
  // restores and re-processes every tile, and a recolor round that writes back
  // AFTER a newer round restored the tile makes OSD's conversion throw
  // DOMException — which destroys the cache record and unloads the tile, so the
  // viewer goes white mid-drag. These pin both halves of the fix.

  it('coalesces a burst of display changes into ONE invalidation', async () => {
    const svc = service as any;
    const invalidate = jest.spyOn(svc, 'invalidateDisplay');
    for (let i = 0; i < 10; i++) svc.scheduleInvalidate(); // a drag's worth of emissions
    expect(invalidate).not.toHaveBeenCalled(); // deferred, not synchronous
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('a superseded recolor round does not write back (would destroy the cache record)', async () => {
    const svc = service as any;
    svc.isMultiChannel = true;
    svc.channelStates = [{ index: 0, name: 'c', color: '#ff0000', min: 0, max: 255, gamma: 1, visible: true }];

    const ctx = {
      canvas: { width: 1, height: 1 },
      getImageData: () => ({ data: new Uint8ClampedArray([10, 10, 10, 255]) }),
      putImageData: jest.fn(),
    };
    const setData = jest.fn();
    const event = {
      tile: { url: 'https://example/tile?channel=0' },
      // A newer display round lands while this one is awaiting its pixels —
      // exactly what the next tick of a slider drag does.
      getData: jest.fn(async (type: string) => {
        if (type === 'context2d') { svc.displayToken++; return ctx; }
        return null;
      }),
      setData,
    };

    await svc.recolorChannelTile(event);

    expect(setData).not.toHaveBeenCalled();
    expect(ctx.putImageData).not.toHaveBeenCalled();
  });

  it('an uncontested recolor round still writes back', async () => {
    const svc = service as any;
    svc.isMultiChannel = true;
    svc.channelStates = [{ index: 0, name: 'c', color: '#ff0000', min: 0, max: 255, gamma: 1, visible: true }];

    const ctx = {
      canvas: { width: 1, height: 1 },
      getImageData: () => ({ data: new Uint8ClampedArray([10, 10, 10, 255]) }),
      putImageData: jest.fn(),
    };
    const setData = jest.fn();
    await svc.recolorChannelTile({
      tile: { url: 'https://example/tile?channel=0' },
      getData: jest.fn(async (type: string) => (type === 'context2d' ? ctx : null)),
      setData,
    });

    expect(ctx.putImageData).toHaveBeenCalled();
    expect(setData).toHaveBeenCalledWith(ctx, 'context2d');
  });
});

/**
 * The composite PNG export must match the on-screen image (review OSD-PLOTLY-9):
 * a multichannel image is drawn from per-channel tiles, so the export fetches
 * each visible channel and merges them like the viewer does.
 */
describe('OpenSeadragonVisualizerService — exportComposite', () => {
  let service: OpenSeadragonVisualizerService;
  let http: HttpTestingController;
  let fetchBitmap: jest.SpyInstance;
  let getContext: jest.SpyInstance;
  let put: jest.Mock;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [OpenSeadragonVisualizerService, ...VIZ_PORT_STUBS],
    });
    service = TestBed.inject(OpenSeadragonVisualizerService);
    http = TestBed.inject(HttpTestingController);
    // One 1x1 level; each fetched tile is a bitmap tagged with its channel value.
    fetchBitmap = jest.spyOn(tileClient, 'fetchTileBitmap').mockImplementation(async (_h, url: string) => {
      const m = /channel=(\d+)/.exec(url);
      return { v: m ? 10 * (Number(m[1]) + 1) : 99, close: () => undefined } as unknown as ImageBitmap;
    });
    let pixel = new Uint8ClampedArray(4);
    put = jest.fn();
    const ctx = {
      clearRect: () => { pixel = new Uint8ClampedArray(4); },
      drawImage: (bmp: { v: number }) => { pixel = new Uint8ClampedArray([bmp.v, bmp.v, bmp.v, 255]); },
      getImageData: () => ({ data: new Uint8ClampedArray(pixel), width: 1, height: 1 }),
      putImageData: put,
    };
    getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['x'])));
    const s = service as any;
    s.descriptor = { width: 1, height: 1, tileSize: 256, z: 1, channels: 3, realLevels: 1,
      levels: [{ res: 0, width: 1, height: 1 }] };
    s.infoB64 = 'INFO64';
    s.realLevels = 1;
    s.currentFileName = 'multi.tif';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    service.unsubscribe();
    http.match(() => true);
  });

  it('merges each visible channel\'s tiles with its tint for a multichannel image', async () => {
    const s = service as any;
    s.isMultiChannel = true;
    s.channelStates = [
      { index: 0, name: 'a', color: '#ff0000', min: 0, max: 255, gamma: 1, visible: true },
      { index: 1, name: 'b', color: '#00ff00', min: 0, max: 255, gamma: 1, visible: false },
      { index: 2, name: 'c', color: '#0000ff', min: 0, max: 255, gamma: 1, visible: true },
    ];
    await service.exportComposite();
    const urls = fetchBitmap.mock.calls.map(([, url]) => url as string);
    expect(urls.some((u) => u.includes('channel=0'))).toBe(true);
    expect(urls.some((u) => u.includes('channel=1'))).toBe(false); // hidden
    expect(urls.some((u) => u.includes('channel=2'))).toBe(true);
    expect(urls.some((u) => !u.includes('channel='))).toBe(false); // no server composite
    const written = put.mock.calls[put.mock.calls.length - 1][0].data;
    expect(Array.from(written)).toEqual([10, 0, 30, 255]);
    expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'multi_composite.png');
    expect(getContext).toHaveBeenCalled();
  });

  it('exports the server-composited tiles through the RGB/grayscale pipeline otherwise', async () => {
    await service.exportComposite();
    const urls = fetchBitmap.mock.calls.map(([, url]) => url as string);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain('channel=');
  });
});

describe('OpenSeadragonVisualizerService (tiled load via /tiles/info)', () => {
  const BIG_SVS = { fileName: 'big.svs' } as Parameters<OpenSeadragonVisualizerService['load']>[0];
  let service: OpenSeadragonVisualizerService;
  let http: HttpTestingController;

  const descriptor = {
    width: 1024, height: 768, tileSize: 256, z: 1, channels: 1, realLevels: 1,
    levels: [{ res: 0, width: 1024, height: 768 }],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        OpenSeadragonVisualizerService,
        ...VIZ_PORT_STUBS,
        // Override the tile-access stub so a "file is selected" — drives the
        // server tile path instead of the no-image early return.
        {
          provide: TILE_ACCESS_PORT,
          useValue: {
            getSelectedInfoB64: () => 'INFO64',
            getAuthHeaders: () => Promise.resolve({ Authorization: 'Bearer t' }),
            zoomOnRegion: () => EMPTY,
            selectDiagramDisplay: () => undefined,
          },
        },
      ],
    });
    service = TestBed.inject(OpenSeadragonVisualizerService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    service.unsubscribe();
    http.match((req) => req.url.includes('colormap-luts')).forEach((r) => r.flush({}));
    http.verify();
  });

  it('polls GET /tiles/info with the selected file info and returns the descriptor', async () => {
    const pending = service.load({ fileName: 'big.svs' } as any, 2);
    // load() awaits getAuthHeaders() before issuing the request — let that
    // microtask settle so the /tiles/info GET is registered.
    await new Promise((r) => setTimeout(r, 0));
    const req = http.expectOne((r) => r.url.includes('tiles/info') && r.url.includes('INFO64'));
    expect(req.request.method).toBe('GET');
    req.flush(descriptor);

    const loaded = await pending;
    expect(loaded.descriptor).toEqual(descriptor);
    expect(loaded.infoB64).toBe('INFO64');
    expect(loaded.z).toBe(2);
    expect(loaded.simple).toBeUndefined(); // tiled path, not simple-image
  });

  it('fails the load at once when /tiles/info answers neither 200 nor 202 (shared poll semantics)', async () => {
    // The OSD poll used to retry every error status until its 10-minute deadline,
    // so a server without /tiles/info held the render (and the Plotly fallback)
    // that long. It now shares napari-js's poll: only 202 is re-polled.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = service.load(BIG_SVS, 0);
    await new Promise((r) => setTimeout(r, 0));
    http.expectOne((r) => r.url.includes('tiles/info')).flush(null, { status: 404, statusText: 'Not Found' });
    await expect(pending).rejects.toThrow(/no descriptor/);
    warn.mockRestore();
  });

  it('cancels the /tiles/info poll and rejects with an AbortError when the load is aborted', async () => {
    const ctl = new AbortController();
    const pending = service.load(BIG_SVS, 0, ctl.signal);
    await new Promise((r) => setTimeout(r, 0));
    const req = http.expectOne((r) => r.url.includes('tiles/info'));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(req.cancelled).toBe(true);
  });

  it('rejects an already-aborted load without polling', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(service.load(BIG_SVS, 0, ctl.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    http.expectNone((r) => r.url.includes('tiles/info'));
  });
});

/**
 * The viewport a contributed plot mode draws over (PlotModeViewport). A real
 * viewer needs a canvas, so a minimal fake stands in for OpenSeadragon: an
 * empty world (the viewport-direct conversion path) and a linear image<->element
 * map.
 */
describe('OpenSeadragonVisualizerService — plot-mode viewport', () => {
  let service: OpenSeadragonVisualizerService;
  let http: HttpTestingController;

  function fakeViewer(zoom = 0.5, bounds = { x: 100, y: 50, width: 400, height: 300 }) {
    return {
      canvas: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
      world: { getItemCount: () => 1, getItemAt: () => null },
      viewport: {
        getBounds: () => bounds,
        viewportToImageRectangle: (r: any) => r,
        imageToViewerElementCoordinates: (p: any) => ({ x: p.x * zoom, y: p.y * zoom }),
        viewerElementToImageCoordinates: (p: any) => ({ x: p.x / zoom, y: p.y / zoom }),
      },
    };
  }

  function mountFake(viewer: any) {
    const s = service as any;
    s.viewer = viewer;
    s.descriptor = { width: 1000, height: 800 };
    s.coordTransform = new OsdCoordinateTransform(viewer);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [OpenSeadragonVisualizerService, ...VIZ_PORT_STUBS],
    });
    service = TestBed.inject(OpenSeadragonVisualizerService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    (service as any).viewer = null;
    (service as any).coordTransform = null;
    service.unsubscribe();
    http.match(() => true).forEach((r) => r.flush({}));
    jest.useRealTimers();
  });

  it('is one stable object that reports not-ready (and NaN, not a throw) with no viewer', () => {
    const vp = service.getPlotModeViewport();
    expect(service.getPlotModeViewport()).toBe(vp);
    expect(vp.isReady()).toBe(false);
    expect(vp.dataToClient(1, 2)).toEqual({ x: NaN, y: NaN });
    expect(vp.clientToData(1, 2)).toEqual({ x: NaN, y: NaN });
    expect(vp.dataLengthToScreen(10)).toBeNaN();
  });

  it('converts through the current viewer once one is mounted, both ways', () => {
    const vp = service.getPlotModeViewport();
    mountFake(fakeViewer(0.5));
    expect(vp.isReady()).toBe(true);
    const c = vp.dataToClient(200, 100);
    expect(c).toEqual({ x: 110, y: 70 }); // (200*.5+10, 100*.5+20)
    expect(vp.clientToData(c.x, c.y)).toEqual({ x: 200, y: 100 });
    expect(vp.dataLengthToScreen(10)).toBe(5);
  });

  it('fitBounds fits the view to an image rect (through world item 0), animated unless immediately', () => {
    const vp = service.getPlotModeViewport();
    vp.fitBounds!({ x: 1, y: 2, width: 3, height: 4 }); // not ready: a no-op, not a throw
    const fits: Array<[any, boolean]> = [];
    const viewer: any = fakeViewer();
    viewer.world.getItemAt = () => ({ imageToViewportRectangle: (r: any) => ({ ...r, via: 'item' }) });
    viewer.viewport.fitBoundsWithConstraints = (r: any, immediately: boolean) => fits.push([r, immediately]);
    mountFake(viewer);
    vp.fitBounds!({ x: 100, y: 200, width: 300, height: 400 });
    vp.fitBounds!({ x: 5, y: 6, width: 7, height: 8 }, { immediately: true });
    vp.fitBounds!({ x: 0, y: 0, width: 0, height: 10 }); // empty: ignored
    expect(fits).toEqual([
      [expect.objectContaining({ x: 100, y: 200, width: 300, height: 400, via: 'item' }), false],
      [expect.objectContaining({ x: 5, y: 6, width: 7, height: 8, via: 'item' }), true],
    ]);
  });

  it('frame$ emits the visible image rect once per animation frame, however many redraws', () => {
    const vp = service.getPlotModeViewport();
    mountFake(fakeViewer());
    const seen: any[] = [];
    const sub = vp.frame$.subscribe((r) => seen.push(r));
    const s = service as any;
    const rect = { x: 100, y: 50, width: 400, height: 300 };
    expect(seen).toEqual([rect]); // the current rect, on subscribe
    s.viewport.scheduleFrame();
    s.viewport.scheduleFrame();
    s.viewport.scheduleFrame();
    expect(seen).toHaveLength(1);
    jest.advanceTimersByTime(20);
    expect(seen).toEqual([rect, rect]);
    s.viewport.scheduleFrame();
    jest.advanceTimersByTime(20);
    expect(seen).toHaveLength(3);
    sub.unsubscribe();
  });

  it('frame$ does no work while nothing listens', () => {
    mountFake(fakeViewer());
    const raf = jest.spyOn(window, 'requestAnimationFrame');
    (service as any).viewport.scheduleFrame();
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('frame$ clamps the rect to the image, like settled$', () => {
    const vp = service.getPlotModeViewport();
    mountFake(fakeViewer(1, { x: -50, y: 700, width: 2000, height: 500 }));
    const frames: any[] = [];
    const settled: any[] = [];
    vp.frame$.subscribe((r) => frames.push(r));
    vp.settled$.subscribe((r) => settled.push(r));
    (service as any).viewport.scheduleFrame();
    jest.advanceTimersByTime(20);
    (service as any).viewport.emitViewportChange();
    const clamped = { x: 0, y: 700, width: 1000, height: 100 };
    expect(frames).toEqual([clamped, clamped]); // initial + one frame
    expect(settled).toEqual([clamped, clamped]); // initial + one settle
  });

  it('a subscriber arriving after the viewport went idle gets the current rect without another event', () => {
    const vp = service.getPlotModeViewport();
    mountFake(fakeViewer());
    const frames: any[] = [];
    const settled: any[] = [];
    vp.frame$.subscribe((r) => frames.push(r));
    vp.settled$.subscribe((r) => settled.push(r));
    expect(frames).toEqual([{ x: 100, y: 50, width: 400, height: 300 }]);
    expect(settled).toEqual(frames);
  });

  it('gives no initial rect before a viewer is mounted', () => {
    const vp = service.getPlotModeViewport();
    const seen: any[] = [];
    vp.frame$.subscribe((r) => seen.push(r));
    vp.settled$.subscribe((r) => seen.push(r));
    expect(seen).toEqual([]);
  });
});
