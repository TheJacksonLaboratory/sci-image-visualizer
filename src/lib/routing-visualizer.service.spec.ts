import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { RoutingVisualizerService } from './routing-visualizer.service';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import { VisualizerStore } from './visualizer-store.service';
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
    unsubscribe: jest.fn(),
  };
}

const IMAGE_INFO: any = { fileName: 'test.tif', isGrayscale: true, imageMeta: [] };

describe('RoutingVisualizerService (characterization)', () => {
  let router: RoutingVisualizerService;
  let plotly: any;
  let osd: any;
  let store: VisualizerStore;

  function setup(useOsdForImage = true): void {
    plotly = mockBackend();
    osd = mockBackend();
    TestBed.resetTestingModule(); // allow per-test re-setup (e.g. the kill-switch case)
    TestBed.configureTestingModule({
      providers: [
        RoutingVisualizerService,
        VisualizerStore,
        { provide: PlotlyService, useValue: plotly },
        { provide: OpenSeadragonVisualizerService, useValue: osd },
        { provide: VIZ_CONFIG, useValue: { useOsdForImage, slideCropServer: '' } },
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

  it('kill switch: useOsdForImage=false sends IMAGE to Plotly', async () => {
    setup(false);
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    expect(plotly.plot).toHaveBeenCalled();
    expect(osd.plot).not.toHaveBeenCalled();
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

  it('delegates histogram to OSD once OSD is the active renderer', async () => {
    await router.plot('div', {}, IMAGE_INFO, 600, PlotType.IMAGE);
    router.getHistogram(1, 256);
    expect(osd.getHistogram).toHaveBeenCalledWith(1, 256);
    expect(plotly.getHistogram).not.toHaveBeenCalled();
  });

  // Pins the CURRENT double-hop (router → plotly → store). Step 1 of the
  // refactoring plan re-points this to the store directly — update then.
  it('display options currently route through the Plotly backend', () => {
    router.getColormap();
    router.setColormap('Reds');
    expect(plotly.getColormap).toHaveBeenCalled();
    expect(plotly.setColormap).toHaveBeenCalledWith('Reds');
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
});
