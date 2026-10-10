
import type { Layer, Viewer } from 'napari-js';

import type { Rgb } from '../../contracts/colormap-lut';
import { type SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../contracts/display-types';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';

import { SpatialSelectionMask } from '../../spatial/spatial-selection';
import { DataRect, pixelsPerDataUnit, visibleDataRect } from '../../spatial/lod';

import { CategoricalLookup } from './spatial-tiles/categorical-lookup';
import { LoadTracker, PlanContext } from './spatial-tiles/plan-context';
import { OrderedLayerGroups, TILE_LAYER_ORDER, TileGroup } from './spatial-tiles/layer-groups';
import { TranscriptHover } from './spatial-tiles/transcript-hover';
import { CellLayers } from './spatial-tiles/cell-layers';
import { TranscriptLayers } from './spatial-tiles/transcript-layers';
import { TranscriptJobPlanner } from './spatial-tiles/transcript-jobs';
import {
  DensityLayer, DensityStats, TranscriptEstimate, TranscriptEstimator,
} from './spatial-tiles/density-layer';

export type { TranscriptEstimate } from './spatial-tiles/density-layer';

/**
 * Level-of-detail cell outlines, transcripts and transcript density for the 2D spatial view.
 *
 * WHY A SEPARATE CLASS
 * --------------------
 * Everything else the spatial view draws is built once per (dataset, view) and only
 * restyled afterwards. These layers also depend on the CAMERA: which tiles are on screen
 * and which level of detail the zoom calls for. Keeping that loop — plan on camera idle,
 * fetch tiles, merge, draw — out of the visualizer service keeps both readable.
 *
 * LAYER ORDER
 * -----------
 * napari-js's layer list is append-only (add / remove / clear), so order is kept by
 * re-adding: cell fill, cell outline, the transcript density, then transcripts on top. Each
 * removal disposes the layer's GPU visual (re-uploaded on the next frame), so a plan restores
 * the order once, after all its groups are in place, and moves only the layers that are out
 * of place ({@link restoreOrder}). `LayerList.move` in napari-js would remove the re-upload.
 * The service's observation markers sit under all of them; while outlines are drawn the
 * markers are hidden (a cell is its outline then, not a dot), so the cells never have to
 * be ordered against them. The density goes OVER the markers on purpose: under 10^5
 * dots it would only show in the gaps between cells. {@link afterObservations} restores
 * the order after the service re-adds its markers.
 *
 * ONE LAYER PER GROUP
 * -------------------
 * Each group is one merged layer over every visible tile, rebuilt when the tile set or
 * level changes. Recolouring (a new cell-type column, a selection) only rewrites the
 * per-shape values — the geometry is not re-expanded.
 */
export interface SpatialTileHost {
  /** Latest dataset/view/selection, as the spatial subscription saw them. */
  latest(): [SpatialDataset | null, SpatialViewState, SpatialSelectionMask] | null;
  /** Canvas size in CSS pixels. */
  canvasSize(): [number, number];
  /** The continuous LUT the view is using (so cells coloured by a gene match the markers). */
  continuousLut(view: SpatialViewState): Rgb[];
  /** Outlines appeared or disappeared: the markers' visibility follows. */
  polygonsShownChanged(shown: boolean): void;
  /** The density window changed (auto-derived or set). */
  densityChanged?(stats: DensityStats): void;
  /** Estimated transcripts in view for the current selection, against the budget. */
  estimateChanged?(estimate: TranscriptEstimate | null): void;
  /** Transcripts of each selected gene inside the view, or null when not known. */
  geneCountsChanged?(counts: Record<string, number> | null): void;
  /** The layers whose data is in flight now ("Transcripts", "Cells"…); empty when none. */
  loadingChanged?(layers: string[]): void;
}

const CAMERA_IDLE_MS = 120;
/** First retry of a view with a failed tile; doubles each time, up to MAX_TILE_RETRIES. */
const TILE_RETRY_MS = 1000;
const MAX_TILE_RETRIES = 3;

export class NapariSpatialTileLayers {
  private viewer: Viewer | null = null;
  private cameraOff: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive retries of an incomplete view. */
  private tileRetries = 0;
  private token = 0;
  /** The overlays' layers, one per group, in their fixed order. */
  private readonly groups = new OrderedLayerGroups<TileGroup>(TILE_LAYER_ORDER);

  /** Loads in flight, per layer label, for the loading badge. */
  private readonly loads = new LoadTracker((labels) => this.host.loadingChanged?.(labels));

  private readonly lookup: CategoricalLookup;
  private readonly jobs: TranscriptJobPlanner;
  private readonly density: DensityLayer;
  private readonly cells: CellLayers;
  private readonly estimator: TranscriptEstimator;
  private readonly hover: TranscriptHover;
  private readonly transcripts: TranscriptLayers;

  constructor(port: SpatialDataPort, private readonly host: SpatialTileHost) {
    this.lookup = new CategoricalLookup(port);
    this.jobs = new TranscriptJobPlanner(port);
    this.cells = new CellLayers(port, this.groups, this.lookup, host);
    this.density = new DensityLayer(port, this.groups, (stats) => host.densityChanged?.(stats));
    this.estimator = new TranscriptEstimator(port, (estimate) => host.estimateChanged?.(estimate));
    this.hover = new TranscriptHover(port, () => this.groups.shown('transcripts'));
    this.transcripts = new TranscriptLayers(this.groups, this.jobs, this.lookup, this.hover);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────

  attach(viewer: Viewer): void {
    if (this.viewer === viewer) return;
    this.detach();
    this.viewer = viewer;
    this.groups.attach(viewer);
    this.cameraOff = viewer.camera.changed.connect(() => this.schedule());
  }

  /**
   * Transcripts of each selected gene inside `rect`: each entry counts for the transcripts it
   * stands for (an aggregate at a coarse level holds several). Null without per-gene data.
   */
  geneCountsIn(rect: DataRect): Record<string, number> | null {
    return this.transcripts.geneCountsIn(rect);
  }

  /**
   * Tooltip lines for the transcript marker under world point `(wx, wy)`, or null; the
   * server's details arrive through `onDetails` once the pointer rests (see TranscriptHover).
   */
  hoverAt(wx: number, wy: number, radiusWorld: number, onDetails: (lines: string[]) => void): string[] | null {
    return this.hover.hoverAt(wx, wy, radiusWorld, onDetails);
  }

  /** Whether `layer` is one of the overlays drawn here (density, cells, transcripts). */
  owns(layer: Layer): boolean {
    return this.groups.owns(layer);
  }

  detach(): void {
    this.hover.dispose();
    this.cameraOff?.();
    this.cameraOff = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.token++;
    this.tileRetries = 0;
    this.transcripts.detached();
    this.loads.clear();
    this.groups.detach();
    this.cells.detached();
    this.viewer = null;
  }

  /** True while outlines are on screen — the service hides its dots then. */
  get outlinesShown(): boolean {
    return this.cells.outlinesShown;
  }

  /** The density window in use and the densest bin, for the panel's threshold control. */
  get densityStats(): DensityStats | null {
    return this.density.stats;
  }

  /** Dataset, view or selection changed: re-plan now rather than on camera idle. */
  refresh(): void {
    this.schedule(0);
  }

  /** Called right after the service adds its marker layer: everything goes back on top. */
  afterObservations(): void {
    this.groups.restoreOrder(true);
  }

  // ── planning ──────────────────────────────────────────────────────────────────────

  private schedule(delay = CAMERA_IDLE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.plan().catch((err) => console.warn('[napari-js] spatial tile plan failed', err));
    }, delay);
  }

  private async plan(): Promise<void> {
    const viewer = this.viewer;
    const latest = this.host.latest();
    if (!viewer || !latest) return;
    const [dataset, view, selection] = latest;
    const token = ++this.token;
    const ctx = new PlanContext(() => token !== this.token || this.viewer !== viewer, this.loads);

    if (!dataset) {
      this.groups.dropAll();
      this.cells.drop();
      return;
    }
    const [w, h] = this.host.canvasSize();
    const ref = dataset.imageRef;
    const rect = visibleDataRect(viewer.camera.center, viewer.camera.zoom, w, h, ref);
    const pxPerUnit = pixelsPerDataUnit(viewer.camera.zoom, ref);
    if (!rect) return;

    this.estimator.plan(dataset, view, viewer, w, h, ctx)
      .catch((err) => console.warn('[napari-js] transcript estimate failed', err));
    // A group whose request failed (a column, a feature vector, a density grid) leaves the
    // others drawn and marks the plan incomplete, so it is retried like a failed tile.
    const settle = (group: string, work: Promise<void>) => work.catch((err) => {
      console.warn(`[napari-js] spatial ${group} plan failed`, err);
      ctx.markIncomplete();
    });
    await Promise.all([
      settle('density', this.density.plan(dataset, view, ctx)),
      settle('cells', this.cells.plan(dataset, view, selection, rect, pxPerUnit, ctx)),
      settle('transcripts', this.transcripts.plan(dataset, view, rect, pxPerUnit, ctx)),
    ]);
    this.groups.restoreOrder(false);
    if (ctx.stale()) return;
    this.host.geneCountsChanged?.(this.transcripts.geneCountsIn(rect));
    // A tile that failed left a hole the cache keys do not record, so try the same view
    // again, backing off, a bounded number of times.
    if (!ctx.incomplete) {
      this.tileRetries = 0;
    } else if (this.tileRetries < MAX_TILE_RETRIES) {
      this.schedule(TILE_RETRY_MS * 2 ** this.tileRetries++);
    }
  }

}
