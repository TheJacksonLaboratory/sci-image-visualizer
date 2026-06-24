import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { Image } from 'image-js';

import { IImageInfo, IImageMetadata } from './image.contract';
import { Region } from '../models/region';
import { PlotType, PlotTypeDescriptor } from './plot-type';
import { ViewerCapabilities } from './capabilities.contract';
import { IRegionOverlay } from './region-overlay.contract';
import { IHistogram } from './channel-histogram-api.contract';
import { ColormapNode, IWandOptions, IBrushOptions } from './display-types';

/**
 * Backend-neutral visualization contract. Plotly is one implementation;
 * OpenSeadragon is another (for the image plot type). The abstraction renders
 * data — a raster image OR a scientific plot (heatmap, surface, contour,
 * scatter, line, isosurface) — draws regions on it, and drives on-canvas tools.
 *
 * Split into role interfaces so a consumer can depend only on the slice it
 * uses, then composed into `IVisualizer`.
 *
 * Types are intentionally permissive (`any` where the current Plotly service
 * is untyped) so `PlotlyService` satisfies the contract without a typing
 * rewrite — tightening is a follow-up, not part of standing the interface up.
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
 * The render/viewport role: load data, render it (image or plot), and handle
 * zoom, stack navigation, and pixel readback.
 */
export interface IDataRenderer {
  load(imageInfo: IImageInfo, zIndex: number): Promise<any>;
  /** `imageLoaded` is the backend-specific handle returned by `load()` —
   *  treat it as opaque and pass it straight through. */
  plot(plotDiv: string, imageLoaded: unknown, imageInfo: IImageInfo, screenHeight: number,
       plotType: PlotType, inPlace?: boolean): Promise<boolean>;
  /** @deprecated Plotly-specific re-render; the OSD backend no-ops it. The host
   *  re-drives `plot()` from its image stream instead. */
  reloadAndPlot(): void;
  reset(): void;
  relayout(trueImageSize?: number[]): void;
  /** @deprecated Plotly-specific (axis reset); the OSD backend no-ops it. Gate
   *  on {@link ViewerCapabilities} before calling. */
  resetAxes(): void;
  /** @deprecated Plotly-specific (autoscale); the OSD backend no-ops it. Gate
   *  on {@link ViewerCapabilities} before calling. */
  autoscale(): void;
  zoomIn(): void;
  zoomOut(): void;
  setDragMode(mode: string | false): void;
  /** Show/hide the overview navigator (the minimap). OpenSeadragon only — Plotly
   *  no-ops it (it has no navigator). Applied when the viewer is (re)created, and
   *  toggled live when one is already mounted. */
  setNavigatorVisible(visible: boolean): void;
  /** Image smoothing (bilinear interpolation). `false` = nearest-neighbour, so
   *  zooming past 1:1 shows crisp pixel blocks (pixel-level inspection).
   *  OpenSeadragon only — Plotly no-ops it. Applied at viewer creation and live
   *  (with a redraw) when one is mounted. */
  setImageSmoothingEnabled(enabled: boolean): void;

  setShowStack(showstack: boolean): void;
  setZIndex(zIndex: number): void;
  setStackLoading(stackLoading: boolean): void;
  isStackLoading(): Observable<boolean>;
  getStackLoadingProgress(): Observable<number>;

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
  /** @deprecated Use `getSurface3dControls()` — 3D scene controls only exist on
   *  a backend that renders 3D plot types; this method silently no-ops on OSD. */
  setSurfaceDragMode(mode: string): void;
  /** @deprecated Use `getSurface3dControls()` — see {@link setSurfaceDragMode}. */
  resetSurfaceCamera(): void;

  getAutoscaleEvent(): Observable<any>;

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
  setRegions(regions: Region[], showRegionLabel?: boolean, isRegionSaveOn?: boolean,
             fillColor?: string, append?: boolean): void;
  /** Framework-neutral accessor — the canonical way to read current regions. */
  getRegions(): Region[];
  getRegionPolygons(): any[];
  getRegionUpdateEvent(): Observable<any[]>;

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

