import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { PresetSet } from '../../models/class-preset';
import { ManageClassesDialogComponent } from './manage-classes-dialog.component';

describe('ManageClassesDialogComponent', () => {
  let fixture: ComponentFixture<ManageClassesDialogComponent>;
  let dialog: ManageClassesDialogComponent;
  let draft: PresetSet;
  let emitted: PresetSet[];

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({
      imports: [VisualizationModule, NoopAnimationsModule],
    }).compileComponents();
    draft = {
      classes: [
        { name: 'Tumor', color: '#FF4444' },
        { name: 'Stroma', color: '#44AAFF' },
      ],
      fallbackPalette: ['#111111', '#222222'],
      autoPromote: false,
      matchMode: 'exact',
    };
    fixture = TestBed.createComponent(ManageClassesDialogComponent);
    dialog = fixture.componentInstance;
    emitted = [];
    dialog.draftChange.subscribe((d) => emitted.push(d));
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('draft', draft);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    jest.restoreAllMocks();
  });

  it('renders one row per class and one swatch per fallback colour', () => {
    expect(document.querySelectorAll('.manage-class-row').length).toBe(2);
    expect(document.querySelectorAll('.fallback-swatch').length).toBe(2);
  });

  it('add/remove helpers emit new drafts and never change the given one', () => {
    dialog['addClass']();
    expect(emitted.at(-1)!.classes.map((c) => c.name)).toEqual(['Tumor', 'Stroma', '']);
    dialog['removeClass'](0);
    expect(emitted.at(-1)!.classes.map((c) => c.name)).toEqual(['Stroma', '']);
    dialog['addFallbackColor']();
    expect(emitted.at(-1)!.fallbackPalette.length).toBe(3);
    dialog['removeFallbackColor'](0);
    expect(emitted.at(-1)!.fallbackPalette).toEqual(['#222222', '#888888']);
    expect(draft.classes.length).toBe(2);
    expect(draft.fallbackPalette.length).toBe(2);
  });

  it('field edits patch one class, the palette, auto-add and matching', () => {
    dialog['patchClass'](1, { name: 'Stroma 2' });
    dialog['setFallbackColor'](0, '#000000');
    dialog['setAutoPromote'](true);
    dialog['setMatchMode']('normalized');
    const last = emitted.at(-1)!;
    expect(last.classes[1]).toEqual({ name: 'Stroma 2', color: '#44AAFF' });
    expect(last.fallbackPalette[0]).toBe('#000000');
    expect(last.autoPromote).toBe(true);
    expect(last.matchMode).toBe('normalized');
    expect(draft.classes[1].name).toBe('Stroma');
  });

  it('typing a class name emits the edited draft', async () => {
    await fixture.whenStable(); // ngModel registers its control a tick later
    const input = document.querySelector('.manage-class-row input[placeholder="Class name"]') as HTMLInputElement;
    input.value = 'Necrosis';
    input.dispatchEvent(new Event('input'));
    expect(emitted.at(-1)!.classes[0].name).toBe('Necrosis');
  });

  it('footer buttons emit reset / export / apply', () => {
    const reset = jest.fn(),
      exp = jest.fn(),
      apply = jest.fn();
    dialog.resetDefaults.subscribe(reset);
    dialog.export.subscribe(exp);
    dialog.apply.subscribe(apply);
    const labels = ['Reset', 'Export', 'Apply'];
    const buttons = Array.from(document.querySelectorAll('.p-dialog-footer button')) as HTMLButtonElement[];
    for (const label of labels) buttons.find((b) => b.textContent?.trim() === label)!.click();
    expect([reset, exp, apply].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
