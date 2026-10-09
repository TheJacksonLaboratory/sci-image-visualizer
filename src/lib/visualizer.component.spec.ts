import { BehaviorSubject } from 'rxjs';

// Capture the RenderOrchestrator host config so the preemption tests can invoke a
// superseded render's callbacks directly and assert they are inert. SliceScrubber
// (same module) stays real — only the orchestrator is stubbed, and its `render` is a
// spy so renderPhase is never auto-driven.
const orchestratorHosts: any[] = [];
jest.mock('./render-orchestrator', () => {
  const actual = jest.requireActual('./render-orchestrator');
  return {
    ...actual,
    RenderOrchestrator: jest.fn().mockImplementation((host: any) => {
      orchestratorHosts.push(host);
      return { render: jest.fn().mockResolvedValue(undefined) };
    }),
  };
});

import { VisualizerComponent } from './visualizer.component';
import { PlotType, PLOT_TYPE_DESCRIPTORS } from './contracts/plot-type';
import { VisualizerStore } from './store/visualizer-store.service';
import { RegionOpsService } from './region-ops.service';
import { WandService } from './toolbar/wand/wand.service';
import { Region, Rectangle, Polygon, MultiPolygon } from './models/region';
import { ToolbarToolContribution } from './contracts/toolbar-tool.contract';

function rectRegion(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const b = new Rectangle();
  b.x = x; b.y = y; b.width = w; b.height = h;
  r.bounds = b;
  return r;
}

/**
 * UI-shell tests for VisualizerComponent (refactoring plan, Step 7) —
 * instantiated directly (no TestBed/template) so the shell logic is testable
 * without mounting OSD/Plotly: z-scrub debouncing through the SliceScrubber,
 * keyboard slice stepping with clamping, and the dialog/toolbar flags.
 */

function mockOverlay() {
  return { setMode: jest.fn(), setSelectedBezier: jest.fn() };
}

function mockPlotService(): any {
  return {
    capabilities: { has: () => true },
    getColormapOptions: jest.fn().mockReturnValue([{ children: [{ label: 'Greys Inv' }] }]),
    getPlotTypeDescriptors: jest.fn().mockReturnValue([]),
    setZIndex: jest.fn(),
    setDisplaySlice: jest.fn(),
    enterStackMode: jest.fn(),
    exitStackMode: jest.fn(),
    isStackMode: jest.fn().mockReturnValue(false),
    getSliceRegions: jest.fn().mockReturnValue([]),
    setPlotType: jest.fn(),
    ensureIntensitySampling: jest.fn().mockResolvedValue(undefined),
    // ── handler delegations exercised by the toolbar/region tests ──
    setReverseScale: jest.fn(),
    setColormap: jest.fn(),
    setShowStack: jest.fn(),
    setStackLoading: jest.fn(),
    downloadImage: jest.fn(),
    autoscale: jest.fn(),
    resetAxes: jest.fn(),
    zoomIn: jest.fn(),
    zoomOut: jest.fn(),
    setImageSmoothingEnabled: jest.fn(),
    setDragMode: jest.fn(),
    setZoomToBoxMode: jest.fn(),
    setWandMode: jest.fn(),
    setWandOptions: jest.fn(),
    setBrushMode: jest.fn(),
    setBrushOptions: jest.fn(),
    setVertexEraserMode: jest.fn(),
    setVertexEraserRadius: jest.fn(),
    segmentRectangles: jest.fn().mockResolvedValue(0),
    segmentRectanglesCellpose: jest.fn().mockResolvedValue(0),
    setSamModel: jest.fn(),
    setSamPointMode: jest.fn(),
    commitSamPoints: jest.fn(),
    clearSamPoints: jest.fn(),
    deleteActiveShape: jest.fn(),
    reloadAndPlot: jest.fn(),
    getRegions: jest.fn().mockReturnValue([]),
    getRegionPolygons: jest.fn().mockReturnValue([]),
    getRegionOverlay: jest.fn().mockReturnValue(mockOverlay()),
    getIsosurfaceControls: jest.fn().mockReturnValue({ setIsoRange: jest.fn() }),
    // Only reached by ngOnDestroy, which most of this suite deliberately skips.
    unsubscribe: jest.fn(),
  };
}

function makeComponent(plot: any, spatialData?: any): VisualizerComponent {
  return new VisualizerComponent(
      { setDiagram: jest.fn(), setImageLoading: jest.fn(), setImageInfo: jest.fn() } as any, // ImageStatePort
      plot,
      { add: jest.fn(), clear: jest.fn() } as any, // MessageService
      { run: (fn: () => void) => fn(), runOutsideAngular: (fn: () => void) => fn() } as any, // NgZone
      { detectChanges: jest.fn(), markForCheck: jest.fn() } as any, // ChangeDetectorRef
      new VisualizerStore(),
      // SamToolService
      {
        status$: new BehaviorSubject(''),
        busy$: new BehaviorSubject(false),
        progress$: new BehaviorSubject(-1),
      } as any,
      // CellSegmentToolService
      {
        status$: new BehaviorSubject(''),
        busy$: new BehaviorSubject(false),
        progress$: new BehaviorSubject(-1),
      } as any,
      // SamPointToolService
      {
        status$: new BehaviorSubject(''),
        busy$: new BehaviorSubject(false),
        progress$: new BehaviorSubject(-1),
      } as any,
      new RegionOpsService(new WandService()), // RegionOpsService
      undefined, // VIZ_CONFIG
      undefined, // TOOLBAR_TOOLS
      spatialData, // SPATIAL_DATA_PORT (optional — absent for image-only hosts)
    );
}

/**
 * A component driven through its real lifecycle (ngOnInit), for the render and
 * teardown specs.
 *
 * ngOnInit subscribes to a long tail of streams on both ports. Rather than
 * enumerating them (and re-enumerating whenever one is added), wrap the mock so
 * any unlisted `getX$()` / `isX()` accessor answers with a BehaviorSubject and
 * anything else with a jest.fn(). Explicit overrides win, and identities are
 * cached so `expect(plot.reset)` is stable across accesses. Every subject handed
 * out is recorded in `subjects`, so a spec can check nothing is still observed
 * after ngOnDestroy.
 */
function harness(overrides: Record<string, unknown> = {}) {
  const subjects: BehaviorSubject<unknown>[] = [];
  const subject = <T>(v: T): BehaviorSubject<T> => {
    const s = new BehaviorSubject<T>(v);
    subjects.push(s as BehaviorSubject<unknown>);
    return s;
  };
  const selfCompleting = (base: any): any => new Proxy(base, {
    has: () => true,
    get(target, prop: any) {
      if (typeof prop !== 'string' || prop in target) return target[prop];
      target[prop] = /\$$|^(get|is)[A-Z]/.test(prop)
        ? jest.fn(() => subject(false))
        : jest.fn();
      return target[prop];
    },
  });
  const plotBase: any = mockPlotService();
  Object.assign(plotBase, {
    getAutoscaleEvent: () => subject(''),
    getIntensityProfile$: () => subject([]),
    getStackLoadingProgress: () => subject(0),
    getViewportChange$: () => subject({ x: 0, y: 0, width: 1, height: 1 }),
    isStackLoading: () => subject(false),
    getCanUndo$: () => subject(false),
    getCanRedo$: () => subject(false),
    getSelectedShapeIndices$: () => subject([]),
    relayout: jest.fn(),
    refreshIntensitySamplingForRoi: jest.fn(),
    setImageMeta: jest.fn(),
    reset: jest.fn(),
    cancelLoading: jest.fn(),
    load: jest.fn().mockImplementation((info: any) => Promise.resolve({ filename: info.fileName })),
    plot: jest.fn().mockResolvedValue(undefined),
    getShowShapeLabel: jest.fn().mockReturnValue(false),
    importRegions: jest.fn().mockReturnValue([]),
    setRegions: jest.fn(),
    resetUndoHistory: jest.fn(),
    setStackLoading: jest.fn(),
  }, overrides);
  const plot: any = selfCompleting(plotBase);
  const imageInfo$ = subject<any>(null);
  const stateBase: any = {
    getImageInfo$: () => imageInfo$,
    getFilename$: () => subject('none'),
    getImageLoadingMessage$: () => subject(''),
    getCacheProgress$: () => subject(null),
    getPanelWidth$: () => subject(500),
    isImageLoading$: () => subject(false),
    isImageCached$: () => subject(true),
    isZoom$: () => subject(false),
    setDiagram: jest.fn(),
    setImageLoading: jest.fn(),
    setImageLoadingMessage: jest.fn(),
    setImageInfo: jest.fn(),
    setImageCached: jest.fn(),
    setLoadingError: jest.fn(),
    setZoom: jest.fn(),
  };
  const state: any = selfCompleting(stateBase);
  const toolFeeds = () => ({ status$: subject(''), busy$: subject(false), progress$: subject(-1) }) as any;
  const messages = { add: jest.fn(), clear: jest.fn() };
  const store = new VisualizerStore();
  const component = new VisualizerComponent(
    state,
    plot,
    messages as any,
    { run: (fn: () => void) => fn(), runOutsideAngular: (fn: () => void) => fn() } as any,
    { detectChanges: jest.fn(), markForCheck: jest.fn() } as any,
    store,
    toolFeeds(),
    toolFeeds(),
    toolFeeds(),
    new RegionOpsService(new WandService()),
  );
  component.ngOnInit();
  return { component, plot, state, imageInfo$, subjects, messages, store };
}

