import { Inject, Injectable, NgZone, Optional, inject } from '@angular/core';
import { Observable, BehaviorSubject, Subject, Subscription, combineLatest, of } from 'rxjs';
import { Image } from 'image-js';
import { saveAs } from 'file-saver';
import { Viewer } from 'napari-js';
import type { ImageLayer, PointsLayer } from 'napari-js';

import { IImageInfo } from '../../contracts/image.contract';

import { SPATIAL_DATA_PORT, SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import {
  SpatialColumn, SpatialDataset, SpatialImageRef, isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import {
  encodeCategorical, markerDiameters, resolveCategoryColors, toRgbaTuples, type RGBA,
} from '../../spatial/spatial-encoding';
import { NO_CATEGORY } from '../../contracts/spatial-dataset.contract';
import { SpatialObservations } from '../../contracts/spatial-dataset.contract';
import {
  SpatialSelectionMask, emptySelection, maskToIndices, mutedFromSelection,
} from '../../spatial/spatial-selection';
import { framePositions } from '../../spatial/spatial-framing';
import { PIXEL_WORLD_QUANTUM, worldQuantumForExtent } from '../../spatial/world-grid';
import { observationsInSlice, volumeImageRef } from '../../spatial/spatial-volume-image';

import { NapariSpatialTileLayers, TranscriptEstimate } from './napari-spatial-tiles';

import { LoadingBadgeState } from './napari-loading-state';
import { NapariToolBridge } from './napari-tool-bridge';
import { SpatialHover } from './napari-spatial-hover';
import { NapariScene, NapariSettings, SceneContext } from './napari-scene';
import { SpatialSession } from './napari-spatial-scene';
import { Spatial3dScene } from './napari-spatial-3d-scene';
import { Scatter3dScene, VolumeScene } from './napari-volume-scene';
import { SurfaceScene } from './napari-surface-scene';
import { Image2dScene, ScatterRegionsScene } from './napari-image-2d-scene';
import { cameraDragMode } from './napari-axes-gizmo';
import { NapariDisplayState } from './napari-display-state';
import { NapariTileClient } from './napari-tile-client';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import { NAPARI_WHEEL_ZOOM_SPEED } from './napari-zoom';
import { ZOOM_BUTTON_STEP } from '../osd/osd-zoom';
import { colorExpressionField, expressionField, fieldContrastWindow } from '../../spatial/spatial-expression';

import { SpatialSelectionStore } from '../../store/spatial-selection.service';
import { SceneKind, sceneKindOf } from './napari-helpers';
import {
  GENE_MAP_MAX_SIDE, GENE_MAP_SIGMA, SPATIAL_FALLBACK_RADIUS, SPATIAL_NEUTRAL_COLOR,
  SPATIAL_NEUTRAL_HEX, SPATIAL_SLICE_MIN_DIAMETER_PX, encodeSpatialContinuous, gatherColors,
} from './napari-spatial-encoding';
import {
  PlotType,
  PlotTypeDescriptor,
  PLOT_TYPE_DESCRIPTORS,
  isNapari3d,
  isNapariIsosurface,
  isNapariSurface,
  isNapariScatter,
  isNapariScatter3d,
  isSpatialOmics,
  isSpatialOmics3d,
  NAPARI_DEFAULT_DECIMATE,
} from '../../contracts/plot-type';
import {
  IViewerBackend,
  PixelData,
  IntensityProfile,
  IIsosurfaceControls,
  IIntensityControls,
  ISurface3dControls,
} from '../../contracts/visualizer.contract';
import {
  ViewerCapabilities,
  ViewerFeature,
  capabilitiesOf,
} from '../../contracts/capabilities.contract';
import { IRegionOverlay } from '../../contracts/region-overlay.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { ColormapNode } from '../../contracts/display-types';
import { VIZ_CONFIG, VizConfig } from '../../contracts/viz-config';
import { TILE_ACCESS_PORT, TileAccessPort } from '../../contracts/ports/tile-access.port';
import { BaseStoreVisualizer } from '../base-store-visualizer';

import { TileDescriptor, throwIfAborted } from '../tile-server';
import { SimpleSliceAccessService } from '../simple-slice-access.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';

import { CanvasToolHost } from '../../toolbar/tool-kit/canvas-tool';
import { CanvasToolManager } from '../../toolbar/tool-kit/canvas-tool-manager';

import { WandService } from '../../toolbar/wand/wand.service';
import { CanvasToolId } from '../../contracts/display-types';
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { ICellSegmenter, CELL_SEGMENTER } from '../../contracts/cell-segmenter.contract';

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

  private readonly api: string;
  /** The jit-service tile server: descriptor, slices, tiled sources, histograms, export. */
  private readonly tileClient: NapariTileClient;
  /** napari-js's render loop and the hot pointer/timer paths run outside the Angular zone
   *  (NAPARI-SVC-25); what they produce for the UI re-enters it through {@link inZone}. */
  private readonly zone = inject(NgZone);

  private viewer: Viewer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private host: HTMLElement | null = null;
  private loaded: NapariLoaded | null = null;
  private currentPlotType: PlotType = PlotType.NAPARI_IMAGE;
  /** The kind of scene {@link plot} mounted — fixed per plot, unlike {@link currentPlotType},
   *  which {@link setPlotType} can change under it. Drives {@link setZIndex}. */
  private mounted: SceneKind | null = null;
  /** Spatial-omics observation markers + the dataset/view subscription driving them. */
  private spatialPoints: PointsLayer | null = null;
  /** The gene map: its layer, the field it was estimated from, and the inputs each
   *  was built for — the field is the expensive half and survives a recolour. */
  private geneMapLayer: ImageLayer | null = null;
  private geneMapKey: string | null = null;
  /** Cursor tooltip and click-to-select for the spatial views. */
  private hover: SpatialHover | null = null;
  /** Whose 2D observations the camera has been framed on — see {@link frameSpatialPointsOnce}. */
  private spatial2dFramed: { viewer: Viewer; datasetId: string } | null = null;
  private spatialSub: Subscription | null = null;
  /** Level-of-detail cell outlines, transcripts and density over the 2D view — created on
   *  first use, and only when a spatial port is bound. */
  private spatialTilesMgr: NapariSpatialTileLayers | null = null;
  /** For the panel: the transcripts-in-view estimate and the density window in use. */
  readonly transcriptEstimate$ = new BehaviorSubject<TranscriptEstimate | null>(null);
  /** Transcripts of each selected gene in view (see NapariSpatialTileLayers.geneCountsIn). */
  readonly geneCountsInView$ = new BehaviorSubject<Record<string, number> | null>(null);
  readonly densityStats$ = new BehaviorSubject<{ lo: number; hi: number; max: number } | null>(null);
  /** Which dataset the current marker layer was built for, so a display-only
   *  change (size, colour, opacity, selection) can update it in place. */
  private spatialLayerKey: string | null = null;
  /** Monotonic guard for the async colour rebuild: fetching a gene vector is a
   *  round-trip, so a fast sequence of colour-by changes can resolve out of
   *  order. Only the newest rebuild is allowed to touch the layer. */
  private spatialRebuildToken = 0;
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
  /** The 2D spatial view's image (until the spatial 2D scene owns it). */
  private spatialImage: Image2dScene | null = null;
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
   * completion in the background, while the scene itself stays mounted.
   *
   * The narrower per-request tokens below ({@link sliceReq}, {@link navigatorToken},
   * {@link spatialRebuildToken}, {@link hoverSourceToken}) are "latest wins WITHIN a scene".
   */
  private loading = new AbortController();
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
    @Inject(TILE_ACCESS_PORT) private readonly tiles: TileAccessPort,
    store: VisualizerStore,
    regionStore: RegionStore,
    wandService: WandService,
    private readonly samTool: SamToolService,
    private readonly samPointTool: SamPointToolService,
    private readonly cellSegmentTool: CellSegmentToolService,
    @Optional() @Inject(CELL_SEGMENTER) private readonly cellSegmenter: ICellSegmenter | null,
    private readonly simpleStack: SimpleSliceAccessService,
    @Inject(VIZ_CONFIG) config: VizConfig,
    // Optional: only a host that serves spatial-omics data provides it, and
    // without it the SPATIAL_OMICS plot type is never offered anyway.
    @Optional() @Inject(SPATIAL_DATA_PORT) private readonly spatialData: SpatialDataPort | null = null,
    private readonly selectionStore: SpatialSelectionStore | null = null,
  ) {
    super(regionStore, store);
    this.api = config.slideCropServer;
    this.tileClient = new NapariTileClient(tiles, simpleStack, this.api);
    this.tileClient.startScene(this.lifetime.signal);
    this.display = new NapariDisplayState(store);
    this.spatial = new SpatialSession(spatialData, selectionStore);
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

  /** The image on screen, as {@link load} recorded it. */
  private info(): IImageInfo | undefined {
    return this.loaded?.imageInfo;
  }

  /** The pyramid descriptor of the image on screen, or null when it has none. */
  private currentDescriptor(): TileDescriptor | null {
    return this.tileClient.currentDescriptor(this.info());
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
    this.currentPlotType = plotType;
    this.mounted = sceneKindOf(plotType);

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

      if (isSpatialOmics3d(plotType)) {
        this.scene = new Spatial3dScene(this.sceneContext(viewer, host, canvas), this.spatial);
        await this.scene.mount();
      } else if (isSpatialOmics(plotType)) {
        // No loaded image: an image-less dataset opened before any image (the visualizer's
        // plotSpatialWithoutImage) — the observations alone.
        await this.mountSpatialOmics(this.sceneContext(viewer, host, canvas), imageLoaded == null);
      } else if (isNapariScatter(plotType)) {
        this.scene = new ScatterRegionsScene(this.sceneContext(viewer, host, canvas));
        await this.scene.mount();
      } else if (isNapariScatter3d(plotType)) {
        this.scene = new Scatter3dScene(this.sceneContext(viewer, host, canvas), info);
        await this.scene.mount();
      } else if (isNapariSurface(plotType)) {
        this.scene = new SurfaceScene(this.sceneContext(viewer, host, canvas));
        await this.scene.mount();
      } else if (isNapari3d(plotType)) {
        const rendering = isNapariIsosurface(plotType) ? 'iso' : 'mip';
        this.scene = new VolumeScene(this.sceneContext(viewer, host, canvas), info, rendering);
        await this.scene.mount();
      } else {
        this.scene = new Image2dScene(this.sceneContext(viewer, host, canvas));
        await this.scene.mount();
      }
      this.tools.scheduleReadback();
      return true;
    } catch (err) {
      console.error('[napari-js] plot failed:', err);
      return false;
    }
  }

  // ── Channels: per-channel composite, LUT, native histograms (jit-ui#102) ──────────────────

  /** Show/hide the overview navigator (same setting as OSD's). */
  setNavigatorVisible(visible: boolean): void {
    this.settings.navigatorVisible = visible;
    this.scene?.setNavigatorVisible?.(visible);
  }

  // ── Spatial omics ────────────────────────────────────────────────────────────────────────

  /**
   * Mount the SPATIAL_OMICS view: the tissue image with one marker per observation, coloured by
   * an annotation column or a gene. The markers rebuild whenever the dataset or the view state
   * changes, so switching the colour-by column does not remount the scene.
   *
   * Sets up the full 2D interaction stack — region overlay, pixel-tool hosts, readback currency —
   * exactly as the plain image view does. That is NOT optional here: this mode's selection is
   * driven by drawn ROIs, so without the overlay there is no way to make a selection at all.
   */
  private async mountSpatialOmics(ctx: SceneContext, noImage = false): Promise<void> {
    const { viewer, host } = ctx;
    // With no image loaded there is nothing to render under the observations; they are
    // framed on their own extent, as for any dataset that brings no image.
    const image = new Image2dScene(ctx, {
      image: !noImage,
      // Only fit to the image when this dataset actually has one. Otherwise there is
      // nothing to fit, `imageW`/`imageH` still hold the LAST image's dimensions, and
      // this fits to those — and because it defers to a frame, it lands AFTER the points
      // are added and overwrites the framing they set. That is what left an image-less
      // dataset as a ten-pixel speck off to one side.
      fit: () => !!this.spatial.latest?.[0]?.imageRef,
      onSlice: () => this.redrawSpatialMarkers(),
      onNavigatorInteract: () => this.hover?.hide(),
    });
    this.scene = image;
    this.spatialImage = image;
    await image.mount();
    this.installSpatialHover(host);
    this.spatialTiles()?.attach(viewer);
    this.subscribeSpatial();
    this.tools.scheduleReadback();
  }

  /**
   * Whether the 2D observation markers are drawn: when the user wants them, and not while
   * cell outlines are on screen — then a cell IS its outline, and a circle on top of it is
   * noise. Zoomed out past the outline threshold, the circles stand in for the cells.
   */
  private spatialPointsVisible(): boolean {
    const view = this.spatial.latest?.[1];
    return (view?.showPoints ?? true) && !this.spatialTilesMgr?.outlinesShown;
  }

  /**
   * The tiled-geometry manager, built on first use. Its host callbacks read this
   * service's live state, so it never holds a stale dataset or colormap.
   */
  private spatialTiles(): NapariSpatialTileLayers | null {
    const port = this.spatialData;
    if (!port) return null;
    this.spatialTilesMgr ??= new NapariSpatialTileLayers(port, {
      latest: () => this.spatial.latest,
      canvasSize: () => [this.canvas?.clientWidth ?? 0, this.canvas?.clientHeight ?? 0],
      continuousLut: (view) => {
        return this.display.spatialLut(view);
      },
      // These follow the camera, which moves outside the zone; the panel reads them.
      estimateChanged: (e) => this.inZone(() => this.transcriptEstimate$.next(e)),
      geneCountsChanged: (c) => this.inZone(() => this.geneCountsInView$.next(c)),
      loadingChanged: (layers) => {
        this.badge.setTileLayers(layers);
      },
      densityChanged: (d) => this.inZone(() => this.densityStats$.next(d)),
      polygonsShownChanged: () => {
        if (this.spatialPoints) this.spatialPoints.visible = this.spatialPointsVisible();
        this.viewer?.requestRender();
      },
    });
    return this.spatialTilesMgr;
  }

  /** The spatial views' tooltip and click-to-select, over the scene just mounted. */
  private installSpatialHover(host: HTMLElement): void {
    this.hover?.dispose();
    this.hover = new SpatialHover({
      is3d: false,
      viewer: this.viewer!,
      canvas: this.canvas!,
      port: this.spatialData,
      selection: this.selectionStore,
      dataset: () => this.spatial.latest?.[0] ?? null,
      positions: (obs) => this.hoverWorldPositions(obs),
      depths: () => null,
      tiles: () => this.spatialTilesMgr,
      toolActive: () => !!this.tools.regionOverlay?.toolActive,
      outsideZone: (fn) => this.zone.runOutsideAngular(fn),
      inZone: (fn) => this.inZone(fn),
    });
    this.hover.install(host);
  }

  /**
   * The 2D markers' WORLD positions, indexed by observation, NaN for any not on
   * the displayed plane — the same affine and the same subset the marker layer was
   * built from, so the tooltip cannot point at a cell that is not drawn.
   */
  private hoverWorldPositions(obs: SpatialObservations): Float32Array | null {
    const dataset = this.spatial.latest?.[0];
    if (!dataset || obs.count === 0) return null;
    const slab = this.spatialSlab(dataset);
    const ref = slab?.ref ?? dataset.imageRef;
    const [sx, sy] = ref?.scale ?? [1, 1];
    const [tx, ty] = ref?.translate ?? [0, 0];
    const drawn = slab?.indices ?? null;
    const out = new Float32Array(obs.count * 2).fill(NaN);
    const n = drawn ? drawn.length : obs.count;
    for (let k = 0; k < n; k++) {
      const i = drawn ? drawn[k] : k;
      out[i * 2] = obs.x[i] * sx + tx;
      out[i * 2 + 1] = obs.y[i] * sy + ty;
    }
    return out;
  }

  /** Observations projected to canvas pixels under the 3D camera (the spatial 3D cloud), indexed
   *  by observation with NaN for any not drawn; null when no cloud is mounted. */
  getSpatialScreenProjection(obs: SpatialObservations): Float32Array | null {
    return this.scene?.screenProjection?.(obs) ?? null;
  }

  /** Rebuild the markers on any dataset or view-state change. */
  private subscribeSpatial(): void {
    this.spatialSub?.unsubscribe();
    const port = this.spatialData;
    if (!port) return;
    const selection$ = this.selectionStore?.getSelection$() ?? of(emptySelection());
    // The display colormap is an input here, not just something read at build
    // time: `continuousColormap: null` means "follow the image's colormap", and a
    // setting that only takes effect at the next unrelated rebuild is not one.
    this.spatialSub = combineLatest([
      port.getDataset$(), this.store.getSpatialView$(), selection$,
      this.store.getColormap(), this.store.getReverseScale(),
    ]).subscribe(([dataset, view, selection, colormap, reverse]) => {
      this.display.record((colormap as ColormapNode) ?? null, !!reverse);
      // Kept so a slice change can redraw the markers for the new plane, which
      // arrives through setZIndex rather than through any of these streams.
      this.spatial.latest = [dataset, view, selection];
      // The markers are about to move or change meaning, so both halves of the
      // tooltip — where the points are, and what they are — are stale.
      this.hover?.invalidate();
      void this.hover?.resolveSource(dataset, view);
      void this.rebuildSpatialPoints(dataset, view, selection);
      this.spatialTilesMgr?.refresh();
    });
  }

  /** (Re)build the observation marker layer for the current dataset + view state. */
  private async rebuildSpatialPoints(
    dataset: SpatialDataset | null, view: SpatialViewState,
    selection: SpatialSelectionMask = emptySelection(),
  ): Promise<void> {
    const viewer = this.viewer;
    if (!viewer) return;
    const token = ++this.spatialRebuildToken;

    // Resolve colours BEFORE touching the scene: a gene fetch can fail or be
    // superseded, and dropping the existing layer first would blank the view.
    let faceColor: RGBA[] | RGBA;
    const endLoading = this.badge.begin('Observations');
    try {
      faceColor = dataset
        ? await this.spatialFaceColors(dataset, view, selection)
        : SPATIAL_NEUTRAL_COLOR;
    } catch (err) {
      console.warn('[napari-js] spatial colouring failed — falling back to a flat colour', err);
      faceColor = SPATIAL_NEUTRAL_COLOR;
    } finally {
      endLoading();
    }
    // A newer rebuild (or a teardown) started while the vector was in flight.
    if (token !== this.spatialRebuildToken || this.viewer !== viewer) return;

    if (!dataset || dataset.observations.count === 0) {
      if (this.spatialPoints) {
        viewer.layers.remove(this.spatialPoints);
        this.spatialPoints = null;
        this.spatialLayerKey = null;
      }
      if (this.geneMapLayer) {
        viewer.layers.remove(this.geneMapLayer);
        this.geneMapLayer = null;
        this.geneMapKey = null;
      }
      return;
    }

    const obs = dataset.observations;
    // A dataset whose image IS its volume shows ONE PLANE at a time, so the
    // markers are the observations in the displayed plane, drawn in that plane's
    // pixel grid. Without the filter the specimen's whole depth piles onto one
    // section and reads as a smear; without the affine the coordinates are read
    // as pixels and land off the slice entirely.
    const slab = this.spatialSlab(dataset);
    // The gene map goes UNDER the cells, so it is settled before they are added.
    await this.ensureGeneMap(viewer, dataset, view, selection, slab);
    if (token !== this.spatialRebuildToken || this.viewer !== viewer) return;
    const ref = slab?.ref ?? dataset.imageRef;
    const base = markerDiameters(obs, SPATIAL_FALLBACK_RADIUS);
    const scale = view.pointScale > 0 ? view.pointScale : 1;
    const floor = slab?.minDiameter ?? 0;
    const sizeOf = (i: number) =>
      Math.max(typeof base === 'number' ? base : base[i], floor) * scale;
    const size: number | Float32Array =
      typeof base === 'number' && !slab
        ? Math.max(base, floor) * scale
        : Float32Array.from(slab?.indices ?? { length: obs.count }, (_v, i) =>
            sizeOf(slab ? slab.indices[i] : i));

    // napari's image view CLEARS the whole layer list on every render, so the
    // markers go with it whenever the image is re-rendered — a scrub, a contrast
    // change. The cached handle is then detached, and mutating it draws nothing:
    // treat a layer that is no longer in the scene as absent so it gets re-added.
    if (this.spatialPoints && !viewer.layers.items.includes(this.spatialPoints)) {
      this.spatialPoints = null;
      this.spatialLayerKey = null;
    }

    // A size/colour/opacity/selection change is DISPLAY-only: mutate the layer
    // rather than dropping and re-adding it. Both setters bump the layer's
    // dataVersion, which is what makes napari-js rebuild the instance buffer and
    // redraw — and it avoids rebuilding 84k positions to change one number.
    // The slice is part of the key: a scrub changes WHICH observations are drawn,
    // which is geometry, not display.
    const key = `${dataset.id}:${obs.count}:${slab?.slice ?? ''}`;
    if (this.spatialPoints && key === this.spatialLayerKey) {
      this.spatialPoints.size = size;
      this.spatialPoints.visible = this.spatialPointsVisible();
      this.spatialPoints.faceColor = gatherColors(faceColor, slab?.indices);
      this.hideForeignImage(viewer, (!!ref || !!dataset.volume) && view.showImage !== false);
    this.tools.regionOverlay?.setRegionsVisible(view.showAnnotations !== false);
      viewer.requestRender();
      return;
    }

    if (this.spatialPoints) {
      viewer.layers.remove(this.spatialPoints);
      this.spatialPoints = null;
    }

    const drawn = slab?.indices;
    const count = drawn ? drawn.length : obs.count;
    const positions = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const o = drawn ? drawn[i] : i;
      positions[i * 2] = obs.x[o];
      positions[i * 2 + 1] = obs.y[o];
    }
    this.spatialLayerKey = key;
    this.spatialPoints = viewer.addPoints(positions, {
      name: 'observations',
      size,
      faceColor: gatherColors(faceColor, drawn),
      // No border: at Visium spot density an outline per marker reads as noise,
      // and it costs a second colour array.
      borderWidth: 0,
      // The dataset's data->world affine. SpatialData records one per coordinate
      // system (Visium spot coords are in the FULL-resolution frame while the
      // served image may be the hires downscale), so without this the markers
      // land in the right shape at the wrong scale. Defaults to identity when
      // the coordinates are already in the image's pixel space.
      scale: ref?.scale ?? [1, 1],
      translate: ref?.translate ?? [0, 0],
      visible: this.spatialPointsVisible(),
    });
    // Outlines, density and transcripts go back over the markers just added.
    this.spatialTilesMgr?.afterObservations();
    this.frameSpatialPointsOnce(viewer, dataset.id, positions, !!ref);
    this.hideForeignImage(viewer, (!!ref || !!dataset.volume) && view.showImage !== false);
    this.tools.regionOverlay?.setRegionsVisible(view.showAnnotations !== false);
    this.setRegionGridFor(dataset, positions);
  }

  /**
   * Tell the region overlay how finely a drawn vertex may be placed.
   *
   * Region geometry is stored in whole world units, which is right when the world IS
   * pixels — a region should align to them. It is wrong for a dataset that registers onto
   * no image: seqFISH's observations span about 5 x 7 units in total, so whole-unit
   * vertices leave roughly six by eight placeable positions across the entire sample and
   * an ROI cannot be drawn at any zoom. Nothing errors; the tool just cannot express the
   * shape.
   *
   * Keyed on whether the dataset brings PIXELS rather than on the extent, because the
   * extent cannot tell the two apart — 2,000 units is a small slide or a large section
   * depending only on what the units are, and only the dataset knows.
   */
  private setRegionGridFor(dataset: SpatialDataset, positions: Float32Array): void {
    const overlay = this.tools.regionOverlay;
    if (!overlay?.setWorldQuantum) return;
    if (dataset.imageRef || dataset.volume) {
      overlay.setWorldQuantum(PIXEL_WORLD_QUANTUM);
      return;
    }
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let i = 0; i < positions.length; i += 2) {
      const x = positions[i];
      const y = positions[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    overlay.setWorldQuantum(worldQuantumForExtent(maxX - minX, maxY - minY));
  }

  /**
   * Hide the image layer for a dataset that brings no image of its own.
   *
   * The host's viewer keeps whatever image was last loaded, and for a dataset that
   * registers onto none that picture belongs to something else entirely — the example's
   * default slide, say. It is not merely irrelevant: the two live in different coordinate
   * spaces (image pixels against the embedding's own units), so the leftover is magnified
   * roughly a hundredfold. At the fitted zoom the camera sits inside its corner, where it
   * reads as blank background, and it appears only once you zoom out far enough to find
   * it — which is exactly how it gets noticed.
   *
   * Hidden rather than removed, and hidden HERE rather than by clearing the host's image
   * state: that state drives the whole render pipeline, including a Plotly backend whose
   * fields are declared with definite-assignment assertions, so emptying it throws from
   * whichever field the next path happens to read. This touches one layer's visibility
   * and nothing else.
   */
  private hideForeignImage(viewer: Viewer, datasetHasPixels: boolean): void {
    // No image of its own → nothing for an overview to show either.
    this.spatialImage?.showNavigatorFor(datasetHasPixels);
    for (const layer of viewer.layers.items) {
      if (layer.kind !== 'image') continue;
      // The transcript-density raster and the gene map are image layers too, but they are
      // data, not the tissue: the Images toggle must not take them down with the slide.
      if (this.spatialTilesMgr?.owns(layer) || layer === this.geneMapLayer) continue;
      // Re-shown when a dataset that owns an image comes back, so switching between
      // datasets does not leave the tissue permanently hidden.
      layer.visible = datasetHasPixels;
    }
    viewer.requestRender();
  }

  /**
   * Frame the 2D camera on the observations, for a dataset that brings no image.
   *
   * The 2D camera is normally fitted to the IMAGE, because the observations are in that
   * image's pixel space and framing the image frames them too. A dataset with no
   * reference image has coordinates in its own units instead — seqFISH's span about
   * 5x7 — so the image framing left over from whatever was on screen before puts the
   * whole cloud offscreen: measured at 9.7 x 13.4 PIXELS, centred 256px from where the
   * camera was looking. The points are all there and drawn; they are a speck. Which
   * looks exactly like the dataset having failed to load.
   *
   * Once per dataset, as napari-js's `fit3d: 'once'` does for the cloud: re-colouring,
   * slicing or picking a gene re-adds this layer, and re-framing on those would move
   * the camera under the user — the camera tools and the canvas drag are meant to be
   * the only things that do.
   */
  private frameSpatialPointsOnce(
    viewer: Viewer, datasetId: string, positions: Float32Array, registered: boolean,
  ): void {
    // Gated on whether THIS dataset registers onto an image, not on `imageW`/`imageH`:
    // those keep the last plotted image's dimensions after the host clears it, so a
    // stale 512x383 read as "there is an image" and skipped the framing entirely.
    if (registered) return;
    // Once per dataset (see above).
    if (this.spatial2dFramed?.viewer === viewer
      && this.spatial2dFramed.datasetId === datasetId) return;

    const fit = framePositions(
      positions, this.canvas?.clientWidth ?? 0, this.canvas?.clientHeight ?? 0,
    );
    // Null means there is nothing to frame on; leave the camera where it is rather
    // than moving the view for a dataset we cannot fit.
    if (!fit) return;
    viewer.camera.set(fit.center, fit.zoom ?? viewer.camera.zoom);
    this.spatial2dFramed = { viewer, datasetId };
  }

  /**
   * The **gene map**: the active gene's expression as a continuous field drawn under
   * the cells.
   *
   * A scatter coloured by a gene says which cells express it; it cannot say where,
   * because the eye will not integrate thousands of dots into a territory. The field
   * is a kernel-weighted MEAN per cell (see `spatial-expression.ts`), so a dense
   * region does not glow merely for being dense, and it is transparent wherever no
   * cell was measured — an unsampled gap must not read as "not expressed".
   *
   * It shares the points' LUT, percentile window and log flag, so the layer under
   * the cells and the cells themselves cannot disagree about what a colour means.
   *
   * Estimated on the DISPLAYED image's pixel grid, coarsened so the long side is at
   * most {@link GENE_MAP_MAX_SIDE}: a smooth field gains nothing from a slide's full
   * resolution. For a volume-backed dataset that grid is the current slice, and only
   * that plane's observations are included — the same rule the markers follow.
   */
  private async ensureGeneMap(
    viewer: Viewer, dataset: SpatialDataset, view: SpatialViewState,
    selection: SpatialSelectionMask,
    slab: { ref: SpatialImageRef; indices: Uint32Array; slice: number } | null,
  ): Promise<void> {
    const gene = view.geneMap && view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
    const port = this.spatialData;
    const smoothing = view.geneMapSmoothing > 0 ? view.geneMapSmoothing : 1;
    const clip = view.percentileClip ?? [0.01, 0.99];

    // Two clocks: the FIELD depends on the gene, the plane and the bandwidth, while
    // the colours depend on the window, the log flag and the opacity. Recolouring a
    // cached field is a fraction of estimating one.
    const fieldKey = gene
      ? [dataset.id, gene, slab?.slice ?? '', smoothing, this.spatial.selectionRev(selection)].join('|')
      : null;
    const key = fieldKey
      ? [
        fieldKey, clip.join(','), view.logScale ? 'log' : 'lin', view.geneMapOpacity,
        this.display.continuousColormapKey(view),
      ].join('|')
      : null;
    if (key === this.geneMapKey) return;

    if (this.geneMapLayer) {
      viewer.layers.remove(this.geneMapLayer);
      this.geneMapLayer = null;
    }
    // ANY change here changes the order the cells have to sit above — including the
    // first one, where there is no previous layer to remove — and the layer list is
    // append-only. So drop the markers unconditionally and let the rebuild below put
    // them back on top; otherwise the field is appended over the measurement.
    if (this.spatialPoints) {
      viewer.layers.remove(this.spatialPoints);
      this.spatialPoints = null;
      this.spatialLayerKey = null;
    }
    this.geneMapKey = key;
    if (!key || !gene || !port) {
      this.spatial.geneMap.field = null;
      this.spatial.geneMap.key = null;
      return;
    }

    // The raster covers the displayed image; without one there is nothing to
    // overlay and the cloud is the 3D mode's business, not this one's. Gated on the
    // DATASET bringing pixels, not on imageW/H: those keep the last plotted image's
    // size after the host clears it, which would size the map over the wrong extent.
    if (!slab && !dataset.imageRef) return;
    const imageW = slab ? dataset.volume!.width : this.imageW;
    const imageH = slab ? dataset.volume!.height : this.imageH;
    if (!imageW || !imageH) return;
    const step = Math.max(
      1,
      Math.ceil(Math.max(imageW, imageH) / GENE_MAP_MAX_SIDE),
    );

    if (fieldKey !== this.spatial.geneMap.key) {
      let values: Float32Array;
      try {
        values = await port.getFeatureVector(gene);
      } catch (err) {
        console.warn(`[napari-js] gene map: "${gene}" unavailable`, err);
        this.geneMapKey = null;
        return;
      }
      if (this.viewer !== viewer || this.geneMapKey !== key) return;
      const inSelection = selection.count > 0 ? maskToIndices(selection.mask) : undefined;
      this.spatial.geneMap.field = expressionField(dataset.observations, {
        ref: slab?.ref ?? dataset.imageRef,
        width: Math.ceil(imageW / step),
        height: Math.ceil(imageH / step),
        step,
        sigma: GENE_MAP_SIGMA * smoothing,
        values,
        // A plane wins over a selection: the 2D view is showing one section, so a
        // field spanning the specimen's depth would not be the thing on screen.
        indices: slab?.indices ?? inSelection,
      });
      this.spatial.geneMap.key = fieldKey;
    }
    const field = this.spatial.geneMap.field;
    if (!field) return;

    const lut = this.display.spatialLut(view);
    // Over the measured pixels only: unmeasured ones are 0 and would drag the low end down.
    const [lo, hi] = fieldContrastWindow(field, clip[0], clip[1]);
    const rgba = colorExpressionField(field, lut, [lo, hi], {
      log: view.logScale,
      // The MAP's own opacity: reading a field under the cells means turning the
      // cells down, which must not take the field with them.
      opacity: view.geneMapOpacity,
    });
    this.geneMapLayer = viewer.addImage(
      { kind: 'typed', width: field.width, height: field.height, channels: 4, dtype: 'uint8', data: rgba },
      {
        name: `gene map · ${gene}`,
        scale: [step, step],
        translate: [0, 0],
        blending: 'translucent',
      },
    );
    viewer.requestRender();
  }

  /**
   * The plane a volume-backed dataset is currently showing: its pixel affine, the
   * observations that fall in it, and the marker floor that grid needs.
   *
   * Null for a dataset with a real `imageRef` (its coordinates are already the
   * image's pixels and every observation belongs to the one section) and for one
   * with no volume at all — both of which draw exactly as before.
   */
  private spatialSlab(dataset: SpatialDataset): {
    ref: SpatialImageRef; indices: Uint32Array; slice: number; minDiameter: number;
  } | null {
    const volume = dataset.volume;
    if (dataset.imageRef || !volume) return null;
    const slice = this.loaded?.z ?? 0;
    return {
      ref: volumeImageRef(volume, dataset.micronsPerUnit),
      indices: observationsInSlice(dataset.observations, volume, slice),
      slice,
      minDiameter: SPATIAL_SLICE_MIN_DIAMETER_PX * volume.voxelSize[0],
    };
  }

  /**
   * Redraw the observation markers over a freshly rendered image.
   *
   * Two reasons, both invisible from the spatial store — which is why a scrub or a
   * re-render never reached the markers on its own:
   *  - the image render CLEARS the layer list, taking the markers with it;
   *  - over a volume-backed dataset the displayed plane decides which
   *    observations belong on screen at all, so the cells have to move with the
   *    section rather than hang over a different one.
   *
   * Uses the latest values the marker subscription saw; a no-op until it has seen
   * any, in the 3D cloud (no image, no plane), and with no dataset to draw.
   */
  private redrawSpatialMarkers(): void {
    const latest = this.spatial.latest;
    if (!latest?.[0] || isSpatialOmics3d(this.currentPlotType)) return;
    void this.rebuildSpatialPoints(...latest);
  }

  /**
   * Per-observation colours for the current view state, or a single flat colour when nothing is
   * selected to colour by. Categorical columns use the column's own palette; continuous columns
   * and gene vectors go through the active colormap with a percentile-clipped window.
   */
  private async spatialFaceColors(
    dataset: SpatialDataset, view: SpatialViewState, selection: SpatialSelectionMask,
  ): Promise<RGBA[] | RGBA> {
    const port = this.spatialData;
    const colorBy = view.colorBy;
    // Everything NOT selected is muted; with nothing selected, nothing is muted
    // and the whole tissue reads normally (the CosMx highlight-vs-mute rule).
    const muted = mutedFromSelection(selection);

    if (!port || !colorBy) {
      // Genuinely uniform: one broadcast tuple, so a flat 84k-observation view
      // does not allocate 84k of them.
      if (!muted && view.opacity >= 1) return SPATIAL_NEUTRAL_COLOR;
      // Not uniform — the opacity control or a selection varies the alpha, so it
      // has to be per-point. Returning the constant tuple here is what made the
      // Opacity slider do nothing in the default state, which is the state anyone
      // lands in before picking a colour source.
      return toRgbaTuples(encodeCategorical(new Uint16Array(dataset.observations.count), {
        colors: [SPATIAL_NEUTRAL_HEX],
        opacity: view.opacity,
        muted,
      }));
    }

    if (colorBy.kind === 'column') {
      const column: SpatialColumn = await port.getColumn(colorBy.name);
      if (isCategoricalColumn(column)) {
        const rgba = encodeCategorical(column.codes, {
          colors: resolveCategoryColors(column.meta),
          opacity: view.opacity,
          muted,
        });
        // Groups switched off in the Cells panel hide their dots too, when the dots are
        // coloured by that same grouping.
        const groupColumn = cellTypeColumnFor(dataset, view);
        if (view.hiddenGroups?.length && groupColumn === colorBy.name) {
          const off = new Set(view.hiddenGroups);
          const hide = column.meta.categories.map((c) => off.has(c));
          for (let i = 0; i < column.codes.length; i++) {
            const c = column.codes[i];
            if (c !== NO_CATEGORY && hide[c]) rgba[4 * i + 3] = 0;
          }
        }
        return toRgbaTuples(rgba);
      }
      // A continuous column may carry its own log hint (counts); the view's
      // toggle wins once the user has set it.
      return toRgbaTuples(this.encodeSpatialContinuous(column.values, view, muted));
    }

    const values = await port.getFeatureVector(colorBy.name);
    return toRgbaTuples(this.encodeSpatialContinuous(values, view, muted));
  }

  /** Continuous values → RGBA through the active colormap and a clipped window (2D markers). */
  private encodeSpatialContinuous(
    values: Float32Array, view: SpatialViewState, muted: Uint8Array | null = null,
  ): Float32Array {
    const lut = this.display.spatialLut(view);
    return encodeSpatialContinuous(values, view, lut, this.spatial.contrastWindows, muted);
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

  reset(): void {
    this.mounted = null;
    this.scene?.dispose();
    this.scene = null;
    // End the previous scene: its frame loading, descriptor poll, tile counts and awaits.
    this.loading.abort();
    this.loading = new AbortController();
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.spatialImage = null;
    this.badge.reset();
    this.tools.teardown();
    this.tileClient.startScene(this.lifetime.signal);
    this.spatialTilesMgr?.detach();
    this.viewer?.dispose();
    this.viewer = null;
    if (this.canvas && this.host?.contains(this.canvas)) this.host.removeChild(this.canvas);
    this.canvas = null;
    this.spatialSub?.unsubscribe();
    this.spatialSub = null;
    this.hover?.dispose();
    this.hover = null;
    this.spatialPoints = null;
    this.spatialLayerKey = null;
    // The gene maps' and density volumes' layers belonged to the disposed viewer, so their keys
    // must go with it: kept, the next viewer would see "already built" and never add them back.
    // The estimated FIELDS (geneMapField*, geneMapVolumeField*) are viewer-independent and stay
    // cached, so a re-plot recolours instead of re-estimating.
    this.geneMapLayer = null;
    this.geneMapKey = null;
    // Invalidate any colour fetch still in flight so it can't attach to the next scene.
    this.spatialRebuildToken++;
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

  setPlotType(plotType: PlotType): void {
    this.currentPlotType = plotType;
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
    return this.tileClient.nativeHistogram$(this.info(), this.loaded?.z ?? 0, channelIndex, bins)
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

