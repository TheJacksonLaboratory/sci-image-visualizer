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
  ({ urls: ['u0', 'u1'], isGrayscale: true, isStack: true, ...over }) as unknown as IImageInfo;

const tilesPort = {
  getSelectedInfoB64: () => 'INFO',
  zoomOnRegion: () => of(new ArrayBuffer(0)),
  selectDiagramDisplay: () => undefined,
  getAuthHeaders: () => Promise.resolve<Record<string, string>>({}),
};

describe('NapariVisualizerService', () => {
  let service: NapariVisualizerService;
  let http: HttpTestingController;
  let regionStore: RegionStore;
  let store: VisualizerStore;

  beforeEach(() => {
    // The render path polls /tiles/info (descriptor JSON) then fetches /tile blobs, both via the
    // global fetch (no WebGPU). A single-level 64×48 pyramid keeps the stitch on the single-tile
    // path. createImageBitmap is stubbed since jsdom can't decode.
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('tiles/info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              width: 64,
              height: 48,
              tileSize: 512,
              z: 1,
              channels: 1,
              realLevels: 1,
              levels: [{ res: 0, width: 64, height: 48 }],
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob()) });
    });
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = jest
      .fn()
      .mockResolvedValue({ width: 64, height: 48, close: () => undefined });

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

  it('advertises image + 3D capabilities and the napari plot types', () => {
    expect(service).toBeTruthy();
    expect(service.capabilities.has(ViewerFeature.ImageDisplay)).toBe(true);
    expect(service.capabilities.has(ViewerFeature.Surface3D)).toBe(true);
    expect(service.capabilities.has(ViewerFeature.Isosurface)).toBe(true);
    expect(service.getPlotTypeDescriptors().map((d) => d.type)).toEqual([
      PlotType.NAPARI_IMAGE,
      PlotType.NAPARI_VOLUME,
      PlotType.NAPARI_ISOSURFACE,
    ]);
  });

  it('load() returns an opaque handle without fetching', async () => {
    const loaded = await service.load(imageInfo(), 1);
    expect(loaded.z).toBe(1);
    expect(loaded.imageInfo.urls.length).toBe(2);
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

  it('exposes no 3D controls until a volume is mounted', () => {
    expect(service.getSurface3dControls()).toBeNull();
    expect(service.getIsosurfaceControls()).toBeNull();
    expect(service.getIntensityControls()).toBeNull();
    expect(service.getRegionOverlay()).toBeNull();
    expect(service.getHistogram(0, 256)).toBeNull();
  });

  it('renders a 2D image from urls[z] on plot()', async () => {
    const div = document.createElement('div');
    div.id = 'plot-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('plot-host', loaded, imageInfo(), 600, PlotType.NAPARI_IMAGE);
    expect(ok).toBe(true);
    expect(service.getTrueImageSize()).toEqual({ width: 64, height: 48 });
    service.zoomIn();
    service.zoomOut();
    expect(service.getDisplayedSourceRect()).not.toBeNull();
    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('plot() returns false when the target element is missing', async () => {
    const loaded = await service.load(imageInfo(), 0);
    expect(await service.plot('nope', loaded, imageInfo(), 600, PlotType.NAPARI_IMAGE)).toBe(false);
  });
});
