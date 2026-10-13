import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { Image } from 'image-js';

import { IImageInfo, IImageMetadata } from './image.contract';
import { Polygon, Region } from '../models/region';
import { PlotType, PlotTypeDescriptor } from './plot-type';
import { ViewerCapabilities } from './capabilities.contract';
import { IRegionOverlay } from './region-overlay.contract';
import { IHistogram } from './channel-histogram-api.contract';
import {
  CanvasToolOptions,
  ColormapNode,
  IWandOptions,
  IBrushOptions,
  SpatialViewState,
  SpatialColorBy,
} from './display-types';
import {
  CategoricalColumnMeta,
  SpatialDataset,
  SpatialEmbedding,
  SpatialMarkerGenes,
  SpatialSelectionMask,
  SpatialTranscriptCounts,
} from './spatial-dataset.contract';
import type { PlotModeViewport } from './plot-type-contribution.contract';

/**
 * Backend-neutral visualization contract. Plotly is one implementation;
 * OpenSeadragon is another (for the image plot type). The abstraction renders
 * data — a raster image OR a scientific plot (heatmap, surface, contour,
 * scatter, line, isosurface) — draws regions on it, and drives on-canvas tools.
 *
 * Split into role interfaces so a consumer can depend only on the slice it
 * uses, then composed into `IVisualizer`.
 */

/** Pixel readback shape returned by `getDisplayedPixelData`. */
export interface PixelData {
  width: number;
  height: number;
  channels: number;
  data: Uint8ClampedArray;
}

/** Intensity sampled along a line ROI (PlotType.LINE over image data). */
export interface IntensityProfile {
  /** Distance along the line. In microns when the image carries a physical
   *  pixel size (mpp); otherwise in image pixels. See {@link unit}. */
  positions: number[];
  /** Sampled intensity (grayscale value or RGB luminance). */
  values: number[];
  /** Unit of {@link positions}: 'µm' when scaled by the image's mpp, else 'px'. */
  unit?: 'µm' | 'px';
  /** Stable id of the line ROI this profile came from (multi-line support). */
  id?: number;
  /** Colour of the line ROI — the inset trace is drawn in the same colour. */
  color?: string;
}

/**
 * What `IDataRenderer.load()` resolves to. Backend-specific beyond `filename`,
 * which names the image the handle was loaded for: the host compares it with the
 * image it asked for, to drop a handle a newer request has overtaken. Pass the
 * handle on to `plot()` unchanged.
 */
export interface LoadedImage {
  readonly filename: string | undefined;
}

/**
 * The render/viewport role: load data, render it (image or plot), and handle
 * zoom, stack navigation, and pixel readback.
 */
export interface IDataRenderer {
  /** Fetch what {@link plot} needs for this image/slice. `signal` aborts when the
   *  host no longer wants the result (a newer image, Cancel, teardown); a backend
   *  may stop its network work then. Optional, and ignored by backends that do
   *  not support it yet. */
  load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<LoadedImage>;
  /** `imageLoaded` is the {@link LoadedImage} handle returned by `load()` (or null
   *  for a draw with no image) — pass it straight through. Resolves false when the
   *  backend could not draw (no plot target, no WebGPU, …). */
  plot(
    plotDiv: string,
    imageLoaded: unknown,
    imageInfo: IImageInfo,
    screenHeight: number,
    plotType: PlotType,
    inPlace?: boolean,
  ): Promise<boolean>;
  /** @deprecated Plotly-specific re-render; the OSD backend no-ops it. The host
   *  re-drives `plot()` from its image stream instead. */
  reloadAndPlot(): void;
  reset(): void;
  relayout(trueImageSize?: number[]): void;
  /**
   * Fit the whole image (or scene) into the view — every backend does: Plotly
   * autoranges its axes, OpenSeadragon goes home, napari-js fits its camera. The
   * backend then emits on {@link getAutoscaleEvent}.
   */
  fitToView(): void;
  /** Reset the view to the image extent. Same intent as {@link fitToView}; kept for
   *  callers of the original name. */
  resetAxes(): void;
  /** @deprecated Use {@link fitToView} — the same operation under its backend-neutral name. */
  autoscale(): void;
  zoomIn(): void;
  zoomOut(): void;
  setDragMode(mode: string | false): void;
  /** @deprecated Use `getOsdViewOptions().setNavigatorVisible()` on `IVisualizer`. */
  setNavigatorVisible(visible: boolean): void;
  /** @deprecated Use `getOsdViewOptions().setImageSmoothingEnabled()` on `IVisualizer`. */
  setImageSmoothingEnabled(enabled: boolean): void;

