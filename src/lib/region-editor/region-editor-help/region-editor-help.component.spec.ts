import { TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { RegionEditorHelpComponent } from './region-editor-help.component';

describe('RegionEditorHelpComponent', () => {
  beforeEach(() => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('shows the help when visible; Ok closes it', async () => {
    await TestBed.configureTestingModule({
      imports: [VisualizationModule, NoopAnimationsModule],
    }).compileComponents();
    const fixture = TestBed.createComponent(RegionEditorHelpComponent);
    const closed = jest.fn();
    fixture.componentInstance.visibleChange.subscribe(closed);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    expect(document.querySelector('.p-dialog-title')?.textContent?.trim()).toBe('Region editor help');
    expect(document.querySelectorAll('.p-dialog h3').length).toBeGreaterThan(5);
    (document.querySelector('.p-dialog-footer button') as HTMLButtonElement).click();
    expect(closed).toHaveBeenCalledWith(false);
    fixture.destroy();
  });
});
