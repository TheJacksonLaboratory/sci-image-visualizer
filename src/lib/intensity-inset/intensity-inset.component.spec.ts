import { BehaviorSubject, Subject } from 'rxjs';

import { IntensityInsetComponent } from './intensity-inset.component';
import { IntensityProfile } from '../contracts/visualizer.contract';
import { IImageInfo } from '../contracts/image.contract';
import { Region } from '../models/region';

describe('IntensityInsetComponent', () => {
  let profiles$: BehaviorSubject<IntensityProfile[]>;
  let viewport$: Subject<{ x: number; y: number; width: number; height: number }>;
  let viz: Record<string, jest.Mock>;
  let inset: IntensityInsetComponent;
  let outside: boolean;
  const LINE: IntensityProfile = { positions: [0, 1], values: [5, 6] };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
    profiles$ = new BehaviorSubject<IntensityProfile[]>([]);
    viewport$ = new Subject();
    viz = {
      getIntensityProfile$: jest.fn(() => profiles$),
      getViewportChange$: jest.fn(() => viewport$),
      renderIntensityInset: jest.fn(),
      refreshIntensitySamplingForRoi: jest.fn(),
      ensureIntensitySampling: jest.fn().mockResolvedValue(undefined),
      getIntensityControls: jest.fn(),
      selectRegion: jest.fn(),
    };
    outside = false;
    const zone = {
      run: (fn: () => unknown) => fn(),
      runOutsideAngular: (fn: () => unknown) => {
        outside = true;
        try { return fn(); } finally { outside = false; }
      },
    };
    inset = new IntensityInsetComponent(viz as never, { detectChanges: jest.fn() } as never, zone as never);
    inset.divId = 'viz-plot-9-inset';
    inset.plotDivName = 'viz-plot-9';
  });

  afterEach(() => {
    inset.ngOnDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows itself while any line exists and charts the profiles into its own div', () => {
    inset.ngOnInit();
    expect(inset.hasProfiles).toBe(false);
    profiles$.next([LINE]);
    expect(inset.hasProfiles).toBe(true);
    expect(viz['renderIntensityInset']).toHaveBeenCalledWith('viz-plot-9-inset', [LINE]);
  });

  it('re-samples at the settled zoom in the Image view only', () => {
    inset.ngOnInit();
    profiles$.next([LINE]);
    viewport$.next({ x: 1, y: 2, width: 3, height: 4 });
    expect(viz['refreshIntensitySamplingForRoi']).not.toHaveBeenCalled();
    inset.imageView = true;
    inset.zIndex = 2;
    viewport$.next({ x: 1, y: 2, width: 3, height: 4 });
    expect(viz['refreshIntensitySamplingForRoi']).toHaveBeenCalledWith(1, 2, 3, 4, 2);
  });

  it('reflows on a window resize, listening outside the zone, and stops on destroy', () => {
    const added: boolean[] = [];
    const realAdd = window.addEventListener.bind(window);
    jest.spyOn(window, 'addEventListener').mockImplementation(
      (type: string, l: EventListenerOrEventListenerObject) => {
        if (type === 'resize') added.push(outside);
        realAdd(type, l);
      });
    inset.ngOnInit();
    expect(added).toEqual([true]);
    profiles$.next([LINE]);
    viz['renderIntensityInset'].mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(viz['renderIntensityInset']).toHaveBeenCalledTimes(1);
    inset.ngOnDestroy();
    window.dispatchEvent(new Event('resize'));
    expect(viz['renderIntensityInset']).toHaveBeenCalledTimes(1);
    expect(profiles$.observed).toBe(false);
  });

  it('reflow() redraws a tick later, and only with lines', () => {
    inset.ngOnInit();
    inset.reflow();
    jest.runAllTimers();
    expect(viz['renderIntensityInset']).not.toHaveBeenCalled();
    profiles$.next([LINE]);
    viz['renderIntensityInset'].mockClear();
    inset.reflow();
    jest.runAllTimers();
    expect(viz['renderIntensityInset']).toHaveBeenCalledTimes(1);
  });

  it('keeps the Image view sampling the committed slice', () => {
    const info = { fileName: 'a' } as IImageInfo;
    inset.ngOnInit();
    inset.imageInfo = info;
    inset.imageView = true;
    inset.sliceCommitted(3);
    expect(viz['ensureIntensitySampling']).not.toHaveBeenCalled(); // no lines yet
    profiles$.next([LINE]);
    inset.sliceCommitted(3);
    expect(viz['ensureIntensitySampling']).toHaveBeenCalledWith(info, 3);
  });

  it('addProfileLine samples first in the Image view, parks the first inset and selects the line', async () => {
    const plot = document.createElement('div');
    plot.id = 'viz-plot-9';
    document.body.appendChild(plot);
    jest.spyOn(plot, 'getBoundingClientRect').mockReturnValue({ right: 800, top: 50 } as DOMRect);
    const line = new Region();
    viz['getIntensityControls'].mockReturnValue({ addProfileLine: () => line });
    inset.ngOnInit();
    inset.imageView = true;
    inset.imageInfo = { fileName: 'a' } as IImageInfo;

    await expect(inset.addProfileLine()).resolves.toBe(line);
    expect(viz['ensureIntensitySampling']).toHaveBeenCalled();
    expect(viz['selectRegion']).toHaveBeenCalledWith(line);
    expect(inset.pos).toEqual({ x: 500, y: 60 });
    plot.remove();
  });
});
