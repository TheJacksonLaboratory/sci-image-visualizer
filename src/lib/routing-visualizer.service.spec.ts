import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom, of } from 'rxjs';

import { RoutingVisualizerService } from './routing-visualizer.service';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import { NapariVisualizerService } from './implementations/napari-js/napari-visualizer.service';
import { VisualizerStore } from './store/visualizer-store.service';
import { VIZ_CONFIG } from './contracts/viz-config';
import { PlotType } from './contracts/plot-type';
import { IChannelState, IHistogram } from './contracts/channel-histogram-api.contract';
import { SPATIAL_DATA_PORT } from './contracts/ports/spatial-data.port';
import { CategoricalColumn, SpatialDataset } from './contracts/spatial-dataset.contract';
import { RegionStore } from './store/region-store.service';
import { SpatialSelectionStore } from './store/spatial-selection.service';
import { Rectangle, Region } from './models/region';
import { BehaviorSubject } from 'rxjs';
import { IntensityProfileService } from './intensity/intensity-profile.service';

/**
 * CHARACTERIZATION TESTS (refactoring plan, Step 0).
 *
 * These pin the router's *current* behavior — backend selection, the per-image
 * OSD fallback, teardown-on-switch, profile filtering, and the auto-contrast
 * windowing math — so the extraction steps that follow are verifiable. If a
 * later step changes one of these on purpose (e.g. Step 1 re-points display
 * options from Plotly to the store), update the pin in the same commit and say
 * so; a pin failing **unintentionally** means a regression.
 */

/** Minimal jest-mocked IVisualizer with just the members the router touches. */
function mockBackend(): any {
  return {
    capabilities: { features: [] },
    load: jest.fn().mockResolvedValue({ ok: true }),
    plot: jest.fn().mockResolvedValue(true),
    reset: jest.fn(),
    purgePlot: jest.fn(), // PlotlyService-only; harmless on the OSD mock
    setActiveImage: jest.fn(), // PlotlyService-only
    reloadAndPlot: jest.fn(),
    relayout: jest.fn(),
    resetAxes: jest.fn(),
    autoscale: jest.fn(),
    fitToView: jest.fn(),
    zoomIn: jest.fn(),
    zoomOut: jest.fn(),
    setDragMode: jest.fn(),
    setShowStack: jest.fn(),
    setZIndex: jest.fn(),
    getHistogram: jest.fn().mockReturnValue(null),
    getHistogram$: jest.fn().mockReturnValue(of(null)),
    exportComposite: jest.fn(),
    exportData: jest.fn(),
    getColormap: jest.fn().mockReturnValue(of('mock-colormap')),
    setColormap: jest.fn(),
    getColormapOptions: jest.fn().mockReturnValue([]),
    getReverseScale: jest.fn().mockReturnValue(of(false)),
    setReverseScale: jest.fn(),
    setImageMeta: jest.fn(),
    getImageMeta: jest.fn().mockReturnValue(of([])),
    getRegions: jest.fn().mockReturnValue([]),
    setRegions: jest.fn(),
    getRegionPolygons: jest.fn().mockReturnValue([]),
    getSelectedShapeIndices$: jest.fn().mockReturnValue(of([])),
    setSelectedShapeIndices: jest.fn(),
    getRegionOverlay: jest.fn().mockReturnValue({ kind: 'overlay' }),
    getSurface3dControls: jest.fn().mockReturnValue({ kind: '3d' }),
    unsubscribe: jest.fn(),
    detach: jest.fn(),
    // ── remaining IVisualizer surface (for delegation coverage) ──
    getTrueImageSize: jest.fn().mockReturnValue({ width: 0, height: 0 }),
    getCurrentImage: jest.fn().mockResolvedValue(null),
    getDisplayedPixelData: jest.fn().mockReturnValue(null),
    getDisplayedSourceRect: jest.fn().mockReturnValue(null),
    downloadImage: jest.fn(),
    setPlotType: jest.fn(),
    setSurfaceDragMode: jest.fn(),
    resetSurfaceCamera: jest.fn(),
    getPlotTypeDescriptors: jest.fn().mockReturnValue([]),
    setStackLoading: jest.fn(),
    isStackLoading: jest.fn().mockReturnValue(of(false)),
    getStackLoadingProgress: jest.fn().mockReturnValue(of(0)),
    getAutoscaleEvent: jest.fn().mockReturnValue(new Subject<void>()),
    getIntensityProfile$: jest.fn().mockReturnValue(of([])),
    renderIntensityInset: jest.fn(),
    getRegionUpdateEvent: jest.fn().mockReturnValue(of([])),
    selectRegion: jest.fn(),
    deleteActiveShape: jest.fn(),
    getShowShapeLabel: jest.fn().mockReturnValue(false),
    getShapeColor: jest.fn().mockReturnValue('#000000'),
    getFillColor: jest.fn().mockReturnValue('#000000'),
    getClassificationColors: jest.fn().mockReturnValue(new Map()),
    setClassificationColor: jest.fn(),
    importRegions: jest.fn().mockReturnValue([]),
    exportRegions: jest.fn(),
    getGeoJsonString: jest.fn().mockReturnValue('{}'),
    setActiveTool: jest.fn(),
    setWandMode: jest.fn(),
    setWandOptions: jest.fn(),
    clearActiveWandRegion: jest.fn(),
    setBrushMode: jest.fn(),
    setBrushOptions: jest.fn(),
    segmentRectangles: jest.fn().mockResolvedValue(0),
    segmentRectanglesCellpose: jest.fn().mockResolvedValue(0),
    setSamModel: jest.fn(),
    setSamPointMode: jest.fn(),
    commitSamPoints: jest.fn(),
    clearSamPoints: jest.fn(),
    setVertexEraserMode: jest.fn(),
    setVertexEraserRadius: jest.fn(),
    setZoomToBoxMode: jest.fn(),
    getIsosurfaceControls: jest.fn().mockReturnValue(null),
    getIntensityControls: jest.fn().mockReturnValue(null),
    ensureIntensitySampling: jest.fn().mockResolvedValue(undefined),
    refreshIntensitySamplingForRoi: jest.fn(),
    // capability-gated getters (IVisualizer split (e)): none by default
    getOsdViewOptions: jest.fn().mockReturnValue(null),
    getVolumeResolution: jest.fn().mockReturnValue(null),
    getIntensitySampling: jest.fn().mockReturnValue(null),
    // NapariVisualizerService-only: the slice editor's planes and the volume they cut.
    setSlicePlanes: jest.fn(),
    getSlicePlaneMove$: jest.fn().mockReturnValue(new Subject()),
    volumeVoxels: jest.fn().mockReturnValue(null),
  };
}

const IMAGE_INFO: any = { fileName: 'test.tif', isGrayscale: true, imageMeta: [] };