  setShowStack(showstack: boolean): void;
  setZIndex(zIndex: number): void;
  setStackLoading(stackLoading: boolean): void;
  isStackLoading(): Observable<boolean>;
  getStackLoadingProgress(): Observable<number>;
  /** Cancel any in-flight multi-frame loading (volume-assembly / surface preload) so it stops
   *  fetching more frames and clears the loading state. Optional — only backends that stream a
   *  z-stack (napari-js WebGPU) do real work here; others no-op. */
  cancelLoading?(): void;

  getTrueImageSize(): { width: number; height: number } | null;
  getCurrentImage(): Promise<Image | null>;
  getDisplayedPixelData(): PixelData | null;
  /**
   * The region of the original, full-resolution image that the pixels returned
   * by {@link getDisplayedPixelData} currently cover — `{ x, y, width, height }`
   * in full-image pixel coordinates. When zoomed/panned into a sub-area this is
   * the crop's origin + extent; when zoomed out/panned beyond the edges, the
   * rectangle may extend outside the image bounds (matching the pixel readback
   * canvas). Lets a consumer map displayed-pixel coordinates back to the original
   * image via `origin + displayedPx * (extent / displayedDim)`.
   *
   * Returns `null` when the viewport isn't laid out yet or the backend can't
   * report it — callers should then fall back to the full-image scale (treat
   * the displayed pixels as a downsample of the whole image).
   */
  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null;
  downloadImage(): void;

  setPlotType(plotType: PlotType): void;
  /** @deprecated Use `getVolumeResolution()?.set()` on `IVisualizer`. */
  setResolutionScale?(scale: number): void;
  /** @deprecated Use `getVolumeResolution()?.get()` on `IVisualizer` (this returns 1 without one). */
  getResolutionScale?(): number;
  /** @deprecated Use `getSurface3dControls()?.setSurfaceDragMode()` — 3D scene controls
   *  only exist on a backend that renders 3D plot types; this silently no-ops on OSD. */
  setSurfaceDragMode(mode: string): void;
  /** @deprecated Use `getSurface3dControls()` — see {@link setSurfaceDragMode}. */
  resetSurfaceCamera(): void;

  /** Emits whenever the backend fits the view ({@link fitToView}). */
  getAutoscaleEvent(): Observable<unknown>;

  /** Plot types this backend advertises (drives the UI selector). */
  getPlotTypeDescriptors(): PlotTypeDescriptor[];

  /** Intensity along the line ROIs; emits the full set as any line is added,
   *  moved, or removed (PlotType.LINE). One entry per line ROI. */
  getIntensityProfile$(): Observable<IntensityProfile[]>;

  /** Render the floating intensity-profile inset chart into `divId` from the
   *  given profiles (one trace per line ROI, coloured to match its line).
   *  Owned by the backend so consumers never reach a charting library directly. */
  renderIntensityInset(divId: string, profiles: IntensityProfile[]): void;
}

