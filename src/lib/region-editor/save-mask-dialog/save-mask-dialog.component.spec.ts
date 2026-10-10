import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { SaveMaskDialogComponent } from './save-mask-dialog.component';

describe('SaveMaskDialogComponent', () => {
  let fixture: ComponentFixture<SaveMaskDialogComponent>;
  let dialog: SaveMaskDialogComponent;
  const buttons = () =>
    Array.from(document.querySelectorAll('.p-dialog-footer button')) as HTMLButtonElement[];

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({ imports: [VisualizationModule, NoopAnimationsModule] })
      .compileComponents();
    fixture = TestBed.createComponent(SaveMaskDialogComponent);
    dialog = fixture.componentInstance;
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('filename', 'a_mask.png');
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); jest.restoreAllMocks(); });

  it('idle: Download emits confirm; Cancel closes', () => {
    const confirm = jest.fn();
    const visible = jest.fn();
    dialog.confirm.subscribe(confirm);
    dialog.visibleChange.subscribe(visible);
    const [cancel, download] = buttons();
    download.click();
    cancel.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(visible).toHaveBeenCalledWith(false);
  });

  it('idle: Download is disabled for a blank filename', () => {
    fixture.componentRef.setInput('filename', '  ');
    fixture.detectChanges();
    expect(buttons()[1].disabled).toBe(true);
  });

  it('busy: shows progress and only a Cancel that cancels the export', () => {
    const cancel = jest.fn();
    dialog.cancelExport.subscribe(cancel);
    fixture.componentRef.setInput('busy', true);
    fixture.componentRef.setInput('encoding', true);
    fixture.detectChanges();
    expect(document.querySelector('.p-dialog-content')?.textContent).toContain('Encoding PNG…');
    expect(document.querySelector('#mask-filename')).toBeNull();
    expect(buttons().length).toBe(1);
    buttons()[0].click();
    expect(cancel).toHaveBeenCalled();
  });
});
