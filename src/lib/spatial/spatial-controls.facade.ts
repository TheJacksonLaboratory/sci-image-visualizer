import { Observable, Subscription, firstValueFrom } from 'rxjs';

import { PlotType, isSpatialOmics3d } from '../contracts/plot-type';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { SpatialColorBy } from '../contracts/display-types';
import { SpatialDataset, SpatialObservations, isCategoricalColumn } from '../contracts/spatial-dataset.contract';
import { ISpatialControls } from '../contracts/visualizer.contract';
import { RegionStore } from '../store/region-store.service';
import { SpatialSelectionStore } from '../store/spatial-selection.service';
import { VisualizerStore } from '../store/visualizer-store.service';
import { resolveCategoryColors } from './spatial-encoding';
import { sectionsOf } from './spatial-sections';
import { observationsInSlice, volumeImageRef } from './spatial-volume-image';
import {
  emptySelection,
  selectByCategory,
  selectByIndices,
  selectInRegions,
  selectInRegionsProjected,
} from './spatial-selection';

/** The renderer-side spatial readouts the controls surface (the napari-js backend). */
export interface SpatialRendererFeeds {
  readonly transcriptEstimate$: { asObservable(): Observable<{ points: number; max: number } | null> };
  readonly geneCountsInView$: { asObservable(): Observable<Record<string, number> | null> };
  readonly densityStats$: { asObservable(): Observable<{ lo: number; hi: number; max: number } | null> };
  /** Observations projected to canvas pixels by the 3D camera, or null when the cloud is not mounted. */
  getSpatialScreenProjection(obs: SpatialObservations): Float32Array | null;
}

/** What the facade works over: the shared stores, the renderer feeds and the router's view state. */
export interface SpatialControlsContext {
  readonly store: VisualizerStore;
  readonly regionStore: RegionStore;
  readonly selectionStore: SpatialSelectionStore;
  readonly napari: SpatialRendererFeeds;
  /** The plot type on screen (the 3D cloud selects in screen space). */
  plotType(): PlotType;
  /** The displayed slice (a volume-backed dataset selects within one section). */
  zIndex(): number;
}

/**
 * The spatial-omics controls (`ISpatialControls`) over a host's `SPATIAL_DATA_PORT`.
 *
 * Backend-neutral: the view state lives in the shared `VisualizerStore` (like the
 * colormap) and the selection in the `SpatialSelectionStore`, so the controls keep
 * working across a plot-type switch and a host can drive them before any backend has
 * mounted. Owns its mirror of the port's dataset — dropping a stale selection and an
 * unsatisfiable colour source when the dataset changes — and the subscription behind
 * it, released by {@link dispose} (review CORE-30).
 */
export class SpatialControlsFacade {
  /** The controls; one object for the facade's life, so consumers can hold it. */
  readonly controls: ISpatialControls;
  /** Latest dataset, mirrored so `selectFromRegions()` can answer synchronously — it
   *  runs from a button click and must not await a round-trip. */
  private dataset: SpatialDataset | null = null;
  private readonly sub: Subscription;

  constructor(
    private readonly port: SpatialDataPort,
    private readonly ctx: SpatialControlsContext,
  ) {
    // Mirror the dataset (and drop a stale selection when it changes — the masks are
    // index-based, so they are meaningless against different observations).
    this.sub = port.getDataset$().subscribe((dataset) => {
      const changed = dataset?.id !== this.dataset?.id;
      this.dataset = dataset;
      if (!changed) return;
      ctx.selectionStore.set(emptySelection(dataset?.observations.count ?? 0));
      // A colour source the new dataset cannot satisfy would leave the map flat while
      // the panel and the charts kept naming the old column — so drop it, and only it:
      // point size, opacity and the rest are the user's preferences.
      const by = ctx.store.currentSpatialView().colorBy;
      if (by && !canColorBy(dataset, by)) ctx.store.setSpatialView({ colorBy: null });
    });
    this.controls = this.build();
  }

  /** Release the port subscription (the router's injector is being destroyed). */
  dispose(): void {
    this.sub.unsubscribe();
  }

