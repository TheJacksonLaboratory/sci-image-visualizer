import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';

import { REGION_EDITOR_API } from '../../contracts/region-editor-api.contract';
import { RegionSourceView } from '../../region-source/region-source';
import { RegionIndexRow } from '../../region-source/region-tiles';
import { RegionSourceListComponent, SOURCE_LIST_ROWS } from './region-source-list.component';

const row = (i: number, label = 'A'): RegionIndexRow => ({
  id: `f${i}`,
  label,
  color: '#ff0000',
  bbox: [0, 0, 1, 1],
});
const ROWS = Array.from({ length: SOURCE_LIST_ROWS + 5 }, (_, i) => row(i, i % 2 ? 'Cortex' : 'Striatum'));

describe('RegionSourceListComponent', () => {
  let fixture: ComponentFixture<RegionSourceListComponent>;
  let view$: BehaviorSubject<RegionSourceView | null>;
  let api: {
    getRegionSourceView$: () => BehaviorSubject<RegionSourceView | null>;
    getRegionSourceIndex: jest.Mock;
    selectSourceFeatures: jest.Mock;
    deleteSourceFeatures: jest.Mock;
  };

  const view = (): RegionSourceView => ({
    source: {} as RegionSourceView['source'],
    plane: 0,
    taken: new Set(),
    colorOf: () => '#00ff00',
  });
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  };
  const items = () => Array.from(fixture.nativeElement.querySelectorAll('.source-row')) as HTMLElement[];

  beforeEach(async () => {
    view$ = new BehaviorSubject<RegionSourceView | null>(null);
    api = {
      getRegionSourceView$: () => view$,
      getRegionSourceIndex: jest.fn(async (q: { offset: number; limit: number; label?: string }) => {
        const rows = ROWS.filter((r) => !q.label || r.label!.toLowerCase().includes(q.label.toLowerCase()));
        return { total: rows.length, rows: rows.slice(q.offset, q.offset + q.limit) };
      }),
      selectSourceFeatures: jest.fn(async () => []),
      deleteSourceFeatures: jest.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [RegionSourceListComponent],
      providers: [{ provide: REGION_EDITOR_API, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(RegionSourceListComponent);
    fixture.detectChanges();
  });

  it('shows nothing without a source', async () => {
    await settle();
    expect(fixture.nativeElement.querySelector('.source-list')).toBeNull();
  });

  it('lists a page of the source with its count, in the class colours', async () => {
    view$.next(view());
    await settle();
    expect(items()).toHaveLength(SOURCE_LIST_ROWS);
    expect(fixture.nativeElement.querySelector('.source-title').textContent).toContain(`${ROWS.length} regions`);
    expect((items()[0].querySelector('.chip-swatch') as HTMLElement).style.background).toBe('rgb(0, 255, 0)');
  });

  it('pages forward and back', async () => {
    view$.next(view());
    await settle();
    (fixture.componentInstance as unknown as { page(d: number): void }).page(1);
    await settle();
    expect(items()).toHaveLength(5);
    expect(api.getRegionSourceIndex).toHaveBeenLastCalledWith({
      offset: SOURCE_LIST_ROWS,
      limit: SOURCE_LIST_ROWS,
      label: undefined,
    });
  });

  it('filters by class, debounced', async () => {
    view$.next(view());
    await settle();
    (fixture.componentInstance as unknown as { onFilter(v: string): void }).onFilter('cort');
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    expect(items().every((el) => el.textContent!.includes('Cortex'))).toBe(true);
  });

  it('takes a picked row into the regions, and deletes with the bin', async () => {
    view$.next(view());
    await settle();
    items()[2].click();
    expect(api.selectSourceFeatures).toHaveBeenCalledWith(['f2'], false);
    (items()[3].querySelector('.pi-trash') as HTMLElement).click();
    expect(api.deleteSourceFeatures).toHaveBeenCalledWith(['f3']);
    expect(api.selectSourceFeatures).toHaveBeenCalledTimes(1);
  });
});
