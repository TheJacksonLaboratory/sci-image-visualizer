import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type {
  SpatialDataset, SpatialEmbedding, SpatialEmbeddingMeta,
} from '../../contracts/spatial-dataset.contract';
import type { SpatialColorBy } from '../../contracts/display-types';
import { geneOptionsFor } from '../../spatial/gene-search';
import type { OmicsGrouping } from '../../implementations/plotly/omics-trace-builders';
import { Supersede } from '../../util/supersede';

/** What a colour-source load came to. */
export type ValueLoad =
  /** Nothing to chart: no colour source, or no port. */
  | 'none'
  /** A categorical column: its counts per category are loaded. */
  | 'categorical'
  /** A gene or numeric column: its values are loaded. */
  | 'continuous'
  /** The load failed; {@link ChartDataModel.notice} says why. */
  | 'failed'
  /** A newer load (or a dataset switch) overtook this one: nothing to do. */
  | 'superseded';

/** What the renderer draws from: everything loaded for the current dataset. */
export interface ChartData {
  /** The colour source's values, when it is continuous. */
  values: Float32Array | null;
  /** The colour source's categories, when it is a categorical column. */
  categorical: OmicsGrouping | null;
  /** The grouping column the violin, box and heatmap split by. */
  grouping: OmicsGrouping | null;
  groupBy: string | null;
  /** The heatmap's genes that have their vectors, in row order. */
  heatmapRows: { name: string; values: Float32Array }[];
  /** The drawn embedding's coordinates, once loaded. */
  embeddingCoords: SpatialEmbedding | null;
}

/**
 * The data the spatial charts draw, and its loading: the colour source's vector (or its
 * categories), the grouping column, the heatmap's gene vectors, and the embedding's
 * coordinates.
 *
 * Each load has its OWN {@link Supersede}: on one shared counter a redraw for a selection
 * change dropped a pending colour-source load (SPATIAL-2), and a busy flag per load, since
 * a shared one was left set by whichever load lost its race. A dataset switch
 * ({@link onDatasetChanged}) cancels all of them together and drops every vector, because
 * each is indexed by the previous dataset's observations (SPATIAL-1).
 *
 * Plain class: the component asks it to load, then renders {@link snapshot}.
 */
export class ChartDataModel {
  /** Categorical column the violin/box (and heatmap) split by; null = one trace for all. */
  groupBy: string | null = null;
  groupOptions: { label: string; value: string | null }[] = [];

  /**
   * Genes the heatmap's rows are. Local rather than in `SpatialViewState`, as the chart
   * kind is: this is what the panel is charting, not what the map is drawing.
   */
  heatmapGenes: string[] = [];
  geneOptions: { label: string; value: string }[] = [];

  /** Embeddings to offer, and which of them is drawn. */
  embeddings: SpatialEmbeddingMeta[] = [];
  embedding: SpatialEmbeddingMeta | null = null;
  embeddingCoords: SpatialEmbedding | null = null;

  /** Set when something cannot be charted, for an inline hint. */
  notice: string | null = null;

  private values: Float32Array | null = null;
  /** Set instead of `values` when the colour source is a categorical column: its
   *  distribution is counts per category, not a histogram of its codes. */
  private categorical: OmicsGrouping | null = null;
  private grouping: OmicsGrouping | null = null;
  /** Every gene the dataset inlined. `geneOptions` is only ever the best few hundred of
   *  these — see `gene-search.ts` for why a whole-transcriptome list cannot be handed to
   *  the control whole. */
  private geneNames: string[] = [];
  /** What is typed in the picker's filter box, so the options can be rebuilt when the
   *  selection changes without losing the query. */
  private geneQuery = '';
  /** Fetched vectors by gene name, so adding a fourth gene does not refetch the first
   *  three — each is a full per-observation Float32Array. */
  private readonly geneCache = new Map<string, Float32Array>();

  private valueBusy = false;
  private heatmapBusy = false;
  private embeddingBusy = false;
  /** Guards the colour-source fetch: a fast colour-source change can resolve out of order,
   *  and a stale vector would be charted against the new label. */
  private readonly valueLoad = new Supersede();
  /** The same for the grouping, which the user can change as fast. */
  private readonly groupLoad = new Supersede();
  private readonly heatmapLoad = new Supersede();
  private readonly embeddingLoad = new Supersede();
  /** The dataset the loaded vectors belong to; `undefined` before the first. */
  private datasetId: string | null | undefined = undefined;

