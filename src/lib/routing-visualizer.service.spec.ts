import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { RoutingVisualizerService } from './routing-visualizer.service';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import { VisualizerStore } from './store/visualizer-store.service';
import { VIZ_CONFIG } from './contracts/viz-config';
import { PlotType } from './contracts/plot-type';
import { IChannelState, IHistogram } from './contracts/channel-histogram-api.contract';

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
    getAutoscaleEvent: jest.fn().mockReturnValue(of(null)),
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
    plotPreviousShapes: jest.fn(),
    setPreviousShapes: jest.fn(),
    getPreviousShapes: jest.fn().mockReturnValue([]),
    importRegions: jest.fn().mockReturnValue([]),
    exportRegions: jest.fn(),
    getGeoJsonString: jest.fn().mockReturnValue('{}'),
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
    getViewportChange$: jest.fn().mockReturnValue(of({ x: 0, y: 0, width: 0, height: 0 })),
    setNavigatorVisible: jest.fn(),
    setImageSmoothingEnabled: jest.fn(),
  };
}

const IMAGE_INFO: any = { fileName: 'test.tif', isGrayscale: true, imageMeta: [] };

describe('RoutingVisualizerService (characterization)', () => {
  let router: RoutingVisualizerService;
  let plotly: any;
  let osd: any;
  let store: VisualizerStore;

  function setup(): void {
    plotly = mockBackend();
    osd = mockBackend();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        RoutingVisualizerService,
        VisualizerStore,
        { provide: PlotlyService, useValue: plotly },
        { provide: OpenSeadragonVisualizerService, useValue: osd },
        { provide: VIZ_CONFIG, useValue: { slideCropServer: '' } },
      ],
    });
    router = TestBed.inject(RoutingVisualizerService);
    store = TestBed.inject(VisualizerStore);
  }

  beforeEach(() => setup());

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

    router.setColormap('Reds');
    router.setReverseScale(true);
    expect(plotly.setColormap).toHaveBeenCalledWith('Reds');
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
    plotly.getRegions.mockReturnValue([profile, annotation]);
    expect(router.getAnnotationRegions()).toEqual([annotation]);
  });

  it('setAnnotationRegions preserves existing profile lines and never appends', () => {
    const profile = { id: 1, kind: 'profile' };
    plotly.getRegions.mockReturnValue([profile, { id: 2 }]);
    const next: any = [{ id: 3 }];
    router.setAnnotationRegions(next, true, false, '#fff');
    expect(plotly.setRegions).toHaveBeenCalledWith([{ id: 3 }, profile], true, false, '#fff', false);
  });

  // ── auto-contrast windowing math ──────────────────────────────────────
  function seedChannel(): void {
    const ch: IChannelState = {
      index: 0, name: 'Intensity', color: '#ffffff', min: 0, max: 255, gamma: 1, visible: true,
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
    ['autoscale', []],
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
    ['getRegions', []],
    ['getRegionPolygons', []],
    ['getRegionUpdateEvent', []],
    ['setSelectedShapeIndices', [[0, 1]]],
    ['selectRegion', [{ id: 1 }]],
    ['getSelectedShapeIndices$', []],
    ['deleteActiveShape', []],
    ['getShowShapeLabel', []],
    ['getShapeColor', []],
    ['getFillColor', []],
    ['getClassificationColors', []],
    ['setClassificationColor', ['tumour', '#fff']],
    ['plotPreviousShapes', []],
    ['setPreviousShapes', [[]]],
    ['getPreviousShapes', []],
    ['importRegions', ['{}']],
    ['exportRegions', [[]]],
    ['getGeoJsonString', [[]]],
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
    ['setRegions', [[], true, false, '#fff', false]],
  ])('routes %s to the active renderer (Plotly before any plot)', (method, args) => {
    (router as any)[method](...args);
    expect(plotly[method]).toHaveBeenCalledWith(...args);
    expect(osd[method]).not.toHaveBeenCalled();
  });

  it('switches delegation to OSD once an IMAGE plot makes it the active renderer', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    router.zoomIn();
    router.setDragMode('pan');
    router.setZIndex(2);
    expect(osd.zoomIn).toHaveBeenCalled();
    expect(osd.setDragMode).toHaveBeenCalledWith('pan');
    expect(osd.setZIndex).toHaveBeenCalledWith(2);
  });

  // ── methods pinned to a specific backend, regardless of the renderer ──
  it.each<[string, any[]]>([
    ['setSurfaceDragMode', ['orbit']],
    ['resetSurfaceCamera', []],
    ['getPlotTypeDescriptors', []],
    ['setStackLoading', [true]],
    ['isStackLoading', []],
    ['getStackLoadingProgress', []],
    ['getAutoscaleEvent', []],
    ['getIntensityProfile$', []],
    ['renderIntensityInset', ['div', []]],
    ['setColormap', ['Reds']],
    ['setReverseScale', [true]],
    ['getIsosurfaceControls', []],
    ['getSurface3dControls', []],
    ['getIntensityControls', []],
    ['ensureIntensitySampling', [IMAGE_INFO, 0]],
    ['refreshIntensitySamplingForRoi', [0, 0, 10, 10, 0]],
  ])('routes %s to Plotly (the full-featured backend)', (method, args) => {
    (router as any)[method](...args);
    expect(plotly[method]).toHaveBeenCalledWith(...args);
  });

  it('setPlotType records the type and delegates to Plotly', () => {
    router.setPlotType(PlotType.HEATMAP);
    expect(plotly.setPlotType).toHaveBeenCalledWith(PlotType.HEATMAP);
  });

  it('getViewportChange$ comes from OpenSeadragon (the only backend that emits it)', () => {
    router.getViewportChange$();
    expect(osd.getViewportChange$).toHaveBeenCalled();
    expect(plotly.getViewportChange$).not.toHaveBeenCalled();
  });

  it.each<[string, any[]]>([
    ['setNavigatorVisible', [false]],
    ['setImageSmoothingEnabled', [false]],
  ])('%s is applied to BOTH backends (set before the first render)', (method, args) => {
    (router as any)[method](...args);
    expect(osd[method]).toHaveBeenCalledWith(...args);
    expect(plotly[method]).toHaveBeenCalledWith(...args);
  });

  it('unsubscribe tears down both backends', () => {
    router.unsubscribe();
    expect(plotly.unsubscribe).toHaveBeenCalled();
    expect(osd.unsubscribe).toHaveBeenCalled();
  });

  it('getIsosurfaceControls / getIntensityControls are Plotly-owned', () => {
    router.getIsosurfaceControls();
    router.getIntensityControls();
    expect(plotly.getIsosurfaceControls).toHaveBeenCalled();
    expect(plotly.getIntensityControls).toHaveBeenCalled();
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
