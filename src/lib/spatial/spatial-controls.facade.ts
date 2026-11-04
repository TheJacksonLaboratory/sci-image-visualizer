import type { Cells3dStatus, TranscriptsInSelection } from '../contracts/display-types';
import {
  debounceTime,
  defer,
  distinctUntilChanged,
  EMPTY,
  firstValueFrom,
  map,
  merge,
  Observable,
  of,
  Subscription,
  switchMap,
  tap,
} from 'rxjs';

import { PlotType, isSpatialOmics3d } from '../contracts/plot-type';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { SpatialColorBy } from '../contracts/display-types';
import {
  CategoricalColumnMeta,
  SpatialDataset,
  SpatialObservations,
  SpatialSelectionMask,
  isCategoricalColumn,
} from '../contracts/spatial-dataset.contract';
import { ISpatialControls, RoiSelectionMode } from '../contracts/visualizer.contract';
import { RegionStore } from '../store/region-store.service';
import { SpatialSelectionStore } from '../store/spatial-selection.service';
import { VisualizerStore } from '../store/visualizer-store.service';
import { categoryColorsFor } from './spatial-encoding';
import { sectionsOf } from './spatial-sections';
import { observationsInSlice, volumeImageRef } from './spatial-volume-image';
import { observationsOnPlane } from './spatial-planes';
import {
  emptySelection,
  selectByCategory,
  selectByIndices,
  selectInClassVolumes,
  selectInRegions,
  selectInRegionsProjected,
  regionShapes,
} from './spatial-selection';
import { cellTypeColumnFor, typicalCellDiameter } from './lod';
import { planeBand } from './spatial-planes';
import {
  CELL_REACH_MICRONS,
  cellsOfCategories,
  countTranscripts,
  tileBudget,
  tilesAroundCells,
  tilesUnderShapes,
  type TranscriptFilter,
} from './transcripts-in-selection';

/** The renderer-side spatial readouts the controls surface (the napari-js backend). */
export interface SpatialRendererFeeds {
  readonly transcriptEstimate$: { asObservable(): Observable<{ points: number; max: number } | null> };
  readonly geneCountsInView$: { asObservable(): Observable<Record<string, number> | null> };
  readonly densityStats$: { asObservable(): Observable<{ lo: number; hi: number; max: number } | null> };
  readonly geneFilterFailed$?: { asObservable(): Observable<boolean> };
  readonly cells3dStatus$?: { asObservable(): Observable<Cells3dStatus | null> };
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
  /**
   * The dataset region set's planes while they slice an image of one plane (see the router's
   * `getDatasetPlanes$`): the slice is then one of them, and a region selects within it. Optional.
   */
  planes?(): readonly number[] | null;
  /**
   * The dataset region set's planes (its `sliceZ`), whether or not they slice the image (a stack of
   * as many planes is sliced by its own slices): the 2D view shows plane `zIndex()`'s transcripts.
   * Optional.
   */
  slicePlanes?(): readonly number[] | null;
  /** Emits when the plot type, the slice shown or the dataset's planes change. Optional. */
  readonly viewChanged$?: Observable<unknown>;
}