describe('VisualizerComponent (UI shell)', () => {
  let component: VisualizerComponent;
  let plotService: any;

  beforeEach(() => {
    jest.useFakeTimers();
    plotService = mockPlotService();
    component = makeComponent(plotService);
  });

  afterEach(() => jest.useRealTimers());

  // ── shared toast outlets ────────────────────────────────────────────
  // PlotlyService is providedIn:'root' and the region editor is a child dialog,
  // so their notices use fixed keys rather than a per-instance one. Exactly one
  // live visualizer may render those outlets or a single message would appear
  // once per viewer (jit-ui runs a main view and a pipeline preview at once).
  describe('shared notice outlets', () => {
    // ngOnInit/ngOnDestroy only add/remove `this` from the live set; the logic
    // worth pinning is who that makes the owner. Driving the real lifecycle here
    // would mean stubbing most of ngOnInit, which this suite deliberately avoids.
    const live = () => (VisualizerComponent as any).liveInstances as Set<unknown>;

    afterEach(() => live().clear());

    it('is rendered by the oldest live visualizer, and hands over on destroy', () => {
      const first = component;
      const second = makeComponent(mockPlotService());

      live().add(first);
      live().add(second);
      expect(first.ownsSharedToasts).toBe(true);
      expect(second.ownsSharedToasts).toBe(false); // no duplicate outlet

      // Tearing down the owner must not leave the outlets unrendered — that
      // would silently drop every notice raised by the root-provided service.
      live().delete(first);
      expect(second.ownsSharedToasts).toBe(true);
    });

    it('renders no outlet when nothing is live', () => {
      expect(component.ownsSharedToasts).toBe(false);
    });
  });

  it('gives each instance its own intensity-inset div id (CORE-9)', () => {
    const other = makeComponent(mockPlotService());
    expect(component.intensityInsetDiv).not.toBe(other.intensityInsetDiv);
    expect(component.intensityInsetDiv).not.toBe(component.plotDivName);
  });

  it('constructs and reads the plot-type descriptors through the service', () => {
    expect(component).toBeTruthy();
    expect(plotService.getPlotTypeDescriptors).toHaveBeenCalled();
  });

  describe('plot-mode curation by test mode', () => {
    const ALL_DESCRIPTORS = Object.values(PLOT_TYPE_DESCRIPTORS).filter(Boolean) as any[];

    beforeEach(() => {
      // Grayscale stack + a 3D-capable backend so the stack/grayscale/3D gates
      // all pass, isolating the test-mode curation + relabeling under test.
      (component as any).imageInfo = { isStack: true, isGrayscale: true };
      plotService.capabilities = { has: () => true };
      plotService.getPlotTypeDescriptors.mockReturnValue(ALL_DESCRIPTORS);
    });

    it('default selector shows only the curated set, under suffix-free labels', () => {
      component.testMode = false;
      (component as any).computePlotTypeOptions();
      const byType = new Map(component.plotTypeOptions.map((d) => [d.type, d.label]));

      // curated + relabeled
      expect(byType.get(PlotType.IMAGE)).toBe('Image');
      expect(byType.get(PlotType.HEATMAP)).toBe('Heatmap');
      expect(byType.get(PlotType.CONTOUR)).toBe('Contour');
      expect(byType.get(PlotType.NAPARI_SURFACE)).toBe('Surface');
      expect(byType.get(PlotType.NAPARI_VOLUME)).toBe('Volume');
      expect(byType.get(PlotType.NAPARI_ISOSURFACE)).toBe('Isosurface');

      // test-only — hidden (all scatters, napari Image, Plotly surface/isosurface)
      for (const t of [
        PlotType.SCATTER, PlotType.SCATTER3D, PlotType.SURFACE, PlotType.ISOSURFACE,
        PlotType.NAPARI_IMAGE, PlotType.NAPARI_SCATTER, PlotType.NAPARI_SCATTER3D,
      ]) {
        expect(byType.has(t)).toBe(false);
      }
    });

    it('test mode shows every type under its backend-suffixed label', () => {
      component.testMode = true;
      (component as any).computePlotTypeOptions();
      const byType = new Map(component.plotTypeOptions.map((d) => [d.type, d.label]));

      // Test mode lifts the `productionLabel` CURATION, not the capability gates:
      // the spatial types still need a dataset, exactly as a volume still needs a
      // stack. This fixture has no dataset, so every spatial mode is held back —
      // the 3D one doubly so, since it also needs observations with a z.
      const gated = ALL_DESCRIPTORS.filter((d) => d.requiresSpatialData);
      expect(gated.map((d) => d.type).sort()).toEqual(
        [PlotType.SPATIAL_OMICS, PlotType.SPATIAL_OMICS_3D].sort(),
      );
      expect(component.plotTypeOptions.length).toBe(ALL_DESCRIPTORS.length - gated.length);
      expect(byType.has(PlotType.SPATIAL_OMICS)).toBe(false);
      expect(byType.has(PlotType.SPATIAL_OMICS_3D)).toBe(false);
      expect(byType.get(PlotType.IMAGE)).toBe('Image (OSD)');
      expect(byType.get(PlotType.NAPARI_IMAGE)).toBe('Image (napari · WebGPU)');
      expect(byType.get(PlotType.SURFACE)).toBe('Surface (Plotly)');
      expect(byType.get(PlotType.NAPARI_SURFACE)).toBe('Surface (napari · WebGPU)');
      expect(byType.get(PlotType.SCATTER)).toBe('Scatter 2D (Plotly)');
    });

    it('recomputes the selector when testMode is bound (ngOnChanges)', () => {
      // default (testMode=false): the curated set excludes the napari Image mode
      component.testMode = false;
      (component as any).computePlotTypeOptions();
      expect(component.plotTypeOptions.some((d) => d.type === PlotType.NAPARI_IMAGE)).toBe(false);
      // host binds testMode=true → ngOnChanges recomputes → it now appears,
      // without waiting for an image to (re)load
      component.testMode = true;
      component.ngOnChanges({ testMode: {} } as any);
      expect(component.plotTypeOptions.some((d) => d.type === PlotType.NAPARI_IMAGE)).toBe(true);
    });

    it('falls back to Image when test mode turns off while a test-only type is active', () => {
      // test mode on, and a test-only type (napari Image) is the active selection
      component.testMode = true;
      component.ngOnChanges({ testMode: {} } as any);
      component.selectedPlotType = PlotType.NAPARI_IMAGE;
      // turning test mode off drops that option → selection reconciled to Image
      component.testMode = false;
      component.ngOnChanges({ testMode: {} } as any);
      expect(component.selectedPlotType).toBe(PlotType.IMAGE);
      expect(plotService.setPlotType).toHaveBeenCalledWith(PlotType.IMAGE);
    });
  });

  describe('spatial-omics plot types gated by dataset availability', () => {
    // No shipped plot type carries `requiresSpatialData` yet — the rendering mode
    // is the next phase. What is under test is the GATE: a descriptor that
    // declares the flag must stay hidden until a dataset is published, exactly
    // as `requiresStack` hides the volume types until a stack is open.
    const SPATIAL_DESCRIPTOR: any = {
      type: 'spatial-omics',
      label: 'Spatial omics (napari · WebGPU)',
      productionLabel: 'Spatial omics',
      dimensions: '2d',
      source: 'spatial',
      requiresSpatialData: true,
    };
    const DESCRIPTORS = [PLOT_TYPE_DESCRIPTORS[PlotType.IMAGE], SPATIAL_DESCRIPTOR] as any[];

    const offered = (c: VisualizerComponent) =>
      c.plotTypeOptions.some((d) => d.type === SPATIAL_DESCRIPTOR.type);

    let dataset$: BehaviorSubject<any>;
    let port: any;

    beforeEach(() => {
      (component as any).imageInfo = { isStack: false, isGrayscale: true };
      plotService.capabilities = { has: () => true };
      plotService.getPlotTypeDescriptors.mockReturnValue(DESCRIPTORS);
      dataset$ = new BehaviorSubject<any>(null);
      port = { getDataset$: () => dataset$.asObservable() };
    });

    it('hides the spatial type when the host provides no SPATIAL_DATA_PORT at all', () => {
      const c = makeComponent(plotService); // no port
      (c as any).watchSpatialDataset();
      (c as any).computePlotTypeOptions();
      expect(offered(c)).toBe(false);
      expect(c.plotTypeOptions.some((d) => d.type === PlotType.IMAGE)).toBe(true);
    });

    it('hides it while the port is bound but no dataset is selected', () => {
      const c = makeComponent(plotService, port);
      (c as any).watchSpatialDataset();
      (c as any).computePlotTypeOptions();
      expect(offered(c)).toBe(false);
    });

    it('offers it as soon as a dataset is published', () => {
      const c = makeComponent(plotService, port);
      (c as any).watchSpatialDataset();
      expect(offered(c)).toBe(false);

      dataset$.next({ id: 'visium-brain', observations: { count: 2 } });
      expect(offered(c)).toBe(true);
    });

    it('hides it again and falls back to Image when the dataset is cleared', () => {
      const c = makeComponent(plotService, port);
      (c as any).watchSpatialDataset();
      dataset$.next({ id: 'visium-brain', observations: { count: 2 } });

      // The spatial mode is the active selection…
      c.selectedPlotType = SPATIAL_DESCRIPTOR.type;
      c.plotType = SPATIAL_DESCRIPTOR.type;

      // …and the host deselects the dataset.
      dataset$.next(null);

      expect(offered(c)).toBe(false);
      expect(c.selectedPlotType).toBe(PlotType.IMAGE);
      expect(plotService.setPlotType).toHaveBeenCalledWith(PlotType.IMAGE);
    });

    it('does not recompute on the port\'s initial null emission', () => {
      const c = makeComponent(plotService, port);
      const spy = jest.spyOn(c as any, 'computePlotTypeOptions');
      (c as any).watchSpatialDataset(); // BehaviorSubject replays null immediately
      expect(spy).not.toHaveBeenCalled();
    });

    it('leaves the other gates intact — a stack-only type stays hidden with a dataset loaded', () => {
      plotService.getPlotTypeDescriptors.mockReturnValue([
        ...DESCRIPTORS, PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_VOLUME],
      ] as any[]);
      const c = makeComponent(plotService, port);
      (c as any).imageInfo = { isStack: false, isGrayscale: true };
      (c as any).watchSpatialDataset();
      dataset$.next({ id: 'visium-brain', observations: { count: 2 } });

      expect(offered(c)).toBe(true);
      expect(c.plotTypeOptions.some((d) => d.type === PlotType.NAPARI_VOLUME)).toBe(false);
    });

    it('unsubscribes on destroy', () => {
      const c = makeComponent(plotService, port);
      (c as any).watchSpatialDataset();
      expect(dataset$.observed).toBe(true);
      c.ngOnDestroy();
      expect(dataset$.observed).toBe(false);
    });

    describe('a registered volume feeds the volumetric modes', () => {
      // The real shape of an ABC-atlas cloud: observations with a z, a registered
      // reference volume, and NO `imageRef` — so there is no image behind it and
      // `isStack`/`isGrayscale` are both unknowable from the image.
      const VOLUME_DATASET = {
        id: 'abc.wholebrain',
        name: 'Whole mouse brain MERFISH',
        observations: { count: 3, z: new Float32Array([0, 1, 2]) },
        volume: { width: 4, height: 4, depth: 4, voxelSize: [1, 1, 1] },
      };
      // The encode awaits `toBlob`, which jest-canvas-mock answers on a timer. The
      // suite's fake clock would hold that forever, and swapping clocks afterwards
      // DISCARDS the pending timer rather than firing it — so real timers have to
      // be in place before the dataset is ever published.
      beforeEach(() => jest.useRealTimers());

      /** Let the volume fetch + slice encode settle: `toBlob` answers per plane, so
       *  one tick is not enough for a whole stack. */
      const flush = async () => {
        for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      };

      it('reaches Volume and Isosurface through the published stack, not a second source', () => {
        // Those modes raymarch the IMAGE STACK and nothing else. What puts them on
        // offer for a 3D omics dataset is that its volume is published AS a
        // grayscale z-stack image — so with no image there is nothing to raymarch,
        // and with one there is, by the ordinary gates.
        plotService.getPlotTypeDescriptors.mockReturnValue([
          PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_VOLUME],
          PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_ISOSURFACE],
        ] as any[]);
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined; // before the volume image is published
        (c as any).watchSpatialDataset();
        dataset$.next(VOLUME_DATASET);
        expect(c.plotTypeOptions.length).toBe(0);

        // …and after: the shape `buildVolumeStackImage` publishes.
        (c as any).imageInfo = { isStack: true, isGrayscale: true };
        (c as any).computePlotTypeOptions();

        const offeredTypes = c.plotTypeOptions.map((d) => d.type);
        expect(offeredTypes).toContain(PlotType.NAPARI_VOLUME);
        expect(offeredTypes).toContain(PlotType.NAPARI_ISOSURFACE);
      });

      it('publishes the volume AS the image and opens the 2D Image view on it', async () => {
        plotService.getPlotTypeDescriptors.mockReturnValue([
          PLOT_TYPE_DESCRIPTORS[PlotType.IMAGE], SPATIAL_DESCRIPTOR,
        ] as any[]);
        port.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 4 * 4));
        const c = makeComponent(plotService, port);
        // The user was on the 3D cloud (the previous dataset), so this also covers
        // the mode actually switching rather than merely already being Image.
        c.selectedPlotType = PlotType.SPATIAL_OMICS_3D;
        (c as any).watchSpatialDataset();
        dataset$.next({
          ...VOLUME_DATASET,
          volume: { width: 4, height: 4, depth: 4, voxelSize: [40, 40, 200] },
        });
        await flush();

        const published = ((c as any).state.setImageInfo as jest.Mock).mock.calls.at(-1)?.[0];
        expect(published).toMatchObject({ isStack: true, isGrayscale: true, tiled: false });
        expect(published.imageMeta[0].z).toBe(4);
        expect(published.urls.length).toBe(4);
        expect(plotService.setPlotType).toHaveBeenCalledWith(PlotType.IMAGE);
      });

      it('does not refetch the voxels when the same dataset is re-emitted', async () => {
        port.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 4 * 4));
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        const withVolume = {
          ...VOLUME_DATASET,
          volume: { width: 4, height: 4, depth: 4, voxelSize: [40, 40, 200] },
        };
        dataset$.next(withVolume);
        await flush();
        // A colour-column change re-emits the dataset; rebuilding then would refetch
        // megabytes and throw the user back to the middle slice.
        dataset$.next({ ...withVolume });
        await flush();

        expect(port.getVolume).toHaveBeenCalledTimes(1);
      });

      it('republishes when switching between two datasets of the same shape', async () => {
        // Two 3D datasets that both carry a volume have the same capability shape,
        // so a guard comparing only that skipped the switch — leaving the first
        // dataset's volume image under the second's observations.
        port.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 4 * 4));
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        const volume = { width: 4, height: 4, depth: 4, voxelSize: [40, 40, 200] };

        dataset$.next({ ...VOLUME_DATASET, id: 'abc.full', volume });
        await flush();
        dataset$.next({ ...VOLUME_DATASET, id: 'abc.sub10', volume });
        await flush();

        expect(port.getVolume).toHaveBeenCalledTimes(2);
        const infos = ((c as any).state.setImageInfo as jest.Mock).mock.calls.map((a: any[]) => a[0]);
        expect(infos.filter((i: any) => i?.isStack).length).toBe(2);
      });

      it('a superseded volume build leaves the newer build\'s loading overlay up (CORE-12)', async () => {
        const pending: ((v: Uint8Array) => void)[] = [];
        port.getVolume = jest.fn(() => new Promise<Uint8Array>((resolve) => pending.push(resolve)));
        const c = makeComponent(plotService, port);
        const setLoading = (c as any).state.setImageLoading as jest.Mock;
        (c as any).watchSpatialDataset();
        const volume = { width: 4, height: 4, depth: 4, voxelSize: [40, 40, 200] };

        dataset$.next({ ...VOLUME_DATASET, id: 'abc.full', volume });
        dataset$.next({ ...VOLUME_DATASET, id: 'abc.sub10', volume });
        await flush();
        expect(pending).toHaveLength(2);

        setLoading.mockClear();
        pending[0](new Uint8Array(4 * 4 * 4)); // the superseded build finishes first
        await flush();
        expect(setLoading).not.toHaveBeenCalledWith(false);

        pending[1](new Uint8Array(4 * 4 * 4));
        await flush();
        expect(setLoading).toHaveBeenLastCalledWith(false);
      });

      it('republishes the volume after a detour through an image-backed dataset', async () => {
        port.getVolume = jest.fn().mockResolvedValue(new Uint8Array(4 * 4 * 4));
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        const withVolume = {
          ...VOLUME_DATASET,
          volume: { width: 4, height: 4, depth: 4, voxelSize: [40, 40, 200] },
        };
        dataset$.next(withVolume);
        await flush();

        // A Visium-style dataset in between: it brings its own tissue image, which
        // is now what the Image view shows.
        dataset$.next({ id: 'visium', name: 'V', observations: { count: 2 }, columns: [],
          imageRef: { imageId: 'tissue' } });
        await flush();
        // Back to the volume dataset — its image has to be published AGAIN, or the
        // Image view keeps the Visium tissue under a whole-brain cloud's controls.
        dataset$.next(withVolume);
        await flush();

        expect(port.getVolume).toHaveBeenCalledTimes(2);
        const infos = ((c as any).state.setImageInfo as jest.Mock).mock.calls.map((a: any[]) => a[0]);
        expect(infos.filter((i: any) => i?.isStack).length).toBe(2);
      });

      it('falls back to the 3D cloud when the volume cannot be fetched', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        port.getVolume = jest.fn().mockRejectedValue(new Error('503'));
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next({
          ...VOLUME_DATASET,
          volume: { width: 4, height: 4, depth: 4, voxelSize: [40, 40, 200] },
        });
        await flush();

        expect(plotService.setPlotType).toHaveBeenCalledWith(PlotType.SPATIAL_OMICS_3D);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
      });

      it('still opens the cloud for a 3D dataset that carries no volume', async () => {
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next({ ...VOLUME_DATASET, volume: undefined });
        await flush();

        expect(plotService.setPlotType).toHaveBeenCalledWith(PlotType.SPATIAL_OMICS_3D);
      });

      it('stops offering the pixel modes for a dataset that brings no image', async () => {
        // Image / Heatmap / Surface all read PIXELS. A dataset like seqFISH records
        // unitless coordinates and no section, so those modes can only come up blank —
        // or worse, showing whichever slide was loaded before.
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next({
          id: 'seqfish', name: 'seqFISH', observations: { count: 3 }, columns: [],
        });
        await flush();

        const sources = c.plotTypeOptions.map((d) => d.source);
        expect(sources).not.toContain('image');
        // …and the spatial mode it CAN draw is still there.
        expect(c.plotTypeOptions.some((d) => d.type === PlotType.SPATIAL_OMICS)).toBe(true);
      });

      it('keeps the pixel modes while a REGISTERED dataset waits for its image', async () => {
        // A dataset declaring an imageRef has an image on the way. Dropping the modes
        // until it lands would make the selector flicker for a state that is transient.
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next({
          id: 'demo', name: 'Demo', observations: { count: 3 }, columns: [],
          imageRef: { imageId: 'slide-1' },
        });
        await flush();

        expect(c.plotTypeOptions.some((d) => d.type === PlotType.IMAGE)).toBe(true);
      });

      it('keeps the pixel modes for a volume-backed dataset with no imageRef', async () => {
        // The ABC 3D dataset registers onto no section, but publishes its VOLUME as a
        // grayscale z-stack image — and Volume / Isosurface are exactly how it is read.
        // Hiding pixel modes for "declares no imageRef" alone took those away.
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next({
          ...VOLUME_DATASET,
          volume: { width: 4, height: 4, depth: 4, voxelSize: [1, 1, 1] },
        });
        await flush();

        expect(c.plotTypeOptions.some((d) => d.source === 'image')).toBe(true);
      });

      it('keeps Image on offer when there is no dataset at all', async () => {
        // A host that has loaded nothing yet still needs a default; an empty selector
        // would be worse than a blank view.
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next(null);
        await flush();

        expect(c.plotTypeOptions.some((d) => d.type === PlotType.IMAGE)).toBe(true);
      });

      it('opens the 2D scatter for a one-plane dataset with no image', async () => {
        // The case that went unhandled: before an image-less 2D assay existed,
        // "no reference image" implied a cloud, so this branch was gated on the z
        // and a dataset without one selected nothing. The host was then stranded on
        // an Image view showing whatever slide was loaded before — the observations
        // never appeared and someone else's tissue did, which reads as a failure to
        // load rather than a missing mode.
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next({
          id: 'seqfish',
          name: 'Mouse embryo seqFISH',
          observations: { count: 3 }, // no z: one plane
          columns: [],
        });
        await flush();

        expect(plotService.setPlotType).toHaveBeenCalledWith(PlotType.SPATIAL_OMICS);
        expect(plotService.setPlotType).not.toHaveBeenCalledWith(PlotType.SPATIAL_OMICS_3D);
      });

      it('draws an image-less dataset when no image was ever loaded (a host\'s first view)', async () => {
        // jit-ui opens a Xenium zip straight from the file tree: no image has been loaded, so
        // there is no image info to re-drive. Redrawing through the renderer's own state threw
        // from Plotly's never-set image size and left a white canvas.
        plotService.plot = jest.fn(async () => true);
        plotService.reloadAndPlot = jest.fn();
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        (c as any).viewReady = true;
        (c as any).watchSpatialDataset();
        dataset$.next({ id: 'xenium', name: 'Cervical', observations: { count: 3 }, columns: [] });
        await flush();

        expect(plotService.reloadAndPlot).not.toHaveBeenCalled();
        expect(plotService.plot).toHaveBeenCalledWith(expect.any(String), null,
          expect.objectContaining({ fileName: 'spatial:xenium', urls: [] }), expect.any(Number), PlotType.SPATIAL_OMICS);
      });

      it('waits for the view before drawing an image-less dataset published before it (jit-ui)', async () => {
        // jit-ui creates the visualizer after the dataset is published: the port replays it into
        // ngOnInit, before the plot div exists, and napari found no target ("plot target not
        // found") — which surfaced as "the renderer could not start".
        plotService.plot = jest.fn(async () => true);
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        dataset$.next({ id: 'csc', name: 'csc-demo', observations: { count: 3 }, columns: [] });
        (c as any).watchSpatialDataset();
        await flush();
        expect(plotService.plot).not.toHaveBeenCalled();
        expect((c as any).messageService.add).not.toHaveBeenCalled();

        (c as any).onViewReady();
        await flush();
        expect(plotService.plot).toHaveBeenCalledTimes(1);
        expect((plotService.plot as jest.Mock).mock.calls[0][2].fileName).toBe('spatial:csc');
      });

      it('draws the current object when the same dataset is re-emitted before the view is ready', async () => {
        // Immutable updates re-emit the same dataset as a new object (e.g. a colour-column change):
        // the waiting draw must not be lost to an object comparison, and it draws the latest object.
        plotService.plot = jest.fn(async () => true);
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        const first = { id: 'csc', name: 'csc-demo', observations: { count: 3 }, columns: [] };
        dataset$.next(first);
        (c as any).watchSpatialDataset();
        await flush();
        const again = { ...first, name: 'csc-demo (recoloured)' };
        dataset$.next(again);
        await flush();
        expect(plotService.plot).not.toHaveBeenCalled();

        (c as any).onViewReady();
        await flush();
        expect(plotService.plot).toHaveBeenCalledTimes(1);
        expect((c as any).spatialDataset).toBe(again);
        expect((plotService.plot as jest.Mock).mock.calls[0][2].fileName).toBe('spatial:csc');
      });

      it('drops a waiting draw when another dataset (a new id) replaced it', async () => {
        plotService.plot = jest.fn(async () => true);
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        dataset$.next({ id: 'one', name: 'One', observations: { count: 3 }, columns: [] });
        (c as any).watchSpatialDataset();
        await flush();
        dataset$.next({ id: 'two', name: 'Two', observations: { count: 3 }, columns: [] });
        await flush();
        (c as any).onViewReady();
        await flush();
        // Only the newer dataset's draw is waiting: it is drawn once, the older never.
        expect((plotService.plot as jest.Mock).mock.calls.map((call) => call[2].fileName)).toEqual(['spatial:two']);
      });

      it('drops a waiting image-less draw when an image or another dataset arrived first', async () => {
        plotService.plot = jest.fn(async () => true);
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        (c as any).watchSpatialDataset();
        dataset$.next({ id: 'one', name: 'One', observations: { count: 3 }, columns: [] });
        await flush();
        (c as any).imageInfo = { fileName: 'slide.tif' }; // an image came in before the view
        (c as any).onViewReady();
        await flush();
        expect(plotService.plot).not.toHaveBeenCalled();
      });

      it('a superseded image-less draw leaves the newer render\'s loading state alone', async () => {
        let finish!: (ok: boolean) => void;
        plotService.plot = jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        (c as any).viewReady = true;
        (c as any).watchSpatialDataset();
        dataset$.next({ id: 'one', name: 'One', observations: { count: 3 }, columns: [] });
        await flush();
        (c as any).renderToken++; // a newer image starts rendering
        const state = (c as any).state;
        state.setImageLoading.mockClear();
        finish(true);
        await flush();
        expect(state.setImageLoading).not.toHaveBeenCalledWith(false);
      });

      it('says so when the renderer cannot draw an image-less dataset, rather than look finished', async () => {
        plotService.plot = jest.fn(async () => false); // napari without WebGPU resolves false
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        (c as any).viewReady = true;
        (c as any).watchSpatialDataset();
        dataset$.next({ id: 'one', name: 'One', observations: { count: 3 }, columns: [] });
        await flush();
        expect((c as any).messageService.add).toHaveBeenCalledWith(
          expect.objectContaining({ severity: 'error', summary: 'Could not draw the dataset' }));
        expect((c as any).state.setImageLoading).toHaveBeenLastCalledWith(false);
      });

      it('re-plots when another image-less dataset follows in the same mode', async () => {
        // Its placeholder image info keys the regions: without a re-plot the first dataset's
        // regions would show on, and be saved under, the second.
        plotService.plot = jest.fn(async () => true);
        const c = makeComponent(plotService, port);
        (c as any).imageInfo = undefined;
        (c as any).viewReady = true;
        (c as any).watchSpatialDataset();
        dataset$.next({ id: 'one', name: 'One', observations: { count: 3 }, columns: [] });
        await flush();
        dataset$.next({ id: 'two', name: 'Two', observations: { count: 3 }, columns: [] });
        await flush();

        expect((plotService.plot as jest.Mock).mock.calls.map((call) => call[2].fileName))
          .toEqual(['spatial:one', 'spatial:two']);
      });

      it('leaves a dataset that HAS an image alone, to be drawn over it', async () => {
        // With a tissue image the host has already opened on it, and the observations
        // register onto that section — switching the type here would fight the host.
        const c = makeComponent(plotService, port);
        (c as any).watchSpatialDataset();
        dataset$.next({
          id: 'demo-brain',
          name: 'Demo',
          observations: { count: 3 },
          columns: [],
          imageRef: { imageId: 'slide-1' },
        });
        await flush();

        expect(plotService.setPlotType).not.toHaveBeenCalledWith(PlotType.SPATIAL_OMICS);
        expect(plotService.setPlotType).not.toHaveBeenCalledWith(PlotType.SPATIAL_OMICS_3D);
      });

    });
  });

  describe('region set-operations (jit-ui#85)', () => {
    /** Make the mock store stateful so replaceRegions can read back results. */
    function statefulRegions(initial: Region[]) {
      let regions = initial.slice();
      plotService.getRegions = jest.fn(() => regions.slice());
      plotService.setRegions = jest.fn((rs: Region[]) => {
        regions = rs.map((r, i) => { if (r.id == null) r.id = 100 + i; return r; });
      });
      plotService.setSelectedShapeIndices = jest.fn();
      return () => regions;
    }

    it('offers Merge / Ungroup / Inverse in the context menu according to the selection', () => {
      statefulRegions([rectRegion(0, 0, 10, 10), rectRegion(50, 50, 10, 10)]);
      const labels = () => ((component as any).buildRegionActionItems() as { label?: string }[])
        .map((i) => i.label);
      (component as any).selectedIndices = [0, 1];
      expect(labels()).toContain('Merge / group');
      expect(labels()).toContain('Inverse');
      expect(labels()).not.toContain('Ungroup');

      (component as any).selectedIndices = [0];
      expect(labels()).not.toContain('Merge / group'); // needs ≥2
      expect(labels()).toContain('Inverse');
    });

    it('selectAllRegions selects every non-profile region', () => {
      const profile = new Region(); profile.kind = 'profile'; profile.bounds = new Rectangle();
      statefulRegions([rectRegion(0, 0, 10, 10), profile, rectRegion(50, 50, 10, 10)]);
      component.selectAllRegions();
      expect(plotService.setSelectedShapeIndices).toHaveBeenCalledWith([0, 2]); // profile (1) excluded
    });

    it('mergeRegions commits one merged region and selects it', () => {
      const read = statefulRegions([rectRegion(0, 0, 20, 20), rectRegion(10, 10, 20, 20)]);
      (component as any).selectedIndices = [0, 1];
      component.mergeRegions();
      expect(plotService.setRegions).toHaveBeenCalled();
      expect(read().length).toBe(1);                       // two → one
      expect(read()[0].bounds).toBeInstanceOf(Polygon);    // overlapping → connected
      expect(plotService.setSelectedShapeIndices).toHaveBeenCalled();
    });

    it('mergeRegions of disjoint rectangles yields a MultiPolygon', () => {
      const read = statefulRegions([rectRegion(0, 0, 10, 10), rectRegion(50, 50, 10, 10)]);
      (component as any).selectedIndices = [0, 1];
      component.mergeRegions();
      expect(read()[0].bounds).toBeInstanceOf(MultiPolygon);
    });

    it('ungroupRegions splits a multi-part region back into parts', () => {
      const read = statefulRegions([rectRegion(0, 0, 10, 10), rectRegion(50, 50, 10, 10)]);
      (component as any).selectedIndices = [0, 1];
      component.mergeRegions();          // → one MultiPolygon
      (component as any).selectedIndices = [0];
      component.ungroupRegions();
      expect(read().length).toBe(2);     // split back into two regions
    });

    it('simplifyRegions replaces the selection and closes the dialog', () => {
      const read = statefulRegions([
        (() => { const r = new Region(); const p = new Polygon();
          p.xpoints = [0, 50, 100, 100, 0]; p.ypoints = [0, 1, 0, 100, 100];
          p.npoints = 5; p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]); p.closed = true;
          r.bounds = p; return r; })(),
      ]);
      (component as any).selectedIndices = [0];
      component.displaySimplifyDialog = true;
      component.simplifyRegions(2);
      expect((read()[0].bounds as Polygon).xpoints.length).toBe(4); // bump removed
      expect(component.displaySimplifyDialog).toBe(false);
    });
  });

  it('onZScrub debounces slice swaps while dragging (last value wins)', () => {
    component.onZScrub(1);
    component.onZScrub(2);
    component.onZScrub(3);
    expect(plotService.setZIndex).not.toHaveBeenCalled();
    jest.advanceTimersByTime(120);
    expect(plotService.setZIndex).toHaveBeenCalledTimes(1);
    expect(plotService.setZIndex).toHaveBeenCalledWith(3);
    expect(component.zIndex).toBe(3);
  });

  it('onZSlide applies immediately and cancels a pending scrub', () => {
    component.onZScrub(2);
    component.onZSlide(5);
    expect(plotService.setZIndex).toHaveBeenCalledWith(5);
    jest.advanceTimersByTime(500);
    expect(plotService.setZIndex).toHaveBeenCalledTimes(1); // scrub dropped
  });

  it('stepSlice clamps to the stack bounds', () => {
    component.maxIndex = 4;
    component.zIndex = 4;
    component.stepSlice(1); // already at the end
    expect(plotService.setZIndex).not.toHaveBeenCalled();
    component.stepSlice(-1);
    expect(plotService.setZIndex).toHaveBeenCalledWith(3);
    component.zIndex = 0;
    plotService.setZIndex.mockClear();
    component.stepSlice(-1); // already at the start
    expect(plotService.setZIndex).not.toHaveBeenCalled();
  });

  describe('per-slice regions on scrub (jit-ui#93)', () => {
    beforeEach(() => {
      plotService.setRegions = jest.fn();
      plotService.importRegions = jest.fn();
    });

    // Scrubbing hands the slice to the store via setDisplaySlice. In stack mode
    // the store swaps the live region set (preserving edits); outside stack mode
    // it only records the slice, leaving single-plane regions untouched. The
    // per-slice swap/preserve semantics themselves are covered in
    // region-store.service.spec (enterStackMode / setDisplaySlice / getSliceRegions).
    it('routes the committed slice to the store via setDisplaySlice', () => {
      component.onZSlide(2); // commit is synchronous
      expect(plotService.setZIndex).toHaveBeenCalledWith(2);
      expect(plotService.setDisplaySlice).toHaveBeenCalledWith(2);
    });

    it('does not re-import geojson or replace regions on scrub (the store owns the swap)', () => {
      component.imageInfo = { roiJsonStrs: ['GEO-0', 'GEO-1', null] } as any;

      component.onZSlide(1);
      expect(plotService.setDisplaySlice).toHaveBeenCalledWith(1);
      expect(plotService.importRegions).not.toHaveBeenCalled();
      expect(plotService.setRegions).not.toHaveBeenCalled();
    });

    it('debounced scrub commits the last slice to the store once', () => {
      component.onZScrub(1);
      component.onZScrub(2);
      component.onZScrub(3);
      expect(plotService.setDisplaySlice).not.toHaveBeenCalled();
      jest.advanceTimersByTime(120);
      expect(plotService.setDisplaySlice).toHaveBeenCalledTimes(1);
      expect(plotService.setDisplaySlice).toHaveBeenCalledWith(3);
    });
  });

  it('openChannelHistogram shows the dialog; dockToolbar re-docks it', () => {
    expect(component.showChannelHistogram).toBe(false);
    component.openChannelHistogram();
    expect(component.showChannelHistogram).toBe(true);

    component.toolbarFloating = true;
    component.dockToolbar();
    expect(component.toolbarFloating).toBe(false);
  });

  describe('toolbar + region handler delegation', () => {
    it('simple viewport actions delegate to the service', () => {
      component.downloadImage();
      component.autoscaleImage();
      component.resetAxes();
      component.zoomIn();
      component.zoomOut();
      component.deleteRegion();
      expect(plotService.downloadImage).toHaveBeenCalled();
      expect(plotService.autoscale).toHaveBeenCalled();
      expect(plotService.resetAxes).toHaveBeenCalled();
      expect(plotService.zoomIn).toHaveBeenCalled();
      expect(plotService.zoomOut).toHaveBeenCalled();
      expect(plotService.deleteActiveShape).toHaveBeenCalled();
    });

    it('onToggleImageSmoothing flips state and applies it', () => {
      expect(component.imageSmoothingEnabled).toBe(false);
      component.onToggleImageSmoothing();
      expect(component.imageSmoothingEnabled).toBe(true);
      expect(plotService.setImageSmoothingEnabled).toHaveBeenCalledWith(true);
    });

    it('hasRegions / getRegionPolygons read through the service', () => {
      plotService.getRegions.mockReturnValue([{ id: 1 }]);
      expect(component.hasRegions()).toBe(true);
      component.getRegionPolygons();
      expect(plotService.getRegionPolygons).toHaveBeenCalled();
    });

    it('onWandSensitivityChange updates state + service and guards bad values', () => {
      component.onWandSensitivityChange(3.5);
      expect(component.wandSensitivity).toBe(3.5);
      expect(plotService.setWandOptions).toHaveBeenCalledWith({ sensitivity: 3.5 });
      component.onWandSensitivityChange(undefined);
      component.onWandSensitivityChange(NaN);
      expect(plotService.setWandOptions).toHaveBeenCalledTimes(1); // bad values ignored
    });

    it('onVertexEraserRadiusChange updates state + service', () => {
      component.onVertexEraserRadiusChange(7);
      expect(component.vertexEraserRadius).toBe(7);
      expect(plotService.setVertexEraserRadius).toHaveBeenCalledWith(7);
    });

    it('onIsoRangeChange updates the isosurface controls and guards short arrays', () => {
      const controls = { setIsoRange: jest.fn() };
      plotService.getIsosurfaceControls.mockReturnValue(controls);
      component.onIsoRangeChange([10, 200]);
      expect(controls.setIsoRange).toHaveBeenCalledWith(10, 200);
      component.onIsoRangeChange([5]); // too short → ignored
      component.onIsoRangeChange(undefined);
      expect(controls.setIsoRange).toHaveBeenCalledTimes(1);
    });

    it('toggleDragMode arms a region tool via the overlay and toggles off on re-select', () => {
      const overlay = mockOverlay();
      plotService.getRegionOverlay.mockReturnValue(overlay);
      component.toggleDragMode('drawrect');
      expect(component.activeDragMode).toBe('drawrect');
      expect(overlay.setMode).toHaveBeenLastCalledWith('drawrect');
      component.toggleDragMode('drawrect'); // re-select → toggle off
      expect(component.activeDragMode).toBeNull();
      expect(overlay.setMode).toHaveBeenLastCalledWith('none');
    });

    it('toggleDragMode pan sets the viewport drag mode', () => {
      component.toggleDragMode('pan');
      expect(plotService.setDragMode).toHaveBeenCalledWith('pan');
    });

    it('toggleDragMode wand arms the wand with the current sensitivity', () => {
      component.wandSensitivity = 2.5;
      component.toggleDragMode('wand');
      expect(plotService.setWandMode).toHaveBeenCalledWith(true, { sensitivity: 2.5 });
    });

    it('toggleDragMode eraseVertex also pushes the eraser radius', () => {
      component.vertexEraserRadius = 12;
      component.toggleDragMode('eraseVertex');
      expect(plotService.setVertexEraserMode).toHaveBeenLastCalledWith(true);
      expect(plotService.setVertexEraserRadius).toHaveBeenCalledWith(12);
    });

    it('toBezierRegion / toPolygonRegion drive the overlay bezier toggle', () => {
      const overlay = mockOverlay();
      plotService.getRegionOverlay.mockReturnValue(overlay);
      component.toBezierRegion();
      expect(overlay.setSelectedBezier).toHaveBeenLastCalledWith(true);
      component.toPolygonRegion();
      expect(overlay.setSelectedBezier).toHaveBeenLastCalledWith(false);
    });

    it('cancelLoading resets the loading flags and slice index', () => {
      component.cancelLoading();
      expect(plotService.setZIndex).toHaveBeenCalledWith(0);
      expect(plotService.setStackLoading).toHaveBeenCalledWith(false);
    });

    it('updateZIndex clamps the index into range before pushing it', () => {
      component.maxIndex = 5;
      component.zIndex = 99;
      component.updateZIndex();
      expect(component.zIndex).toBe(5);
      expect(plotService.setZIndex).toHaveBeenCalledWith(5);
    });
  });
});

