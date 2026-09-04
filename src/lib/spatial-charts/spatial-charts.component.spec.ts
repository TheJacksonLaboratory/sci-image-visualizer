import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { SpatialChartsComponent } from './spatial-charts.component';
import { VISUALIZER, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { SpatialColorBy } from '../contracts/display-types';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../contracts/display-types';
import { SpatialSelectionMask, emptySelection } from '../spatial/spatial-selection';

jest.mock('plotly.js-dist-min', () => ({
  react: jest.fn().mockResolvedValue(undefined),
  relayout: jest.fn(),
  purge: jest.fn(),
}));
import * as Plotly from 'plotly.js-dist-min';

const dataset: SpatialDataset = {
  id: 'demo', name: 'Demo',
  observations: { count: 4, x: new Float32Array(4), y: new Float32Array(4) },
  columns: [
    { kind: 'categorical', name: 'region', categories: ['A', 'B'] },
    { kind: 'continuous', name: 'total_counts' },
  ],
  features: { count: 3, names: ['Ttr', 'Mbp', 'Snap25'] },
};

describe('SpatialChartsComponent', () => {
  let component: SpatialChartsComponent;
  let chartHost: HTMLDivElement | null = null;
  let fixture: ComponentFixture<SpatialChartsComponent>;
  let view$: BehaviorSubject<SpatialViewState>;
  let selection$: BehaviorSubject<SpatialSelectionMask>;
  let dataset$: BehaviorSubject<SpatialDataset | null>;
  let controls: jest.Mocked<ISpatialControls>;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** The last (traces, layout) pair handed to Plotly. */
  const lastPlot = () => {
    const calls = (Plotly.react as jest.Mock).mock.calls;
    const call = calls[calls.length - 1];
    return { traces: (call?.[1] ?? []) as Record<string, any>[], layout: call?.[2] as any };
  };

  /** Behavioural tests drive ngOnInit directly: rendering the populated body
   *  under NO_ERRORS_SCHEMA gives the ngModel inputs no value accessor. */
  async function build(spatial: ISpatialControls | null, render = false) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      declarations: [SpatialChartsComponent],
      imports: [FormsModule],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [{ provide: VISUALIZER, useValue: { getSpatialControls: () => spatial } }],
    }).compileComponents();
    fixture = TestBed.createComponent(SpatialChartsComponent);
    component = fixture.componentInstance;
    // The component draws into a div it looks up by its OWN per-instance id, so
    // the host element can only be made once that id exists.
    chartHost = document.createElement('div');
    chartHost.id = component.chartDiv;
    document.body.appendChild(chartHost);
    if (render) {
      fixture.detectChanges();
    } else {
      component.ngOnInit();
      component.ngAfterViewInit();
    }
    await flush();
    return component;
  }

  beforeEach(() => {
    (Plotly.react as jest.Mock).mockClear();
    (Plotly.purge as jest.Mock).mockClear();
    view$ = new BehaviorSubject<SpatialViewState>({ ...DEFAULT_SPATIAL_VIEW });
    selection$ = new BehaviorSubject<SpatialSelectionMask>(emptySelection());
    dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    controls = {
      getDataset$: jest.fn(() => dataset$),
      getViewState$: jest.fn(() => view$),
      getSelection$: jest.fn(() => selection$),
      viewState: jest.fn(() => view$.value),
      setViewState: jest.fn(),
      colorByColumn: jest.fn(), colorByFeature: jest.fn(), clearColorBy: jest.fn(),
      searchFeatures: jest.fn(), categoryColors: jest.fn(),
      selectFromRegions: jest.fn(), selectCategory: jest.fn(), clearSelection: jest.fn(),
      continuousValues: jest.fn(async () => new Float32Array([1, 2, 3, 4])),
      categoricalView: jest.fn(async () => ({
        name: 'region', categories: ['A', 'B'], colors: ['#f00', '#00f'],
        codes: new Uint16Array([0, 0, 1, 1]),
      })),
      categoricalColumns: jest.fn(() => ['region']),
    } as unknown as jest.Mocked<ISpatialControls>;

  });

  afterEach(() => {
    chartHost?.remove();
    chartHost = null;
  });

  it('stays inert without a SPATIAL_DATA_PORT (the host panel explains why)', async () => {
    // The empty state lives in the enclosing <spatial-controls> dialog now, so
    // this component simply does nothing rather than repeating the message.
    await build(null, true);
    expect(component.controls).toBeNull();
    expect(Plotly.react).not.toHaveBeenCalled();
  });

  describe('active', () => {
    it('draws when the host panel becomes visible', async () => {
      await build(controls);
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'total_counts' } });
      await flush();
      (Plotly.react as jest.Mock).mockClear();

      component.active = true;
      await flush();
      // The enclosing dialog creates and destroys its content, so an explicit
      // trigger is what guarantees a first draw with no state change.
      expect(Plotly.react).toHaveBeenCalled();
    });

    it('defers the draw when a collapsed section expands', async () => {
      await build(controls);
      component.active = false;
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'total_counts' } });
      await flush();
      (Plotly.react as jest.Mock).mockClear();

      // The host is still `hidden` at the moment the setter runs, so drawing
      // synchronously would size the chart to a zero-height div.
      component.active = true;
      expect(Plotly.react).not.toHaveBeenCalled();
      await flush();
      expect(Plotly.react).toHaveBeenCalled();
    });

    it('does not draw while the host panel is hidden', async () => {
      await build(controls);
      component.active = false;
      (Plotly.react as jest.Mock).mockClear();
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'total_counts' } });
      await flush();
      expect(Plotly.react).not.toHaveBeenCalled();
    });
  });

  it('says what to do when nothing is coloured by', async () => {
    await build(controls);
    expect(component.notice).toMatch(/Colour the map by a column or a gene/);
    expect(Plotly.react).not.toHaveBeenCalled();
  });

  describe('with a continuous colour source', () => {
    beforeEach(async () => {
      await build(controls);
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'total_counts' } });
      await flush();
    });

    it('charts what the map is coloured by', () => {
      expect(controls.continuousValues).toHaveBeenCalledWith({ kind: 'column', name: 'total_counts' });
      const { traces, layout } = lastPlot();
      expect(traces[0].type).toBe('histogram');
      expect(traces[0].x).toEqual([1, 2, 3, 4]);
      expect(layout.xaxis.title.text).toBe('total_counts');
      expect(component.subject).toBe('total_counts');
      expect(component.notice).toBeNull();
    });

    it('labels a gene source as a gene', async () => {
      view$.next({ ...view$.value, colorBy: { kind: 'feature', name: 'Ttr' } });
      await flush();
      expect(component.subject).toBe('gene Ttr');
    });

    it('overlays the selection on the histogram', async () => {
      selection$.next({ mask: new Uint8Array([0, 1, 1, 0]), count: 2 });
      await flush();
      const { traces } = lastPlot();
      expect(traces).toHaveLength(2);
      expect(traces[1].name).toBe('Selected');
      expect(traces[1].x).toEqual([2, 3]);
      expect(component.selectionCount).toBe(2);
    });

    it('re-renders on a log-scale change without refetching the vector', async () => {
      const before = controls.continuousValues.mock.calls.length;
      view$.next({ ...view$.value, logScale: true });
      await flush();
      expect(controls.continuousValues.mock.calls.length).toBe(before);
      expect(lastPlot().layout.xaxis.title.text).toBe('log1p(total_counts)');
    });

    it('switches chart kind without refetching', async () => {
      const before = controls.continuousValues.mock.calls.length;
      component.onKind('violin');
      await flush();
      expect(controls.continuousValues.mock.calls.length).toBe(before);
      expect(lastPlot().traces[0].type).toBe('violin');
    });

    it('groups a violin by a categorical column, in the map colours', async () => {
      component.onKind('violin');
      await component.onGroupBy('region');
      await flush();
      expect(controls.categoricalView).toHaveBeenCalledWith('region');
      const { traces } = lastPlot();
      expect(traces).toHaveLength(2);
      expect(traces[0]).toEqual(expect.objectContaining({ name: 'A', y: [1, 2] }));
      expect(traces[0].marker.color).toBe('#f00');
    });

    it('ignores the grouping for a histogram', async () => {
      await component.onGroupBy('region');
      component.onKind('histogram');
      await flush();
      expect(lastPlot().traces[0].type).toBe('histogram');
    });

    it('suggests a grouping for a violin that has none', () => {
      component.onKind('violin');
      expect(component.suggestsGrouping).toBe(true);
      component.onKind('histogram');
      expect(component.suggestsGrouping).toBe(false);
    });

    it('recovers from a failed grouping fetch instead of half-applying it', async () => {
      controls.categoricalView.mockRejectedValueOnce(new Error('not loaded'));
      component.onKind('violin');
      await component.onGroupBy('region');
      expect(component.groupBy).toBeNull();
      expect(lastPlot().traces[0].name).toBe('All');
    });

    it('ignores a superseded vector that resolves late', async () => {
      let release: (v: Float32Array) => void = () => undefined;
      controls.continuousValues
        .mockImplementationOnce(() => new Promise<Float32Array>((r) => { release = r; }))
        .mockResolvedValueOnce(new Float32Array([9, 9]));

      view$.next({ ...view$.value, colorBy: { kind: 'feature', name: 'slow' } });
      view$.next({ ...view$.value, colorBy: { kind: 'feature', name: 'fast' } });
      await flush();
      const afterFast = (Plotly.react as jest.Mock).mock.calls.length;

      release(new Float32Array([1, 1]));
      await flush();
      expect((Plotly.react as jest.Mock).mock.calls.length).toBe(afterFast);
    });
  });

  describe('with a categorical colour source', () => {
    beforeEach(async () => {
      await build(controls);
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'region' } });
      await flush();
    });

    it('charts counts per category instead of refusing', () => {
      // A category CODE is a label, not a magnitude, so a histogram of it would be
      // meaningless — but "how many cells per class" is the question the legend
      // implies and never answers.
      expect(controls.categoricalView).toHaveBeenCalledWith('region');
      expect(controls.continuousValues).not.toHaveBeenCalled();
      expect(component.notice).toBeNull();
      expect(component.kind).toBe('counts');

      const { traces, layout } = lastPlot();
      expect(traces[0].type).toBe('bar');
      expect(traces[0].orientation).toBe('h');
      // A x2, B x2, biggest first — and reversed, since Plotly draws the first
      // horizontal category at the bottom.
      expect(traces[0].y).toEqual(['B', 'A']);
      expect(traces[0].x).toEqual([2, 2]);
      expect(layout.xaxis.title.text).toBe('observations');
    });

    it('offers only the kinds a categorical subject can be drawn as', () => {
      // A category code is a label, not a magnitude, so no histogram/violin/box.
      // The heatmap is always offered: its subject is a gene LIST crossed with a
      // grouping, not whatever the map happens to be coloured by.
      expect(component.kindOptions.map((k) => k.value)).toEqual(['counts', 'heatmap']);
    });

    it('returns to a histogram when the source goes back to continuous', async () => {
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'total_counts' } });
      await flush();
      expect(component.kind).toBe('histogram');
      expect(component.kindOptions.map((k) => k.value))
        .toEqual(['histogram', 'violin', 'box', 'heatmap']);
      expect(lastPlot().traces[0].type).toBe('histogram');
    });

    it('reports a genuine failure rather than swallowing it', async () => {
      controls.categoricalView.mockRejectedValueOnce(new Error('column blew up'));
      view$.next({ ...view$.value, colorBy: null });
      await flush();
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'region' } });
      await flush();
      expect(component.notice).toMatch(/could not be charted/);
      expect(Plotly.purge).toHaveBeenCalled();
    });
  });

  it('ignores a grouping response that a later choice overtook', async () => {
    await build(controls);
    view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'total_counts' } });
    await flush();
    component.onKind('violin');

    // A slow 'region' and a fast 'other': without sequencing the slow one lands
    // last and charts region's categories under a dropdown that says other.
    type CatView = Awaited<ReturnType<ISpatialControls['categoricalView']>>;
    let resolveSlow: (v: CatView) => void = () => undefined;
    controls.categoricalView
      .mockImplementationOnce(() => new Promise<CatView>((r) => { resolveSlow = r; }))
      .mockResolvedValueOnce({
        name: 'other', categories: ['X'], colors: ['#0f0'], codes: new Uint16Array([0, 0, 0, 0]),
      });

    const slow = component.onGroupBy('region');
    await component.onGroupBy('other');
    resolveSlow({
      name: 'region', categories: ['A', 'B'], colors: ['#f00', '#00f'],
      codes: new Uint16Array([0, 0, 1, 1]),
    });
    await slow;
    await flush();

    expect(component.groupBy).toBe('other');
    expect(lastPlot().traces.map((t: Record<string, unknown>) => t.name)).toEqual(['X']);
  });

  it('gives each instance its own chart div, so two panels cannot draw into one', async () => {
    // Two exported visualizers on a page (the main diagram + a modal preview) mean
    // two charts; a shared DOM id hands both the first element.
    await build(controls);
    const first = component.chartDiv;
    await build(controls);
    expect(component.chartDiv).not.toBe(first);
    expect(document.getElementById(component.chartDiv)).not.toBeNull();
  });

  describe('lifecycle', () => {
    it('lists the dataset\'s categorical columns to group by', async () => {
      await build(controls);
      expect(component.groupOptions).toEqual([
        { label: 'No grouping', value: null },
        { label: 'region', value: 'region' },
      ]);
    });

    it('drops a grouping that the new dataset does not have', async () => {
      await build(controls);
      await component.onGroupBy('region');
      controls.categoricalColumns.mockReturnValue([]);
      dataset$.next({ ...dataset, id: 'other', columns: [] });
      expect(component.groupBy).toBeNull();
    });

    it('tears down its subscriptions and the plot', async () => {
      await build(controls);
      expect(view$.observed).toBe(true);
      fixture.destroy();
      expect(view$.observed).toBe(false);
      expect(selection$.observed).toBe(false);
      expect(Plotly.purge).toHaveBeenCalledWith(component.chartDiv);
    });
  });

  describe('heatmap (genes x groups)', () => {
    /**
     * Eight cells, four per category — the class view needs more than the
     * default three-cell floor per group to draw at all, and a four-cell
     * selection still sits far under the per-cell cap.
     */
    const geneValues: Record<string, number[]> = {
      Ttr: [1, 1, 1, 1, 9, 9, 9, 9], // low in A, high in B
      Mbp: [5, 5, 5, 5, 5, 5, 5, 5], // flat: distinguishes nothing
    };

    beforeEach(async () => {
      controls.continuousValues = jest.fn(async (source: SpatialColorBy) =>
        Float32Array.from(geneValues[source.name] ?? new Array(8).fill(0)));
      controls.categoricalView = jest.fn(async (column: string) => ({
        name: column, categories: ['A', 'B'], colors: ['#f00', '#00f'],
        codes: Uint16Array.from([0, 0, 0, 0, 1, 1, 1, 1]),
      }));
      await build(controls);
      await flush();
    });

    it('offers the dataset’s gene names as the rows to pick from', () => {
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Ttr', 'Mbp', 'Snap25']);
    });

    it('seeds with the gene already on screen, rather than opening empty', async () => {
      view$.next({ ...view$.value, colorBy: { kind: 'feature', name: 'Ttr' } });
      await flush();
      component.onKind('heatmap');
      await flush();
      expect(component.heatmapGenes).toEqual(['Ttr']);
      // …and it picked a grouping on its own: a heatmap with no columns is not
      // a chart, so "No grouping" is not a usable default here.
      expect(component.groupBy).toBe('region');
      await flush();
      expect(lastPlot().traces[0].type).toBe('heatmap');
    });

    it('draws one row per gene and one column per category', async () => {
      component.onKind('heatmap');
      await flush();
      await component.onHeatmapGenes(['Ttr', 'Mbp']);
      await flush();
      const { traces, layout } = lastPlot();
      expect(traces[0].type).toBe('heatmap');
      expect(traces[0].x).toEqual(['A', 'B']);
      // Rows are flipped for Plotly, so 'Mbp' is drawn first and 'Ttr' second.
      expect(traces[0].y).toEqual(['Mbp', 'Ttr']);
      // Ttr is low in A and high in B; z-scored that is -1 and +1.
      expect(traces[0].z[1]).toEqual([-1, 1]);
      // Mbp is flat, so it distinguishes nothing — zeros, not NaN.
      expect(traces[0].z[0]).toEqual([0, 0]);
      expect(layout.xaxis.title.text).toBe('region');
    });

    it('narrows to the selection, and switches to per-cell columns for a small one', async () => {
      component.onKind('heatmap');
      await flush();
      await component.onHeatmapGenes(['Ttr']);
      selection$.next({ mask: Uint8Array.from([1, 0, 1, 0, 0, 0, 0, 0]), count: 2 });
      await flush();
      const { traces } = lastPlot();
      expect(traces[0].type).toBe('heatmap');
      // Two selected cells is far under the per-cell cap, so the columns become
      // the cells themselves — "what is in this region", not a 2-column class
      // matrix.
      expect(traces[0].x).toEqual(['#0', '#2']);
      expect(component.heatmapNote).toContain('per selected cell');
    });

    it('z-scores by default and says so, and can be turned off', async () => {
      component.onKind('heatmap');
      await flush();
      await component.onHeatmapGenes(['Ttr']);
      await flush();
      expect(component.heatmapZScore).toBe(true);
      expect(lastPlot().traces[0].zmin).toBeLessThan(0); // symmetric about zero
      expect(component.heatmapNote).toContain('z-scored');

      component.onHeatmapZScore(false);
      await flush();
      expect(lastPlot().traces[0].zmin).toBeUndefined();
      expect(component.heatmapNote).toContain('Raw means');
    });

    it('asks for genes when it has none, instead of drawing an empty grid', async () => {
      view$.next({ ...view$.value, colorBy: null });
      await flush();
      component.onKind('heatmap');
      await flush();
      expect(component.heatmapGenes).toEqual([]);
      expect(component.heatmapNote).toContain('Pick one or more genes');
    });

    it('fetches each gene once, however often it redraws', async () => {
      component.onKind('heatmap');
      await flush();
      await component.onHeatmapGenes(['Ttr', 'Mbp']);
      await flush();
      const after = (controls.continuousValues as jest.Mock).mock.calls.length;
      // Adding a third gene must not refetch the first two — each is a full
      // per-observation vector.
      await component.onHeatmapGenes(['Ttr', 'Mbp', 'Snap25']);
      await flush();
      expect((controls.continuousValues as jest.Mock).mock.calls.length).toBe(after + 1);
    });

    it('drops genes the new dataset does not have', async () => {
      component.onKind('heatmap');
      await flush();
      await component.onHeatmapGenes(['Ttr', 'Mbp']);
      dataset$.next({ ...dataset, id: 'other', features: { count: 1, names: ['Actb'] } });
      await flush();
      expect(component.heatmapGenes).toEqual([]);
      expect(component.geneOptions.map((o) => o.value)).toEqual(['Actb']);
    });
  });


  /**
   * Sizing the plot to the panel.
   *
   * The panel sits in a dialog the user can drag wider, and Plotly will not
   * follow on its own: `responsive: true` listens for WINDOW resizes only, so a
   * dialog drag reaches it through nothing at all.
   */
  describe('resizing with the panel', () => {
    let callbacks: (() => void)[];
    let observed: Element[];
    let saved: unknown;

    beforeEach(() => {
      callbacks = [];
      observed = [];
      saved = (global as unknown as { ResizeObserver?: unknown }).ResizeObserver;
      (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        constructor(cb: () => void) { callbacks.push(cb); }
        observe(el: Element) { observed.push(el); }
        unobserve() { /* unused by the component */ }
        disconnect() { /* nothing to release in the stub */ }
      };
      (Plotly.relayout as jest.Mock).mockClear();
    });

    afterEach(() => {
      (global as unknown as { ResizeObserver?: unknown }).ResizeObserver = saved;
    });

    /** jsdom runs no layout, so a width has to be stated outright. */
    const setWidth = (px: number) => Object.defineProperty(
      chartHost as HTMLDivElement, 'clientWidth', { value: px, configurable: true },
    );

    /** Fire the observer and let its coalescing frame run. */
    const resizeTo = async (px: number) => {
      setWidth(px);
      callbacks.forEach((cb) => cb());
      await new Promise((r) => setTimeout(r, 40));
    };

    const lastRelayout = () => {
      const calls = (Plotly.relayout as jest.Mock).mock.calls;
      return calls[calls.length - 1]?.[1];
    };

    it('observes the component host, not the plot div', async () => {
      await build(controls);
      // The div lives behind `*ngIf="controls"` and is not in the document when
      // ngAfterViewInit runs, so observing IT installed nothing at all and never
      // retried — the bug that left the plot fixed at its first width.
      expect(observed).toContain(fixture.nativeElement);
      expect(observed).not.toContain(chartHost);
    });

    it('installs the observer even with no controls, when no div is ever drawn', async () => {
      await build(null);
      expect(callbacks).toHaveLength(1);
    });

    it('resizes the WIDTH ONLY where the layout fixed its own height', async () => {
      controls.continuousValues = jest.fn(async (_source: SpatialColorBy) =>
        Float32Array.from([1, 2, 3, 4]));
      controls.categoricalView = jest.fn(async (column: string) => ({
        name: column, categories: ['A', 'B'], colors: ['#f00', '#00f'],
        codes: Uint16Array.from([0, 0, 1, 1]),
      }));
      await build(controls);
      // A categorical subject selects the counts chart on its own.
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'region' } });
      await flush();
      expect(component.kind).toBe('counts');
      // Guard: this test only means something if counts really does fix a height.
      expect(typeof lastPlot().layout?.height).toBe('number');

      await resizeTo(800);
      // Autosizing here would take the height from the container and squash the
      // bars; the height is deliberately one band per bar.
      expect(lastRelayout()).toEqual({ width: 800 });
    });

    it('autosizes where the layout wants the container’s height', async () => {
      controls.continuousValues = jest.fn(async (_source: SpatialColorBy) =>
        Float32Array.from([1, 2, 3, 4]));
      await build(controls);
      component.onKind('histogram');
      await flush();
      // Guard: the distribution kinds must NOT be fixing a height.
      expect(lastPlot().layout?.height).toBeUndefined();

      await resizeTo(800);
      expect(lastRelayout()).toEqual({ autosize: true });
    });

    it('ignores a zero width, so a collapsed panel cannot flatten the plot', async () => {
      await build(controls);
      // Reach a real width FIRST: at the initial 0 the unchanged-width guard
      // would hide a missing zero guard and this would pass for the wrong reason.
      await resizeTo(600);
      (Plotly.relayout as jest.Mock).mockClear();
      await resizeTo(0);
      expect(Plotly.relayout).not.toHaveBeenCalled();
    });

    it('does nothing when the width has not actually changed', async () => {
      await build(controls);
      await resizeTo(600);
      (Plotly.relayout as jest.Mock).mockClear();
      await resizeTo(600);
      expect(Plotly.relayout).not.toHaveBeenCalled();
    });

    it('coalesces a drag’s burst of observations into one frame', async () => {
      await build(controls);
      const raf = jest.spyOn(global, 'requestAnimationFrame');
      setWidth(700);
      // A drag fires these continuously, and each relayout is a full Plotly
      // re-measure. Asserting on the relayout COUNT would prove nothing: the
      // unchanged-width guard collapses repeats on its own. The claim here is
      // that the burst schedules one frame.
      for (let i = 0; i < 20; i++) callbacks.forEach((cb) => cb());
      expect(raf).toHaveBeenCalledTimes(1);
      raf.mockRestore();
      await new Promise((r) => setTimeout(r, 40));
      expect((Plotly.relayout as jest.Mock).mock.calls).toHaveLength(1);
    });
  });

});
