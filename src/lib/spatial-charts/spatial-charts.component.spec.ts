import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { SpatialChartsComponent } from './spatial-charts.component';
import { VISUALIZER, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../contracts/display-types';
import { SpatialSelectionMask, emptySelection } from '../implementations/spatial/spatial-selection';

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
  features: { count: 1, names: ['Ttr'] },
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
      expect(component.kindOptions.map((k) => k.value)).toEqual(['counts']);
    });

    it('returns to a histogram when the source goes back to continuous', async () => {
      view$.next({ ...view$.value, colorBy: { kind: 'column', name: 'total_counts' } });
      await flush();
      expect(component.kind).toBe('histogram');
      expect(component.kindOptions.map((k) => k.value)).toEqual(['histogram', 'violin', 'box']);
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
});
