import { Inject, Injectable, NgZone, Optional, inject } from '@angular/core';
import { Observable, BehaviorSubject, Subject, of } from 'rxjs';
import { Image } from 'image-js';
import { saveAs } from 'file-saver';
import { Viewer } from 'napari-js';

import { IImageInfo } from '../../contracts/image.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { CanvasToolId } from '../../contracts/display-types';
import { IRegionOverlay } from '../../contracts/region-overlay.contract';
import { SpatialObservations } from '../../contracts/spatial-dataset.contract';
import { SPATIAL_DATA_PORT, SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import { TILE_ACCESS_PORT, TileAccessPort } from '../../contracts/ports/tile-access.port';
import { VIZ_CONFIG, VizConfig } from '../../contracts/viz-config';
import { ICellSegmenter, CELL_SEGMENTER } from '../../contracts/cell-segmenter.contract';
import { ViewerCapabilities, ViewerFeature, capabilitiesOf } from '../../contracts/capabilities.contract';
import {
  PlotType, PlotTypeDescriptor, PLOT_TYPE_DESCRIPTORS, NAPARI_DEFAULT_DECIMATE, isNapari3d,
  isNapariIsosurface, isNapariScatter, isNapariScatter3d, isNapariSurface, isSpatialOmics, isSpatialOmics3d,
} from '../../contracts/plot-type';
import {
  IViewerBackend, PixelData, IntensityProfile, IIsosurfaceControls, IIntensityControls, ISurface3dControls,
} from '../../contracts/visualizer.contract';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { SpatialSelectionStore } from '../../store/spatial-selection.service';
import { CanvasToolHost } from '../../toolbar/tool-kit/canvas-tool';
import { CanvasToolManager } from '../../toolbar/tool-kit/canvas-tool-manager';
import { WandService } from '../../toolbar/wand/wand.service';
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { BaseStoreVisualizer } from '../base-store-visualizer';
import { throwIfAborted } from '../tile-server';
import { SimpleSliceAccessService } from '../simple-slice-access.service';
import { ZOOM_BUTTON_STEP } from '../osd/osd-zoom';
import { NAPARI_WHEEL_ZOOM_SPEED } from './napari-zoom';
import { TranscriptEstimate } from './napari-spatial-tiles';
import { NapariTileClient } from './napari-tile-client';
import { NapariDisplayState } from './napari-display-state';
import { LoadingBadgeState } from './napari-loading-state';
import { NapariToolBridge } from './napari-tool-bridge';
import { cameraDragMode } from './napari-axes-gizmo';
import { NapariScene, NapariSettings, SceneContext } from './napari-scene';
import { Image2dScene, ScatterRegionsScene } from './napari-image-2d-scene';
import { Scatter3dScene, VolumeScene } from './napari-volume-scene';
import { SurfaceScene } from './napari-surface-scene';
import { SpatialSession } from './napari-spatial-scene';
import { Spatial2dScene } from './napari-spatial-2d-scene';
import { Spatial3dScene } from './napari-spatial-3d-scene';

/** Opaque handle from {@link NapariVisualizerService.load}, passed back to plot(). */
interface NapariLoaded {
  imageInfo: IImageInfo;
  z: number;
  /** Must match `IImageInfo.fileName` — the render orchestrator drops the result if the
   *  handle's `filename` doesn't match the requested image (guards against stale clicks). */
  filename: string;
}

/**
 * The WebGPU image backend, built on the published `napari-js` library (jit-ui#102: a
 * browser-based napari shipped as a JS library, alongside OpenSeadragon for images and Plotly
 * for 3D).
 *
 * One scene is mounted per {@link plot}, chosen by plot type:
 *  - **2D image** (and the region-centroid scatter and spatial-omics views over it): pyramidal
 *    `TiledSource`s against the jit-service `/tile` endpoint when `/tiles/info` describes the
 *    image, else a single stitched level (`tiled:false` stacks fetch each slice's own URL);
 *    multichannel additive tints, grayscale colormap or RGB; scale bar, navigator, region
 *    overlay and the shared pixel tools (wand, brush, eraser, zoom-to-box, SAM/cellpose).
 *  - **Volume / isosurface / 3D scatter / surface**: slices assembled into a decimated volume
 *    (or one height field per slice), with the axes gizmo and the Z-height handle.
 *  - **Spatial omics 2D / 3D**: observation markers or a 3D cloud, gene maps, density volumes,
 *    level-of-detail tiles, hover tooltip and click-to-select.
 *
 * Per-channel histograms come from the client data, or from the server's `/histogram` for
 * >8-bit images; TIFF export from `/export/tiff`. Region state and display options delegate to
 * the shared {@link RegionStore} / {@link VisualizerStore} through {@link BaseStoreVisualizer},
 * exactly as OSD does. napari-js's render loop and the hot pointer paths run outside the
 * Angular zone.
 */
@Injectable({ providedIn: 'root' })
export class NapariVisualizerService extends BaseStoreVisualizer implements IViewerBackend {
  readonly capabilities: ViewerCapabilities = capabilitiesOf([
    ViewerFeature.ImageDisplay,
    ViewerFeature.StackSlider,
    ViewerFeature.PixelReadback,
    ViewerFeature.Surface3D,
    ViewerFeature.Isosurface,
  ]);

  /** The jit-service tile server: descriptor, slices, tiled sources, histograms, export. */
  private readonly tileClient: NapariTileClient;
  /** napari-js's render loop and the hot pointer/timer paths run outside the Angular zone
   *  (NAPARI-SVC-25); what they produce for the UI re-enters it through {@link inZone}. */
  private readonly zone = inject(NgZone);

  private viewer: Viewer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private host: HTMLElement | null = null;
  private loaded: NapariLoaded | null = null;
  /** For the panel: the transcripts-in-view estimate and the density window in use. */
  readonly transcriptEstimate$ = new BehaviorSubject<TranscriptEstimate | null>(null);
  /** Transcripts of each selected gene in view (see NapariSpatialTileLayers.geneCountsIn). */
  readonly geneCountsInView$ = new BehaviorSubject<Record<string, number> | null>(null);
  readonly densityStats$ = new BehaviorSubject<{ lo: number; hi: number; max: number } | null>(null);
  /** "x reloading…" at the bottom of the canvas: the tile layers' loads and the observations'. */
  private readonly badge = new LoadingBadgeState();
  /** The store's display state (colormap, reverse, invert) and the colormaps derived from it. */
  private readonly display: NapariDisplayState;
  /**
   * The mounted scene's lifetime: aborted by {@link reset}, so everything a plot starts — its
   * descriptor poll, its tile fetches, its badge counts, its awaits — can tell that a newer plot
   * has replaced it. A tile that settles after a reset belongs to the aborted scene and leaves the
   * new scene's count alone.
   */
  private lifetime = new AbortController();
  /** What {@link plot} mounted, while it is mounted. */
  private scene: NapariScene | null = null;
  /** Spatial state that outlives a scene (latest data, windows, estimated gene-map fields). */
  private readonly spatial: SpatialSession;
  /** Viewer settings that outlive a scene. */
  private readonly settings: NapariSettings = {
    resolutionScale: NAPARI_DEFAULT_DECIMATE,
    navigatorVisible: true,
    imageSmoothing: false,
    axesVisible: true,
    surfaceWireframe: false,
    volumeZScale: 1,
  };
  /**
   * Frame loading (volume assembly, surface preload): aborted by {@link reset} AND by
   * {@link cancelLoading}, so a Cancel actually stops fetching frames instead of running to
   * completion in the background, while the scene itself stays mounted. (Latest-wins WITHIN a
   * scene — a scrub, a colour rebuild, a hover-source fetch — is each scene's own business.)
   */
  private loading = new AbortController();
  /** The image's full-resolution size as the last scene drew it (it outlives the scene). */
  private imageW = 0;
  private imageH = 0;
  /** The region overlay, the pixel tools and the displayed-pixel readback they read. */
  private readonly tools: NapariToolBridge;
  /** What this backend's canvas tools read and write (one host for every tool). */
  private readonly toolHost: CanvasToolHost;
  /** This backend's own wand, brush, eraser, zoom-to-box and SAM point tools. */
  protected readonly canvasTools: CanvasToolManager;
  private readonly stackLoading$ = new BehaviorSubject<boolean>(false);
  private readonly stackLoadingProgress$ = new BehaviorSubject<number>(0);
  private readonly autoscaleEvent$ = new Subject<unknown>();
  private readonly intensityProfile$ = new Subject<IntensityProfile[]>();
  private readonly viewportChange$ = new Subject<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>();

  constructor(
    @Inject(TILE_ACCESS_PORT) tiles: TileAccessPort,
    store: VisualizerStore,
    regionStore: RegionStore,
    wandService: WandService,
    private readonly samTool: SamToolService,
    private readonly samPointTool: SamPointToolService,
    cellSegmentTool: CellSegmentToolService,
    @Optional() @Inject(CELL_SEGMENTER) cellSegmenter: ICellSegmenter | null,
    private readonly simpleStack: SimpleSliceAccessService,
    @Inject(VIZ_CONFIG) config: VizConfig,
    // Optional: only a host that serves spatial-omics data provides it, and
    // without it the SPATIAL_OMICS plot type is never offered anyway.
    @Optional() @Inject(SPATIAL_DATA_PORT) spatialData: SpatialDataPort | null = null,
    selectionStore: SpatialSelectionStore | null = null,
  ) {
    super(regionStore, store);
    this.tileClient = new NapariTileClient(tiles, simpleStack, config.slideCropServer);
    this.tileClient.startScene(this.lifetime.signal);
    this.display = new NapariDisplayState(store);
    this.spatial = new SpatialSession(spatialData, selectionStore, {
      continuousLut: (view) => this.display.spatialLut(view),
      // These follow the camera, which moves outside the zone; the panel reads them.
      estimateChanged: (e) => this.inZone(() => this.transcriptEstimate$.next(e)),
      geneCountsChanged: (c) => this.inZone(() => this.geneCountsInView$.next(c)),
      densityChanged: (d) => this.inZone(() => this.densityStats$.next(d)),
      loadingChanged: (layers) => this.badge.setTileLayers(layers),
    });
    this.tools = new NapariToolBridge({
      viewer: () => this.viewer,
      host: () => this.host,
      canvas: () => this.canvas,
      imageSize: () => this.getTrueImageSize(),
      frameIndex: () => this.loaded?.z ?? 0,
      fileName: () => this.loaded?.filename,
      // Reached from timers armed outside the zone; subscribers are UI.
      viewportChanged: (rect) => this.inZone(() => this.viewportChange$.next(rect)),
      outsideZone: (fn) => this.zone.runOutsideAngular(fn),
      inZone: (fn) => this.inZone(fn),
    }, { regionStore, wandService, samTool, samPointTool, cellSegmentTool, cellSegmenter });
    this.toolHost = this.tools.toolHost;
    this.canvasTools = this.tools.canvasTools;
  }

  /** Run `fn` inside the Angular zone: for output (subjects the UI renders, store writes)
   *  produced by work that runs outside it. */
  private inZone<T>(fn: () => T): T {
    return NgZone.isInAngularZone() ? fn() : this.zone.run(fn);
  }

  /** What a scene is built from (see {@link SceneContext}). */
  private sceneContext(viewer: Viewer, host: HTMLElement, canvas: HTMLCanvasElement): SceneContext {
    return {
      viewer,
      host,
      canvas,
      signal: this.lifetime.signal,
      loading: () => this.loading.signal,
      info: () => this.loaded?.imageInfo,
      z: () => this.loaded?.z ?? 0,
      tiles: this.tileClient,
      display: this.display,
      badge: this.badge,
      tools: this.tools,
      store: this.store,
      regionStore: this.regionStore,
      settings: this.settings,
      stack: {
        loading: (on) => this.stackLoading$.next(on),
        progress: (percent) => this.stackLoadingProgress$.next(percent),
      },
      imageSize: () => ({ width: this.imageW, height: this.imageH }),
      setImageSize: (width, height) => {
        this.imageW = width;
        this.imageH = height;
      },
      fitCameraSoon: () => this.fitCameraSoon(),
      outsideZone: (fn) => this.zone.runOutsideAngular(fn),
      inZone: (fn) => this.inZone(fn),
    };
  }

  // ── IDataRenderer: load / render / viewport ───────────────────────────────
  /**
   * Record the image to draw. No network work happens here — the descriptor poll and the tile,
   * volume and spatial fetches all run in {@link plot} under its scene signal, which a newer plot,
   * {@link reset} or `cancelLoading()` aborts — so `signal` is only checked: an already-aborted
   * load rejects with an `AbortError` and leaves the recorded image alone.
   */
  async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<NapariLoaded> {
    throwIfAborted(signal);
    // Keeps SimpleSliceAccessService's blob cache in sync even when the user
    // switches backends (e.g. OSD Image → napari Volume) on the same file —
    // whichever backend loads a genuinely different file first evicts it.
    this.simpleStack.noteActiveFile(imageInfo.fileName);
    this.loaded = { imageInfo, z: zIndex, filename: imageInfo.fileName };
    return this.loaded;
  }

  async plot(
    plotDiv: string,
    imageLoaded: unknown,
    imageInfo: IImageInfo,
    screenHeight: number,
    plotType: PlotType,
    inPlace?: boolean,
  ): Promise<boolean> {
    const host = document.getElementById(plotDiv);
    if (!host) {
      console.error(`[napari-js] plot target #${plotDiv} not found`);
      return false;
    }
    this.reset();
    // A new image: a stroke or SAM prompt in progress belonged to the old one.
    if (!inPlace) this.canvasTools.resetAll();
    // This plot's scene. A newer plot resets into the next one while this one still awaits, and
    // a superseded plot must not go on to draw (or count image tiles) into the newer scene.
    const scene = this.lifetime.signal;
    this.host = host;
    this.badge.attach(host);

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = screenHeight ? `${screenHeight}px` : '100%';
    host.appendChild(canvas);
    this.canvas = canvas;

    const info = (imageLoaded as NapariLoaded)?.imageInfo ?? imageInfo;

    try {
      // Built OUTSIDE the Angular zone, so its requestAnimationFrame loop, its canvas pointer /
      // wheel listeners and its ResizeObserver do not each trigger app-wide change detection.
      // Whatever they cause that the UI shows re-enters the zone (see inZone).
      const viewer = this.zone.runOutsideAngular(() => new Viewer({
        canvas,
        background: { r: 0.07, g: 0.07, b: 0.09, a: 1 },
        // Set here rather than left to napari-js's own default so the gentler
        // step applies with the version currently installed. Chosen to match the
        // OSD backend's step (see OSD_ZOOM_PER_SCROLL): the wheel should feel the
        // same on an image whichever renderer is drawing it. The step applies per
        // scroll EVENT, and a trackpad sends a burst of them per swipe, so a step
        // tuned to a mouse notch runs away under a trackpad.
        wheelZoomSpeed: NAPARI_WHEEL_ZOOM_SPEED,
        // The FIRST 3D layer of a scene frames the orbit camera; every later one leaves the
        // pose alone. A spatial scene is built from several layers and rebuilt constantly —
        // recolouring by a class, picking a gene, stepping a section — and with napari-js's
        // previous unconditional framing each of those threw away an orbit the user had set.
        // The pose it snapped back to depended on WHICH layer was rebuilt, so isolating one
        // section zoomed to that section's bounds. `resetFit3D()` on a dataset change is what
        // lets the next scene frame itself.
        fit3d: 'once',
        // In the spatial modes a plain click SELECTS the class under the cursor,
        // so napari's OSD-style click-to-zoom is turned off there: otherwise one
        // click would both select a class and zoom 2x about the cursor, and the
        // zoom would then halve the pixel radius the next click hit-tests with.
        // Zooming is still on the wheel, the zoom buttons and the zoom-box tool.
        ...(isSpatialOmics(plotType) || isSpatialOmics3d(plotType)
          ? { clickZoomFactor: 0 }
          : {}),
      }));
      this.viewer = viewer;
      await viewer.ready;
      if (scene.aborted) return false;

      // No loaded image: an image-less spatial dataset opened before any image (the visualizer's
      // plotSpatialWithoutImage) — the observations alone.
      this.scene = this.createScene(plotType, this.sceneContext(viewer, host, canvas), info, imageLoaded == null);
      await this.scene.mount();
      this.tools.scheduleReadback();
      return true;
    } catch (err) {
      console.error('[napari-js] plot failed:', err);
      return false;
    }
  }

  /** The scene a plot type mounts. */
  private createScene(
    plotType: PlotType, ctx: SceneContext, info: IImageInfo | undefined, noImage: boolean,
  ): NapariScene {
    if (isSpatialOmics3d(plotType)) return new Spatial3dScene(ctx, this.spatial);
    if (isSpatialOmics(plotType)) return new Spatial2dScene(ctx, this.spatial, noImage);
    if (isNapariScatter(plotType)) return new ScatterRegionsScene(ctx);
    if (isNapariScatter3d(plotType)) return new Scatter3dScene(ctx, info);
    if (isNapariSurface(plotType)) return new SurfaceScene(ctx);
    if (isNapari3d(plotType)) return new VolumeScene(ctx, info, isNapariIsosurface(plotType) ? 'iso' : 'mip');
    return new Image2dScene(ctx);
  }

  /** Show/hide the overview navigator (same setting as OSD's). */
  setNavigatorVisible(visible: boolean): void {
    this.settings.navigatorVisible = visible;
    this.scene?.setNavigatorVisible?.(visible);
  }

  /** Observations projected to canvas pixels under the 3D camera (the spatial 3D cloud), indexed
   *  by observation with NaN for any not drawn; null when no cloud is mounted. */
  getSpatialScreenProjection(obs: SpatialObservations): Float32Array | null {
    return this.scene?.screenProjection?.(obs) ?? null;
  }

  private fitCameraSoon(): void {
    const run = (): void => {
      if (this.viewer && this.canvas && this.imageW > 0 && this.imageH > 0) {
        this.viewer.camera.fit(
          this.imageW,
          this.imageH,
          this.canvas.clientWidth || this.imageW,
          this.canvas.clientHeight || this.imageH,
        );
      }
    };
    if (typeof requestAnimationFrame === 'function') this.zone.runOutsideAngular(() => requestAnimationFrame(run));
    else run();
  }

  /** @deprecated Plotly-specific; host re-drives plot() from its image stream. */
  reloadAndPlot(): void {
    /* no-op */
  }

  /**
   * End the mounted scene: abort its lifetime (its descriptor poll, tile counts, frame loading and
   * awaits) and dispose it — its layers, keys, subscriptions and listeners go with it, so the next
   * plot can never inherit an "already built" key (NAPARI-SVC-1) — then tear the viewer down.
   */
  reset(): void {
    this.loading.abort();
    this.loading = new AbortController();
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.scene?.dispose();
    this.scene = null;
    this.badge.reset();
    this.tools.teardown();
    this.tileClient.startScene(this.lifetime.signal);
    this.viewer?.dispose();
    this.viewer = null;
    if (this.canvas && this.host?.contains(this.canvas)) this.host.removeChild(this.canvas);
    this.canvas = null;
  }

  relayout(_trueImageSize?: number[]): void {
    this.viewer?.requestRender();
  }

  /** @deprecated Plotly-specific axis reset. */
  resetAxes(): void {
    this.fitCameraSoon();
  }

  /** @deprecated Plotly-specific autoscale. */
  autoscale(): void {
    this.fitCameraSoon();
    this.autoscaleEvent$.next(undefined);
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_BUTTON_STEP);
  }

  zoomOut(): void {
    this.zoomBy(1 / ZOOM_BUTTON_STEP);
  }

  /** Zoom by `factor` (> 1 = in) on whichever camera is live: the 2D camera's zoom, or — in a 3D
   *  scene, where that would change nothing visible — the orbit camera's distance. */
  private zoomBy(factor: number): void {
    const v = this.viewer;
    if (!v) return;
    if (v.dims.ndisplay === 3) v.camera3d.zoomBy(1 / factor); // zoomBy scales the distance
    else v.camera.zoom = v.camera.zoom * factor;
  }

  setDragMode(_mode: string | false): void {
    // No-op: pan and zoom are always the napari camera's default gestures, and pan/zoom gating for
    // drawing is owned by the region overlay's setMode (setControlsEnabled). Toggling controls here
    // would fight that — the host calls setDragMode(false) alongside overlay.setMode(<tool>).
  }

  setImageSmoothingEnabled(enabled: boolean): void {
    this.settings.imageSmoothing = enabled;
    // Apply live to the rendered image layers; baked into the next render too.
    this.scene?.setImageSmoothing?.(enabled);
  }

  setShowStack(_showstack: boolean): void {
    /* stack navigated via setZIndex */
  }

  setZIndex(zIndex: number): void {
    if (this.loaded) this.loaded.z = zIndex;
    if (!this.viewer) return;
    // Dispatch on WHAT IS MOUNTED, not on which layer handle happens to be non-null: a surface
    // still preloading (or whose first build failed) has no layer yet, and a 3D scatter or cloud
    // has none of them — and both used to fall through to the 2D render (NAPARI-SVC-9).
    this.scene?.setZ(zIndex);
  }

  setStackLoading(stackLoading: boolean): void {
    this.stackLoading$.next(stackLoading);
  }

  /** Cancel in-flight frame loading: abort {@link loading} so the volume-assembly / surface
   *  preload workers stop fetching more frames, and clear the loading flag + progress. */
  cancelLoading(): void {
    this.loading.abort();
    this.loading = new AbortController();
    this.stackLoading$.next(false);
    this.stackLoadingProgress$.next(0);
  }

  isStackLoading(): Observable<boolean> {
    return this.stackLoading$.asObservable();
  }

  getStackLoadingProgress(): Observable<number> {
    return this.stackLoadingProgress$.asObservable();
  }

  getTrueImageSize(): { width: number; height: number } | null {
    return this.imageW > 0 && this.imageH > 0 ? { width: this.imageW, height: this.imageH } : null;
  }

  getCurrentImage(): Promise<Image | null> {
    return Promise.resolve(null);
  }

  getDisplayedPixelData(): PixelData | null {
    return this.tools.lastPixels;
  }

  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    const v = this.viewer;
    const size = this.getTrueImageSize();
    if (!v || !size) return null;
    const r = v.visibleWorldRect();
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    return {
      x,
      y,
      width: Math.min(size.width, r.x + r.width) - x,
      height: Math.min(size.height, r.y + r.height) - y,
    };
  }

  downloadImage(): void {
    void this.exportComposite();
  }

  /** No-op: the mounted scene is fixed per {@link plot}; a new plot type takes a re-plot. */
  setPlotType(_plotType: PlotType): void {
    /* the scene is chosen by plot() */
  }

  /** Map a Plotly-style 3D drag mode onto napari-js's camera drag mode. */
  setSurfaceDragMode(mode: string): void {
    if (!this.viewer) return;
    this.viewer.setCameraDragMode(cameraDragMode(mode));
  }

  /** Re-frame the 3D camera on the scene: napari-js frames the union of every 3D layer's bounds
   *  (surface, volume, point cloud), with the viewport-aware framing its adders use. */
  resetSurfaceCamera(): void {
    this.viewer?.fitToLayers();
    this.viewer?.requestRender();
  }

  getAutoscaleEvent(): Observable<unknown> {
    return this.autoscaleEvent$.asObservable();
  }

  /**
   * The plot types this backend can mount — every type {@link plot} dispatches on.
   *
   * Contract-only in production: the router answers `getPlotTypeDescriptors` from the Plotly
   * service, so nothing reaches this one through it; it is kept accurate for direct callers.
   */
  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    // The WebGPU napari-js options, offered alongside (not replacing) the OSD/Plotly types.
    return [
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_IMAGE]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_SCATTER]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_SURFACE]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_SCATTER3D]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_VOLUME]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_ISOSURFACE]!,
      // Gated by `requiresSpatialData`, so the selector hides them until a dataset is published
      // (the 3D one also by `requiresSpatial3d`).
      PLOT_TYPE_DESCRIPTORS[PlotType.SPATIAL_OMICS]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.SPATIAL_OMICS_3D]!,
    ];
  }

  /** The napari 3D decimate factor (1 = full … 8 = ⅛). Read by the toolbar to init the control. */
  getResolutionScale(): number {
    return this.settings.resolutionScale;
  }

  /** Set the decimate factor for the napari 3D types. Takes effect on the next (re)load — the host
   *  re-plots after calling this, since decimation changes the fetched/assembled data. */
  setResolutionScale(scale: number): void {
    this.settings.resolutionScale = Math.max(1, Math.round(scale));
  }

  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.intensityProfile$.asObservable();
  }

  renderIntensityInset(_divId: string, _profiles: IntensityProfile[]): void {
    /* Plotly owns the intensity inset */
  }

  // ── IRegionStore + classification colours ──────────────────────────────────
  // Inherited from BaseStoreVisualizer — pure delegations to the shared
  // RegionStore / VisualizerStore (identical to the OSD backend).

  // ── IToolController ────────────────────────────────────────────────────────
  // setActiveTool and the per-tool setters run in BaseStoreVisualizer over this.canvasTools; the
  // pointer and readback gating, and the SAM / cellpose runs, are the tool bridge's.

  protected override beforeToolChange(next: CanvasToolId | null): boolean {
    return this.tools.beforeToolChange(next);
  }
  segmentRectangles(): Promise<number> {
    return this.tools.segmentRectangles();
  }
  segmentRectanglesCellpose(): Promise<number> {
    return this.tools.segmentRectanglesCellpose();
  }
  setSamModel(id: string): void {
    this.samTool.setModel(id);
    this.samPointTool.setModel(id);
  }

  // ── IDisplayOptions ───────────────────────────────────────────────────────
  // Inherited from BaseStoreVisualizer — pure delegations to the shared
  // VisualizerStore (identical to the OSD backend).

  // ── IIntensitySampling: Plotly owns sampling; emit viewport changes ───────
  ensureIntensitySampling(_imageInfo: IImageInfo, _zIndex: number): Promise<void> {
    return Promise.resolve();
  }
  refreshIntensitySamplingForRoi(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
    _zIndex: number,
  ): void {
    /* Plotly owns intensity sampling */
  }
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.viewportChange$.asObservable();
  }

  // ── IVisualizer composite members ─────────────────────────────────────────
  getRegionOverlay(): IRegionOverlay | null {
    return this.tools.regionOverlay;
  }
  getIsosurfaceControls(): IIsosurfaceControls | null {
    return this.scene?.isoControls?.() ?? null;
  }
  getIntensityControls(): IIntensityControls | null {
    return null;
  }
  getSurface3dControls(): ISurface3dControls | null {
    return this.scene?.surface3dControls?.() ?? null;
  }
  getHistogram(channelIndex: number, bins: number): IHistogram | null {
    if (!this.viewer) return null;
    return this.scene?.histogram(channelIndex, bins) ?? null;
  }
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null> {
    // >8-bit channels: the true native distribution from the server (the displayed pixels are
    // 8-bit, so the client histogram would be clipped). 8-bit channels use the client path.
    return this.tileClient.nativeHistogram$(this.loaded?.imageInfo, this.loaded?.z ?? 0, channelIndex, bins)
      ?? of(this.getHistogram(channelIndex, bins));
  }

  /** Save the displayed composite as a PNG. Through file-saver, which (unlike revoking an object
   *  URL straight after `a.click()`) does not race the browser's download. */
  exportComposite(): void {
    const v = this.viewer;
    if (!v) return;
    void v
      .screenshot()
      .then((blob) => saveAs(blob, 'napari-js.png'))
      .catch((err) => console.warn('[napari-js] PNG export failed', err));
  }
  /** Native-bit-depth (16/32-bit) multi-band TIFF export via the server `/export/tiff` endpoint —
   *  the displayed PNG is an 8-bit figure, this preserves the true pixel values. Visible channels
   *  only (omitted when all are visible → server default). Mirrors the OSD backend. */
  async exportData(): Promise<void> {
    await this.tileClient.exportTiff(
      this.loaded?.z ?? 0, this.store.currentChannelStates(), this.loaded?.filename,
    );
  }
  unsubscribe(): void {
    this.reset();
  }
}