/**
 * The window keydown shortcuts must leave browser/OS shortcuts alone: Cmd/Ctrl+D
 * (bookmark) used to delete the selected region, Ctrl+S toggled Select, etc.
 * (review CORE-2).
 */
describe('VisualizerComponent — keyboard shortcuts with modifiers (CORE-2)', () => {
  let component: VisualizerComponent;
  let plotService: ReturnType<typeof mockPlotService>;
  let toggle: jest.SpyInstance;

  beforeEach(() => {
    plotService = mockPlotService();
    plotService.undo = jest.fn();
    plotService.redo = jest.fn();
    component = makeComponent(plotService);
    component.ngAfterViewInit();
    toggle = jest.spyOn(component, 'toggleDragMode').mockImplementation(() => undefined);
  });

  afterEach(() => component.ngOnDestroy());

  const press = (init: KeyboardEventInit) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));

  it.each([
    { key: 'd', metaKey: true },
    { key: 'd', ctrlKey: true },
    { key: 'D', ctrlKey: true, shiftKey: true },
    { key: 'Delete', altKey: true },
    { key: 's', ctrlKey: true },
    { key: 'f', metaKey: true },
    { key: 'p', ctrlKey: true },
    { key: 'l', metaKey: true },
    { key: 'w', ctrlKey: true },
  ])('ignores %o (no region delete, no tool toggle)', (init) => {
    press(init);
    expect(plotService.deleteActiveShape).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it('a plain d still deletes the selected region and a plain s still toggles Select', () => {
    press({ key: 'd' });
    expect(plotService.deleteActiveShape).toHaveBeenCalledTimes(1);
    press({ key: 's' });
    expect(toggle).toHaveBeenCalledWith('select');
  });

  it('Ctrl+Z / Cmd+Shift+Z still undo / redo', () => {
    press({ key: 'z', ctrlKey: true });
    expect(plotService.undo).toHaveBeenCalledTimes(1);
    press({ key: 'z', metaKey: true, shiftKey: true });
    expect(plotService.redo).toHaveBeenCalledTimes(1);
    expect(plotService.deleteActiveShape).not.toHaveBeenCalled();
  });
});