/** Region/shape state: CRUD, selection, classification colours, GeoJSON I/O. */
export interface IRegionStore {
  setRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
    append?: boolean,
  ): void;
  /** Framework-neutral accessor — the canonical way to read current regions. */
  getRegions(): Region[];
  /** The current regions as polygons (rectangles expanded), for server requests. */
  getRegionPolygons(): Polygon[];
  /** Emits the region set whenever it changes. */
  getRegionUpdateEvent(): Observable<Region[]>;

  setSelectedShapeIndices(indices: number[]): void;
  getSelectedShapeIndices$(): Observable<number[]>;
  /** Select a specific region (by identity), highlighting it on whichever
   *  backend is rendering — Plotly sets its active-shape handles, OpenSeadragon
   *  highlights the SVG element. No-op if the region isn't in the store. */
  selectRegion(region: Region): void;
  deleteActiveShape(): void;

  getShowShapeLabel(): boolean;
  getShapeColor(): string;
  getFillColor(): string;
  getClassificationColors(): Map<string, string>;
  setClassificationColor(label: string, color: string): void;

  /** Undo the most recent region action (jit-ui#85). Restores the region set to
   *  the state before that action; up to a small fixed depth (10) is retained,
   *  so it can be invoked up to 10 times in a row. No-op when nothing is left to
   *  undo. */
  undo(): void;
  /** Re-apply the most recently undone region action. No-op when there's
   *  nothing to redo (any fresh region action clears the redo future). */
  redo(): void;
  /** Synchronous read of {@link getCanUndo$}. */
  canUndo(): boolean;
  /** Synchronous read of {@link getCanRedo$}. */
  canRedo(): boolean;
  /** Emits whether an undo step is currently available — drives the toolbar
   *  Undo button's enabled (greyed-out) state. */
  getCanUndo$(): Observable<boolean>;
  /** Emits whether a redo step is currently available — drives the toolbar
   *  Redo button's enabled (greyed-out) state. */
  getCanRedo$(): Observable<boolean>;
  /** Clear the undo/redo history (e.g. on image load/switch). */
  resetUndoHistory(): void;

  importRegions(geoJsonStr: string): Region[];
  exportRegions(regions: Region[]): void;
  getGeoJsonString(regions: Region[]): string;

  /** Begin a per-slice z-stack region session (jit-ui#93). `slices` maps each
   *  zero-based slice index to that slice's regions; the store shows `initialZ`
   *  live while holding the rest, so scrubbing swaps region sets and edits on a
   *  slice persist. `saveLayout` records how the stack persists — `combined`
   *  (one z-indexed geojson, single-file z-stack) or `per-slice-file` (folder
   *  stack). See {@link setDisplaySlice}, {@link getSliceRegions}. */
  enterStackMode(
    slices: Map<number, Region[]>,
    initialZ?: number,
    saveLayout?: 'combined' | 'per-slice-file',
  ): void;
  /** End the per-slice session (single-plane image, or the stack was closed). */
  exitStackMode(): void;
  /** True while a per-slice z-stack session is active. */
  isStackMode(): boolean;
  /** How the current stack persists to disk (jit-ui#93). */
  getStackSaveLayout(): 'combined' | 'per-slice-file';
  /** Swap the live region set to slice `z` (stack mode only), capturing the
   *  current slice's edits first. Called on every committed slice scrub. */
  setDisplaySlice(z: number): void;
  /** Every slice's regions for save/export, each tagged with its zero-based
   *  {@link Region.z}; the flat set outside stack mode. */
  getSliceRegions(): Region[];
  /** Slices to write on a per-slice-file save (folder stack, jit-ui#93): each
   *  slice with regions, plus slices cleared since load (empty, to overwrite).
   *  Keyed by zero-based slice index; regions tagged with their z. */
  getStackSaveSlices(): Map<number, Region[]>;
}

