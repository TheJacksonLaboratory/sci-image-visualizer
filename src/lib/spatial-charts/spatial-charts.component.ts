import {
  AfterViewInit, Component, Inject, Input, OnDestroy, OnInit,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';
import * as Plotly from 'plotly.js-dist-min';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialColorBy, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import {
  SpatialSelectionMask, emptySelection, maskToIndices,
} from '../spatial/spatial-selection';
import { cellsAsGroups, heatmapMatrix } from '../spatial/spatial-heatmap';
import {
  OmicsChartKind, OmicsGrouping, benefitsFromGrouping, buildCountTraces, buildHeatmapTraces,
  buildOmicsTraces, countsLayout, heatmapLayout, omicsLayout,
} from '../implementations/plotly/omics-trace-builders';

/** Per-instance chart-div id source — see {@link SpatialChartsComponent.chartDiv}. */
let chartInstanceSeq = 0;

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
    const was = this.isActive;
    this.isActive = on;
    // Deferred by a task: when a collapsed section expands, the host is still
    // `hidden` at the moment this setter runs, so plotting now would size the
    // chart to a zero-height div.
    if (on && !was) setTimeout(() => void this.reload(), 0);
    else if (on) void this.reload();
  }
  get active(): boolean {
    return this.isActive;
  }
  private isActive = true;

  /** Per-instance, for the same reason the visualizer's plot div is
   *  (`visualizer.component.ts`): two mounted charts sharing one DOM id means
   *  `getElementById` hands both of them the first element, so one instance draws
   *  into — or purges — the other's canvas. */
  readonly chartDiv = `spatial-charts-plot-${++chartInstanceSeq}`;
  private static readonly CONTINUOUS_KINDS: { label: string; value: OmicsChartKind }[] = [
    { label: 'Histogram', value: 'histogram' },
    { label: 'Violin', value: 'violin' },
    { label: 'Box', value: 'box' },
  ];
  private static readonly CATEGORICAL_KINDS: { label: string; value: OmicsChartKind }[] = [
    { label: 'Counts', value: 'counts' },
  ];

  /** Available whatever the map is coloured by: the heatmap's subject is a GENE
   *  LIST crossed with a grouping, not the active colour source. */
  private static readonly ALWAYS_KINDS: { label: string; value: OmicsChartKind }[] = [
    { label: 'Heatmap', value: 'heatmap' },
  ];

  /** The kinds the ACTIVE subject can be drawn as. A category code is a label,
   *  not a magnitude, so a histogram of it would be meaningless — what a
   *  categorical column has is a frequency distribution. */
  get kindOptions(): { label: string; value: OmicsChartKind }[] {
    return [
      ...(this.categorical
        ? SpatialChartsComponent.CATEGORICAL_KINDS
        : SpatialChartsComponent.CONTINUOUS_KINDS),
      ...SpatialChartsComponent.ALWAYS_KINDS,
    ];
  }

  controls: ISpatialControls | null = null;
  kind: OmicsChartKind = 'histogram';
  /**
   * Genes the heatmap's rows are, and the vectors behind them.
   *
   * Local rather than in `SpatialViewState`, matching how the chart KIND is
   * held: this is what the panel is charting, not what the map is drawing, and
   * the renderer has no use for it.
   */
  heatmapGenes: string[] = [];
  /** Z-score each gene across the groups. On by default: without it one loud
   *  gene saturates the scale and the rest of the panel reads as blank. */
  heatmapZScore = true;
  /** Past this many selected cells the per-cell view is a texture, not a
   *  readable panel, so the columns go back to being classes. */
  private static readonly HEATMAP_CELL_COLUMNS = 200;
  /**
   * Column cap for the grouped heatmap.
   *
   * Any categorical column can be the x axis, and they are not the same size:
   * `neurotransmitter` has 9 categories, `class` 34, `subclass` 338. At 338 the
   * panel is a texture — columns a couple of pixels wide, no readable label —
   * so past this many the strongest columns are kept and the note says how many
   * were dropped. See `maxCols` in `spatial-heatmap.ts`.
   */
  private static readonly HEATMAP_MAX_COLUMNS = 40;
  /** Columns the cap dropped from the last render, for the note. */
  private heatmapHidden = 0;
  geneOptions: { label: string; value: string }[] = [];
  /** Fetched vectors by gene name, so adding a fourth gene does not refetch the
   *  first three — each is a full per-observation Float32Array. */
  private readonly geneCache = new Map<string, Float32Array>();
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
  /** Set instead of `values` when the colour source is a categorical column: its
   *  distribution is counts per category, not a histogram of its codes. */
  private categorical: OmicsGrouping | null = null;
  private grouping: OmicsGrouping | null = null;
  /** Guards the async value fetch: a fast colour-source change can resolve out
   *  of order, and a stale vector would be charted against the new label. */
  private token = 0;
  /** The same guard for the grouping fetch, which the user can change as fast. */
  private groupToken = 0;
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

    this.subs.add(this.controls.getDataset$().subscribe((dataset) => {
      this.groupOptions = [
        { label: 'No grouping', value: null },
        ...(this.controls?.categoricalColumns() ?? []).map((n) => ({ label: n, value: n })),
      ];
      // A new dataset's columns are different; a carried-over group is meaningless.
      if (this.groupBy && !this.groupOptions.some((o) => o.value === this.groupBy)) {
        this.groupBy = null;
        this.grouping = null;
      }
      // The heatmap's rows come from the dataset's gene list. A dataset too wide
      // to inline its names offers none here — the panel's typeahead is the way
      // in for those, and the heatmap needs names it can list.
      this.geneOptions = (dataset?.features?.names ?? []).map((n) => ({ label: n, value: n }));
      const known = new Set(this.geneOptions.map((o) => o.value));
      this.heatmapGenes = this.heatmapGenes.filter((n) => known.has(n));
      this.geneCache.clear();
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
    if (kind === 'heatmap') {
      // Seed with the gene already on screen, so the chart says something the
      // moment it opens rather than showing an empty grid and a prompt.
      if (this.heatmapGenes.length === 0 && this.colorBy?.kind === 'feature') {
        this.heatmapGenes = [this.colorBy.name];
      }
      void (async () => {
        await this.ensureHeatmapGrouping();
        await this.loadHeatmapGenes();
        void this.render();
      })();
      return;
    }
    void this.render();
  }

  /**
   * The grouping the heatmap's columns come from, defaulting rather than
   * demanding one: a heatmap with no columns is not a chart, and "No grouping"
   * is a sensible answer for a violin but not for this.
   */
  private async ensureHeatmapGrouping(): Promise<void> {
    if (this.grouping || !this.controls) return;
    const first = this.groupOptions.find((o) => o.value)?.value;
    if (!first) return;
    await this.onGroupBy(first);
  }

  onHeatmapZScore(on: boolean): void {
    this.heatmapZScore = on;
    void this.render();
  }

  /** What the heatmap is currently showing, said plainly. */
  get heatmapNote(): string {
    if (this.heatmapGenes.length === 0) return 'Pick one or more genes for the rows.';
    const perCell = this.selectionCount > 0
      && this.selectionCount <= SpatialChartsComponent.HEATMAP_CELL_COLUMNS;
    if (perCell) {
      return `One column per selected cell (${this.selectionCount}). `
        + 'Mean expression per cell, so the columns are cells rather than classes.';
    }
    const scope = this.selectionCount > 0 ? 'the selected cells' : 'all cells';
    const scaled = this.heatmapZScore
      ? ' Each gene is z-scored across the columns, so the colour is above or below that gene\'s own average.'
      : ' Raw means, so a highly-expressed gene dominates the scale.';
    // Saying so matters: without it the panel looks like the whole column.
    const capped = this.heatmapHidden > 0
      ? ` Showing the ${SpatialChartsComponent.HEATMAP_MAX_COLUMNS} strongest of `
        + `${SpatialChartsComponent.HEATMAP_MAX_COLUMNS + this.heatmapHidden}, `
        + 'ranked by the largest value any picked gene reaches.'
      : '';
    return `Mean expression of each gene within each ${this.groupBy ?? 'group'}, over ${scope}.`
      + `${scaled}${capped}`;
  }

  /** Gene rows for the heatmap. */
  async onHeatmapGenes(names: string[]): Promise<void> {
    this.heatmapGenes = names ?? [];
    await this.loadHeatmapGenes();
    void this.render();
  }

  /**
   * Fetch any gene the heatmap needs and does not already hold.
   *
   * Sequenced on the same token the colour-source load uses: each vector is a
   * separate request, and a slower one must not paint rows for a gene list the
   * user has already moved on from.
   */
  private async loadHeatmapGenes(): Promise<void> {
    const controls = this.controls;
    if (!controls) return;
    const missing = this.heatmapGenes.filter((n) => !this.geneCache.has(n));
    if (missing.length === 0) return;
    const mine = ++this.token;
    this.busy = true;
    try {
      for (const name of missing) {
        const values = await controls.continuousValues({ kind: 'feature', name });
        if (mine !== this.token) return;
        this.geneCache.set(name, values);
      }
      this.notice = null;
    } catch (err) {
      if (mine !== this.token) return;
      this.notice = `A gene could not be charted: ${(err as Error)?.message ?? err}`;
    } finally {
      if (mine === this.token) this.busy = false;
    }
  }

  async onGroupBy(name: string | null): Promise<void> {
    this.groupBy = name;
    if (!name || !this.controls) {
      this.grouping = null;
      void this.render();
      return;
    }
    // Sequenced: pick A then B and a slower A would otherwise land last, charting
    // A's categories under a dropdown that says B.
    const mine = ++this.groupToken;
    try {
      const view = await this.controls.categoricalView(name);
      if (mine !== this.groupToken) return;
      this.grouping = { codes: view.codes, categories: view.categories, colors: view.colors };
    } catch {
      if (mine !== this.groupToken) return;
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
      this.categorical = null;
      this.notice = controls
        ? 'Colour the map by a column or a gene to chart its distribution.'
        : null;
      void this.render();
      return;
    }
    this.busy = true;
    // A categorical column charts as COUNTS per category — asked for by name
    // rather than discovered by catching the continuous fetch's error, so a
    // genuine failure still reads as a failure.
    const isCategorical = source.kind === 'column'
      && (controls.categoricalColumns() ?? []).includes(source.name);
    try {
      if (isCategorical) {
        const view = await controls.categoricalView(source.name);
        if (mine !== this.token) return; // superseded
        this.categorical = { codes: view.codes, categories: view.categories, colors: view.colors };
        this.values = null;
        this.kind = 'counts';
        this.notice = null;
      } else {
        const values = await controls.continuousValues(source);
        if (mine !== this.token) return;
        this.values = values;
        this.categorical = null;
        if (this.kind === 'counts') this.kind = 'histogram';
        this.notice = null;
      }
    } catch (err) {
      if (mine !== this.token) return;
      this.values = null;
      this.categorical = null;
      this.notice = `"${source.name}" could not be charted: ${(err as Error)?.message ?? err}`;
    } finally {
      if (mine === this.token) this.busy = false;
    }
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.isActive) return;
    const el = document.getElementById(this.chartDiv);
    if (!el) return;
    // The heatmap answers a different question from the other kinds — which
    // genes distinguish which groups — so it is driven by its own gene list and
    // grouping rather than by whatever the map is coloured by.
    if (this.kind === 'heatmap') {
      await this.renderHeatmap();
      return;
    }
    if (!this.colorBy || (!this.values && !this.categorical)) {
      try {
        Plotly.purge(this.chartDiv);
      } catch { /* nothing plotted */ }
      return;
    }
    if (this.categorical) {
      const counts = {
        group: this.categorical,
        selection: this.selection.count > 0 ? this.selection.mask : null,
        name: this.colorBy.name,
      };
      await Plotly.react(this.chartDiv, buildCountTraces(counts) as never,
        countsLayout(counts) as never, CHART_CONFIG as never);
      return;
    }
    if (!this.values) return;
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

  /**
   * Genes × groups mean expression.
   *
   * Columns are the grouping column's categories — or, inside a SMALL
   * selection, the selected cells themselves. A two-column class matrix is a
   * poor answer for an ROI holding forty cells; "what is in front of me" is the
   * question there, and each cell earns a column.
   */
  private async renderHeatmap(): Promise<void> {
    const controls = this.controls;
    const genes = this.heatmapGenes
      .map((name) => ({ name, values: this.geneCache.get(name) }))
      .filter((g): g is { name: string; values: Float32Array } => !!g.values);
    if (!controls || genes.length === 0 || !this.grouping) {
      try {
        Plotly.purge(this.chartDiv);
      } catch { /* nothing plotted */ }
      return;
    }

    const selected = this.selection.count > 0 ? maskToIndices(this.selection.mask) : null;
    const perCell = !!selected && selected.length <= SpatialChartsComponent.HEATMAP_CELL_COLUMNS;
    const cells = perCell && selected
      ? cellsAsGroups(selected, this.grouping.codes.length,
        SpatialChartsComponent.HEATMAP_CELL_COLUMNS)
      : null;

    const matrix = heatmapMatrix(
      genes,
      cells ? cells.groups : { codes: this.grouping.codes, categories: this.grouping.categories },
      {
        ...(cells ? { indices: cells.indices, minCells: 1 } : {}),
        // Outside the per-cell view a selection still narrows the means, the way
        // the violin and box narrow rather than overlay.
        ...(!cells && selected ? { indices: selected } : {}),
        // Only the grouped view: `cellsAsGroups` already caps by even thinning,
        // and re-ranking those columns would lose the selection's spread.
        ...(cells ? {} : { maxCols: SpatialChartsComponent.HEATMAP_MAX_COLUMNS }),
        zScore: this.heatmapZScore,
      },
    );
    if (!matrix) {
      try {
        Plotly.purge(this.chartDiv);
      } catch { /* nothing plotted */ }
      this.notice = 'No group has enough measured cells for a mean.';
      return;
    }
    this.notice = null;
    this.heatmapHidden = matrix.hiddenCols;
    const input = {
      rows: matrix.rows,
      cols: matrix.cols,
      values: matrix.values,
      counts: matrix.counts,
      zScored: this.heatmapZScore,
      groupLabel: cells ? 'selected cells' : (this.groupBy ?? ''),
    };
    await Plotly.react(this.chartDiv, buildHeatmapTraces(input) as never,
      heatmapLayout(input) as never, CHART_CONFIG as never);
  }
}
