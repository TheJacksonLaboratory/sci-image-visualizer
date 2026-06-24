import { Inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Image } from 'image-js';

import { IImageInfo, IImageMetadata } from './contracts/image.contract';
import { Region } from './models/region';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import { PlotType, PlotTypeDescriptor } from './contracts/plot-type';
import { IVisualizer, PixelData, IntensityProfile, IIsosurfaceControls, IIntensityControls, ISurface3dControls } from './contracts/visualizer.contract';
import { ViewerCapabilities } from './contracts/capabilities.contract';
import { IRegionOverlay } from './contracts/region-overlay.contract';
import { IRegionEditorApi } from './contracts/region-editor-api.contract';
import { IChannelHistogramApi, IChannelState, IHistogram } from './contracts/channel-histogram-api.contract';
import { VisualizerStore } from './store/visualizer-store.service';
import { NapariVisualizerService } from './implementations/napari-js/napari-visualizer.service';
import { VIZ_CONFIG, VizConfig } from './contracts/viz-config';

/**
 * Backend selector. Routes per plot type:
 *  - the **Image** plot type renders through OpenSeadragon — a natively-tiled,
 *    zoomable raster backed by the jit-service tile endpoints. It's the default
 *    view and supports the region overlay/tools and (for grayscale) the
 *    colormap, applied client-side via the tile pixel pipeline.
 *  - every other plot type (heatmap, surface, contour, scatter, line,
 *    scatter3d, isosurface) renders through Plotly.
 *
 * Only the **render + viewport** path is routed. Region state, display options
 * (colormap/LUT), and the long-lived observables always live in Plotly (the
 * shared store) so both backends stay in sync; OSD reads them to drive its own
 * overlay and tile recoloring.
 *
 * The Image type renders through OpenSeadragon; a failed OSD load falls back to
 * Plotly for that image only (see `osdFellBack`) so it still renders.
 */
/** Intensity-profile line ROIs are owned by the intensity tool, not the editor.
 *  Package-internal predicate (property-based so it also matches plain objects
 *  after a drag round-trip). */
function isProfileRegion(r: any): boolean {
  return r?.kind === 'profile';
}

/** Saturation-based auto-window: pick [min,max] so ~`saturation` of pixels clip
 *  at each end of the histogram. A dominant first/last bin (unscanned padding /
 *  clipped background) is dropped so it doesn't skew the range. */
function autoWindowFromHistogram(h: IHistogram, saturation: number): [number, number] {
  const counts = h.counts.slice();
  const n = counts.length;
  if (n === 0) return [0, 255];
  if (n > 2 && counts[0] > counts[1]) counts[0] = 0;
  if (n > 2 && counts[n - 1] > counts[n - 2]) counts[n - 1] = 0;
  let total = 0;
  for (const c of counts) total += c;
  if (total <= 0) return [0, 255];
  const target = total * Math.max(0, Math.min(0.5, saturation));
  let acc = 0;
  let min = h.bins[0];
  for (let i = 0; i < n; i++) {
    acc += counts[i];
    if (acc > target) { min = h.bins[i]; break; }
  }
  acc = 0;
  let max = h.bins[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    acc += counts[i];
    if (acc > target) { max = h.bins[i]; break; }
  }
  return [min, max];
}

@Injectable({ providedIn: 'root' })
export class RoutingVisualizerService implements IVisualizer, IRegionEditorApi, IChannelHistogramApi {

  private currentPlotType: PlotType = PlotType.IMAGE;
  private lastRendered: IVisualizer | null = null;
  /** OSD failed for the *current* render cycle (e.g. a fresh file still caching
   *  past the deadline) → fall back to Plotly for this image only. Reset by
   *  reset() at the start of every render cycle, so the next file — or a
   *  re-select once the file is cached — retries OSD. (Was a permanent flag,
   *  which left the whole session stuck on Plotly after one slow load.) */
  private osdFellBack = false;
  /** napari-js failed for the current render cycle → fall back to OSD (then Plotly).
   *  Reset by reset() at the start of every cycle, like {@link osdFellBack}. */
  private napariFellBack = false;