/** On-canvas tool modes (wand, brush, vertex eraser, zoom-to-box, SAM point). */
export interface IToolController {
  /**
   * Arm one on-canvas tool (`CanvasToolId`) with its options — the wand's
   * {@link IWandOptions}, the brush's {@link IBrushOptions} (`size` is the
   * matrix-pixel diameter of the painted disc), the eraser's `{ radius }` —
   * and disarm the one that was armed. `null`, or any id that is not a canvas
   * tool (a region draw mode such as `'drawrect'`, `'pan'`), disarms only.
   * Arming the armed tool again applies the options and keeps its work in
   * progress.
   */
  setActiveTool(id: string | null, options?: CanvasToolOptions): void;
  /** @deprecated Use `setActiveTool('wand', options)` / `setActiveTool(null)`. */
  setWandMode(active: boolean, options?: IWandOptions): void;
  setWandOptions(options: IWandOptions): void;
  clearActiveWandRegion(): void;
  /** @deprecated Use `setActiveTool('brush', options)` / `setActiveTool(null)`. */
  setBrushMode(active: boolean, options?: IBrushOptions): void;
  setBrushOptions(options: IBrushOptions): void;
  /** @deprecated Use `setActiveTool('eraseVertex', { radius })` / `setActiveTool(null)`. */
  setVertexEraserMode(active: boolean): void;
  setVertexEraserRadius(radius: number): void;
  /** @deprecated Use `setActiveTool('zoomToBox')` / `setActiveTool(null)`. */
  setZoomToBoxMode(active: boolean): void;
  /** Box-prompted SAM segmentation: segment every rectangle region into masks.
   *  Returns the number of mask regions added. (jit-ui#90) */
  segmentRectangles(): Promise<number>;
  /** Cellpose-on-crop: client slide-crop each rectangle and segment cells in it
   *  (cellpose-SAM via the host's CELL_SEGMENTER). Returns regions added. */
  segmentRectanglesCellpose(): Promise<number>;
  /** Choose the registered SAM model the segment tools use (jit-ui#90 P1). */
  setSamModel(id: string): void;
  /** Toggle the interactive SAM point-prompt tool (click = +point, Shift = -).
   *  @deprecated Use `setActiveTool('samPoint')` / `setActiveTool(null)`. */
  setSamPointMode(active: boolean): void;
  /** Finalise / discard the in-progress SAM point object. */
  commitSamPoints(): void;
  clearSamPoints(): void;
}

/**
 * Controls specific to the ISOSURFACE plot type. Optional and capability-gated
 * (`ViewerFeature.Isosurface`): only a backend that renders isosurfaces exposes
 * it, via `IVisualizer.getIsosurfaceControls()`. Kept off the always-on
 * contract so consumers never call a control that's meaningless for the current
 * plot type / backend.
 */
export interface IIsosurfaceControls {
  /** Live-update the isosurface intensity band [isomin, isomax] over 0–255. */
  setIsoRange(isoMin: number, isoMax: number): void;
}

/**
 * Controls specific to the 3D plot types (SURFACE / SCATTER3D / ISOSURFACE
 * scenes). Capability-gated like {@link IIsosurfaceControls}: only a backend
 * that renders 3D scenes exposes it, via `IVisualizer.getSurface3dControls()` —
 * the deprecated top-level `setSurfaceDragMode`/`resetSurfaceCamera` silently
 * no-op on 2D-only backends.
 */
export interface ISurface3dControls {
  /** Switch the 3D scene interaction mode (orbit / turntable / pan / zoom). */
  setSurfaceDragMode(mode: string): void;
  /** Reset the 3D scene camera to its default eye position. */
  resetSurfaceCamera(): void;
  /** Toggle the 3D coordinate-axes / scale gizmo on/off. Optional — only the napari-js WebGPU
   *  volume/isosurface backend renders one (jit-ui#102). */
  setAxesVisible?(visible: boolean): void;
  /** Whether the axes gizmo is currently shown (for initializing the toggle UI). Optional. */
  axesVisible?(): boolean;
  /** Render the surface as a wireframe (edges) instead of a filled surface. Optional — only the
   *  napari-js WebGPU surface backend supports it (jit-ui#102). */
  setWireframe?(on: boolean): void;
  /** Whether the surface is currently drawn as a wireframe (for initializing the toggle UI). */
  wireframe?(): boolean;
}

/**
 * Controls specific to the LINE (intensity-profile) plot type. Capability-gated
 * like {@link IIsosurfaceControls}: only a backend that renders the line-ROI /
 * inset exposes it, via `IVisualizer.getIntensityControls()`.
 */
export interface IIntensityControls {
  /** Add another line ROI (next bright palette colour) and its inset trace.
   *  Returns the created region so the caller can select it on the active
   *  backend, or null if no image extent is known yet. */
  addProfileLine(): Region | null;
}

/** A categorical column resolved for charting: labels, codes and map colours. */
export interface SpatialCategoricalView {
  name: string;
  categories: string[];
  /** `#rrggbb` per category, index-aligned with {@link categories}. */
  colors: string[];
  /** Per-observation category index, or `NO_CATEGORY`. */
  codes: Uint16Array;
}

