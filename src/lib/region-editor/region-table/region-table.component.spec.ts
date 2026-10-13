import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { VisualizationModule } from '../../visualization.module';
import { Rectangle, Region } from '../../models/region';
import { RegionTableComponent } from './region-table.component';

describe('RegionTableComponent', () => {
  let fixture: ComponentFixture<RegionTableComponent>;
  let table: RegionTableComponent;
  const el = () => fixture.nativeElement as HTMLElement;
  const rect = (id: number, w: number, label?: string) =>
    Object.assign(new Region(), {
      id,
      label,
      color: '#123456',
      bounds: Object.assign(new Rectangle(), { x: 0, y: 0, width: w, height: 10 }),
    });
  let rows: Region[];

  beforeEach(async () => {
    // jsdom can't parse PrimeNG's component stylesheets; drop just that noise.
    const consoleError = console.error;
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('Could not parse CSS stylesheet')) consoleError(...args);
    });
    await TestBed.configureTestingModule({
      imports: [VisualizationModule, NoopAnimationsModule],
    }).compileComponents();
    rows = [rect(1, 10, 'Tumor'), rect(2, 20)];
    fixture = TestBed.createComponent(RegionTableComponent);
    table = fixture.componentInstance;
    fixture.componentRef.setInput('page', rows);
    fixture.componentRef.setInput('total', 12);
    fixture.componentRef.setInput('first', 10);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    jest.restoreAllMocks();
  });

  it('renders the page with areas and the paginator report', () => {
    expect(el().querySelectorAll('tbody tr').length).toBe(2);
    expect(Array.from(el().querySelectorAll('td.surface-cell')).map((td) => td.textContent?.trim())).toEqual([
      '100 px²',
      '200 px²',
    ]);
    expect(el().querySelector('.p-paginator-current')?.textContent?.trim()).toBe('11 to 12 of 12');
  });

  it('re-derives the area column when the pixel size changes', () => {
    fixture.componentRef.setInput('mpp', { mppX: 0.5, mppY: 0.5 });
    fixture.detectChanges();
    expect(Array.from(el().querySelectorAll('td.surface-cell')).map((td) => td.textContent?.trim())).toEqual([
      '25 µm²',
      '50 µm²',
    ]);
  });

  it('a row trash button reports the row index across pages', () => {
    const del = jest.fn();
    table.deleteRow.subscribe(del);
    (el().querySelectorAll('tbody tr td:last-child button')[1] as HTMLButtonElement).click();
    expect(del).toHaveBeenCalledWith(11);
  });

  it('shows the inline editor for rows with a draft, and reports edits', async () => {
    const start = jest.fn(),
      draft = jest.fn(),
      stop = jest.fn();
    table.labelEditStart.subscribe(start);
    table.labelDraftChange.subscribe(draft);
    table.labelEditStop.subscribe(stop);
    (el().querySelector('td.class-cell .pi-pencil') as HTMLElement).click();
    expect(start).toHaveBeenCalledWith(rows[0]);

    fixture.componentRef.setInput('labelDrafts', new Map([[rows[0], 'Tumor']]));
    fixture.detectChanges();
    await fixture.whenStable();
    const input = el().querySelector('td.class-cell input') as HTMLInputElement;
    input.value = 'Necrosis';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(draft).toHaveBeenCalledWith({ region: rows[0], value: 'Necrosis' });
    expect(stop).toHaveBeenCalledWith({ region: rows[0], commit: false });
    expect(rows[0].label).toBe('Tumor'); // the table never writes a region
  });

  it('a row click reports the new selection, then the row select', () => {
    const events: string[] = [];
    table.selectionChange.subscribe((s) => events.push(`selection:${s.map((r) => r.id)}`));
    table.rowSelect.subscribe(() => events.push('row'));
    (el().querySelector('td.surface-cell') as HTMLElement).click();
    expect(events).toEqual(['selection:1', 'row']);
  });
});