describe('RoutingVisualizerService (characterization)', () => {
  let router: RoutingVisualizerService;
  let plotly: any;
  let osd: any;
  let napari: any;
  let store: VisualizerStore;
  let regionStore: RegionStore;
  let intensity: Record<string, jest.Mock>;

  function setup(): void {
    intensity = {
      getIntensityProfile$: jest.fn().mockReturnValue(of([])),
      setSamplingElement: jest.fn(),
      ensureIntensitySampling: jest.fn().mockResolvedValue(undefined),
      refreshIntensitySamplingForRoi: jest.fn(),
      addProfileLine: jest.fn().mockReturnValue(null),
    };
    plotly = mockBackend();
    osd = mockBackend();
    napari = mockBackend();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        RoutingVisualizerService,
        VisualizerStore,
        { provide: PlotlyService, useValue: plotly },
        { provide: OpenSeadragonVisualizerService, useValue: osd },
        { provide: NapariVisualizerService, useValue: napari },
        { provide: VIZ_CONFIG, useValue: { slideCropServer: '' } },
        { provide: IntensityProfileService, useValue: intensity },
      ],
    });
    router = TestBed.inject(RoutingVisualizerService);
    store = TestBed.inject(VisualizerStore);
    regionStore = TestBed.inject(RegionStore);
  }

  beforeEach(() => setup());

  // ── imported region sources ───────────────────────────────────────────
  describe('imported region sources', () => {
    const open = () => Promise.resolve({ info: { planes: [0] } } as never);
    let attach: jest.SpyInstance;
    beforeEach(() => {
      attach = jest.spyOn(regionStore, 'attachRegionSource').mockImplementation(() => undefined);
      jest.spyOn(regionStore, 'detachRegionSources').mockImplementation(() => undefined);
    });

    it('gives each slice of a stack its own source, every slice emptied first', () => {
      (router as any).plottedInfo = { isStack: true, tiled: false };
      const openers = new Map([
        [0, open],
        [1, open],
        [2, open],
      ]);
      expect(router.importSliceRegionSources(openers)).toBe(3);
      expect(router.isStackMode()).toBe(true);
      expect(router.getStackSaveLayout()).toBe('per-slice-file');
      expect(attach.mock.calls.map((c) => c[1])).toEqual([{ slice: 0 }, { slice: 1 }, { slice: 2 }]);
    });

    it("gives a single image slice 0's source only", () => {
      (router as any).plottedInfo = { isStack: false };
      expect(
        router.importSliceRegionSources(
          new Map([
            [0, open],
            [1, open],
          ]),
        ),
      ).toBe(1);
      expect(attach.mock.calls.map((c) => c[1])).toEqual([{ slice: 0 }]);
    });

    it('lays a served set over every slice when it is z-indexed, else on the slice shown', async () => {
      (router as any).plottedInfo = { isStack: true, tiled: true };
      await router.importRegionSourceOpener(() => Promise.resolve({ info: { planes: [0, 1, 2] } } as never));
      expect(attach.mock.calls[0][1]).toBe('planes');
      expect(router.isStackMode()).toBe(true);
      expect(router.getStackSaveLayout()).toBe('combined');

      attach.mockClear();
      router.setDisplaySlice(1);
      await router.importRegionSourceOpener(open);
      expect(attach.mock.calls[0][1]).toEqual({ slice: 1 });
    });
  });

  // ── regions in 3D ─────────────────────────────────────────────────────
  it('names a 3D build on the loading badge until it settles, once per mesh', async () => {
    const done = jest.fn();
    napari.beginTask = jest.fn().mockReturnValue(done);
    napari.regionVoxelStep = jest.fn().mockReturnValue(2);
    napari.setRegionMeshes = jest.fn();
    const mesh = { vertices: new Float32Array(9), faces: new Uint32Array(3) };
    const build = jest
      .spyOn(regionStore, 'reconstructClasses')
      .mockImplementation(async (groups) => groups.map((g) => ({ key: g.key, mesh })));
    const hpf = { key: 'HPF', classes: ['HPF', 'CA1'], color: '#7ed04b' };

    await router.showRegionClasses3d([hpf]);
    expect(napari.beginTask).toHaveBeenCalledWith('Building HPF in 3D…');
    expect(done).toHaveBeenCalledTimes(1);
    expect(napari.setRegionMeshes).toHaveBeenCalledTimes(1);

    // Built already: no build, no message.
    await router.showRegionClasses3d([hpf]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(napari.beginTask).toHaveBeenCalledTimes(1);

    // A failed build still clears its message.
    build.mockRejectedValueOnce(new Error('no outlines'));
    await expect(router.showRegionClasses3d([{ key: 'CB', classes: ['CB'], color: '#f0f080' }])).rejects.toThrow();
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("drops an image's region surfaces when another image is plotted, not on a re-plot", async () => {
    napari.beginTask = jest.fn().mockReturnValue(() => undefined);
    napari.regionVoxelStep = jest.fn().mockReturnValue(2);
    napari.setRegionMeshes = jest.fn();
    napari.setRegionHighlight = jest.fn();
    const mesh = { vertices: new Float32Array(9), faces: new Uint32Array(3) };
    jest
      .spyOn(regionStore, 'reconstructClasses')
      .mockImplementation(async (groups) => groups.map((g) => ({ key: g.key, mesh })));
    const shown: string[][] = [];
    router.getRegionClasses3d$().subscribe((groups) => shown.push(groups.map((g) => g.key)));

    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.NAPARI_VOLUME);
    await router.showRegionClasses3d([{ key: 'HPF', classes: ['HPF'], color: '#7ed04b' }]);
    expect(napari.setRegionMeshes).toHaveBeenLastCalledWith([expect.objectContaining({ key: 'HPF' })], 'test.tif');

    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(shown[shown.length - 1]).toEqual(['HPF']);

    await router.plot('div', {}, { ...IMAGE_INFO, fileName: 'merfish.zarr' }, 600, PlotType.NAPARI_VOLUME);
    expect(shown[shown.length - 1]).toEqual([]);
    expect(napari.setRegionMeshes).toHaveBeenLastCalledWith([], undefined);
    expect(napari.setRegionHighlight).toHaveBeenLastCalledWith([]);
  });

  // ── the split volume view (slice editor) ─────────────────────────────
  const STACK: any = { ...IMAGE_INFO, isStack: true, urls: ['s0', 's1', 's2'] };

  it('splits a volume view: OSD shows the displayed slice beside it and takes the region tools', async () => {
    osd.getRegionOverlay.mockReturnValue({ kind: 'slice overlay' });
    napari.getRegionOverlay.mockReturnValue({ kind: '3d overlay' });
    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    router.setZIndex(2);
    router.setActiveTool('brush');
    expect(napari.setActiveTool).toHaveBeenLastCalledWith('brush', undefined);

    await expect(router.setSliceEditor('div-slice')).resolves.toBe(true);
    expect(osd.load).toHaveBeenCalledWith(STACK, 2);
    expect(osd.plot).toHaveBeenCalledWith('div-slice', { ok: true }, STACK, 600, PlotType.IMAGE, false);

    // Region, tool and overlay calls act on the slice; view calls stay with the 3D view.
    router.setActiveTool('wand', { sensitivity: 3 });
    expect(osd.setActiveTool).toHaveBeenLastCalledWith('wand', { sensitivity: 3 });
    expect(router.getRegionOverlay()).toEqual({ kind: 'slice overlay' });
    router.setBrushOptions({ size: 9 });
    expect(osd.setBrushOptions).toHaveBeenCalledWith({ size: 9 });
    router.zoomIn();
    expect(napari.zoomIn).toHaveBeenCalled();
    expect(osd.zoomIn).not.toHaveBeenCalled();

    // One slice for both panes.
    router.setZIndex(1);
    expect(osd.setZIndex).toHaveBeenLastCalledWith(1);

    await router.setSliceEditor(null);
    expect(osd.reset).toHaveBeenCalled();
    expect(napari.setSlicePlanes).toHaveBeenLastCalledWith({ x: null, y: null, z: null });
    router.setActiveTool('select');
    expect(napari.setActiveTool).toHaveBeenLastCalledWith('select', undefined);
    expect(router.getRegionOverlay()).toEqual({ kind: '3d overlay' });
  });

  it('cuts the sections through x and y from the volume, and moves the planes with the slice and drags', async () => {
    const settle = () => new Promise((r) => setTimeout(r, 5));
    // A 4 × 3 × 2 volume of an 8 × 6 px image with 2 slices.
    napari.volumeVoxels.mockReturnValue({
      width: 4,
      height: 3,
      depth: 2,
      channels: new Map([[0, new Uint8Array(24).fill(100)]]),
      multichannel: false,
      frame: { size: [8, 6, 2], world: [8, 6, 4] },
    });
    // The plane drags the router subscribed to when it was made.
    const moves = napari.getSlicePlaneMove$.mock.results[0].value as Subject<{ axis: string; value: number }>;
    const views: any[] = [];
    router.getSectionViews$().subscribe((v) => views.push(v));
    const drags: number[] = [];
    router.getSliceDrag$().subscribe((z) => drags.push(z));

    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    router.setZIndex(1);
    await router.setSliceEditor('div-slice');
    await settle();
    // The planes start through the middle of the image.
    expect(napari.setSlicePlanes).toHaveBeenLastCalledWith({ x: 4, y: 3, z: 1 });
    const { x, y } = views[views.length - 1];
    expect(x.size).toEqual([2, 6]); // slices across, y down
    expect(x.scale).toEqual([2, 1]); // a slice is twice a pixel deep in the volume
    expect([x.image.width, x.image.height]).toEqual([2, 3]);
    expect(x.crosshair).toEqual({ u: 1.5, v: 3 });
    expect(y.size).toEqual([8, 2]);
    expect(y.crosshair).toEqual({ u: 4, v: 1.5 });

    // A plane dragged in the volume: x moves its section, z picks the slice through the host.
    moves.next({ axis: 'x', value: 6.4 });
    moves.next({ axis: 'z', value: 0.4 });
    await settle();
    expect(drags).toEqual([0]);
    expect(napari.setSlicePlanes).toHaveBeenLastCalledWith({ x: 6.4, y: 3, z: 1 });
    router.setSectionPlane('y', 99); // clamped into the image
    router.setZIndex(0);
    await settle();
    expect(napari.setSlicePlanes).toHaveBeenLastCalledWith({ x: 6.4, y: 5, z: 0 });
    expect(views[views.length - 1].y.at).toBe(5);

    await router.setSliceEditor(null);
    expect(views[views.length - 1]).toEqual({ x: null, y: null });
  });

  it('takes the slice pane down for another plot type and brings it back with the volume view', async () => {
    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    await router.setSliceEditor('div-slice');
    osd.plot.mockClear();

    await router.plot('div', {}, STACK, 600, PlotType.HEATMAP);
    expect(osd.reset).toHaveBeenCalled();
    expect(osd.plot).not.toHaveBeenCalled();
    router.setZIndex(1);
    expect(osd.setZIndex).not.toHaveBeenCalledWith(1);

    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    await Promise.resolve();
    expect(osd.plot).toHaveBeenCalledWith('div-slice', { ok: true }, STACK, 600, PlotType.IMAGE, false);
  });

  it('shows another image in the slice pane when the volume view plots it, and nothing without a stack', async () => {
    await expect(router.setSliceEditor('div-slice')).resolves.toBe(false); // nothing plotted yet
    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    await router.setSliceEditor('div-slice');
    osd.plot.mockClear();
    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME); // a re-plot of the same image
    await Promise.resolve();
    expect(osd.plot).not.toHaveBeenCalled();
    const other = { ...STACK, fileName: 'other.tif' };
    await router.plot('div', {}, other, 600, PlotType.NAPARI_VOLUME);
    await Promise.resolve();
    expect(osd.plot).toHaveBeenCalledWith('div-slice', { ok: true }, other, 600, PlotType.IMAGE, false);
  });

  it('rebuilds the 3D surfaces of the classes an edit touched once edits pause, not on a slice switch', async () => {
    jest.useFakeTimers();
    try {
      napari.beginTask = jest.fn().mockReturnValue(() => undefined);
      napari.regionVoxelStep = jest.fn().mockReturnValue(2);
      napari.setRegionMeshes = jest.fn();
      const mesh = { vertices: new Float32Array(9), faces: new Uint32Array(3) };
      const build = jest
        .spyOn(regionStore, 'reconstructClasses')
        .mockImplementation(async (groups) => groups.map((g) => ({ key: g.key, mesh })));
      const square = (label: string, x: number) =>
        Object.assign(new Region(), {
          label,
          bounds: Object.assign(new Rectangle(), { x, y: 0, width: 10, height: 10 }),
        });
      regionStore.enterStackMode(new Map([[0, [square('HPF', 0)]]]), 0, 'combined');
      await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
      await router.showRegionClasses3d([
        { key: 'HPF', classes: ['HPF', 'CA1'], color: '#7ed04b' },
        { key: 'CB', classes: ['CB'], color: '#f0f080' },
      ]);
      expect(build).toHaveBeenCalledTimes(1);

      // Drawing CA1 (in HPF's group) twice in a row: one rebuild, of HPF only, after the pause.
      regionStore.addRegion(square('CA1', 20));
      regionStore.addRegion(square('CA1', 40));
      await jest.advanceTimersByTimeAsync(300);
      expect(build).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(400);
      expect(build).toHaveBeenCalledTimes(2);
      expect(build.mock.calls[1][0].map((g) => g.key)).toEqual([expect.stringContaining('HPF,CA1')]);

      // A class not shown in 3D, or another slice coming up: nothing to rebuild.
      regionStore.addRegion(square('MB', 60));
      regionStore.setDisplaySlice(1);
      await jest.advanceTimersByTimeAsync(1000);
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("cuts another image's sections from its own outlines, with the planes back through its middle", async () => {
    const settle = () => new Promise((r) => setTimeout(r, 5));
    const volume = (size: number) => ({
      width: 4,
      height: 4,
      depth: 2,
      channels: new Map([[0, new Uint8Array(32)]]),
      multichannel: false,
      frame: { size: [size, size, 2], world: [size, size, 2] },
    });
    const read = jest.spyOn(regionStore, 'outlinesByClass').mockResolvedValue(new Map());
    napari.volumeVoxels.mockReturnValue(volume(100));
    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    await router.setSliceEditor('div-slice');
    await settle();
    router.setSectionPlane('x', 90);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    napari.volumeVoxels.mockReturnValue(volume(40));
    await router.plot('div', {}, { ...STACK, fileName: 'other.tif' }, 600, PlotType.NAPARI_VOLUME);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(napari.setSlicePlanes).toHaveBeenLastCalledWith({ x: 20, y: 20, z: 0 });
  });

  it('reads the outlines again on the next cut when a read fails', async () => {
    const settle = () => new Promise((r) => setTimeout(r, 5));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    napari.volumeVoxels.mockReturnValue({
      width: 4,
      height: 4,
      depth: 2,
      channels: new Map([[0, new Uint8Array(32)]]),
      multichannel: false,
      frame: { size: [8, 8, 2], world: [8, 8, 2] },
    });
    const read = jest
      .spyOn(regionStore, 'outlinesByClass')
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(new Map());
    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    await router.setSliceEditor('div-slice');
    await settle();
    expect(warn).toHaveBeenCalled();
    router.setSectionPlane('x', 2);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('takes the sections and planes down when the view is detached', async () => {
    const views: any[] = [];
    router.getSectionViews$().subscribe((v) => views.push(v));
    await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
    await router.setSliceEditor('div-slice');
    router.detach();
    expect(napari.setSlicePlanes).toHaveBeenLastCalledWith({ x: null, y: null, z: null });
    expect(views[views.length - 1]).toEqual({ x: null, y: null });
  });

  it('rebuilds every shown surface when source features are deleted (no live region changes)', async () => {
    jest.useFakeTimers();
    try {
      napari.beginTask = jest.fn().mockReturnValue(() => undefined);
      napari.regionVoxelStep = jest.fn().mockReturnValue(2);
      napari.setRegionMeshes = jest.fn();
      const mesh = { vertices: new Float32Array(9), faces: new Uint32Array(3) };
      const build = jest
        .spyOn(regionStore, 'reconstructClasses')
        .mockImplementation(async (groups) => groups.map((g) => ({ key: g.key, mesh })));
      const sources = jest.spyOn(regionStore, 'getSourceStateKey').mockReturnValue('before');
      await router.plot('div', {}, STACK, 600, PlotType.NAPARI_VOLUME);
      await router.showRegionClasses3d([{ key: 'CB', classes: ['CB'], color: '#f0f080' }]);
      expect(build).toHaveBeenCalledTimes(1);

      // The update a delete makes: the sources hold less, the live regions are as they were.
      sources.mockReturnValue('after');
      regionStore.addRegion(new Region());
      await jest.advanceTimersByTimeAsync(1000);
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  // ── backend selection per plot type ───────────────────────────────────
  it('routes the IMAGE plot type to OpenSeadragon', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(osd.plot).toHaveBeenCalled();
    expect(plotly.plot).not.toHaveBeenCalled();
  });

  it.each([PlotType.HEATMAP, PlotType.SURFACE, PlotType.CONTOUR, PlotType.SCATTER, PlotType.ISOSURFACE])(
    'routes %s to Plotly',
    async (type) => {
      await router.plot('div', {}, IMAGE_INFO, 600, type);
      expect(plotly.plot).toHaveBeenCalled();
      expect(osd.plot).not.toHaveBeenCalled();
    },
  );

  // ── contributed plot modes ride on the backend on screen ─────────────
  it('hands a contributed plot mode the viewport of the backend on screen, or null', async () => {
    const viewport = { kind: 'osd-viewport' };
    osd.getPlotModeViewport = jest.fn().mockReturnValue(viewport);
    expect(router.getPlotModeViewport()).toBeNull(); // Plotly before any plot: none
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(router.getPlotModeViewport()).toBe(viewport);
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.HEATMAP);
    expect(router.getPlotModeViewport()).toBeNull();
  });

  it('always applies the per-image region cache through Plotly (setActiveImage), whichever backend renders', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(plotly.setActiveImage).toHaveBeenCalledWith(IMAGE_INFO);
  });

  // ── teardown on backend switch ────────────────────────────────────────
  it('purges Plotly (not reset) when switching Plotly → OSD, and resets OSD when switching back', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.HEATMAP); // lastRendered = plotly
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(plotly.purgePlot).toHaveBeenCalledTimes(1);
    expect(plotly.reset).not.toHaveBeenCalled();

    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.HEATMAP); // OSD → plotly
    expect(osd.reset).toHaveBeenCalledTimes(1);
  });

  it('does not tear anything down when re-plotting on the same backend', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.HEATMAP);
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.HEATMAP);
    expect(plotly.purgePlot).not.toHaveBeenCalled();
    expect(osd.reset).not.toHaveBeenCalled();
  });

  // ── OSD load-failure fallback lifecycle ───────────────────────────────
  it('falls back to Plotly for THIS image when the OSD load fails, then re-arms OSD on reset()', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    osd.load.mockRejectedValueOnce(new Error('still caching'));

    await router.load(IMAGE_INFO, 0); // currentPlotType defaults to IMAGE
    expect(plotly.load).toHaveBeenCalledTimes(1);

    // The fallback is sticky for the current render cycle…
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(plotly.plot).toHaveBeenCalledTimes(1);
    expect(osd.plot).not.toHaveBeenCalled();

    // …and cleared by reset() (start of the next cycle) so OSD is retried.
    router.reset();
    await router.load(IMAGE_INFO, 0);
    expect(osd.load).toHaveBeenCalledTimes(2); // first (failed) + retried
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(osd.plot).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('passes the abort signal through to the backend load (CORE-11)', async () => {
    router.setPlotType(PlotType.IMAGE);
    const signal = new AbortController().signal;
    await router.load(IMAGE_INFO, 0, signal);
    expect(osd.load).toHaveBeenCalledWith(IMAGE_INFO, 0, signal);
  });

  it('does not fall back to another backend for a load that was aborted', async () => {
    router.setPlotType(PlotType.IMAGE);
    const ctl = new AbortController();
    osd.load.mockImplementation(() => {
      ctl.abort();
      return Promise.reject(new Error('aborted'));
    });
    await expect(router.load(IMAGE_INFO, 0, ctl.signal)).rejects.toThrow('aborted');
    expect(plotly.load).not.toHaveBeenCalled();
  });

  it('loads through OSD when it succeeds (no Plotly load)', async () => {
    await router.load(IMAGE_INFO, 0);
    expect(osd.load).toHaveBeenCalled();
    expect(plotly.load).not.toHaveBeenCalled();
  });

  // ── renderer() delegation (defaults to Plotly before any plot) ────────
  it('delegates histogram + exports to the active renderer (Plotly before any plot)', () => {
    router.getHistogram(0, 256);
    router.getHistogram$(0, 256);
    router.exportComposite();
    router.exportData();
    expect(plotly.getHistogram).toHaveBeenCalledWith(0, 256);
    expect(plotly.getHistogram$).toHaveBeenCalledWith(0, 256);
    expect(plotly.exportComposite).toHaveBeenCalled();
    expect(plotly.exportData).toHaveBeenCalled();
  });

  it('getMaskImageSize reports the active renderer image size (jit-ui#95)', () => {
    jest.spyOn(plotly, 'getTrueImageSize').mockReturnValue({ width: 8, height: 6 });
    expect(router.getMaskImageSize()).toEqual({ width: 8, height: 6 });
  });

  it('getMaskImageSize returns null when the image size is unknown', () => {
    jest.spyOn(plotly, 'getTrueImageSize').mockReturnValue(null);
    router.setImageMeta([]);
    expect(router.getMaskImageSize()).toBeNull();
  });

  it('getMaskImageSize falls back to image metadata when the renderer size is non-finite (jit-ui#95)', () => {
    // Plotly bounds can produce NaN before a plot is laid out.
    jest.spyOn(plotly, 'getTrueImageSize').mockReturnValue({ width: NaN, height: NaN });
    router.setImageMeta([{ channelCount: 1, rgbChannels: 1, x: 1024, y: 768, z: 1 }]);
    expect(router.getMaskImageSize()).toEqual({ width: 1024, height: 768 });
  });

  it('getMaskImageSize returns null when neither renderer nor metadata give a valid size', () => {
    jest.spyOn(plotly, 'getTrueImageSize').mockReturnValue({ width: NaN, height: NaN });
    router.setImageMeta([]);
    expect(router.getMaskImageSize()).toBeNull();
  });

  it('delegates histogram to OSD once OSD is the active renderer', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    router.getHistogram(1, 256);
    expect(osd.getHistogram).toHaveBeenCalledWith(1, 256);
    expect(plotly.getHistogram).not.toHaveBeenCalled();
  });

  // Updated by refactoring-plan Step 1: reads come straight from the shared
  // store (the old router→plotly→store double-hop is gone); the SETTERS still
  // route through Plotly because they carry a live restyle side effect.
  it('display-option reads come from the store; setters route through Plotly (restyle glue)', async () => {
    store.setColormap('Greens'); // direct store write — what reads must surface
    await expect(firstValueFrom(router.getColormap())).resolves.toBe('Greens');
    expect(plotly.getColormap).not.toHaveBeenCalled();

    const reds = { label: 'Reds', data: { value: 'Reds' } };
    router.setColormap(reds);
    router.setReverseScale(true);
    expect(plotly.setColormap).toHaveBeenCalledWith(reds);
    expect(plotly.setReverseScale).toHaveBeenCalledWith(true);
  });

  it('3D scene controls always come from Plotly (capability-gated)', () => {
    expect(router.getSurface3dControls()).toEqual({ kind: '3d' });
    expect(plotly.getSurface3dControls).toHaveBeenCalled();
  });

  // ── region-overlay fallback ───────────────────────────────────────────
  it('falls back to the Plotly overlay when OSD is active but has no overlay yet', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    osd.getRegionOverlay.mockReturnValue(null);
    const overlay = router.getRegionOverlay();
    expect(plotly.getRegionOverlay).toHaveBeenCalled();
    expect(overlay).toEqual({ kind: 'overlay' });
  });

  // ── annotation vs profile-line filtering (IRegionEditorApi) ───────────
  it('getAnnotationRegions excludes intensity-profile lines', () => {
    const profile = { id: 1, kind: 'profile' };
    const annotation = { id: 2 };
    jest.spyOn(regionStore, 'getRegions').mockReturnValue([profile, annotation] as unknown as Region[]);
    expect(router.getAnnotationRegions()).toEqual([annotation]);
  });

  it('setAnnotationRegions preserves existing profile lines and never appends', () => {
    const profile = { id: 1, kind: 'profile' };
    jest.spyOn(regionStore, 'getRegions').mockReturnValue([profile, { id: 2 }] as unknown as Region[]);
    const write = jest.spyOn(regionStore, 'setRegions').mockImplementation(() => undefined);
    const next: any = [{ id: 3 }];
    router.setAnnotationRegions(next, true, false, '#fff');
    expect(write).toHaveBeenCalledWith([{ id: 3 }, profile], true, false, '#fff', false);
  });

  // ── auto-contrast windowing math ──────────────────────────────────────
  function seedChannel(): void {
    const ch: IChannelState = {
      index: 0,
      name: 'Intensity',
      color: '#ffffff',
      min: 0,
      max: 255,
      gamma: 1,
      visible: true,
    };
    store.setChannelStates([ch]);
  }

  it('autoContrast picks the saturation window from the renderer histogram', () => {
    seedChannel();
    const h: IHistogram = {
      bins: [0, 1, 2, 3, 4, 5, 6, 7],
      counts: [0, 10, 20, 40, 20, 10, 0, 0],
      max: 40,
    };
    plotly.getHistogram.mockReturnValue(h);
    router.autoContrast([0], 0.001);
    const after = store.currentChannelStates()[0];
    expect(after.min).toBe(1);
    expect(after.max).toBe(5);
  });

  it('autoContrast drops a dominant first bin (background/padding) before windowing', () => {
    seedChannel();
    const h: IHistogram = {
      bins: [0, 1, 2, 3, 4],
      counts: [50, 10, 20, 10, 5], // counts[0] > counts[1] → zeroed
      max: 50,
    };
    plotly.getHistogram.mockReturnValue(h);
    router.autoContrast([0], 0.001);
    const after = store.currentChannelStates()[0];
    expect(after.min).toBe(1);
    expect(after.max).toBe(4);
  });

  it('autoContrast leaves the window untouched when the histogram is unavailable', () => {
    seedChannel();
    plotly.getHistogram.mockReturnValue(null);
    router.autoContrast([0], 0.001);
    const after = store.currentChannelStates()[0];
    expect(after.min).toBe(0);
    expect(after.max).toBe(255);
  });

  // ── channel state goes to the store, not a backend ────────────────────
  it('setChannelState writes the shared store (both backends subscribe)', () => {
    seedChannel();
    router.setChannelState(0, { min: 10, max: 200 });
    const after = store.currentChannelStates()[0];
    expect(after.min).toBe(10);
    expect(after.max).toBe(200);
  });

  // ── render/viewport/region/tool delegation → active renderer ──────────
  // Before any plot, renderer() is the Plotly default.
  it.each<[string, any[]]>([
    ['relayout', [[10, 20]]],
    ['resetAxes', []],
    ['fitToView', []],
    ['zoomIn', []],
    ['zoomOut', []],
    ['setDragMode', ['pan']],
    ['setShowStack', [true]],
    ['setZIndex', [3]],
    ['getTrueImageSize', []],
    ['getCurrentImage', []],
    ['getDisplayedPixelData', []],
    ['getDisplayedSourceRect', []],
    ['downloadImage', []],
    ['exportComposite', []],
    ['exportData', []],
    ['setActiveTool', ['wand', { sensitivity: 2 }]],
    ['setActiveTool', [null, undefined]],
    ['setWandMode', [true, { sensitivity: 2 }]],
    ['setWandOptions', [{ sensitivity: 2 }]],
    ['clearActiveWandRegion', []],
    ['setBrushMode', [true, { size: 40 }]],
    ['setBrushOptions', [{ size: 40 }]],
    ['segmentRectangles', []],
    ['segmentRectanglesCellpose', []],
    ['setSamModel', ['microsam-vit-b-lm']],
    ['setSamPointMode', [true]],
    ['commitSamPoints', []],
    ['clearSamPoints', []],
    ['setVertexEraserMode', [true]],
    ['setVertexEraserRadius', [5]],
    ['setZoomToBoxMode', [true]],
    ['getHistogram', [0, 256]],
    ['getHistogram$', [0, 256]],
  ])('routes %s to the active renderer (Plotly before any plot)', (method, args) => {
    (router as any)[method](...args);
    expect(plotly[method]).toHaveBeenCalledWith(...args);
    expect(osd[method]).not.toHaveBeenCalled();
  });

  // ── region reads and plain writes come straight from the shared stores (IVisualizer split (d)) ──
  it.each<[string, unknown[], 'region' | 'display']>([
    ['getRegions', [], 'region'],
    ['getRegionPolygons', [], 'region'],
    ['getRegionUpdateEvent', [], 'region'],
    ['getSelectedShapeIndices$', [], 'region'],
    ['getShowShapeLabel', [], 'region'],
    ['getShapeColor', [], 'region'],
    ['getFillColor', [], 'region'],
    ['canUndo', [], 'region'],
    ['canRedo', [], 'region'],
    ['getCanUndo$', [], 'region'],
    ['getCanRedo$', [], 'region'],
    ['resetUndoHistory', [], 'region'],
    ['importRegions', ['{"type":"FeatureCollection","features":[]}'], 'region'],
    ['getGeoJsonString', [[]], 'region'],
    ['isStackMode', [], 'region'],
    ['exitStackMode', [], 'region'],
    ['getStackSaveLayout', [], 'region'],
    ['getSliceRegions', [], 'region'],
    ['getStackSaveSlices', [], 'region'],
    // the writes too (step (d)): every backend redraws from the store's events
    ['setRegions', [[], true, false, '#fff', false], 'region'],
    ['setSelectedShapeIndices', [[0, 1]], 'region'],
    ['selectRegion', [{ id: 1 }], 'region'],
    ['deleteActiveShape', [], 'region'],
    ['undo', [], 'region'],
    ['redo', [], 'region'],
    ['setDisplaySlice', [2], 'region'],
    ['getClassificationColors', [], 'display'],
    ['setClassificationColor', ['tumour', '#ffffff'], 'display'],
  ])('serves %s from the shared store, not a backend', async (method, args, owner) => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE); // OSD on screen
    const target = (owner === 'region' ? regionStore : store) as unknown as Record<string, () => unknown>;
    const spy = jest.spyOn(target, method);
    (router as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
    expect(spy).toHaveBeenCalledWith(...args);
    for (const backend of [plotly, osd, napari]) {
      if (backend[method]) expect(backend[method]).not.toHaveBeenCalled();
    }
  });

  it('exports regions through the store, named after the image last plotted', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    const spy = jest.spyOn(regionStore, 'exportRegions').mockImplementation(() => undefined);
    router.exportRegions([]);
    expect(spy).toHaveBeenCalledWith([], 'test.tif');
    for (const backend of [plotly, osd, napari]) expect(backend.exportRegions).not.toHaveBeenCalled();
  });

  it('switches delegation to OSD once an IMAGE plot makes it the active renderer', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    router.zoomIn();
    router.setDragMode('pan');
    router.setZIndex(2);
    router.setActiveTool('brush', { size: 8 });
    expect(osd.zoomIn).toHaveBeenCalled();
    expect(osd.setActiveTool).toHaveBeenCalledWith('brush', { size: 8 });
    expect(plotly.setActiveTool).not.toHaveBeenCalled();
    expect(osd.setDragMode).toHaveBeenCalledWith('pan');
    expect(osd.setZIndex).toHaveBeenCalledWith(2);
  });

  // ── methods pinned to a specific backend, regardless of the renderer ──
  it.each<[string, any[]]>([
    ['getPlotTypeDescriptors', []],
    ['setStackLoading', [true]],
    ['isStackLoading', []],
    ['getStackLoadingProgress', []],
    ['getAutoscaleEvent', []],
    ['renderIntensityInset', ['div', []]],
    ['setColormap', ['Reds']],
    ['setReverseScale', [true]],
    ['getIsosurfaceControls', []],
    ['getSurface3dControls', []],
  ])('routes %s to Plotly (the full-featured backend)', (method, args) => {
    (router as any)[method](...args);
    expect(plotly[method]).toHaveBeenCalledWith(...args);
  });

  it('the deprecated autoscale is fitToView; the 3D camera members go through getSurface3dControls()', () => {
    router.autoscale();
    expect(plotly.fitToView).toHaveBeenCalledTimes(1);
    const controls = { setSurfaceDragMode: jest.fn(), resetSurfaceCamera: jest.fn() };
    plotly.getSurface3dControls.mockReturnValue(controls);
    router.setSurfaceDragMode('orbit');
    router.resetSurfaceCamera();
    expect(controls.setSurfaceDragMode).toHaveBeenCalledWith('orbit');
    expect(controls.resetSurfaceCamera).toHaveBeenCalled();
    plotly.getSurface3dControls.mockReturnValue(null); // a 2D-only backend: a no-op, not a throw
    expect(() => router.resetSurfaceCamera()).not.toThrow();
  });

  it('surfaces the autoscale event of every backend, not only Plotly (CORE-5)', () => {
    const osdAutoscale = new Subject<void>();
    const napariAutoscale = new Subject<void>();
    osd.getAutoscaleEvent.mockReturnValue(osdAutoscale);
    napari.getAutoscaleEvent.mockReturnValue(napariAutoscale);
    const seen = jest.fn();
    const sub = router.getAutoscaleEvent().subscribe(seen);
    osdAutoscale.next();
    napariAutoscale.next();
    expect(seen).toHaveBeenCalledTimes(2);
    sub.unsubscribe();
  });

  it('forwards the image key with the image meta to the store (CORE-8)', () => {
    const spy = jest.spyOn(store, 'setImageMeta');
    router.setImageMeta([], 'a.tif');
    expect(spy).toHaveBeenCalledWith([], 'a.tif');
  });

  it('setPlotType records the type and delegates to Plotly', () => {
    router.setPlotType(PlotType.HEATMAP);
    expect(plotly.setPlotType).toHaveBeenCalledWith(PlotType.HEATMAP);
  });

  // ── capability-gated extras (IVisualizer split (e)) ─────────────────────
  function viewOptions() {
    return { setNavigatorVisible: jest.fn(), setImageSmoothingEnabled: jest.fn() };
  }

  it('applies the view options to every backend that has them, before any render', () => {
    const osdOpts = viewOptions();
    const napariOpts = viewOptions();
    osd.getOsdViewOptions.mockReturnValue(osdOpts);
    napari.getOsdViewOptions.mockReturnValue(napariOpts); // Plotly has none (null)
    router.getOsdViewOptions().setNavigatorVisible(false);
    router.getOsdViewOptions().setImageSmoothingEnabled(true);
    for (const o of [osdOpts, napariOpts]) {
      expect(o.setNavigatorVisible).toHaveBeenCalledWith(false);
      expect(o.setImageSmoothingEnabled).toHaveBeenCalledWith(true);
    }
    // The deprecated always-on members are the same fan-out.
    router.setNavigatorVisible(true);
    router.setImageSmoothingEnabled(false);
    for (const o of [osdOpts, napariOpts]) {
      expect(o.setNavigatorVisible).toHaveBeenLastCalledWith(true);
      expect(o.setImageSmoothingEnabled).toHaveBeenLastCalledWith(false);
    }
  });

  it('serves the volume resolution of the backend on screen; the old members go through it', async () => {
    expect(router.getVolumeResolution()).toBeNull(); // Plotly before any plot
    expect(router.getResolutionScale()).toBe(1);
    expect(() => router.setResolutionScale(4)).not.toThrow();

    const resolution = { get: jest.fn().mockReturnValue(2), set: jest.fn() };
    napari.getVolumeResolution.mockReturnValue(resolution);
    router.setPlotType(PlotType.NAPARI_VOLUME);
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.NAPARI_VOLUME);
    expect(router.getVolumeResolution()).toBe(resolution);
    expect(router.getResolutionScale()).toBe(2);
    router.setResolutionScale(8);
    expect(resolution.set).toHaveBeenCalledWith(8);
  });

  it('merges the viewport changes of every backend that reports them (OSD, napari-js)', () => {
    const osd$ = new Subject<{ x: number; y: number; width: number; height: number }>();
    const napari$ = new Subject<{ x: number; y: number; width: number; height: number }>();
    osd.getIntensitySampling.mockReturnValue({ getViewportChange$: () => osd$ });
    napari.getIntensitySampling.mockReturnValue({ getViewportChange$: () => napari$ });
    const seen: number[] = [];
    router
      .getIntensitySampling()
      .getViewportChange$()
      .subscribe((r) => seen.push(r.x));
    router.getViewportChange$().subscribe((r) => seen.push(r.x * 10)); // deprecated alias
    osd$.next({ x: 1, y: 0, width: 1, height: 1 });
    napari$.next({ x: 2, y: 0, width: 1, height: 1 });
    expect(seen).toEqual([1, 10, 2, 20]);
  });

  it('the deprecated sampling members go through getIntensitySampling()', async () => {
    await router.plot('viz-plot-2', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    const sampling = router.getIntensitySampling();
    await sampling.ensureIntensitySampling(IMAGE_INFO, 1);
    sampling.refreshIntensitySamplingForRoi(0, 0, 5, 5, 1);
    expect(intensity['ensureIntensitySampling']).toHaveBeenCalledWith(IMAGE_INFO, 1);
    expect(intensity['refreshIntensitySamplingForRoi']).toHaveBeenCalledWith(0, 0, 5, 5, 1);
    expect(intensity['setSamplingElement']).toHaveBeenCalledWith('viz-plot-2');
  });

  it('detach detaches every backend; unsubscribe is its deprecated alias (CORE-1)', () => {
    router.detach();
    for (const b of [plotly, osd, napari]) expect(b.detach).toHaveBeenCalledTimes(1);
    router.unsubscribe();
    for (const b of [plotly, osd, napari]) expect(b.detach).toHaveBeenCalledTimes(2);
  });

  it('detach also disposes the napari-js viewer and forgets the backend on screen (CORE-7)', async () => {
    await router.load(IMAGE_INFO, 0);
    router.setPlotType(PlotType.NAPARI_VOLUME);
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.NAPARI_VOLUME);
    expect(napari.plot).toHaveBeenCalled();
    router.detach();
    expect(napari.detach).toHaveBeenCalled();
    // Nothing is on screen any more: delegation falls back to the Plotly default.
    router.zoomIn();
    expect(plotly.zoomIn).toHaveBeenCalled();
    expect(napari.zoomIn).not.toHaveBeenCalled();
  });

  it('getIsosurfaceControls is Plotly-owned before any plot', () => {
    router.getIsosurfaceControls();
    expect(plotly.getIsosurfaceControls).toHaveBeenCalled();
  });

  // ── intensity profiles: the backend-neutral IntensityProfileService, not Plotly ──
  it('serves the profiles and the line controls from the IntensityProfileService on any backend', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE); // OSD on screen
    router.getIntensityProfile$();
    expect(intensity['getIntensityProfile$']).toHaveBeenCalled();
    expect(router.getIntensityControls()).toBe(intensity);
    for (const b of [plotly, osd, napari]) {
      expect(b.getIntensityProfile$).not.toHaveBeenCalled();
      expect(b.getIntensityControls).not.toHaveBeenCalled();
    }
  });

  it('samples through the IntensityProfileService, sizing crops from the plotted div', async () => {
    await router.plot('viz-plot-1', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    await router.ensureIntensitySampling(IMAGE_INFO, 2);
    router.refreshIntensitySamplingForRoi(1, 2, 3, 4, 2);
    expect(intensity['ensureIntensitySampling']).toHaveBeenCalledWith(IMAGE_INFO, 2);
    expect(intensity['refreshIntensitySamplingForRoi']).toHaveBeenCalledWith(1, 2, 3, 4, 2);
    // Each call points the service at the plot div first.
    expect(intensity['setSamplingElement'].mock.calls).toEqual([['viz-plot-1'], ['viz-plot-1']]);
    expect(intensity['setSamplingElement'].mock.invocationCallOrder[1]).toBeLessThan(
      intensity['refreshIntensitySamplingForRoi'].mock.invocationCallOrder[0],
    );
    for (const b of [plotly, osd, napari]) expect(b.refreshIntensitySamplingForRoi).not.toHaveBeenCalled();
  });

  it('keeps rendering the inset through Plotly', () => {
    router.renderIntensityInset('inset', []);
    expect(plotly.renderIntensityInset).toHaveBeenCalledWith('inset', []);
  });

  // ── display + channel state read/write the shared store ───────────────
  it('reverse-scale and image-meta reads come from the store', async () => {
    store.setReverseScale(true);
    await expect(firstValueFrom(router.getReverseScale())).resolves.toBe(true);
    const meta: any = [{ channelCount: 1, rgbChannels: 1, x: 4, y: 4, z: 1 }];
    router.setImageMeta(meta);
    await expect(firstValueFrom(router.getImageMeta())).resolves.toEqual(meta);
  });

  it('grayscale and invert toggles round-trip through the store', async () => {
    router.setGrayscale(true);
    router.setInvert(true);
    await expect(firstValueFrom(router.getGrayscale$())).resolves.toBe(true);
    await expect(firstValueFrom(router.getInvert$())).resolves.toBe(true);
  });

  it('resetContrast restores a channel to its default window (0..255, gamma 1)', () => {
    seedChannel();
    router.setChannelState(0, { min: 30, max: 90, gamma: 2 });
    router.resetContrast([0]);
    const after = store.currentChannelStates()[0];
    expect(after.min).toBe(0);
    expect(after.max).toBe(255);
    expect(after.gamma).toBe(1);
  });

  it('getChannels$ surfaces the store channel states', async () => {
    seedChannel();
    const chans = await firstValueFrom(router.getChannels$());
    expect(chans).toHaveLength(1);
    expect(chans[0].name).toBe('Intensity');
  });
});