/**
 * Preemption of a superseded render (#5).
 *
 * A newer image used to be DROPPED while an earlier render was in flight, which
 * produced three failures: the wrong image on screen, an overlay that never
 * cleared, and (on a cold image) a minutes-long window where every click was
 * discarded. These tests pin the two halves of the fix — the newer image is
 * rendered, and the superseded render can no longer touch UI state.
 */
describe('VisualizerComponent — render preemption (#5)', () => {
  function infoFor(fileName: string): any {
    return {
      fileName,
      urls: [`/api/preview?info=${fileName}`],
      smallUrls: undefined,
      isStack: false,
      showStack: false,
      isGrayscale: false,
      trueImageSize: [100, 100],
      imageMeta: [{ x: 100, y: 100, z: 1, rgbChannels: 3, channelCount: 3 }],
    };
  }

  beforeEach(() => {
    orchestratorHosts.length = 0;
  });

  it('renders the newer image instead of dropping it, and stops the replaced render', () => {
    const { plot, imageInfo$ } = harness();

    imageInfo$.next(infoFor('A.tif'));
    expect(orchestratorHosts).toHaveLength(1);
    expect(plot.reset).toHaveBeenCalledTimes(1);

    // B arrives while A is still in flight. Before the fix this was discarded.
    imageInfo$.next(infoFor('B.tif'));
    expect(orchestratorHosts).toHaveLength(2);
    expect(plot.reset).toHaveBeenCalledTimes(2);
    // the replaced render is told to stop streaming frames
    expect(plot.cancelLoading).toHaveBeenCalled();
  });

  it("a superseded render's callbacks cannot flip UI state", () => {
    const { component, state, imageInfo$ } = harness();
    imageInfo$.next(infoFor('A.tif'));
    imageInfo$.next(infoFor('B.tif'));
    const [staleHost, liveHost] = orchestratorHosts;

    state.setImageLoading.mockClear();
    staleHost.smallShown();
    staleHost.sharpenSettled();
    staleHost.finished(false);

    // The overlay belongs to B now, and B is still rendering.
    expect(state.setImageLoading).not.toHaveBeenCalled();
    expect((component as any).running).toBe(true);

    // B's own callbacks still work.
    liveHost.finished(false);
    expect(state.setImageLoading).toHaveBeenCalledWith(false);
    expect((component as any).running).toBe(false);
  });

  it('a superseded renderPhase does not issue a load at all', async () => {
    const { plot, imageInfo$ } = harness();
    imageInfo$.next(infoFor('A.tif'));
    imageInfo$.next(infoFor('B.tif'));
    const [staleHost, liveHost] = orchestratorHosts;

    plot.load.mockClear();
    await expect(staleHost.renderPhase(infoFor('A.tif'), false)).resolves.toBeNull();
    // Not merely discarded after loading — never fetched. RenderOrchestrator calls
    // renderPhase per tier and retries the sharpen pass, so a stale render that
    // still loaded would keep hitting the backend for an abandoned image.
    expect(plot.load).not.toHaveBeenCalled();

    await liveHost.renderPhase(infoFor('B.tif'), false);
    expect(plot.load).toHaveBeenCalledTimes(1);
  });
});

