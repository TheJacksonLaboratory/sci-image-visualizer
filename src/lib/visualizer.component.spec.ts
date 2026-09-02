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
      // the spatial type still needs a dataset, exactly as a volume still needs a
      // stack. This fixture has no dataset, so it is the one type held back.
      const gated = ALL_DESCRIPTORS.filter((d) => d.requiresSpatialData);
      expect(gated).toHaveLength(1);
      expect(component.plotTypeOptions.length).toBe(ALL_DESCRIPTORS.length - gated.length);
      expect(byType.has(PlotType.SPATIAL_OMICS)).toBe(false);
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

    it('canMerge / canUngroup / hasEligibleSelection reflect the selection', () => {
      statefulRegions([rectRegion(0, 0, 10, 10), rectRegion(50, 50, 10, 10)]);
      (component as any).selectedIndices = [0, 1];
      expect(component.canMergeRegions).toBe(true);
      expect(component.hasEligibleSelection).toBe(true);
      expect(component.canUngroupRegions).toBe(false);

      (component as any).selectedIndices = [0];
      expect(component.canMergeRegions).toBe(false); // needs ≥2
      expect(component.hasEligibleSelection).toBe(true);
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

    it('toggleReverseScale flips state and pushes it to the service', () => {
      component.toggleReverseScale();
      expect(component.reversescale).toBe(true);
      expect(plotService.setReverseScale).toHaveBeenCalledWith(true);
      component.toggleReverseScale();
      expect(plotService.setReverseScale).toHaveBeenLastCalledWith(false);
    });

    it('onToggleImageSmoothing flips state and applies it', () => {
      expect(component.imageSmoothingEnabled).toBe(false);
      component.onToggleImageSmoothing();
      expect(component.imageSmoothingEnabled).toBe(true);
      expect(plotService.setImageSmoothingEnabled).toHaveBeenCalledWith(true);
    });

    it('selectColormap applies a leaf node but ignores a parent (has children)', () => {
      component.selectColormap({ label: 'Viridis' } as any);
      expect(plotService.setColormap).toHaveBeenCalledTimes(1);
      component.selectColormap({ label: 'group', children: [] } as any);
      expect(plotService.setColormap).toHaveBeenCalledTimes(1); // parent ignored
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

  /**
   * ngOnInit subscribes to a long tail of streams on both ports. Rather than
   * enumerating them (and re-enumerating whenever one is added), wrap the mock so
   * any unlisted `getX$()` / `isX()` accessor answers with a BehaviorSubject and
   * anything else with a jest.fn(). Explicit overrides below win, and identities are
   * cached so `expect(plot.reset)` is stable across accesses.
   */
  function selfCompleting(base: any): any {
    const cache: any = base;
    return new Proxy(cache, {
      has: () => true,
      get(target, prop: any) {
        if (typeof prop !== 'string' || prop in target) return target[prop];
        target[prop] = /\$$|^(get|is)[A-Z]/.test(prop)
          ? jest.fn(() => new BehaviorSubject(false))
          : jest.fn();
        return target[prop];
      },
    });
  }

  function harness() {
    const plotBase: any = mockPlotService();
    Object.assign(plotBase, {
      getAutoscaleEvent: () => new BehaviorSubject(''),
      getColormap: () => new BehaviorSubject('Greys'),
      getReverseScale: () => new BehaviorSubject(false),
      getIntensityProfile$: () => new BehaviorSubject([]),
      getStackLoadingProgress: () => new BehaviorSubject(0),
      getViewportChange$: () => new BehaviorSubject({ x: 0, y: 0, width: 1, height: 1 }),
      isStackLoading: () => new BehaviorSubject(false),
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
      setPreviousShapes: jest.fn(),
      resetUndoHistory: jest.fn(),
      setStackLoading: jest.fn(),
    });
    const plot: any = selfCompleting(plotBase);
    const imageInfo$ = new BehaviorSubject<any>(null);
    const stateBase: any = {
      getImageInfo$: () => imageInfo$,
      getFilename$: () => new BehaviorSubject('none'),
      getImageLoadingMessage$: () => new BehaviorSubject(''),
      getCacheProgress$: () => new BehaviorSubject(null),
      getPanelWidth$: () => new BehaviorSubject(500),
      isImageLoading$: () => new BehaviorSubject(false),
      isImageCached$: () => new BehaviorSubject(true),
      isZoom$: () => new BehaviorSubject(false),
      setDiagram: jest.fn(),
      setImageLoading: jest.fn(),
      setImageLoadingMessage: jest.fn(),
      setImageInfo: jest.fn(),
      setImageCached: jest.fn(),
      setLoadingError: jest.fn(),
      setZoom: jest.fn(),
    };
    const state: any = selfCompleting(stateBase);
    const component = new VisualizerComponent(
      state,
      plot,
      { add: jest.fn(), clear: jest.fn() } as any,
      { run: (fn: () => void) => fn(), runOutsideAngular: (fn: () => void) => fn() } as any,
      { detectChanges: jest.fn(), markForCheck: jest.fn() } as any,
      new VisualizerStore(),
      { status$: new BehaviorSubject(''), busy$: new BehaviorSubject(false), progress$: new BehaviorSubject(-1) } as any,
      { status$: new BehaviorSubject(''), busy$: new BehaviorSubject(false), progress$: new BehaviorSubject(-1) } as any,
      { status$: new BehaviorSubject(''), busy$: new BehaviorSubject(false), progress$: new BehaviorSubject(-1) } as any,
      new RegionOpsService(new WandService()),
    );
    component.ngOnInit();
    return { component, plot, state, imageInfo$ };
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
    staleHost.finished(false, 'stale render finished');

    // The overlay belongs to B now, and B is still rendering.
    expect(state.setImageLoading).not.toHaveBeenCalled();
    expect((component as any).running).toBe(true);

    // B's own callbacks still work.
    liveHost.finished(false, 'live render finished');
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
});
