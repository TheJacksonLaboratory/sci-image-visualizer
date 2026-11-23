import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MultiSelect } from 'primeng/multiselect';

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
});