  private build(): ISpatialControls {
    const port = this.port;
    return {
      getDataset$: () => port.getDataset$(),
      getViewState$: () => this.ctx.store.getSpatialView$(),
      viewState: () => this.ctx.store.currentSpatialView(),
      setViewState: (partial) => this.ctx.store.setSpatialView(partial),
      // The hint SEEDS the toggle when the source changes, and nothing consults it
      // afterwards. It used to be ORed in at render time, which meant an unchecked
      // box could not turn log scaling off for a hinted column — and the linked
      // chart, which reads `logScale` alone, disagreed with the map about what it
      // was showing. One authority, set once per source.
      colorByColumn: (name: string) => {
        const meta = this.dataset?.columns.find((c) => c.name === name);
        const hint = meta?.kind === 'continuous' ? !!meta.logScaleHint : false;
        this.ctx.store.setSpatialView({ colorBy: { kind: 'column', name }, logScale: hint });
      },
      colorByFeature: (name: string) =>
        this.ctx.store.setSpatialView({
          colorBy: { kind: 'feature', name },
          logScale: !!this.dataset?.features?.logScaleHint,
        }),
      clearColorBy: () => this.ctx.store.setSpatialView({ colorBy: null }),
      searchFeatures: async (query: string, limit = 50) => {
        // Prefer the port's search (a 31k-gene dataset does not ship its names);
        // otherwise filter whatever the manifest inlined.
        if (port.searchFeatures) return port.searchFeatures(query, limit);
        const dataset = await firstValueFrom(port.getDataset$());
        const names = dataset?.features?.names ?? [];
        const q = query.toLowerCase();
        return names.filter((n) => n.toLowerCase().includes(q)).slice(0, limit);
      },
      ...(port.importGroups
        ? {
            importGroups: (label: string, table: string) => port.importGroups!(label, table),
          }
        : {}),
      ...(port.getTranscriptCounts
        ? {
            transcriptCounts: (genes: string[]) => port.getTranscriptCounts!(genes),
          }
        : {}),
      ...(port.getMarkerGenes
        ? {
            markerGenes: (column: string, perGroup?: number) => port.getMarkerGenes!(column, perGroup),
          }
        : {}),
      getTranscriptEstimate$: () => this.ctx.napari.transcriptEstimate$.asObservable(),
      getGeneCountsInView$: () => this.ctx.napari.geneCountsInView$.asObservable(),
      getDensityStats$: () => this.ctx.napari.densityStats$.asObservable(),
      categoryColors: async (name: string) => {
        const column = await port.getColumn(name);
        if (!isCategoricalColumn(column)) {
          throw new Error(`[spatial] column "${name}" is continuous — it has no categories`);
        }
        // Resolved by the SAME function the renderer uses, so a legend swatch
        // can never disagree with the colour on screen.
        return resolveCategoryColors(column.meta);
      },

      continuousValues: async (source) => {
        if (source.kind === 'feature') return port.getFeatureVector(source.name);
        const column = await port.getColumn(source.name);
        if (isCategoricalColumn(column)) {
          throw new Error(`[spatial] column "${source.name}" is categorical — it has no values to chart`);
        }
        return column.values;
      },

      categoricalView: async (name: string) => {
        const column = await port.getColumn(name);
        if (!isCategoricalColumn(column)) {
          throw new Error(`[spatial] column "${name}" is continuous — it has no categories`);
        }
        return {
          name,
          categories: column.meta.categories,
          colors: resolveCategoryColors(column.meta),
          codes: column.codes,
        };
      },

      // Spread rather than always defined: `getEmbedding` is optional on both the port
      // and this facade, and a panel checks for its presence to decide whether the view
      // is offered at all. Defining it as a function that rejects would make an
      // embedding-less source look like a broken one.
      ...(port.getEmbedding ? { getEmbedding: (name: string) => port.getEmbedding!(name) } : {}),

      categoricalColumns: () =>
        (this.dataset?.columns ?? []).filter((c) => c.kind === 'categorical').map((c) => c.name),

      // Memoized on the observations object, so the renderer's own lookup and
      // this one are the same single scan of up to 3.7M z values.
      sampledSections: () => {
        const obs = this.dataset?.observations;
        return obs ? sectionsOf(obs) : null;
      },

      getSelection$: () => this.ctx.selectionStore.getSelection$(),

      selectFromRegions: () => {
        const dataset = this.dataset;
        if (!dataset) return 0;
        const regions = this.ctx.regionStore.getRegions();
        // The union of every drawn region — so every ROI tool the library
        // already has doubles as a spatial selection tool.
        //
        // In the 3D cloud there is no data-space affine to push a drawn shape
        // through, so the observations are projected to canvas pixels by the
        // renderer (which owns the camera) and tested in screen space instead.
        // Falls back to the 2D path whenever the cloud is not mounted.
        const projected = isSpatialOmics3d(this.ctx.plotType())
          ? this.ctx.napari.getSpatialScreenProjection(dataset.observations)
          : null;
        // In the 2D view of a volume-backed dataset the shape was drawn over ONE
        // section, in the volume's pixel grid: it selects the cells of that
        // section, not the whole depth of brain standing behind them.
        const volume = !dataset.imageRef ? dataset.volume : undefined;
        const selection = projected
          ? selectInRegionsProjected(projected, dataset.observations.count, regions)
          : selectInRegions(
              dataset.observations,
              volume ? volumeImageRef(volume, dataset.micronsPerUnit) : dataset.imageRef,
              regions,
              volume ? observationsInSlice(dataset.observations, volume, this.ctx.zIndex()) : undefined,
            );
        this.ctx.selectionStore.set(selection);
        return selection.count;
      },

      selectCategory: async (column: string, categoryIndex: number) => {
        const loaded = await port.getColumn(column);
        if (!isCategoricalColumn(loaded)) {
          throw new Error(`[spatial] column "${column}" is continuous — it has no categories`);
        }
        const selection = selectByCategory(loaded.codes, categoryIndex);
        this.ctx.selectionStore.set(selection);
        return selection.count;
      },

      selectIndices: (indices: Iterable<number>) => {
        const count = this.dataset?.observations.count ?? 0;
        if (count === 0) return 0;
        const selection = selectByIndices(indices, count);
        this.ctx.selectionStore.set(selection);
        return selection.count;
      },

      clearSelection: () => this.ctx.selectionStore.clear(),
    };
  }
}

/**
 * Whether `dataset` can answer this colour source. A column is checkable against the
 * declared list. A gene is checkable only when the dataset inlines its feature names —
 * a dataset too wide to inline them (typeahead-only) keeps the source, and a name that
 * turns out not to exist surfaces as the chart's "could not be charted" rather than as
 * a silent reset.
 */
function canColorBy(dataset: SpatialDataset | null, by: SpatialColorBy): boolean {
  if (!dataset) return false;
  if (by.kind === 'column') return dataset.columns.some((c) => c.name === by.name);
  const names = dataset.features?.names;
  return !!dataset.features && (!names || names.includes(by.name));
}
