import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';

import { OpenSeadragonVisualizerService } from './openseadragon-visualizer.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';

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
