import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';

import { Viewer } from 'napari-js';

import { NapariVisualizerService } from './napari-visualizer.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { VIZ_CONFIG } from '../../contracts/viz-config';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { SPATIAL_3D_MAX_CATEGORIES } from '../spatial/spatial-encoding';
import * as expressionModule from '../spatial/spatial-expression';
import { PlotType } from '../../contracts/plot-type';
import { ViewerFeature } from '../../contracts/capabilities.contract';
import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { SPATIAL_DATA_PORT } from '../../contracts/ports/spatial-data.port';
import {
  CategoricalColumn, ContinuousColumn, SpatialDataset,
} from '../../contracts/spatial-dataset.contract';
import { DEFAULT_MUTED_OPACITY } from '../spatial/spatial-encoding';
import { SpatialSelectionStore } from '../../store/spatial-selection.service';

const imageInfo = (over: Partial<IImageInfo> = {}): IImageInfo =>
  ({ urls: ['u0', 'u1'], isGrayscale: true, isStack: true, ...over }) as unknown as IImageInfo;

/** A spatial dataset with `count` observations on a diagonal, 27.5 px spot radius. */
const spatialDataset = (count = 3): SpatialDataset => ({
  id: 'demo', name: 'Demo',
  observations: {
    count,
    x: Float32Array.from({ length: count }, (_, i) => i * 10),
    y: Float32Array.from({ length: count }, (_, i) => i * 20),
    radius: 27.5,
  },
  columns: [
    { kind: 'categorical', name: 'region', categories: ['A', 'B'], colors: ['#ff0000', '#0000ff'] },
    { kind: 'continuous', name: 'total_counts', logScaleHint: true },
  ],
  features: { count: 1, names: ['Ttr'] },
});

/** The same dataset with a z, so it can be drawn as a cloud. */
const spatialDataset3d = (count = 3): SpatialDataset => {
  const base = spatialDataset(count);
  return {
    ...base,
    observations: {
      ...base.observations,
      z: Float32Array.from({ length: count }, (_, i) => i * 30),
    },
  };
};

