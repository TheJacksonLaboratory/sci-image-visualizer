import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SpatialColorByComponent } from './spatial-color-by.component';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { GenePickerModel } from '../spatial-gene-picker';
import { SpatialGroupsPanelComponent } from '../spatial-groups-panel/spatial-groups-panel.component';
import {
  SpatialControlsFake,
  TILED_DATASET,
  bindInputs,
  fakeSpatialControls,
  fire,
  one,
  shallowPanel,
} from '../../testing/spatial-panel-testing';

describe('SpatialColorByComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialColorByComponent>;
  let component: SpatialColorByComponent;
  let root: HTMLElement;
  const DATASET: SpatialDataset = {
    ...TILED_DATASET,
    features: { count: 2, names: ['Ttr', 'Mbp'], logScaleHint: true },
    columns: [...TILED_DATASET.columns, { kind: 'continuous', name: 'total_counts', logScaleHint: true }],
  };

  async function build(dataset: SpatialDataset = DATASET, inputs: Record<string, unknown> = {}) {
    TestBed.resetTestingModule();
    fake.dataset$.next(dataset);
    shallowPanel(SpatialGroupsPanelComponent);
    shallowPanel(SpatialColorByComponent, [SpatialGroupsPanelComponent]);
    await TestBed.configureTestingModule({ imports: [SpatialColorByComponent] }).compileComponents();
    fixture = TestBed.createComponent(SpatialColorByComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    bindInputs(fixture, { controls: fake.controls, dataset: fake.dataset$, view: fake.view$, ...inputs });
  }

  const mode = () => component['mode'];

  beforeEach(() => {
    fake = fakeSpatialControls(DATASET);
  });

  it('offers the colourings the dataset supports', async () => {
    await build();
    expect(component['modeOptions'].map((o) => o.value)).toEqual(['group', 'gene', 'measure', 'single']);
    expect(component['measureOptions'].map((o) => o.value)).toEqual(['cell_area', 'total_counts']);
    await build({ ...DATASET, features: undefined, columns: [] });
    expect(component['modeOptions'].map((o) => o.value)).toEqual(['single']);
  });

  it('colours the markers and the cells by one grouping, its groups listed', async () => {
    await build();
    expect(mode()).toBeNull();
    component['onMode']('group');
    expect(fake.view$.value).toEqual(
      expect.objectContaining({
        colorBy: { kind: 'column', name: 'graphclust' },
        cellTypeColumn: 'graphclust',
        cellColorMode: 'group',
      }),
    );
    expect(mode()).toBe('group');
    fixture.detectChanges();
    expect(root.querySelector('spatial-groups-panel')).toBeTruthy();
  });

  it('colours them by a gene once one is picked, through the shared gene list', async () => {
    const genes = new GenePickerModel(
      () => fake.controls,
      () => [],
    );
    genes.setDataset(DATASET);
    await build(DATASET, { genes });
    component['onMode']('gene');
    // Waiting for its gene: shown, nothing written.
    expect(mode()).toBe('gene');
    expect(fake.view$.value.colorBy).toBeNull();
    fixture.detectChanges();
    const gene = one(root, 'p-dropdown[inputId=sc-gene]');
    expect((gene as unknown as { options: { value: string }[] }).options.map((o) => o.value)).toEqual([
      'Ttr',
      'Mbp',
    ]);
    fire(gene, 'onFilter', { filter: 'mb' });
    fixture.detectChanges();
    expect((gene as unknown as { options: { value: string }[] }).options.map((o) => o.value)).toEqual(['Mbp']);
    component['onGene']('Mbp');
    expect(fake.view$.value).toEqual(
      expect.objectContaining({
        colorBy: { kind: 'feature', name: 'Mbp' },
        logScale: true,
        cellColorMode: 'gene',
        cellColorGene: 'Mbp',
      }),
    );
    expect(mode()).toBe('gene');
    // Back to Gene later: the gene the cells had.
    component['onMode']('single');
    component['onMode']('gene');
    expect(fake.view$.value.colorBy).toEqual({ kind: 'feature', name: 'Mbp' });
  });

  it('colours them by a measurement', async () => {
    await build();
    component['onMode']('measure');
    expect(mode()).toBe('measure');
    component['onMeasure']('total_counts');
    expect(fake.view$.value).toEqual(
      expect.objectContaining({
        colorBy: { kind: 'column', name: 'total_counts' },
        logScale: true,
        cellColorMode: 'column',
      }),
    );
    expect(component['selectedMeasure']).toBe('total_counts');
  });

  it('colours them all in one colour', async () => {
    await build();
    component['onMode']('group');
    component['onMode']('single');
    expect(fake.view$.value).toEqual(expect.objectContaining({ colorBy: null, cellColorMode: 'single' }));
    expect(mode()).toBe('single');
    component['onSingleColor']('#123456');
    expect(fake.view$.value.cellSingleColor).toBe('#123456');
  });

  it('reflects a colouring set elsewhere (e.g. by the host)', async () => {
    await build();
    fake.controls.colorByFeature('Ttr');
    expect(mode()).toBe('gene');
    expect(component['selectedGene']).toBe('Ttr');
    fake.controls.colorByColumn('curated_cell_type');
    expect(mode()).toBe('group');
    fake.controls.colorByColumn('cell_area');
    expect(mode()).toBe('measure');
  });
});