  /** A load is in flight. */
  get busy(): boolean {
    return this.valueBusy || this.heatmapBusy || this.embeddingBusy;
  }

  /** Whether the colour source is a categorical column (with its categories loaded). */
  get isCategorical(): boolean {
    return !!this.categorical;
  }

  /** Whether a grouping column's categories are loaded. */
  get hasGrouping(): boolean {
    return !!this.grouping;
  }

  /** What the renderer draws from. */
  snapshot(): ChartData {
    return {
      values: this.values,
      categorical: this.categorical,
      grouping: this.grouping,
      groupBy: this.groupBy,
      heatmapRows: this.heatmapGenes
        .map((name) => ({ name, values: this.geneCache.get(name) }))
        .filter((g): g is { name: string; values: Float32Array } => !!g.values),
      embeddingCoords: this.embeddingCoords,
    };
  }

  /**
   * A dataset emission: its grouping columns, gene names and the embeddings to offer.
   *
   * @returns true when this is a SWITCH from another dataset. Every vector loaded so far is
   *   then dropped and every load still running for the old dataset cancelled; the caller
   *   must reload the colour source (and the grouping), because a port may go straight from
   *   one dataset to the next with a colour source of the same name, so the view need not
   *   re-emit.
   */
  onDatasetChanged(
    dataset: SpatialDataset | null, categoricalColumns: readonly string[], embeddings: SpatialEmbeddingMeta[],
  ): boolean {
    const id = dataset?.id ?? null;
    const switched = this.datasetId !== undefined && id !== this.datasetId;
    this.datasetId = id;
    this.groupOptions = [
      { label: 'No grouping', value: null },
      ...categoricalColumns.map((n) => ({ label: n, value: n })),
    ];
    // A new dataset's columns are different; a carried-over group is meaningless.
    if (this.groupBy && !this.groupOptions.some((o) => o.value === this.groupBy)) {
      this.groupBy = null;
      this.grouping = null;
    }
    // The heatmap's rows come from the dataset's gene list. A dataset too wide to inline
    // its names offers none here — the panel's typeahead is the way in for those, and the
    // heatmap needs names it can list.
    this.geneNames = [...(dataset?.features?.names ?? [])];
    this.geneQuery = '';
    // Validated against the WHOLE list, not the visible options: those are capped, and
    // filtering the selection by them would drop genes the dataset still has.
    const known = new Set(this.geneNames);
    this.heatmapGenes = this.heatmapGenes.filter((n) => known.has(n));
    this.refreshGeneOptions();
    this.geneCache.clear();

    // Embeddings belong to the dataset, so they are re-read with it and the loaded
    // coordinates dropped: a UMAP from the previous dataset over these observations would
    // be a plot of two different things at once.
    this.embeddings = embeddings;
    this.embedding = embeddings[0] ?? null;
    this.embeddingCoords = null;

    if (switched) {
      this.valueLoad.cancel();
      this.groupLoad.cancel();
      this.heatmapLoad.cancel();
      this.embeddingLoad.cancel();
      this.valueBusy = this.heatmapBusy = this.embeddingBusy = false;
      this.values = null;
      this.categorical = null;
      this.grouping = null;
    }
    return switched;
  }