/**
 * The spatial controls are implemented on the ROUTER rather than a backend
 * because the state is backend-neutral (it lives in the shared store, like the
 * colormap) — so they must work with no backend mounted and survive a plot-type
 * switch. These pin that, plus the two pieces with real logic: the feature
 * search fallback and the legend colours.
 */
describe('RoutingVisualizerService — spatial controls', () => {
  const dataset: SpatialDataset = {
    id: 'demo',
    name: 'Demo',
    observations: { count: 2, x: new Float32Array(2), y: new Float32Array(2) },
    columns: [
      { kind: 'categorical', name: 'region', categories: ['A', 'B'], colors: ['#ff0000', '#0000ff'] },
      { kind: 'continuous', name: 'counts' },
    ],
    features: { count: 3, names: ['Ttr', 'Fth1', 'Mbp'] },
  };

  function build(port: unknown | null) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        RoutingVisualizerService,
        VisualizerStore,
        { provide: PlotlyService, useValue: mockBackend() },
        { provide: OpenSeadragonVisualizerService, useValue: mockBackend() },
        { provide: NapariVisualizerService, useValue: mockBackend() },
        { provide: VIZ_CONFIG, useValue: { slideCropServer: '' } },
        { provide: IntensityProfileService, useValue: {} },
        ...(port ? [{ provide: SPATIAL_DATA_PORT, useValue: port }] : []),
      ],
    });
    return {
      router: TestBed.inject(RoutingVisualizerService),
      store: TestBed.inject(VisualizerStore),
    };
  }

  function mockPort(over: Record<string, unknown> = {}) {
    return {
      getDataset$: () => new BehaviorSubject<SpatialDataset | null>(dataset),
      getColumn: jest.fn(),
      getFeatureVector: jest.fn(),
      ...over,
    };
  }

  /** A rectangle ROI in world coordinates. */
  function roi(x: number, y: number, w: number, h: number): Region {
    const r = new Region();
    const b = new Rectangle();
    b.x = x;
    b.y = y;
    b.width = w;
    b.height = h;
    r.bounds = b;
    return r;
  }

  describe('log scaling', () => {
    it('seeds the toggle from the source hint, and lets an explicit off win', () => {
      // The hint used to be ORed in at render time, so an unchecked box could not
      // turn log scaling off for a hinted column — and the linked chart, which
      // reads `logScale` alone, disagreed with the map about what it showed.
      const hinted: SpatialDataset = {
        ...dataset,
        columns: [{ kind: 'continuous', name: 'total_counts', logScaleHint: true }],
        features: { count: 1, names: ['Ttr'], logScaleHint: true },
      };
      const { router, store } = build(
        mockPort({
          getDataset$: () => new BehaviorSubject<SpatialDataset | null>(hinted),
        }),
      );
      const controls = router.getSpatialControls()!;

      controls.colorByColumn('total_counts');
      expect(store.currentSpatialView().logScale).toBe(true);

      // Explicitly off, and it stays off — nothing consults the hint again.
      controls.setViewState({ logScale: false });
      expect(store.currentSpatialView().logScale).toBe(false);

      // A gene carries its own hint, and re-seeds on the switch.
      controls.colorByFeature('Ttr');
      expect(store.currentSpatialView().logScale).toBe(true);
    });

    it('clears the toggle for a source with no hint', () => {
      const { router, store } = build(mockPort());
      const controls = router.getSpatialControls()!;
      controls.setViewState({ logScale: true });

      controls.colorByColumn('counts'); // continuous, no hint
      expect(store.currentSpatialView().logScale).toBe(false);
    });
  });

  describe('on a dataset change', () => {
    it('drops a colour source the new dataset cannot satisfy, and keeps the rest', async () => {
      const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
      const { router, store } = build(mockPort({ getDataset$: () => dataset$ }));
      const controls = router.getSpatialControls()!;

      controls.colorByColumn('region');
      controls.setViewState({ pointScale: 3 });
      expect(store.currentSpatialView().colorBy).toEqual({ kind: 'column', name: 'region' });

      // A different dataset with no `region`: keeping the source would leave the
      // map flat while the panel and the charts kept naming it.
      dataset$.next({
        ...dataset,
        id: 'other',
        columns: [{ kind: 'categorical', name: 'zone', categories: ['Z'] }],
      });

      expect(store.currentSpatialView().colorBy).toBeNull();
      // Display preferences are the user's, not the previous dataset's state.
      expect(store.currentSpatialView().pointScale).toBe(3);
    });

    it('keeps a colour source the new dataset still has', () => {
      const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
      const { router, store } = build(mockPort({ getDataset$: () => dataset$ }));
      router.getSpatialControls()!.colorByColumn('region');

      dataset$.next({ ...dataset, id: 'other' }); // same columns

      expect(store.currentSpatialView().colorBy).toEqual({ kind: 'column', name: 'region' });
    });

    it('keeps a gene when the new dataset is too wide to inline its names', () => {
      const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
      const { router, store } = build(mockPort({ getDataset$: () => dataset$ }));
      router.getSpatialControls()!.colorByFeature('Ttr');

      // Typeahead-only: the names are not there to check against, so a name that
      // turns out not to exist should surface as a failed fetch, not a silent reset.
      dataset$.next({ ...dataset, id: 'wide', features: { count: 31_000 } });

      expect(store.currentSpatialView().colorBy).toEqual({ kind: 'feature', name: 'Ttr' });
    });
  });

  describe('selection', () => {
    /** Three observations: two inside a 0..10 box, one far away. */
    const spatial: SpatialDataset = {
      ...dataset,
      observations: {
        count: 3,
        x: Float32Array.from([1, 5, 500]),
        y: Float32Array.from([1, 5, 500]),
      },
    };

    function withDataset(over: Record<string, unknown> = {}) {
      const built = build(
        mockPort({
          getDataset$: () => new BehaviorSubject<SpatialDataset | null>(spatial),
          ...over,
        }),
      );
      return {
        ...built,
        regions: TestBed.inject(RegionStore),
        selection: TestBed.inject(SpatialSelectionStore),
      };
    }

    it('selects observations inside the drawn ROIs — every ROI tool becomes a selector', () => {
      const { router, regions, selection } = withDataset();
      regions.setRegions([roi(0, 0, 10, 10)]);

      const count = router.getSpatialControls()!.selectFromRegions();
      expect(count).toBe(2);
      expect(Array.from(selection.current().mask)).toEqual([1, 1, 0]);
    });

    it('reports zero (and publishes an empty selection) when the ROIs match nothing', () => {
      const { router, regions, selection } = withDataset();
      regions.setRegions([roi(900, 900, 10, 10)]);
      expect(router.getSpatialControls()!.selectFromRegions()).toBe(0);
      expect(selection.isEmpty()).toBe(true);
    });

    it('selects a whole category from the legend', async () => {
      const column: CategoricalColumn = {
        meta: { kind: 'categorical', name: 'region', categories: ['A', 'B'] },
        codes: new Uint16Array([0, 1, 1]),
      };
      const { router, selection } = withDataset({
        getColumn: jest.fn().mockResolvedValue(column),
      });
      const count = await router.getSpatialControls()!.selectCategory('region', 1);
      expect(count).toBe(2);
      expect(Array.from(selection.current().mask)).toEqual([0, 1, 1]);
    });

    it('rejects a category selection on a continuous column', async () => {
      const { router } = withDataset({
        getColumn: jest.fn().mockResolvedValue({
          meta: { kind: 'continuous', name: 'counts' },
          values: new Float32Array(3),
        }),
      });
      await expect(router.getSpatialControls()!.selectCategory('counts', 0)).rejects.toThrow(/continuous/);
    });

    it('clears the selection', () => {
      const { router, regions, selection } = withDataset();
      regions.setRegions([roi(0, 0, 10, 10)]);
      router.getSpatialControls()!.selectFromRegions();
      router.getSpatialControls()!.clearSelection();
      expect(selection.isEmpty()).toBe(true);
    });

    it('drops the selection when the dataset changes — masks are index-based', () => {
      const dataset$ = new BehaviorSubject<SpatialDataset | null>(spatial);
      const built = build(mockPort({ getDataset$: () => dataset$ }));
      const regions = TestBed.inject(RegionStore);
      const selection = TestBed.inject(SpatialSelectionStore);
      regions.setRegions([roi(0, 0, 10, 10)]);
      built.router.getSpatialControls()!.selectFromRegions();
      expect(selection.current().count).toBe(2);

      dataset$.next({ ...spatial, id: 'other' });
      expect(selection.isEmpty()).toBe(true);
    });

    it('selects nothing when no dataset is loaded', () => {
      const { router } = build(
        mockPort({
          getDataset$: () => new BehaviorSubject<SpatialDataset | null>(null),
        }),
      );
      expect(router.getSpatialControls()!.selectFromRegions()).toBe(0);
    });
  });

  it('drops its dataset subscription when its injector is destroyed (CORE-30)', () => {
    const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    build(mockPort({ getDataset$: () => dataset$ })).router.getSpatialControls();
    expect(dataset$.observed).toBe(true);
    // A component-scoped chain (provideVisualization) is destroyed with its host
    // component; the root port must not keep the whole isolated chain reachable.
    TestBed.resetTestingModule();
    expect(dataset$.observed).toBe(false);
  });

  it('returns null when the host binds no SPATIAL_DATA_PORT', () => {
    const { router } = build(null);
    expect(router.getSpatialControls()).toBeNull();
  });

  it('returns the same object across calls, so a consumer can hold it', () => {
    const { router } = build(mockPort());
    expect(router.getSpatialControls()).toBe(router.getSpatialControls());
  });

  it('reads and writes the shared view state', async () => {
    const { router, store } = build(mockPort());
    const controls = router.getSpatialControls()!;

    expect(controls.viewState().colorBy).toBeNull();
    controls.colorByColumn('region');
    expect(store.currentSpatialView().colorBy).toEqual({ kind: 'column', name: 'region' });
    expect(await firstValueFrom(controls.getViewState$())).toEqual(
      expect.objectContaining({ colorBy: { kind: 'column', name: 'region' } }),
    );

    controls.colorByFeature('Ttr');
    expect(store.currentSpatialView().colorBy).toEqual({ kind: 'feature', name: 'Ttr' });

    controls.clearColorBy();
    expect(store.currentSpatialView().colorBy).toBeNull();

    controls.setViewState({ pointScale: 3, opacity: 0.5 });
    expect(store.currentSpatialView()).toEqual(expect.objectContaining({ pointScale: 3, opacity: 0.5 }));
  });

  it('exposes the dataset stream for pickers and legends', async () => {
    const { router } = build(mockPort());
    expect(await firstValueFrom(router.getSpatialControls()!.getDataset$())).toBe(dataset);
  });

  describe('searchFeatures', () => {
    it('delegates to the port when it can search (a 31k-gene dataset ships no names)', async () => {
      const searchFeatures = jest.fn().mockResolvedValue(['Ttr']);
      const { router } = build(mockPort({ searchFeatures }));
      expect(await router.getSpatialControls()!.searchFeatures('tt', 5)).toEqual(['Ttr']);
      expect(searchFeatures).toHaveBeenCalledWith('tt', 5);
    });

    it('falls back to filtering the inlined names when the port cannot search', async () => {
      const { router } = build(mockPort()); // no searchFeatures on the port
      // Case-insensitive substring over ['Ttr', 'Fth1', 'Mbp'] — 'Mbp' has no 't'.
      expect(await router.getSpatialControls()!.searchFeatures('t')).toEqual(['Ttr', 'Fth1']);
      expect(await router.getSpatialControls()!.searchFeatures('mb')).toEqual(['Mbp']);
    });

    it('returns nothing rather than throwing when neither is available', async () => {
      const port = mockPort({
        getDataset$: () => new BehaviorSubject<SpatialDataset | null>(null),
      });
      const { router } = build(port);
      expect(await router.getSpatialControls()!.searchFeatures('t')).toEqual([]);
    });
  });

  describe('categoryColors', () => {
    it('resolves legend swatches with the same function the renderer uses', async () => {
      const column: CategoricalColumn = {
        meta: {
          kind: 'categorical',
          name: 'region',
          categories: ['A', 'B'],
          colors: ['#ff0000', '#0000ff'],
        },
        codes: new Uint16Array([0, 1]),
      };
      const { router } = build(mockPort({ getColumn: jest.fn().mockResolvedValue(column) }));
      expect(await router.getSpatialControls()!.categoryColors('region')).toEqual(['#ff0000', '#0000ff']);
    });

    it('rejects for a continuous column instead of returning an empty legend', async () => {
      const column = {
        meta: { kind: 'continuous', name: 'counts' },
        values: new Float32Array(2),
      };
      const { router } = build(mockPort({ getColumn: jest.fn().mockResolvedValue(column) }));
      await expect(router.getSpatialControls()!.categoryColors('counts')).rejects.toThrow(
        /continuous .* no categories/,
      );
    });
  });
});