  constructor(private plotly: PlotlyService,
              private osd: OpenSeadragonVisualizerService,
              private napari: NapariVisualizerService,
              private store: VisualizerStore,
              @Inject(VIZ_CONFIG) private config: VizConfig) {}

  private isImageType(t: PlotType): boolean {
    return t === PlotType.IMAGE;
  }

  /** The explicit WebGPU napari-js plot types (jit-ui#102) — always route to napari-js. */
  private isNapariType(t: PlotType): boolean {
    return (
      t === PlotType.NAPARI_IMAGE ||
      t === PlotType.NAPARI_VOLUME ||
      t === PlotType.NAPARI_ISOSURFACE
    );
  }

  /** Backend to attempt for the image plot type this render (OSD unless OSD
   *  already fell back this cycle). */
  private imageBackend(): IVisualizer {
    // Explicit napari-js plot types (the user picked one in the dropdown) → napari-js,
    // falling back to Plotly only if it fails to load.
    if (this.isNapariType(this.currentPlotType)) {
      return this.napariFellBack ? this.plotly : this.napari;
    }
    if (this.isImageType(this.currentPlotType)) {
      // Opt-in WebGPU napari-js backend (jit-ui#102), with OSD then Plotly as fallbacks.
      if (this.config.useNapariRenderer && !this.napariFellBack) return this.napari;
      if (!this.osdFellBack) return this.osd;
    }
    return this.plotly;
  }

  /** Backend currently on screen — what ongoing zoom/tool/region ops act on. */
  private renderer(): IVisualizer {
    return this.lastRendered ?? this.plotly;
  }

  // System capabilities are Plotly's (the full-featured backend) so the UI
  // keeps offering every plot type regardless of which one is on screen.
  get capabilities(): ViewerCapabilities { return this.plotly.capabilities; }

  // ── render / viewport → active renderer ──────────────────────────────
  async load(imageInfo: IImageInfo, zIndex: number): Promise<any> {
    const backend = this.imageBackend();
    if (backend === this.napari) {
      try {
        return await this.napari.load(imageInfo, zIndex);
      } catch (err) {
        // napari-js couldn't load → fall back to OSD (then Plotly) for THIS image.
        console.warn('[visualizer] napari-js load failed — falling back to OpenSeadragon.', err);
        this.napariFellBack = true;
        return this.loadViaOsdThenPlotly(imageInfo, zIndex);
      }
    }
    if (backend === this.osd) {
      return this.loadViaOsdThenPlotly(imageInfo, zIndex);
    }
    return this.plotly.load(imageInfo, zIndex);
  }