/** Where the selection the transcript list counts comes from. */
type SelectionSource = 'cells' | 'types' | 'regions';

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
      // Group colours are chosen for this dataset's groupings; another's same-named column is not them.
      if (Object.keys(current.groupColors ?? {}).length) ctx.store.setSpatialView({ groupColors: {} });
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

  /**
   * The transcripts of the selection, by gene, counted again whenever what they depend on changes.
   * The selection is the latest of three, as the user made them: the selected cells (a cell clicked,
   * a legend group, a brush), the classes picked in the region editor (in spatial 3D the cell types
   * of the type surfaces), or the regions selected on the image (2D only). Clearing the latest goes
   * back to the one before, when it still stands.
   */
  private transcriptsInSelection$(): Observable<TranscriptsInSelection> {
    const { ctx } = this;
    return defer(() => {
      let active: SelectionSource[] = [];
      const track = (source: SelectionSource, on: boolean) => {
        active = active.filter((s) => s !== source);
        if (on) active.push(source);
      };
      const view = ctx.store.getSpatialView$().pipe(
        map((v) => `${v.transcriptQuality}|${v.cellTypeColumn ?? ''}`),
        distinctUntilChanged(),
      );
      return merge(
        // On subscribing, the three come in this order: of those standing, the cells come last
        // (the most specific).
        ctx.regionStore.getSelectedShapeIndices$().pipe(tap((i) => track('regions', i.length > 0))),
        ctx.regionStore.getPickedClasses$().pipe(tap((c) => track('types', c.length > 0))),
        ctx.selectionStore.getSelection$().pipe(tap((sel) => track('cells', sel.count > 0))),
        ctx.regionStore.getRegionUpdateEvent(),
        ctx.viewChanged$ ?? EMPTY,
        view,
        this.port.getDataset$(),
      ).pipe(
        debounceTime(150),
        switchMap(() => this.countSelection(active.slice())),
      );
    });
  }

  /** {@link transcriptsOf} as a stream: `loading`, then the list; unsubscribing abandons it. */
  private countSelection(active: readonly SelectionSource[]): Observable<TranscriptsInSelection> {
    return new Observable<TranscriptsInSelection>((sub) => {
      let cancelled = false;
      this.transcriptsOf(
        active,
        (state) => {
          if (!cancelled) sub.next(state);
        },
        () => cancelled,
      )
        .then((state) => {
          if (cancelled) return;
          sub.next(state);
          sub.complete();
        })
        .catch((err) => {
          if (cancelled) return;
          sub.next({ state: 'error', message: `The transcripts could not be counted: ${err?.message ?? err}` });
          sub.complete();
        });
      return () => {
        cancelled = true;
      };
    });
  }

  /**
   * Count the transcripts of the latest selection in `active` (see {@link transcriptsInSelection$}):
   * through the whole volume in spatial 3D, on the plane shown in 2D when the dataset's planes slice
   * it.
   */
  private async transcriptsOf(
    active: readonly SelectionSource[],
    progress: (state: TranscriptsInSelection) => void,
    cancelled: () => boolean,
  ): Promise<TranscriptsInSelection> {
    const dataset = this.dataset;
    const meta = dataset?.transcriptTiles;
    if (!dataset || !meta) return { state: 'empty', message: 'This dataset has no transcripts.' };
    const is3d = isSpatialOmics3d(this.ctx.plotType());
    const planes = !is3d && meta.hasZ ? (this.ctx.slicePlanes?.() ?? null) : null;
    const sliced = planes && planes.length > 1 ? planes : null;
    const k = sliced ? Math.max(0, Math.min(sliced.length - 1, this.ctx.zIndex())) : 0;
    const plane = sliced ? { index: k, count: sliced.length } : null;
    const band = sliced ? planeBand(sliced, k) : null;
    // Drawn regions are image shapes: they select on the image, in 2D.
    const eligible = active.filter((s) => !is3d || s !== 'regions');
    const source = eligible[eligible.length - 1] ?? null;
    if (!source) {
      return {
        state: 'empty',
        plane,
        message: is3d
          ? 'Select a cell, or pick a cell type, to list the transcripts in it.'
          : `Select a cell or a region${sliced ? ' on this plane' : ''} to list the transcripts in it.`,
      };
    }

    const obs = dataset.observations;
    const quality = this.ctx.store.currentSpatialView().transcriptQuality === 'all' ? 'all' : 'high';
    const imageRef =
      dataset.volume && !dataset.imageRef
        ? volumeImageRef(dataset.volume, dataset.micronsPerUnit)
        : dataset.imageRef;
    let scope: 'cells' | 'types' | 'regions' = source;
    let label: string;
    let filter: TranscriptFilter;
    let tiles: { tiles: { level: number; gx: number; gy: number }[]; partial: boolean };

    const cellsTarget = async (): Promise<{ mask: Uint8Array; count: number; label: string } | null> => {
      if (source === 'cells') {
        const sel = this.ctx.selectionStore.current();
        if (!sel.count) return null;
        let first = -1;
        if (sel.count === 1) first = sel.mask.indexOf(1);
        const name = first >= 0 ? (obs.ids?.[first] ?? String(first)) : null;
        return {
          mask: sel.mask,
          count: sel.count,
          label: name !== null ? `Cell ${name}` : `${sel.count.toLocaleString()} selected cells`,
        };
      }
      const classes = this.ctx.regionStore.getPickedClasses();
      const column = this.cellTypeColumnOf(dataset, classes);
      if (!column) return null;
      const loaded = await this.port.getColumn(column);
      if (!isCategoricalColumn(loaded)) return null;
      const cells = cellsOfCategories(loaded.codes, loaded.meta.categories, classes);
      if (!cells.count) return null;
      const names =
        classes.length > 3 ? `${classes.slice(0, 3).join(', ')} +${classes.length - 3}` : classes.join(', ');
      return { ...cells, label: `${classes.length > 1 ? 'Cell types' : 'Cell type'}: ${names}` };
    };

    const cells = source === 'regions' ? null : await cellsTarget();
    if (cancelled()) return { state: 'loading' };
    if (cells) {
      label = cells.label;
      filter = { kind: 'cells', mask: cells.mask };
      tiles = tilesAroundCells(
        obs,
        cells.mask,
        this.cellReach(dataset),
        meta.levels,
        meta.bounds,
        tileBudget(meta),
      );
    } else {
      // Picked classes that are no cell type: in 2D, the regions of those classes on the plane.
      if (source === 'types' && is3d) {
        return {
          state: 'empty',
          message: 'The picked classes are not cell types of this dataset: select a cell to list its transcripts.',
        };
      }
      const regions = this.ctx.regionStore.getRegions();
      let chosen: typeof regions;
      if (source === 'regions') {
        chosen = this.ctx.regionStore
          .getSelectedShapeIndices()
          .map((i) => regions[i])
          .filter((r) => !!r);
        label = `${chosen.length} selected region${chosen.length === 1 ? '' : 's'}`;
      } else {
        const classes = new Set(this.ctx.regionStore.getPickedClasses());
        chosen = regions.filter((r) => !!r.label && classes.has(r.label));
        label = `Class: ${[...classes].join(', ')}`;
      }
      const shapes = chosen.flatMap((r) => regionShapes(r));
      if (!shapes.length) {
        return {
          state: 'empty',
          plane,
          message:
            source === 'regions'
              ? 'The selected regions enclose no area.'
              : `No region of those classes${sliced ? ' on this plane' : ''}.`,
        };
      }
      scope = 'regions';
      filter = { kind: 'shapes', shapes, imageRef };
      tiles = tilesUnderShapes(shapes, imageRef, meta.levels, meta.bounds, tileBudget(meta));
    }

    progress({ state: 'loading', scope, label, plane });
    const count = await countTranscripts({
      port: this.port,
      tiles: tiles.tiles,
      quality,
      filter,
      band,
      names: meta.genes ?? null,
      cancelled,
      partial: tiles.partial,
    });
    if (!count) return { state: 'loading' };
    return { state: 'ready', scope, label, plane, ...count };
  }

  /**
   * The categorical column the picked classes are cell types of: the dataset's cell-type column
   * when it holds any of them, else the first categorical column that does; null when none does.
   */
  private cellTypeColumnOf(dataset: SpatialDataset, classes: readonly string[]): string | null {
    if (!classes.length) return null;
    const categorical = dataset.columns.filter((c): c is CategoricalColumnMeta => c.kind === 'categorical');
    const holds = (c: CategoricalColumnMeta) => classes.some((name) => c.categories.includes(name));
    const preferred = cellTypeColumnFor(dataset, this.ctx.store.currentSpatialView());
    const first = categorical.find((c) => c.name === preferred && holds(c)) ?? categorical.find(holds);
    return first?.name ?? null;
  }

  /** How far from a cell's centre its transcripts are looked for, in observation units. */
  private cellReach(dataset: SpatialDataset): number {
    const ref = dataset.imageRef;
    const micronsPerUnit = dataset.micronsPerUnit ?? (ref?.mppX ? ref.mppX * (ref.scale?.[0] ?? 1) : undefined);
    if (micronsPerUnit && micronsPerUnit > 0) return CELL_REACH_MICRONS / micronsPerUnit;
    return typicalCellDiameter(dataset.observations.radius) * 3;
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
      getGeneFilterFailed$: () => this.ctx.napari.geneFilterFailed$?.asObservable() ?? of(false),
      getCells3dStatus$: () => this.ctx.napari.cells3dStatus$?.asObservable() ?? of(null),
      ...(port.getTranscriptTile ? { getTranscriptsInSelection$: () => this.transcriptsInSelection$() } : {}),
      categoryColors: async (name: string) => {
        const column = await port.getColumn(name);
        if (!isCategoricalColumn(column)) {
          throw new Error(`[spatial] column "${name}" is continuous — it has no categories`);
        }
        // Resolved by the SAME function the renderer uses, so a legend swatch
        // can never disagree with the colour on screen.
        return categoryColorsFor(name, column.meta, this.ctx.store.currentSpatialView().groupColors);
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
          colors: categoryColorsFor(name, column.meta, this.ctx.store.currentSpatialView().groupColors),
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
          // section, not the whole depth of brain standing behind them. Likewise over
          // one of a region set's planes: the cells nearest it.
          const planes = !volume ? this.ctx.planes?.() : null;
          selection = selectInRegions(
            dataset.observations,
            volume ? volumeImageRef(volume, dataset.micronsPerUnit) : dataset.imageRef,
            this.ctx.regionStore.getRegions(),
            volume
              ? observationsInSlice(dataset.observations, volume, this.ctx.zIndex())
              : planes
                ? observationsOnPlane(dataset.observations, planes, this.ctx.zIndex())
                : undefined,
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
