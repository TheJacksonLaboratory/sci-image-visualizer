import { Inject, Injectable, OnDestroy, Optional } from '@angular/core';
import { EMPTY, Observable, Subject, Subscription, combineLatest, merge, BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';
import { Image } from 'image-js';
import { resolveColormap } from 'napari-js';

import { IImageInfo, IImageMetadata } from './contracts/image.contract';
import { Polygon, Region } from './models/region';
import { ClassPreset, PresetSet } from './models/class-preset';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import {
  PlotType,
  PlotTypeDescriptor,
  isNapari3d,
  isNapariScatter,
  isSpatialOmics,
  isSpatialOmics3d,
  isNapariIsosurface,
  isNapariVolume,
} from './contracts/plot-type';
import {
  IViewerBackend,
  IVisualizer,
  LoadedImage,
  PixelData,
  IntensityProfile,
  IIsosurfaceControls,
  IIntensityControls,
  ISurface3dControls,
  ISpatialControls,
  IIntensitySampling,
  IOsdViewOptions,
  IVolumeResolution,
} from './contracts/visualizer.contract';
import { SPATIAL_DATA_PORT, SpatialDataPort } from './contracts/ports/spatial-data.port';
import { CanvasToolOptions, ColormapNode, IBrushOptions, IWandOptions } from './contracts/display-types';
import { SpatialControlsFacade } from './spatial/spatial-controls.facade';
import { RegionStore } from './store/region-store.service';
import { REGION_SOURCE_MIN_CHARS, RegionSource, RegionSourceView } from './region-source/region-source';
import type { RegionIndexPage, RegionIndexQuery } from './region-source/region-tiles';
import type { RegionStyle } from './region-overlay/region-style';
import type { Mesh } from 'napari-js/geometry';
import { openGeoJsonRegionSource } from './region-source/worker-region-source';
import type { RegionSourceOpener, RegionSourceSlices } from './store/region-source-scope';
import { SpatialSelectionStore } from './store/spatial-selection.service';
import { ViewerCapabilities } from './contracts/capabilities.contract';
import { IRegionOverlay } from './contracts/region-overlay.contract';
import { IRegionEditorApi } from './contracts/region-editor-api.contract';
import { IChannelHistogramApi, IChannelState, IHistogram } from './contracts/channel-histogram-api.contract';
import { autoWindowFromHistogram } from './contracts/intensity';
import { VisualizerStore } from './store/visualizer-store.service';
import { NapariVisualizerService } from './implementations/napari-js/napari-visualizer.service';
import { channelTintColormap, volumeColormap } from './implementations/napari-js/napari-display-state';
import { VIZ_CONFIG, VizConfig } from './contracts/viz-config';
import { PlotModeViewport } from './contracts/plot-type-contribution.contract';
import { IntensityProfileService } from './intensity/intensity-profile.service';
import { changedClasses, classSignatures } from './store/class-signatures';
import { VolumeSections } from './visualizer/volume-sections';
import type { SectionAxis, SectionViews } from './contracts/section-view.contract';

/** How long after the last edit the surfaces of the classes it touched are rebuilt (ms). */
export const REGION_SURFACE_REBUILD_MS = 600;

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
  private lastRendered: IViewerBackend | null = null;
  /** OSD failed for the *current* render cycle (e.g. a fresh file still caching
   *  past the deadline) → fall back to Plotly for this image only. Reset by
   *  reset() at the start of every render cycle, so the next file — or a
   *  re-select once the file is cached — retries OSD. (Was a permanent flag,
   *  which left the whole session stuck on Plotly after one slow load.) */
  private osdFellBack = false;
  /** napari-js failed for the current render cycle → fall back to OSD (then Plotly).
   *  Reset by reset() at the start of every cycle, like {@link osdFellBack}. */
  private napariFellBack = false;
  /** The file name of the image last plotted (names a GeoJSON export). */
  private plottedFileName: string | undefined;
  /** The div the backends render into (every backend shares it); '' before the first plot. */
  private plotDiv = '';
  /** Whether a napari volume view is the current plot type. */
  private readonly volumeView$ = new BehaviorSubject<boolean>(false);
  /** Region reconstructions built so far, by image, resolution and classes (with those classes). */
  private readonly meshCache = new Map<string, { mesh: Mesh; classes: readonly string[] }>();
  /** Bumped per {@link showRegionClasses3d} (and per new image), so only the latest one shows. */
  private meshRequest = 0;
  /** The class groups shown in 3D, and the image they belong to. */
  private readonly classes3d$ = new BehaviorSubject<ReadonlyArray<{ key: string; classes: readonly string[] }>>(
    [],
  );
  private classes3dImage: string | undefined;
  /** The groups last asked for in 3D, with their colours: what an edit's rebuild shows again. */
  private shown3d: ReadonlyArray<{ key: string; classes: readonly string[]; color: string; label?: string }> = [];
  /**
   * Each class's fingerprint on the live slice (see classSignatures), which image and slice, and
   * what the region sources hold (see RegionStore.getSourceStateKey). Null while nothing follows
   * the edits (no surface built, no sections).
   */
  private liveClasses: { at: string; signatures: Map<string, number>; sources: string } | null = null;
  /** The pending rebuild of the surfaces an edit touched. */
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly regionUpdates: Subscription;

  // ── The slice pane (the volume view's split): OSD editing one slice beside the 3D view ──
  /** The div the slice pane renders into while it is wanted (null: no split). */
  private sliceDiv: string | null = null;
  /** Whether OSD is mounted in the slice pane: region, tool and overlay calls go to it. */
  private sliceMounted = false;
  /** The image the slice pane shows. */
  private sliceFile: string | undefined;
  /** Bumped per slice-pane mount or teardown, so only the latest one lands. */
  private sliceRequest = 0;
  /** The sections beside the split volume view (the planes x and y through the stack). */
  private readonly sections: VolumeSections;
  /** The z plane dragged in the volume: the slice to show (see {@link getSliceDrag$}). */
  private readonly sliceDrag$ = new Subject<number>();
  private readonly sectionSubs = new Subscription();
  /** The image info and screen height of the last plot (what the slice pane mounts). */
  private plottedInfo: IImageInfo | null = null;
  private plottedHeight = 0;

  constructor(
    private plotly: PlotlyService,
    private osd: OpenSeadragonVisualizerService,
    private napari: NapariVisualizerService,
    private store: VisualizerStore,
    @Inject(VIZ_CONFIG) private config: VizConfig,
    // Optional: a host that serves no spatial-omics data binds nothing,
    // and `getSpatialControls()` then returns null.
    private regionStore: RegionStore,
    private selectionStore: SpatialSelectionStore,
    private intensity: IntensityProfileService,
    @Optional()
    @Inject(SPATIAL_DATA_PORT)
    private spatialData: SpatialDataPort | null = null,
  ) {
    this.regionUpdates = this.regionStore.getRegionUpdateEvent().subscribe(() => this.onRegionsChanged());
    this.sections = new VolumeSections({
      volume: () => this.napari.volumeVoxels(),
      image: () => this.plottedFileName,
      showPlanes: (planes) => this.napari.setSlicePlanes(planes),
      outlinesByClass: (level) => this.regionStore.outlinesByClass(level),
      isClassHidden: (label) => this.regionStore.isClassHidden(label),
      colorOf: (label) => this.classColor(label),
      channelStates: () => this.store.currentChannelStates(),
      colormap: (st, multichannel) => {
        // As the volume scene colours the channel (invert is applied before the colormap).
        const display = {
          colormap: this.store.currentColormap(),
          reverse: this.store.currentReverseScale(),
          invert: false,
        };
        return resolveColormap(
          multichannel ? channelTintColormap(st?.color ?? '#ffffff', display) : volumeColormap(st, display),
        );
      },
      invert: () => this.store.currentInvert(),
      slice: () => this.currentZIndex,
    });
    // A plane dragged in the volume: the z plane picks the slice (through the host's slider, so
    // the store and the slice pane follow), the others move their section.
    this.sectionSubs.add(
      this.napari.getSlicePlaneMove$().subscribe(({ axis, value }) => {
        if (axis === 'z') this.sliceDrag$.next(Math.round(value));
        else this.sections.setPlane(axis, value);
      }),
    );
    this.sectionSubs.add(this.store.getChannelStates().subscribe(() => this.sections.schedule()));
    this.sectionSubs.add(this.store.getInvert().subscribe(() => this.sections.schedule()));
    this.sectionSubs.add(this.store.getColormap().subscribe(() => this.sections.schedule()));
    this.sectionSubs.add(this.store.getReverseScale().subscribe(() => this.sections.schedule()));
  }

  /** A class's colour: its classification colour, else its region source's, else a default. */
  private classColor(label: string): string {
    return (
      this.store.getClassificationColors().get(label) ??
      this.regionStore.getRegionSourceView()?.colorOf({ label, color: null }) ??
      '#ffcc00'
    );
  }

  /** The sections beside the split volume view (nulls while it is not split). */
  getSectionViews$(): Observable<SectionViews> {
    return this.sections.getViews$();
  }

  /** Move a section's plane to `at` (image px). */
  setSectionPlane(axis: SectionAxis, at: number): void {
    this.sections.setPlane(axis, at);
  }

  /** The slice picked by dragging the z plane in the volume: the host shows it (its slider). */
  getSliceDrag$(): Observable<number> {
    return this.sliceDrag$.asObservable();
  }

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
  private imageBackend(): IViewerBackend {
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
  private renderer(): IViewerBackend {
    return this.lastRendered ?? this.plotly;
  }

  /**
   * Backend region, tool and overlay calls act on: the slice pane's OSD while the volume view is
   * split (regions are edited there), else the backend on screen. View calls (zoom, fit, colour,
   * export) stay with {@link renderer}.
   */
  private regionBackend(): IViewerBackend {
    return this.sliceMounted ? this.osd : this.renderer();
  }

  // System capabilities are Plotly's (the full-featured backend) so the UI
  // keeps offering every plot type regardless of which one is on screen.
  get capabilities(): ViewerCapabilities {
    return this.plotly.capabilities;
  }

  // ── render / viewport → active renderer ──────────────────────────────
  async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<LoadedImage> {
    // A stack can open away from slice 0 (`initialZIndex` — a volume opens
    // mid-specimen), and that arrives here rather than through setZIndex.
    this.currentZIndex = zIndex;
    const backend = this.imageBackend();
    if (backend === this.napari) {
      try {
        return await this.napari.load(imageInfo, zIndex, signal);
      } catch (err) {
        // Aborted: nobody wants this image any more, so don't go on to load it elsewhere.
        if (signal?.aborted) throw err;
        this.napariFellBack = true;
        // Mirror imageBackend()'s fallback so load + plot pick the same backend:
        //  - 3D napari types have no 2D fallback → straight to Plotly.
        //  - 2D image → OSD, then Plotly.
        if (this.isNapari3dType(this.currentPlotType)) {
          console.warn('[visualizer] napari-js load failed — falling back to Plotly.', err);
          return this.plotly.load(imageInfo, zIndex, signal);
        }
        console.warn('[visualizer] napari-js load failed — falling back to OpenSeadragon.', err);
        return this.loadViaOsdThenPlotly(imageInfo, zIndex, signal);
      }
    }
    if (backend === this.osd) {
      return this.loadViaOsdThenPlotly(imageInfo, zIndex, signal);
    }
    return this.plotly.load(imageInfo, zIndex, signal);
  }

  /** Try OSD; on failure fall back to Plotly for this image (not permanent — see reset()). */
  private async loadViaOsdThenPlotly(
    imageInfo: IImageInfo,
    zIndex: number,
    signal?: AbortSignal,
  ): Promise<LoadedImage> {
    try {
      return await this.osd.load(imageInfo, zIndex, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[visualizer] OpenSeadragon load failed — falling back to Plotly for this image.', err);
      this.osdFellBack = true;
      return this.plotly.load(imageInfo, zIndex, signal);
    }
  }
  plot(
    plotDiv: string,
    imageLoaded: unknown,
    imageInfo: IImageInfo,
    screenHeight: number,
    plotType: PlotType,
    inPlace?: boolean,
  ): Promise<boolean> {
    this.currentPlotType = plotType;
    this.volumeView$.next(isNapariVolume(plotType) || isNapariIsosurface(plotType));
    this.plottedFileName = imageInfo?.fileName;
    this.plottedInfo = imageInfo ?? null;
    this.plottedHeight = screenHeight;
    // The slice pane belongs to the volume view: another plot type takes it down (OSD may be
    // about to draw the main view, which must not find the pane's viewer still mounted).
    if (!this.volumeView$.value) this.unmountSlice();
    // Region surfaces belong to the image they were built from: another image drops them.
    if (this.classes3d$.value.length && this.plottedFileName !== this.classes3dImage) this.clearRegionClasses3d();
    this.plotDiv = plotDiv;
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
    const plotted = next.plot(plotDiv, imageLoaded, imageInfo, screenHeight, plotType, inPlace);
    if (!this.sliceDiv || !this.volumeView$.value) return plotted;
    // The split volume view: the slice pane follows the image (a new one, or its sharper pass).
    return plotted.then((ok) => {
      if (ok && (!this.sliceMounted || this.sliceFile !== imageInfo?.fileName || inPlace)) {
        void this.mountSlice(!!inPlace && this.sliceMounted && this.sliceFile === imageInfo?.fileName);
      }
      // The volume was assembled again (another image, or resolution): cut the sections from it.
      if (ok) this.sections.schedule();
      return ok;
    });
  }

  /**
   * Split the volume view: show the slice being edited in `div` (OpenSeadragon, with every region
   * tool) beside the 3D view, or stop (null). Kept across re-plots of a volume view; another plot
   * type takes the pane down and a volume view brings it back. Resolves whether the pane shows.
   */
  async setSliceEditor(div: string | null): Promise<boolean> {
    this.sliceDiv = div;
    if (!div) {
      this.unmountSlice();
      return false;
    }
    return this.mountSlice(false);
  }

  /** Mount (or refresh in place) OSD in the slice pane on the displayed slice. */
  private async mountSlice(inPlace: boolean): Promise<boolean> {
    const div = this.sliceDiv;
    const info = this.plottedInfo;
    if (!div || !info?.urls?.length || !this.volumeView$.value) return false;
    const request = ++this.sliceRequest;
    try {
      const loaded = await this.osd.load(info, this.currentZIndex);
      if (request !== this.sliceRequest) return false;
      const ok = await this.osd.plot(div, loaded, info, this.plottedHeight, PlotType.IMAGE, inPlace);
      if (request !== this.sliceRequest) return false;
      this.sliceMounted = ok;
      this.sliceFile = info.fileName;
      if (ok) {
        // The slice may have moved while the pane loaded.
        this.osd.setZIndex(this.currentZIndex);
        this.trackLiveClasses();
        this.sections.start();
      }
      return ok;
    } catch (err) {
      if (request === this.sliceRequest)
        console.warn('[visualizer] The slice pane could not show the image.', err);
      return false;
    }
  }

  /** Take the slice pane's viewer down (the split stays wanted while {@link sliceDiv} is set). */
  private unmountSlice(): void {
    this.sliceRequest++;
    if (this.sliceMounted) {
      this.osd.reset();
      this.sections.stop();
    }
    this.sliceMounted = false;
    this.sliceFile = undefined;
  }
  reloadAndPlot(): void {
    this.plotly.reloadAndPlot();
  }
  reset(): void {
    // Start of a render cycle: re-enable napari-js/OSD attempts (clear any prior
    // per-image fallback) and tear down whatever's on screen.
    this.osdFellBack = false;
    this.napariFellBack = false;
    this.renderer().reset();
  }
  relayout(trueImageSize?: number[]): void {
    this.renderer().relayout(trueImageSize);
  }
  resetAxes(): void {
    this.renderer().resetAxes();
  }
  fitToView(): void {
    this.renderer().fitToView();
  }
  /** @deprecated Use {@link fitToView}. */
  autoscale(): void {
    this.fitToView();
  }
  zoomIn(): void {
    this.renderer().zoomIn();
  }
  zoomOut(): void {
    this.renderer().zoomOut();
  }
  setDragMode(mode: string | false): void {
    this.renderer().setDragMode(mode);
    if (this.sliceMounted) this.osd.setDragMode(mode);
  }
  /** Every backend, on screen or not. */
  private backends(): IViewerBackend[] {
    return [this.plotly, this.osd, this.napari];
  }

  /**
   * The navigator / smoothing options, applied to EVERY backend that has them (not
   * just the active renderer): consumers set them before the first render, when
   * `renderer()` is still the Plotly default, and OSD/napari-js must receive them
   * to honour them at viewer creation.
   */
  getOsdViewOptions(): IOsdViewOptions {
    return this.viewOptions;
  }
  private readonly viewOptions: IOsdViewOptions = {
    setNavigatorVisible: (visible) => {
      for (const b of this.backends()) b.getOsdViewOptions()?.setNavigatorVisible(visible);
    },
    setImageSmoothingEnabled: (enabled) => {
      for (const b of this.backends()) b.getOsdViewOptions()?.setImageSmoothingEnabled(enabled);
    },
  };
  /** @deprecated Use `getOsdViewOptions().setNavigatorVisible()`. */
  setNavigatorVisible(visible: boolean): void {
    this.viewOptions.setNavigatorVisible(visible);
  }
  /** @deprecated Use `getOsdViewOptions().setImageSmoothingEnabled()`. */
  setImageSmoothingEnabled(enabled: boolean): void {
    this.viewOptions.setImageSmoothingEnabled(enabled);
  }
  setShowStack(showstack: boolean): void {
    this.renderer().setShowStack(showstack);
  }
  setZIndex(zIndex: number): void {
    this.currentZIndex = zIndex;
    this.renderer().setZIndex(zIndex);
    if (this.sliceMounted) {
      this.osd.setZIndex(zIndex);
      this.sections.schedule();
    }
  }
  getTrueImageSize(): { width: number; height: number } | null {
    return this.renderer().getTrueImageSize();
  }
  getCurrentImage(): Promise<Image | null> {
    return this.renderer().getCurrentImage();
  }
  getDisplayedPixelData(): PixelData | null {
    return this.renderer().getDisplayedPixelData();
  }
  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    return this.renderer().getDisplayedSourceRect();
  }
  downloadImage(): void {
    this.renderer().downloadImage();
  }
  exportComposite(): void {
    this.renderer().exportComposite();
  }

  setPlotType(plotType: PlotType): void {
    this.currentPlotType = plotType;
    this.volumeView$.next(isNapariVolume(plotType) || isNapariIsosurface(plotType));
    this.plotly.setPlotType(plotType);
  }
  /** @deprecated Use `getSurface3dControls()`. */
  setSurfaceDragMode(mode: string): void {
    this.getSurface3dControls()?.setSurfaceDragMode(mode);
  }
  /** @deprecated Use `getSurface3dControls()`. */
  resetSurfaceCamera(): void {
    this.getSurface3dControls()?.resetSurfaceCamera();
  }
  /** The 3D decimate factor of the backend on screen (napari-js), else null. */
  getVolumeResolution(): IVolumeResolution | null {
    return this.renderer().getVolumeResolution();
  }
  /** @deprecated Use `getVolumeResolution()?.set()`. */
  setResolutionScale(scale: number): void {
    this.getVolumeResolution()?.set(scale);
  }
  /** @deprecated Use `getVolumeResolution()?.get()`. */
  getResolutionScale(): number {
    return this.getVolumeResolution()?.get() ?? 1;
  }
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
  setStackLoading(b: boolean): void {
    this.plotly.setStackLoading(b);
  }
  // Cancel in-flight loading on every backend — the user's Cancel shouldn't depend on which one is
  // active. Only backends that stream frames (napari-js) do real work; the rest no-op. The concrete
  // backend classes don't all declare the optional contract method, so call it via IViewerBackend.
  cancelLoading(): void {
    for (const backend of [this.plotly, this.osd, this.napari] as IViewerBackend[]) {
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
    const track = (v: IViewerBackend): Observable<[number, boolean]> =>
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
  /** The line-ROI profiles: sampled by the backend-neutral IntensityProfileService. */
  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.intensity.getIntensityProfile$();
  }
  // The intensity inset is a Plotly LINE chart — render it through Plotly whichever
  // backend draws the main image.
  renderIntensityInset(divId: string, profiles: IntensityProfile[]): void {
    this.plotly.renderIntensityInset(divId, profiles);
  }

  // ── regions ──────────────────────────────────────────────────────────
  // Region state lives in the shared RegionStore, so every read and write goes
  // straight to it. Every backend draws from the store's events: the OSD and
  // napari-js overlays and Plotly's shape projection redraw on its region-update
  // and selection streams, and the canvas tools reset on getRegionSetReplaced$
  // (undo, redo, a slice switch).
  setRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
    append?: boolean,
  ): void {
    this.regionStore.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
  }
  getRegions(): Region[] {
    return this.regionStore.getRegions();
  }
  getRegionPolygons(): Polygon[] {
    return this.regionStore.getRegionPolygons();
  }
  getRegionUpdateEvent(): Observable<Region[]> {
    return this.regionStore.getRegionUpdateEvent();
  }
  setSelectedShapeIndices(indices: number[]): void {
    this.regionStore.setSelectedShapeIndices(indices);
  }
  selectRegion(region: Region): void {
    this.regionStore.selectRegion(region);
  }
  getSelectedShapeIndices$(): Observable<number[]> {
    return this.regionStore.getSelectedShapeIndices$();
  }
  deleteActiveShape(): void {
    this.regionStore.deleteActiveShape();
  }
  getShowShapeLabel(): boolean {
    return this.regionStore.getShowShapeLabel();
  }
  getShapeColor(): string {
    return this.regionStore.getShapeColor();
  }
  getFillColor(): string {
    return this.regionStore.getFillColor();
  }
  getClassificationColors(): Map<string, string> {
    return this.store.getClassificationColors();
  }
  setClassificationColor(label: string, color: string): void {
    this.store.setClassificationColor(label, color);
  }
  // Annotation-class presets live in the shared VisualizerStore (backend-neutral
  // session state), so route straight to it rather than through renderer(). (jit-ui#70)
  getPresetSet(): PresetSet {
    return this.store.getPresetSet();
  }
  getPresetSet$(): Observable<PresetSet> {
    return this.store.getPresetSet$();
  }
  setPresetSet(set: PresetSet): void {
    this.store.setPresetSet(set);
  }
  upsertClass(preset: ClassPreset): void {
    this.store.upsertClass(preset);
  }
  removeClass(name: string): void {
    this.store.removeClass(name);
  }
  resetPresets(): void {
    this.store.resetPresets();
  }
  undo(): void {
    this.regionStore.undo();
  }
  redo(): void {
    this.regionStore.redo();
  }
  canUndo(): boolean {
    return this.regionStore.canUndo();
  }
  canRedo(): boolean {
    return this.regionStore.canRedo();
  }
  getCanUndo$(): Observable<boolean> {
    return this.regionStore.getCanUndo$();
  }
  getCanRedo$(): Observable<boolean> {
    return this.regionStore.getCanRedo$();
  }
  resetUndoHistory(): void {
    this.regionStore.resetUndoHistory();
  }
  importRegions(geoJsonStr: string): Region[] {
    return this.regionStore.importRegions(geoJsonStr);
  }
  /** Download `regions` as GeoJSON, named after the image last plotted. */
  exportRegions(regions: Region[]): void {
    this.regionStore.exportRegions(regions, this.plottedFileName);
  }
  getGeoJsonString(regions: Region[]): string {
    return this.regionStore.getGeoJsonString(regions);
  }

  /** Hold a large region set as a tiled region source (see RegionStore.attachRegionSource). */
  attachRegionSource(source: RegionSource | RegionSourceOpener, slices?: RegionSourceSlices): void {
    this.regionStore.attachRegionSource(source, slices);
  }
  async importRegionSource(geoJsonStr: string): Promise<boolean> {
    if (geoJsonStr.length < (this.config?.regionSourceMinChars ?? REGION_SOURCE_MIN_CHARS)) return false;
    let opened: RegionSource | null = await openGeoJsonRegionSource(geoJsonStr);
    // The first open is the one just made; a source closed to save memory parses again.
    this.regionStore.attachRegionSource(() => {
      const source = opened;
      opened = null;
      return source ? Promise.resolve(source) : openGeoJsonRegionSource(geoJsonStr);
    });
    return true;
  }
  dropRegionSource(): Promise<void> {
    return this.regionStore.dropSliceRegionSource();
  }
  getRegionSourceView$(): Observable<RegionSourceView | null> {
    return this.regionStore.getRegionSourceView$();
  }
  getRegionSourceIndex(query: Omit<RegionIndexQuery, 'exclude'>): Promise<RegionIndexPage> {
    return this.regionStore.getRegionSourceIndex(query);
  }
  selectSourceFeatures(ids: readonly string[], additive?: boolean): Promise<number[]> {
    return this.regionStore.selectSourceFeatures(ids, additive);
  }
  deleteSourceFeatures(ids: readonly string[]): void {
    this.regionStore.deleteSourceFeatures(ids);
  }
  getRegionStyle$(): Observable<RegionStyle> {
    return this.regionStore.getRegionStyle$();
  }
  setRegionStyle(patch: Partial<RegionStyle>): void {
    this.regionStore.setRegionStyle(patch);
  }
  // ── Regions in 3D: their reconstructions shown in the volume view ─────

  /** Whether a napari volume (or isosurface) view is on screen: regions can be shown in 3D. */
  getVolumeView$(): Observable<boolean> {
    return this.volumeView$.asObservable();
  }

  /** The class groups shown in 3D on this image ([] after a switch to another image). */
  getRegionClasses3d$(): Observable<ReadonlyArray<{ key: string; classes: readonly string[] }>> {
    return this.classes3d$.asObservable();
  }

  /** Hide every region surface and forget them (a build still running is dropped). */
  private clearRegionClasses3d(): void {
    this.meshRequest++;
    this.shown3d = [];
    this.classes3d$.next([]);
    this.classes3dImage = undefined;
    this.napari.setRegionMeshes([], undefined);
    this.napari.setRegionHighlight([]);
  }

  /** Highlight the surfaces of these group keys in the volume view (none: all as usual). */
  highlightRegionClasses3d(keys: readonly string[]): void {
    this.napari.setRegionHighlight(keys);
  }

  /** A surface clicked in the volume view with the selection tool (its group key), or none (null). */
  getRegionPicked3d$(): Observable<{ key: string | null; additive: boolean }> {
    return this.napari.getRegionMeshPick$();
  }

  /**
   * Show these groups of classes in the volume view as 3D reconstructions (each group one surface
   * in its colour: an atlas structure with its substructures), and only these; [] hides them.
   * Reconstructed from every slice's outlines at the volume's resolution, cached per image.
   */
  async showRegionClasses3d(
    groups: ReadonlyArray<{ key: string; classes: readonly string[]; color: string; label?: string }>,
  ): Promise<void> {
    const request = ++this.meshRequest;
    this.classes3dImage = this.plottedFileName;
    this.shown3d = groups;
    // What an edit from now on is compared with (the live slice may not have changed yet).
    this.liveClasses = null;
    this.trackLiveClasses();
    this.classes3d$.next(groups.map((g) => ({ key: g.key, classes: g.classes })));
    const width = this.getTrueImageSize()?.width ?? 1024;
    const step = this.napari.regionVoxelStep() ?? Math.max(1, width / 256);
    const image = this.plottedFileName ?? '';
    const cacheKey = (g: { classes: readonly string[] }) => `${image}|${step.toFixed(3)}|${g.classes.join(',')}`;
    const missing = groups.filter((g) => !this.meshCache.has(cacheKey(g)));
    if (missing.length) {
      const names = missing.map((g) => g.key);
      const what = names.length > 3 ? `${names.length} regions` : names.join(', ');
      const done = this.napari.beginTask(`Building ${what} in 3D…`);
      try {
        const built = await this.regionStore.reconstructClasses(
          missing.map((g) => ({ key: cacheKey(g), classes: g.classes })),
          step,
        );
        const classesOf = new Map(missing.map((g) => [cacheKey(g), g.classes]));
        for (const b of built) this.meshCache.set(b.key, { mesh: b.mesh, classes: classesOf.get(b.key) ?? [] });
      } finally {
        done();
      }
    }
    if (request !== this.meshRequest) return;
    this.napari.setRegionMeshes(
      groups.map((g) => {
        const mesh = this.meshCache.get(cacheKey(g))!.mesh;
        return { key: g.key, color: g.color, label: g.label, vertices: mesh.vertices, faces: mesh.faces };
      }),
      this.plottedFileName,
    );
  }

  /**
   * The regions changed: when the live slice's regions of some classes did (an edit, an undo, not
   * a slice or image switch), their reconstructions are stale. They are dropped, and those shown
   * in 3D are rebuilt once the edits pause.
   */
  private onRegionsChanged(): void {
    // Nothing follows the edits (no surface built or shown, no sections): skip the fingerprints.
    if (!this.sliceMounted && !this.shown3d.length && !this.meshCache.size) {
      this.liveClasses = null;
      return;
    }
    const before = this.liveClasses;
    this.liveClasses = null;
    const now = this.trackLiveClasses();
    // Another slice or image came up: no region changed (the sections recut for the slice).
    if (!before || before.at !== now.at) return;
    const changed = changedClasses(before.signatures, now.signatures);
    // Source features deleted (or that undone) change no live region, and which classes they were
    // is not known here: every class is stale. A feature taken shows as its class's change.
    const everyClass = !changed.size && before.sources !== now.sources;
    if (!changed.size && !everyClass) return;
    const touched = (c: string) => everyClass || changed.has(c);
    if (this.sliceMounted) this.sections.regionsChanged();
    for (const [key, entry] of [...this.meshCache]) {
      if (entry.classes.some(touched)) this.meshCache.delete(key);
    }
    if (!this.shown3d.some((g) => g.classes.some(touched))) return;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.shown3d.length && this.classes3dImage === this.plottedFileName) {
        void this.showRegionClasses3d(this.shown3d);
      }
    }, REGION_SURFACE_REBUILD_MS);
  }

  /** Fingerprint the live slice's classes, unless already: what the next edit is compared with. */
  private trackLiveClasses(): { at: string; signatures: Map<string, number>; sources: string } {
    this.liveClasses ??= {
      at: this.liveSliceKey(),
      signatures: classSignatures(this.regionStore.getRegions()),
      sources: this.regionStore.getSourceStateKey(),
    };
    return this.liveClasses;
  }

  /** Which slice of which image the live regions are. */
  private liveSliceKey(): string {
    return `${this.regionStore.getDisplaySlice()}\n${this.plottedFileName ?? ''}`;
  }

  /** Each class's volume over the whole stack, in px² × slices (see RegionStore.classVolumes). */
  async getClassVolumes(classes: readonly string[]): Promise<Record<string, number>> {
    return Object.fromEntries(await this.regionStore.classVolumes(classes));
  }

  getRegionSourceClassCounts(): Promise<Record<string, number>> {
    return this.regionStore.getRegionSourceClassCounts();
  }
  getHiddenClasses$(): Observable<ReadonlySet<string>> {
    return this.regionStore.getHiddenClasses$();
  }
  setClassesHidden(classes: readonly string[], hidden: boolean): void {
    this.regionStore.setClassesHidden(classes, hidden);
    // A surface is its class's (its group key is the class name).
    this.napari.setRegionHidden([...this.regionStore.getHiddenClasses()]);
    this.sections.schedule();
  }
  async selectRegionClasses(classes: readonly string[], additive?: boolean): Promise<void> {
    await this.regionStore.selectClasses(classes, additive);
  }
  getGeoJsonStringWithSource(regions: Region[], slice?: number): Promise<string> {
    return this.regionStore.getGeoJsonWithSource(regions, slice);
  }

  // ── Per-slice z-stack regions (jit-ui#93), from the shared RegionStore. ──
  enterStackMode(
    slices: Map<number, Region[]>,
    initialZ?: number,
    saveLayout?: 'combined' | 'per-slice-file',
  ): void {
    this.regionStore.enterStackMode(slices, initialZ, saveLayout);
  }
  exitStackMode(): void {
    this.regionStore.exitStackMode();
  }
  isStackMode(): boolean {
    return this.regionStore.isStackMode();
  }
  /** The slice the regions are shown for (recorded outside stack mode too). */
  getDisplaySlice(): number {
    return this.regionStore.getDisplaySlice();
  }
  getStackSaveLayout(): 'combined' | 'per-slice-file' {
    return this.regionStore.getStackSaveLayout();
  }
  setDisplaySlice(z: number): void {
    this.regionStore.setDisplaySlice(z);
  }
  getSliceRegions(): Region[] {
    return this.regionStore.getSliceRegions();
  }
  getStackSaveSlices(): Map<number, Region[]> {
    return this.regionStore.getStackSaveSlices();
  }
  /** All slices' ANNOTATION regions for a z-stack save (jit-ui#93), each tagged
   *  with its zero-based Region.z; profile lines excluded. Flat annotation set
   *  outside stack mode. */
  getSliceAnnotationRegions(): Region[] {
    return this.regionStore.getSliceRegions().filter((r) => !isProfileRegion(r));
  }
  /** Per-slice annotation regions to write on a folder-stack save (jit-ui#93):
   *  slice index → that slice's annotation regions (profile lines excluded),
   *  including now-empty slices that were loaded non-empty (so they overwrite). */
  getStackSaveAnnotationSlices(): Map<number, Region[]> {
    const out = new Map<number, Region[]>();
    for (const [z, regs] of this.regionStore.getStackSaveSlices()) {
      out.set(
        z,
        regs.filter((r) => !isProfileRegion(r)),
      );
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
      s && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width >= 1 && s.height >= 1
        ? { width: Math.round(s.width), height: Math.round(s.height) }
        : null;

    const fromRenderer = valid(this.getTrueImageSize());
    if (fromRenderer) return fromRenderer;

    let meta: IImageMetadata[] = [];
    this.getImageMeta()
      .subscribe((m) => (meta = m))
      .unsubscribe();
    const m0 = meta?.[0];
    return m0 ? valid({ width: m0.x, height: m0.y }) : null;
  }

  // ── IRegionEditorApi: annotation-only surface for the Region Editor ───
  // Intensity-profile lines (kind='profile') belong to the intensity tool, not
  // the editor. These methods give external consumers an annotation-only view
  // and guarantee profile lines are preserved. The writes land in the store like
  // any other, and every backend redraws from its events.

  getAnnotationRegions(): Region[] {
    return this.regionStore.getRegions().filter((r) => !isProfileRegion(r));
  }
  setAnnotationRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
  ): void {
    // Re-append the store's profile lines so an editor save/delete can't drop them.
    const profiles = this.regionStore.getRegions().filter((r) => isProfileRegion(r));
    const annotations = (regions || []).filter((r) => !isProfileRegion(r));
    this.setRegions([...annotations, ...profiles], showRegionLabel, isRegionSaveOn, fillColor, false);
  }
  getSelectedRegions$(): Observable<Region[]> {
    // Map the internal index-based selection to the selected annotation regions.
    return this.getSelectedShapeIndices$().pipe(
      map((idxs) => {
        const regs = this.regionStore.getRegions();
        return idxs.map((i) => regs[i]).filter((r): r is Region => !!r && !isProfileRegion(r));
      }),
    );
  }
  setSelectedRegions(regions: Region[]): void {
    const regs = this.regionStore.getRegions();
    const indices = (regions || []).map((r) => regs.findIndex((x) => x.id === r.id)).filter((i) => i >= 0);
    this.setSelectedShapeIndices(indices);
  }

  // ── tools → active renderer (run on either backend) ─────────────────
  // The wand, vertex eraser and zoom-to-box are implemented on both backends
  // via ICoordinateTransform (+ a viewport pixel readback for the wand), so they
  // follow the active renderer — the slice pane's while the volume view is split.
  setActiveTool(id: string | null, options?: CanvasToolOptions): void {
    this.regionBackend().setActiveTool(id, options);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setWandMode(active: boolean, options?: IWandOptions): void {
    this.regionBackend().setWandMode(active, options);
  }
  setWandOptions(options: IWandOptions): void {
    this.regionBackend().setWandOptions(options);
  }
  clearActiveWandRegion(): void {
    this.regionBackend().clearActiveWandRegion();
  }
  /** @deprecated Use {@link setActiveTool}. */
  setBrushMode(active: boolean, options?: IBrushOptions): void {
    this.regionBackend().setBrushMode(active, options);
  }
  setBrushOptions(options: IBrushOptions): void {
    this.regionBackend().setBrushOptions(options);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setVertexEraserMode(active: boolean): void {
    this.regionBackend().setVertexEraserMode(active);
  }
  setVertexEraserRadius(radius: number): void {
    this.regionBackend().setVertexEraserRadius(radius);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setZoomToBoxMode(active: boolean): void {
    this.regionBackend().setZoomToBoxMode(active);
  }
  segmentRectangles(): Promise<number> {
    return this.regionBackend().segmentRectangles();
  }
  segmentRectanglesCellpose(): Promise<number> {
    return this.regionBackend().segmentRectanglesCellpose();
  }
  setSamModel(id: string): void {
    this.regionBackend().setSamModel(id);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setSamPointMode(active: boolean): void {
    this.regionBackend().setSamPointMode(active);
  }
  commitSamPoints(): void {
    this.regionBackend().commitSamPoints();
  }
  clearSamPoints(): void {
    this.regionBackend().clearSamPoints();
  }

  // ── display options ──────────────────────────────────────────────────
  // State lives in the shared VisualizerStore — reads go straight to it.
  // The two SETTERS still route through Plotly because its implementations
  // carry render glue beyond the store write (a live Plotly.restyle of
  // colorscale/reversescale on the mounted heatmap); OSD recolors via its own
  // store subscription either way.
  getColormap(): Observable<ColormapNode | null> {
    return this.store.getColormap();
  }
  setColormap(colormap: ColormapNode): void {
    this.plotly.setColormap(colormap);
  }
  getColormapOptions(): ColormapNode[] {
    return this.store.getColormapOptions();
  }
  getReverseScale(): Observable<boolean> {
    return this.store.getReverseScale();
  }
  setReverseScale(reverse: boolean): void {
    this.plotly.setReverseScale(reverse);
  }
  setImageMeta(imageMeta: IImageMetadata[], imageKey?: string): void {
    this.store.setImageMeta(imageMeta, imageKey);
  }
  getImageMeta(): Observable<IImageMetadata[]> {
    return this.store.getImageMeta();
  }

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
  exportData(): void {
    this.renderer().exportData();
  }
  getChannels$(): Observable<IChannelState[]> {
    return this.store.getChannelStates();
  }
  setSelectedChannel(index: number): void {
    this.store.setSelectedChannel(index);
  }
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
  getGrayscale$(): Observable<boolean> {
    return this.store.getGrayscale();
  }
  setGrayscale(on: boolean): void {
    this.store.setGrayscale(on);
  }
  getInvert$(): Observable<boolean> {
    return this.store.getInvert();
  }
  setInvert(on: boolean): void {
    this.store.setInvert(on);
  }

  /**
   * The active backend's region overlay (the slice pane's while the volume view is split). Falls
   * back to Plotly's when the active backend
   * (OSD or napari-js) is selected but a plot isn't mounted yet, so callers always get a
   * usable overlay.
   */
  getRegionOverlay(): IRegionOverlay {
    const r = this.regionBackend();
    if (r === this.osd) {
      return this.osd.getRegionOverlay() ?? this.plotly.getRegionOverlay();
    }
    if (r === this.napari) {
      return this.napari.getRegionOverlay() ?? this.plotly.getRegionOverlay();
    }
    return this.plotly.getRegionOverlay();
  }

  /** Isosurface controls of the backend on screen, when it renders isosurfaces. */
  getIsosurfaceControls(): IIsosurfaceControls | null {
    return this.renderer().getIsosurfaceControls();
  }

  /** 3D scene controls of the backend on screen (Plotly or napari-js), or null on a
   *  2D-only one. */
  getSurface3dControls(): ISurface3dControls | null {
    return this.renderer().getSurface3dControls();
  }

  /** Intensity (line-ROI) controls, whichever backend draws the image: the
   *  IntensityProfileService adds the line to the store, and every backend
   *  (Plotly included) draws it from the store's update event. */
  getIntensityControls(): IIntensityControls | null {
    return this.intensity;
  }

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
    this.regionUpdates.unsubscribe();
    this.sectionSubs.unsubscribe();
    this.sections.stop();
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
  }

  /**
   * Intensity-profile sampling, whichever backend is on screen: the sampling is the
   * backend-neutral IntensityProfileService's; the viewport changes come from every
   * backend that reports them (OpenSeadragon, napari-js), merged into one stable
   * stream the inset subscribes to once.
   */
  getIntensitySampling(): IIntensitySampling {
    return this.intensitySampling;
  }
  private readonly intensitySampling: IIntensitySampling = {
    // Load the displayed slice's pixels for a backend that has no frames of its own
    // (OpenSeadragon, napari-js; Plotly feeds its frames to the service when it plots).
    ensureIntensitySampling: (imageInfo, zIndex) => {
      this.pointSamplingAtPlot();
      return this.intensity.ensureIntensitySampling(imageInfo, zIndex);
    },
    // Re-sample from a fresh crop of the image-pixel ROI at display resolution.
    refreshIntensitySamplingForRoi: (x, y, width, height, zIndex) => {
      this.pointSamplingAtPlot();
      this.intensity.refreshIntensitySamplingForRoi(x, y, width, height, zIndex);
    },
    getViewportChange$: () =>
      merge(...this.backends().map((b) => b.getIntensitySampling()?.getViewportChange$() ?? EMPTY)),
  };
  /** @deprecated Use `getIntensitySampling().ensureIntensitySampling()`. */
  ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void> {
    return this.intensitySampling.ensureIntensitySampling(imageInfo, zIndex);
  }

  /** Crops for sampling are sized from the plot div (whichever backend renders into it). */
  private pointSamplingAtPlot(): void {
    if (this.plotDiv) this.intensity.setSamplingElement(this.plotDiv);
  }

  /** @deprecated Use `getIntensitySampling().getViewportChange$()`. */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.intensitySampling.getViewportChange$();
  }

  /** @deprecated Use `getIntensitySampling().refreshIntensitySamplingForRoi()`. */
  refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number, zIndex: number): void {
    this.intensitySampling.refreshIntensitySamplingForRoi(x, y, width, height, zIndex);
  }

  /** The visualizer view is going away: detach every backend — dropping their view-bound
   *  subscriptions and disposing the napari-js viewer, whose canvas, render loop and GPU
   *  buffers would otherwise outlive the view (for a component-scoped chain, forever).
   *  Nothing is on screen afterwards, so the next plot starts from the default backend. */
  detach(): void {
    this.sliceRequest++;
    this.sections.stop();
    this.sliceMounted = false;
    this.sliceDiv = null;
    this.plotly.detach();
    this.osd.detach();
    this.napari.detach();
    this.lastRendered = null;
  }

  /** @deprecated Use {@link detach}. */
  unsubscribe(): void {
    this.detach();
  }
}