  /** Try OSD; on failure fall back to Plotly for this image (not permanent — see reset()). */
  private async loadViaOsdThenPlotly(imageInfo: IImageInfo, zIndex: number): Promise<any> {
    try {
      return await this.osd.load(imageInfo, zIndex);
    } catch (err) {
      console.warn('[visualizer] OpenSeadragon load failed — falling back to Plotly for this image.', err);
      this.osdFellBack = true;
      return this.plotly.load(imageInfo, zIndex);
    }
  }
  plot(plotDiv: string, imageLoaded: any, imageInfo: IImageInfo, screenHeight: number,
       plotType: PlotType, inPlace?: boolean): Promise<boolean> {
    this.currentPlotType = plotType;
    // Apply the per-image region cache (snapshot old regions, restore the new
    // image's, clear selection) for whichever backend renders — Plotly does
    // this inside its own plot(), but OSD doesn't, so drive it here. Idempotent
    // for the same image, so it's safe to call on every (re)plot.
    this.plotly.setActiveImage(imageInfo);
    const next = this.imageBackend();
    // Both backends share the same div — tear down the outgoing one on switch.
    // Plotly must be *purged* (not reset, which re-draws empty axes) before OSD
    // takes the div.
    if (this.lastRendered && this.lastRendered !== next) {
      if (this.lastRendered === this.plotly) this.plotly.purgePlot();
      else this.lastRendered.reset();
    }
    this.lastRendered = next;
    return next.plot(plotDiv, imageLoaded, imageInfo, screenHeight, plotType, inPlace);
  }
  reloadAndPlot(): void { this.plotly.reloadAndPlot(); }
  reset(): void {
    // Start of a render cycle: re-enable napari-js/OSD attempts (clear any prior
    // per-image fallback) and tear down whatever's on screen.
    this.osdFellBack = false;
    this.napariFellBack = false;
    this.renderer().reset();
  }
  relayout(trueImageSize?: number[]): void { this.renderer().relayout(trueImageSize); }
  resetAxes(): void { this.renderer().resetAxes(); }
  autoscale(): void { this.renderer().autoscale(); }
  zoomIn(): void { this.renderer().zoomIn(); }
  zoomOut(): void { this.renderer().zoomOut(); }
  setDragMode(mode: string | false): void { this.renderer().setDragMode(mode); }
  // Set on both backends (not just the active renderer): consumers call this
  // before the first render, when `renderer()` is still the Plotly default, so
  // OSD must receive the flag to honour it at viewer creation.
  setNavigatorVisible(visible: boolean): void {
    this.osd.setNavigatorVisible(visible);
    this.plotly.setNavigatorVisible(visible);
  }
  // Set on both backends (see setNavigatorVisible): consumers may set it before
  // the first render, when the active renderer is still Plotly.
  setImageSmoothingEnabled(enabled: boolean): void {
    this.osd.setImageSmoothingEnabled(enabled);
    this.plotly.setImageSmoothingEnabled(enabled);
  }
  setShowStack(showstack: boolean): void { this.renderer().setShowStack(showstack); }
  setZIndex(zIndex: number): void { this.renderer().setZIndex(zIndex); }
  getTrueImageSize(): { width: number; height: number } | null { return this.renderer().getTrueImageSize(); }
  getCurrentImage(): Promise<Image | null> { return this.renderer().getCurrentImage(); }
  getDisplayedPixelData(): PixelData | null { return this.renderer().getDisplayedPixelData(); }
  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    return this.renderer().getDisplayedSourceRect();
  }
  downloadImage(): void { this.renderer().downloadImage(); }
  exportComposite(): void { this.renderer().exportComposite(); }

  setPlotType(plotType: PlotType): void {
    this.currentPlotType = plotType;
    this.plotly.setPlotType(plotType);
  }
  setSurfaceDragMode(mode: string): void { this.renderer().setSurfaceDragMode(mode); }
  resetSurfaceCamera(): void { this.renderer().resetSurfaceCamera(); }
  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    // Plotly enumerates the full PLOT_TYPE_DESCRIPTORS map, which already includes the
    // napari-js WebGPU types (jit-ui#102) — so this single source covers them (no duplicates).
    return this.plotly.getPlotTypeDescriptors();
  }

  // ── long-lived observables + stack flags → Plotly (stable subscriptions) ──
  setStackLoading(b: boolean): void { this.plotly.setStackLoading(b); }
  isStackLoading(): Observable<boolean> { return this.plotly.isStackLoading(); }
  getStackLoadingProgress(): Observable<number> { return this.plotly.getStackLoadingProgress(); }
  getAutoscaleEvent(): Observable<any> { return this.plotly.getAutoscaleEvent(); }
  getIntensityProfile$(): Observable<IntensityProfile[]> { return this.plotly.getIntensityProfile$(); }
  // The intensity inset is a Plotly LINE chart — render it through Plotly, which
  // owns the profile stream regardless of which backend draws the main image.
  renderIntensityInset(divId: string, profiles: IntensityProfile[]): void {
    this.plotly.renderIntensityInset(divId, profiles); }

  // ── regions → active renderer ────────────────────────────────────────
  // Region *state* lives in the shared RegionStore; both backends implement
  // IRegionStore by delegating to it. We route through the active renderer
  // (not hardcoded Plotly) so the backend on screen also *renders* the change:
  // Plotly relayouts its shapes, OpenSeadragon's overlay redraws from the store
  // update event. Either way the same store is the single source of truth.
  setRegions(regions: Region[], showRegionLabel?: boolean, isRegionSaveOn?: boolean,
             fillColor?: string, append?: boolean): void {
    this.renderer().setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
  }
  getRegions(): Region[] { return this.renderer().getRegions(); }
  getRegionPolygons(): any[] { return this.renderer().getRegionPolygons(); }
  getRegionUpdateEvent(): Observable<any[]> { return this.renderer().getRegionUpdateEvent(); }
  setSelectedShapeIndices(indices: number[]): void { this.renderer().setSelectedShapeIndices(indices); }
  selectRegion(region: Region): void { this.renderer().selectRegion(region); }
  getSelectedShapeIndices$(): Observable<number[]> { return this.renderer().getSelectedShapeIndices$(); }
  deleteActiveShape(): void { this.renderer().deleteActiveShape(); }
  getShowShapeLabel(): boolean { return this.renderer().getShowShapeLabel(); }
  getShapeColor(): string { return this.renderer().getShapeColor(); }
  getFillColor(): string { return this.renderer().getFillColor(); }
  getClassificationColors(): Map<string, string> { return this.renderer().getClassificationColors(); }
  setClassificationColor(label: string, color: string): void {
    this.renderer().setClassificationColor(label, color); }
  plotPreviousShapes(): void { this.renderer().plotPreviousShapes(); }
  setPreviousShapes(shapes: any[]): void { this.renderer().setPreviousShapes(shapes); }
  getPreviousShapes(): any[] { return this.renderer().getPreviousShapes(); }
  // Undo state is owned by the shared RegionStore (same instance for both
  // backends), so routing through the active renderer is safe and stable.
  undo(): void { this.renderer().undo(); }
  redo(): void { this.renderer().redo(); }
  canUndo(): boolean { return this.renderer().canUndo(); }
  canRedo(): boolean { return this.renderer().canRedo(); }
  getCanUndo$(): Observable<boolean> { return this.renderer().getCanUndo$(); }
  getCanRedo$(): Observable<boolean> { return this.renderer().getCanRedo$(); }
  resetUndoHistory(): void { this.renderer().resetUndoHistory(); }
  importRegions(geoJsonStr: string): Region[] { return this.renderer().importRegions(geoJsonStr); }
  exportRegions(regions: Region[]): void { this.renderer().exportRegions(regions); }
  getGeoJsonString(regions: Region[]): string { return this.renderer().getGeoJsonString(regions); }

  /** Authoritative full-resolution image size for mask export. Prefers the
   *  active renderer's reported size, falling back to the image metadata (x/y
   *  are the full-res pixel dimensions used across the app). Rejects non-finite
   *  or non-positive sizes — the Plotly bounds can yield NaN before a plot is
   *  fully laid out, which would otherwise crash mask creation. */
  getMaskImageSize(): { width: number; height: number } | null {
    const valid = (s: { width: number; height: number } | null | undefined) =>
      s && Number.isFinite(s.width) && Number.isFinite(s.height) &&
      s.width >= 1 && s.height >= 1
        ? { width: Math.round(s.width), height: Math.round(s.height) }
        : null;

    const fromRenderer = valid(this.getTrueImageSize());
    if (fromRenderer) return fromRenderer;

    let meta: IImageMetadata[] = [];
    this.getImageMeta().subscribe((m) => (meta = m)).unsubscribe();
    const m0 = meta?.[0];
    return m0 ? valid({ width: m0.x, height: m0.y }) : null;
  }

  // ── IRegionEditorApi: annotation-only surface for the Region Editor ───
  // Intensity-profile lines (kind='profile') belong to the intensity tool, not
  // the editor. These methods give external consumers an annotation-only view
  // and guarantee profile lines are preserved. Routing (not the store) owns this
  // so writes/selection go through renderer() and the active backend re-renders
  // (Plotly relayouts its shapes in setRegions; it doesn't on regionUpdate$).

  getAnnotationRegions(): Region[] {
    return this.renderer().getRegions().filter((r) => !isProfileRegion(r));
  }
  setAnnotationRegions(regions: Region[], showRegionLabel?: boolean,
                       isRegionSaveOn?: boolean, fillColor?: string): void {
    // Re-append the store's profile lines so an editor save/delete can't drop
    // them, then route through setRegions so the active backend re-renders.
    const profiles = this.renderer().getRegions().filter((r) => isProfileRegion(r));
    const annotations = (regions || []).filter((r) => !isProfileRegion(r));
    this.setRegions([...annotations, ...profiles], showRegionLabel, isRegionSaveOn, fillColor, false);
  }
  getSelectedRegions$(): Observable<Region[]> {
    // Map the internal index-based selection to the selected annotation regions.
    return this.getSelectedShapeIndices$().pipe(
      map((idxs) => {
        const regs = this.renderer().getRegions();
        return idxs
          .map((i) => regs[i])
          .filter((r): r is Region => !!r && !isProfileRegion(r));
      }),
    );
  }
  setSelectedRegions(regions: Region[]): void {
    const regs = this.renderer().getRegions();
    const indices = (regions || [])
      .map((r) => regs.findIndex((x) => x.id === r.id))
      .filter((i) => i >= 0);
    this.setSelectedShapeIndices(indices);
  }

  // ── tools → active renderer (run on either backend) ─────────────────
  // The wand, vertex eraser and zoom-to-box are implemented on both backends
  // via ICoordinateTransform (+ a viewport pixel readback for the wand), so they
  // follow the active renderer.
  setWandMode(active: boolean, options?: any): void { this.renderer().setWandMode(active, options); }
  setWandOptions(options: any): void { this.renderer().setWandOptions(options); }
  clearActiveWandRegion(): void { this.renderer().clearActiveWandRegion(); }
  setBrushMode(active: boolean, options?: any): void { this.renderer().setBrushMode(active, options); }
  setBrushOptions(options: any): void { this.renderer().setBrushOptions(options); }
  setVertexEraserMode(active: boolean): void { this.renderer().setVertexEraserMode(active); }
  setVertexEraserRadius(radius: number): void { this.renderer().setVertexEraserRadius(radius); }
  setZoomToBoxMode(active: boolean): void { this.renderer().setZoomToBoxMode(active); }
  segmentRectangles(): Promise<number> { return this.renderer().segmentRectangles(); }
  segmentRectanglesCellpose(): Promise<number> { return this.renderer().segmentRectanglesCellpose(); }
  setSamModel(id: string): void { this.renderer().setSamModel(id); }
  setSamPointMode(active: boolean): void { this.renderer().setSamPointMode(active); }
  commitSamPoints(): void { this.renderer().commitSamPoints(); }
  clearSamPoints(): void { this.renderer().clearSamPoints(); }

  // ── display options ──────────────────────────────────────────────────
  // State lives in the shared VisualizerStore — reads go straight to it.
  // The two SETTERS still route through Plotly because its implementations
  // carry render glue beyond the store write (a live Plotly.restyle of
  // colorscale/reversescale on the mounted heatmap); OSD recolors via its own
  // store subscription either way.
  getColormap(): Observable<any> { return this.store.getColormap(); }
  setColormap(colormap: any): void { this.plotly.setColormap(colormap); }
  getColormapOptions(): any { return this.store.getColormapOptions(); }
  getReverseScale(): Observable<boolean> { return this.store.getReverseScale(); }
  setReverseScale(reverscale: any): void { this.plotly.setReverseScale(reverscale); }
  setImageMeta(imageMeta: IImageMetadata[]): void { this.store.setImageMeta(imageMeta); }
  getImageMeta(): Observable<IImageMetadata[]> { return this.store.getImageMeta(); }

  // ── IChannelHistogramApi: Channels & Histogram pane surface ───────────
  // Channel/grayscale/invert state lives in the shared VisualizerStore; both
  // backends subscribe and recolor live, so setters just write the store. The
  // histogram comes from whichever backend is on screen (its native pixels).
  getHistogram(channelIndex: number, bins: number): IHistogram | null {
    return this.renderer().getHistogram(channelIndex, bins);
  }
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null> {
    return this.renderer().getHistogram$(channelIndex, bins);
  }
  /** Export the underlying data (16-bit multi-band TIFF) via the active backend. */
  exportData(): void { this.renderer().exportData(); }
  getChannels$(): Observable<IChannelState[]> { return this.store.getChannelStates(); }
  setChannelState(index: number, partial: Partial<IChannelState>): void {
    this.store.setChannelState(index, partial);
  }
  resetContrast(indices: number[]): void {
    // Full reset: window (0..255), gamma (1) AND the channel's default tint.
    for (const i of indices) this.store.resetChannelState(i);
  }
  /** Auto-window each channel by saturating `saturation` (0..1) of pixels at each
   *  end of its histogram (skipping outlier first/last bins). */
  autoContrast(indices: number[], saturation: number): void {
    for (const i of indices) {
      const h = this.renderer().getHistogram(i, 256);
      if (!h) continue;
      const [min, max] = autoWindowFromHistogram(h, saturation);
      if (max > min) this.store.setChannelState(i, { min, max });
    }
  }
  getGrayscale$(): Observable<boolean> { return this.store.getGrayscale(); }
  setGrayscale(on: boolean): void { this.store.setGrayscale(on); }
  getInvert$(): Observable<boolean> { return this.store.getInvert(); }
  setInvert(on: boolean): void { this.store.setInvert(on); }

  /**
   * The active backend's region overlay. Falls back to Plotly's when OSD is
   * active but a plot isn't mounted yet, so callers always get a usable overlay.
   */
  getRegionOverlay(): IRegionOverlay {
    const r = this.renderer();
    if (r === this.osd) {
      return this.osd.getRegionOverlay() ?? this.plotly.getRegionOverlay();
    }
    return this.plotly.getRegionOverlay();
  }

  /**
   * Isosurface controls when available — always Plotly's, since the isosurface
   * plot type renders on Plotly (OSD only handles the image type).
   */
  getIsosurfaceControls(): IIsosurfaceControls | null { return this.renderer().getIsosurfaceControls(); }

  /** 3D scene controls — always Plotly's, since the 3D plot types render on
   *  Plotly (OSD only handles the image type). */
  getSurface3dControls(): ISurface3dControls | null { return this.renderer().getSurface3dControls(); }

  /** Intensity (line-ROI) controls — always Plotly's, since the line profiles
   *  render their inset on Plotly regardless of which backend draws the image. */
  getIntensityControls(): IIntensityControls | null { return this.plotly.getIntensityControls(); }

  /** Load pixel frames for intensity sampling when OpenSeadragon owns the image
   *  (it doesn't feed Plotly's frame cache). No-op needed when Plotly renders. */
  ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void> {
    return this.plotly.ensureIntensitySampling(imageInfo, zIndex);
  }

  /** Visible-region changes from the OpenSeadragon viewer (image-pixel coords),
   *  so the intensity inset can re-sample at the current zoom level. Plotly's own
   *  high-def zoom updates the sampling cache inline, so only OSD feeds this. */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.osd.getViewportChange$();
  }

  /** Re-sample the intensity profiles from a fresh crop of the given image-pixel
   *  ROI at display resolution (sampling always lives in Plotly). */
  refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number, zIndex: number): void {
    this.plotly.refreshIntensitySamplingForRoi(x, y, width, height, zIndex);
  }

  unsubscribe(): void {
    this.plotly.unsubscribe();
    this.osd.unsubscribe();
  }
}
