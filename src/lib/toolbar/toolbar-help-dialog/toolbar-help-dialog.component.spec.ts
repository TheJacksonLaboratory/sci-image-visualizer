import { TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { ToolbarToolContribution } from '../../contracts/toolbar-tool.contract';
import { ToolbarHelpDialogComponent } from './toolbar-help-dialog.component';

describe('ToolbarHelpDialogComponent', () => {
  beforeEach(() => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('names the contributed tools and lists their help; Ok closes', async () => {
    await TestBed.configureTestingModule({ imports: [VisualizationModule, NoopAnimationsModule] })
      .compileComponents();
    const fixture = TestBed.createComponent(ToolbarHelpDialogComponent);
    const closed = jest.fn();
    fixture.componentInstance.visibleChange.subscribe(closed);
    const tool = { label: 'Detect', help: { body: '<b>Detect</b> finds things.' } } as ToolbarToolContribution;
    fixture.componentRef.setInput('contributedTools', [tool]);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    expect(fixture.componentInstance['contributedToolNames']).toBe('Detect');
    const text = document.querySelector('.p-dialog-content')?.textContent ?? '';
    expect(text).toContain('no-prompt ones (Detect)');
    expect(text).toContain('Detect finds things.');
    (document.querySelector('.p-dialog-footer button') as HTMLButtonElement).click();
    expect(closed).toHaveBeenCalledWith(false);
    fixture.destroy();
  });
});
