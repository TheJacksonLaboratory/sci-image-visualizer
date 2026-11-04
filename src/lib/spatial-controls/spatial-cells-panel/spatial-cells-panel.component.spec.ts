import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SpatialCellsPanelComponent } from './spatial-cells-panel.component';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import {
  SpatialControlsFake,
  TILED_DATASET,
  bindInputs,
  fakeSpatialControls,
  one,
  shallowPanel,
} from '../../testing/spatial-panel-testing';

describe('SpatialCellsPanelComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialCellsPanelComponent>;
  let component: SpatialCellsPanelComponent;
  let root: HTMLElement;

  async function build(dataset: SpatialDataset = TILED_DATASET, inputs: Record<string, unknown> = {}) {
    fake.dataset$.next(dataset);
    shallowPanel(SpatialCellsPanelComponent);
    await TestBed.configureTestingModule({ imports: [SpatialCellsPanelComponent] }).compileComponents();
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
    expect(component['cellsOn']).toBe(true);
    component['onShowCells'](false);
    expect(fake.view$.value.showCells).toBe(false);
    expect(component['cellsOn']).toBe(false);
  });

  it('offers the boundary sets cell first, with Both, labelled briefly to fit one row', async () => {
    await build({
      ...TILED_DATASET,
      polygonTiles: {
        ...TILED_DATASET.polygonTiles!,
        sets: [
          { name: 'nucleus', label: 'Nucleus boundaries' },
          { name: 'cell', label: 'Cell boundaries' },
        ],
      },
    });
    expect(component['cellSetOptions'].map((o) => o.label)).toEqual(['Cell', 'Nucleus', 'Both']);
    expect(component['cellSetOptions'].map((o) => o.value)).toEqual(['cell', 'nucleus', 'both']);
    expect(component['activeCellSet']).toBe('cell');
    // Stable between passes: a fresh array per read made the buttons unclickable.
    expect(component['cellSetOptions']).toBe(component['cellSetOptions']);
  });

  it('switches each of two boundary sets on or off, both, either or neither', async () => {
    await build({
      ...TILED_DATASET,
      polygonTiles: {
        ...TILED_DATASET.polygonTiles!,
        sets: [
          { name: 'nuclear', label: 'Nuclear boundaries' },
          { name: 'cell', label: 'Cell boundaries' },
        ],
        defaultSet: 'cell',
      },
    });
    fixture.detectChanges();
    expect(component['boundarySets'].map((s) => s.label)).toEqual(['Cell boundaries', 'Nuclear boundaries']);
    expect(root.querySelectorAll('p-inputSwitch')).toHaveLength(2);
    // Only the drawing's choice (fill, outline or both) is a select button.
    expect(root.querySelectorAll('p-selectButton')).toHaveLength(1);
    // The cells' outlines by default, alone.
    expect(component['boundaryOn']('cell')).toBe(true);
    expect(component['boundaryOn']('nuclear')).toBe(false);

    component['onBoundary']('nuclear', true);
    expect(fake.view$.value).toEqual(expect.objectContaining({ showCells: true, cellSet: 'both' }));
    expect(component['boundaryOn']('cell')).toBe(true);
    expect(component['boundaryOn']('nuclear')).toBe(true);

    component['onBoundary']('cell', false);
    expect(fake.view$.value.cellSet).toBe('nuclear');
    expect(component['boundaryOn']('cell')).toBe(false);

    component['onBoundary']('nuclear', false);
    expect(fake.view$.value.showCells).toBe(false);
    expect(component['boundaryOn']('nuclear')).toBe(false);

    component['onBoundary']('cell', true);
    expect(fake.view$.value).toEqual(expect.objectContaining({ showCells: true, cellSet: 'cell' }));
  });

  it("shows the set drawn when the view's set is another dataset's", async () => {
    // Kept from a dataset whose sets were cell and nucleus; this one has nuclear instead.
    fake.view$.next({ ...fake.view$.value, showCells: true, cellSet: 'nucleus' });
    await build({
      ...TILED_DATASET,
      polygonTiles: {
        ...TILED_DATASET.polygonTiles!,
        sets: [
          { name: 'cell', label: 'Cell boundaries' },
          { name: 'nuclear', label: 'Nuclear boundaries' },
        ],
        defaultSet: 'cell',
      },
    });
    // What the renderer draws: the dataset's default.
    expect(component['activeCellSet']).toBe('cell');
    expect(component['boundaryOn']('cell')).toBe(true);
    expect(component['boundaryOn']('nuclear')).toBe(false);

    component['onBoundary']('nuclear', true);
    expect(fake.view$.value.cellSet).toBe('both');
    component['onBoundary']('nuclear', false);
    expect(fake.view$.value).toEqual(expect.objectContaining({ showCells: true, cellSet: 'cell' }));
    component['onBoundary']('cell', false);
    expect(fake.view$.value.showCells).toBe(false);
  });

  it('keeps the one-of choice for more than two boundary sets', async () => {
    await build({
      ...TILED_DATASET,
      polygonTiles: {
        ...TILED_DATASET.polygonTiles!,
        sets: [
          { name: 'cell', label: 'Cell boundaries' },
          { name: 'nucleus', label: 'Nucleus boundaries' },
          { name: 'membrane', label: 'Membrane boundaries' },
        ],
      },
    });
    fixture.detectChanges();
    expect(root.querySelectorAll('p-inputSwitch')).toHaveLength(0);
    expect(root.querySelectorAll('p-selectButton')).toHaveLength(2);
  });

  it('patches the display settings', async () => {
    await build();
    component['onShowCells'](true);
    component['onCellSet']('nucleus');
    component['onCellDraw']('both');
    component['onCellOpacity'](0.3);
    expect(fake.view$.value).toEqual(
      expect.objectContaining({
        showCells: true,
        cellSet: 'nucleus',
        cellDraw: 'both',
        cellOpacity: 0.3,
      }),
    );
    expect(component['activeCellSet']).toBe('nucleus');
    (fake.controls.setViewState as jest.Mock).mockClear();
    component['onCellOpacity'](undefined);
    component['onCellOpacityPercent'](null);
    expect(fake.controls.setViewState).not.toHaveBeenCalled();
    component['onCellOpacityPercent'](1);
    expect(fake.view$.value.cellOpacity).toBe(0.05); // clamped to the slider's floor
    expect(component['cellOpacityPercent']).toBe(5);
  });

  it('draws the cells, with no colouring of its own: the Observations section colours them', async () => {
    await build();
    fixture.detectChanges();
    expect(root.querySelector('.sc-subhead')?.textContent?.trim()).toBe('Cell segmentations');
    expect(root.textContent).not.toContain('Cell Color');
    expect(root.querySelector('spatial-groups-panel')).toBeNull();
    expect(root.textContent).toContain('View cells as');
  });
});
