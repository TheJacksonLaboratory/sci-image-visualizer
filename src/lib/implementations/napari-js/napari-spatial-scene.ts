import { Observable, Subscription, combineLatest, of } from 'rxjs';

import { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { ColormapNode, SpatialViewState } from '../../contracts/display-types';
import { ExpressionField, ExpressionVolumeField } from '../../spatial/spatial-expression';
import { SpatialSelectionMask, emptySelection } from '../../spatial/spatial-selection';
import { SpatialSelectionStore } from '../../store/spatial-selection.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { Supersede } from '../../util/supersede';
import { ContrastWindowCache } from './napari-spatial-encoding';
import { SpatialHover } from './napari-spatial-hover';
import { NapariSpatialTileLayers, TranscriptEstimate } from './napari-spatial-tiles';
import { Rgb } from '../../contracts/colormap-lut';
import type { SceneContext } from './napari-scene';

/** What the spatial subscription last saw: the dataset, the view state and the selection. */
export type SpatialLatest = [SpatialDataset | null, SpatialViewState, SpatialSelectionMask];

/** Where the spatial tile layers' panel outputs go (the service's subjects and badge). */
export interface SpatialTileSinks {
  /** The continuous LUT the view is using (so cells coloured by a gene match the markers). */
  continuousLut(view: SpatialViewState): Rgb[];
  estimateChanged(estimate: TranscriptEstimate | null): void;
  geneCountsChanged(counts: Record<string, number> | null): void;
  densityChanged(stats: { lo: number; hi: number; max: number }): void;
  loadingChanged(layers: string[]): void;
}

/** The 2D scene the tile layers currently draw into. */
export interface SpatialTileOwner {
  canvasSize(): [number, number];
  /** Outlines appeared or disappeared: the markers' visibility follows. */
  polygonsShownChanged(): void;
}

/** An estimated field and the inputs it was estimated for. */
export interface FieldCache<T> {
  key: string | null;
  field: T | null;
}

/**
 * The spatial state that outlives a scene (review Appendix B): what the subscription last saw, the
 * memoised percentile windows, the selection revision counter and the estimated gene-map FIELDS —
 * viewer-independent and expensive, so a re-plot recolours the cached field instead of estimating
 * it again. Everything that names a layer of a viewer belongs to the scene instead.
 */
export class SpatialSession {
  /** Latest (dataset, view, selection) the spatial subscription saw — so a slice change can
   *  rebuild the markers for the new plane, and the tile layers and the hover can read it. */
  latest: SpatialLatest | null = null;
  /** Spatial colouring's percentile windows, memoised per coloured vector (SPATIAL-12). */
  readonly contrastWindows = new ContrastWindowCache();
  /** The 2D gene map's field (the expensive half: it survives a recolour and a re-plot). */
  readonly geneMap: FieldCache<ExpressionField> = { key: null, field: null };
  /** The 3D gene map's field. */
  readonly geneMapVolume: FieldCache<ExpressionVolumeField> = { key: null, field: null };
  private lastSelectionSeen: SpatialSelectionMask | null = null;
  private selectionRevision = 0;
  /** Level-of-detail cell outlines, transcripts and density over the 2D view — created on first
   *  use, only when a spatial port is bound, and kept across scenes (its tile caches with it). */
  private tileLayers: NapariSpatialTileLayers | null = null;
  private tileOwner: SpatialTileOwner | null = null;

  constructor(
    readonly port: SpatialDataPort | null,
    readonly selection: SpatialSelectionStore | null,
    private readonly sinks: SpatialTileSinks,
  ) {}

  /** The tile layers, if they were ever built. */
  get tiles(): NapariSpatialTileLayers | null {
    return this.tileLayers;
  }

  /**
   * The tile layers, built on first use (null without a spatial port), now drawing for `owner`.
   * Their host callbacks read the session's live state and the owner's canvas, so they never hold
   * a stale dataset or colormap.
   */
  claimTiles(owner: SpatialTileOwner): NapariSpatialTileLayers | null {
    const port = this.port;
    if (!port) return null;
    this.tileOwner = owner;
    const sinks = this.sinks;
    this.tileLayers ??= new NapariSpatialTileLayers(port, {
      latest: () => this.latest,
      canvasSize: () => this.tileOwner?.canvasSize() ?? [0, 0],
      continuousLut: (view) => sinks.continuousLut(view),
      estimateChanged: (e) => sinks.estimateChanged(e),
      geneCountsChanged: (c) => sinks.geneCountsChanged(c),
      loadingChanged: (layers) => sinks.loadingChanged(layers),
      densityChanged: (d) => sinks.densityChanged(d),
      polygonsShownChanged: () => this.tileOwner?.polygonsShownChanged(),
    });
    return this.tileLayers;
  }

  /** `owner`'s scene is going away: take the tile layers off its viewer. */
  releaseTiles(owner: SpatialTileOwner): void {
    if (this.tileOwner !== owner) return;
    this.tileOwner = null;
    this.tileLayers?.detach();
  }

  /**
   * A revision number for a selection object.
   *
   * The store hands out a NEW mask object per change, so object identity is the
   * cheap and exact way to tell two selections apart — a fingerprint over 3.7M
   * mask bytes would be neither. Counting revisions keeps the cache key a short
   * string.
   */
  selectionRev(selection: SpatialSelectionMask): number {
    if (selection !== this.lastSelectionSeen) {
      this.lastSelectionSeen = selection;
      this.selectionRevision++;
    }
    return this.selectionRevision;
  }

  /**
   * Everything a spatial scene redraws on: the dataset, the view state, the selection — and the
   * display colormap and reverse flag, which are inputs here, not just something read at build
   * time: `continuousColormap: null` means "follow the image's colormap", and a setting that only
   * takes effect at the next unrelated rebuild is not one. Null without a spatial port.
   */
  changes$(
    store: VisualizerStore,
  ): Observable<[SpatialDataset | null, SpatialViewState, SpatialSelectionMask, unknown, boolean]> | null {
    const port = this.port;
    if (!port) return null;
    const selection$ = this.selection?.getSelection$() ?? of(emptySelection());
    return combineLatest([
      port.getDataset$(),
      store.getSpatialView$(),
      selection$,
      store.getColormap(),
      store.getReverseScale(),
    ]);
  }
}

/**
 * What the 2D and 3D spatial scenes share: the subscription that redraws them, the hover over
 * them, and the latest-wins sequencing of their (async) rebuilds.
 */
export abstract class SpatialSceneBase {
  protected readonly hover: SpatialHover;
  /** Latest wins within the scene: a colour fetch is a round-trip, so a fast sequence of
   *  colour-by changes can resolve out of order, and only the newest may touch the layers. */
  protected readonly rebuilds = new Supersede();
  private sub: Subscription | null = null;

  protected constructor(
    protected readonly ctx: SceneContext,
    protected readonly session: SpatialSession,
    is3d: boolean,
  ) {
    this.hover = new SpatialHover({
      is3d,
      viewer: ctx.viewer,
      canvas: ctx.canvas,
      port: session.port,
      selection: session.selection,
      dataset: () => session.latest?.[0] ?? null,
      positions: (obs) => this.hoverPositions(obs),
      depths: () => this.hoverDepths(),
      tiles: () => this.hoverTiles(),
      toolActive: () => !!ctx.tools.regionOverlay?.toolActive,
      outsideZone: (fn) => ctx.outsideZone(fn),
      inZone: (fn) => ctx.inZone(fn),
    });
  }

  /** Rebuild on every dataset, view, selection or colormap change. */
  protected subscribeSpatial(): void {
    this.sub?.unsubscribe();
    this.sub =
      this.session.changes$(this.ctx.store)?.subscribe(([dataset, view, selection, colormap, reverse]) => {
        this.ctx.display.record((colormap as ColormapNode) ?? null, !!reverse);
        // Kept so a slice change can redraw the markers for the new plane, which
        // arrives through setZIndex rather than through any of these streams.
        this.session.latest = [dataset, view, selection];
        // The markers are about to move or change meaning, so both halves of the
        // tooltip — where the points are, and what they are — are stale.
        this.hover.invalidate();
        void this.hover.resolveSource(dataset, view);
        void this.rebuild(dataset, view, selection);
        this.afterChange();
      }) ?? null;
  }

  /** (Re)build the scene's layers for the current dataset + view state. */
  protected abstract rebuild(
    dataset: SpatialDataset | null,
    view: SpatialViewState,
    selection?: SpatialSelectionMask,
  ): Promise<void>;
  /** Run after each rebuild is started (the 2D tile layers refresh here). */
  protected afterChange(): void {
    /* nothing by default */
  }
  /** Where the markers are drawn, for the hit-test (see `SpatialHoverHost.positions`). */
  protected abstract hoverPositions(obs: SpatialDataset['observations']): Float32Array | null;
  protected hoverDepths(): Float32Array | null {
    return null;
  }
  protected hoverTiles(): NapariSpatialTileLayers | null {
    return null;
  }

  /** Stop following the data, drop the hover, and make every rebuild in flight stale. */
  protected disposeSpatial(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    this.rebuilds.cancel();
    this.hover.dispose();
  }
}
