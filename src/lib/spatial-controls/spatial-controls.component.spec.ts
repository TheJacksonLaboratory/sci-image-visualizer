import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { BehaviorSubject, of } from 'rxjs';

import { SpatialControlsComponent } from './spatial-controls.component';
import { VISUALIZER, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../contracts/display-types';
import {
  SpatialSelectionMask, emptySelection,
} from '../implementations/spatial/spatial-selection';

const dataset: SpatialDataset = {
  id: 'demo',
  name: 'Demo brain',
  observations: { count: 1983, x: new Float32Array(0), y: new Float32Array(0) },
  columns: [
    { kind: 'categorical', name: 'region', categories: ['Cortex', 'Thalamus'], colors: ['#f00', '#00f'] },
    { kind: 'continuous', name: 'total_counts', unit: 'counts', logScaleHint: true },
  ],
  features: { count: 12, names: ['Ttr', 'Mbp'] },
};

describe('SpatialControlsComponent', () => {
  let component: SpatialControlsComponent;
  let fixture: ComponentFixture<SpatialControlsComponent>;
  let dataset$: BehaviorSubject<SpatialDataset | null>;
  let view$: BehaviorSubject<SpatialViewState>;
  let controls: jest.Mocked<ISpatialControls>;
  let selection$: BehaviorSubject<SpatialSelectionMask>;

  /** Let the async key rebuild (categoryColors is a promise) settle. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Build the component with a given `getSpatialControls` result.
   *
   * `render` is opt-in: the PrimeNG inputs carry `ngModel`, and under
   * `NO_ERRORS_SCHEMA` those elements have no value accessor, so rendering the
   * populated body throws NG01203. The behavioural tests therefore drive
   * `ngOnInit()` directly (as the Channels & Histogram spec does) and only the
   * empty states — which render no form controls — are actually rendered.
   */
  async function build(spatial: ISpatialControls | null, render = false) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      declarations: [SpatialControlsComponent],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA], // PrimeNG elements are not under test here
      providers: [{
        provide: VISUALIZER,
        useValue: {
          getSpatialControls: () => spatial,
          getColormap: () => of({ label: 'Viridis', data: { value: 'Viridis' } }),
          getReverseScale: () => of(false),
        },
      }],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialControlsComponent);
    component = fixture.componentInstance;
    if (render) fixture.detectChanges();
    else component.ngOnInit();
    await flush();
    return component;
  }

  beforeEach(() => {
    dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    view$ = new BehaviorSubject<SpatialViewState>({ ...DEFAULT_SPATIAL_VIEW });
    selection$ = new BehaviorSubject<SpatialSelectionMask>(emptySelection());
    controls = {
      getDataset$: jest.fn(() => dataset$),
      getViewState$: jest.fn(() => view$),
      viewState: jest.fn(() => view$.value),
      setViewState: jest.fn((partial) => view$.next({ ...view$.value, ...partial })),
      colorByColumn: jest.fn((name: string) =>
        view$.next({ ...view$.value, colorBy: { kind: 'column', name } })),
      colorByFeature: jest.fn((name: string) =>
        view$.next({ ...view$.value, colorBy: { kind: 'feature', name } })),
      clearColorBy: jest.fn(() => view$.next({ ...view$.value, colorBy: null })),
      searchFeatures: jest.fn(async () => ['Ttr']),
      categoryColors: jest.fn(async () => ['#ff0000', '#0000ff']),
      getSelection$: jest.fn(() => selection$),
      selectFromRegions: jest.fn(() => {
        selection$.next({ mask: new Uint8Array([1, 0, 1]), count: 2 });
        return 2;
      }),
      selectCategory: jest.fn(async () => {
        selection$.next({ mask: new Uint8Array([1, 0, 0]), count: 1 });
        return 1;
      }),
      clearSelection: jest.fn(() => selection$.next(emptySelection())),
    } as unknown as jest.Mocked<ISpatialControls>;
  });

  describe('without a SPATIAL_DATA_PORT', () => {
    it('renders an empty state instead of dead controls', async () => {
      await build(null, true);
      expect(component.controls).toBeNull();
      expect(component.dataset).toBeNull();
      expect(component.columnOptions).toEqual([]);
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('SPATIAL_DATA_PORT');
    });

    it('setters are safe no-ops', async () => {
      await build(null);
      expect(() => {
        component.onColumn('region');
        component.onPointScale(2);
        component.reset();
      }).not.toThrow();
    });
  });

  describe('colour source', () => {
    beforeEach(async () => build(controls));

    it('offers "None" plus every column, labelled by kind', () => {
      expect(component.columnOptions[0]).toEqual({ label: 'None (flat colour)', value: null });
      expect(component.columnOptions.map((o) => o.value)).toEqual([null, 'region', 'total_counts']);
      expect(component.columnOptions[1].label).toContain('2 categories');
      expect(component.columnOptions[2].label).toContain('counts');
    });

    it('colours by a column', () => {
      component.onColumn('region');
      expect(controls.colorByColumn).toHaveBeenCalledWith('region');
    });

    it('clears the colouring when None is chosen', () => {
      component.onColumn(null);
      expect(controls.clearColorBy).toHaveBeenCalled();
    });

    it('column and gene are mutually exclusive, so the source is never ambiguous', () => {
      component.onGene('Ttr');
      expect(component.selectedColumn).toBeNull();
      expect(controls.colorByFeature).toHaveBeenCalledWith('Ttr');

      component.onColumn('region');
      expect(component.selectedGene).toBeNull();
    });

    it('reflects a colour source set elsewhere (e.g. by the host)', () => {
      controls.colorByFeature('Mbp');
      expect(component.selectedGene).toBe('Mbp');
      expect(component.selectedColumn).toBeNull();
    });
  });

  describe('gene picker', () => {
    beforeEach(async () => build(controls));

    it('lists the dataset\'s own gene names, so the options exist before typing', () => {
      // The fixture inlines its names, which is the targeted-panel case.
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Ttr', 'Mbp']);
      expect(component.genesAreRemote).toBe(false);
    });

    it('filters resident names in the dropdown, without hitting the port', async () => {
      await component.onGeneFilter('tt');
      // Nothing to fetch: the dropdown narrows the list it already has.
      expect(controls.searchFeatures).not.toHaveBeenCalled();
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Ttr', 'Mbp']);
    });

    it('searches the port per keystroke when the dataset inlines no names', async () => {
      // Whole-transcriptome: ~31k names are not shipped, so the answer to the
      // query BECOMES the option list — same control, filtering one hop away.
      dataset$.next({ ...dataset, features: { count: 31_000 } } as SpatialDataset);
      await flush();
      expect(component.genesAreRemote).toBe(true);
      expect(component.geneOptions).toEqual([]);

      await component.onGeneFilter('tt');
      expect(controls.searchFeatures).toHaveBeenCalledWith('tt', 50);
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Ttr']);

      // Clearing the filter empties the list rather than leaving a stale one.
      await component.onGeneFilter('');
      expect(component.geneOptions).toEqual([]);
    });

    it('surfaces a remote failure instead of wedging the control', async () => {
      dataset$.next({ ...dataset, features: { count: 31_000 } } as SpatialDataset);
      await flush();
      controls.searchFeatures.mockRejectedValueOnce(new Error('offline'));
      await component.onGeneFilter('tt');
      expect(component.geneOptions).toEqual([]);
      expect(component.geneSearchFailed).toBe(true);

      // …and the next keystroke clears the failure rather than latching it.
      await component.onGeneFilter('ttr');
      expect(component.geneSearchFailed).toBe(false);
    });

    it('clearing the dropdown clears the colour source', () => {
      component.onGene(null);
      expect(controls.clearColorBy).toHaveBeenCalled();
      expect(component.selectedGene).toBeNull();
    });
  });

  describe('key', () => {
    beforeEach(async () => build(controls));

    it('builds a legend for a categorical column from the renderer\'s own colours', async () => {
      component.onColumn('region');
      await flush();
      expect(controls.categoryColors).toHaveBeenCalledWith('region');
      expect(component.legend).toEqual([
        { label: 'Cortex', color: '#ff0000' },
        { label: 'Thalamus', color: '#0000ff' },
      ]);
      expect(component.isCategorical).toBe(true);
      expect(component.colorBarCss).toBeNull();
    });

    it('builds a colour bar for a continuous column', async () => {
      component.onColumn('total_counts');
      await flush();
      expect(component.legend).toBeNull();
      expect(component.isContinuous).toBe(true);
      expect(component.colorBarCss).toContain('linear-gradient');
    });

    it('builds a colour bar for a gene', async () => {
      component.onGene('Ttr');
      await flush();
      expect(component.isContinuous).toBe(true);
      expect(component.colorByLabel).toBe('Gene · Ttr');
    });

    it('surfaces a column description, so a DERIVED column does not read as measured', async () => {
      dataset$.next({
        ...dataset,
        columns: [{
          kind: 'categorical', name: 'cluster', categories: ['a', 'b'],
          description: 'k-means (k=8) — derived for the demo',
        }],
      });
      component.onColumn('cluster');
      await flush();
      expect(component.activeDescription).toMatch(/k-means/);
    });

    it('has no description for a gene or an undescribed column', async () => {
      component.onGene('Ttr');
      await flush();
      expect(component.activeDescription).toBeNull();
      component.onColumn('region');
      await flush();
      expect(component.activeDescription).toBeNull();
    });

    it('shows no key at all when nothing is coloured by', async () => {
      component.onColumn(null);
      await flush();
      expect(component.legend).toBeNull();
      expect(component.colorBarCss).toBeNull();
      expect(component.colorByLabel).toBe('Flat colour');
    });

    it('leaves the key empty rather than wrong when the column cannot be read', async () => {
      controls.categoryColors.mockRejectedValueOnce(new Error('not loaded'));
      component.onColumn('region');
      await flush();
      expect(component.legend).toBeNull();
    });
  });

  describe('display controls', () => {
    beforeEach(async () => build(controls));

    it('writes point scale and opacity through', () => {
      component.onPointScale(2.5);
      expect(controls.setViewState).toHaveBeenCalledWith({ pointScale: 2.5 });
      component.onOpacity(0.4);
      expect(controls.setViewState).toHaveBeenCalledWith({ opacity: 0.4 });
    });

    it('ignores an empty slider value rather than storing undefined', () => {
      component.onPointScale(undefined);
      component.onOpacity(undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('writes the log toggle and the percentile clip', () => {
      component.onLogScale(true);
      expect(controls.setViewState).toHaveBeenCalledWith({ logScale: true });
      component.onClip([0.05, 0.95]);
      expect(controls.setViewState).toHaveBeenCalledWith({ percentileClip: [0.05, 0.95] });
    });

    it('offers the gene map only while a gene is the colour source', () => {
      expect(component.canMapGene).toBe(false); // nothing to map
      component.onColumn('region');
      expect(component.canMapGene).toBe(false); // a column is not a gene
      view$.next({ ...view$.value, colorBy: { kind: 'feature', name: 'Ttr' } });
      expect(component.canMapGene).toBe(true);
    });

    it('writes the gene-map toggle and its bandwidth, ignoring an empty slider', () => {
      component.onGeneMap(true);
      expect(controls.setViewState).toHaveBeenCalledWith({ geneMap: true });
      component.onGeneMapSmoothing(2);
      expect(controls.setViewState).toHaveBeenCalledWith({ geneMapSmoothing: 2 });
      // The map's opacity is its own: turning the cells down to read the field
      // beneath them must not dim the field too.
      component.onGeneMapOpacity(0.4);
      expect(controls.setViewState).toHaveBeenCalledWith({ geneMapOpacity: 0.4 });
      (controls.setViewState as jest.Mock).mockClear();
      component.onGeneMapOpacity(undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('writes the density toggle and its bandwidth, ignoring an empty slider', () => {
      component.onDensityVolume(true);
      expect(controls.setViewState).toHaveBeenCalledWith({ densityVolume: true });
      component.onDensitySmoothing(2.5);
      expect(controls.setViewState).toHaveBeenCalledWith({ densitySmoothing: 2.5 });
      (controls.setViewState as jest.Mock).mockClear();
      component.onDensitySmoothing(undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('says when a column has more categories than the 3D cloud can colour', () => {
      // subclass (338) is served for the density volumes; a user who picks it in the
      // cloud sees one flat colour, and a console warning is not something anyone
      // reads — so the panel says why, and what does render it.
      component.is3d = true;
      (component as any).legend = Array.from({ length: 338 }, (_, i) => ({
        label: `s${i}`, color: '#888888',
      }));
      expect(component.exceedsCloudPalette).toBe(true);
      // 95, not 96: one of the LUT's 96 distinguishable blocks is reserved for a
      // missing value, and the panel must publish what the renderer enforces —
      // at 96 the cloud drew flat with no warning at all.
      expect(component.cloudPaletteLimit).toBe(95);
      (component as any).legend = Array.from({ length: 96 }, () => ({ label: 'c', color: '#888' }));
      expect(component.exceedsCloudPalette).toBe(true);

      // Within the ceiling, or in 2D, there is nothing to warn about.
      (component as any).legend = Array.from({ length: 95 }, () => ({ label: 'c', color: '#888' }));
      expect(component.exceedsCloudPalette).toBe(false);
      (component as any).legend = Array.from({ length: 338 }, () => ({ label: 'c', color: '#888' }));
      component.is3d = false;
      expect(component.exceedsCloudPalette).toBe(false);
    });

    it('says what the density volumes are showing, and that it is an estimate', () => {
      // An estimate is only honest if the reader can tell it from measurement.
      expect(component.densityNote).toContain('not measured cells');
      expect(component.densityNote).toContain('all cells');
      // …and how to actually see them: the cloud is drawn over the fields.
      expect(component.densityNote).toContain('Lower Opacity');

      (component as any).legend = [{ label: 'A', color: '#f00' }];
      expect(component.densityNote).toContain('largest clusters');
    });

    it('reset restores the defaults and clears both pickers', () => {
      component.onColumn('region');
      component.reset();
      expect(controls.setViewState).toHaveBeenCalledWith({ ...DEFAULT_SPATIAL_VIEW });
      expect(component.selectedColumn).toBeNull();
      expect(component.selectedGene).toBeNull();
    });
  });

  it('gives each instance its own charts-body id for aria-controls and the scroll', async () => {
    await build(controls);
    const first = component.chartsBodyId;
    await build(controls);
    // Otherwise `aria-controls` names a non-unique target and expanding the
    // second panel scrolls the first panel's chart into view.
    expect(component.chartsBodyId).not.toBe(first);
  });

  describe('out-of-order responses', () => {
    beforeEach(async () => build(controls));

    it('keeps the options for the query in the box, not an earlier one', async () => {
      // Typing outruns the lookup: a slow answer for "Tt" must not replace the
      // options for "Ttr", and its failure must not mark "Ttr" as failed.
      dataset$.next({ ...dataset, features: { count: 31_000 } } as SpatialDataset);
      await flush();
      let resolveSlow: (v: string[]) => void = () => undefined;
      controls.searchFeatures
        .mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }))
        .mockResolvedValueOnce(['Ttr']);

      const slow = component.onGeneFilter('Tt');
      await component.onGeneFilter('Ttr');
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Ttr']);

      resolveSlow(['Tt-one', 'Tt-two']);
      await slow;

      expect(component.geneOptions.map((o) => o.value)).toEqual(['Ttr']);
      expect(component.geneSearchFailed).toBe(false);
    });

    it('keeps the legend of the column that is selected now', async () => {
      // Two categorical columns, so the slow one's palette has somewhere wrong to
      // land: `region` (2 categories) answering after `zone` (1).
      dataset$.next({
        ...dataset,
        columns: [
          ...dataset.columns,
          { kind: 'categorical', name: 'zone', categories: ['Z'], colors: ['#0f0'] },
        ],
      } as SpatialDataset);
      await flush();

      let resolveSlow: (v: string[]) => void = () => undefined;
      controls.categoryColors
        .mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }))
        .mockResolvedValueOnce(['#0f0']);

      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'region' } });
      await flush();
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'zone' } });
      await flush();
      resolveSlow(['#f00', '#00f']);
      await flush();

      // region's two-colour answer arriving late must not repaint zone's key.
      expect(component.legend?.map((e) => e.color)).toEqual(['#0f0']);
    });
  });

  describe('selection', () => {
    beforeEach(async () => build(controls));

    it('selects from the drawn ROIs and reports the count', () => {
      component.selectFromRegions();
      expect(controls.selectFromRegions).toHaveBeenCalled();
      expect(component.hasSelection).toBe(true);
      expect(component.selection.count).toBe(2);
      expect(component.selectionMissed).toBe(false);
    });

    it('says so when the ROIs matched nothing, rather than looking inert', () => {
      controls.selectFromRegions.mockReturnValueOnce(0);
      component.selectFromRegions();
      expect(component.selectionMissed).toBe(true);
      expect(component.hasSelection).toBe(false);
    });

    it('selects a category from the legend', async () => {
      component.onColumn('region');
      await flush();
      await component.selectCategory(1);
      expect(controls.selectCategory).toHaveBeenCalledWith('region', 1);
      expect(component.selectedCategory).toBe(1);
      expect(component.hasSelection).toBe(true);
    });

    it('clicking the active legend row again clears — a click is reversible', async () => {
      component.onColumn('region');
      await flush();
      await component.selectCategory(0);
      expect(component.selectedCategory).toBe(0);

      await component.selectCategory(0);
      expect(controls.clearSelection).toHaveBeenCalled();
      expect(component.selectedCategory).toBeNull();
      expect(component.hasSelection).toBe(false);
    });

    it('ignores a legend click while colouring by a gene (no categories to select)', async () => {
      component.onGene('Ttr');
      await flush();
      await component.selectCategory(0);
      expect(controls.selectCategory).not.toHaveBeenCalled();
    });

    it('drops the highlighted row when the selection is cleared elsewhere', async () => {
      component.onColumn('region');
      await flush();
      await component.selectCategory(1);
      selection$.next(emptySelection());
      expect(component.selectedCategory).toBeNull();
    });

    it('reset clears the selection as well as the view state', () => {
      component.selectFromRegions();
      component.reset();
      expect(controls.clearSelection).toHaveBeenCalled();
      expect(component.hasSelection).toBe(false);
    });
  });

  describe('distribution section', () => {
    beforeEach(async () => build(controls));

    it('starts collapsed, so the panel stays the height of its controls', () => {
      expect(component.chartsOpen).toBe(false);
    });

    it('toggles open and shut', () => {
      component.toggleCharts();
      expect(component.chartsOpen).toBe(true);
      component.toggleCharts();
      expect(component.chartsOpen).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('drops stale picker state when the dataset changes', async () => {
      await build(controls);
      component.onGene('Ttr');
      dataset$.next({ ...dataset, id: 'other', name: 'Other', columns: [] });
      expect(component.selectedGene).toBeNull();
      expect(component.columnOptions).toHaveLength(1); // just "None"
    });

    it('unsubscribes on destroy', async () => {
      await build(controls);
      expect(dataset$.observed).toBe(true);
      fixture.destroy();
      expect(dataset$.observed).toBe(false);
      expect(view$.observed).toBe(false);
    });

    it('emits visibility changes for two-way binding', async () => {
      await build(controls);
      const seen: boolean[] = [];
      component.visibleChange.subscribe((v) => seen.push(v));
      component.onVisibleChange(false);
      expect(seen).toEqual([false]);
      expect(component.visible).toBe(false);
    });
  });
});