describe('VisualizerComponent — teardown (CORE-3)', () => {
  it('leaves no subscription behind on the ports or the backend after ngOnDestroy', () => {
    const { component, subjects } = harness();
    expect(subjects.some((s) => s.observed)).toBe(true); // sanity: init subscribed
    component.ngOnDestroy();
    const leaked = subjects.filter((s) => s.observed);
    expect(leaked).toHaveLength(0);
  });

  it('stops mirroring the stack-loading streams once destroyed', () => {
    const progress$ = new BehaviorSubject(0);
    const loading$ = new BehaviorSubject(false);
    const { component } = harness({
      getStackLoadingProgress: () => progress$,
      isStackLoading: () => loading$,
    });
    component.ngOnDestroy();
    progress$.next(42);
    loading$.next(true);
    expect(component.loadingPercentage).toBe(0);
    expect(component.stackLoading).toBe(false);
  });
});

describe('VisualizerComponent — global listeners run outside Angular (CORE-4)', () => {
  let component: VisualizerComponent;
  let added: { type: string; outside: boolean }[];

  beforeEach(() => {
    let outside = false;
    added = [];
    const realAdd = window.addEventListener.bind(window);
    jest.spyOn(window, 'addEventListener').mockImplementation(((type: string, l: any, o?: any) => {
      added.push({ type, outside });
      realAdd(type, l, o);
    }) as any);
    component = makeComponent(mockPlotService());
    (component as any).ngZone = {
      run: (fn: () => unknown) => fn(),
      runOutsideAngular: (fn: () => unknown) => {
        outside = true;
        try { return fn(); } finally { outside = false; }
      },
    };
    component.ngAfterViewInit();
  });

  afterEach(() => {
    component.ngOnDestroy();
    jest.restoreAllMocks();
  });

  it('registers every window listener outside the zone, so a mousemove does not run change detection', () => {
    const types = added.map((a) => a.type).sort();
    expect(types).toEqual(['contextmenu', 'keydown', 'mousemove', 'mouseup', 'resize', 'wheel']);
    expect(added.every((a) => a.outside)).toBe(true);
  });

  it('steps the slice on ArrowRight/ArrowLeft from the one keydown listener', () => {
    component.imageInfo = { isStack: true } as any;
    component.maxIndex = 5;
    const press = (key: string) =>
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
    press('ArrowRight');
    press('ArrowRight');
    expect(component.zIndex).toBe(2);
    press('ArrowLeft');
    expect(component.zIndex).toBe(1);
  });
});

