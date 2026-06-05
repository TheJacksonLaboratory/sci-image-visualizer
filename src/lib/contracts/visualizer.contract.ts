import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { Image } from 'image-js';

import { IImageInfo, IImageMetadata } from './image.contract';
import { Region } from '../models/region';
import { PlotType, PlotTypeDescriptor } from './plot-type';
import { ViewerCapabilities } from './capabilities.contract';
import { IRegionOverlay } from './region-overlay.contract';
import { IHistogram } from './channel-histogram-api.contract';

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
  plot(plotDiv: string, imageLoaded: any, imageInfo: IImageInfo, screenHeight: number,
       plotType: PlotType, inPlace?: boolean): Promise<boolean>;
  reloadAndPlot(): void;
  reset(): void;
  relayout(trueImageSize?: number[]): void;
  resetAxes(): void;
  autoscale(): void;
  zoomIn(): void;
  zoomOut(): void;
  setDragMode(mode: string | false): void;

  setShowStack(showstack: boolean): void;
  setZIndex(zIndex: number): void;
  setStackLoading(stackLoading: boolean): void;
  isStackLoading(): Observable<boolean>;
  getStackLoadingProgress(): Observable<number>;

  getTrueImageSize(): { width: number; height: number } | null;
  getCurrentImage(): Promise<Image | null>;
  getDisplayedPixelData(): PixelData | null;
  downloadImage(): void;

  setPlotType(plotType: PlotType): void;
  setSurfaceDragMode(mode: string): void;
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

  importRegions(geoJsonStr: string): Region[];
  exportRegions(regions: Region[]): void;
  getGeoJsonString(regions: Region[]): string;
}

/** On-canvas tool modes (wand, vertex eraser, zoom-to-box). */
export interface IToolController {
  setWandMode(active: boolean, options?: any): void;
  setWandOptions(options: any): void;
  clearActiveWandRegion(): void;
  setVertexEraserMode(active: boolean): void;
  setVertexEraserRadius(radius: number): void;
  setZoomToBoxMode(active: boolean): void;
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
  getColormap(): Observable<any>;
  setColormap(colormap: any): void;
  getColormapOptions(): any;
  getReverseScale(): Observable<boolean>;
  setReverseScale(reverscale: any): void;
  setImageMeta(imageMeta: IImageMetadata[]): void;
  getImageMeta(): Observable<IImageMetadata[]>;
}

/** Composite contract a visualization backend implements. */
export interface IVisualizer extends IDataRenderer, IRegionStore, IToolController, IDisplayOptions {
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
  /** Binned intensity histogram for a channel from the currently-displayed
   *  pixels, or null when none are available. Feeds the Channels & Histogram
   *  pane. */
  getHistogram(channelIndex: number, bins: number): IHistogram | null;
  unsubscribe(): void;
}

/**
 * DI token for the active visualization backend. Not wired into providers yet
 * — consumers still inject `PlotlyService` directly. Introduced so the
 * eventual router/factory (Plotly vs OpenSeadragon, per plot type) can be
 * registered centrally without touching consumer constructors.
 */
export const VISUALIZER = new InjectionToken<IVisualizer>('VISUALIZER');
