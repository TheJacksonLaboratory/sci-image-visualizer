import { Observable, Subscription, firstValueFrom } from 'rxjs';

import { PlotType, isSpatialOmics3d } from '../contracts/plot-type';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { SpatialColorBy } from '../contracts/display-types';
import {
  SpatialDataset,
  SpatialObservations,
  SpatialSelectionMask,
  isCategoricalColumn,
} from '../contracts/spatial-dataset.contract';
import { ISpatialControls, RoiSelectionMode } from '../contracts/visualizer.contract';
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
  selectInClassVolumes,
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
  /** The ids of the regions drawn over the 3D cloud in screen space (its lassos). */
  getSpatialLassoIds(): number[];
  /** Image px per voxel of the volume the region surfaces sit in; null when the plotted image is
   *  not a volume's stack (the regions are then not in the reference volume's grid). */
  regionVoxelStep(): number | null;
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
  /** Latest dataset, mirrored so `selectFromRegions()` answers from the dataset on
   *  screen — it runs from a button click and must not await a round-trip. */
  private dataset: SpatialDataset | null = null;
  private readonly sub: Subscription;
  /** Bumped per class-volume selection (and on dispose): only the latest may publish. */
  private roiRequest = 0;

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
      const current = ctx.store.currentSpatialView();
      const by = current.colorBy;
      if (by && !canColorBy(dataset, by)) ctx.store.setSpatialView({ colorBy: null });
      // The gene filter names the old dataset's genes: kept, it could hide every observation.
      if (current.observationGenes?.length) ctx.store.setSpatialView({ observationGenes: [] });
    });
    this.controls = this.build();
  }

  /** Release the port subscription (the router's injector is being destroyed). */
  dispose(): void {
    this.sub.unsubscribe();
    // A class-volume selection still reading its outlines publishes nothing.
    this.roiRequest++;
  }

  /**
   * How "Select from ROIs" selects now — the one rule its executor and the panel's description
   * share: inside the picked classes' volumes in the 3D cloud, when the dataset has a reference
   * volume (and no tissue image) and the plotted image is that volume's stack, so the regions sit
   * in its grid; by the drawn regions otherwise.
   */
  private roiSelectionMode(): RoiSelectionMode {
    const dataset = this.dataset;
    const eligible =
      !!dataset?.volume &&
      !dataset.imageRef &&
      isSpatialOmics3d(this.ctx.plotType()) &&
      this.ctx.regionStore.getPickedClasses().length > 0 &&
      this.ctx.napari.regionVoxelStep() !== null;
    return eligible ? 'class-volumes' : 'regions';
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

      selectFromRegions: async () => {
        const dataset = this.dataset;
        if (!dataset) return 0;
        const is3d = isSpatialOmics3d(this.ctx.plotType());
        const volume = !dataset.imageRef ? dataset.volume : undefined;
        // In the 3D cloud, region classes picked in the Region Editor (a class
        // tree node with its subclasses, a surface clicked in 3D) select the
        // cells inside their volumes — the structures shown among the cells.
        if (volume && this.roiSelectionMode() === 'class-volumes') {
          const classes = this.ctx.regionStore.getPickedClasses();
          const request = ++this.roiRequest;
          const revision = this.ctx.selectionStore.revision();
          const outlines = await this.ctx.regionStore.classSliceOutlines(classes);
          // Superseded while the outlines were read: a newer request, any newer selection
          // (a Clear, a legend click, a linked chart's brush), another dataset, view or pick,
          // or the facade disposed. Its mask would overwrite what the user did since.
          const current = this.ctx.regionStore.getPickedClasses();
          if (
            request !== this.roiRequest ||
            revision !== this.ctx.selectionStore.revision() ||
            this.dataset !== dataset ||
            this.roiSelectionMode() !== 'class-volumes' ||
            current.length !== classes.length ||
            current.some((c, i) => c !== classes[i])
          ) {
            return null;
          }
          const selection = selectInClassVolumes(dataset.observations, volume, outlines);
          this.ctx.selectionStore.set(selection);
          return selection.count;
        }
        // Otherwise the union of every drawn region — so every ROI tool the
        // library already has doubles as a spatial selection tool.
        //
        // In the 3D cloud there is no data-space affine to push a drawn shape
        // through, so the observations are projected to canvas pixels by the
        // renderer (which owns the camera) and tested in screen space instead —
        // against the lassos drawn there only: every other region is in image
        // space. Falls back to the 2D path whenever the cloud is not mounted.
        const projected = is3d ? this.ctx.napari.getSpatialScreenProjection(dataset.observations) : null;
        let selection: SpatialSelectionMask;
        if (projected) {
          const lassos = new Set(this.ctx.napari.getSpatialLassoIds());
          const regions = this.ctx.regionStore.getRegions().filter((r) => lassos.has(r.id));
          selection = selectInRegionsProjected(projected, dataset.observations.count, regions);
        } else {
          // In the 2D view of a volume-backed dataset the shape was drawn over ONE
          // section, in the volume's pixel grid: it selects the cells of that
          // section, not the whole depth of brain standing behind them.
          selection = selectInRegions(
            dataset.observations,
            volume ? volumeImageRef(volume, dataset.micronsPerUnit) : dataset.imageRef,
            this.ctx.regionStore.getRegions(),
            volume ? observationsInSlice(dataset.observations, volume, this.ctx.zIndex()) : undefined,
          );
        }
        this.ctx.selectionStore.set(selection);
        return selection.count;
      },

      roiSelectionMode: () => this.roiSelectionMode(),

      getPickedRegionClasses$: () => this.ctx.regionStore.getPickedClasses$(),

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
