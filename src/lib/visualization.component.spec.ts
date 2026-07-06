import { BehaviorSubject } from 'rxjs';

import { VisualizationComponent } from './visualization.component';
import { VisualizerStore } from './store/visualizer-store.service';
import { RegionOpsService } from './region-ops.service';
import { WandService } from './toolbar/wand/wand.service';
import { Region, Rectangle, Polygon, MultiPolygon } from './models/region';

function rectRegion(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const b = new Rectangle();
  b.x = x; b.y = y; b.width = w; b.height = h;
  r.bounds = b;
  return r;
}

/**
 * UI-shell tests for VisualizationComponent (refactoring plan, Step 7) —
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
  };
}

describe('VisualizationComponent (UI shell)', () => {
  let component: VisualizationComponent;
  let plotService: any;

  beforeEach(() => {
    jest.useFakeTimers();
    plotService = mockPlotService();
    component = new VisualizationComponent(
      { setDiagram: jest.fn(), setImageLoading: jest.fn(), setImageInfo: jest.fn() } as any, // ImageStatePort
      plotService,
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
    );
  });

  afterEach(() => jest.useRealTimers());

  it('constructs and reads the plot-type descriptors through the service', () => {
    expect(component).toBeTruthy();
    expect(plotService.getPlotTypeDescriptors).toHaveBeenCalled();
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

  describe('per-slice ROI swap on scrub (jit-ui#93)', () => {
    beforeEach(() => {
      plotService.importRegions = jest.fn((_json: string) => [{ getShape: () => ({}) } as any]);
      plotService.setRegions = jest.fn();
      plotService.getShowShapeLabel = jest.fn().mockReturnValue(true);
      plotService.setPreviousShapes = jest.fn();
      plotService.resetUndoHistory = jest.fn();
    });

    it('swaps to the slice\'s own ROI for a folder stack that carries roiJsonStrs', () => {
      component.imageInfo = { roiJsonStrs: ['GEO-0', 'GEO-1', null] } as any;

      component.onZSlide(1); // commit is synchronous
      expect(plotService.setZIndex).toHaveBeenCalledWith(1);
      expect(plotService.importRegions).toHaveBeenCalledWith('GEO-1');
      expect(plotService.setRegions).toHaveBeenCalledTimes(1);
    });

    it('clears regions on a slice with no geojson (no stale ROI carried over)', () => {
      component.imageInfo = { roiJsonStrs: ['GEO-0', 'GEO-1', null] } as any;

      component.onZSlide(2); // slice 2 → null
      expect(plotService.importRegions).not.toHaveBeenCalled();
      expect(plotService.setRegions).toHaveBeenCalledWith([]);
    });

    it('does NOT touch regions on scrub for a single image / server z-stack (scalar roiJsonStr)', () => {
      component.imageInfo = { roiJsonStr: 'GLOBAL' } as any; // not per-slice

      component.onZSlide(2);
      expect(plotService.setZIndex).toHaveBeenCalledWith(2);
      expect(plotService.importRegions).not.toHaveBeenCalled();
      expect(plotService.setRegions).not.toHaveBeenCalled();
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
