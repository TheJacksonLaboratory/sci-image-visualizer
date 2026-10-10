import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { BehaviorSubject, of } from 'rxjs';

import { SpatialControlsComponent, parseGeneGroups } from './spatial-controls.component';
import { GENE_OPTIONS_MAX } from '../spatial/gene-search';
import { VISUALIZER, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../contracts/display-types';
import { COLORMAP_OPTIONS } from '../plot.utilities';
import {
  SpatialSelectionMask, emptySelection,
} from '../spatial/spatial-selection';

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
          // The library's real option tree, so the picker's lookup is tested
          // against the values a host actually gets.
          getColormapOptions: () => COLORMAP_OPTIONS,
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
      // Three imaged sections, so the "one section at a time" control has
      // something to step through.
      sampledSections: jest.fn(() => Float32Array.from([0, 10, 20])),
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

    it('narrows resident names itself, without hitting the port', async () => {
      await component.onGeneFilter('tt');
      // Nothing to fetch: the names are already here.
      expect(controls.searchFeatures).not.toHaveBeenCalled();
      // And the component does the narrowing rather than handing the control every name
      // and letting it filter — which is what made an 18,078-gene dataset lock the UI on
      // each keystroke.
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Ttr']);
    });

    it('shows only the head of a whole-transcriptome list, not all of it', async () => {
      // The reported freeze: opening the picker on the Visium bundle's 18,078 genes.
      // What must not happen is those becoming 18,078 options.
      const names = Array.from({ length: 18078 }, (_, i) => `Gene${i}`);
      dataset$.next({ ...dataset, features: { count: names.length, names } });
      await flush();
      expect(component.genesAreRemote).toBe(false);
      expect(component.geneOptions.length).toBe(GENE_OPTIONS_MAX);

      // Typing still reaches a name far past the cap, because the search runs over the
      // whole resident list rather than over what happens to be on screen.
      await component.onGeneFilter('Gene17999');
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Gene17999']);
      expect(controls.searchFeatures).not.toHaveBeenCalled();
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

    it('switches the drawn annotation regions off and on, like the other layer sections', () => {
      component.onShowAnnotations(false);
      expect(controls.setViewState).toHaveBeenCalledWith({ showAnnotations: false });
      expect(component.view.showAnnotations).toBe(false);
      component.onShowAnnotations(true);
      expect(component.view.showAnnotations).toBe(true);
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

    it('writes the picked colormap, and clearing it goes back to the image’s', () => {
      component.onContinuousColormap({ label: 'Magma', data: { value: 'MAGMA_LUT' } });
      expect(controls.setViewState).toHaveBeenCalledWith({ continuousColormap: 'MAGMA_LUT' });
      component.onContinuousColormap(null);
      expect(controls.setViewState).toHaveBeenCalledWith({ continuousColormap: null });
      // A group row carries no value, so picking one must not set a bogus colormap.
      component.onContinuousColormap({ label: 'Sequential', data: null } as never);
      expect(controls.setViewState).toHaveBeenLastCalledWith({ continuousColormap: null });
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
      component.onContinuousColormap(resolved);
      expect(controls.setViewState).toHaveBeenCalledWith({
        continuousColormap: resolved.data.value,
      });

      // And an unresolved key is still a name, which must pass through too.
      const key = component.colormapOptions
        .flatMap((g) => g.children ?? [])
        .find((n) => n.label === 'Plasma')!;
      expect(key.data!.value).toBe('PLASMA_LUT');
      component.onContinuousColormap(key);
      expect(controls.setViewState).toHaveBeenCalledWith({ continuousColormap: 'PLASMA_LUT' });
    });

    it('shows the colormap in use, found in the option tree', async () => {
      // The picker has to reflect state set from anywhere — a host calling
      // setViewState, or a restored session — not just its own clicks.
      view$.next({ ...view$.value, continuousColormap: 'MAGMA_LUT' });
      await flush();
      expect(component.selectedColormapNode?.label).toBe('Magma');

      view$.next({ ...view$.value, continuousColormap: null });
      await flush();
      expect(component.selectedColormapNode).toBeNull();

      // An unknown value selects nothing rather than throwing.
      view$.next({ ...view$.value, continuousColormap: 'NOT_A_LUT' });
      await flush();
      expect(component.selectedColormapNode).toBeNull();
    });

    it('builds the colour bar from the colormap the renderer would use', async () => {
      view$.next({
        ...view$.value,
        colorBy: { kind: 'feature', name: 'Ttr' },
        continuousColormap: 'Reds',
      });
      await flush();
      const reds = component.colorBarCss!;
      expect(reds).toContain('linear-gradient');

      view$.next({ ...view$.value, continuousColormap: 'Viridis' });
      await flush();
      // A different colormap has to produce a different bar; built from `lutFor`
      // on the IMAGE's colormap alone, the bar showed grey while the canvas drew
      // Viridis, which makes the key worse than no key at all.
      expect(component.colorBarCss).not.toBe(reds);
    });

    it('writes the volume and cloud visibility independently', () => {
      // The point of separate toggles: every combination is reachable, including
      // the density volumes alone.
      component.onShowVolume(false);
      expect(controls.setViewState).toHaveBeenCalledWith({ showVolume: false });
      component.onShowPoints(false);
      expect(controls.setViewState).toHaveBeenCalledWith({ showPoints: false });
      expect(component.view.showVolume).toBe(false);
      expect(component.view.showPoints).toBe(false);
    });

    it('writes the volume opacity, separately from the markers', () => {
      component.onVolumeOpacity(0.2);
      expect(controls.setViewState).toHaveBeenCalledWith({ volumeOpacity: 0.2 });
      // Turning the backdrop down must leave the measurement drawn over it alone.
      expect(component.view.opacity).toBe(DEFAULT_SPATIAL_VIEW.opacity);
      (controls.setViewState as jest.Mock).mockClear();
      component.onVolumeOpacity(undefined);
      expect(controls.setViewState).not.toHaveBeenCalled();
    });

    it('opens the section picker mid-stack and releases it back to every section', () => {
      expect(component.oneSection).toBe(false);
      expect(component.isSectioned).toBe(true); // three sections in the mock
      expect(component.lastSection).toBe(2);

      component.onOneSection(true);
      // The middle slide, not the first: for a brain the first is a nearly empty
      // olfactory-bulb section, which reads as a broken control.
      expect(controls.setViewState).toHaveBeenCalledWith({ pointSection: 1 });
      expect(component.oneSection).toBe(true);
      expect(component.sectionLabel).toBe('2 of 3');

      component.onPointSection(2);
      expect(component.sectionLabel).toBe('3 of 3');

      component.onOneSection(false);
      expect(controls.setViewState).toHaveBeenCalledWith({ pointSection: null });
      expect(component.oneSection).toBe(false);
    });

    it('offers no section picker for a dataset whose z is not sectioned', () => {
      component.sections = null;
      expect(component.isSectioned).toBe(false);
      expect(component.sectionLabel).toBe('');
      // A single section is not a stack to step through either.
      component.sections = Float32Array.from([5]);
      expect(component.isSectioned).toBe(false);
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

  describe('template bindings', () => {
    beforeEach(async () => build(controls));

    it('return the same option array and colour bar until their inputs change', async () => {
      // Fresh arrays per change-detection pass make PrimeNG re-render its controls, and a
      // colour bar is a 256-entry LUT; neither should be rebuilt per pass.
      const options = component.markerColumnOptions;
      const bar = component.densityColorBarCss;
      expect(component.markerColumnOptions).toBe(options);
      expect(component.densityColorBarCss).toBe(bar);
      dataset$.next({ ...dataset, columns: [...dataset.columns] });
      await flush();
      expect(component.markerColumnOptions).not.toBe(options);
      expect(component.markerColumnOptions).toEqual(options);
    });
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

    it('drops a whole-transcriptome gene list fetched for the previous dataset', async () => {
      // Two remote-gene datasets: A's list arriving after the switch must not become
      // B's, and B's own preload must not be skipped as "already loading".
      const remote = (id: string) => ({ ...dataset, id, features: { count: 31_000 } }) as SpatialDataset;
      dataset$.next(remote('A'));
      await flush();
      let resolveA: (v: string[]) => void = () => undefined;
      controls.searchFeatures
        .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))
        .mockResolvedValueOnce(['B-gene']);

      const loadingA = component.ensureGeneList();
      dataset$.next(remote('B'));
      await flush();
      resolveA(['A-gene']);
      await loadingA;
      expect(component.genesAreRemote).toBe(true);
      expect(component.geneOptions.map((o) => o.value)).not.toContain('A-gene');

      await component.ensureGeneList();
      expect(controls.searchFeatures).toHaveBeenCalledTimes(2);
      expect(component.genesAreRemote).toBe(false);
      expect(component.geneOptions.map((o) => o.value)).toEqual(['B-gene']);
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

  /**
   * Re-fitting the chart when the dialog is resized.
   *
   * Plotly does not follow a container resize on its own — its `responsive`
   * option listens for WINDOW resizes only — so the panel has to tell it. The
   * signal is the dialog's own resize-end event rather than an observer watching
   * boxes.
   */
  describe('resizing the dialog', () => {
    it('re-fits the embedded chart', async () => {
      await build(controls);
      const resize = jest.fn();
      // The chart is a ViewChild, which the behavioural tests do not render.
      (component as unknown as { charts?: { resize: () => void } }).charts = { resize };
      component.onResizeEnd();
      expect(resize).toHaveBeenCalledTimes(1);
    });

    it('does not blow up before the chart exists', async () => {
      await build(controls);
      // The charts section is collapsed until opened, so the ViewChild is unset.
      expect(() => component.onResizeEnd()).not.toThrow();
    });

    it('is actually wired to the dialog in the template', async () => {
      // The delegation above passes even if the binding was never written, or was
      // misspelled — a template typo fails silently. Under NO_ERRORS_SCHEMA the
      // p-dialog is an unknown element, so the output binding registers as a plain
      // DOM listener and dispatching the event exercises the real wiring.
      await build(null, true);
      const spy = jest.spyOn(component, 'onResizeEnd');
      const dialog = fixture.nativeElement.querySelector('p-dialog');
      expect(dialog).toBeTruthy();
      dialog.dispatchEvent(new Event('onResizeEnd'));
      expect(spy).toHaveBeenCalled();
    });
  });


  describe('cells and transcripts', () => {
    const tiled: SpatialDataset = {
      ...dataset,
      columns: [
        { kind: 'categorical', name: 'graphclust', categories: ['A', 'B'] },
        { kind: 'categorical', name: 'curated_cell_type', categories: ['T cell', 'Tumour'] },
        { kind: 'continuous', name: 'cell_area' },
      ],
      features: { count: 27000 },
      polygonTiles: {
        bounds: [0, 0, 100, 100],
        sets: [{ name: 'nucleus', label: 'Nuclei' }, { name: 'cell', label: 'Cells' }],
        defaultSet: 'cell',
        levels: [{ tileSize: 250 }],
      },
      transcriptTiles: {
        bounds: [0, 0, 100, 100], geneCount: 27000, hasZ: true,
        levels: [{ tileSize: 250, aggregated: false }],
      },
      density: { gridSize: [10, 10], origin: [0, 0], rows: 10, cols: 10 },
      transcriptBins: {
        bounds: [0, 0, 100, 100], origin: [0, 0], count: 1000,
        levels: [{ binSize: 2, tileSize: 128 }],
      },
    };

    it('offers the controls only for a dataset that has the geometry', async () => {
      await build(controls);
      expect(component.hasCells).toBe(false);
      expect(component.hasTranscripts).toBe(false);
      dataset$.next(tiled);
      expect(component.hasCells).toBe(true);
      expect(component.hasTranscripts).toBe(true);
      // Outlines are on by default for data that has them, until the user says otherwise.
      expect(component.cellsOn).toBe(true);
      component.onShowCells(false);
      expect(component.cellsOn).toBe(false);
      // Explorer's order: cell first, and Both when there are two sets.
      expect(component.cellSetOptions.map((o) => o.value)).toEqual(['cell', 'nucleus', 'both']);
      expect(component.activeCellSet).toBe('cell');
      expect(component.transcriptModeOptions.map((o) => o.label))
        .toEqual(['Points', 'Icons', 'Density Map']);
    });

    it('keeps option lists stable between change-detection passes', async () => {
      dataset$.next(tiled);
      await build(controls);
      // A fresh array per read made PrimeNG re-render the buttons until they were unclickable.
      expect(component.transcriptModeOptions).toBe(component.transcriptModeOptions);
      expect(component.groupOptions).toBe(component.groupOptions);
      expect(component.geneTree).toBe(component.geneTree);
      expect(component.geneMenu).toBe(component.geneMenu);
    });

    it('lists groups under their section, with a k-means family listed once', async () => {
      dataset$.next({
        ...tiled,
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
      await build(controls);
      expect(component.groupOptions).toEqual([
        { label: 'Xenium Onboard Analysis groups', items: [
          { label: 'Graph-Based Clustering (GEX)', value: 'graphclust' },
          { label: 'K-Means Clustering (GEX)', value: 'family:kmeans' },
        ] },
        { label: 'Imported groups', items: [{ label: 'Mine', value: 'imported:Mine' }] },
      ]);
      component.onGroupEntry('family:kmeans');
      expect(view$.value.cellTypeColumn).toBe('kmeans_2');
      expect(component.activeGroupEntry).toBe('family:kmeans');
      expect(component.groupVariantOptions.map((o) => o.label)).toEqual(['k = 2', 'k = 3']);
      component.onGroupVariant('kmeans_3');
      component.onGroupEntry('graphclust');
      component.onGroupEntry('family:kmeans');
      expect(view$.value.cellTypeColumn).toBe('kmeans_3'); // remembers the k chosen
    });

    it('counts cells per group and hides switched-off groups', async () => {
      dataset$.next(tiled);
      (controls as any).categoricalView = jest.fn(async () => ({
        name: 'graphclust', categories: ['A', 'B'], colors: ['#f00', '#0f0'],
        codes: Uint16Array.from([1, 1, 0, 1, 0xffff]),
      }));
      await build(controls);
      await flush();
      expect(component.groupRows.map((r) => [r.label, r.count])).toEqual([['B', 3], ['A', 1]]);
      expect(component.groupTotal).toBe(4);
      component.onGroupShown('B', false);
      expect(view$.value.hiddenGroups).toEqual(['B']);
      expect(component.allGroupsShown).toBe(false);
      component.onAllGroupsShown(true);
      expect(view$.value.hiddenGroups).toEqual([]);
      // Changing grouping clears the switched-off groups of the old one.
      component.onGroupShown('A', false);
      component.onCellTypeColumn('curated_cell_type');
      expect(view$.value.hiddenGroups).toEqual([]);
    });

    /** Install a `categoricalView` mock on the controls (an optional member of the port). */
    const categoricalView = (fn: jest.Mock) => {
      (controls as unknown as { categoricalView: jest.Mock }).categoricalView = fn;
      return fn;
    };
    /** The colours of the cells' groups, by name (private component state). */
    const groupColors = () => (component as unknown as { cellGroupColors: Map<string, string> }).cellGroupColors;

    it("drops group rows the previous dataset's same-named grouping answers late", async () => {
      // Both datasets group by `graphclust`: only the load sequence, not the name, can
      // tell the old dataset's answer from the new one's.
      dataset$.next(tiled);
      const view = (categories: string[], codes: number[]) => ({
        name: 'graphclust', categories, colors: categories.map(() => '#000'),
        codes: Uint16Array.from(codes),
      });
      let resolveOld: (v: ReturnType<typeof view>) => void = () => undefined;
      categoricalView(jest.fn())
        .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
        .mockResolvedValueOnce(view(['New'], [0, 0]));
      await build(controls);
      dataset$.next({ ...tiled, id: 'other' } as SpatialDataset);
      await flush();
      expect(component.groupRows.map((r) => r.label)).toEqual(['New']);

      resolveOld(view(['Old'], [0, 0, 0]));
      await flush();
      expect(component.groupRows.map((r) => r.label)).toEqual(['New']);
    });

    it("keeps the newer grouping's rows when a superseded load fails", async () => {
      dataset$.next(tiled);
      let rejectOld: (e: Error) => void = () => undefined;
      let resolveNew: (v: unknown) => void = () => undefined;
      categoricalView(jest.fn())
        .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
        .mockImplementationOnce(() => new Promise((r) => { resolveNew = r; }));
      await build(controls);
      component.onCellTypeColumn('curated_cell_type');
      await flush();
      rejectOld(new Error('gone'));
      await flush();
      resolveNew({
        name: 'curated_cell_type', categories: ['T cell'], colors: ['#000'], codes: Uint16Array.from([0]),
      });
      await flush();
      expect(component.groupRows.map((r) => r.label)).toEqual(['T cell']);
      expect(controls.categoricalView).toHaveBeenCalledTimes(2);
    });

    it("reloads the group colours for a new dataset's same-named grouping", async () => {
      dataset$.next(tiled);
      categoricalView(jest.fn(async () => ({
        name: 'graphclust', categories: ['A', 'B'], colors: ['#000', '#000'], codes: Uint16Array.from([0]),
      })));
      controls.categoryColors.mockResolvedValueOnce(['#f00', '#0f0']).mockResolvedValueOnce(['#00f', '#ff0']);
      await build(controls);
      await flush();
      expect([...groupColors().values()]).toEqual(['#f00', '#0f0']);

      dataset$.next({ ...tiled, id: 'other' } as SpatialDataset);
      await flush();
      expect([...groupColors().values()]).toEqual(['#00f', '#ff0']);
    });

    it('builds the selected-genes tree from gene groups, and hides genes with the eye', async () => {
      dataset$.next(tiled);
      await build(controls);
      controls.setViewState({
        transcriptGenes: ['DMBT1', 'MUC5AC', 'KRT5'],
        transcriptGeneGroups: [{ name: 'Endocervical', genes: ['DMBT1', 'MUC5AC', 'PIGR'] }],
      });
      expect(component.geneTree).toEqual([
        { name: 'Endocervical', genes: ['DMBT1', 'MUC5AC'] },
        { name: null, genes: ['KRT5'] },
      ]);
      component.onGenesShown(['DMBT1', 'MUC5AC'], false);
      expect(view$.value.transcriptHiddenGenes).toEqual(['DMBT1', 'MUC5AC']);
      expect(component.areGenesShown(['DMBT1', 'MUC5AC'])).toBe(false);
      component.onGeneColor('KRT5', '#123456');
      expect(component.geneColorOf('KRT5')).toBe('#123456');
    });

    it('parses gene groups from a group,gene table', () => {
      expect(parseGeneGroups('group,gene\nPlasma,IGHG3\nPlasma,IGKC\nEndo,AQP1\n')).toEqual([
        { name: 'Plasma', genes: ['IGHG3', 'IGKC'] }, { name: 'Endo', genes: ['AQP1'] },
      ]);
    });

    it('the Transcripts header switch turns transcripts off and back on in the last mode', async () => {
      dataset$.next(tiled);
      await build(controls);
      component.onTranscriptMode('glyphs');
      component.onTranscriptsOn(false);
      expect(view$.value.transcriptMode).toBe('off');
      component.onTranscriptsOn(true);
      expect(view$.value.transcriptMode).toBe('glyphs');
    });

    it('seeds the transcript genes from the gene being coloured by', async () => {
      dataset$.next(tiled);
      await build(controls);
      component.onGene('EPCAM');
      component.onTranscriptMode('circles');
      expect(view$.value.transcriptMode).toBe('circles');
      expect(view$.value.transcriptGenes).toEqual(['EPCAM']);
    });

    it('loads a whole-transcriptome gene list lazily, once, on first open', async () => {
      dataset$.next(tiled);
      await build(controls);
      expect(component.genesAreRemote).toBe(true);
      controls.searchFeatures.mockResolvedValue(['A1BG', 'EPCAM', 'EPHA2', 'KRT5']);
      await component.ensureGeneList();
      expect(controls.searchFeatures).toHaveBeenCalledWith('', 100_000);
      expect(component.genesAreRemote).toBe(false);
      // Resident now: filtering is local, no further requests.
      controls.searchFeatures.mockClear();
      await component.onGeneFilter('EP');
      expect(controls.searchFeatures).not.toHaveBeenCalled();
      expect(component.geneOptions.map((o) => o.value)).toEqual(['EPCAM', 'EPHA2']);
      await component.ensureGeneList();
      expect(controls.searchFeatures).not.toHaveBeenCalled();
    });

    it('keeps chosen transcript genes among the options, so their chips show', async () => {
      dataset$.next(tiled);
      await build(controls);
      controls.searchFeatures.mockResolvedValue(['A1BG', 'KRT5']);
      component.onTranscriptGenes(['EPCAM']);
      await component.ensureGeneList();
      expect(component.geneOptions.map((o) => o.value)).toContain('EPCAM');
    });

    it('labels the boundary sets briefly, to fit one row', async () => {
      dataset$.next({
        ...tiled,
        polygonTiles: { ...tiled.polygonTiles!, sets: [
          { name: 'nucleus', label: 'Nucleus boundaries' }, { name: 'cell', label: 'Cell boundaries' },
        ] },
      });
      await build(controls);
      expect(component.cellSetOptions.map((o) => o.label)).toEqual(['Cell', 'Nucleus', 'Both']);
    });

    it('gives each gene a glyph by position until one is chosen', async () => {
      dataset$.next(tiled);
      await build(controls);
      expect(component.glyphOf('A', 0)).toBe('circle');
      expect(component.glyphOf('B', 1)).toBe('star');
      component.onGlyph('B', 'hexagon');
      expect(view$.value.transcriptGlyphs).toEqual({ B: 'hexagon' });
      expect(component.glyphOf('B', 1)).toBe('hexagon');
    });

    it('opens one icon and colour picker per gene, as Xenium Explorer does', async () => {
      dataset$.next(tiled);
      await build(controls);
      jest.useFakeTimers();
      view$.next({ ...view$.value, transcriptGenes: ['A', 'B'] });
      const panel = { toggle: jest.fn(), hide: jest.fn() };
      const click = new MouseEvent('click');
      component.openGeneStyle(click, 'B', panel);
      expect(component.styleGene).toBe('B');
      expect(component.styleGlyph).toBe('star'); // B's default, by position
      jest.runAllTimers();
      expect(panel.toggle).toHaveBeenCalledWith(click);
      // Clicking the same gene again just toggles the panel.
      component.openGeneStyle(click, 'B', panel);
      expect(panel.toggle).toHaveBeenCalledTimes(2);
      // Choosing an icon and a colour writes the view state; the picker follows it.
      component.onGlyph('B', 'diamond');
      expect(component.styleGlyph).toBe('diamond');
      component.onGeneColor('B', component.colorPresets[3]);
      expect(view$.value.transcriptGeneColors).toEqual({ B: component.colorPresets[3] });
      jest.useRealTimers();
    });

    it('accepts a typed hex colour with or without #, and ignores anything else', async () => {
      dataset$.next(tiled);
      await build(controls);
      component.onGeneHex('A', ' 43BCE7 ');
      expect(view$.value.transcriptGeneColors).toEqual({ A: '#43bce7' });
      component.onGeneHex('A', '#zzzzzz');
      component.onGeneHex('A', '#123');
      expect(view$.value.transcriptGeneColors).toEqual({ A: '#43bce7' });
    });

    it("resets a gene's icon and colour to its defaults, leaving the others", async () => {
      dataset$.next(tiled);
      await build(controls);
      view$.next({
        ...view$.value, transcriptGenes: ['A', 'B'],
        transcriptGlyphs: { A: 'x', B: 'hexagon' }, transcriptGeneColors: { A: '#111111', B: '#222222' },
      });
      component.resetGeneStyle('A');
      expect(view$.value.transcriptGlyphs).toEqual({ B: 'hexagon' });
      expect(view$.value.transcriptGeneColors).toEqual({ B: '#222222' });
      expect(component.glyphOf('A', 0)).toBe('circle');
    });

    it('in Cluster colouring, shows every gene of a cluster in the cluster\'s colour', async () => {
      dataset$.next(tiled);
      await build(controls);
      view$.next({
        ...view$.value, transcriptColorBy: 'cluster', transcriptGenes: ['A', 'B', 'C'],
        transcriptGeneGroups: [{ name: 'K1', genes: ['A', 'B'] }],
      });
      expect(component.geneSwatchOf('A')).toBe(component.geneSwatchOf('B'));
      expect(component.geneSwatchOf('C')).not.toBe(component.geneSwatchOf('A'));
      view$.next({ ...view$.value, transcriptColorBy: 'gene' });
      expect(component.geneSwatchOf('A')).not.toBe(component.geneSwatchOf('B')); // per gene again
    });

    it('draws each glyph for the picker and the gene rows', async () => {
      dataset$.next(tiled);
      await build(controls);
      expect(component.glyphOptions).toHaveLength(10);
      for (const o of component.glyphOptions) expect(component.glyphPoints(o.value)).toBe(o.points);
    });

    it('adds each cluster\'s marker genes as a gene group, each gene once', async () => {
      const markerGenes = jest.fn(async () => ({
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
      }));
      (controls as unknown as { markerGenes: unknown }).markerGenes = markerGenes;
      dataset$.next(tiled);
      await build(controls);
      view$.next({ ...view$.value, cellTypeColumn: 'curated_cell_type', transcriptGenes: ['EPCAM'] });
      expect(component.canAddMarkers).toBe(true);
      component.openMarkers();
      expect(component.markerColumn).toBe('curated_cell_type'); // the cells' grouping
      expect(component.markerClusters).toEqual(['T cell', 'Tumour']);
      component.markerPerGroup = 10;
      await component.addMarkerGenes();
      expect(markerGenes).toHaveBeenCalledWith('curated_cell_type', 10);
      expect(view$.value.transcriptGeneGroups).toEqual([
        { name: 'T cell', genes: ['CD3E'] },
        { name: 'Tumour', genes: ['KRT5', 'SHARED'] }, // SHARED goes where it scores higher
      ]);
      expect(view$.value.transcriptGenes).toEqual(['EPCAM', 'CD3E', 'KRT5', 'SHARED']);
      expect(view$.value.transcriptColorBy).toBe('cluster'); // coloured by cluster from now on
      expect(component.markersOpen).toBe(false);
    });

    it('applies the clusters picked when asked, even if the form changes while the scan runs', async () => {
      let finish!: () => void;
      (controls as unknown as { markerGenes: unknown }).markerGenes = jest.fn(() => new Promise((resolve) => {
        finish = () => resolve({ column: 'graphclust', groups: [
          { name: 'A', cells: 5, genes: [{ name: 'GA', score: 1, pctIn: 0.5, pctOut: 0.1 }] },
          { name: 'B', cells: 5, genes: [{ name: 'GB', score: 1, pctIn: 0.5, pctOut: 0.1 }] },
        ] });
      }));
      dataset$.next(tiled);
      await build(controls);
      component.openMarkers();
      component.onMarkerColumn('graphclust');
      component.markerClusters = ['A'];
      const added = component.addMarkerGenes();
      component.markerClusters = ['B']; // edited mid-scan
      finish();
      await added;
      expect(view$.value.transcriptGeneGroups).toEqual([{ name: 'A', genes: ['GA'] }]);
    });

    it('adds only the clusters picked, and says so when none pass', async () => {
      (controls as unknown as { markerGenes: unknown }).markerGenes = jest.fn(async () => ({
        column: 'graphclust', groups: [{ name: 'A', cells: 5, genes: [] }, { name: 'B', cells: 5, genes: [] }],
      }));
      dataset$.next(tiled);
      await build(controls);
      component.openMarkers();
      component.onMarkerColumn('graphclust');
      component.markerClusters = ['A'];
      await component.addMarkerGenes();
      expect(component.markerError).toMatch(/No marker genes/);
      expect(view$.value.transcriptGeneGroups).toEqual([]);
    });

    it('shows the renderer\'s per-gene counts in view, 0 for a gene with none', async () => {
      const counts$ = new BehaviorSubject<Record<string, number> | null>(null);
      (controls as unknown as { getGeneCountsInView$: unknown }).getGeneCountsInView$ = () => counts$;
      dataset$.next(tiled);
      await build(controls);
      expect(component.geneCountOf('CD163')).toBeNull();
      counts$.next({ CD163: 17 });
      expect(component.geneCountOf('CD163')).toBe(17);
      expect(component.geneCountOf('CD163L1')).toBe(0);
    });

    it('patches the display settings', async () => {
      dataset$.next(tiled);
      await build(controls);
      component.onShowCells(true);
      component.onCellSet('nucleus');
      component.onCellDraw('both');
      component.onCellOpacity(0.3);
      component.onTranscriptQuality(true);
      component.onTranscriptColorBy('gene');
      expect(view$.value).toEqual(expect.objectContaining({
        showCells: true, cellSet: 'nucleus', cellDraw: 'both', cellOpacity: 0.3,
        transcriptQuality: 'all', transcriptColorBy: 'gene',
      }));
    });
      it('offers every gene, grouped, for a dataset with the pyramid', async () => {
      dataset$.next(tiled);
      await build(controls);
      expect(component.canShowAllGenes).toBe(true);
      expect(component.showingAllGenes).toBe(false);
      component.onTranscriptMode('circles');
      component.onTranscriptAllGenes(true);
      expect(component.showingAllGenes).toBe(true);
      // Density is per gene: the switch does not apply there.
      component.onTranscriptMode('density');
      expect(component.showingAllGenes).toBe(false);
      component.onTranscriptBudget(50_000);
      expect(view$.value.transcriptBudget).toBe(50_000);
      dataset$.next(dataset);
      expect(component.canShowAllGenes).toBe(false);
    });
    it('says when "All genes" is still being prepared on the server', async () => {
      const { transcriptBins: _bins, ...rest } = tiled;
      void _bins;
      dataset$.next({ ...rest, transcriptBinsStatus: { state: 'building', done: 25, total: 100 } });
      await build(controls);
      expect(component.canShowAllGenes).toBe(false);
      expect(component.allGenesPreparing).toContain('25%');
      dataset$.next({ ...rest, transcriptBinsStatus: { state: 'failed', message: 'disk full' } });
      expect(component.allGenesPreparing).toContain('disk full');
      dataset$.next(tiled);
      expect(component.allGenesPreparing).toBeNull();
    });
});
});
