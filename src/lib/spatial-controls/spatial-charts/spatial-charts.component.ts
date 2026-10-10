import {
  AfterViewInit, Component, Inject, Input, OnDestroy, OnInit,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../../contracts/visualizer.contract';
import {
  SpatialEmbedding,
  SpatialEmbeddingMeta,
} from '../../contracts/spatial-dataset.contract';
import { SpatialColorBy, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../../contracts/display-types';
import {
  SpatialSelectionMask, emptySelection, maskToIndices,
} from '../../spatial/spatial-selection';
import { cellsAsGroups, heatmapMatrix } from '../../spatial/spatial-heatmap';
import { geneOptionsFor } from '../../spatial/gene-search';
import {
  BROWSER_TSNE_MAX_OBSERVATIONS, EmbeddingComputeCoordinator,
} from '../../spatial/embedding-compute-coordinator';
import { Supersede } from '../../util/supersede';
import { EMBEDDING_CONFIG, PlotlyChartHost } from './plotly-chart-host';
import { ChartKindOption, chartKindOptions, embeddingNote, heatmapNote, kindHelp } from './chart-help';
import {
  OmicsChartKind, OmicsGrouping, benefitsFromGrouping, buildCountTraces, buildHeatmapTraces,
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
    const categorical = !!this.categorical;
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
  /** Embeddings the dataset publishes, and which of them is drawn. */
  embeddings: SpatialEmbeddingMeta[] = [];
  embedding: SpatialEmbeddingMeta | null = null;
  private embeddingCoords: SpatialEmbedding | null = null;
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
  /** Every gene the dataset inlined. `geneOptions` is only ever the best few hundred of
   *  these — see `gene-search.ts` for why a whole-transcriptome list cannot be handed to
   *  the control whole. */
  private geneNames: string[] = [];
  /** What is typed in the picker's filter box, so the options can be rebuilt when the
   *  selection changes without losing the query. */
  private geneQuery = '';
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
  /** A load is in flight. One flag per load, because each is superseded on its own: a
   *  shared flag was left set by whichever load lost its race. */
  get busy(): boolean {
    return this.valueBusy || this.heatmapBusy || this.embeddingBusy;
  }
  private valueBusy = false;
  private heatmapBusy = false;
  private embeddingBusy = false;

  private view: SpatialViewState = { ...DEFAULT_SPATIAL_VIEW };
  private selection: SpatialSelectionMask = emptySelection();
  private values: Float32Array | null = null;
  /** Set instead of `values` when the colour source is a categorical column: its
   *  distribution is counts per category, not a histogram of its codes. */
  private categorical: OmicsGrouping | null = null;
  private grouping: OmicsGrouping | null = null;
  /** Guards the async value fetch: a fast colour-source change can resolve out
   *  of order, and a stale vector would be charted against the new label. */
  private readonly valueLoad = new Supersede();
  /** The same guard for the grouping fetch, which the user can change as fast. */
  private readonly groupLoad = new Supersede();
  /** And for the heatmap's gene vectors and the embedding's coordinates. Each load has
   *  its own: on one shared counter, a redraw for a selection change dropped a pending
   *  colour-source load. */
  private readonly heatmapLoad = new Supersede();
  private readonly embeddingLoad = new Supersede();
  /** The dataset the loaded vectors belong to; `undefined` before the first emission. */
  private datasetId: string | null | undefined = undefined;
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
      const id = dataset?.id ?? null;
      const switched = this.datasetId !== undefined && id !== this.datasetId;
      this.datasetId = id;
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
      this.geneNames = [...(dataset?.features?.names ?? [])];
      this.geneQuery = '';
      // Validated against the WHOLE list, not the visible options: those are capped, and
      // filtering the selection by them would drop genes the dataset still has.
      const known = new Set(this.geneNames);
      this.heatmapGenes = this.heatmapGenes.filter((n) => known.has(n));
      this.refreshGeneOptions();
      this.geneCache.clear();

      // Embeddings belong to the dataset, so they are re-read with it and the loaded
      // coordinates dropped: a UMAP from the previous dataset over these observations
      // would be a plot of two different things at once.
      // Offer to compute a t-SNE only where the dataset has PCA to embed and no t-SNE of
      // its own; anything computed or computing for the previous dataset is dropped.
      this.embeddings = this.compute.setDataset(dataset?.embeddings ?? [], dataset?.observations.count ?? 0);
      this.embedding = this.embeddings[0] ?? null;
      this.embeddingCoords = null;
      // Nothing to draw for the kind that was selected; fall back rather than sit blank.
      if (this.kind === 'embedding' && this.embeddings.length === 0) this.kind = 'histogram';

      // Every vector loaded so far is indexed by the previous dataset's observations, and
      // a port may go straight from one dataset to the next with a colour source of the
      // same name, so the view need not re-emit. Drop them, drop anything still loading
      // for the old dataset, and fetch afresh.
      if (switched) {
        this.valueLoad.cancel();
        this.groupLoad.cancel();
        this.heatmapLoad.cancel();
        this.embeddingLoad.cancel();
        this.valueBusy = this.heatmapBusy = this.embeddingBusy = false;
        this.values = null;
        this.categorical = null;
        this.grouping = null;
        if (this.groupBy) void this.onGroupBy(this.groupBy);
        void this.reload();
      }
    }));
  }

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
    this.heatmapGenes = names ?? [];
    // Chosen genes must stay in the options or the control cannot label its chips.
    this.refreshGeneOptions();
    await this.loadHeatmapGenes();
    void this.render();
  }

  /**
   * Fetch any gene the heatmap needs and does not already hold.
   *
   * Sequenced: each vector is a separate request, and a slower one must not paint
   * rows for a gene list the user has already moved on from — nor land in the cache
   * of a dataset it was not fetched for.
   */
  private async loadHeatmapGenes(): Promise<void> {
    const controls = this.controls;
    if (!controls) return;
    const missing = this.heatmapGenes.filter((n) => !this.geneCache.has(n));
    if (missing.length === 0) return;
    const current = this.heatmapLoad.next();
    this.heatmapBusy = true;
    try {
      for (const name of missing) {
        const values = await controls.continuousValues({ kind: 'feature', name });
        if (!current()) return;
        this.geneCache.set(name, values);
      }
      this.notice = null;
    } catch (err) {
      if (!current()) return;
      this.notice = `A gene could not be charted: ${(err as Error)?.message ?? err}`;
    } finally {
      if (current()) this.heatmapBusy = false;
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
    const current = this.groupLoad.next();
    try {
      const view = await this.controls.categoricalView(name);
      if (!current()) return;
      this.grouping = { codes: view.codes, categories: view.categories, colors: view.colors };
    } catch {
      if (!current()) return;
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
    const current = this.valueLoad.next();
    if (!controls || !source) {
      this.valueBusy = false;
      this.values = null;
      this.categorical = null;
      this.notice = controls
        ? 'Colour the map by a column or a gene to chart its distribution.'
        : null;
      void this.render();
      return;
    }
    this.valueBusy = true;
    // A categorical column charts as COUNTS per category — asked for by name
    // rather than discovered by catching the continuous fetch's error, so a
    // genuine failure still reads as a failure.
    const isCategorical = source.kind === 'column'
      && (controls.categoricalColumns() ?? []).includes(source.name);
    try {
      if (isCategorical) {
        const view = await controls.categoricalView(source.name);
        if (!current()) return; // superseded
        this.categorical = { codes: view.codes, categories: view.categories, colors: view.colors };
        this.values = null;
        // Only off the distribution tabs. The heatmap does not chart the colour source,
        // and the embedding is coloured BY it — its own caption asks for exactly this.
        if (this.kind !== 'embedding' && this.kind !== 'heatmap') this.kind = 'counts';
        this.notice = null;
      } else {
        const values = await controls.continuousValues(source);
        if (!current()) return;
        this.values = values;
        this.categorical = null;
        if (this.kind === 'counts') this.kind = 'histogram';
        this.notice = null;
      }
    } catch (err) {
      if (!current()) return;
      this.values = null;
      this.categorical = null;
      this.notice = `"${source.name}" could not be charted: ${(err as Error)?.message ?? err}`;
    } finally {
      if (current()) this.valueBusy = false;
    }
    void this.render();
  }

  /**
   * The embedding scatter — a UMAP over the same observations.
   *
   * Answers what the map cannot: the map says WHERE a population sits, this says which
   * populations there are and how close they are in expression.
   *
   * Linked to the map without asking for anything: it reuses `this.categorical`, the same
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

    // Sequenced: the coordinates are a round-trip, and a slower one must not paint over
    // an embedding the user has already moved on from.
    const current = this.embeddingLoad.next();
    // Computed here, not served: a local result is the same shape as a fetched one, so
    // everything downstream — colouring, lasso selection, the camera — is unchanged.
    const local = this.compute.result(meta.name);
    if (local) {
      this.embeddingCoords = local;
    } else if (this.isComputable) {
      // Offered but not yet computed. The panel shows the Compute button; drawing nothing
      // is right, and an error would be wrong — there is no failure here.
      this.purgePlot();
      this.notice = null;
      return;
    } else if (!this.embeddingCoords || this.embeddingCoords.meta.name !== meta.name) {
      this.embeddingBusy = true;
      try {
        const loaded = await controls.getEmbedding(meta.name);
        if (!current()) return;
        this.embeddingCoords = loaded;
      } catch (err) {
        if (!current()) return;
        this.notice = `Could not load ${meta.label ?? meta.name}: `
          + `${(err as Error)?.message ?? err}`;
        this.purgePlot();
        return;
      } finally {
        if (current()) this.embeddingBusy = false;
      }
    }
    const coords = this.embeddingCoords;
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
      ...(this.categorical
        ? {
          categories: {
            codes: this.categorical.codes,
            names: this.categorical.categories,
            colors: this.categorical.colors,
          },
        }
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

  /**
   * Rebuild the visible options: the best matches for what is typed, plus what is chosen.
   *
   * A capped multi-select that drops its own selections cannot resolve their labels, and
   * the model loses them on the next change — the chips vanish for no reason the user
   * can see.
   */
  private refreshGeneOptions(): void {
    this.geneOptions = geneOptionsFor(this.geneNames, this.geneQuery, this.heatmapGenes)
      .map((n) => ({ label: n, value: n }));
  }

  /** The gene picker's filter box changed: search the resident names, show the best. */
  onGeneFilter(query: string): void {
    this.geneQuery = query ?? '';
    this.refreshGeneOptions();
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
    this.embeddingCoords = result;
    await this.render();
  }

  /** Stop a run. It settles shortly after, leaving no embedding. */
  cancelCompute(): void {
    this.compute.cancel();
  }

  /** Which embedding to draw, when the dataset publishes more than one. */
  onEmbedding(name: string): void {
    const next = this.embeddings.find((e) => e.name === name);
    if (!next || next.name === this.embedding?.name) return;
    this.embedding = next;
    this.embeddingCoords = null;
    void this.render();
  }

  /** What the chart on screen shows, and what it cannot be read for — see {@link kindHelp}. */
  get kindHelp(): string {
    return kindHelp(this.kind, this.embedding);
  }

  /** What the embedding view is showing, said plainly. */
  get embeddingNote(): string {
    return embeddingNote(this.embeddingCoords?.meta ?? this.embedding, !!this.categorical, this.selection.count);
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
    if (!this.colorBy || (!this.values && !this.categorical)) {
      this.purgePlot();
      return;
    }
    if (this.categorical) {
      const counts = {
        group: this.categorical,
        selection: this.selection.count > 0 ? this.selection.mask : null,
        name: this.colorBy.name,
      };
      // Counted once for both: the layout's height follows the bar count.
      const tally = countByCategory(counts);
      await this.draw(buildCountTraces(counts, tally), countsLayout(counts, tally));
      return;
    }
    if (!this.values) return;
    const input = {
      values: this.values,
      name: this.colorBy.name,
      group: benefitsFromGrouping(this.kind) ? this.grouping : null,
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
    const controls = this.controls;
    const genes = this.heatmapGenes
      .map((name) => ({ name, values: this.geneCache.get(name) }))
      .filter((g): g is { name: string; values: Float32Array } => !!g.values);
    if (!controls || genes.length === 0 || !this.grouping) {
      this.purgePlot();
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
