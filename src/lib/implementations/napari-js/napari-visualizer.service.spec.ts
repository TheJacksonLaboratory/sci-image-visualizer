import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { firstValueFrom, of } from 'rxjs';

import { NapariVisualizerService } from './napari-visualizer.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { VIZ_CONFIG } from '../../contracts/viz-config';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { PlotType } from '../../contracts/plot-type';
import { ViewerFeature } from '../../contracts/capabilities.contract';
import { IImageInfo } from '../../contracts/image.contract';

const imageInfo = (over: Partial<IImageInfo> = {}): IImageInfo =>
  ({ urls: ['u0'], tiled: true, isStack: false, ...over }) as unknown as IImageInfo;

const tilesPort = {
  getSelectedInfoB64: () => 'INFO',
  zoomOnRegion: () => of(new ArrayBuffer(0)),
  selectDiagramDisplay: () => undefined,
  getAuthHeaders: () => Promise.resolve<Record<string, string>>({}),
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('NapariVisualizerService', () => {
  let service: NapariVisualizerService;
  let http: HttpTestingController;
  let regionStore: RegionStore;
  let store: VisualizerStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        NapariVisualizerService,
        VisualizerStore,
        RegionStore,
        { provide: TILE_ACCESS_PORT, useValue: tilesPort },
        { provide: VIZ_CONFIG, useValue: { slideCropServer: 'http://srv/' } },
      ],
    });
    service = TestBed.inject(NapariVisualizerService);
    http = TestBed.inject(HttpTestingController);
    regionStore = TestBed.inject(RegionStore);
    store = TestBed.inject(VisualizerStore);
    // VisualizerStore fetches its colormap LUTs on construction — satisfy it here.
    http.expectOne('assets/plotting/colormap-luts.json').flush({});
  });

  afterEach(() => http.verify());

  /** Drive a tiled load() through the awaited auth-headers microtask + flush /tiles/info. */
  async function loadTiled(width = 512, height = 512): Promise<unknown> {
    const pending = service.load(imageInfo(), 0);
    await tick();
    http.expectOne((r) => r.url.includes('tiles/info')).flush({
      width,
      height,
      tileSize: 256,
      z: 1,
      channels: 4,
      levels: [{ res: 0, width, height }],
    });
    return pending;
  }

  it('constructs and advertises image-display capabilities', () => {
    expect(service).toBeTruthy();
    expect(service.capabilities.has(ViewerFeature.ImageDisplay)).toBe(true);
    expect(service.getPlotTypeDescriptors().map((d) => d.type)).toEqual([PlotType.IMAGE]);
  });

  it('load() fetches /tiles/info for a tiled image', async () => {
    const loaded = (await loadTiled(1024, 1024)) as { kind: string };
    expect(loaded.kind).toBe('tiled');
    expect(service.getTrueImageSize()).toEqual({ width: 1024, height: 1024 });
  });

  it('load() takes the simple path for non-tiled images (no HTTP)', async () => {
    const loaded = await service.load(imageInfo({ tiled: false }), 0);
    expect(loaded.kind).toBe('simple');
    expect(loaded.url).toBe('u0');
  });

  it('delegates region operations to the shared RegionStore', () => {
    const set = jest.spyOn(regionStore, 'setRegions');
    service.setRegions([], true, false, '#fff', false);
    expect(set).toHaveBeenCalled();
    expect(Array.isArray(service.getRegions())).toBe(true);
    expect(() => {
      service.undo();
      service.redo();
      service.resetUndoHistory();
    }).not.toThrow();
    expect(typeof service.canUndo()).toBe('boolean');
  });

  it('delegates display options to the shared VisualizerStore', async () => {
    const setCm = jest.spyOn(store, 'setColormap');
    service.setColormap({ label: 'gray' } as never);
    expect(setCm).toHaveBeenCalled();
    service.setReverseScale(true);
    service.setImageMeta([]);
    expect(await firstValueFrom(service.getReverseScale())).toBe(true);
  });

  it('tool controls are safe no-ops in the POC backend', async () => {
    expect(() => {
      service.setWandMode(true);
      service.setBrushMode(false);
      service.setVertexEraserMode(true);
      service.setZoomToBoxMode(false);
      service.setSamPointMode(true);
      service.clearSamPoints();
    }).not.toThrow();
    expect(await service.segmentRectangles()).toBe(0);
    expect(await service.segmentRectanglesCellpose()).toBe(0);
  });

  it('capability-gated controls return null and 3D/intensity are stubbed', () => {
    expect(service.getIsosurfaceControls()).toBeNull();
    expect(service.getIntensityControls()).toBeNull();
    expect(service.getSurface3dControls()).toBeNull();
    expect(service.getRegionOverlay()).toBeNull();
    expect(service.getHistogram(0, 256)).toBeNull();
  });

  it('mounts a viewer and reports a displayed source rect on plot()', async () => {
    const div = document.createElement('div');
    div.id = 'plot-host';
    document.body.appendChild(div);

    const loaded = await loadTiled(512, 512);

    const ok = await service.plot('plot-host', loaded, imageInfo(), 600, PlotType.IMAGE);
    expect(ok).toBe(true);
    service.zoomIn();
    service.zoomOut();
    service.setZIndex(0);
    expect(service.getDisplayedSourceRect()).not.toBeNull();
    expect(service.getTrueImageSize()).toEqual({ width: 512, height: 512 });
    service.unsubscribe();
    document.body.removeChild(div);
  });
});