/** The 3D dataset plus a reference volume, for the anatomy-backdrop path. */
const spatialDatasetVolume = (count = 3): SpatialDataset => ({
  ...spatialDataset3d(count),
  volume: { width: 4, height: 6, depth: 10, voxelSize: [100, 200, 400] },
});

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
  let dataset$: BehaviorSubject<SpatialDataset | null>;
  let spatialPort: {
    getDataset$: () => typeof dataset$;
    getColumn: jest.Mock;
    getFeatureVector: jest.Mock;
    getVolume: jest.Mock;
  };

  beforeEach(() => {
    dataset$ = new BehaviorSubject<SpatialDataset | null>(null);
    spatialPort = {
      getDataset$: () => dataset$,
      getColumn: jest.fn(),
      getFeatureVector: jest.fn(),
      // Rejects by default: a dataset with no volume must never be waiting on one.
      getVolume: jest.fn().mockRejectedValue(new Error('no volume')),
    };
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

    // jsdom has no canvas 2d context — the channel readback (drawImage + getImageData) needs one.
    jest
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(
        () =>
          ({
            drawImage: () => undefined,
            clearRect: () => undefined,
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4),
            }),
          }) as unknown as CanvasRenderingContext2D,
      );

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        NapariVisualizerService,
        VisualizerStore,
        RegionStore,
        { provide: TILE_ACCESS_PORT, useValue: tilesPort },
        { provide: VIZ_CONFIG, useValue: { slideCropServer: 'http://srv/' } },
        { provide: SPATIAL_DATA_PORT, useValue: spatialPort },
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
  // Restore prototype spies (addSurface/addVolume/addAxes/…) between tests so a spy from one test
  // doesn't leak its accumulated `.mock.results` into another (beforeEach re-establishes the base
  // fetch/canvas mocks).
  afterEach(() => jest.restoreAllMocks());

  it('advertises image + 3D capabilities and the napari plot types', () => {
    expect(service).toBeTruthy();
    expect(service.capabilities.has(ViewerFeature.ImageDisplay)).toBe(true);
    expect(service.capabilities.has(ViewerFeature.Surface3D)).toBe(true);
    expect(service.capabilities.has(ViewerFeature.Isosurface)).toBe(true);
    expect(service.getPlotTypeDescriptors().map((d) => d.type)).toEqual([
      PlotType.NAPARI_IMAGE,
      PlotType.NAPARI_SCATTER,
      PlotType.NAPARI_SURFACE,
      PlotType.NAPARI_SCATTER3D,
      PlotType.NAPARI_VOLUME,
      PlotType.NAPARI_ISOSURFACE,
      // Advertised unconditionally; the SELECTOR hides it until a dataset is
      // published (`requiresSpatialData`), so a host with no spatial data never
      // sees it even though the backend can render it.
      PlotType.SPATIAL_OMICS,
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

  it('tool controls are safe no-ops before a plot is mounted', async () => {
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
    // A region overlay is mounted for the 2D image and accepts a draw mode without throwing.
    const overlay = service.getRegionOverlay();
    expect(overlay).not.toBeNull();
    overlay?.setMode('drawrect');
    overlay?.setMode('none');
    service.unsubscribe();
    document.body.removeChild(div);
  });

  /**
   * A numbered image series (jit-ui folder-stack feature) assembles its stack
   * from N separate files' own preview URLs, not one server-tiled file with
   * an internal z dimension — tiled:false signals this. Regression: without
   * it, every slice fetch hit /tile?info=<whichever file was last "selected">
   * &z=<scrub index>, which 400s for any z beyond that ONE file's own extent
   * (each series file is a single frame). tiled:false must bypass the
   * /tiles/info descriptor poll entirely and fetch urls[z] directly.
   */
  it('renders a tiled:false multi-file stack from urls[z] directly, bypassing /tiles/info', async () => {
    const info = imageInfo({
      tiled: false,
      urls: ['https://x/a.png', 'https://x/b.png', 'https://x/c.png'],
    });
    // Fetched via SimpleSliceAccessService (HttpClient), not the raw
    // globalThis.fetch this beforeEach mocks for the tiled-path tests —
    // spy on HttpClient.get directly so the response resolves synchronously.
    const getSpy = jest.spyOn(TestBed.inject(HttpClient), 'get').mockReturnValue(of(new Blob()));

    const div = document.createElement('div');
    div.id = 'plot-host-tiled-false';
    document.body.appendChild(div);

    // zIndex 1 — the middle file, the case that broke: a fixed single-file
    // tile scheme would request z=1 against whichever file was "selected"
    // (usually z=0/one frame only) and 400.
    const loaded = await service.load(info, 1);
    const ok = await service.plot('plot-host-tiled-false', loaded, info, 600, PlotType.NAPARI_IMAGE);

    expect(ok).toBe(true);
    // Fetched slice 1's own URL directly — no /tiles/info poll, no /tile?...&z= construction.
    expect(getSpy).toHaveBeenCalledWith('https://x/b.png', { responseType: 'blob' });
    service.unsubscribe();
    document.body.removeChild(div);
    getSpy.mockRestore();
  });

  it('plot() returns false when the target element is missing', async () => {
    const loaded = await service.load(imageInfo(), 0);
    expect(await service.plot('nope', loaded, imageInfo(), 600, PlotType.NAPARI_IMAGE)).toBe(false);
  });

  it('volume display state drives the layer contrast window + gamma from the store', async () => {
    // Capture the volume layer the stub Viewer hands back so we can assert what the
    // display-state subscription writes onto it (regression: min/max/gamma must reach the volume).
    const addVolume = jest.spyOn(
      Viewer.prototype as unknown as { addVolume: (...a: unknown[]) => unknown },
      'addVolume',
    );

    const div = document.createElement('div');
    div.id = 'vol-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('vol-host', loaded, imageInfo(), 600, PlotType.NAPARI_VOLUME);
    expect(ok).toBe(true);
    expect(service.getSurface3dControls()).not.toBeNull();

    const volLayer = addVolume.mock.results[0].value as {
      contrastLimits: [number, number];
      gamma: number;
      colormap: { name: string };
    };

    // The histogram pane's window (min/max) + gamma now reach the 3D volume layer.
    store.setChannelStates([
      { index: 0, name: 'v', color: '#00ff00', min: 20, max: 200, gamma: 2, visible: true } as IChannelState,
    ]);
    expect(volLayer.contrastLimits).toEqual([20, 200]);
    expect(volLayer.gamma).toBe(2);
    // Channel colour tints the volume (no explicit colormap selected) — regression.
    expect(volLayer.colormap.name).toContain('00ff00');

    // Invert flips the ramp (VolumeLayer has no per-layer invert, so it's emulated).
    store.setInvert(true);
    expect(volLayer.colormap.name).toContain('reversed');

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('mounts a napari-js height-field surface; min/max reshapes it, colour edits update it', async () => {
    const addSurface = jest.spyOn(
      Viewer.prototype as unknown as { addSurface: (...a: unknown[]) => unknown },
      'addSurface',
    );
    const latest = () =>
      addSurface.mock.results[addSurface.mock.results.length - 1].value as {
        contrastLimits: [number, number];
        gamma: number;
        colormap: { name: string };
      };

    const div = document.createElement('div');
    div.id = 'surf-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('surf-host', loaded, imageInfo(), 600, PlotType.NAPARI_SURFACE);
    expect(ok).toBe(true);
    expect(addSurface).toHaveBeenCalled();
    // addSurface(vertices, faces, values, opts) with real typed-array mesh geometry (heightField).
    const [vertices, faces, values] = addSurface.mock.calls[0] as [
      Float32Array,
      Uint32Array,
      Float32Array,
    ];
    expect(vertices).toBeInstanceOf(Float32Array);
    expect(faces).toBeInstanceOf(Uint32Array);
    expect(values).toBeInstanceOf(Float32Array);
    expect(service.getSurface3dControls()).not.toBeNull();

    // Changing min/max REBUILDS the mesh (a pixel's height = its intensity within [min,max]); the
    // new layer carries the window + gamma + channel-colour colormap.
    const beforeWindow = addSurface.mock.calls.length;
    store.setChannelStates([
      { index: 0, name: 's', color: '#00ff00', min: 30, max: 210, gamma: 1.5, visible: true } as IChannelState,
    ]);
    expect(addSurface.mock.calls.length).toBeGreaterThan(beforeWindow); // geometry rebuilt
    expect(latest().contrastLimits).toEqual([30, 210]);
    expect(latest().gamma).toBe(1.5);
    expect(latest().colormap.name).toContain('00ff00');

    // A colour-only edit (invert) updates the existing layer's colormap in place — NO rebuild.
    const beforeInvert = addSurface.mock.calls.length;
    store.setInvert(true);
    expect(addSurface.mock.calls.length).toBe(beforeInvert);
    expect(latest().colormap.name).toContain('reversed');

    // The stack slider re-slices: picking another z rebuilds the surface (from the pre-loaded cache).
    service.setZIndex(1);
    await Promise.resolve();
    expect(addSurface.mock.calls.length).toBeGreaterThan(beforeInvert);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('mounts a 3D axes gizmo for the napari surface and toggles it via Surface-3D controls', async () => {
    const addAxes = jest.spyOn(
      Viewer.prototype as unknown as { addAxes: (...a: unknown[]) => unknown },
      'addAxes',
    );
    const div = document.createElement('div');
    div.id = 'surf-axes-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    await service.plot('surf-axes-host', loaded, imageInfo(), 600, PlotType.NAPARI_SURFACE);
    expect(addAxes).toHaveBeenCalled();
    const axes = addAxes.mock.results[0].value as { visible: boolean };

    const ctrls = service.getSurface3dControls();
    expect(ctrls?.axesVisible?.()).toBe(true);
    ctrls?.setAxesVisible?.(false);
    expect(axes.visible).toBe(false);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('toggles the surface wireframe via Surface-3D controls', async () => {
    const addSurface = jest.spyOn(
      Viewer.prototype as unknown as { addSurface: (...a: unknown[]) => unknown },
      'addSurface',
    );
    const div = document.createElement('div');
    div.id = 'surf-wire-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    await service.plot('surf-wire-host', loaded, imageInfo(), 600, PlotType.NAPARI_SURFACE);
    const layer = addSurface.mock.results[addSurface.mock.results.length - 1].value as {
      wireframe: boolean;
    };

    const ctrls = service.getSurface3dControls();
    expect(ctrls?.wireframe?.()).toBe(false);
    ctrls?.setWireframe?.(true);
    expect(layer.wireframe).toBe(true); // live layer property, no rebuild
    expect(ctrls?.wireframe?.()).toBe(true);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('sources the surface by stitching the whole slice from the pyramid (resolution scales)', async () => {
    const div = document.createElement('div');
    div.id = 'surf-src-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    await service.plot('surf-src-host', loaded, imageInfo(), 600, PlotType.NAPARI_SURFACE);

    // With a /tiles/info descriptor, the surface stitches the slice from the pyramid (/tile) at a
    // budget driven by the decimate factor — so its resolution can scale (unlike a fixed thumbnail),
    // and it covers the whole slice rather than a corner.
    const fetchMock = globalThis.fetch as jest.Mock;
    const fetchedUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(fetchedUrls.some((u) => u.includes('tiles/info'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('/tile?'))).toBe(true);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('mounts a 2D scatter of region centroids via addPoints', async () => {
    jest
      .spyOn(regionStore, 'getRegions')
      .mockReturnValue([{ bounds: { x: 10, y: 20, width: 4, height: 6 } }] as never);
    const addPoints = jest.spyOn(
      Viewer.prototype as unknown as { addPoints: (...a: unknown[]) => unknown },
      'addPoints',
    );
    const div = document.createElement('div');
    div.id = 'scatter2d-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('scatter2d-host', loaded, imageInfo(), 600, PlotType.NAPARI_SCATTER);
    expect(ok).toBe(true);
    expect(addPoints).toHaveBeenCalled();
    // The rectangle centroid (10+2, 20+3) is scattered as a point.
    expect(Array.from(addPoints.mock.calls[0][0] as Float32Array)).toEqual([12, 23]);

    // REGRESSION: this mode plots REGION centroids, so without the region overlay
    // there is no way to produce a point at all. The toolbar gates its region
    // buttons on 2D-vs-3D, not on plot type, so they showed and did nothing.
    const overlay = service.getRegionOverlay();
    expect(overlay).not.toBeNull();
    expect(() => overlay?.setMode('drawrect')).not.toThrow();

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('mounts a 3D scatter voxel cloud via addPoints3D', async () => {
    const addPoints3d = jest.spyOn(
      Viewer.prototype as unknown as { addPoints3D: (...a: unknown[]) => unknown },
      'addPoints3D',
    );
    const div = document.createElement('div');
    div.id = 'scatter3d-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('scatter3d-host', loaded, imageInfo(), 600, PlotType.NAPARI_SCATTER3D);
    expect(ok).toBe(true);
    expect(addPoints3d).toHaveBeenCalled();
    // addPoints3D(positions, values) with N×3 positions and N values.
    const [pos, val] = addPoints3d.mock.calls[0] as [Float32Array, Float32Array];
    expect(pos).toBeInstanceOf(Float32Array);
    expect(val).toBeInstanceOf(Float32Array);
    expect(pos.length).toBe(val.length * 3);
    // A 3D scatter exposes the Surface-3D orbit/reset controls.
    expect(service.getSurface3dControls()).not.toBeNull();

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('decimates the surface mesh by the resolution scale', async () => {
    // A large source so the grid caps (¼ = 220, ⅛ = 110) actually downscale it and differ.
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = jest
      .fn()
      .mockResolvedValue({ width: 1024, height: 768, close: () => undefined });
    const addSurface = jest.spyOn(
      Viewer.prototype as unknown as { addSurface: (...a: unknown[]) => unknown },
      'addSurface',
    );
    const div = document.createElement('div');
    div.id = 'surf-decimate-host';
    document.body.appendChild(div);
    const loaded = await service.load(imageInfo(), 0);

    // Default load is ¼; a coarser factor → fewer polygons.
    expect(service.getResolutionScale()).toBe(4);
    await service.plot('surf-decimate-host', loaded, imageInfo(), 600, PlotType.NAPARI_SURFACE);
    const defaultVerts = (addSurface.mock.calls[0][0] as Float32Array).length;

    service.setResolutionScale(8);
    expect(service.getResolutionScale()).toBe(8);
    await service.plot('surf-decimate-host', loaded, imageInfo(), 600, PlotType.NAPARI_SURFACE);
    const coarseVerts = (
      addSurface.mock.calls[addSurface.mock.calls.length - 1][0] as Float32Array
    ).length;
    expect(coarseVerts).toBeLessThan(defaultVerts);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('fetchSlice falls back to the composite overview when allowed and a channel has no in-budget level', async () => {
    // Multichannel whole-slide: per-channel tiles exist ONLY at the huge real level (res 0); the
    // small overviews are composite-only. Stitching res 0 for a channel is ~1000s of tiles → server
    // 504s (the reported bug). With the fallback opted-in (surface path), fetchSlice pulls the small
    // composite overview instead.
    const tileUrls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('tiles/info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              width: 16000, height: 19000, tileSize: 512, z: 1, channels: 3, multichannel: true,
              realLevels: 1, // only res 0 is per-channel; the rest are composite overviews
              levels: [
                { res: 0, width: 16000, height: 19000 }, // huge real level (~1178 tiles)
                { res: 4, width: 1000, height: 1187 },
                { res: 6, width: 250, height: 297 }, // small overview that fits a tiny budget
              ],
            }),
        });
      }
      tileUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob()) });
    });
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = jest
      .fn()
      .mockResolvedValue({ width: 250, height: 297, close: () => undefined });

    // channel 1 at a small (surface ¼) tile budget, WITH composite fallback allowed.
    await (service as unknown as {
      fetchSlice: (z: number, c: number, b: number, allowCompositeFallback: boolean) => Promise<unknown>;
    }).fetchSlice(0, 1, 3, true);

    expect(tileUrls.length).toBeGreaterThan(0);
    // Dropped to the composite (no &channel=) rather than stitching the huge per-channel level…
    expect(tileUrls.every((u) => !u.includes('channel='))).toBe(true);
    // …at a small overview (never the huge res 0)…
    expect(tileUrls.every((u) => !u.includes('res=0'))).toBe(true);
    // …and a handful of tiles, not ~1000.
    expect(tileUrls.length).toBeLessThanOrEqual(9);
  });

  it('fetchSlice keeps each channel distinct (no composite fallback) by default — for volumes', async () => {
    // Regression: a multichannel VOLUME assembles each channel via fetchSlice. If a channel with no
    // in-budget level silently fell back to the composite, every channel would fetch identical data
    // and the channels would collapse into one washed-out grayscale. Volume assembly leaves the
    // fallback OFF (the default), so the per-channel band is preserved even when it exceeds budget.
    const tileUrls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('tiles/info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              width: 2000, height: 2000, tileSize: 512, z: 1, channels: 3, multichannel: true,
              realLevels: 1, // per-channel only at res 0 (16 tiles > budget); small composite exists
              levels: [
                { res: 0, width: 2000, height: 2000 },
                { res: 3, width: 250, height: 250 }, // composite overview that WOULD fit the budget
              ],
            }),
        });
      }
      tileUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob()) });
    });
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = jest
      .fn()
      .mockResolvedValue({ width: 250, height: 250, close: () => undefined });

    // Default call (allowCompositeFallback omitted → false): the volume path.
    await (service as unknown as {
      fetchSlice: (z: number, c: number, b: number) => Promise<unknown>;
    }).fetchSlice(0, 1, 3);

    // Stayed on the requested channel (never dropped to the composite), so channels stay distinct.
    expect(tileUrls.length).toBeGreaterThan(0);
    expect(tileUrls.every((u) => u.includes('channel=1'))).toBe(true);
  });

  it('fetchSlice keeps the channel when a real level fits the tile budget', async () => {
    // Small multichannel image: the real level fits, so the surface stays channel-specific.
    const tileUrls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('tiles/info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              width: 64, height: 48, tileSize: 512, z: 1, channels: 3, multichannel: true,
              realLevels: 1, levels: [{ res: 0, width: 64, height: 48 }],
            }),
        });
      }
      tileUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob()) });
    });

    await (service as unknown as {
      fetchSlice: (z: number, c: number, b: number) => Promise<unknown>;
    }).fetchSlice(0, 1, 3);

    expect(tileUrls.some((u) => u.includes('channel=1'))).toBe(true);
  });

  it('mounts a 3D axes gizmo for volumes and toggles it via Surface-3D controls', async () => {
    const addAxes = jest.spyOn(
      Viewer.prototype as unknown as { addAxes: (...a: unknown[]) => unknown },
      'addAxes',
    );
    const div = document.createElement('div');
    div.id = 'axes-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    await service.plot('axes-host', loaded, imageInfo(), 600, PlotType.NAPARI_VOLUME);
    const axes = addAxes.mock.results[0].value as { visible: boolean };
    expect(axes.visible).toBe(true);

    const ctrls = service.getSurface3dControls();
    expect(ctrls?.axesVisible?.()).toBe(true);
    ctrls?.setAxesVisible?.(false);
    expect(axes.visible).toBe(false);
    expect(ctrls?.axesVisible?.()).toBe(false);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('builds one volume layer per channel for a multichannel volume', async () => {
    // 3-channel multichannel descriptor → one additive tinted volume per channel.
    (globalThis.fetch as unknown as jest.Mock).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('tiles/info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              width: 64,
              height: 48,
              tileSize: 512,
              z: 2,
              channels: 3,
              multichannel: true,
              realLevels: 1,
              channelInfo: [{ color: '#ff0000' }, { color: '#00ff00' }, { color: '#0000ff' }],
              levels: [{ res: 0, width: 64, height: 48 }],
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob()) });
    });
    const addVolume = jest.spyOn(
      Viewer.prototype as unknown as { addVolume: (...a: unknown[]) => unknown },
      'addVolume',
    );
    addVolume.mockClear(); // the prototype spy persists across tests; count only this plot
    const div = document.createElement('div');
    div.id = 'mcvol-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('mcvol-host', loaded, imageInfo(), 600, PlotType.NAPARI_VOLUME);
    expect(ok).toBe(true);
    expect(addVolume).toHaveBeenCalledTimes(3); // one volume layer per channel
    // Per-channel volume histogram resolves from that channel's assembled data.
    expect(service.getHistogram(2, 256)).not.toBeNull();

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('renders the volume at a decimate factor (subsampled), histogram still resolves', async () => {
    const div = document.createElement('div');
    div.id = 'vol-decimate-host';
    document.body.appendChild(div);

    service.setResolutionScale(4); // ¼ resolution
    expect(service.getResolutionScale()).toBe(4);
    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('vol-decimate-host', loaded, imageInfo(), 600, PlotType.NAPARI_VOLUME);
    expect(ok).toBe(true);
    expect(service.getSurface3dControls()).not.toBeNull();
    // The volume histogram still resolves from the assembled (subsampled) volume.
    expect(service.getHistogram(0, 256)).not.toBeNull();

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('keeps the volume world box (and Z) constant across resolution changes', async () => {
    // Regression: the volume box used to be sized by the sampled voxel counts, so a higher in-plane
    // resolution grew X/Y while Z (the slice count) stayed put — Z appeared to shrink. The box must
    // be resolution-invariant: dims × voxelSize is the same at ¼ and Full.
    (globalThis.fetch as unknown as jest.Mock).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('tiles/info')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              width: 1024, height: 768, tileSize: 2048, z: 2, channels: 1, realLevels: 1,
              levels: [{ res: 0, width: 1024, height: 768 }], // one big tile → dims track maxSlice
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob()) });
    });
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = jest
      .fn()
      .mockResolvedValue({ width: 1024, height: 768, close: () => undefined });
    const addVolume = jest.spyOn(
      Viewer.prototype as unknown as { addVolume: (...a: unknown[]) => unknown },
      'addVolume',
    );
    const div = document.createElement('div');
    div.id = 'vol-invariant-host';
    document.body.appendChild(div);
    const loaded = await service.load(imageInfo(), 0);

    // World box (dims × voxelSize) captured at a given resolution scale.
    const worldBoxAt = async (scale: number): Promise<[number, number, number]> => {
      service.setResolutionScale(scale);
      addVolume.mockClear();
      await service.plot('vol-invariant-host', loaded, imageInfo(), 600, PlotType.NAPARI_VOLUME);
      const [, w, h, d, opts] = addVolume.mock.calls[0] as [
        unknown, number, number, number, { voxelSize: [number, number, number] },
      ];
      const vs = opts.voxelSize;
      return [w * vs[0], h * vs[1], d * vs[2]];
    };

    const quarter = await worldBoxAt(4); // ¼ (dims ≈ 256×192)
    const full = await worldBoxAt(1); //    Full (dims ≈ 1024×768)
    // Same world box at both resolutions — in particular the Z extent doesn't change.
    expect(full[0]).toBeCloseTo(quarter[0], 3);
    expect(full[1]).toBeCloseTo(quarter[1], 3);
    expect(full[2]).toBeCloseTo(quarter[2], 3);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('restretches the volume Z (voxelSize.z + axes depth) via the Z-height handle', async () => {
    const div = document.createElement('div');
    div.id = 'vol-zscale-host';
    document.body.appendChild(div);
    const loaded = await service.load(imageInfo(), 0);
    await service.plot('vol-zscale-host', loaded, imageInfo(), 600, PlotType.NAPARI_VOLUME);

    const svc = service as unknown as {
      volumeView: { layers: { voxelSize: readonly [number, number, number] }[] };
      axesLayer: { depth: number };
      setVolumeZScale: (f: number) => void;
    };
    const baseVsZ = svc.volumeView.layers[0].voxelSize[2];
    const baseDepth = svc.axesLayer.depth;

    svc.setVolumeZScale(2); // taller
    expect(svc.volumeView.layers[0].voxelSize[2]).toBeCloseTo(baseVsZ * 2, 5);
    expect(svc.axesLayer.depth).toBeCloseTo(baseDepth * 2, 5);
    // XY voxel scale is untouched by a Z-height change.
    expect(svc.volumeView.layers[0].voxelSize[0]).toBeGreaterThan(0);

    svc.setVolumeZScale(0.5); // flatter (relative to base, not the previous 2×)
    expect(svc.volumeView.layers[0].voxelSize[2]).toBeCloseTo(baseVsZ * 0.5, 5);
    expect(svc.axesLayer.depth).toBeCloseTo(baseDepth * 0.5, 5);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  it('composites multiple channels and serves per-channel histograms (multichannel)', async () => {
    // A 3-channel multichannel descriptor → one additive tinted layer per channel.
    (globalThis.fetch as unknown as jest.Mock).mockImplementation((url: string) => {
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
              channels: 3,
              multichannel: true,
              realLevels: 1,
              channelInfo: [{ color: '#ff0000' }, { color: '#00ff00' }, { color: '#0000ff' }],
              levels: [{ res: 0, width: 64, height: 48 }],
            }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob()) });
    });

    const div = document.createElement('div');
    div.id = 'mc-host';
    document.body.appendChild(div);

    const loaded = await service.load(imageInfo(), 0);
    const ok = await service.plot('mc-host', loaded, imageInfo(), 600, PlotType.NAPARI_IMAGE);
    expect(ok).toBe(true);
    // Per-channel native histogram now resolves from the in-memory scalar layers.
    const hist = service.getHistogram(1, 256);
    expect(hist).not.toBeNull();
    expect(hist?.counts.length).toBe(256);

    service.unsubscribe();
    document.body.removeChild(div);
  });

  describe('SPATIAL_OMICS_3D mode', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    let addPoints3D: jest.SpyInstance;

    /** Mount the 3D cloud with `dataset` published; returns every layer built. */
    async function mount3d(dataset: SpatialDataset | null = spatialDataset3d()) {
      // Replace any host from an earlier mount: overlays and the scale bar attach
      // to it, and a leftover would be visible to the next test's DOM assertions.
      document.getElementById('spatial3d-host')?.remove();
      const div = document.createElement('div');
      div.id = 'spatial3d-host';
      document.body.appendChild(div);
      dataset$.next(dataset);
      const loaded = await service.load(imageInfo(), 0);
      await service.plot('spatial3d-host', loaded, imageInfo(), 600, PlotType.SPATIAL_OMICS_3D);
      await flush();
      return addPoints3D.mock.results.map((r) => r.value);
    }

    const last = (layers: any[]) => layers.at(-1);
    const named = (layers: any[], name: string) => layers.filter((l) => l.name === name).at(-1);

    beforeEach(() => {
      addPoints3D = jest.spyOn(Viewer.prototype, 'addPoints3D');
    });

    it('draws the cloud flat above the published category ceiling, and in colour at it', async () => {
      // The enforced limit and the one the panel publishes have to be the same
      // number: at 96 categories the encoder rejected while the panel warned only
      // above 96, so the cloud drew flat with nothing said.
      const palette = (n: number) => ({
        meta: {
          kind: 'categorical', name: 'wide',
          categories: Array.from({ length: n }, (_, i) => `c${i}`),
          colors: Array.from({ length: n }, () => '#123456'),
        },
        codes: new Uint16Array([0, 1, 2]),
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      spatialPort.getColumn.mockResolvedValue(palette(SPATIAL_3D_MAX_CATEGORIES));
      await mount3d(spatialDataset3d());
      store.setSpatialView({ colorBy: { kind: 'column', name: 'wide' } });
      await flush();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('exceeds'));

      spatialPort.getColumn.mockResolvedValue(palette(SPATIAL_3D_MAX_CATEGORIES + 1));
      store.setSpatialView({ colorBy: { kind: 'column', name: 'wider' } });
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
      warn.mockRestore();
    });

    describe('camera', () => {
      /** The pose a user would have set by orbiting and dollying the canvas. */
      const POSE = { azimuth: 1.1, elevation: 0.4, distance: 4242, target: [7, 8, 9] };
      const cam = () => (service as unknown as {
        viewer: { camera3d: { azimuth: number; elevation: number; distance: number;
          target: [number, number, number] } };
      }).viewer.camera3d;
      const setPose = () => {
        const c = cam();
        c.azimuth = POSE.azimuth;
        c.elevation = POSE.elevation;
        c.distance = POSE.distance;
        c.target = [...POSE.target] as [number, number, number];
      };
      const pose = () => {
        const c = cam();
        return {
          azimuth: c.azimuth, elevation: c.elevation, distance: c.distance,
          target: [...c.target],
        };
      };

      /** A volume-backed dataset with a categorical column and cells on 3 planes. */
      const clustered3d = (): SpatialDataset => {
        const base = spatialDatasetVolume(6);
        return {
          ...base,
          observations: {
            ...base.observations,
            count: 6,
            x: Float32Array.from({ length: 6 }, () => 150),
            y: Float32Array.from({ length: 6 }, () => 500),
            z: new Float32Array([400, 400, 1200, 1200, 2000, 2000]),
          },
        } as SpatialDataset;
      };

      it('frames once when the scene first appears', async () => {
        // The opening view has to come from somewhere, and the reference volume's
        // box is the framing worth having — the brain, not a stray segmentation.
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(spatialDatasetVolume(3));
        // 4x6x10 voxels of 100x200x400 -> a 400 x 1200 x 4000 world box, framed at
        // 1.8x its longest side. Suppressing every framing would leave the stub's
        // initial distance of 1 and an unusable opening view.
        expect(pose().distance).toBeCloseTo(4000 * 1.8, 5);
        expect(pose().target).toEqual([0, 0, 0]);
      });

      it('keeps the camera when the colour column changes', async () => {
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getColumn.mockResolvedValue({
          meta: {
            kind: 'categorical', name: 'region', categories: ['A', 'B'],
            colors: ['#ff0000', '#0000ff'],
          },
          codes: new Uint16Array([0, 0, 0, 1, 1, 1]),
        });
        await mount3d(clustered3d());
        setPose();

        store.setSpatialView({ colorBy: { kind: 'column', name: 'region' } });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });
      });

      it('keeps the camera when a gene is picked, and when its map is drawn', async () => {
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(clustered3d());
        setPose();

        store.setSpatialView({ colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });

        // The gene map adds a VOLUME, which is the add that calls frame().
        store.setSpatialView({ geneMap: true });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });

        store.setSpatialView({ geneMapVolume: true });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });
      });

      it('keeps the camera when a section is isolated', async () => {
        // The worst case: napari would pivot and dolly onto ONE section's bounds,
        // so the view would lurch to a different place for every section.
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(clustered3d());
        setPose();

        store.setSpatialView({ pointSection: 1 });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });

        store.setSpatialView({ pointSection: 2 });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });

        store.setSpatialView({ pointSection: null });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });
      });

      it('keeps the camera when a selection is highlighted, and when volumes appear', async () => {
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getColumn.mockResolvedValue({
          meta: {
            kind: 'categorical', name: 'region', categories: ['A', 'B'],
            colors: ['#ff0000', '#0000ff'],
          },
          codes: new Uint16Array([0, 0, 0, 1, 1, 1]),
        });
        await mount3d(clustered3d());
        store.setSpatialView({ colorBy: { kind: 'column', name: 'region' } });
        await flush();
        setPose();

        TestBed.inject(SpatialSelectionStore).set({
          mask: new Uint8Array([1, 0, 1, 0, 1, 0]), count: 3,
        });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });

        store.setSpatialView({ densityVolume: true });
        await flush();
        expect(pose()).toEqual({ ...POSE, target: [...POSE.target] });
      });
    });

    describe('scene visibility', () => {
      const cloud = (layers: any[]) => named(layers, 'observations');

      it('hides the cloud without discarding it, so it comes straight back', async () => {
        const layers = await mount3d();
        expect(cloud(layers).visible).toBe(true);
        const built = addPoints3D.mock.calls.length;

        store.setSpatialView({ showPoints: false });
        await flush();
        // The SAME layer, hidden — not a rebuild, and not removed from the scene.
        expect(cloud(addPoints3D.mock.results.map((r) => r.value)).visible).toBe(false);
        expect(addPoints3D.mock.calls.length).toBe(built);
        const inScene = (service as unknown as {
          viewer: { layers: { items: readonly { name?: string }[] } };
        }).viewer.layers.items.filter((l) => l.name === 'observations');
        expect(inScene).toHaveLength(1);

        store.setSpatialView({ showPoints: true });
        await flush();
        expect(cloud(addPoints3D.mock.results.map((r) => r.value)).visible).toBe(true);
        expect(addPoints3D.mock.calls.length).toBe(built);
      });

      it('hides the reference volume without re-fetching it', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        const getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getVolume = getVolume;
        await mount3d(spatialDatasetVolume(3));
        const volume = addVolume.mock.results.map((r) => r.value).at(-1);
        expect(volume.visible).toBe(true);
        expect(getVolume).toHaveBeenCalledTimes(1);

        store.setSpatialView({ showVolume: false });
        await flush();
        // A 100 MB template must not be re-fetched to un-hide a checkbox, so the
        // toggle is visibility and nothing else.
        expect(volume.visible).toBe(false);
        expect(getVolume).toHaveBeenCalledTimes(1);
        expect(addVolume.mock.calls.length).toBe(1);

        store.setSpatialView({ showVolume: true });
        await flush();
        expect(volume.visible).toBe(true);
        expect(getVolume).toHaveBeenCalledTimes(1);
      });

      it('applies the reference volume opacity, at build and on a change', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        store.setSpatialView({ volumeOpacity: 0.2 });
        await mount3d(spatialDatasetVolume(3));

        // Built at the requested opacity, so the first painted frame is right
        // rather than flashing the default and settling.
        const volume = addVolume.mock.results.map((r) => r.value).at(-1);
        expect(addVolume.mock.calls.at(-1)![4]!.opacity).toBe(0.2);
        expect(volume.opacity).toBe(0.2);

        store.setSpatialView({ volumeOpacity: 0.9 });
        await flush();
        expect(volume.opacity).toBe(0.9);
        // The backdrop's opacity is its own — the cloud keeps the markers' value.
        expect(named(addPoints3D.mock.results.map((r) => r.value), 'observations').opacity).toBe(1);
        expect(addVolume.mock.calls.length).toBe(1); // a property, not a rebuild
      });

      it('draws one imaged section at a time, cells and scalars together', async () => {
        // z = 0, 30, 60 — three sections, one observation each.
        spatialPort.getColumn.mockResolvedValue({
          meta: { kind: 'continuous', name: 'total_counts' },
          values: new Float32Array([10, 20, 30]),
        });
        await mount3d();
        store.setSpatialView({ colorBy: { kind: 'column', name: 'total_counts' } });
        await flush();
        expect(cloud(addPoints3D.mock.results.map((r) => r.value)).positions).toHaveLength(9);

        store.setSpatialView({ pointSection: 1 });
        await flush();
        const one = cloud(addPoints3D.mock.results.map((r) => r.value));
        // The middle section's single cell: x=10, y=20, z=30.
        expect(Array.from(one.positions)).toEqual([10, 20, 30]);
        // …and ITS scalar, not the first observation's — a per-observation vector
        // against one section's positions would colour each cell by a stranger.
        expect(one.values).toHaveLength(1);

        store.setSpatialView({ pointSection: null });
        await flush();
        expect(cloud(addPoints3D.mock.results.map((r) => r.value)).positions).toHaveLength(9);
      });

      it('clamps a section index the dataset no longer has', async () => {
        // The view state outlives the dataset, so a stale index must not blank
        // the cloud or read past the section list.
        await mount3d();
        store.setSpatialView({ pointSection: 99 });
        await flush();
        const layer = cloud(addPoints3D.mock.results.map((r) => r.value));
        // The last section, drawn — not an empty layer.
        expect(Array.from(layer.positions)).toEqual([20, 40, 60]);
      });

      it('restricts the selection highlight to the section on screen', async () => {
        await mount3d();
        // Select the first and last observations, then show only the middle one.
        TestBed.inject(SpatialSelectionStore).set({ mask: new Uint8Array([1, 0, 1]), count: 2 });
        await flush();
        expect(named(addPoints3D.mock.results.map((r) => r.value), 'selected')).toBeDefined();

        store.setSpatialView({ pointSection: 1 });
        await flush();
        // Nothing selected is on this section, so there is no highlight layer to
        // leave floating where its own cells are not drawn.
        const inScene = (service as unknown as {
          viewer: { layers: { items: readonly { name?: string }[] } };
        }).viewer.layers.items.filter((l) => l.name === 'selected');
        expect(inScene).toHaveLength(0);
      });
    });

    describe('gene map in 3D', () => {
      /**
       * A volume-backed dataset whose sections have GAPS between them: the 400-unit
       * z voxel puts the cells on planes 1, 3 and 5, leaving 2 and 4 unimaged. The
       * gap is the whole point — it is what separates the measured sheets from the
       * interpolated volume, and a fixture with adjacent sections cannot tell them
       * apart.
       */
      const sectioned = (): SpatialDataset => {
        const base = spatialDatasetVolume(6);
        return {
          ...base,
          observations: {
            ...base.observations,
            count: 6,
            x: Float32Array.from({ length: 6 }, () => 150),
            y: Float32Array.from({ length: 6 }, () => 500),
            z: new Float32Array([400, 400, 1200, 1200, 2000, 2000]),
          },
        } as SpatialDataset;
      };
      const mapLayers = (addVolume: jest.SpyInstance) =>
        addVolume.mock.results
          .map((r) => r.value)
          .filter((l) => typeof l?.name === 'string' && l.name.startsWith('gene map'));

      it('draws nothing until the option is on AND a gene is the colour source', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());

        store.setSpatialView({ geneMap: true, colorBy: { kind: 'column', name: 'region' } });
        await flush();
        expect(mapLayers(addVolume)).toHaveLength(0);

        store.setSpatialView({ colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        expect(mapLayers(addVolume)).toHaveLength(1);
      });

      it('draws the sheets additively on the reference volume’s own lattice', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();

        const call = addVolume.mock.calls.find((c) => /gene map/.test(String(c[4]?.name)))!;
        const [, w, h, d, opts] = call;
        // Coarsened in-plane (the 4x6 template becomes 2x3) but the depth is the
        // volume's own, so there is still one plane per imaged section.
        expect([w, h, d]).toEqual([2, 3, 10]);
        // The physical extent is unchanged, so the box still coincides with the
        // reference volume's — a VolumeLayer has no translate to correct with.
        expect(opts!.voxelSize).toEqual([200, 400, 400]);
        expect([w * 200, h * 400, d * 400]).toEqual([4 * 100, 6 * 200, 10 * 400]);
        // Additive, so the sheets read through each other and through the tissue.
        expect(opts!.blending).toBe('additive');
        // The encoding already applied the window; a second one would re-window it.
        expect(opts!.contrastLimits).toEqual([0, 255]);
        expect(opts!.name).toBe('gene map · Ttr');
      });

      it('fills only the imaged planes as sheets, and bridges them as a volume', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();

        const plane = 2 * 3; // the coarsened lattice's in-plane size
        const filled = (data: Uint8Array, k: number) =>
          Array.from(data.slice(k * plane, (k + 1) * plane)).some((v) => v > 0);
        const sheets = addVolume.mock.calls.find((c) => /gene map/.test(String(c[4]?.name)))![0];
        // The imaged planes carry the measurement…
        expect(filled(sheets, 1)).toBe(true);
        expect(filled(sheets, 3)).toBe(true);
        expect(filled(sheets, 5)).toBe(true);
        // …and the gap between two sections stays EMPTY, which is what makes these
        // sheets rather than a volume. Empty means invisible, since the raymarch
        // takes alpha from the value.
        expect(filled(sheets, 2)).toBe(false);
        expect(filled(sheets, 4)).toBe(false);
        expect(filled(sheets, 0)).toBe(false);

        store.setSpatialView({ geneMapVolume: true });
        await flush();
        const vol = addVolume.mock.calls.filter((c) => /gene map/.test(String(c[4]?.name))).at(-1)!;
        expect(String(vol[4]!.name)).toContain('volume');
        const volData = vol[0] as Uint8Array;
        // Now the gaps carry an interpolated estimate…
        expect(filled(volData, 2)).toBe(true);
        expect(filled(volData, 4)).toBe(true);
        // …but nothing appears beyond the outermost imaged section.
        expect(filled(volData, 0)).toBe(false);
      });

      it('ignores the section restriction while interpolating', async () => {
        // A volume built from ONE section would smear that slide through the whole
        // depth and present it as an estimate of the specimen.
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());
        store.setSpatialView({
          geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' },
          geneMapVolume: true, geneMapSection: 0,
        });
        await flush();

        const plane = 2 * 3; // the coarsened lattice's in-plane size
        const filled = (data: Uint8Array, k: number) =>
          Array.from(data.slice(k * plane, (k + 1) * plane)).some((v) => v > 0);
        const data = addVolume.mock.calls
          .filter((c) => /gene map/.test(String(c[4]?.name))).at(-1)![0] as Uint8Array;
        // Every imaged plane contributed, not just section 0: plane 5 is the last
        // section, and with section 0 alone it would fall outside the sampled
        // range and be zeroed.
        expect(filled(data, 5)).toBe(true);
        expect(filled(data, 3)).toBe(true);
      });

      it('draws one sheet when a section is picked, and clamps a stale index', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());
        store.setSpatialView({
          geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' }, geneMapSection: 0,
        });
        await flush();

        const plane = 2 * 3; // the coarsened lattice's in-plane size
        const filled = (data: Uint8Array, k: number) =>
          Array.from(data.slice(k * plane, (k + 1) * plane)).some((v) => v > 0);
        const one = addVolume.mock.calls
          .filter((c) => /gene map/.test(String(c[4]?.name))).at(-1)![0] as Uint8Array;
        // Section 0 is z = 400 -> plane 1, and no other section is drawn.
        expect(filled(one, 1)).toBe(true);
        expect(filled(one, 3)).toBe(false);
        expect(filled(one, 5)).toBe(false);

        store.setSpatialView({ geneMapSection: 99 });
        await flush();
        const clamped = addVolume.mock.calls
          .filter((c) => /gene map/.test(String(c[4]?.name))).at(-1)![0] as Uint8Array;
        // The LAST section, drawn — not an empty volume.
        expect(filled(clamped, 5)).toBe(true);
        expect(filled(clamped, 1)).toBe(false);
      });

      it('does not re-estimate the field for a recolour, only for a new gene', async () => {
        const estimate = jest.spyOn(expressionModule, 'expressionVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        expect(estimate).toHaveBeenCalledTimes(1);

        // A window change recolours the cached field — re-estimating would be a
        // full pass over the lattice for colours that come out of a LUT.
        store.setSpatialView({ percentileClip: [0.05, 0.95] });
        await flush();
        expect(estimate).toHaveBeenCalledTimes(1);

        store.setSpatialView({ geneMapOpacity: 0.4 });
        await flush();
        expect(estimate).toHaveBeenCalledTimes(1);

        // Interpolating is a different field, and so is a different gene.
        store.setSpatialView({ geneMapVolume: true });
        await flush();
        expect(estimate).toHaveBeenCalledTimes(2);
        estimate.mockRestore();
      });

      it('honours the chosen colormap, and follows the image’s live without one', async () => {
        // 3D mounts no display-state subscription of its own, so the spatial
        // subscription is the ONLY thing that keeps the colour scale current here.
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        const first = mapLayers(addVolume).at(-1)!.colormap;

        store.setSpatialView({ continuousColormap: 'Reds' });
        await flush();
        const chosen = mapLayers(addVolume).at(-1)!.colormap;
        expect(chosen).not.toEqual(first);

        // Back to following the image, then change the image's colormap.
        store.setSpatialView({ continuousColormap: null });
        await flush();
        const following = mapLayers(addVolume).at(-1)!.colormap;
        store.setColormap({ label: 'Reds', data: { value: 'Reds' } } as never);
        await flush();
        expect(mapLayers(addVolume).at(-1)!.colormap).not.toEqual(following);
      });

      it('removes the layer when the option is switched off', async () => {
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 2, 3, 4, 5, 6]));
        await mount3d(sectioned());
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        const inScene = () =>
          ((service as unknown as { viewer: { layers: { items: readonly { name?: string }[] } } })
            .viewer.layers.items).filter((l) => l.name?.startsWith('gene map')).length;
        expect(inScene()).toBe(1);

        store.setSpatialView({ geneMap: false });
        await flush();
        expect(inScene()).toBe(0);
      });
    });

    describe('cluster density volumes', () => {
      /** A dataset with a volume, a categorical column, and cells on 3 planes. */
      const clustered = (): SpatialDataset => {
        const base = spatialDatasetVolume(6);
        return {
          ...base,
          observations: {
            ...base.observations,
            count: 6,
            x: Float32Array.from({ length: 6 }, () => 150),
            y: Float32Array.from({ length: 6 }, () => 500),
            z: new Float32Array([400, 400, 800, 800, 1200, 1200]),
          },
        } as SpatialDataset;
      };

      /** Three categories: A x3, B x2, C x1 — so the ranking is observable. */
      const column = {
        meta: {
          kind: 'categorical', name: 'region', categories: ['A', 'B', 'C'],
          colors: ['#ff0000', '#00ff00', '#0000ff'],
        },
        codes: new Uint16Array([0, 0, 0, 1, 1, 2]),
      };

      const densityLayers = (addVolume: jest.SpyInstance) =>
        addVolume.mock.results
          .map((r) => r.value)
          .filter((l) => typeof l?.name === 'string' && l.name.startsWith('density · '));

      it('draws nothing extra until the option is switched on', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(clustered());

        expect(densityLayers(addVolume)).toHaveLength(0); // the reference volume only
      });

      it('draws one additive, tinted volume per cluster, biggest first', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getColumn.mockResolvedValue(column);
        await mount3d(clustered());

        store.setSpatialView({ colorBy: { kind: 'column', name: 'region' }, densityVolume: true });
        await flush();

        const layers = densityLayers(addVolume);
        // One per category, ranked by cell count — A (3), B (2), C (1).
        expect(layers.map((l) => l.name)).toEqual([
          'density · A', 'density · B', 'density · C',
        ]);
        // Additive so overlapping territories both read; translucent so the
        // interior is visible rather than only the brightest shell.
        expect(layers[0].blending).toBe('additive');
        expect(layers[0].rendering).toBe('translucent');
        // On the volume's grid, coarsened — same physical box, fewer voxels.
        expect(layers[0].width * layers[0].voxelSize[0]).toBeCloseTo(4 * 100, 6);
        expect(layers[0].depth * layers[0].voxelSize[2]).toBeCloseTo(10 * 400, 6);
        expect(layers[0].width).toBeLessThan(4 * 100);
      });

      it('divides the opacity budget across the clusters so overlap does not blow out', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        spatialPort.getColumn.mockResolvedValue(column);
        await mount3d(clustered());

        store.setSpatialView({ colorBy: { kind: 'column', name: 'region' }, densityVolume: true });
        await flush();
        const many = densityLayers(addVolume);
        expect(many).toHaveLength(3);
        // Additive blending sums: three broad fields at full opacity saturate to
        // white, so the budget is split.
        expect(many.every((l) => l.opacity < 0.55)).toBe(true);
        expect(many[0].opacity * many.length).toBeLessThanOrEqual(1.2);

        // One cluster has nothing to blow out against, so it keeps the full value.
        store.setSpatialView({ colorBy: null });
        await flush();
        expect(densityLayers(addVolume).at(-1).opacity).toBeCloseTo(0.55, 6);
      });

      it('rasterises total density when the colouring is not categorical', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(clustered());

        store.setSpatialView({ colorBy: null, densityVolume: true });
        await flush();

        expect(densityLayers(addVolume).map((l) => l.name)).toEqual(['density · all cells']);
      });

      it('removes the volumes when the option is switched off', async () => {
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(clustered());
        store.setSpatialView({ densityVolume: true });
        await flush();
        const inScene = () =>
          ((service as unknown as { viewer: { layers: { items: readonly { name?: string }[] } } })
            .viewer.layers.items).filter((l) => l.name?.startsWith('density · ')).length;
        expect(inScene()).toBe(1);

        store.setSpatialView({ densityVolume: false });
        await flush();
        expect(inScene()).toBe(0);
      });

      it('re-rasterises for a different selection of the same size', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(clustered());
        store.setSpatialView({ densityVolume: true });
        await flush();
        const built = densityLayers(addVolume).length;

        // Two DIFFERENT selections, same count: keyed on the count alone this
        // looks unchanged, and the previous ROI's fields stay on screen.
        TestBed.inject(SpatialSelectionStore)
          .set({ mask: Uint8Array.from([1, 1, 0, 0, 0, 0]), count: 2 });
        await flush();
        const afterFirst = densityLayers(addVolume).length;
        expect(afterFirst).toBeGreaterThan(built);

        TestBed.inject(SpatialSelectionStore)
          .set({ mask: Uint8Array.from([0, 0, 0, 0, 1, 1]), count: 2 });
        await flush();
        expect(densityLayers(addVolume).length).toBeGreaterThan(afterFirst);
      });

      it('does not re-rasterise for a change that cannot alter the field', async () => {
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(clustered());
        store.setSpatialView({ densityVolume: true });
        await flush();
        const built = densityLayers(addVolume).length;

        // Point size is a cloud knob: rasterising again would cost seconds for a
        // field that cannot have changed.
        store.setSpatialView({ pointScale: 3 });
        await flush();
        expect(densityLayers(addVolume).length).toBe(built);

        // Bandwidth does change it.
        store.setSpatialView({ densitySmoothing: 3 });
        await flush();
        expect(densityLayers(addVolume).length).toBeGreaterThan(built);
      });
    });

    it('draws the cloud with x, y and z interleaved', async () => {
      const layers = await mount3d();
      expect(addPoints3D).toHaveBeenCalled();
      // x = i*10, y = i*20, z = i*30, laid out x-fastest.
      expect(Array.from(named(layers, 'observations').positions)).toEqual([
        0, 0, 0,
        10, 20, 30,
        20, 40, 60,
      ]);
    });

    it('draws nothing when the observations have no z', async () => {
      // The plot type is gated on `requiresSpatial3d`, but a host can set the
      // type directly, and a 2D dataset must not be silently flattened onto z=0.
      const layers = await mount3d(spatialDataset());
      expect(layers).toHaveLength(0);
    });

    it('scales the marker size by pointScale', async () => {
      const layers = await mount3d();
      // Screen pixels here, not data units: the 3D layer sizes billboards in
      // screen space, so the data-unit radius does not carry over.
      expect(named(layers, 'observations').size).toBe(3);

      store.setSpatialView({ pointScale: 2 });
      await flush();
      expect(last(addPoints3D.mock.results.map((r) => r.value)).size).toBe(6);
    });

    it('maps each category code onto its OWN colour in the LUT', async () => {
      // The heart of the 3D categorical path. The layer has no per-point RGBA, so
      // a palette is smuggled through a 256-entry scalar LUT as one block per
      // category. This asserts the block arithmetic: with slot 0 reserved for
      // "no category", code i must resolve to palette entry i and not a
      // neighbour's blend.
      const column: CategoricalColumn = {
        meta: {
          kind: 'categorical', name: 'region', categories: ['A', 'B'],
          colors: ['#ff0000', '#0000ff'],
        },
        codes: new Uint16Array([0, 1, 0]),
      };
      spatialPort.getColumn.mockResolvedValue(column);

      await mount3d();
      store.setSpatialView({ colorBy: { kind: 'column', name: 'region' } });
      await flush();

      const layer = last(addPoints3D.mock.results.map((r) => r.value));
      // Codes are shifted by one, keeping 0 free for the unassigned colour.
      expect(Array.from(layer.values)).toEqual([1, 2, 1]);
      const k = 3; // 2 categories + the reserved slot
      expect(layer.contrastLimits).toEqual([-0.5, k - 0.5]);

      // Resolve each code the way the shader does: normalise through
      // contrastLimits, then index the LUT.
      const lut = layer.colormap.stops as [number, number, number][];
      expect(lut).toHaveLength(256);
      const colourOf = (value: number) => {
        const [lo, hi] = layer.contrastLimits;
        const t = (value - lo) / (hi - lo);
        return lut[Math.max(0, Math.min(255, Math.round(t * 255)))];
      };
      expect(colourOf(1)).toEqual([255, 0, 0]);   // category A
      expect(colourOf(2)).toEqual([0, 0, 255]);   // category B
    });

    it('refuses to colour more categories than the LUT can hold apart', async () => {
      // 96 is the measured ceiling; beyond it the colours would be subtly wrong
      // while the legend stayed confident, so the renderer draws flat instead.
      const categories = Array.from({ length: 200 }, (_, i) => `c${i}`);
      const column: CategoricalColumn = {
        meta: {
          kind: 'categorical', name: 'many', categories,
          colors: categories.map(() => '#ff0000'),
        },
        codes: new Uint16Array([0, 1, 2]),
      };
      spatialPort.getColumn.mockResolvedValue(column);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await mount3d();
      store.setSpatialView({ colorBy: { kind: 'column', name: 'many' } });
      await flush();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('256-entry LUT'));
      const layer = last(addPoints3D.mock.results.map((r) => r.value));
      // Flat: a two-stop colormap, every value resolving to the same colour.
      expect((layer.colormap as any).name).toBe('spatial-flat');
      warn.mockRestore();
    });

    it('windows a continuous column through the colormap', async () => {
      const column: ContinuousColumn = {
        meta: { kind: 'continuous', name: 'score' },
        values: Float32Array.from([0, 5, 10]),
      };
      spatialPort.getColumn.mockResolvedValue(column);

      await mount3d();
      store.setSpatialView({ colorBy: { kind: 'column', name: 'score' }, percentileClip: [0, 1] });
      await flush();

      const layer = last(addPoints3D.mock.results.map((r) => r.value));
      expect(Array.from(layer.values)).toEqual([0, 5, 10]);
      expect(layer.contrastLimits).toEqual([0, 10]);
    });

    it('never hands the shader a degenerate window', async () => {
      // Every value identical: a zero-width window would divide by zero when the
      // shader normalises, so it has to be widened.
      const column: ContinuousColumn = {
        meta: { kind: 'continuous', name: 'flat' },
        values: Float32Array.from([7, 7, 7]),
      };
      spatialPort.getColumn.mockResolvedValue(column);

      await mount3d();
      store.setSpatialView({ colorBy: { kind: 'column', name: 'flat' }, percentileClip: [0, 1] });
      await flush();

      const [lo, hi] = last(addPoints3D.mock.results.map((r) => r.value)).contrastLimits;
      expect(hi).toBeGreaterThan(lo);
    });

    it('mounts the region overlay so the ROI tools work in 3D', async () => {
      // REGRESSION: the 3D mount is deliberately thinner than the 2D one (no
      // image, no scale bar, no readback), and an earlier revision dropped region
      // drawing along with all that. The tools then showed in the toolbar and did
      // nothing — exactly the failure the 2D spatial mode shipped with once.
      await mount3d();
      const overlay = service.getRegionOverlay();
      expect(overlay).not.toBeNull();
      expect(() => overlay?.setMode('drawrect')).not.toThrow();
      expect(() => overlay?.setMode('none')).not.toThrow();
    });

    it('projects observations to canvas pixels through the 3D camera', async () => {
      await mount3d();
      const projected = service.getSpatialScreenProjection(spatialDataset3d().observations);
      expect(projected).not.toBeNull();
      expect(projected!.length).toBe(3 * 2);
      // The stub camera is the identity, so clip == world and the mapping reduces
      // to NDC -> canvas: x = (nx/2 + 0.5)*w, y = (1 - (ny/2 + 0.5))*h. The y flip
      // is the part worth pinning: NDC points up, canvas points down, and getting
      // it backwards would silently mirror every selection.
      const w = 300;
      const h = 150;
      const obs = spatialDataset3d().observations;
      for (let i = 0; i < obs.count; i++) {
        expect(projected![i * 2]).toBeCloseTo((obs.x[i] * 0.5 + 0.5) * w, 3);
        expect(projected![i * 2 + 1]).toBeCloseTo((1 - (obs.y[i] * 0.5 + 0.5)) * h, 3);
      }
    });

    describe('reference volume', () => {
      it('adds the volume with the declared dimensions and voxel size', async () => {
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');

        await mount3d(spatialDatasetVolume());

        expect(addVolume).toHaveBeenCalled();
        const layer = addVolume.mock.results.at(-1)?.value;
        expect([layer.width, layer.height, layer.depth]).toEqual([4, 6, 10]);
        expect(layer.voxelSize).toEqual([100, 200, 400]);
        // Translucent, not MIP: a maximum-intensity projection of an averaged
        // template is a flat shell that hides the very points it is backing.
        expect(layer.rendering).toBe('translucent');
        expect(layer.opacity).toBeLessThan(1);
      });

      it('offsets the cloud by HALF THE BOX so it sits inside the volume', async () => {
        // The load-bearing bit. napari-js centres a volume's box on the world
        // origin, while observations are in the volume's frame with its near
        // corner AT the origin — so the points have to move by half the box or
        // the cloud floats outside the anatomy by half a brain.
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        const layers = await mount3d(spatialDatasetVolume());

        const half = [(4 * 100) / 2, (6 * 200) / 2, (10 * 400) / 2];
        const obs = spatialDataset3d().observations;
        const z = obs.z!;
        const positions = named(layers, 'observations').positions;
        for (let i = 0; i < obs.count; i++) {
          expect(positions[i * 3]).toBeCloseTo(obs.x[i] - half[0], 3);
          expect(positions[i * 3 + 1]).toBeCloseTo(obs.y[i] - half[1], 3);
          expect(positions[i * 3 + 2]).toBeCloseTo(z[i] - half[2], 3);
        }
      });

      it('leaves the cloud at its own coordinates when there is no volume', async () => {
        const layers = await mount3d(spatialDataset3d());
        const obs = spatialDataset3d().observations;
        const positions = named(layers, 'observations').positions;
        expect(positions[3]).toBeCloseTo(obs.x[1], 3);
      });

      it('draws the cloud anyway when the volume fails to load', async () => {
        // A backdrop is a nicety; losing it must not cost the data.
        spatialPort.getVolume = jest.fn().mockRejectedValue(new Error('503'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        const layers = await mount3d(spatialDatasetVolume());

        expect(named(layers, 'observations')).toBeDefined();
        // ...and unoffset, since there is no box to sit inside.
        expect(named(layers, 'observations').positions[3])
          .toBeCloseTo(spatialDataset3d().observations.x[1], 3);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
      });

      it('applies the same offset to the selected-subset layer', async () => {
        // Two layers drawn from one cloud: if only one is offset, a selection
        // appears half a brain away from the points it selected.
        spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
        await mount3d(spatialDatasetVolume());
        TestBed.inject(SpatialSelectionStore).set({
          mask: Uint8Array.from([0, 1, 0]), count: 1,
        });
        await flush();

        const all = addPoints3D.mock.results.map((r) => r.value);
        const selected = named(all, 'selected');
        const obs = spatialDataset3d().observations;
        expect(Array.from(selected.positions)).toEqual([
          obs.x[1] - (4 * 100) / 2,
          obs.y[1] - (6 * 200) / 2,
          obs.z![1] - (10 * 400) / 2,
        ]);
      });
    });

    it('shows a scale bar when the dataset declares its unit', async () => {
      const layers = await mount3d({ ...spatialDataset3d(), micronsPerUnit: 1 });
      expect(layers.length).toBeGreaterThan(0);
      // Rendered into the plot host, so its presence is observable from the DOM
      // rather than through a private field.
      expect(document.getElementById('spatial3d-host')?.textContent).toMatch(/µm|nm|mm|cm/);
    });

    it('shows NO scale bar when the coordinate unit is unknown', async () => {
      // A bar labelled in microns over unknown units reads as a measurement, and
      // is worse than no bar at all.
      await mount3d(spatialDataset3d());
      expect(document.getElementById('spatial3d-host')?.textContent ?? '')
        .not.toMatch(/µm|nm|mm|cm/);
    });

    it('draws a selection as a second layer, muting the parent cloud', async () => {
      // There is no per-point alpha in 3D, so the 2D highlight-vs-mute trick has
      // to be rebuilt out of two layers.
      const layers = await mount3d();
      const before = named(layers, 'observations');
      expect(before.opacity).toBe(1);

      TestBed.inject(SpatialSelectionStore).set({
        mask: Uint8Array.from([0, 1, 0]), count: 1,
      });
      await flush();

      const all = addPoints3D.mock.results.map((r) => r.value);
      const selected = named(all, 'selected');
      expect(selected).toBeDefined();
      // Only the selected observation, at its own coordinates.
      expect(Array.from(selected.positions)).toEqual([10, 20, 30]);
      expect(selected.opacity).toBe(1);
      // ...and the parent drops to the muted level.
      expect(named(all, 'observations').opacity).toBeCloseTo(DEFAULT_MUTED_OPACITY);
    });
  });

  describe('Volume / Isosurface world box', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** Mount the volume view over `info` and return the volume layer built.
     *  A `tiled: false` stack fetches each slice through SimpleSliceAccessService
     *  (HttpClient), not the raw `globalThis.fetch` this suite mocks — so stub it
     *  here, or the assembly awaits responses that never come. */
    async function mountVolume(info: IImageInfo) {
      jest.spyOn(TestBed.inject(HttpClient), 'get').mockReturnValue(of(new Blob()));
      const addVolume = jest.spyOn(Viewer.prototype, 'addVolume');
      const div = document.createElement('div');
      div.id = 'vol-box-host';
      document.body.appendChild(div);
      const loaded = await service.load(info, 0);
      await service.plot('vol-box-host', loaded, info, 600, PlotType.NAPARI_VOLUME);
      await flush();
      const layer = addVolume.mock.results.at(-1)?.value;
      document.body.removeChild(div);
      return layer;
    }

    it('takes its voxels from the IMAGE STACK, not from a spatial dataset', async () => {
      // These modes raymarch the stack and nothing else. A 3D omics dataset reaches
      // them because its registered volume is published AS a grayscale z-stack
      // image — not through a second voxel source behind the same modes.
      spatialPort.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 6 * 10));
      dataset$.next(spatialDatasetVolume());

      await mountVolume(imageInfo());

      expect(spatialPort.getVolume).not.toHaveBeenCalled();
    });

    it('gives a stack that declares mppX/Y/Z its true physical proportions', async () => {
      // 40 x 40 x 200 µm voxels: the box has to come out 11 x 11 x 15.2 mm, or the
      // anatomy renders as a cube-aspect brick.
      const layer = await mountVolume(imageInfo({
        // `tiled: false` is the shape a published volume image has: complete
        // per-slice images, no server pyramid to describe.
        tiled: false,
        urls: Array.from({ length: 76 }, (_, z) => `u${z}`),
        imageMeta: [
          { channelCount: 1, rgbChannels: 1, x: 275, y: 275, z: 76, mppX: 40, mppY: 40, mppZ: 200 },
        ],
      }));

      // voxelSize maps the SAMPLED grid onto the world box, so the box itself is
      // voxelSize x sampled dims — the assertion that survives any decimate factor.
      const [vx, vy, vz] = layer.voxelSize;
      expect(vx * layer.width).toBeCloseTo(275 * 40, 3);
      expect(vy * layer.height).toBeCloseTo(275 * 40, 3);
      expect(vz * layer.depth).toBeCloseTo(76 * 200, 3);
      // Anisotropic, and in the right direction: z voxels are the long ones.
      expect(vz / vx).toBeGreaterThan(1);
    });

    it('labels the axes from the physical extent, once — not the world box', async () => {
      // Regression: the label maths read a pixel count off the world box and
      // multiplied by mpp. Once the box is physical (µm) that scaled it twice —
      // 11 mm of mouse brain came out as "44.0 cm" — and Z, never physical at all,
      // read "76 px" for a volume that knows it is 15.2 mm deep.
      await mountVolume(imageInfo({
        tiled: false,
        urls: Array.from({ length: 76 }, (_, z) => `u${z}`),
        imageMeta: [
          { channelCount: 1, rgbChannels: 1, x: 275, y: 275, z: 76, mppX: 40, mppY: 40, mppZ: 200 },
        ],
      }));

      const labels = (service as unknown as {
        buildAxesLabels: (v: { width: number; height: number; depth: number }) => { text: string }[];
      }).buildAxesLabels({ width: 1, height: 1, depth: 1 }).map((l) => l.text);

      // 275 x 40 µm = 11 000 µm and 76 x 200 µm = 15 200 µm, formatted in cm at
      // this scale — a mouse brain, not the 44.0 cm the double-scaled label gave.
      expect(labels[0]).toBe('X · 1.1 cm');
      expect(labels[1]).toBe('Y · 1.1 cm');
      expect(labels[2]).toBe('Z · 1.5 cm');
    });

    it('labels Z in slices when the stack declares no slice spacing', async () => {
      await mountVolume(imageInfo({
        tiled: false,
        urls: Array.from({ length: 8 }, (_, z) => `u${z}`),
        imageMeta: [
          { channelCount: 1, rgbChannels: 1, x: 275, y: 275, z: 8, mppX: 40, mppY: 40 },
        ],
      }));

      const labels = (service as unknown as {
        buildAxesLabels: (v: { width: number; height: number; depth: number }) => { text: string }[];
      }).buildAxesLabels({ width: 1, height: 1, depth: 1 }).map((l) => l.text);

      expect(labels[0]).toBe('X · 1.1 cm');
      expect(labels[2]).toBe('Z · 8 px'); // unknown thickness — say so, don't invent one
    });

    it('falls back to the shape-only reference box when no slice spacing is declared', async () => {
      // Most stacks (a WSI z-series) have no mppZ to offer. The box is then chosen
      // to be independent of the decimate factor rather than physically true.
      const layer = await mountVolume(imageInfo({
        tiled: false,
        urls: Array.from({ length: 8 }, (_, z) => `u${z}`),
        imageMeta: [
          { channelCount: 1, rgbChannels: 1, x: 275, y: 275, z: 8, mppX: 40, mppY: 40 },
        ],
      }));

      const [vx, , vz] = layer.voxelSize;
      // Depth spans the slice count, not a physical extent.
      expect(vz * layer.depth).toBeCloseTo(8, 3);
      expect(vx * layer.width).not.toBeCloseTo(275 * 40, 3);
    });
  });

  describe('SPATIAL_OMICS mode', () => {
    /** Let the async colour resolution settle (a gene fetch is a round-trip). */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    let addPoints: jest.SpyInstance;

    /** Mount the spatial mode with `dataset` published, and return the layer built. */
    async function mount(dataset: SpatialDataset | null = spatialDataset()) {
      const div = document.createElement('div');
      div.id = 'spatial-host';
      document.body.appendChild(div);
      dataset$.next(dataset);
      const loaded = await service.load(imageInfo(), 0);
      await service.plot('spatial-host', loaded, imageInfo(), 600, PlotType.SPATIAL_OMICS);
      await flush();
      return addPoints.mock.results.at(-1)?.value;
    }

    beforeEach(() => {
      addPoints = jest.spyOn(Viewer.prototype, 'addPoints');
    });

    /** Layers currently in the stub viewer's scene. */
    const viewerLayers = () =>
      ((service as unknown as { viewer: { layers: { items: readonly unknown[] } } })
        .viewer?.layers.items ?? []) as readonly unknown[];

    /** Mount with the stack opened on slice `z`, as a volume-backed dataset does. */
    async function mountAt(dataset: SpatialDataset, z: number) {
      const div = document.createElement('div');
      div.id = 'spatial-slice-host';
      document.body.appendChild(div);
      dataset$.next(dataset);
      const loaded = await service.load(imageInfo(), z);
      await service.plot('spatial-slice-host', loaded, imageInfo(), 600, PlotType.SPATIAL_OMICS);
      await flush();
      return addPoints.mock.results.at(-1)?.value;
    }

    describe('over a volume-backed 3D dataset', () => {
      /** Observations at x/y (0,0), (10,20), (20,40) with z 0, 500, 900 — which on
       *  400-deep planes is slice 0, 1 and 2. */
      const sliced = (): SpatialDataset => {
        const base = spatialDatasetVolume(3);
        return {
          ...base,
          observations: { ...base.observations, z: new Float32Array([0, 500, 900]) },
        };
      };

      it('draws only the displayed plane\'s observations, in the slice pixel grid', async () => {
        const layer = await mountAt(sliced(), 1);

        // Just observation 1 — the other two are other sections, and drawing them
        // would pile the specimen's whole depth onto one plane.
        expect(Array.from(layer.positions)).toEqual([10, 20]);
        // Coordinates stay data-space; the volume's affine puts them in the
        // slice's pixels (voxels are 100 x 200 wide, near corner at the origin).
        expect(layer.scale).toEqual([1 / 100, 1 / 200]);
        expect(layer.translate).toEqual([0, 0]);
      });

      it('follows a scrub to the new plane', async () => {
        await mountAt(sliced(), 1);
        service.setZIndex(2);
        await flush();

        expect(Array.from(addPoints.mock.results.at(-1)?.value.positions)).toEqual([20, 40]);
      });

      it('re-adds a marker layer the image render cleared out of the scene', async () => {
        const layer = await mountAt(sliced(), 1);
        expect(viewerLayers()).toContain(layer);

        // What napari's image view does on EVERY render: empty the layer list. The
        // service's cached handle is now detached, and mutating it draws nothing.
        (service as unknown as { viewer: { layers: { clear(): void } } }).viewer.layers.clear();
        expect(viewerLayers()).toHaveLength(0);

        // A display-only change, so nothing about the marker key changed — the
        // fast path would mutate the detached layer and leave the plane empty.
        store.setSpatialView({ pointScale: 3 });
        await flush();

        const next = addPoints.mock.results.at(-1)?.value;
        expect(next).not.toBe(layer);
        expect(viewerLayers()).toContain(next);
        expect(Array.from(next.positions)).toEqual([10, 20]);
      });

      it('redraws the markers only AFTER the image render that clears them', async () => {
        await mountAt(sliced(), 1);
        // The stitched branch, which is what a volume-backed dataset takes: its
        // slices are blob images, not a server pyramid. (The tiled branch only
        // moves `dims.z` — no render, so nothing clears the markers there.)
        (service as unknown as { tiled: boolean }).tiled = false;
        const order: string[] = [];
        jest
          .spyOn(service as unknown as { renderImage: (z: number, t?: number) => Promise<void> },
            'renderImage')
          .mockImplementation(async () => { order.push('image'); });
        jest
          .spyOn(service as unknown as { rebuildSpatialPoints: (...a: unknown[]) => Promise<void> },
            'rebuildSpatialPoints')
          .mockImplementation(async () => { order.push('markers'); });

        service.setZIndex(2);
        await flush();

        // Markers first would put them under the clear the render performs, which
        // is exactly how a scrubbed plane ended up with no observations on it.
        expect(order).toEqual(['image', 'markers']);
      });

      it('floors the marker diameter so a sub-pixel cell still shows', async () => {
        const ds = sliced();
        // 2-unit radius on a 100-unit voxel grid: drawn to scale that is 1/25 of a
        // pixel, and the section would come up empty.
        const layer = await mountAt(
          { ...ds, observations: { ...ds.observations, radius: 2 } }, 1,
        );
        expect(Array.from(layer.size as Float32Array)).toEqual([1.5 * 100]);
      });

      it('gathers per-point colours down to the drawn subset', async () => {
        spatialPort.getColumn.mockResolvedValue({
          meta: {
            kind: 'categorical', name: 'region', categories: ['A', 'B', 'C'],
            colors: ['#ff0000', '#00ff00', '#0000ff'],
          },
          codes: new Uint16Array([0, 1, 2]),
        });
        await mountAt(sliced(), 1);
        store.setSpatialView({ colorBy: { kind: 'column', name: 'region' } });
        await flush();

        const layer = addPoints.mock.results.at(-1)?.value;
        // One colour, and it is observation 1's — a colour array still indexed by
        // the whole dataset would paint this point red.
        expect(layer.faceColor).toHaveLength(1);
        expect(layer.faceColor[0].slice(0, 3)).toEqual([0, 1, 0]);
      });

      it('leaves a dataset with a real imageRef drawing every observation', async () => {
        const ds = sliced();
        const layer = await mountAt(
          { ...ds, imageRef: { imageId: 'tissue', scale: [2, 2] } }, 1,
        );
        // Its coordinates are already the image's pixels and there is one section:
        // nothing to filter, and the dataset's own affine still wins.
        expect(Array.from(layer.positions)).toEqual([0, 0, 10, 20, 20, 40]);
        expect(layer.scale).toEqual([2, 2]);
      });
    });

    describe('gene map', () => {
      const geneMapLayers = (addImage: jest.SpyInstance) =>
        addImage.mock.calls.filter((c) => /gene map/.test(String((c[1] as { name?: string })?.name)));

      it('draws nothing until the option is on AND a gene is the colour source', async () => {
        const addImage = jest.spyOn(Viewer.prototype, 'addImage');
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 5, 9]));
        await mount();

        // On, but coloured by a column: there is no gene to map.
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'column', name: 'region' } });
        await flush();
        expect(geneMapLayers(addImage)).toHaveLength(0);

        store.setSpatialView({ colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        expect(geneMapLayers(addImage)).toHaveLength(1);
      });

      it('hands napari an RGBA raster on the image grid, blended under the cells', async () => {
        const addImage = jest.spyOn(Viewer.prototype, 'addImage');
        const addPoints = jest.spyOn(Viewer.prototype, 'addPoints');
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 5, 9]));
        await mount();
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();

        const [source, opts] = geneMapLayers(addImage).at(-1)!;
        const src = source as { kind: string; channels: number; dtype: string; data: Uint8Array };
        expect(src.kind).toBe('typed');
        // RGBA, so the layer can be transparent where nothing was measured.
        expect(src.channels).toBe(4);
        expect(src.dtype).toBe('uint8');
        expect((opts as { blending?: string }).blending).toBe('translucent');
        // The markers are re-added after it, so the cells stay on top of the field.
        expect(addPoints.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
          addImage.mock.invocationCallOrder.at(-1)!,
        );
      });

      it('does not re-estimate the field for a recolour, only for a new gene', async () => {
        // Counted on the estimator itself, not on the fetch: the points path fetches
        // the same vector to colour the markers, so a fetch count says nothing about
        // whether the FIELD was rebuilt.
        const estimate = jest.spyOn(expressionModule, 'expressionField');
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 5, 9]));
        await mount();
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        expect(estimate).toHaveBeenCalledTimes(1);

        // A window change recolours the cached field — re-estimating would be a full
        // pass over the raster for colours that come out of a LUT.
        store.setSpatialView({ percentileClip: [0.05, 0.95] });
        await flush();
        expect(estimate).toHaveBeenCalledTimes(1);

        // A different gene is a different field.
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([9, 5, 1]));
        store.setSpatialView({ colorBy: { kind: 'feature', name: 'Mbp' } });
        await flush();
        expect(estimate).toHaveBeenCalledTimes(2);
        estimate.mockRestore();
      });

      it('colours the field with the chosen colormap, not the image’s', async () => {
        // The display colormap belongs to the tissue image; the gene map's own
        // choice has to override it, or picking a gradient does nothing.
        const addImage = jest.spyOn(Viewer.prototype, 'addImage');
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 5, 9]));
        await mount();
        store.setSpatialView({
          geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' },
          continuousColormap: 'Reds',
        });
        await flush();
        const reds = geneMapLayers(addImage).at(-1)![0] as { data: Uint8Array };

        store.setSpatialView({ continuousColormap: 'Blues' });
        await flush();
        const blues = geneMapLayers(addImage).at(-1)![0] as { data: Uint8Array };
        expect(Array.from(blues.data)).not.toEqual(Array.from(reds.data));

        // Reds really is red-dominant and Blues blue-dominant, so this is the
        // colormap reaching the pixels and not merely some byte changing.
        const channelSums = (d: Uint8Array) => {
          let r = 0; let b = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; b += d[i + 2]; }
          return { r, b };
        };
        expect(channelSums(reds.data).r).toBeGreaterThan(channelSums(reds.data).b);
        expect(channelSums(blues.data).b).toBeGreaterThan(channelSums(blues.data).r);
      });

      it('follows the image’s colormap live while none is chosen', async () => {
        // "Match the image" is the default, and a setting that only takes effect
        // at the next unrelated rebuild is not a setting.
        const addImage = jest.spyOn(Viewer.prototype, 'addImage');
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 5, 9]));
        await mount();
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        const before = geneMapLayers(addImage).at(-1)![0] as { data: Uint8Array };

        store.setColormap({ label: 'Reds', data: { value: 'Reds' } } as never);
        await flush();
        const after = geneMapLayers(addImage).at(-1)![0] as { data: Uint8Array };
        expect(Array.from(after.data)).not.toEqual(Array.from(before.data));
      });

      it('removes the layer when the option is switched off', async () => {
        spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([1, 5, 9]));
        await mount();
        store.setSpatialView({ geneMap: true, colorBy: { kind: 'feature', name: 'Ttr' } });
        await flush();
        const inScene = () =>
          ((service as unknown as { viewer: { layers: { items: readonly { name?: string }[] } } })
            .viewer.layers.items).filter((l) => l.name?.startsWith('gene map')).length;
        expect(inScene()).toBe(1);

        store.setSpatialView({ geneMap: false });
        await flush();
        expect(inScene()).toBe(0);
      });
    });

    it('draws one marker per observation at its coordinates', async () => {
      const layer = await mount();
      expect(addPoints).toHaveBeenCalled();
      expect(Array.from(layer.positions)).toEqual([0, 0, 10, 20, 20, 40]);
    });

    it('sizes markers by DIAMETER from the radius, scaled by pointScale', async () => {
      const layer = await mount();
      expect(layer.size).toBe(55); // 27.5 px radius -> 55 px diameter

      store.setSpatialView({ pointScale: 2 });
      await flush();
      expect(addPoints.mock.results.at(-1)?.value.size).toBe(110);
    });

    it('uses one flat colour when nothing is selected to colour by', async () => {
      const layer = await mount();
      // A single RGBA tuple, broadcast — not a per-point array.
      expect(Array.isArray(layer.faceColor)).toBe(true);
      expect(layer.faceColor).toHaveLength(4);
      expect(typeof layer.faceColor[0]).toBe('number');
    });

    it('colours by a categorical column using the column\'s own palette', async () => {
      const column: CategoricalColumn = {
        meta: {
          kind: 'categorical', name: 'region', categories: ['A', 'B'],
          colors: ['#ff0000', '#0000ff'],
        },
        codes: new Uint16Array([0, 1, 0]),
      };
      spatialPort.getColumn.mockResolvedValue(column);

      await mount();
      store.setSpatialView({ colorBy: { kind: 'column', name: 'region' } });
      await flush();

      const layer = addPoints.mock.results.at(-1)?.value;
      expect(spatialPort.getColumn).toHaveBeenCalledWith('region');
      expect(layer.faceColor).toHaveLength(3); // one tuple per observation
      expect(layer.faceColor[0].slice(0, 3)).toEqual([1, 0, 0]);
      expect(layer.faceColor[1].slice(0, 3)).toEqual([0, 0, 1]);
    });

    it('colours by a gene vector through the active colormap', async () => {
      spatialPort.getFeatureVector.mockResolvedValue(new Float32Array([0, 5, 10]));

      await mount();
      store.setSpatialView({ colorBy: { kind: 'feature', name: 'Ttr' } });
      await flush();

      const layer = addPoints.mock.results.at(-1)?.value;
      expect(spatialPort.getFeatureVector).toHaveBeenCalledWith('Ttr');
      expect(layer.faceColor).toHaveLength(3);
      // Distinct values must map to distinct colours — a flat result would mean
      // the contrast window collapsed.
      expect(layer.faceColor[0]).not.toEqual(layer.faceColor[2]);
    });

    it('falls back to a flat colour when a gene fetch fails, rather than blanking the view', async () => {
      spatialPort.getFeatureVector.mockRejectedValue(new Error('404'));
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await mount();
      store.setSpatialView({ colorBy: { kind: 'feature', name: 'Missing' } });
      await flush();

      const layer = addPoints.mock.results.at(-1)?.value;
      expect(layer.faceColor).toHaveLength(4); // the broadcast tuple, so points still render
    });

    it('ignores a superseded colour fetch that resolves late', async () => {
      await mount();
      // 'slow' resolves AFTER 'fast', but 'fast' was requested second.
      let releaseSlow: (v: Float32Array) => void = () => undefined;
      spatialPort.getFeatureVector.mockImplementationOnce(
        () => new Promise<Float32Array>((resolve) => { releaseSlow = resolve; }),
      );
      spatialPort.getFeatureVector.mockResolvedValueOnce(new Float32Array([9, 9, 9]));

      store.setSpatialView({ colorBy: { kind: 'feature', name: 'slow' } });
      store.setSpatialView({ colorBy: { kind: 'feature', name: 'fast' } });
      await flush();
      const afterFast = addPoints.mock.calls.length;

      releaseSlow(new Float32Array([0, 0, 0]));
      await flush();
      // The stale response must not add another layer.
      expect(addPoints.mock.calls.length).toBe(afterFast);
    });

    // REGRESSION: the mode's selection is driven by drawn ROIs, so mounting it
    // without the region overlay left the region tools inert — the toolbar
    // buttons showed (they gate on 2D, not on plot type) but did nothing.
    it('mounts the region overlay, so the ROI tools work as they do on the image view', async () => {
      await mount();
      const overlay = service.getRegionOverlay();
      expect(overlay).not.toBeNull();
      expect(() => {
        overlay?.setMode('drawrect');
        overlay?.setMode('drawpolygon');
        overlay?.setMode('none');
      }).not.toThrow();
    });

    it('arms the pixel tools, so wand/brush work over the spots too', async () => {
      await mount();
      expect(() => {
        service.setWandMode(true);
        service.setBrushMode(true);
        service.setZoomToBoxMode(true);
        service.setVertexEraserMode(true);
      }).not.toThrow();
    });

    // REGRESSION: the Opacity slider did nothing in the DEFAULT state. With no
    // colour source and no selection the flat colour was a constant tuple, so
    // `view.opacity` was dropped on the floor — and that is the state anyone
    // lands in before picking a column or a gene.
    it('honours opacity with no colour source selected', async () => {
      const layer = await mount();
      // Uniform at opacity 1: one broadcast tuple, so a flat 84k view does not
      // allocate 84k of them.
      expect(layer.faceColor).toHaveLength(4);

      store.setSpatialView({ opacity: 0.3 });
      await flush();
      // No longer uniform, so it becomes per-point and the alpha carries it.
      expect(layer.faceColor).toHaveLength(3);
      expect((layer.faceColor as number[][])[0][3]).toBeCloseTo(0.3, 2);
    });

    it('updates size and colour IN PLACE, without rebuilding the layer', async () => {
      await mount();
      const calls = addPoints.mock.calls.length;
      const layer = addPoints.mock.results.at(-1)?.value;

      store.setSpatialView({ pointScale: 3 });
      await flush();
      // A display-only change must not re-add the layer: at 84k observations
      // that would rebuild every position to change one number.
      expect(addPoints.mock.calls.length).toBe(calls);
      expect(layer.size).toBe(165); // 27.5 radius -> 55 diameter x 3
    });

    it('rebuilds the layer when the DATASET changes', async () => {
      await mount();
      const calls = addPoints.mock.calls.length;
      dataset$.next({ ...spatialDataset(2), id: 'other' });
      await flush();
      expect(addPoints.mock.calls.length).toBe(calls + 1);
    });

    it('applies the dataset\'s data->world affine so spots land on the image', async () => {
      const layer = await mount({
        ...spatialDataset(),
        imageRef: { scale: [0.5, 0.5], translate: [10, -4], mppX: 1 },
      });
      expect(layer.scale).toEqual([0.5, 0.5]);
      expect(layer.translate).toEqual([10, -4]);
    });

    it('defaults the affine to identity when the dataset declares none', async () => {
      const layer = await mount();
      expect(layer.scale).toEqual([1, 1]);
      expect(layer.translate).toEqual([0, 0]);
    });

    it('renders nothing extra for an empty dataset', async () => {
      const layer = await mount({ ...spatialDataset(0), observations: {
        count: 0, x: new Float32Array(0), y: new Float32Array(0),
      } });
      expect(layer).toBeUndefined();
    });

    it('stops tracking the dataset on reset', async () => {
      await mount();
      expect(dataset$.observed).toBe(true);
      service.reset();
      expect(dataset$.observed).toBe(false);
    });
  });
});
