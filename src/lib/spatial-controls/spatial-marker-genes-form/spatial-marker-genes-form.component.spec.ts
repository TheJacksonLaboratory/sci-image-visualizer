import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { SpatialMarkerGenesFormComponent } from './spatial-marker-genes-form.component';
import {
  SpatialControlsFake, StubValueAccessorDirective, TILED_DATASET, bindInputs, fakeSpatialControls, fire,
} from '../../testing/spatial-panel-testing';

describe('SpatialMarkerGenesFormComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialMarkerGenesFormComponent>;
  let component: SpatialMarkerGenesFormComponent;
  let root: HTMLElement;

  const markerGenes = (fn: jest.Mock) => {
    (fake.controls as unknown as { markerGenes: unknown }).markerGenes = fn;
    return fn;
  };

  async function build(open = true) {
    await TestBed.configureTestingModule({
      declarations: [SpatialMarkerGenesFormComponent, StubValueAccessorDirective],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialMarkerGenesFormComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    bindInputs(fixture, { controls: fake.controls, dataset: fake.dataset$, view: fake.view$, open });
  }

  beforeEach(() => {
    fake = fakeSpatialControls(TILED_DATASET);
  });

  it("adds each cluster's marker genes as a gene group, each gene once", async () => {
    const scan = markerGenes(jest.fn(async () => ({
      column: 'curated_cell_type',
      groups: [
        { name: 'T cell', cells: 10, genes: [
          { name: 'CD3E', score: 2, pctIn: 0.8, pctOut: 0.1 },
          { name: 'SHARED', score: 0.5, pctIn: 0.4, pctOut: 0.2 },
        ] },
        { name: 'Tumour', cells: 20, genes: [
          { name: 'KRT5', score: 3, pctIn: 0.9, pctOut: 0.1 },
          { name: 'SHARED', score: 1.5, pctIn: 0.6, pctOut: 0.2 },
        ] },
      ],
    })));
    fake.view$.next({ ...fake.view$.value, cellTypeColumn: 'curated_cell_type', transcriptGenes: ['EPCAM'] });
    await build();
    expect(component.markerColumn).toBe('curated_cell_type'); // the cells' grouping
    expect(component.markerClusters).toEqual(['T cell', 'Tumour']);
    const closed: boolean[] = [];
    component.openChange.subscribe((v) => closed.push(v));
    component.markerPerGroup = 10;
    await component.addMarkerGenes();
    expect(scan).toHaveBeenCalledWith('curated_cell_type', 10);
    expect(fake.view$.value.transcriptGeneGroups).toEqual([
      { name: 'T cell', genes: ['CD3E'] },
      { name: 'Tumour', genes: ['KRT5', 'SHARED'] }, // SHARED goes where it scores higher
    ]);
    expect(fake.view$.value.transcriptGenes).toEqual(['EPCAM', 'CD3E', 'KRT5', 'SHARED']);
    expect(fake.view$.value.transcriptColorBy).toBe('cluster'); // coloured by cluster from now on
    expect(closed).toEqual([false]);
  });

  it('applies the clusters picked when asked, even if the form changes while the scan runs', async () => {
    let finish!: () => void;
    markerGenes(jest.fn(() => new Promise((resolve) => {
      finish = () => resolve({ column: 'graphclust', groups: [
        { name: 'A', cells: 5, genes: [{ name: 'GA', score: 1, pctIn: 0.5, pctOut: 0.1 }] },
        { name: 'B', cells: 5, genes: [{ name: 'GB', score: 1, pctIn: 0.5, pctOut: 0.1 }] },
      ] });
    })));
    await build();
    component.onMarkerColumn('graphclust');
    component.markerClusters = ['A'];
    const added = component.addMarkerGenes();
    component.markerClusters = ['B']; // edited mid-scan
    finish();
    await added;
    expect(fake.view$.value.transcriptGeneGroups).toEqual([{ name: 'A', genes: ['GA'] }]);
  });

  it('adds only the clusters picked, and says so when none pass', async () => {
    markerGenes(jest.fn(async () => ({
      column: 'graphclust', groups: [{ name: 'A', cells: 5, genes: [] }, { name: 'B', cells: 5, genes: [] }],
    })));
    await build();
    component.onMarkerColumn('graphclust');
    component.markerClusters = ['A'];
    await component.addMarkerGenes();
    expect(component.markerError).toMatch(/No marker genes/);
    expect(fake.view$.value.transcriptGeneGroups).toEqual([]);
    fixture.detectChanges();
    expect(root.textContent).toContain('No marker genes');
  });

  it('reports a failed scan, and keeps the column picked across a re-open', async () => {
    markerGenes(jest.fn(async () => { throw new Error('matrix unavailable'); }));
    await build();
    component.onMarkerColumn('graphclust');
    await component.addMarkerGenes();
    expect(component.markerError).toBe('matrix unavailable');
    expect(component.markerLoading).toBe(false);
    fixture.componentRef.setInput('open', false);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    expect(component.markerColumn).toBe('graphclust');
    expect(component.markerError).toBeNull();
  });

  it('offers every grouping but the segmentation method, stable between passes', async () => {
    await build();
    expect(component.markerColumnOptions.map((o) => o.value)).toEqual(['graphclust', 'curated_cell_type']);
    const options = component.markerColumnOptions;
    fixture.detectChanges();
    expect(component.markerColumnOptions).toBe(options);
    fake.dataset$.next({ ...TILED_DATASET, columns: [...TILED_DATASET.columns] });
    expect(component.markerColumnOptions).not.toBe(options);
    expect(component.markerColumnOptions).toEqual(options);
  });

  it('renders only while open, and Cancel closes it', async () => {
    await build(false);
    expect(root.querySelector('.sc-markers')).toBeNull();
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const closed: boolean[] = [];
    component.openChange.subscribe((v) => closed.push(v));
    fire(root.querySelectorAll('.sc-markers-actions p-button')[1], 'onClick');
    expect(closed).toEqual([false]);
    fixture.detectChanges();
    expect(root.querySelector('.sc-markers')).toBeNull();
  });
});
