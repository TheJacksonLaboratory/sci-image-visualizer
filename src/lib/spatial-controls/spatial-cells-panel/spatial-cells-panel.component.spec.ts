import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { SpatialCellsPanelComponent } from './spatial-cells-panel.component';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { GenePickerModel } from '../spatial-gene-picker';
import {
  SpatialControlsFake, StubValueAccessorDirective, TILED_DATASET, bindInputs, fakeSpatialControls, fire, one,
  panelNamed, rowLabelled,
} from '../../testing/spatial-panel-testing';

describe('SpatialCellsPanelComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialCellsPanelComponent>;
  let component: SpatialCellsPanelComponent;
  let root: HTMLElement;

  async function build(dataset: SpatialDataset = TILED_DATASET, inputs: Record<string, unknown> = {}) {
    fake.dataset$.next(dataset);
    await TestBed.configureTestingModule({
      declarations: [SpatialCellsPanelComponent, StubValueAccessorDirective],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialCellsPanelComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    bindInputs(fixture, { controls: fake.controls, dataset: fake.dataset$, view: fake.view$, ...inputs });
  }

  beforeEach(() => {
    fake = fakeSpatialControls(TILED_DATASET);
  });

  it('switches outlines, on by default for data that has them', async () => {
    await build();
    // Outlines are on by default for data that has them, until the user says otherwise.
    expect(component.cellsOn).toBe(true);
    component.onShowCells(false);
    expect(fake.view$.value.showCells).toBe(false);
    expect(component.cellsOn).toBe(false);
  });

  it('offers the boundary sets cell first, with Both, labelled briefly to fit one row', async () => {
    await build({
      ...TILED_DATASET,
      polygonTiles: { ...TILED_DATASET.polygonTiles!, sets: [
        { name: 'nucleus', label: 'Nucleus boundaries' }, { name: 'cell', label: 'Cell boundaries' },
      ] },
    });
    expect(component.cellSetOptions.map((o) => o.label)).toEqual(['Cell', 'Nucleus', 'Both']);
    expect(component.cellSetOptions.map((o) => o.value)).toEqual(['cell', 'nucleus', 'both']);
    expect(component.activeCellSet).toBe('cell');
    // Stable between passes: a fresh array per read made the buttons unclickable.
    expect(component.cellSetOptions).toBe(component.cellSetOptions);
  });

  it('patches the display settings', async () => {
    await build();
    component.onShowCells(true);
    component.onCellSet('nucleus');
    component.onCellDraw('both');
    component.onCellOpacity(0.3);
    expect(fake.view$.value).toEqual(expect.objectContaining({
      showCells: true, cellSet: 'nucleus', cellDraw: 'both', cellOpacity: 0.3,
    }));
    expect(component.activeCellSet).toBe('nucleus');
    (fake.controls.setViewState as jest.Mock).mockClear();
    component.onCellOpacity(undefined);
    component.onCellOpacityPercent(null);
    expect(fake.controls.setViewState).not.toHaveBeenCalled();
    component.onCellOpacityPercent(1);
    expect(fake.view$.value.cellOpacity).toBe(0.05); // clamped to the slider's floor
    expect(component.cellOpacityPercent).toBe(5);
  });

  it('offers the colourings the dataset supports, and the gene list behind them', async () => {
    const genes = new GenePickerModel(() => fake.controls, () => []);
    genes.setDataset({ ...TILED_DATASET, features: { count: 2, names: ['Ttr', 'Mbp'] } });
    await build(TILED_DATASET, { genes });
    expect(component.cellColorOptions.map((o) => o.value)).toEqual(['group', 'gene', 'single']);
    component.onCellColorMode('gene');
    const gene = one(rowLabelled(root, 'Gene'), 'p-dropdown');
    expect((gene as unknown as { options: { value: string }[] }).options.map((o) => o.value)).toEqual(['Ttr', 'Mbp']);
    // The shared model filters, and the OnPush panel follows it.
    fire(gene, 'onFilter', { filter: 'mb' });
    fixture.detectChanges();
    expect((gene as unknown as { options: { value: string }[] }).options.map((o) => o.value)).toEqual(['Mbp']);
    component.onCellColorGene('Mbp');
    component.onCellSingleColor('#123456');
    expect(fake.view$.value).toEqual(expect.objectContaining({
      cellColorMode: 'gene', cellColorGene: 'Mbp', cellSingleColor: '#123456',
    }));
  });

  it('shows the observations colour bar for a gene colouring, else the density map\'s', async () => {
    await build(TILED_DATASET, { colorBarCss: 'linear-gradient(red, blue)' });
    expect(component.densityColorBarCss).toContain('linear-gradient');
    const inferno = component.densityColorBarCss;
    fake.view$.next({ ...fake.view$.value, densityColormap: 'Viridis' });
    expect(component.densityColorBarCss).not.toBe(inferno);
  });

  it('asks to open and close from its header', async () => {
    await build(TILED_DATASET, { open: false });
    const asked: boolean[] = [];
    component.openChange.subscribe((on) => asked.push(on));
    expect(root.querySelector('.sc-panel-body')).toBeNull();
    (one(panelNamed(root, 'Cells'), '.sc-panel-head') as HTMLElement).click();
    expect(asked).toEqual([true]);
  });
});