/**
 * Controls for the SPATIAL_OMICS plot type: what the observation markers are
 * coloured by, and how they are drawn. Capability-gated like
 * {@link IIsosurfaceControls} — `getSpatialControls()` returns null unless a
 * host has bound `SPATIAL_DATA_PORT`.
 *
 * The view state is backend-neutral (it lives in the shared store, like the
 * colormap), so these controls work whichever backend is on screen.
 */
export interface ISpatialControls {
  /** The dataset being visualized, or null. Drives the column/gene pickers and
   *  the legend. */
  getDataset$(): Observable<SpatialDataset | null>;
  /** Current display state (colour source, point scale, opacity, scaling). */
  getViewState$(): Observable<SpatialViewState>;
  /** Synchronous read, for seeding a control's initial value. */
  viewState(): SpatialViewState;
  /** Patch the display state; the markers rebuild without remounting the scene. */
  setViewState(partial: Partial<SpatialViewState>): void;
  /** Colour by an annotation column. Rejects for an unknown column. */
  colorByColumn(name: string): void;
  /** Colour by a gene; its vector is fetched on demand. */
  colorByFeature(name: string): void;
  /** Clear the colour source — every observation renders in one neutral colour. */
  clearColorBy(): void;
  /** Typeahead over feature names, for datasets too wide to inline the list. */
  searchFeatures(query: string, limit?: number): Promise<string[]>;
  /** Per-category display colours for a categorical column, index-aligned with
   *  its `categories` — the legend's swatches, resolved the same way the
   *  renderer resolves them so the two cannot disagree. */
  categoryColors(name: string): Promise<string[]>;

  // ── values, for the 1-D charts ────────────────────────────────────────
  /**
   * The values behind a colour source, index-aligned with the observations.
   * Rejects for a categorical column — there is nothing continuous to chart.
   */
  continuousValues(source: SpatialColorBy): Promise<Float32Array>;
  /**
   * A categorical column's categories, per-observation codes and display
   * colours — everything a grouped violin/box needs, with the colours resolved
   * the same way the map resolves them.
   */
  categoricalView(column: string): Promise<SpatialCategoricalView>;

  /**
   * One embedding's coordinates — a UMAP, t-SNE or PCA plane over the same observations.
   *
   * Optional, and absent when the data source serves none: `SpatialDataPort.getEmbedding`
   * is itself optional, so a panel must be able to ask whether this exists rather than
   * calling it and catching.
   */
  getEmbedding?(name: string): Promise<SpatialEmbedding>;
  /** Names of the categorical columns available to group by. */
  categoricalColumns(): string[];
  /**
   * Import a cell grouping (CSV/TSV of `cell_id`, `group`) as a new categorical column.
   * Optional: only data sources that can join cell ids implement it.
   */
  importGroups?(label: string, table: string): Promise<{ column: CategoricalColumnMeta; matched: number }>;
  /** Transcript totals per gene — for the points estimate. Optional. */
  transcriptCounts?(genes: string[]): Promise<SpatialTranscriptCounts>;
  /** Marker genes of each group of a categorical column. Optional (see the port). */
  markerGenes?(column: string, perGroup?: number): Promise<SpatialMarkerGenes>;
  /** Transcripts of each selected gene in the current view, or null when not known
   *  (all genes at once, transcripts off, or a selection zoomed out on a dataset without the
   *  pyramid's per-gene levels, where clusters are drawn from summed density grids). */
  getGeneCountsInView$?(): Observable<Record<string, number> | null>;
  /** Estimated transcripts in view for the current selection, against the marker budget. */
  getTranscriptEstimate$?(): Observable<{ points: number; max: number } | null>;
  /** The density map's colour window in use (auto-derived or set) and its densest bin. */
  getDensityStats$?(): Observable<{ lo: number; hi: number; max: number } | null>;
  /**
   * The z positions of the sections the dataset was imaged at, ascending — or
   * null when its z is continuous rather than sectioned (so there are no sections
   * to offer) or when there is no dataset.
   *
   * Lets a panel offer "one section at a time" for the 3D cloud only where that
   * means something, and label the chosen one. Scanned once per dataset.
   */
  sampledSections(): Float32Array | null;