  /** Fetch the colour source's vector — or, for a categorical column, its categories. */
  async loadValues(controls: ISpatialControls | null, source: SpatialColorBy | null): Promise<ValueLoad> {
    const current = this.valueLoad.next();
    if (!controls || !source) {
      this.valueBusy = false;
      this.values = null;
      this.categorical = null;
      this.notice = controls ? 'Colour the map by a column or a gene to chart its distribution.' : null;
      return 'none';
    }
    this.valueBusy = true;
    // A categorical column charts as COUNTS per category — asked for by name rather than
    // discovered by catching the continuous fetch's error, so a genuine failure still
    // reads as a failure.
    const isCategorical = source.kind === 'column' && (controls.categoricalColumns() ?? []).includes(source.name);
    try {
      if (isCategorical) {
        const view = await controls.categoricalView(source.name);
        if (!current()) return 'superseded';
        this.categorical = { codes: view.codes, categories: view.categories, colors: view.colors };
        this.values = null;
        this.notice = null;
        return 'categorical';
      }
      const values = await controls.continuousValues(source);
      if (!current()) return 'superseded';
      this.values = values;
      this.categorical = null;
      this.notice = null;
      return 'continuous';
    } catch (err) {
      if (!current()) return 'superseded';
      this.values = null;
      this.categorical = null;
      this.notice = `"${source.name}" could not be charted: ${(err as Error)?.message ?? err}`;
      return 'failed';
    } finally {
      if (current()) this.valueBusy = false;
    }
  }

  /**
   * Group by `name` (null for none), fetching its categories.
   *
   * @returns false when a later choice overtook this one — sequenced, because picking A
   *   then B with a slower A would otherwise chart A's categories under a dropdown that
   *   says B. A failure falls back to no grouping.
   */
  async loadGrouping(controls: ISpatialControls | null, name: string | null): Promise<boolean> {
    this.groupBy = name;
    if (!name || !controls) {
      this.grouping = null;
      return true;
    }
    const current = this.groupLoad.next();
    try {
      const view = await controls.categoricalView(name);
      if (!current()) return false;
      this.grouping = { codes: view.codes, categories: view.categories, colors: view.colors };
    } catch {
      if (!current()) return false;
      this.grouping = null;
      this.groupBy = null;
    }
    return true;
  }

  /** The heatmap's rows. Chosen genes stay among the options, or the control cannot label
   *  its chips. */
  setHeatmapGenes(names: string[] | null): void {
    this.heatmapGenes = names ?? [];
    this.refreshGeneOptions();
  }

  /** The gene picker's filter box changed: search the resident names, show the best. */
  filterGenes(query: string | null): void {
    this.geneQuery = query ?? '';
    this.refreshGeneOptions();
  }

  /**
   * Fetch any gene the heatmap needs and does not already hold.
   *
   * Sequenced: each vector is a separate request, and a slower one must not paint rows
   * for a gene list the user has already moved on from — nor land in the cache of a
   * dataset it was not fetched for.
   */
  async loadHeatmapGenes(controls: ISpatialControls | null): Promise<void> {
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

  /** Draw `name` next, when the dataset offers it. @returns whether the choice changed. */
  selectEmbedding(name: string): boolean {
    const next = this.embeddings.find((e) => e.name === name);
    if (!next || next.name === this.embedding?.name) return false;
    this.embedding = next;
    this.embeddingCoords = null;
    return true;
  }

  /**
   * The coordinates for `meta`: kept when already loaded, else fetched — sequenced, as a
   * slower round-trip must not paint over an embedding the user has already moved on from.
   *
   * @returns whether they are ready to draw ('failed' has set {@link notice}).
   */
  async loadEmbedding(
    getEmbedding: (name: string) => Promise<SpatialEmbedding>, meta: SpatialEmbeddingMeta,
  ): Promise<'ready' | 'failed' | 'superseded'> {
    const current = this.embeddingLoad.next();
    if (this.embeddingCoords?.meta.name === meta.name) return 'ready';
    this.embeddingBusy = true;
    try {
      const loaded = await getEmbedding(meta.name);
      if (!current()) return 'superseded';
      this.embeddingCoords = loaded;
      return 'ready';
    } catch (err) {
      if (!current()) return 'superseded';
      this.notice = `Could not load ${meta.label ?? meta.name}: ${(err as Error)?.message ?? err}`;
      return 'failed';
    } finally {
      if (current()) this.embeddingBusy = false;
    }
  }

  /**
   * Supersede any embedding load in flight without starting one — for a draw that needs
   * no fetch (computed here, or still to be computed), which a slower fetch must not
   * overwrite.
   */
  supersedeEmbeddingLoad(): void {
    this.embeddingLoad.cancel();
  }

  private refreshGeneOptions(): void {
    this.geneOptions = geneOptionsFor(this.geneNames, this.geneQuery, this.heatmapGenes)
      .map((n) => ({ label: n, value: n }));
  }
}
