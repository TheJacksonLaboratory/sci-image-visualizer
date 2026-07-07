import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { EMPTY, firstValueFrom } from 'rxjs';

import { OpenSeadragonVisualizerService } from './openseadragon-visualizer.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { saveAs } from 'file-saver';

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
        fitWhenContainerSized: (e: HTMLElement | null, r: () => void) => void;
      }).fitWhenContainerSized(el, refit);

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
});

describe('OpenSeadragonVisualizerService (tiled load via /tiles/info)', () => {
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
});