  // ── selection ─────────────────────────────────────────────────────────
  /** The current selection. Empty means "nothing selected", in which case the
   *  whole tissue renders normally rather than everything being muted. */
  getSelection$(): Observable<SpatialSelectionMask>;
  /**
   * Select every observation inside the currently-drawn regions (their union).
   * Reuses the existing ROI tools — rectangle, polygon, freehand, wand, brush —
   * so there is no separate marquee to learn. Returns how many were selected.
   */
  selectFromRegions(): number;
  /** Select every observation in one category of a categorical column — the
   *  legend click. Rejects for an unknown or continuous column. */
  selectCategory(column: string, categoryIndex: number): Promise<number>;

  /**
   * Select an explicit set of observations, replacing any current selection.
   *
   * For a linked plot: lassoing points in an embedding is a selection OF observations,
   * and every other view — the map, the distributions — reads the same mask, so brushing
   * one lights up the rest. Returns how many were selected.
   */
  selectIndices(indices: Iterable<number>): number;
  clearSelection(): void;
}

/** Display options (colormap/LUT, reverse scale, image metadata). */
export interface IDisplayOptions {
  getColormap(): Observable<ColormapNode | null>;
  setColormap(colormap: ColormapNode): void;
  getColormapOptions(): ColormapNode[];
  getReverseScale(): Observable<boolean>;
  setReverseScale(reverse: boolean): void;
  /** Publish the current image's metadata. `imageKey` (its file name) lets the
   *  channel state survive a re-plot of the same image but not a switch to another. */
  setImageMeta(imageMeta: IImageMetadata[], imageKey?: string): void;
  getImageMeta(): Observable<IImageMetadata[]>;
}

/**
 * The part of intensity sampling a rendering backend owns: where its view settled.
 * What `IViewerBackend.getIntensitySampling()` returns.
 */
export interface IIntensityViewportSource {
  /** Visible-region changes (image-pixel coords), emitted when the view settles,
   *  so the inset can re-sample at the current zoom. */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }>;
}

/**
 * Intensity-profile sampling (the line ROIs' inset), from `IVisualizer.getIntensitySampling()`.
 * The sampling itself is backend-neutral (the library's IntensityProfileService
 * samples whatever image is on screen); the viewport-change signal comes from the
 * backend that draws the image (OpenSeadragon and napari-js report it; Plotly
 * re-samples its high-def zoom crops inline instead).
 */
export interface IIntensitySampling extends IIntensityViewportSource {
  /** Load the current image/slice's pixels so the line-ROI profiles have data
   *  (a backend with no frames of its own: OpenSeadragon, napari-js). */
  ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void>;
  /** Re-sample the profiles from a fresh crop of the given image-pixel ROI at
   *  display resolution. */
  refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number, zIndex: number): void;
}

/**
 * The 2D view options of a tiled image viewer: the overview navigator and image
 * smoothing. OpenSeadragon's, mirrored by napari-js's 2D views; Plotly has neither.
 * Capability-gated: `IViewerBackend.getOsdViewOptions()` is null on a backend
 * without them.
 */
export interface IOsdViewOptions {
  /** Show/hide the overview navigator (the minimap). Applied when the viewer is
   *  (re)created, and toggled live when one is already mounted. */
  setNavigatorVisible(visible: boolean): void;
  /** Image smoothing (bilinear interpolation). `false` = nearest-neighbour, so
   *  zooming past 1:1 shows crisp pixel blocks (pixel-level inspection). Applied
   *  at viewer creation and live (with a redraw) when one is mounted. */
  setImageSmoothingEnabled(enabled: boolean): void;
}

/**
 * The 3D decimate factor of a volume renderer (napari-js WebGPU): 1 = full
 * resolution … 8 = ⅛ per axis. Capability-gated: null on a backend without one.
 */
export interface IVolumeResolution {
  /** The current factor (to initialize the Resolution control). */
  get(): number;
  /** Set the factor (rounded, at least 1). Takes effect on the next (re)load —
   *  the host re-plots after calling it, since it changes the fetched data. */
  set(scale: number): void;
}