describe('VisualizerComponent — failed and superseded renders (CORE-11)', () => {
  const info = (fileName: string): any => ({
    fileName, urls: [`/p/${fileName}`], isStack: false, showStack: false, isGrayscale: true,
    trueImageSize: [10, 10], imageMeta: [],
  });

  beforeEach(() => { orchestratorHosts.length = 0; });

  it('treats plot() resolving false as a failure, not a finished render', async () => {
    const { component, plot, imageInfo$ } = harness();
    plot.plot.mockResolvedValue(false);
    imageInfo$.next(info('A.tif'));
    const [host] = orchestratorHosts;
    await expect(host.renderPhase(info('A.tif'), false)).rejects.toThrow();
    component.ngOnDestroy();
  });

  it('tells the user when the current render failed, and stays quiet for a superseded one', () => {
    const { component, imageInfo$, messages } = harness();
    imageInfo$.next(info('A.tif'));
    imageInfo$.next(info('B.tif'));
    const [stale, live] = orchestratorHosts;
    stale.renderFailed(new Error('gone'));
    expect(messages.add).not.toHaveBeenCalled();
    live.renderFailed(new Error('no WebGPU'));
    expect(messages.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
    component.ngOnDestroy();
  });

  it('hands load() an AbortSignal and aborts it when a newer image supersedes the render', async () => {
    const { component, plot, imageInfo$ } = harness();
    imageInfo$.next(info('A.tif'));
    await orchestratorHosts[0].renderPhase(info('A.tif'), false);
    const signal: AbortSignal = plot.load.mock.calls[0][2];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    imageInfo$.next(info('B.tif'));
    expect(signal.aborted).toBe(true);
    component.ngOnDestroy();
  });

  it('aborts the in-flight load on cancel and on destroy', async () => {
    const { component, plot, imageInfo$ } = harness();
    imageInfo$.next(info('A.tif'));
    await orchestratorHosts[0].renderPhase(info('A.tif'), false);
    component.cancelLoading();
    expect(plot.load.mock.calls[0][2].aborted).toBe(true);

    imageInfo$.next(info('B.tif'));
    await orchestratorHosts[1].renderPhase(info('B.tif'), false);
    component.ngOnDestroy();
    expect(plot.load.mock.calls[1][2].aborted).toBe(true);
  });
});

describe('VisualizerComponent — host-owned image info is never mutated (CORE-13)', () => {
  const stack = (extra: Record<string, unknown> = {}): any => Object.freeze({
    fileName: 'series.tif', urls: ['/0', '/1', '/2', '/3'], isStack: true, showStack: false,
    isGrayscale: true, trueImageSize: [10, 10], imageMeta: [], ...extra,
  });

  it('honours the one-shot initialZIndex without writing to the host object', () => {
    const { component, imageInfo$ } = harness();
    const info = stack({ initialZIndex: 2 });
    expect(() => imageInfo$.next(info)).not.toThrow();
    expect(component.zIndex).toBe(2);
    // Re-driving the pipeline from the component's copy must not jump back to the hint.
    expect(component.imageInfo?.initialZIndex).toBeUndefined();
    component.ngOnDestroy();
  });

  it('publishes the image meta keyed by file name, so channel edits do not leak across images (CORE-8)', () => {
    const { component, imageInfo$, plot } = harness();
    imageInfo$.next(stack());
    expect(plot.setImageMeta).toHaveBeenCalledWith([], 'series.tif');
    component.ngOnDestroy();
  });

  it('does not re-apply the hint when the host re-emits the very same object', () => {
    const { component, imageInfo$ } = harness();
    const info = stack({ initialZIndex: 2 });
    imageInfo$.next(info);
    component.zIndex = 3; // the user scrubbed
    imageInfo$.next(info);
    expect(component.zIndex).toBe(3);
    component.ngOnDestroy();
  });

  it('switching to a stack-only Plotly type re-emits a copy with showStack on', () => {
    const { component, imageInfo$, state } = harness();
    const info = stack();
    imageInfo$.next(info);
    (component as any).plotTypeMenu = [{ type: PlotType.ISOSURFACE, requiresStack: true, dimensions: '3d' }];
    expect(() => component.onSelectPlotType(PlotType.ISOSURFACE)).not.toThrow();
    const sent = state.setImageInfo.mock.calls.at(-1)[0];
    expect(sent).toMatchObject({ fileName: 'series.tif', showStack: true });
    expect(sent).not.toBe(info);
    component.ngOnDestroy();
  });
});

describe('VisualizerComponent — host handle (CORE-10)', () => {
  it('registers a small typed handle with the host, not the component itself', () => {
    const { component, state, plot } = harness();
    expect(state.setDiagram).toHaveBeenCalledTimes(1);
    const handle = state.setDiagram.mock.calls[0][0];
    expect(handle).not.toBe(component);
    expect(handle.visualizer).toBe(plot);
    expect(handle.plotService).toBe(plot); // deprecated alias jit-ui still reads
    plot.getRegions.mockReturnValue([{ id: 1 }]);
    expect(handle.hasRegions()).toBe(true);
    handle.getRegionPolygons();
    expect(plot.getRegionPolygons).toHaveBeenCalled();
    component.ngOnDestroy();
  });

  it('clears the registration on destroy so the host does not keep a dead viewer', () => {
    const { component, state } = harness();
    component.ngOnDestroy();
    expect(state.setDiagram).toHaveBeenLastCalledWith(null);
  });
});

describe('VisualizerComponent — autoscale from the backend (CORE-5)', () => {
  it('disarms the backend tool along with the toolbar, not just the toolbar', () => {
    const autoscale$ = new BehaviorSubject<void>(undefined);
    const { component, plot, store } = harness({ getAutoscaleEvent: () => autoscale$ });
    component.toggleDragMode('wand');
    expect(plot.setWandMode).toHaveBeenLastCalledWith(true, expect.anything());

    autoscale$.next(); // the context-menu "Autoscale" on OSD / napari
    expect(component.activeDragMode).toBeNull();
    expect(plot.setWandMode).toHaveBeenLastCalledWith(false, expect.anything());
    let tool: string | null = 'unset';
    store.getActiveTool$().subscribe((t) => (tool = t)).unsubscribe();
    expect(tool).toBeNull();
    component.ngOnDestroy();
  });
});

describe('VisualizerComponent — contributed tool parameters', () => {
  /** A tool whose checkpoint overrides two of the tool's baseline values. */
  function tool(): ToolbarToolContribution {
    return {
      id: 'detect',
      label: 'Detect',
      icon: { pi: 'pi-search' },
      runTooltip: 'run',
      models: () => [
        { id: 'crowded', label: 'Crowded', defaults: { overlapX: 60, confidence: 0.8 } },
        { id: 'sparse', label: 'Sparse', defaults: { overlapX: 0 } },
      ],
      defaultModelId: () => 'crowded',
      params: [
        { id: 'confidence', label: 'Confidence', type: 'number' },
        { id: 'overlapX', label: 'Overlap X', type: 'number' },
        { id: 'minArea', label: 'Min area', type: 'number' },
      ],
      defaultParams: () => ({ confidence: 0.6, overlapX: 0, minArea: 0 }),
      progress: { status$: null as never, busy$: null as never, progress$: null as never },
      run: async () => 0,
    };
  }

  function componentWith(t: ToolbarToolContribution): VisualizerComponent {
    const c = Object.create(VisualizerComponent.prototype) as VisualizerComponent;
    c.contributedTools = [t];
    c.toolModelIds = {};
    c.toolParams = {};
    return c;
  }

  it('applies the active checkpoint defaults on the FIRST use, not just after a switch', () => {
    // The bug this pins: the first seed called defaultParams directly and
    // skipped the per-model merge, so a tool's opening run used the tool's
    // baseline tiling and thresholds instead of the checkpoint's — and looked
    // correct the moment the user touched the model picker.
    const c = componentWith(tool());

    const p = c.paramsFor('detect');

    expect(p['overlapX']).toBe(60);
    expect(p['confidence']).toBe(0.8);
    expect(p['minArea']).toBe(0); // tool baseline still applies where the model is silent
  });

  it('re-seeds from the newly picked checkpoint', () => {
    const c = componentWith(tool());
    c.paramsFor('detect');

    c.onToolModelChange({ toolId: 'detect', modelId: 'sparse' });

    expect(c.paramsFor('detect')['overlapX']).toBe(0);
    // 'sparse' overrides only overlapX, so confidence falls back to the tool's.
    expect(c.paramsFor('detect')['confidence']).toBe(0.6);
  });

  it('Reset returns to the same values a first use would have produced', () => {
    const c = componentWith(tool());
    const first = { ...c.paramsFor('detect') };
    c.paramsFor('detect')['overlapX'] = 5;

    c.resetToolParams('detect');

    expect(c.paramsFor('detect')).toEqual(first);
  });
  it('builds the parameter dialog model once on open, not per change-detection pass (CORE-22)', () => {
    const c = componentWith(tool());
    c.openToolParams('detect');
    const open = c.openParams!;
    expect(open.tool.id).toBe('detect');
    expect(open.fields.map((f) => f.spec.id)).toEqual(['confidence', 'overlapX', 'minArea']);
    expect(open.fields[0].number).toBe(open.fields[0].spec); // narrowed once, here
    expect(open.values).toBe(c.paramsFor('detect'));

    // A reset or checkpoint switch while the dialog is open re-binds it to the new values.
    c.resetToolParams('detect');
    expect(c.openParams!.values).toBe(c.paramsFor('detect'));
    c.onToolModelChange({ toolId: 'detect', modelId: 'sparse' });
    expect(c.openParams!.values['overlapX']).toBe(0);

    c.closeToolParams();
    expect(c.openParams).toBeNull();
  });
});
