import {
  AfterViewInit, Component, Inject, Input, OnDestroy, OnInit,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';
import * as Plotly from 'plotly.js-dist-min';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialColorBy, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { SpatialSelectionMask, emptySelection } from '../implementations/spatial/spatial-selection';
import {
  OmicsChartKind, OmicsGrouping, benefitsFromGrouping, buildOmicsTraces, omicsLayout,
} from '../implementations/plotly/omics-trace-builders';

/** Plotly config: a static-ish analysis chart, not an editable figure. */
const CHART_CONFIG = {
  displaylogo: false,
  responsive: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
};

/**
 * Distribution charts over the spatial-omics values — histogram, violin, box —
 * **linked to the map**: they chart whatever the map is coloured by, and narrow
 * to the current selection.
 *
 * Embedded INSIDE `<spatial-controls>` rather than owning a dialog of its own:
 * the two are one workflow (change the colour source, watch the distribution
 * move), and splitting them across two floating windows made the link harder to
 * see, not easier. It stays a separate component so the pure trace builders and
 * its own tests keep their boundary.
 *
 * Charting the active colour source rather than offering its own value picker is
 * deliberate: it keeps one source of truth, so what you see on the map and what
 * you see in the chart cannot disagree, and it makes the link legible without
 * explaining it.
 *
 * Depends only on {@link ISpatialControls} through the `VISUALIZER` contract
 * token, like `SpatialControlsComponent`. Trace building lives in the pure
 * `omics-trace-builders`; this component only moves data and owns the div.
 */
@Component({
  selector: 'spatial-charts',
  templateUrl: './spatial-charts.component.html',
  styleUrls: ['./spatial-charts.component.scss'],
})
export class SpatialChartsComponent implements OnInit, AfterViewInit, OnDestroy {
  /**
   * Whether the host panel is on screen. The chart only draws when it is: the
   * enclosing dialog creates and destroys its content, so without this the
   * component would mount with a div present but no state change to trigger a
   * first draw.
   */
  @Input() set active(on: boolean) {
    this.isActive = on;
    if (on) void this.reload();
  }
  get active(): boolean {
    return this.isActive;
  }
  private isActive = true;

  readonly chartDiv = 'spatial-charts-plot';
  readonly kindOptions: { label: string; value: OmicsChartKind }[] = [
    { label: 'Histogram', value: 'histogram' },
    { label: 'Violin', value: 'violin' },
    { label: 'Box', value: 'box' },
  ];

  controls: ISpatialControls | null = null;
  kind: OmicsChartKind = 'histogram';
  /** Categorical column the violin/box splits by; null = one trace for all. */
  groupBy: string | null = null;
  groupOptions: { label: string; value: string | null }[] = [];

  /** What the map is coloured by — the chart's subject. */
  colorBy: SpatialColorBy | null = null;
  selectionCount = 0;
  /** Set when the active colour source cannot be charted, for an inline hint. */
  notice: string | null = null;
  busy = false;

  private view: SpatialViewState = { ...DEFAULT_SPATIAL_VIEW };
  private selection: SpatialSelectionMask = emptySelection();
  private values: Float32Array | null = null;
  private grouping: OmicsGrouping | null = null;
  /** Guards the async value fetch: a fast colour-source change can resolve out
   *  of order, and a stale vector would be charted against the new label. */
  private token = 0;
  /** Whether the first view emission has been handled. */
  private primed = false;
  private resizeObserver?: ResizeObserver;
  private readonly subs = new Subscription();

  constructor(@Inject(VISUALIZER) private readonly viz: IVisualizer) {}

  ngOnInit(): void {
    this.controls = this.viz.getSpatialControls?.() ?? null;
    if (!this.controls) return;

    this.subs.add(combineLatest([
      this.controls.getViewState$(), this.controls.getSelection$(),
    ]).subscribe(([view, selection]) => {
      const sourceChanged = view.colorBy?.kind !== this.view.colorBy?.kind
        || view.colorBy?.name !== this.view.colorBy?.name;
      this.view = view;
      this.colorBy = view.colorBy;
      this.selection = selection;
      this.selectionCount = selection.count;
      // A selection or log change only needs a re-render; a new colour source
      // needs its vector fetched first. The FIRST emission always reloads:
      // otherwise `null -> null` reads as "unchanged" and the component sits
      // with no data and no explanation until something else moves.
      if (!this.primed || sourceChanged) {
        this.primed = true;
        void this.reload();
      } else {
        // A selection or log-scale change needs only a redraw of the same vector.
        void this.render();
      }
    }));

    this.subs.add(this.controls.getDataset$().subscribe(() => {
      this.groupOptions = [
        { label: 'No grouping', value: null },
        ...(this.controls?.categoricalColumns() ?? []).map((n) => ({ label: n, value: n })),
      ];
      // A new dataset's columns are different; a carried-over group is meaningless.
      if (this.groupBy && !this.groupOptions.some((o) => o.value === this.groupBy)) {
        this.groupBy = null;
        this.grouping = null;
      }
    }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.resizeObserver?.disconnect();
    try {
      Plotly.purge(this.chartDiv);
    } catch {
      // The div may already be gone with the dialog; nothing to clean up.
    }
  }

  /** Keep the plot sized to the (resizable) host dialog. */
  ngAfterViewInit(): void {
    const el = document.getElementById(this.chartDiv);
    // ResizeObserver is browser-only; the component must still work where it is
    // absent (jsdom, SSR) — resize tracking is a nicety, drawing is not.
    if (el && !this.resizeObserver && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        try {
          Plotly.relayout(this.chartDiv, { autosize: true });
        } catch {
          // Not plotted yet.
        }
      });
      this.resizeObserver.observe(el);
    }
    // The div exists only now, so this is the earliest a first draw can land.
    void this.reload();
  }

  onKind(kind: OmicsChartKind): void {
    this.kind = kind;
    void this.render();
  }

  async onGroupBy(name: string | null): Promise<void> {
    this.groupBy = name;
    if (!name || !this.controls) {
      this.grouping = null;
      void this.render();
      return;
    }
    try {
      const view = await this.controls.categoricalView(name);
      this.grouping = { codes: view.codes, categories: view.categories, colors: view.colors };
    } catch {
      this.grouping = null;
      this.groupBy = null;
    }
    void this.render();
  }

  /** True when the current kind would read better with a grouping chosen. */
  get suggestsGrouping(): boolean {
    return benefitsFromGrouping(this.kind) && !this.groupBy && this.groupOptions.length > 1;
  }

  get subject(): string {
    if (!this.colorBy) return '';
    return this.colorBy.kind === 'feature' ? `gene ${this.colorBy.name}` : this.colorBy.name;
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Fetch the active colour source's vector, then draw. */
  private async reload(): Promise<void> {
    const controls = this.controls;
    const source = this.view.colorBy;
    const mine = ++this.token;
    if (!controls || !source) {
      this.values = null;
      this.notice = controls
        ? 'Colour the map by a continuous column or a gene to chart it.'
        : null;
      void this.render();
      return;
    }
    this.busy = true;
    try {
      const values = await controls.continuousValues(source);
      if (mine !== this.token) return; // superseded
      this.values = values;
      this.notice = null;
    } catch {
      if (mine !== this.token) return;
      this.values = null;
      // The common case: the map is coloured by a categorical column.
      this.notice = `"${source.name}" is categorical — it has no distribution. `
        + 'Colour by a continuous column or a gene, or group a violin by it.';
    } finally {
      if (mine === this.token) this.busy = false;
    }
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.isActive) return;
    const el = document.getElementById(this.chartDiv);
    if (!el) return;
    if (!this.values || !this.colorBy) {
      try {
        Plotly.purge(this.chartDiv);
      } catch { /* nothing plotted */ }
      return;
    }
    const input = {
      values: this.values,
      name: this.colorBy.kind === 'feature' ? this.colorBy.name : this.colorBy.name,
      group: benefitsFromGrouping(this.kind) ? this.grouping : null,
      selection: this.selection.count > 0 ? this.selection.mask : null,
      log: this.view.logScale,
    };
    const traces = buildOmicsTraces(this.kind, input);
    await Plotly.react(this.chartDiv, traces as never, omicsLayout(this.kind, input) as never,
      CHART_CONFIG as never);
  }
}