/**
 * The host-facing composite contract, implemented by the router (`VISUALIZER`). A
 * rendering backend implements {@link IViewerBackend} instead.
 */
export interface IVisualizer
  extends IDataRenderer, IRegionStore, IToolController, IDisplayOptions, IIntensitySampling {
  readonly capabilities: ViewerCapabilities;
  /** This backend's region renderer. May be null until a plot is mounted
   *  (OpenSeadragon). Drives region draw/select modes uniformly. */
  getRegionOverlay(): IRegionOverlay | null;
  /** Isosurface controls when this backend advertises `ViewerFeature.Isosurface`,
   *  else null — so consumers gate on the returned object, not a no-op method. */
  getIsosurfaceControls(): IIsosurfaceControls | null;
  /** Intensity (line-ROI) controls when the backend renders the LINE plot type,
   *  else null. */
  getIntensityControls(): IIntensityControls | null;
  /** 3D scene controls when this backend renders 3D plot types, else null —
   *  the capability-gated replacement for the deprecated top-level
   *  `setSurfaceDragMode`/`resetSurfaceCamera`. */
  getSurface3dControls(): ISurface3dControls | null;
  /** The navigator / image-smoothing options. Never null on the router: a setting
   *  applies to every backend that has them (OpenSeadragon, napari-js), so it can
   *  be set before the first render and survives a backend switch. */
  getOsdViewOptions(): IOsdViewOptions;
  /** The 3D decimate factor of the backend on screen, or null when it has none
   *  (only napari-js renders volumes). */
  getVolumeResolution(): IVolumeResolution | null;
  /** Intensity-profile sampling, whichever backend is on screen. */
  getIntensitySampling(): IIntensitySampling;
  /** @deprecated Use `getIntensitySampling().ensureIntensitySampling()`. */
  ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void>;
  /** @deprecated Use `getIntensitySampling().refreshIntensitySamplingForRoi()`. */
  refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number, zIndex: number): void;
  /** @deprecated Use `getIntensitySampling().getViewportChange$()`. */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }>;
  /** Spatial-omics controls when a `SPATIAL_DATA_PORT` is bound, else null.
   *  Optional: only the routing service implements it, since the state is shared
   *  rather than owned by any one backend. */
  getSpatialControls?(): ISpatialControls | null;
  /** The viewport a contributed plot mode draws over, when the backend on
   *  screen can provide one (OpenSeadragon), else null. Optional: backends that
   *  no contributed mode rides on need not implement it. */
  getPlotModeViewport?(): PlotModeViewport | null;
  /** Binned intensity histogram for a channel from the currently-displayed
   *  pixels, or null when none are available. Feeds the Channels & Histogram
   *  pane. */
  getHistogram(channelIndex: number, bins: number): IHistogram | null;
  /** Async histogram stream — native bit depth for >8-bit images (server), else
   *  the 8-bit client histogram. */
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null>;
  /** Export the displayed image, composited with the current display settings,
   *  as a publication-ready PNG download. */
  exportComposite(): void;
  /** Export the underlying image data as a data-preserving multi-band TIFF
   *  (native bit depth). No-op on backends that can't provide it. */
  exportData(): void;
  /**
   * The view is going away (the `<visualizer>` is destroyed): drop what is bound to
   * it — the on-screen viewer, its render loop and view subscriptions — so nothing
   * outlives the view. Service-lifetime state (stores, the backends' own store
   * subscriptions) is untouched, so a later view on the same chain renders normally.
   */
  detach(): void;
  /** @deprecated Use {@link detach}, which this delegates to. */
  unsubscribe(): void;
}

/**
 * What a rendering backend implements (Plotly, OpenSeadragon, napari-js): rendering,
 * the viewport, pixel readback, export, loading state and its on-canvas tools, plus
 * capability-gated getters for what only some backends have.
 *
 * It is the backend-facing half of {@link IVisualizer}. Region and display state are
 * not here: they live in the shared `RegionStore` / `VisualizerStore`, which the router
 * serves to hosts directly; a backend draws them by subscribing to the stores' events.
 * Hosts keep depending on `IVisualizer` (the router's composite), never on a backend.
 */
