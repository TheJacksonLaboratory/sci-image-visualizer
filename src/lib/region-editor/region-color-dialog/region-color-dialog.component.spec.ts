import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { ClassColorEdit, RegionColorDialogComponent } from './region-color-dialog.component';

describe('RegionColorDialogComponent', () => {
  let fixture: ComponentFixture<RegionColorDialogComponent>;
  let dialog: RegionColorDialogComponent;
  const seeded: ClassColorEdit[] = [{ label: 'Tumor', color: '#111111' }, { label: '', color: '#222222' }];

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({ imports: [VisualizationModule, NoopAnimationsModule] })
      .compileComponents();
    fixture = TestBed.createComponent(RegionColorDialogComponent);
    dialog = fixture.componentInstance;
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('edits', seeded);
    fixture.componentRef.setInput('selectedCount', 3);
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); jest.restoreAllMocks(); });

  it('lists one picker per class, unclassified last as labelled', () => {
    const text = document.querySelector('.p-dialog-content')?.textContent ?? '';
    expect(text).toContain('3');
    expect(text).toContain('Tumor');
    expect(text).toContain('Unclassified');
    expect(document.querySelectorAll('.p-dialog hex-color-picker').length).toBe(2);
  });

  it('edits a copy and applies the edited colours', () => {
    const applied = jest.fn();
    dialog.apply.subscribe(applied);
    dialog['setColor'](0, '#abcdef');
    (document.querySelectorAll('.p-dialog-footer button')[1] as HTMLButtonElement).click();
    expect(applied).toHaveBeenCalledWith([{ label: 'Tumor', color: '#abcdef' }, { label: '', color: '#222222' }]);
    expect(seeded[0].color).toBe('#111111');
  });
});
