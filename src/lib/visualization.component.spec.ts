import { BehaviorSubject } from 'rxjs';

import { VisualizationComponent } from './visualization.component';
import { VisualizerStore } from './store/visualizer-store.service';

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
    );
  });

  afterEach(() => jest.useRealTimers());

  it('constructs and reads the plot-type descriptors through the service', () => {
    expect(component).toBeTruthy();
    expect(plotService.getPlotTypeDescriptors).toHaveBeenCalled();
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
