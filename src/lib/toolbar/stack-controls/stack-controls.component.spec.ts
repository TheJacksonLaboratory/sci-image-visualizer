import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { StackControlsComponent } from './stack-controls.component';

describe('StackControlsComponent', () => {
  let fixture: ComponentFixture<StackControlsComponent>;
  let stack: StackControlsComponent;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({
      imports: [VisualizationModule, NoopAnimationsModule],
    }).compileComponents();
    fixture = TestBed.createComponent(StackControlsComponent);
    stack = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
    jest.restoreAllMocks();
  });

  it('the live scrubber shows the slice of the stack', () => {
    fixture.componentRef.setInput('liveScrubber', true);
    fixture.componentRef.setInput('zIndex', 2);
    fixture.componentRef.setInput('maxIndex', 7);
    fixture.detectChanges();
    expect(el().querySelector('p-slider')).not.toBeNull();
    expect(el().textContent).toContain('2 of 7');
  });

  it('the stack toggle picks a stack option; the slice bar shows in single-image mode', () => {
    fixture.componentRef.setInput('stackToggle', true);
    fixture.componentRef.setInput('zIndex', 3);
    fixture.componentRef.setInput('maxIndex', 9);
    fixture.detectChanges();
    expect(el().querySelector('p-slider')).not.toBeNull();
    expect(el().querySelector('p-inputnumber')).toBeNull();
    expect(el().textContent).toContain('3 of 9');
    const picked: string[] = [];
    stack.selectStackOption.subscribe((o) => picked.push(o.val));
    (el().querySelector('button[aria-label="Stack mode"]') as HTMLButtonElement).click();
    expect(picked).toEqual(['true']);
    fixture.componentRef.setInput('showStack', true);
    fixture.detectChanges();
    expect(el().querySelector('p-slider')).toBeNull();
  });

  describe("the heatmap's slice bar", () => {
    let shown: number[];
    let replots: number;
    beforeEach(() => {
      fixture.componentRef.setInput('stackToggle', true);
      fixture.detectChanges();
      shown = [];
      replots = 0;
      stack.zIndexInput.subscribe((z) => shown.push(z));
      stack.reloadAndPlot.subscribe(() => replots++);
    });

    it('re-plots the slice a drag is let go on, not each step of it', () => {
      stack['dragging'] = true;
      stack['onSliceChange'](3);
      stack['onSliceChange'](4);
      expect(shown).toEqual([3, 4]);
      expect(replots).toBe(0);
      stack['onSliceEnd'](4);
      expect(replots).toBe(1);
      expect(stack['dragging']).toBe(false);
    });

    it('re-plots once key steps pause', () => {
      jest.useFakeTimers();
      try {
        stack['onSliceChange'](1);
        stack['onSliceChange'](2);
        jest.advanceTimersByTime(StackControlsComponent.REPLOT_DELAY_MS - 1);
        expect(replots).toBe(0);
        jest.advanceTimersByTime(1);
        expect(replots).toBe(1);
        expect(shown).toEqual([1, 2]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('a click on the track re-plots at once, without a second re-plot after', () => {
      jest.useFakeTimers();
      try {
        stack['onSliceChange'](5);
        stack['onSliceEnd'](5);
        expect(replots).toBe(1);
        jest.advanceTimersByTime(StackControlsComponent.REPLOT_DELAY_MS);
        expect(replots).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('the live scrubber follows the bar and never re-plots', () => {
    fixture.componentRef.setInput('liveScrubber', true);
    fixture.detectChanges();
    const scrubbed: Array<number | undefined> = [];
    const slid: Array<number | undefined> = [];
    let replots = 0;
    stack.zScrub.subscribe((z) => scrubbed.push(z));
    stack.zSlide.subscribe((z) => slid.push(z));
    stack.reloadAndPlot.subscribe(() => replots++);
    stack['onSliceChange'](2);
    stack['onSliceEnd'](2);
    expect(scrubbed).toEqual([2]);
    expect(slid).toEqual([2]);
    expect(replots).toBe(0);
  });
});
