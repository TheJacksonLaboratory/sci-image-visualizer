import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { firstValueFrom, of } from 'rxjs';

import { Viewer } from 'napari-js';

import { NapariVisualizerService } from './napari-visualizer.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { VIZ_CONFIG } from '../../contracts/viz-config';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { PlotType } from '../../contracts/plot-type';
import { ViewerFeature } from '../../contracts/capabilities.contract';
import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';

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
});
