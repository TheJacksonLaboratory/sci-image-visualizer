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
    await TestBed.configureTestingModule({ imports: [VisualizationModule, NoopAnimationsModule] })
      .compileComponents();
    fixture = TestBed.createComponent(StackControlsComponent);
    stack = fixture.componentInstance;
  });

  afterEach(() => { fixture.destroy(); jest.restoreAllMocks(); });

  it('the live scrubber shows the slice of the stack', () => {
    fixture.componentRef.setInput('liveScrubber', true);
    fixture.componentRef.setInput('zIndex', 2);
    fixture.componentRef.setInput('maxIndex', 7);
    fixture.detectChanges();
    expect(el().querySelector('p-slider')).not.toBeNull();
    expect(el().textContent).toContain('2 of 7');
  });

  it('the stack toggle picks a stack option; the slice field shows in single-image mode', () => {
    fixture.componentRef.setInput('stackToggle', true);
    fixture.detectChanges();
    expect(el().querySelector('p-inputnumber')).not.toBeNull();
    const picked: string[] = [];
    stack.selectStackOption.subscribe((o) => picked.push(o.val));
    (el().querySelector('button[aria-label="Stack mode"]') as HTMLButtonElement).click();
    expect(picked).toEqual(['true']);
    fixture.componentRef.setInput('showStack', true);
    fixture.detectChanges();
    expect(el().querySelector('p-inputnumber')).toBeNull();
  });

  it('a blank slice field keeps the current slice', () => {
    const typed: number[] = [];
    stack.zIndexInput.subscribe((z) => typed.push(z));
    stack.zIndex = 4;
    stack['onSliceInput']('');
    stack['onSliceInput'](null);
    stack['onSliceInput']('6');
    expect(typed).toEqual([4, 4, 6]);
  });
});