export interface IViewerBackend extends IToolController {
  readonly capabilities: ViewerCapabilities;

  // ── render lifecycle ──────────────────────────────────────────────────
  load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<LoadedImage>;
  plot(
    plotDiv: string,
    imageLoaded: unknown,
    imageInfo: IImageInfo,
    screenHeight: number,
    plotType: PlotType,
    inPlace?: boolean,
  ): Promise<boolean>;
  reset(): void;
  relayout(trueImageSize?: number[]): void;
  /** The view is going away: release what is bound to it. */
  detach(): void;
  /** Stop streaming frames (volume assembly / surface preload). Optional: only
   *  backends that stream a z-stack do work here. */
  cancelLoading?(): void;

  // ── viewport ─────────────────────────────────────────────────────────
  zoomIn(): void;
  zoomOut(): void;
  setDragMode(mode: string | false): void;
  fitToView(): void;
  /** @see IDataRenderer.resetAxes */
  resetAxes(): void;
  setZIndex(zIndex: number): void;
  setShowStack(showstack: boolean): void;
  /** Emits whenever the backend fits the view. */
  getAutoscaleEvent(): Observable<unknown>;
  isStackLoading(): Observable<boolean>;
  getStackLoadingProgress(): Observable<number>;

  // ── pixels, histogram, export ─────────────────────────────────────────
  getTrueImageSize(): { width: number; height: number } | null;
  getCurrentImage(): Promise<Image | null>;
  getDisplayedPixelData(): PixelData | null;
  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null;
  getHistogram(channelIndex: number, bins: number): IHistogram | null;
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null>;
  downloadImage(): void;
  exportComposite(): void;
  exportData(): void;

  // ── capability-gated surfaces (null / absent where the backend lacks the feature) ──
  getRegionOverlay(): IRegionOverlay | null;
  getIsosurfaceControls(): IIsosurfaceControls | null;
  getSurface3dControls(): ISurface3dControls | null;
  getIntensityControls(): IIntensityControls | null;
  getPlotModeViewport?(): PlotModeViewport | null;
  /** Navigator / image smoothing, or null when the backend has neither (Plotly). */
  getOsdViewOptions(): IOsdViewOptions | null;
  /** The 3D decimate factor, or null when the backend renders no volumes. */
  getVolumeResolution(): IVolumeResolution | null;
  /** Where the view settled, for the intensity inset's re-sampling; null when the
   *  backend re-samples on its own (Plotly's high-def zoom). The sampling itself is
   *  the router's (IntensityProfileService). */
  getIntensitySampling(): IIntensityViewportSource | null;
}

/**
 * What a mounted `<visualizer>` hands its host through
 * `ImageStatePort.setDiagram()` — a small, typed surface rather than the component
 * itself, whose every public member would otherwise be de-facto API. Cleared
 * (`setDiagram(null)`) when the visualizer is destroyed. Hosts that can inject
 * {@link VISUALIZER} / `REGION_EDITOR_API` directly need not use it at all.
 */
export interface VisualizerHandle {
  /** The visualizer chain this `<visualizer>` renders through. */
  readonly visualizer: IVisualizer;
  /** @deprecated Use {@link visualizer}. Kept for hosts that read the component's
   *  former `plotService` field off the registered object. */
  readonly plotService: IVisualizer;
  /** Whether any region (annotation or intensity line) exists on the current image. */
  hasRegions(): boolean;
  /** The current regions as polygons, for a server request (crop / processing). */
  getRegionPolygons(): Polygon[];
}

/**
 * DI token for the active visualization backend. Bind it (`useExisting`) to the
 * `RoutingVisualizerService`, which selects Plotly vs OpenSeadragon per plot
 * type. Consumers — including this library's own `VisualizerComponent` —
 * inject `IVisualizer` through this token rather than the concrete router, so
 * the routing/fallback implementation can change without touching constructors.
 */
export const VISUALIZER = new InjectionToken<IVisualizer>('VISUALIZER');
