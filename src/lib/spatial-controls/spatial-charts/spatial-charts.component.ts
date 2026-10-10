import {
  AfterViewInit, Component, Inject, Input, OnDestroy, OnInit,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../../contracts/visualizer.contract';
import { SpatialEmbeddingMeta } from '../../contracts/spatial-dataset.contract';
import { SpatialColorBy, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../../contracts/display-types';
import {
  SpatialSelectionMask, emptySelection, maskToIndices,
} from '../../spatial/spatial-selection';
import { HeatmapMatrix, cellsAsGroups } from '../../spatial/spatial-heatmap';
import { computeHeatmapMatrixAsync } from '../../workers/spatial-math';
import { Supersede } from '../../util/supersede';
import {
  BROWSER_TSNE_MAX_OBSERVATIONS, EmbeddingComputeCoordinator, EmbeddingComputeState,
} from '../../spatial/embedding-compute-coordinator';
import { ChartDataModel } from './chart-data-model';
import { EMBEDDING_CONFIG, PlotlyChartHost } from './plotly-chart-host';
import { ChartKindOption, chartKindOptions, embeddingNote, heatmapNote, kindHelp } from './chart-help';
import {
  OmicsChartKind, benefitsFromGrouping, buildCountTraces, buildHeatmapTraces,
  countByCategory,
  buildOmicsTraces, buildEmbeddingTraces, countsLayout, heatmapLayout, omicsLayout, embeddingLayout,
} from '../../implementations/plotly/omics-trace-builders';

/**
 * Widen the help tooltip, once per document.
 *
 * PrimeNG caps `.p-tooltip` at 12.5rem and appends it to `<body>`, so a component
 * stylesheet cannot reach it — the same reason the detached dialog is sized inline. At
 * 200 px the chart explanations render as a tall thread of two-word lines, which is worse
 * than not showing them. The library ships no global stylesheet to put this in, so one
 * rule is injected instead: scoped to this component's own tooltip class, idempotent, and
 * skipped where there is no document.
 */
const HELP_TIP_STYLE_ID = 'sx-help-tip-style';
function ensureHelpTipStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(HELP_TIP_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HELP_TIP_STYLE_ID;
  style.textContent = '.sx-help-tip .p-tooltip-text { max-width: none; width: 24rem; '
    + 'line-height: 1.45; }\n.sx-help-tip { max-width: none; }';
  document.head.appendChild(style);
}

/** Per-instance chart-div id source — see {@link SpatialChartsComponent.chartDiv}. */
let chartInstanceSeq = 0;


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

  /** One increment per INSTANCE — a static initializer would run once per class and
   *  hand every instance the same id, which is the bug this id exists to avoid. Declared
   *  before the ids because field initializers run in order. */
  private readonly seq = ++chartInstanceSeq;
  /** Per-instance, for the same reason the visualizer's plot div is
   *  (`visualizer.component.ts`): two mounted charts sharing one DOM id means
   *  `getElementById` hands both of them the first element, so one instance draws
   *  into — or purges — the other's canvas. */
  readonly chartDiv = `spatial-charts-plot-${this.seq}`;
  /**
   * The div inside the detached window.
   *
   * A separate id rather than moving the existing div: Angular destroys and recreates a
   * div across an `*ngIf`, so Plotly would be left holding a detached node. Two divs and
   * a redraw is both simpler and correct.
   *
   * ONE is enough for every kind, because only the active kind is ever plotted. Detaching
   * is remembered per kind, but at most one window is open at a time.
   */
  readonly detachedDiv = `spatial-charts-detached-${this.seq}`;

  /**
   * Whether the chart is shown in its own window rather than inline.
   *
   * Detached, it sits ALONGSIDE the spatial-omics dialog instead of inside it — which is
   * the point: these are read against the map, not instead of it. The dialog is only so
   * wide.
   *
   * One flag for the PANEL, not one per kind. Where the window is, is a property of the
   * workspace someone has arranged, not of the tab they happen to be on: having put the
   * charts beside the map, switching from the heatmap to the counts should swap what the
   * window shows, not yank it back into the dialog and make them detach it again.
   */
  detached = false;
  /**
   * Largest dataset this will offer to embed in the browser — see
   * {@link BROWSER_TSNE_MAX_OBSERVATIONS}.
   */
  static readonly BROWSER_TSNE_MAX_OBSERVATIONS = BROWSER_TSNE_MAX_OBSERVATIONS;

  /** The t-SNE computed in this browser: what to offer, the run, its progress, its results. */
  private readonly compute = new EmbeddingComputeCoordinator();

  /** 0..1 while running, or null before the first report. Drives the progress bar. */
  get computeFraction(): number | null {
    return this.compute.state.fraction;
  }
  /** Which backend the worker got — 'webgpu', 'wasm' or 'cpu'. Shown while running. */
  get computeBackend(): string | null {
    return this.compute.state.backend;
  }
  get computeMessage(): string | null {
    return this.compute.state.message;
  }
  get computeError(): string | null {
    return this.compute.state.error;
  }
  /** Where a computation stands, for the embedding controls. */
  get computeState(): EmbeddingComputeState {
    return this.compute.state;
  }
  /** True when a t-SNE is missing but the dataset is too big to embed here. */
  get tsneTooLarge(): boolean {
    return this.compute.tooLarge;
  }

  /** The kinds the ACTIVE subject can be drawn as. A category code is a label,
   *  not a magnitude, so a histogram of it would be meaningless — what a
   *  categorical column has is a frequency distribution.
   *
   *  Bound to a `p-selectButton`, so the SAME array is returned until what it is built
   *  from changes: a fresh array per change-detection pass makes PrimeNG re-render the
   *  buttons, and a button re-rendered under the pointer swallows the click. */
  get kindOptions(): ChartKindOption[] {
    const categorical = this.data.isCategorical;
    const embeddings = this.embeddings.length > 0;
    const hit = this.kindOptionsMemo;
    if (hit && hit.categorical === categorical && hit.embeddings === embeddings) {
      return hit.options;
    }
    const options = chartKindOptions(categorical, embeddings);
    this.kindOptionsMemo = { categorical, embeddings, options };
    return options;
  }
  private kindOptionsMemo: {
    categorical: boolean; embeddings: boolean; options: ChartKindOption[];
  } | null = null;

  controls: ISpatialControls | null = null;
  kind: OmicsChartKind = 'histogram';
  /** The data charted, and its loading — see {@link ChartDataModel}. */
  private readonly data = new ChartDataModel();

  /** Embeddings the dataset offers, and which of them is drawn. */
  get embeddings(): SpatialEmbeddingMeta[] {
    return this.data.embeddings;
  }
  get embedding(): SpatialEmbeddingMeta | null {
    return this.data.embedding;
  }
  /** Genes the heatmap's rows are. */
  get heatmapGenes(): string[] {
    return this.data.heatmapGenes;
  }
  /** The heatmap gene picker's options. */
  get geneOptions(): { label: string; value: string }[] {
    return this.data.geneOptions;
  }
  /** Categorical column the violin/box splits by; null = one trace for all. */
  get groupBy(): string | null {
    return this.data.groupBy;
  }
  get groupOptions(): { label: string; value: string | null }[] {
    return this.data.groupOptions;
  }
  /** Set when the active colour source cannot be charted, for an inline hint. */
  get notice(): string | null {
    return this.data.notice;
  }
  set notice(text: string | null) {
    this.data.notice = text;
  }
  /** A load is in flight. */
  get busy(): boolean {
    return this.data.busy;
  }
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

  /** What the map is coloured by — the chart's subject. */
  colorBy: SpatialColorBy | null = null;
  selectionCount = 0;

  private view: SpatialViewState = { ...DEFAULT_SPATIAL_VIEW };
  private selection: SpatialSelectionMask = emptySelection();
  /** Whether the first view emission has been handled. */
  private primed = false;
  private readonly subs = new Subscription();

  constructor(@Inject(VISUALIZER) private readonly viz: IVisualizer) {}

  ngOnInit(): void {
    // Before the port check: the help icon is in the template either way, and a panel
    // with no data source is exactly where someone reads it.
    ensureHelpTipStyle();
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
      // Offer to compute a t-SNE only where the dataset has PCA to embed and no t-SNE of
      // its own; anything computed or computing for the previous dataset is dropped.
      const embeddings = this.compute.setDataset(dataset?.embeddings ?? [], dataset?.observations.count ?? 0);
      const switched = this.data.onDatasetChanged(dataset, this.controls?.categoricalColumns() ?? [], embeddings);
      // Nothing to draw for the kind that was selected; fall back rather than sit blank.
      if (this.kind === 'embedding' && embeddings.length === 0) this.kind = 'histogram';
      // Everything loaded was the previous dataset's: fetch afresh, even when the view
      // does not re-emit (a colour source of the same name).
      if (switched) {
        if (this.groupBy) void this.onGroupBy(this.groupBy);
        void this.reload();
      }
    }));
  }

  /** Latest wins among heatmap draws, whose matrix may be computed in a worker. */
  private readonly heatmapRender = new Supersede();

  /** Plotly I/O for both the inline and the detached div. */
  private readonly plot = new PlotlyChartHost();

  /**
   * Re-fit the plot to the panel's current width.
   *
   * Called by the host when the dialog finishes resizing. Plotly does not notice
   * a container resize on its own — its `responsive` option listens for WINDOW
   * resizes only, so dragging a dialog edge reaches it through nothing at all.
   */
  resize(): void {
    this.plot.refit(this.chartDiv);
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    // A worker outlives the component that started it: closing the panel mid-run would
    // otherwise leave a t-SNE saturating a GPU for minutes with nothing left to receive
    // the answer.
    this.compute.abandon();
    this.heatmapRender.cancel();
    // BOTH divs: a chart left detached at teardown holds its WebGL context in the
    // window's div, which the inline id would never reach.
    for (const div of [this.chartDiv, this.detachedDiv]) this.plot.purge(div);
  }

  ngAfterViewInit(): void {
    // The div exists only now, so this is the earliest a first draw can land.
    void this.reload();
  }

  onKind(kind: OmicsChartKind): void {
    this.kind = kind;
    if (kind === 'heatmap') {
      // Seed with the gene already on screen, so the chart says something the
      // moment it opens rather than showing an empty grid and a prompt.
      if (this.heatmapGenes.length === 0 && this.colorBy?.kind === 'feature') {
        this.data.setHeatmapGenes([this.colorBy.name]);
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
    if (this.data.hasGrouping || !this.controls) return;
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
    return heatmapNote({
      geneCount: this.heatmapGenes.length,
      selectionCount: this.selectionCount,
      zScore: this.heatmapZScore,
      hidden: this.heatmapHidden,
      groupBy: this.groupBy,
      maxColumns: SpatialChartsComponent.HEATMAP_MAX_COLUMNS,
      cellColumns: SpatialChartsComponent.HEATMAP_CELL_COLUMNS,
    });
  }

  /** Gene rows for the heatmap. */
  async onHeatmapGenes(names: string[]): Promise<void> {
    this.data.setHeatmapGenes(names);
    await this.loadHeatmapGenes();
    void this.render();
  }

  /** Fetch any gene the heatmap needs and does not already hold. */
  private loadHeatmapGenes(): Promise<void> {
    return this.data.loadHeatmapGenes(this.controls);
  }

  async onGroupBy(name: string | null): Promise<void> {
    if (await this.data.loadGrouping(this.controls, name)) void this.render();
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
    const loaded = await this.data.loadValues(this.controls, this.view.colorBy);
    if (loaded === 'superseded') return;
    // Only off the distribution tabs. The heatmap does not chart the colour source, and the
    // embedding is coloured BY it — its own caption asks for exactly this.
    if (loaded === 'categorical' && this.kind !== 'embedding' && this.kind !== 'heatmap') this.kind = 'counts';
    if (loaded === 'continuous' && this.kind === 'counts') this.kind = 'histogram';
    void this.render();
  }

  /**
   * The embedding scatter — a UMAP over the same observations.
   *
   * Answers what the map cannot: the map says WHERE a population sits, this says which
   * populations there are and how close they are in expression.
   *
   * Linked to the map without asking for anything: it reuses the loaded categories, the same
   * loaded colouring the counts chart draws from, so the two cannot disagree about what a
   * colour means and no second fetch happens. A selection dims the rest rather than
   * dropping it — the embedding's shape is the context that makes a selection legible.
   */
  private async renderEmbedding(): Promise<void> {
    const controls = this.controls;
    const meta = this.embedding;
    if (!controls || !meta) {
      this.purgePlot();
      return;
    }
    if (!controls.getEmbedding) {
      this.notice = 'This data source does not serve embeddings.';
      this.purgePlot();
      return;
    }

    // Computed here, not served: a local result is the same shape as a fetched one, so
    // everything downstream — colouring, lasso selection, the camera — is unchanged.
    const local = this.compute.result(meta.name);
    if (local) {
      this.data.supersedeEmbeddingLoad();
      this.data.embeddingCoords = local;
    } else if (this.isComputable) {
      // Offered but not yet computed. The panel shows the Compute button; drawing nothing
      // is right, and an error would be wrong — there is no failure here.
      this.data.supersedeEmbeddingLoad();
      this.purgePlot();
      this.notice = null;
      return;
    } else {
      const loaded = await this.data.loadEmbedding((name) => controls.getEmbedding!(name), meta);
      if (loaded === 'superseded') return;
      if (loaded === 'failed') {
        this.purgePlot();
        return;
      }
    }
    const { embeddingCoords: coords, categorical } = this.data.snapshot();
    if (!coords) return;

    const target = this.plotTarget;
    if (!document.getElementById(target)) return; // the window is closed, or not rendered yet
    const view = this.plot.liveView(target);

    this.notice = null;
    const input = {
      x: coords.x,
      y: coords.y,
      // The third dimension when the embedding has one — what switches the plot to a
      // rotatable 3D scatter. Decoded only for a 3-dim embedding, so its presence here
      // is the same question as `meta.dims === 3`.
      ...(coords.z ? { z: coords.z } : {}),
      label: meta.label ?? meta.name,
      derived: meta.derived,
      // Present for a PCA, absent for a UMAP — see `varianceRatio` on the meta.
      ...(meta.varianceRatio ? { varianceRatio: meta.varianceRatio } : {}),
      ...(categorical
        ? { categories: { codes: categorical.codes, names: categorical.categories, colors: categorical.colors } }
        : {}),
      ...(this.selection.count > 0 ? { selection: this.selection.mask } : {}),
      // Whatever view the user has set up, read from the LIVE plot — which is where
      // rotating and zooming leave it.
      ...(view ? { view } : {}),
    };
    await this.plot.draw(target, buildEmbeddingTraces(input), embeddingLayout(input), EMBEDDING_CONFIG);
    // Draw round a cluster here and those cells light up on the tissue: every view reads
    // the same mask.
    this.plot.bindSelection(target, {
      selected: (indices) => this.controls?.selectIndices(indices),
      deselected: () => this.controls?.clearSelection(),
    });
  }


  /**
   * Whether the plot on screen fixed its own height.
   *
   * The counts and heatmap layouts size themselves to their row count, so in the detached
   * window they can be TALLER than the window — which has to scroll rather than clip. An
   * embedding fixes no height and fills the window instead. The template needs to know
   * which, because the two want opposite `flex` and `overflow`.
   */
  get hasFixedHeight(): boolean {
    return this.plot.hasFixedHeight;
  }

  /** Where the active kind draws: its own window, or the shared chart div. */
  get plotTarget(): string {
    return this.detached ? this.detachedDiv : this.chartDiv;
  }

  /**
   * Header for the detached window — what it is showing, named as its tab is.
   *
   * The embedding names the embedding rather than the tab, because "Embedding" beside a
   * window drawing a t-SNE says less than "t-SNE" does.
   */
  get detachedTitle(): string {
    if (this.kind === 'embedding') {
      return this.embedding?.label ?? this.embedding?.name ?? 'Embedding';
    }
    const label = this.kindOptions.find((k) => k.value === this.kind)?.label ?? 'Chart';
    return this.subject ? `${label} · ${this.subject}` : label;
  }

  /**
   * Move the active kind between its own window and the panel.
   *
   * Purges the div it is LEAVING first. Plotly keeps per-div state, and a graph left
   * behind in a div that Angular then removes leaks its WebGL context — and if the div
   * comes back, react would resize a plot whose data belongs to the other place.
   */
  toggleDetached(): void {
    const leaving = this.plotTarget;
    this.detached = !this.detached;
    this.plot.purge(leaving);
    // Going back INLINE, the div appears with the next change detection, so a task is
    // enough. Going OUT, the window's div does not exist yet — PrimeNG mounts the dialog
    // with a transition — so the dialog's own `onShow` drives that draw instead. A single
    // deferred attempt drew nothing and never retried.
    if (!this.detached) setTimeout(() => void this.render(), 0);
  }

  /** The detached window is up and its div exists — now the plot can be drawn into it. */
  onDetachedWindowShown(): void {
    void this.render();
  }

  /** Re-fit the detached window's plot after it is resized. */
  onDetachedResizeEnd(): void {
    this.plot.refit(this.detachedDiv);
  }

  /** The gene picker's filter box changed: search the resident names, show the best. */
  onGeneFilter(query: string): void {
    this.data.filterGenes(query);
  }

  /** Roughly how long a run will take, in seconds, from the measured anchor. */
  get computeEstimateSeconds(): number {
    return this.compute.estimateSeconds;
  }

  /** That estimate as something to put on a button. */
  get computeEstimateLabel(): string {
    return this.compute.estimateLabel;
  }

  /** Why the option is absent, when a dataset is past the threshold. */
  get tsneTooLargeNote(): string {
    return this.compute.tooLargeNote;
  }

  /** Whether the selected embedding is one this browser would have to compute. */
  get isComputable(): boolean {
    return this.compute.isComputable(this.embedding);
  }

  /** Whether it has already been computed in this session. */
  get isComputed(): boolean {
    return this.compute.isComputed(this.embedding);
  }

  get isComputing(): boolean {
    return this.compute.running;
  }

  /** Compute the selected embedding here, in a worker, then draw it. */
  async computeEmbedding(): Promise<void> {
    const meta = this.embedding;
    const controls = this.controls;
    if (!meta || !controls?.getEmbedding || this.isComputing) return;
    const result = await this.compute.start(meta, this.embeddings, (name) => controls.getEmbedding!(name));
    if (!result) return;
    this.data.embeddingCoords = result;
    await this.render();
  }

  /** Stop a run. It settles shortly after, leaving no embedding. */
  cancelCompute(): void {
    this.compute.cancel();
  }

  /** Which embedding to draw, when the dataset publishes more than one. */
  onEmbedding(name: string): void {
    if (this.data.selectEmbedding(name)) void this.render();
  }

  /** What the chart on screen shows, and what it cannot be read for — see {@link kindHelp}. */
  get kindHelp(): string {
    return kindHelp(this.kind, this.embedding);
  }

  /** What the embedding view is showing, said plainly. */
  get embeddingNote(): string {
    return embeddingNote(
      this.data.embeddingCoords?.meta ?? this.embedding, this.data.isCategorical, this.selection.count,
    );
  }

  /** Purge the ACTIVE target: purging the inline div while detached would leave the window
   *  showing a plot the component believes it has cleared. */
  private purgePlot(): void {
    this.plot.purge(this.plotTarget);
  }

  /** Draw into the active target. */
  private draw(traces: unknown, layout: unknown): Promise<void> {
    return this.plot.draw(this.plotTarget, traces, layout);
  }

  private async render(): Promise<void> {
    if (!this.isActive) return;
    // Guard on the div the ACTIVE kind will draw into, not always the shared one. While a
    // kind is detached the inline div is removed by its `*ngIf`, so checking that one
    // bailed here and the detached window never got a plot.
    const target = this.plotTarget;
    if (!document.getElementById(target)) return;
    // Anything but the embedding inherits a div the embedding may have bound handlers on.
    if (this.kind !== 'embedding') this.plot.unbindSelection(target);
    // A heatmap still computing must not draw over the kind that replaced it.
    if (this.kind !== 'heatmap') this.heatmapRender.cancel();
    // The heatmap answers a different question from the other kinds — which
    // genes distinguish which groups — so it is driven by its own gene list and
    // grouping rather than by whatever the map is coloured by.
    if (this.kind === 'heatmap') {
      await this.renderHeatmap();
      return;
    }
    // Also independent of the active colour source: the coordinates are the dataset's,
    // and the colouring merely follows whatever the map is using.
    if (this.kind === 'embedding') {
      await this.renderEmbedding();
      return;
    }
    const { values, categorical, grouping } = this.data.snapshot();
    if (!this.colorBy || (!values && !categorical)) {
      this.purgePlot();
      return;
    }
    if (categorical) {
      const counts = {
        group: categorical,
        selection: this.selection.count > 0 ? this.selection.mask : null,
        name: this.colorBy.name,
      };
      // Counted once for both: the layout's height follows the bar count.
      const tally = countByCategory(counts);
      await this.draw(buildCountTraces(counts, tally), countsLayout(counts, tally));
      return;
    }
    if (!values) return;
    const input = {
      values,
      name: this.colorBy.name,
      group: benefitsFromGrouping(this.kind) ? grouping : null,
      selection: this.selection.count > 0 ? this.selection.mask : null,
      log: this.view.logScale,
    };
    const traces = buildOmicsTraces(this.kind, input);
    await this.draw(traces, omicsLayout(this.kind, input));
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
    const { heatmapRows: genes, grouping } = this.data.snapshot();
    if (!this.controls || genes.length === 0 || !grouping) {
      this.purgePlot();
      return;
    }

    const selected = this.selection.count > 0 ? maskToIndices(this.selection.mask) : null;
    const perCell = !!selected && selected.length <= SpatialChartsComponent.HEATMAP_CELL_COLUMNS;
    const cells = perCell && selected
      ? cellsAsGroups(selected, grouping.codes.length,
        SpatialChartsComponent.HEATMAP_CELL_COLUMNS)
      : null;

    // Off the main thread for a big dataset (genes × cells past the worker threshold), and
    // superseded by the next heatmap draw: a slow matrix for an earlier gene list or
    // selection must not land over the current one, and its worker stops.
    const task = this.heatmapRender.next();
    let matrix: HeatmapMatrix | null;
    try {
      matrix = await computeHeatmapMatrixAsync(
        genes,
        cells ? cells.groups : { codes: grouping.codes, categories: grouping.categories },
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
        { signal: task.signal },
      );
    } catch (err) {
      if (!task.isCurrent()) return;
      throw err;
    }
    if (!task.isCurrent()) return;
    if (!matrix) {
      this.purgePlot();
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
    await this.draw(buildHeatmapTraces(input), heatmapLayout(input));
  }
}
