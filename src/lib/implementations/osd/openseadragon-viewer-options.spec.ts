import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { OpenSeadragonVisualizerService } from './openseadragon-visualizer.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { PlotType } from '../../contracts/plot-type';
import { OSD_ZOOM_PER_SCROLL } from './osd-zoom';

/**
 * Viewer-option coverage.
 *
 * Tuning options like `minPixelRatio` are OpenSeadragon config keys, not library
 * code: they appear exactly once, nothing in the library reads them, and OSD
 * silently falls back to its own default if a key is misspelled or renamed
 * upstream. That makes them invisible to every other test and to grep. This spec
 * captures the options object actually handed to the OSD factory and asserts the
 * ones whose values we depend on.
 *
 * Mounting a real viewer needs a live DOM + canvas, so `./osd-lib` (the single
 * place the real OpenSeadragon is normalized) is mocked: the factory records its
 * options and then throws a sentinel. Throwing is deliberate - it stops before
 * the ~60 lines of post-construction wiring, so the test does not have to
 * simulate a viewer and cannot rot as that wiring changes. The options were
 * already captured by then, which is the whole claim under test.
 */
const capturedOptions: any[] = [];
const SENTINEL = 'stop-after-viewer-options';

jest.mock('./osd-lib', () => {
  const factory: any = jest.fn((options: any) => {
    capturedOptions.push(options);
    throw new Error(SENTINEL);
  });
  // Statics touched on the way to the factory call: buildTileSource constructs a
  // TileSource and reads Point; the advisory silencer assigns to OSD.console.
  factory.TileSource = function TileSource(this: any, spec: any) {
    Object.assign(this, spec);
  };
  factory.Point = function Point(this: any, x: number, y: number) {
    this.x = x;
    this.y = y;
  };
  return { OSD: factory };
});

describe('OpenSeadragonVisualizerService — viewer options', () => {
  let service: OpenSeadragonVisualizerService;
  let http: HttpTestingController;

  const descriptor = {
    width: 1024,
    height: 768,
    tileSize: 256,
    z: 1,
    channels: 1,
    realLevels: 1,
    levels: [{ res: 0, width: 1024, height: 768 }],
  };

  beforeEach(() => {
    capturedOptions.length = 0;
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        OpenSeadragonVisualizerService,
        ...VIZ_PORT_STUBS,
        {
          provide: TILE_ACCESS_PORT,
          useValue: {
            getSelectedInfoB64: () => 'INFO64',
            getAuthHeaders: () => Promise.resolve({ Authorization: 'Bearer t' }),
            zoomOnRegion: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
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
    // Drain without flushing: some of these are blob/arraybuffer requests and
    // flushing a plain object into them throws in Angular's _toBlob. verify() is
    // deliberately not called - this spec is about the options object, not about
    // pinning which requests plot() happens to fire.
    http.match(() => true);
  });

  /** Drive plot() far enough to construct the viewer, swallowing the sentinel. */
  function optionsFromPlot(): any {
    const loaded = { descriptor, infoB64: 'INFO64', z: 0, filename: 'flat.tif' };
    const imageInfo: any = {
      fileName: 'flat.tif',
      urls: ['/api/preview?info=INFO64'],
      isStack: false,
      showStack: false,
      isGrayscale: false,
      trueImageSize: [1024, 768],
      imageMeta: [{ x: 1024, y: 768, z: 1, rgbChannels: 3, channelCount: 3 }],
    };
    document.body.innerHTML = '<div id="plotdiv"></div>';
    try {
      service.plot('plotdiv', loaded, imageInfo, 500, PlotType.IMAGE);
    } catch (e: any) {
      if (!String(e?.message).includes(SENTINEL)) throw e;
    }
    expect(capturedOptions.length).toBe(1); // the factory was reached
    return capturedOptions[0];
  }

  it('passes minPixelRatio=0.5 — raising it selects COARSER levels, not finer', () => {
    // This assertion previously pinned 1, on the mistaken reading that
    // minPixelRatio meant "minimum sharpness". It is the opposite: in
    // TiledImage._getLevelsInterval it DIVIDES into the ratio -
    //   highestLevel = floor( log2( currentZeroRatio / minPixelRatio ) )
    // - so a larger value yields a lower (coarser) level. Measured on a flat
    // 22304x24528 image, 1 left every zoom below native upscaled ~1.34x (1.86x
    // at 1:1), while 0.5 never upscaled and reached full resolution at 1:1.
    //
    // Guarding the exact value, not just "not 1": 0.25 is finer still but jumps
    // two rungs and fetches ~4x the tiles for no visible gain, and the ingress
    // does not cache tiles, so every viewer pays that.
    expect(optionsFromPlot().minPixelRatio).toBe(0.5);
  });

  it('keeps the zoom limits that let the user inspect individual pixels', () => {
    // Past 1:1 the blocks are genuine source pixels, so maxZoomPixelRatio must
    // stay well above OSD's default 1.1 (jit-ui#94).
    const o = optionsFromPlot();
    expect(o.maxZoomPixelRatio).toBe(20);
    expect(o.minZoomImageRatio).toBe(0.01);
  });

  it('scrolls at the step the region overlay also uses', () => {
    // The wheel is handled by OSD or by the overlay depending on whether a region
    // tool is active. If these two drift apart, the zoom changes pace the moment a
    // tool is picked up — which is why the value is one shared constant rather
    // than a number written in both places, as it was.
    expect(optionsFromPlot().zoomPerScroll).toBe(OSD_ZOOM_PER_SCROLL);
  });

  it('scrolls gently enough that a trackpad burst does not fly', () => {
    // The step applies per scroll EVENT, and a trackpad swipe is a burst of them,
    // so this compounds: at OSD's default 1.2 a 20-event swipe is 38x. Pinned as a
    // ceiling rather than an exact value so the number stays tunable.
    expect(OSD_ZOOM_PER_SCROLL).toBeGreaterThan(1);
    expect(OSD_ZOOM_PER_SCROLL).toBeLessThanOrEqual(1.05);
    // ~24 notches to double, which is where the napari-js backend sits for the
    // same image — the wheel should not depend on which renderer is active.
    const notchesToDouble = Math.log(2) / Math.log(OSD_ZOOM_PER_SCROLL);
    expect(notchesToDouble).toBeGreaterThan(15);
  });
});
