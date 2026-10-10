import { Inject, Injectable, OnDestroy, Optional } from '@angular/core';
import { Observable, combineLatest, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { Image } from 'image-js';

import { IImageInfo, IImageMetadata } from './contracts/image.contract';
import { Polygon, Region } from './models/region';
import { ClassPreset, PresetSet } from './models/class-preset';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import { PlotType, PlotTypeDescriptor, isNapari3d, isNapariScatter, isSpatialOmics, isSpatialOmics3d } from './contracts/plot-type';
import { IVisualizer, LoadedImage, PixelData, IntensityProfile, IIsosurfaceControls, IIntensityControls, ISurface3dControls, ISpatialControls } from './contracts/visualizer.contract';
import { SPATIAL_DATA_PORT, SpatialDataPort } from './contracts/ports/spatial-data.port';
import { CanvasToolOptions, ColormapNode, IBrushOptions, IWandOptions } from './contracts/display-types';
import { SpatialControlsFacade } from './spatial/spatial-controls.facade';
import { RegionStore } from './store/region-store.service';
import { SpatialSelectionStore } from './store/spatial-selection.service';
import { ViewerCapabilities } from './contracts/capabilities.contract';
import { IRegionOverlay } from './contracts/region-overlay.contract';
import { IRegionEditorApi } from './contracts/region-editor-api.contract';
import { IChannelHistogramApi, IChannelState, IHistogram } from './contracts/channel-histogram-api.contract';
import { autoWindowFromHistogram } from './contracts/intensity';
import { VisualizerStore } from './store/visualizer-store.service';
import { NapariVisualizerService } from './implementations/napari-js/napari-visualizer.service';
import { VIZ_CONFIG, VizConfig } from './contracts/viz-config';
import { PlotModeViewport } from './contracts/plot-type-contribution.contract';

/** Intensity-profile line ROIs are owned by the intensity tool, not the editor.
 *  Package-internal predicate (property-based so it also matches plain objects
 *  after a drag round-trip). */
function isProfileRegion(r: { kind?: string } | null | undefined): boolean {
  return r?.kind === 'profile';
}

/**
 * The visualizer chain's front door: implements `IVisualizer`, `IRegionEditorApi`
 * and `IChannelHistogramApi` (bound to the `VISUALIZER` / `REGION_EDITOR_API` /
 * `CHANNEL_HISTOGRAM_API` tokens) over three rendering backends, chosen per plot type:
 *  - **Image** renders through OpenSeadragon (natively tiled, region tools,
 *    client-side colormap), or through napari-js when `VizConfig.useNapariRenderer`
 *    opts in; the napari image types and the 2D spatial-omics mode render through
 *    napari-js. A failed load falls back napari-js → OSD → Plotly for that image only
 *    (see `napariFellBack` / `osdFellBack`, cleared by `reset()`).
 *  - the napari 3D types (volume, isosurface, surface, 3D scatter, the 3D spatial
 *    cloud) render through napari-js, falling back to Plotly.
 *  - every other plot type (heatmap, contour, surface, scatter, line, …) renders
 *    through Plotly.
 *
 * Only rendering and the viewport are routed to the backend on screen. Region state
 * lives in the shared `RegionStore` and display state (colormap, channels, presets,
 * spatial view) in the shared `VisualizerStore`, so every backend sees the same
 * values; the backends subscribe to them to redraw.
 *
 * Package-internal: hosts depend on the tokens, not on this class.
 */
@Injectable({ providedIn: 'root' })
export class RoutingVisualizerService implements IVisualizer, IRegionEditorApi, IChannelHistogramApi, OnDestroy {

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
              @Inject(VIZ_CONFIG) private config: VizConfig,
              // Optional: a host that serves no spatial-omics data binds nothing,
              // and `getSpatialControls()` then returns null.
              private regionStore: RegionStore,
              private selectionStore: SpatialSelectionStore,
              @Optional() @Inject(SPATIAL_DATA_PORT)
              private spatialData: SpatialDataPort | null = null) {}

  private isImageType(t: PlotType): boolean {
    return t === PlotType.IMAGE;
  }

  /** The 2D napari types (image, region-centroid scatter, spatial omics) — a 2D fallback chain
   *  (OSD, then Plotly).
   *
   *  NOTE for SPATIAL_OMICS: only napari-js draws the observation markers. If it fails (no WebGPU,
   *  device loss) the fallback renders the tissue image ALONE — the spatial layer is absent, not
   *  degraded. That is deliberate for now: showing the slide beats showing nothing, and a Plotly
   *  `scattergl` spatial mode is the planned real fallback (see the plot-mode design doc). */
  private isNapariImageType(t: PlotType): boolean {
    return t === PlotType.NAPARI_IMAGE || isNapariScatter(t) || isSpatialOmics(t);
  }

  /** The 3D napari types (volume/isosurface/surface/scatter, plus the 3D spatial cloud) — no 2D
   *  fallback exists (OSD is image-only), so they fall straight to Plotly. */
  private isNapari3dType(t: PlotType): boolean {
    return isNapari3d(t) || isSpatialOmics3d(t);
  }

  /**
   * Backend to attempt for the current plot type this render. The fallback chains below are
   * mirrored exactly by {@link load} so the handle `plot()` receives always comes from the
   * backend `plot()` selects (no load/plot backend mismatch):
   *  - 2D image (explicit `NAPARI_IMAGE`, or `IMAGE` with the WebGPU opt-in): napari-js → OSD → Plotly.
   *  - plain `IMAGE` (no opt-in): OSD → Plotly.
   *  - 3D napari (`NAPARI_VOLUME`/`NAPARI_ISOSURFACE`): napari-js → Plotly (OSD can't render 3D).
   */
  private imageBackend(): IVisualizer {
    const t = this.currentPlotType;
    // 2D image with a napari-js attempt (explicit napari image, or opt-in on the Image type).
    if (this.isNapariImageType(t) || (this.isImageType(t) && this.config.useNapariRenderer)) {
      if (!this.napariFellBack) return this.napari;
      if (!this.osdFellBack) return this.osd;
      return this.plotly;
    }
    // Plain Image type (no napari opt-in): OSD, then Plotly.
    if (this.isImageType(t)) {
      return this.osdFellBack ? this.plotly : this.osd;
    }
    // 3D napari types: napari-js, with Plotly as the only viable fallback.
    if (this.isNapari3dType(t)) {
      return this.napariFellBack ? this.plotly : this.napari;
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
  async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<LoadedImage> {
    // A stack can open away from slice 0 (`initialZIndex` — a volume opens
    // mid-specimen), and that arrives here rather than through setZIndex.
    this.currentZIndex = zIndex;
    const backend = this.imageBackend();
    if (backend === this.napari) {
      try {
        return await (this.napari as IVisualizer).load(imageInfo, zIndex, signal);
      } catch (err) {
        // Aborted: nobody wants this image any more, so don't go on to load it elsewhere.
        if (signal?.aborted) throw err;
        this.napariFellBack = true;
        // Mirror imageBackend()'s fallback so load + plot pick the same backend:
        //  - 3D napari types have no 2D fallback → straight to Plotly.
        //  - 2D image → OSD, then Plotly.
        if (this.isNapari3dType(this.currentPlotType)) {
          console.warn('[visualizer] napari-js load failed — falling back to Plotly.', err);
          return (this.plotly as IVisualizer).load(imageInfo, zIndex, signal);
        }
        console.warn('[visualizer] napari-js load failed — falling back to OpenSeadragon.', err);
        return this.loadViaOsdThenPlotly(imageInfo, zIndex, signal);
      }
    }
    if (backend === this.osd) {
      return this.loadViaOsdThenPlotly(imageInfo, zIndex, signal);
    }
    return (this.plotly as IVisualizer).load(imageInfo, zIndex, signal);
  }

  /** Try OSD; on failure fall back to Plotly for this image (not permanent — see reset()). */
  private async loadViaOsdThenPlotly(imageInfo: IImageInfo, zIndex: number,
                                     signal?: AbortSignal): Promise<LoadedImage> {
    try {
      return await (this.osd as IVisualizer).load(imageInfo, zIndex, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[visualizer] OpenSeadragon load failed — falling back to Plotly for this image.', err);
      this.osdFellBack = true;
      return (this.plotly as IVisualizer).load(imageInfo, zIndex, signal);
    }
  }
  plot(plotDiv: string, imageLoaded: unknown, imageInfo: IImageInfo, screenHeight: number,
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
    this.napari.setNavigatorVisible(visible);
  }
  // Set on both backends (see setNavigatorVisible): consumers may set it before
  // the first render, when the active renderer is still Plotly.
  setImageSmoothingEnabled(enabled: boolean): void {
    this.osd.setImageSmoothingEnabled(enabled);
    this.plotly.setImageSmoothingEnabled(enabled);
  }
  setShowStack(showstack: boolean): void { this.renderer().setShowStack(showstack); }
  setZIndex(zIndex: number): void {
    this.currentZIndex = zIndex;
    this.renderer().setZIndex(zIndex);
  }
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
  setResolutionScale(scale: number): void { this.renderer().setResolutionScale?.(scale); }
  getResolutionScale(): number { return this.renderer().getResolutionScale?.() ?? 1; }
  /** The viewport of the backend on screen, for a contributed plot mode. Null
   *  when that backend cannot provide one (e.g. OSD fell back to Plotly). */
  getPlotModeViewport(): PlotModeViewport | null {
    return this.renderer().getPlotModeViewport?.() ?? null;
  }
  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    // Plotly enumerates the full PLOT_TYPE_DESCRIPTORS map, which already includes the
    // napari-js WebGPU types (jit-ui#102) — so this single source covers them (no duplicates).
    return this.plotly.getPlotTypeDescriptors();
  }

  // ── long-lived observables + stack flags ──────────────────────────────────
  setStackLoading(b: boolean): void { this.plotly.setStackLoading(b); }
  // Cancel in-flight loading on every backend — the user's Cancel shouldn't depend on which one is
  // active. Only backends that stream frames (napari-js) do real work; the rest no-op. The concrete
  // backend classes don't all declare the optional contract method, so call it via IVisualizer.
  cancelLoading(): void {
    for (const backend of [this.plotly, this.osd, this.napari] as IVisualizer[]) {
      backend.cancelLoading?.();
    }
  }
  // Loading state is surfaced from whichever backend is doing the work: OSD and napari-js (volume
  // assembly) drive their own subjects, so merge all three into one stable stream the host
  // subscribes to once. (Previously hardcoded to Plotly, so napari/OSD progress never showed.)
  isStackLoading(): Observable<boolean> {
    return combineLatest([
      this.plotly.isStackLoading(),
      this.osd.isStackLoading(),
      this.napari.isStackLoading(),
    ]).pipe(map((flags) => flags.some(Boolean)));
  }
  getStackLoadingProgress(): Observable<number> {
    // Report the progress of whichever backend is ACTIVELY loading (max across active ones). A plain
    // merge let an idle backend's stale value win the stream on a re-load — leaving the bar below the
    // active backend's real progress (e.g. stuck ~⅓ while the % read 100). Gating by the loading flag
    // ignores idle backends, so the bar tracks the one doing the work and reaches 100%.
    const track = (v: IVisualizer): Observable<[number, boolean]> =>
      combineLatest([v.getStackLoadingProgress(), v.isStackLoading()]);
    return combineLatest([track(this.plotly), track(this.osd), track(this.napari)]).pipe(
      map((pairs) => {
        const active = pairs.filter(([, loading]) => loading).map(([p]) => p);
        return active.length ? Math.max(...active) : 0;
      }),
    );
  }
  // Every backend fits to view on its own (Plotly's autoscale, OSD's goHome, napari's camera
  // fit) and each emits from its own subject, so merge all three: listening to Plotly alone
  // missed the context-menu Autoscale on the Image and napari views.
  getAutoscaleEvent(): Observable<void> {
    return merge(
      this.plotly.getAutoscaleEvent(),
      this.osd.getAutoscaleEvent(),
      this.napari.getAutoscaleEvent(),
    ).pipe(map(() => undefined));
  }
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
  getRegionPolygons(): Polygon[] { return this.renderer().getRegionPolygons(); }
  getRegionUpdateEvent(): Observable<Region[]> { return this.renderer().getRegionUpdateEvent(); }
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
  // Annotation-class presets live in the shared VisualizerStore (backend-neutral
  // session state), so route straight to it rather than through renderer(). (jit-ui#70)
  getPresetSet(): PresetSet { return this.store.getPresetSet(); }
  getPresetSet$(): Observable<PresetSet> { return this.store.getPresetSet$(); }
  setPresetSet(set: PresetSet): void { this.store.setPresetSet(set); }
  upsertClass(preset: ClassPreset): void { this.store.upsertClass(preset); }
  removeClass(name: string): void { this.store.removeClass(name); }
  resetPresets(): void { this.store.resetPresets(); }
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

  // ── Per-slice z-stack regions (jit-ui#93) — the RegionStore is shared across
  //    backends, so routing to the active renderer hits the same store. ──────
  enterStackMode(slices: Map<number, Region[]>, initialZ?: number,
                 saveLayout?: 'combined' | 'per-slice-file'): void {
    this.renderer().enterStackMode(slices, initialZ, saveLayout);
  }
  exitStackMode(): void { this.renderer().exitStackMode(); }
  isStackMode(): boolean { return this.renderer().isStackMode(); }
  getStackSaveLayout(): 'combined' | 'per-slice-file' { return this.renderer().getStackSaveLayout(); }
  setDisplaySlice(z: number): void { this.renderer().setDisplaySlice(z); }
  getSliceRegions(): Region[] { return this.renderer().getSliceRegions(); }
  getStackSaveSlices(): Map<number, Region[]> { return this.renderer().getStackSaveSlices(); }
  /** All slices' ANNOTATION regions for a z-stack save (jit-ui#93), each tagged
   *  with its zero-based Region.z; profile lines excluded. Flat annotation set
   *  outside stack mode. */
  getSliceAnnotationRegions(): Region[] {
    return this.renderer().getSliceRegions().filter((r) => !isProfileRegion(r));
  }
  /** Per-slice annotation regions to write on a folder-stack save (jit-ui#93):
   *  slice index → that slice's annotation regions (profile lines excluded),
   *  including now-empty slices that were loaded non-empty (so they overwrite). */
  getStackSaveAnnotationSlices(): Map<number, Region[]> {
    const out = new Map<number, Region[]>();
    for (const [z, regs] of this.renderer().getStackSaveSlices()) {
      out.set(z, regs.filter((r) => !isProfileRegion(r)));
    }
    return out;
  }

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
  setActiveTool(id: string | null, options?: CanvasToolOptions): void {
    this.renderer().setActiveTool(id, options);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setWandMode(active: boolean, options?: IWandOptions): void { this.renderer().setWandMode(active, options); }
  setWandOptions(options: IWandOptions): void { this.renderer().setWandOptions(options); }
  clearActiveWandRegion(): void { this.renderer().clearActiveWandRegion(); }
  /** @deprecated Use {@link setActiveTool}. */
  setBrushMode(active: boolean, options?: IBrushOptions): void { this.renderer().setBrushMode(active, options); }
  setBrushOptions(options: IBrushOptions): void { this.renderer().setBrushOptions(options); }
  /** @deprecated Use {@link setActiveTool}. */
  setVertexEraserMode(active: boolean): void { this.renderer().setVertexEraserMode(active); }
  setVertexEraserRadius(radius: number): void { this.renderer().setVertexEraserRadius(radius); }
  /** @deprecated Use {@link setActiveTool}. */
  setZoomToBoxMode(active: boolean): void { this.renderer().setZoomToBoxMode(active); }
  segmentRectangles(): Promise<number> { return this.renderer().segmentRectangles(); }
  segmentRectanglesCellpose(): Promise<number> { return this.renderer().segmentRectanglesCellpose(); }
  setSamModel(id: string): void { this.renderer().setSamModel(id); }
  /** @deprecated Use {@link setActiveTool}. */
  setSamPointMode(active: boolean): void { this.renderer().setSamPointMode(active); }
  commitSamPoints(): void { this.renderer().commitSamPoints(); }
  clearSamPoints(): void { this.renderer().clearSamPoints(); }

  // ── display options ──────────────────────────────────────────────────
  // State lives in the shared VisualizerStore — reads go straight to it.
  // The two SETTERS still route through Plotly because its implementations
  // carry render glue beyond the store write (a live Plotly.restyle of
  // colorscale/reversescale on the mounted heatmap); OSD recolors via its own
  // store subscription either way.
  getColormap(): Observable<ColormapNode | null> { return this.store.getColormap(); }
  setColormap(colormap: ColormapNode): void { this.plotly.setColormap(colormap); }
  getColormapOptions(): ColormapNode[] { return this.store.getColormapOptions(); }
  getReverseScale(): Observable<boolean> { return this.store.getReverseScale(); }
  setReverseScale(reverse: boolean): void { this.plotly.setReverseScale(reverse); }
  setImageMeta(imageMeta: IImageMetadata[], imageKey?: string): void {
    this.store.setImageMeta(imageMeta, imageKey);
  }
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
  setSelectedChannel(index: number): void { this.store.setSelectedChannel(index); }
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
      const [min, max] = autoWindowFromHistogram(h, saturation, [0, 255]);
      if (max > min) this.store.setChannelState(i, { min, max });
    }
  }
  getGrayscale$(): Observable<boolean> { return this.store.getGrayscale(); }
  setGrayscale(on: boolean): void { this.store.setGrayscale(on); }
  getInvert$(): Observable<boolean> { return this.store.getInvert(); }
  setInvert(on: boolean): void { this.store.setInvert(on); }

  /**
   * The active backend's region overlay. Falls back to Plotly's when the active backend
   * (OSD or napari-js) is selected but a plot isn't mounted yet, so callers always get a
   * usable overlay.
   */
  getRegionOverlay(): IRegionOverlay {
    const r = this.renderer();
    if (r === this.osd) {
      return this.osd.getRegionOverlay() ?? this.plotly.getRegionOverlay();
    }
    if (r === this.napari) {
      return this.napari.getRegionOverlay() ?? this.plotly.getRegionOverlay();
    }
    return this.plotly.getRegionOverlay();
  }

  /** Isosurface controls of the backend on screen, when it renders isosurfaces. */
  getIsosurfaceControls(): IIsosurfaceControls | null { return this.renderer().getIsosurfaceControls(); }

  /** 3D scene controls of the backend on screen (Plotly or napari-js), or null on a
   *  2D-only one. */
  getSurface3dControls(): ISurface3dControls | null { return this.renderer().getSurface3dControls(); }

  /** Intensity (line-ROI) controls — always Plotly's, since the line profiles
   *  render their inset on Plotly regardless of which backend draws the image. */
  getIntensityControls(): IIntensityControls | null { return this.plotly.getIntensityControls(); }

  /**
   * Spatial-omics controls, or null when no `SPATIAL_DATA_PORT` is bound. Served by a
   * backend-neutral {@link SpatialControlsFacade} (state in the shared stores), so the
   * controls work across a plot-type switch and before any backend has mounted.
   */
  getSpatialControls(): ISpatialControls | null {
    if (!this.spatialData) return null;
    this.spatialFacade ??= new SpatialControlsFacade(this.spatialData, {
      store: this.store,
      regionStore: this.regionStore,
      selectionStore: this.selectionStore,
      napari: this.napari,
      plotType: () => this.currentPlotType,
      zIndex: () => this.currentZIndex,
    });
    return this.spatialFacade.controls;
  }

  /** Created on first use; owns the dataset subscription. */
  private spatialFacade: SpatialControlsFacade | null = null;
  /** Displayed slice. Only a volume-backed spatial dataset reads it, to keep a
   *  region drawn over one section from selecting the whole depth behind it. */
  private currentZIndex = 0;

  /** Angular calls this when the injector providing the router is destroyed — the host
   *  component for a `provideVisualization()` chain. The dataset subscription would
   *  otherwise keep the whole isolated chain reachable from the root data port. */
  ngOnDestroy(): void {
    this.spatialFacade?.dispose();
    this.spatialFacade = null;
  }

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

  /** The visualizer view is going away: drop the backends' view-bound subscriptions and
   *  dispose the napari-js viewer (its canvas, render loop and GPU buffers would otherwise
   *  outlive the view — for a component-scoped chain, forever). Nothing is on screen
   *  afterwards, so the next plot starts from the default backend. */
  unsubscribe(): void {
    this.plotly.unsubscribe();
    this.osd.unsubscribe();
    this.napari.reset();
    this.lastRendered = null;
  }
}
