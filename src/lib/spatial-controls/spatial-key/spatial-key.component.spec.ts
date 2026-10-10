import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { SpatialKeyComponent, colorByLabel, colormapNodeFor } from './spatial-key.component';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { COLORMAP_OPTIONS } from '../../plot.utilities';
import {
  SpatialControlsFake, StubValueAccessorDirective, accessorOf, bindInputs, fakeSpatialControls, fire, one,
} from '../../testing/spatial-panel-testing';

const dataset: SpatialDataset = {
  id: 'demo', name: 'Demo brain',
  observations: { count: 3, x: new Float32Array(3), y: new Float32Array(3) },
  columns: [
    { kind: 'categorical', name: 'region', categories: ['Cortex', 'Thalamus'] },
    {
      kind: 'categorical', name: 'cluster', categories: ['a', 'b'],
      description: 'k-means (k=8) — derived for the demo',
    },
    { kind: 'continuous', name: 'total_counts', unit: 'counts' },
  ],
  features: { count: 2, names: ['Ttr', 'Mbp'] },
};

describe('SpatialKeyComponent', () => {
  let fake: SpatialControlsFake;
  let fixture: ComponentFixture<SpatialKeyComponent>;
  let key: SpatialKeyComponent;
  let root: HTMLElement;

  async function build(inputs: Record<string, unknown> = {}) {
    await TestBed.configureTestingModule({
      declarations: [SpatialKeyComponent, StubValueAccessorDirective],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialKeyComponent);
    key = fixture.componentInstance;
    root = fixture.nativeElement as HTMLElement;
    bindInputs(fixture, {
      controls: fake.controls, dataset: fake.dataset$, view: fake.view$,
      colormapOptions: COLORMAP_OPTIONS, ...inputs,
    });
  }

  beforeEach(() => {
    fake = fakeSpatialControls(dataset);
  });

  it('shows nothing while nothing is coloured by', async () => {
    await build();
    expect(root.querySelector('.sc-key')).toBeNull();
    expect(key.colorByLabel).toBe('Flat colour');
  });

  describe('heading', () => {
    it('names a gene as a gene and a column by its name', () => {
      expect(colorByLabel({ colorBy: null })).toBe('Flat colour');
      expect(colorByLabel({ colorBy: { kind: 'feature', name: 'Ttr' } })).toBe('Gene · Ttr');
      expect(colorByLabel({ colorBy: { kind: 'column', name: 'region' } })).toBe('region');
    });

    it('surfaces a column description, so a DERIVED column does not read as measured', async () => {
      await build();
      fake.view$.next({ ...fake.view$.value, colorBy: { kind: 'column', name: 'cluster' } });
      expect(key.activeDescription).toMatch(/k-means/);
      expect(one(root, '.sc-key').textContent).toContain('k-means');
    });

    it('has no description for a gene or an undescribed column', async () => {
      await build();
      fake.view$.next({ ...fake.view$.value, colorBy: { kind: 'feature', name: 'Ttr' } });
      expect(key.activeDescription).toBeNull();
      fake.view$.next({ ...fake.view$.value, colorBy: { kind: 'column', name: 'region' } });
      expect(key.activeDescription).toBeNull();
    });
  });

  describe('a categorical colouring', () => {
    const legend = [{ label: 'Cortex', color: '#ff0000' }, { label: 'Thalamus', color: '#0000ff' }];

    it('lists the legend, highlights the selected row, and reports a click', async () => {
      await build({ legend, selectedCategory: 1 });
      fake.view$.next({ ...fake.view$.value, colorBy: { kind: 'column', name: 'region' } });
      const clicked: number[] = [];
      key.categoryClicked.subscribe((i) => clicked.push(i));
      const rows = root.querySelectorAll<HTMLButtonElement>('.sc-legend-btn');
      expect(Array.from(rows).map((r) => r.textContent?.trim())).toEqual(['Cortex', 'Thalamus']);
      expect(rows[1].classList.contains('selected')).toBe(true);
      rows[0].click();
      expect(clicked).toEqual([0]);
      // No colour bar and no colormap picker for categories.
      expect(root.querySelector('.sc-colorbar')).toBeNull();
      expect(key.isCategorical).toBe(true);
      expect(key.isContinuous).toBe(false);
    });
  });

  describe('a continuous colouring', () => {
    beforeEach(async () => {
      await build({ colorBarCss: 'linear-gradient(to right, red, blue)' });
      fake.view$.next({ ...fake.view$.value, colorBy: { kind: 'feature', name: 'Ttr' } });
    });

    it('shows the colour bar with its colormap picker', () => {
      expect(key.isContinuous).toBe(true);
      expect(one(root, '.sc-colorbar')).toBeTruthy();
      expect(root.querySelector('.sc-legend')).toBeNull();
      expect(one(root, 'p-treeSelect')).toBeTruthy();
    });

    it('writes the picked colormap, and clearing it goes back to the image’s', () => {
      const picker = one(root, 'p-treeSelect');
      fire(picker, 'onNodeSelect', { node: { label: 'Magma', data: { value: 'MAGMA_LUT' } } });
      expect(fake.controls.setViewState).toHaveBeenCalledWith({ continuousColormap: 'MAGMA_LUT' });
      fire(picker, 'onClear');
      expect(fake.controls.setViewState).toHaveBeenCalledWith({ continuousColormap: null });
      // A group row carries no value, so picking one must not set a bogus colormap.
      key.onContinuousColormap({ label: 'Sequential', data: null } as never);
      expect(fake.controls.setViewState).toHaveBeenLastCalledWith({ continuousColormap: null });
    });

    it('writes an INLINE colour scale, which is what most options become', () => {
      // COLORMAP_OPTIONS ships `*_LUT` KEYS, and the store rewrites them in place
      // with 256-stop `[stop, colour]` arrays once assets/plotting/colormap-luts.json
      // loads — so at runtime most of the library's colormaps are arrays, not
      // names. (No HTTP here, so the tree still holds the keys; the array case is
      // built explicitly.) A handler that only accepts strings shows the pick in
      // the dropdown and changes nothing on screen, which is the worst of both.
      const resolved = {
        label: 'Plasma',
        data: { value: [[0, 'rgb(12,7,134)'], [1, 'rgb(239,248,33)']] as [number, string][] },
      };
      key.onContinuousColormap(resolved);
      expect(fake.controls.setViewState).toHaveBeenCalledWith({ continuousColormap: resolved.data.value });

      // And an unresolved key is still a name, which must pass through too.
      const plasma = COLORMAP_OPTIONS.flatMap((g) => g.children ?? []).find((n) => n.label === 'Plasma')!;
      expect(plasma.data!.value).toBe('PLASMA_LUT');
      key.onContinuousColormap(plasma);
      expect(fake.controls.setViewState).toHaveBeenCalledWith({ continuousColormap: 'PLASMA_LUT' });
    });

    it('shows the colormap in use, found in the option tree', async () => {
      // The picker has to reflect state set from anywhere — a host calling
      // setViewState, or a restored session — not just its own clicks.
      fake.view$.next({ ...fake.view$.value, continuousColormap: 'MAGMA_LUT' });
      expect(key.selectedColormapNode?.label).toBe('Magma');
      await fixture.whenStable();
      expect((accessorOf(fixture, one(root, 'p-treeSelect')).value as { label: string }).label).toBe('Magma');

      fake.view$.next({ ...fake.view$.value, continuousColormap: null });
      expect(key.selectedColormapNode).toBeNull();

      // An unknown value selects nothing rather than throwing.
      fake.view$.next({ ...fake.view$.value, continuousColormap: 'NOT_A_LUT' });
      expect(key.selectedColormapNode).toBeNull();
    });
  });

  it('finds a colormap value at either level of the tree, by reference', () => {
    const leaf = { label: 'Leaf', data: { value: 'LEAF' } };
    const group = { label: 'Group', data: { value: 'GROUP' }, children: [leaf] };
    expect(colormapNodeFor([group], 'LEAF')).toBe(leaf);
    expect(colormapNodeFor([group], 'GROUP')).toBe(group);
    expect(colormapNodeFor([group], null)).toBeNull();
  });
});
