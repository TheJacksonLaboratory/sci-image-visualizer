import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';

import { OpenSeadragonVisualizerService } from './openseadragon-visualizer.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';

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

  it('getRegionOverlay is null until a viewer is mounted', () => {
    expect(service.getRegionOverlay()).toBeNull();
  });

  it('getTrueImageSize is null before any descriptor is loaded', () => {
    expect(service.getTrueImageSize()).toBeNull();
  });
});
