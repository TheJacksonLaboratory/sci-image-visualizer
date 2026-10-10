import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { ClassesPanelComponent } from './classes-panel.component';

describe('ClassesPanelComponent', () => {
  let fixture: ComponentFixture<ClassesPanelComponent>;
  let panel: ClassesPanelComponent;
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
    fixture = TestBed.createComponent(ClassesPanelComponent);
    panel = fixture.componentInstance;
    fixture.componentRef.setInput('classes', [
      { name: 'Region', color: '#00FFFF' },
      { name: 'Tumor', color: '#FF4444' },
      { name: 'Stroma', color: '#44AAFF' },
    ]);
    fixture.componentRef.setInput(
      'counts',
      new Map([
        ['region', 2],
        ['tumor', 1],
      ]),
    );
    fixture.componentRef.setInput('matchMode', 'normalized');
    fixture.componentRef.setInput('activeClass', 'Tumor');
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    jest.restoreAllMocks();
  });

  it('lists the classes with counts keyed by the match mode, marking the active one', () => {
    const rows = Array.from(el().querySelectorAll('.class-row'));
    expect(rows.map((r) => r.querySelector('.row-name')?.textContent?.trim())).toEqual([
      'Region',
      'Tumor',
      'Stroma',
    ]);
    expect(rows.map((r) => r.querySelector('.row-count')?.textContent?.trim())).toEqual(['2', '1', '0']);
    expect(rows.map((r) => r.classList.contains('active'))).toEqual([false, true, false]);
  });

  it('the in-use default class cannot be removed; others can', () => {
    const del = Array.from(el().querySelectorAll('.row-del')) as HTMLButtonElement[];
    expect(del.map((b) => b.disabled)).toEqual([true, false, false]);
    expect(panel['removeTooltip']('Region')).toContain('cannot be removed');
    expect(panel['removeTooltip']('Tumor')).toBe('Remove class — its regions revert to Region');
    expect(panel['removeTooltip']('Stroma')).toBe('Remove class');
  });

  it('a row click picks the class; the trash removes without picking', () => {
    const pick = jest.fn(),
      remove = jest.fn();
    panel.pick.subscribe(pick);
    panel.remove.subscribe(remove);
    (el().querySelectorAll('.class-row')[2] as HTMLElement).click();
    (el().querySelectorAll('.row-del')[2] as HTMLButtonElement).click();
    expect(pick.mock.calls).toEqual([['Stroma']]);
    expect(remove.mock.calls).toEqual([['Stroma']]);
  });

  it('re-derives the counts when a new count map arrives', () => {
    fixture.componentRef.setInput('counts', new Map([['stroma', 4]]));
    fixture.detectChanges();
    expect(Array.from(el().querySelectorAll('.row-count')).map((c) => c.textContent?.trim())).toEqual([
      '0',
      '0',
      '4',
    ]);
    // The default class is no longer in use, so it can be removed.
    expect((el().querySelector('.row-del') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the row tooltip depends on whether regions are selected', () => {
    expect(panel['rowTooltip']('Tumor')).toContain('active');
    fixture.componentRef.setInput('selectedCount', 2);
    expect(panel['rowTooltip']('Tumor')).toContain('selected region');
  });
});
