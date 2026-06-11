import { VisualizationComponent } from './visualization.component';
import { VisualizerStore } from './visualizer-store.service';

/**
 * UI-shell tests for VisualizationComponent (refactoring plan, Step 7) —
 * instantiated directly (no TestBed/template) so the shell logic is testable
 * without mounting OSD/Plotly: z-scrub debouncing through the SliceScrubber,
 * keyboard slice stepping with clamping, and the dialog/toolbar flags.
 */

function mockPlotService(): any {
  return {
    capabilities: { has: () => true },
    getColormapOptions: jest.fn().mockReturnValue([{ children: [{ label: 'Greys Inv' }] }]),
    getPlotTypeDescriptors: jest.fn().mockReturnValue([]),
    setZIndex: jest.fn(),
    setPlotType: jest.fn(),
    ensureIntensitySampling: jest.fn().mockResolvedValue(undefined),
  };
}

describe('VisualizationComponent (UI shell)', () => {
  let component: VisualizationComponent;
  let plotService: any;

  beforeEach(() => {
    jest.useFakeTimers();
    plotService = mockPlotService();
    component = new VisualizationComponent(
      { setDiagram: jest.fn() } as any,         // ImageStatePort (unused by these paths)
      plotService,
      { add: jest.fn() } as any,                // MessageService
      { run: (fn: () => void) => fn(), runOutsideAngular: (fn: () => void) => fn() } as any, // NgZone
      { detectChanges: jest.fn(), markForCheck: jest.fn() } as any, // ChangeDetectorRef
      new VisualizerStore(),
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
});
