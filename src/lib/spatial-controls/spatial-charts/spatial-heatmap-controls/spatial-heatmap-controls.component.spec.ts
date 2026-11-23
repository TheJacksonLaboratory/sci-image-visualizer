import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MultiSelect } from 'primeng/multiselect';
import { Select } from 'primeng/select';

import type { HeatmapOrder } from '../../../spatial/heatmap-order';

import { SpatialHeatmapControlsComponent } from './spatial-heatmap-controls.component';

/** The heatmap's gene picker with PrimeNG's real MultiSelect. */
describe('SpatialHeatmapControlsComponent', () => {
  let fixture: ComponentFixture<SpatialHeatmapControlsComponent>;
  let picked: string[][];

  const multiSelect = () => fixture.debugElement.query(By.directive(MultiSelect)).componentInstance as MultiSelect;
  const toggleAll = () => multiSelect().onToggleAll({ originalEvent: new Event('click') });

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SpatialHeatmapControlsComponent] }).compileComponents();
    fixture = TestBed.createComponent(SpatialHeatmapControlsComponent);
    fixture.componentRef.setInput(
      'geneOptions',
      ['Ttr', 'Mbp', 'Snap25'].map((n) => ({ label: n, value: n })),
    );
    picked = [];
    fixture.componentInstance.genesChange.subscribe((genes) => picked.push(genes));
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('offers a select-all checkbox, as the panel’s other gene pickers do', () => {
    expect(multiSelect().showToggleAll).toBe(true);
  });

  it('selects every gene in the list, and clears them again', async () => {
    toggleAll();
    expect(picked.at(-1)).toEqual(['Ttr', 'Mbp', 'Snap25']);

    fixture.componentRef.setInput('genes', ['Ttr', 'Mbp', 'Snap25']);
    fixture.detectChanges();
    await fixture.whenStable();
    toggleAll();
    expect(picked.at(-1)).toEqual([]);
  });

  it('selects only the genes a search shows, keeping those already picked', async () => {
    fixture.componentRef.setInput('genes', ['Snap25']);
    fixture.detectChanges();
    await fixture.whenStable();
    multiSelect()._filterValue.set('t');

    toggleAll();
    expect(picked.at(-1)).toEqual(['Snap25', 'Ttr']);
  });

  it('labels the z-score checkbox (PrimeNG 18+ Checkbox has no label input)', () => {
    const input = fixture.nativeElement.querySelector('#sx-zscore') as HTMLInputElement;
    expect(input.labels?.[0]?.textContent?.trim()).toBe('z-score');
  });

  it('offers the gene and group sort orders, and says which changed', () => {
    const orders: HeatmapOrder[] = [];
    fixture.componentInstance.orderChange.subscribe((o) => orders.push(o));
    const [genes, groups] = fixture.debugElement.queryAll(By.directive(Select));
    const values = (s: typeof genes) => (s.componentInstance as Select).options!.map((o) => o.value);
    expect(values(genes)).toEqual(['picked', 'peak', 'clustered', 'name']);
    expect(values(groups)).toEqual(['dataset', 'clustered', 'cells']);

    genes.triggerEventHandler('ngModelChange', 'peak');
    groups.triggerEventHandler('ngModelChange', 'cells');
    expect(orders).toEqual([
      { genes: 'peak', groups: 'dataset' },
      { genes: 'picked', groups: 'cells' },
    ]);
  });
});
