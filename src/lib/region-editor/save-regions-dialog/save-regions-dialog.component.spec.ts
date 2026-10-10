import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { SaveRegionsDialogComponent } from './save-regions-dialog.component';

describe('SaveRegionsDialogComponent', () => {
  let fixture: ComponentFixture<SaveRegionsDialogComponent>;
  let dialog: SaveRegionsDialogComponent;
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
    fixture = TestBed.createComponent(SaveRegionsDialogComponent);
    dialog = fixture.componentInstance;
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('filename', 'a.geojson');
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); jest.restoreAllMocks(); });

  it('uses the given header and confirm label; confirm emits', () => {
    fixture.componentRef.setInput('header', 'Export Regions');
    fixture.componentRef.setInput('confirmLabel', 'Export');
    fixture.detectChanges();
    const confirm = jest.fn();
    dialog.confirm.subscribe(confirm);
    expect(document.querySelector('.p-dialog-title')?.textContent?.trim()).toBe('Export Regions');
    expect(buttons()[1].textContent?.trim()).toBe('Export');
    buttons()[1].click();
    expect(confirm).toHaveBeenCalled();
  });

  it('warns when the file exists', () => {
    expect(document.querySelector('.p-dialog .p-error')).toBeNull();
    fixture.componentRef.setInput('fileExists', true);
    fixture.detectChanges();
    expect(document.querySelector('.p-dialog .p-error')?.textContent).toContain('will be overwritten');
  });

  it('busy: progress and a Cancel that cancels the save', () => {
    const cancel = jest.fn();
    dialog.cancelSave.subscribe(cancel);
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(document.querySelector('.p-dialog-content')?.textContent).toContain('Saving regions…');
    expect(buttons().length).toBe(1);
    buttons()[0].click();
    expect(cancel).toHaveBeenCalled();
  });
});