  plotPreviousShapes(): void;
  setPreviousShapes(shapes: any[]): void;
  getPreviousShapes(): any[];

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
}

/** On-canvas tool modes (wand, brush, vertex eraser, zoom-to-box). */
export interface IToolController {
  setWandMode(active: boolean, options?: IWandOptions): void;
  setWandOptions(options: IWandOptions): void;
  clearActiveWandRegion(): void;
  /** Brush region tool. `size` (matrix-pixel diameter) sizes the painted disc. */
  setBrushMode(active: boolean, options?: IBrushOptions): void;
  setBrushOptions(options: IBrushOptions): void;
  setVertexEraserMode(active: boolean): void;
  setVertexEraserRadius(radius: number): void;
  setZoomToBoxMode(active: boolean): void;
  /** Box-prompted SAM segmentation: segment every rectangle region into masks.
   *  Returns the number of mask regions added. (jit-ui#90) */
  segmentRectangles(): Promise<number>;
  /** Cellpose-on-crop: client slide-crop each rectangle and segment cells in it
   *  (cellpose-SAM via the host's CELL_SEGMENTER). Returns regions added. */
  segmentRectanglesCellpose(): Promise<number>;
  /** Choose the registered SAM model the segment tools use (jit-ui#90 P1). */
  setSamModel(id: string): void;
  /** Toggle the interactive SAM point-prompt tool (click = +point, Shift = -). */
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

/** Display options (colormap/LUT, reverse scale, image metadata). */
export interface IDisplayOptions {
  getColormap(): Observable<ColormapNode | null>;
  setColormap(colormap: ColormapNode): void;
  getColormapOptions(): ColormapNode[];
  getReverseScale(): Observable<boolean>;
  setReverseScale(reverscale: any): void;
  setImageMeta(imageMeta: IImageMetadata[]): void;
  getImageMeta(): Observable<IImageMetadata[]>;
}

/**
 * Intensity-profile sampling (PlotType.LINE). The sampling *source* lives in the
 * Plotly backend (it owns pixel readback); OpenSeadragon contributes only the
 * viewport-change signal that drives re-sampling at the current zoom. Each
 * backend implements the part it owns and no-ops the rest — mirroring the
 * deprecated no-op pattern on {@link IDataRenderer} — so the contract is uniform
 * and a consumer can depend on `IVisualizer` alone (no concrete-type reach-in).
 */
export interface IIntensitySampling {
  /** Populate the intensity-sampling cache for the current image/slice so the
   *  line-ROI profiles have pixel data. Real on Plotly; no-op on OSD. */
  ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void>;
  /** Re-sample the profiles from a fresh crop of the given image-pixel ROI at
   *  display resolution. Real on Plotly; no-op on OSD. */
  refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number,
                                 zIndex: number): void;
  /** Visible-region changes (image-pixel coords), emitted when the view settles,
   *  so the inset can re-sample at the current zoom. Real on OSD; empty on Plotly
   *  (its high-def zoom updates the sampling cache inline instead). */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }>;
}

/** Composite contract a visualization backend implements. */
export interface IVisualizer extends IDataRenderer, IRegionStore, IToolController, IDisplayOptions,
  IIntensitySampling {
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
  unsubscribe(): void;
}

/**
 * DI token for the active visualization backend. Bind it (`useExisting`) to the
 * `RoutingVisualizerService`, which selects Plotly vs OpenSeadragon per plot
 * type. Consumers — including this library's own `VisualizationComponent` —
 * inject `IVisualizer` through this token rather than the concrete router, so
 * the routing/fallback implementation can change without touching constructors.
 */
export const VISUALIZER = new InjectionToken<IVisualizer>('VISUALIZER');
