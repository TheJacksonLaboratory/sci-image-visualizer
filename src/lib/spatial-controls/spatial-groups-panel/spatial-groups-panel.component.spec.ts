import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { SpatialGroupsPanelComponent } from './spatial-groups-panel.component';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import {
  SpatialControlsFake, StubValueAccessorDirective, TILED_DATASET, bindInputs, fakeSpatialControls, fire, one,
} from '../../testing/spatial-panel-testing';

describe('SpatialGroupsPanelComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialGroupsPanelComponent>;
  let component: SpatialGroupsPanelComponent;
  let categoricalView: jest.Mock;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const view = (categories: string[], codes: number[], name = 'graphclust') => ({
    name, categories, colors: categories.map(() => '#000'), codes: Uint16Array.from(codes),
  });

  async function build(dataset: SpatialDataset = TILED_DATASET) {
    fake.dataset$.next(dataset);
    await TestBed.configureTestingModule({
      declarations: [SpatialGroupsPanelComponent, StubValueAccessorDirective],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialGroupsPanelComponent);
    component = fixture.componentInstance;
    bindInputs(fixture, { controls: fake.controls, dataset: fake.dataset$, view: fake.view$ });
    await flush();
    fixture.detectChanges();
  }

  beforeEach(() => {
    fake = fakeSpatialControls(TILED_DATASET);
    categoricalView = jest.fn(async () => view(['A', 'B'], [0, 1]));
    (fake.controls as unknown as { categoricalView: jest.Mock }).categoricalView = categoricalView;
  });

  it('lists groups under their section, with a k-means family listed once', async () => {
    await build({
      ...TILED_DATASET,
      columns: [
        { kind: 'categorical', name: 'graphclust', description: 'Graph-Based Clustering (GEX)',
          categories: ['A', 'B'], section: 'Xenium Onboard Analysis groups' },
        ...[2, 3].map((k) => ({
          kind: 'categorical' as const, name: `kmeans_${k}`, categories: ['x'],
          section: 'Xenium Onboard Analysis groups',
          family: { id: 'kmeans', label: 'K-Means Clustering (GEX)', variant: `k = ${k}` },
        })),
        { kind: 'categorical', name: 'imported:Mine', description: 'Mine', categories: ['T'],
          section: 'Imported groups' },
      ],
    });
    expect(component.groupOptions).toEqual([
      { label: 'Xenium Onboard Analysis groups', items: [
        { label: 'Graph-Based Clustering (GEX)', value: 'graphclust' },
        { label: 'K-Means Clustering (GEX)', value: 'family:kmeans' },
      ] },
      { label: 'Imported groups', items: [{ label: 'Mine', value: 'imported:Mine' }] },
    ]);
    // A fresh array per read made PrimeNG re-render the options until they were unclickable.
    expect(component.groupOptions).toBe(component.groupOptions);
    component.onGroupEntry('family:kmeans');
    expect(fake.view$.value.cellTypeColumn).toBe('kmeans_2');
    expect(component.activeGroupEntry).toBe('family:kmeans');
    expect(component.groupVariantOptions.map((o) => o.label)).toEqual(['k = 2', 'k = 3']);
    component.onGroupVariant('kmeans_3');
    component.onGroupEntry('graphclust');
    component.onGroupEntry('family:kmeans');
    expect(fake.view$.value.cellTypeColumn).toBe('kmeans_3'); // remembers the k chosen
  });

  it('counts cells per group and hides switched-off groups', async () => {
    categoricalView.mockImplementation(async () => ({
      name: 'graphclust', categories: ['A', 'B'], colors: ['#f00', '#0f0'],
      codes: Uint16Array.from([1, 1, 0, 1, 0xffff]),
    }));
    await build();
    expect(component.groupRows.map((r) => [r.label, r.count])).toEqual([['B', 3], ['A', 1]]);
    expect(component.groupTotal).toBe(4);
    const root = fixture.nativeElement as HTMLElement;
    expect(one(root, '.sc-group-all .sc-count').textContent).toContain('4');
    component.onGroupShown('B', false);
    expect(fake.view$.value.hiddenGroups).toEqual(['B']);
    expect(component.allGroupsShown).toBe(false);
    component.onAllGroupsShown(true);
    expect(fake.view$.value.hiddenGroups).toEqual([]);
    // Changing grouping clears the switched-off groups of the old one.
    component.onGroupShown('A', false);
    component.onCellTypeColumn('curated_cell_type');
    expect(fake.view$.value.hiddenGroups).toEqual([]);
  });

  it("drops group rows the previous dataset's same-named grouping answers late", async () => {
    // Both datasets group by `graphclust`: only the load sequence, not the name, can tell
    // the old dataset's answer from the new one's.
    let resolveOld: (v: ReturnType<typeof view>) => void = () => undefined;
    categoricalView
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(view(['New'], [0, 0]));
    await build();
    fake.dataset$.next({ ...TILED_DATASET, id: 'other' } as SpatialDataset);
    await flush();
    expect(component.groupRows.map((r) => r.label)).toEqual(['New']);

    resolveOld(view(['Old'], [0, 0, 0]));
    await flush();
    expect(component.groupRows.map((r) => r.label)).toEqual(['New']);
  });

  it("keeps the newer grouping's rows when a superseded load fails", async () => {
    let rejectOld: (e: Error) => void = () => undefined;
    let resolveNew: (v: unknown) => void = () => undefined;
    categoricalView
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveNew = r; }));
    await build();
    component.onCellTypeColumn('curated_cell_type');
    await flush();
    rejectOld(new Error('gone'));
    await flush();
    resolveNew(view(['T cell'], [0], 'curated_cell_type'));
    await flush();
    expect(component.groupRows.map((r) => r.label)).toEqual(['T cell']);
    expect(categoricalView).toHaveBeenCalledTimes(2);
  });

  it('shows no rows without a grouping', async () => {
    await build({ ...TILED_DATASET, columns: [{ kind: 'continuous', name: 'cell_area' }] });
    expect(component.groupRows).toEqual([]);
    expect(component.groupOptions).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).querySelector('.sc-subhead')).toBeNull();
  });

  describe('importing a grouping', () => {
    const file = (name: string, text: string) => ({
      files: [{ name, text: async () => text }], value: 'C:\\fakepath\\x',
    }) as unknown as HTMLInputElement;

    it('imports a CSV as a column named after the file, and groups the cells by it', async () => {
      const importGroups = jest.fn(async (label: string) => ({
        column: { kind: 'categorical' as const, name: `imported:${label}`, categories: ['T'] }, matched: 3,
      }));
      (fake.controls as unknown as { importGroups: unknown }).importGroups = importGroups;
      await build();
      expect(component.canImportGroups).toBe(true);
      const input = file('Mine.csv', 'cell_id,group\n1,T');
      await component.onImportGroupsFile(input);
      expect(importGroups).toHaveBeenCalledWith('Mine', 'cell_id,group\n1,T');
      expect(input.value).toBe('');
      expect(fake.view$.value.cellTypeColumn).toBe('imported:Mine');
      expect(component.groupImporting).toBe(false);
    });

    it('says why an import failed', async () => {
      (fake.controls as unknown as { importGroups: unknown }).importGroups = jest.fn(async () => {
        throw new Error('no cell_id column');
      });
      await build();
      await component.onImportGroupsFile(file('Bad.csv', 'x'));
      expect(component.groupImportError).toBe('no cell_id column');
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('no cell_id column');
    });

    it('is not offered when the port cannot import', async () => {
      await build();
      expect(component.canImportGroups).toBe(false);
    });
  });

  it('wires the rendered rows to the view', async () => {
    await build();
    const root = fixture.nativeElement as HTMLElement;
    const rows = root.querySelectorAll('.sc-group-row:not(.sc-group-all)');
    fire(one(rows[0] as HTMLElement, 'p-checkbox'), 'onChange', { checked: false });
    expect(fake.view$.value.hiddenGroups).toEqual(['A']);
  });
});
