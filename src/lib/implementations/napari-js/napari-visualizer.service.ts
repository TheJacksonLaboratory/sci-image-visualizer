import { Inject, Injectable, NgZone, Optional, inject } from '@angular/core';
import { Observable, BehaviorSubject, Subject, Subscription, combineLatest, of } from 'rxjs';
import { Image } from 'image-js';
import { saveAs } from 'file-saver';
import {
  Viewer, histogramScalar, colormapFromLut, heightField, MultiChannelImageView,
  MultiChannelVolumeView,
} from 'napari-js';
import type {
  AxesLayer, ImageLayer, SurfaceLayer, VolumeLayer, PointsLayer, Points3DLayer, TiledSource,
  ChannelView, VolumeChannel, ProjectedPoints,
} from 'napari-js';
import { nearestProjectedIndex, ScreenIndex, SCREEN_INDEX_MIN_POINTS } from 'napari-js';

import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { SPATIAL_DATA_PORT, SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import {
  SpatialColumn, SpatialDataset, SpatialImageRef, findColumnMeta, isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import {
  encodeCategorical, markerDiameters, resolveCategoryColors, toRgbaTuples, DEFAULT_MUTED_OPACITY,
  type RGBA,
} from '../../spatial/spatial-encoding';
import { NO_CATEGORY } from '../../contracts/spatial-dataset.contract';
import { SpatialObservations } from '../../contracts/spatial-dataset.contract';
import {
  SpatialSelectionMask, emptySelection, maskToIndices, mutedFromSelection, sameSelection,
  selectByCategory,
} from '../../spatial/spatial-selection';
import { framePositions } from '../../spatial/spatial-framing';
import { PIXEL_WORLD_QUANTUM, worldQuantumForExtent } from '../../spatial/world-grid';
import { observationsInSlice, volumeImageRef } from '../../spatial/spatial-volume-image';
import { defaultSigma, densityGrid, rasterizeDensity } from '../../spatial/spatial-density';
import { observationsInSection, sectionsOf } from '../../spatial/spatial-sections';
import { type HoverSource, hoverText, nearestObservation, PointGridIndex } from '../../spatial/spatial-hover';
import { NapariSpatialTooltip } from './napari-spatial-tooltip';
import { NapariSpatialTileLayers, TranscriptEstimate } from './napari-spatial-tiles';
import { NapariNavigator } from './napari-navigator';
import { LoadingBadgeState } from './napari-loading-state';
import { NapariToolBridge } from './napari-tool-bridge';
import { NapariDisplayState } from './napari-display-state';
import { AssembledVolume, NapariTileClient } from './napari-tile-client';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import { NAPARI_WHEEL_ZOOM_SPEED } from './napari-zoom';
import { ZOOM_BUTTON_STEP } from '../osd/osd-zoom';
import {
  type ExpressionField, type ExpressionVolumeField, colorExpressionField,
  encodeExpressionVolume, expressionField, expressionVolume, fieldContrastWindow,
} from '../../spatial/spatial-expression';

import { SpatialSelectionStore } from '../../store/spatial-selection.service';
import {
  LumaPlane, SCATTER3D_MAX_POINTS, SCATTER3D_MAX_XY, SURFACE_MAX_GRID, SURFACE_Z_ASPECT, SceneKind,
  VOLUME_FETCH_CONCURRENCY, VOLUME_WORLD_INPLANE_REF, isServerlessMultichannel, mapPool,
  sceneKindOf, stackDepth, surfaceResolutionFor, tintFor, tintedComposite, toIHistogram,
  toNapariGamma, typedPlane, volumeResolutionFor,
} from './napari-helpers';
import {
  ContrastWindowCache, DensityGroup, GENE_MAP_MAX_SIDE, GENE_MAP_SIGMA,
  GENE_MAP_VOLUME_STRIDE, SPATIAL_3D_BASE_SIZE, SPATIAL_FALLBACK_RADIUS, SPATIAL_NEUTRAL_COLOR,
  SPATIAL_NEUTRAL_HEX, SPATIAL_SELECTED_SIZE_SCALE, SPATIAL_SLICE_MIN_DIAMETER_PX, Spatial3dEncoding,
  encodeSpatial3dCategorical, encodeSpatial3dContinuous, encodeSpatialContinuous, gatherColors,
  rankDensityGroups, spatialFlatColormap, totalDensityGroup,
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
import { regionCentroids } from '../region-centroids';
import { TileDescriptor, throwIfAborted } from '../tile-server';
import { SimpleSliceAccessService } from '../simple-slice-access.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { NapariScaleBar, ScaleBarCamera } from './napari-scale-bar';
import { formatUm } from '../../overlays/scale-bar-core';

import { NapariAxesLabels, AxisLabelSpec } from './napari-axes-labels';
import { NapariVolumeZHandle } from './napari-volume-z-handle';

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
  /** napari-js high-level view owning the 3D volume layers (one additive tinted layer per channel
   *  for multichannel, or a single grayscale volume). Null in 2D. */
  private volumeView: MultiChannelVolumeView | null = null;
  /** True when the volume is composited from per-channel layers (vs a single grayscale volume). */
  private volumeMultichannel = false;
  /** napari-js height-field surface mesh (NAPARI_SURFACE plot type; null otherwise). Built from a
   *  single grayscale slice by {@link buildSurface} via napari-js's `heightField` + `addSurface`. */
  private surfaceLayer: SurfaceLayer | null = null;
  /** Which band the surface samples (a channel index for multichannel, else the composite). */
  private surfaceChannel: number | undefined = undefined;
  /** True when the mounted Surface follows one band of a multichannel image. */
  private surfaceMultichannel = false;
  /** Pre-loaded per-slice luminance planes (already decimated to the surface grid), keyed by z,
   *  so the stack slider rebuilds the surface instantly. Filled by {@link preloadSurfacePlanes}. */
  private readonly surfacePlanes = new Map<
    number,
    { data: Uint8Array; width: number; height: number }
  >();
  /** The surface preload in flight; a newer one (a channel switch) aborts it. */
  private surfacePreload: AbortController | null = null;
  /** In-plane grid cap for the active surface load (full grid ÷ the decimate factor). */
  private surfaceMaxGrid = SURFACE_MAX_GRID;
  /** Contrast window [min,max] the current surface mesh was built with. A change reshapes the
   *  mesh (pixel height = intensity within [min,max]), so it triggers a geometry rebuild. */
  private surfaceWindow: [number, number] | null = null;
  /** Persisted wireframe choice for the surface (re-applied when a new surface mounts). */
  private surfaceWireframe = false;
  /** napari-js 2D scatter points (region centroids) + its region-change subscription. */
  private scatter2dPoints: PointsLayer | null = null;
  private scatterRegionSub: Subscription | null = null;
  /** napari-js 3D scatter (voxel point cloud). */
  private scatter3dLayer: Points3DLayer | null = null;
  /** Spatial-omics observation markers + the dataset/view subscription driving them. */
  private spatialPoints: PointsLayer | null = null;
  /** The 3D point cloud. One layer: selection is a per-point alpha on it, not a second. */
  private spatialPoints3d: Points3DLayer | null = null;
  private spatialLayerKey3d: string | null = null;
  /** Interleaved x,y,z, cached so a colour change does not re-walk 3.7M observations. */
  private spatialPositions3d: Float32Array | null = null;
  /** Identity of the scalars currently uploaded — see {@link rebuildSpatialPoints3d}. */
  private spatialScalarKey3d: string | null = null;
  /** The anatomical volume the cloud sits inside, when the dataset has one. */
  private spatialVolume: VolumeLayer | null = null;
  private spatialVolumeKey: string | null = null;
  /** Per-cluster density volumes drawn alongside the cloud, and what they were
   *  built from — rasterising is seconds of work, so it must not repeat for a
   *  change that cannot affect the field. */
  private densityLayers: VolumeLayer[] = [];
  private densityKey: string | null = null;
  /** Selection identity, as a number the density key can carry. */
  private lastSelectionSeen: SpatialSelectionMask | null = null;
  private selectionRevision = 0;
  /** The gene map: its layer, the field it was estimated from, and the inputs each
   *  was built for — the field is the expensive half and survives a recolour. */
  private geneMapLayer: ImageLayer | null = null;
  private geneMapKey: string | null = null;
  private geneMapField: ExpressionField | null = null;
  private geneMapFieldKey: string | null = null;
  /** The 3D gene map: its volume layer, the field behind it, and the inputs each
   *  was built for — same two clocks as the 2D map. */
  private geneMapVolumeLayer: VolumeLayer | null = null;
  private geneMapVolumeKey: string | null = null;
  private geneMapVolumeField: ExpressionVolumeField | null = null;
  private geneMapVolumeFieldKey: string | null = null;
  /** Offset applied to observation coordinates to sit them in the volume's box. */
  private spatialOrigin3d: [number, number, number] = [0, 0, 0];
  /** Cursor tooltip for the spatial views, and everything it needs: what the
   *  cloud is coloured by, and where each drawn observation is. */
  private spatialTooltip: NapariSpatialTooltip | null = null;
  private hoverSource: HoverSource | null = null;
  private hoverSourceKey: string | null = null;
  /** Sequences the async resolutions. The KEY is only committed once one lands,
   *  so a superseded fetch cannot leave the cache claiming to hold a source it
   *  never stored. */
  private hoverSourceToken = 0;
  /** Drawn observations' positions for hit-testing, indexed BY OBSERVATION with
   *  NaN for anything not drawn. Screen pixels in 3D (the camera moves them, so
   *  they are rebuilt when it does) and WORLD units in 2D (where the camera only
   *  scales, so the pointer is converted instead of 374k points). */
  private hoverPositions: Float32Array | null = null;
  private hoverPositionsRev = -1;

  /**
   * Screen-space bucket index over the 3D projection, built on the first hover after the
   * scene moved rather than when it moves.
   *
   * Lazily, and that is the whole design: an orbit drag changes the camera every frame, so
   * building eagerly would spend tens of milliseconds a frame indexing for picks nobody is
   * making. Deferred, it is built once when the drag stops and the pointer next moves —
   * measured upstream at 3.7M points, that turns a 12.6 ms scan per pointermove into
   * 0.066 ms.
   */
  private hoverIndex: ScreenIndex | null = null;
  /** The 2D counterpart of {@link hoverIndex}: a grid over the world positions. */
  private hoverGrid2d: PointGridIndex | null = null;
  /** Bumped whenever the cached positions go stale: a marker rebuild, or — in 3D
   *  only, where the projection depends on it — a camera move. */
  private spatialSceneRev = 0;
  private hoverPointer: { clientX: number; clientY: number } | null = null;
  private hoverFrame = 0;
  private hoverOff: (() => void)[] = [];
  /** Observation indices the cached 3D positions belong to, in the same order;
   *  null when every observation is drawn. Without it a projection built from the
   *  positions is indexed by DRAWN order and silently attributes each point to
   *  the wrong observation as soon as a section is isolated. */
  private spatialDrawn3d: Uint32Array | null = null;

  /** Reused projection buffers — see {@link getSpatialScreenProjection}. */
  private spatialProjection3d: ProjectedPoints | undefined = undefined;

  /** Per-observation depth from the last projection, for the depth-aware hover pick. */
  private spatialDepths3d: Float32Array | null = null;
  /** Whose 2D observations the camera has been framed on — see {@link frameSpatialPointsOnce}. */
  private spatial2dFramed: { viewer: Viewer; datasetId: string } | null = null;
  /** Dataset the 3D scale bar was built for. */
  private spatialScaleBarKey: string | null = null;
  private spatialSub: Subscription | null = null;
  /** Level-of-detail cell outlines, transcripts and density over the 2D view — created on
   *  first use, and only when a spatial port is bound. */
  private spatialTilesMgr: NapariSpatialTileLayers | null = null;
  /** For the panel: the transcripts-in-view estimate and the density window in use. */
  readonly transcriptEstimate$ = new BehaviorSubject<TranscriptEstimate | null>(null);
  /** Transcripts of each selected gene in view (see NapariSpatialTileLayers.geneCountsIn). */
  readonly geneCountsInView$ = new BehaviorSubject<Record<string, number> | null>(null);
  readonly densityStats$ = new BehaviorSubject<{ lo: number; hi: number; max: number } | null>(null);
  /** Latest (dataset, view, selection) the spatial subscription saw, so a slice
   *  change can rebuild the markers for the new plane. */
  private spatialLatest: [SpatialDataset | null, SpatialViewState, SpatialSelectionMask] | null =
    null;
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
  private scene = new AbortController();
  /**
   * Frame loading (volume assembly, surface preload): aborted by {@link reset} AND by
   * {@link cancelLoading}, so a Cancel actually stops fetching frames instead of running to
   * completion in the background, while the scene itself stays mounted.
   *
   * The narrower per-request tokens below ({@link sliceReq}, {@link navigatorToken},
   * {@link spatialRebuildToken}, {@link hoverSourceToken}) are "latest wins WITHIN a scene".
   */
  private loading = new AbortController();
  /** Decimate factor for the napari 3D types (1 = Full, 2 = ½, 4 = ¼ default, 8 = ⅛). Applied when a
   *  volume/isosurface/surface (re)loads; changing it needs a re-plot (it changes fetched data). */
  private resolutionScale = NAPARI_DEFAULT_DECIMATE;
  /** 3D coordinate-axes / scale gizmo for the volume/isosurface view (null in 2D). */
  private axesLayer: AxesLayer | null = null;
  /** DOM X/Y/Z + scale labels tracking the 3D axes gizmo (null in 2D). */
  private axesLabels: NapariAxesLabels | null = null;
  /** Draggable Z-height grip over the volume (null unless a volume/isosurface is mounted). */
  private zHandle: NapariVolumeZHandle | null = null;
  /** User Z-height factor for the volume (1 = the volume's natural proportions); driven by the
   *  in-view drag handle. Reset per mount. */
  private volumeZScale = 1;
  /** Volume world box at `volumeZScale = 1` (base) + the sampled voxel depth — enough to recompute
   *  the Z-axis voxel scale, axes depth, and overlay anchors as the handle stretches Z. */
  private volumeWorldBase: { width: number; height: number; depth: number } | null = null;
  private volumeSampledDepth = 1;
  /** Persisted axes on/off choice, re-applied when a new volume mounts. Defaults on. */
  private axesVisible = true;
  private volumeDims: { width: number; height: number; depth: number } | null = null;
  /** Assembled uint8 volume data per channel (key = channel index), kept for the volume intensity
   *  histogram. Key 0 holds the grayscale/composite volume in the single-channel case. */
  private readonly volumeChannelData = new Map<number, Uint8Array>();
  private imageW = 0;
  private imageH = 0;
  /** Monotonic slice-request id so a slow out-of-order slice fetch can't clobber a newer one. */
  private sliceReq = 0;

  /** How the current 2D image is composited (drives histogram + state application). */
  private imageMode: 'grayscale' | 'multichannel' | 'rgb' = 'rgb';
  /** napari-js high-level view that owns the per-channel layer set (build + live display
   *  updates) for the current {@link imageMode}. Rebuilt on each (re)render. */
  private channelView: MultiChannelImageView | null = null;
  /** Live subscription applying channel-state / colormap changes to the layers. */
  private displaySub: Subscription | null = null;
  /** Physical scale bar overlay for the 2D image (null when 3D or the image has no µm/pixel). */
  private scaleBar: NapariScaleBar | null = null;
  /** Overview minimap (bottom-right), as OSD's navigator. */
  private navigator: NapariNavigator | null = null;
  /** Whether the navigator is shown — the same host setting OSD's navigator honours. */
  private navigatorVisible = true;
  /** Bumped per thumbnail request, so a slow one cannot overwrite a newer slice's. */
  private navigatorToken = 0;
  /** The current slice's per-channel thumbnail bitmaps (multichannel only), kept so a tint or
   *  visibility change recolours the thumbnail without re-fetching it. */
  private navigatorChannels: ImageBitmap[] | null = null;
  /** The tints/visibility the thumbnail was last composited with — see {@link recolorNavigator}. */
  private navigatorTintKey = '';
  /** The region overlay, the pixel tools and the displayed-pixel readback they read. */
  private readonly tools: NapariToolBridge;
  /** What this backend's canvas tools read and write (one host for every tool). */
  private readonly toolHost: CanvasToolHost;
  /** This backend's own wand, brush, eraser, zoom-to-box and SAM point tools. */
  protected readonly canvasTools: CanvasToolManager;
  /** Image smoothing (bilinear) vs nearest-neighbour (crisp pixels, the default). */
  private imageSmoothing = false;
  /** True when the 2D image is rendered via pyramidal TiledSources (descriptor available). */
  private tiled = false;
  /** Coarse per-channel luminance sample (keyed by channel index) for the histogram in tiled mode,
   *  where the layers have no full in-memory pixels. Refreshed on plot + slice change. */
  private readonly histSamples = new Map<number, Uint8Array>();
  /** Latest-wins token for {@link refreshHistogramSamples}. */
  private histGen = 0;
  /** Spatial colouring's percentile windows, memoised per coloured vector (SPATIAL-12). */
  private readonly contrastWindows = new ContrastWindowCache();

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
    this.tileClient.startScene(this.scene.signal);
    this.display = new NapariDisplayState(store);
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
    const scene = this.scene.signal;
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
    const z = (imageLoaded as NapariLoaded)?.z ?? 0;

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
        await this.mountSpatialOmics3d(viewer, host);
      } else if (isSpatialOmics(plotType)) {
        // No loaded image: an image-less dataset opened before any image (the visualizer's
        // plotSpatialWithoutImage) — the observations alone.
        await this.mountSpatialOmics(viewer, host, z, imageLoaded == null);
      } else if (isNapariScatter(plotType)) {
        await this.mountScatter(viewer, host, z);
      } else if (isNapariScatter3d(plotType)) {
        await this.mountScatter3d(viewer, info);
      } else if (isNapariSurface(plotType)) {
        await this.mountSurface(viewer);
      } else if (isNapari3d(plotType)) {
        await this.mountVolume(viewer, info, plotType);
      } else {
        await this.renderImage(z);
        this.fitCameraSoon();
        this.subscribeDisplayState();
        this.installScaleBar();
        this.installNavigator(z);
        this.tools.install2dInteraction(viewer, host);
      }
      this.tools.scheduleReadback();
      return true;
    } catch (err) {
      console.error('[napari-js] plot failed:', err);
      return false;
    }
  }

  // ── Channels: per-channel composite, LUT, native histograms (jit-ui#102) ──────────────────

  /**
   * Render the 2D image for slice `z`. With a server pyramid descriptor we use a pyramidal
   * {@link TiledSource} per layer so the view refines to higher resolution on zoom (like OSD) and
   * sits naturally in full-resolution coordinates; without one we fall back to the single-level
   * stitch. Three display modes either way: multichannel additive tint, grayscale colormap, RGB.
   */
  private async renderImage(z: number, token?: number): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    const scene = this.scene.signal;
    const desc = await this.tileClient.ensureDescriptor(this.info());
    // Reset into a newer scene while the descriptor was in flight: this render is superseded.
    if (scene.aborted) return;
    if (desc && desc.levels?.length) {
      if (token != null && token !== this.sliceReq) return;
      await this.renderImageTiled(z, desc, scene);
      return;
    }
    return this.renderImageStitched(z, token);
  }

  /** Single-level stitch fallback (no descriptor): the pre-tiling path. */
  private async renderImageStitched(z: number, token?: number): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    const desc = await this.tileClient.ensureDescriptor(this.info());
    const states = this.store.currentChannelStates();
    const channelCount = desc?.channels ?? (states.length || 1);
    const multichannel = !!desc?.multichannel && channelCount > 1;

    // 1) Fetch all pixel data BEFORE touching the viewer, so a superseded scrub can bail without
    //    having torn down the visible layers (avoids flicker / out-of-order layer state).
    let mode: 'grayscale' | 'multichannel' | 'rgb';
    let planes: Array<{ data: Uint8Array; width: number; height: number }> = [];
    let bitmap: ImageBitmap | null = null;
    if (multichannel) {
      mode = 'multichannel';
      planes = await Promise.all(
        Array.from({ length: channelCount }, (_, c) => this.tileClient.fetchChannelData(this.info(), z, c)),
      );
    } else if (channelCount === 1) {
      mode = 'grayscale';
      // Composite fetch (no channel) → all overview levels usable, so a large grayscale image
      // selects a fitting downscaled level instead of the full-res real level (texture limit).
      planes = [await this.tileClient.fetchChannelData(this.info(), z)];
    } else {
      mode = 'rgb';
      bitmap = await this.tileClient.fetchSlice(this.info(), z);
    }

    // 2) Commit — unless a newer scrub superseded us or the viewer was torn down.
    if ((token != null && token !== this.sliceReq) || this.viewer !== v) {
      bitmap?.close?.();
      return;
    }

    // The displayed texture may be a downscaled pyramid level; scale the layer into FULL-RESOLUTION
    // world coordinates (level-0 pixels) so the camera, readback and — critically — pre-saved
    // regions (stored in full-res coords, e.g. ndpi) all line up regardless of which level is shown.
    // This mirrors OSD, whose coordinate system is always level 0.
    const texW = mode === 'rgb' ? (bitmap as ImageBitmap).width : planes[0]?.width ?? 0;
    const texH = mode === 'rgb' ? (bitmap as ImageBitmap).height : planes[0]?.height ?? 0;
    const fullW = desc?.width || texW || 1;
    const fullH = desc?.height || texH || 1;
    const scale: [number, number] = [texW ? fullW / texW : 1, texH ? fullH / texH : 1];

    this.imageMode = mode;
    const interpolation: 'linear' | 'nearest' = this.imageSmoothing ? 'linear' : 'nearest';
    this.channelView = new MultiChannelImageView(v);
    if (mode === 'multichannel') {
      const views = planes.map((d, c) => this.tintedChannelView(c, states, desc, typedPlane(d), scale));
      this.channelView.render('multichannel', views, { interpolation });
    } else if (mode === 'grayscale') {
      const view = this.grayscaleChannelView(states[0], typedPlane(planes[0]), scale);
      this.channelView.render('grayscale', [view], { interpolation });
    } else {
      this.channelView.render('rgb', [{ source: bitmap as ImageBitmap, scale }], { interpolation });
    }
    this.imageW = fullW;
    this.imageH = fullH;
  }

  /**
   * Render the 2D image with pyramidal {@link TiledSource}s — the view refines to higher resolution
   * as you zoom in (the visual fetches the level whose texels ≈ screen pixels) and sits in full-res
   * coordinates so regions align. Same three modes as the stitch path. Per-channel layers use the
   * REAL pyramid levels (per-channel tiles only exist there); the composite uses all levels.
   */
  private async renderImageTiled(z: number, desc: TileDescriptor, scene: AbortSignal): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    const states = this.store.currentChannelStates();
    const channelCount = desc.channels ?? (states.length || 1);
    const multichannel = !!desc.multichannel && channelCount > 1;
    const interpolation: 'linear' | 'nearest' = this.imageSmoothing ? 'linear' : 'nearest';

    this.tiled = true;
    this.channelView = new MultiChannelImageView(v);

    if (multichannel) {
      this.imageMode = 'multichannel';
      const views = Array.from({ length: channelCount }, (_, c) =>
        this.tintedChannelView(c, states, desc, this.tiledSource(desc, c, 1, scene)));
      this.channelView.render('multichannel', views, { interpolation });
    } else if (channelCount === 1) {
      this.imageMode = 'grayscale';
      const view = this.grayscaleChannelView(states[0], this.tiledSource(desc, undefined, 1, scene));
      this.channelView.render('grayscale', [view], { interpolation });
    } else {
      this.imageMode = 'rgb';
      this.channelView.render('rgb', [{ source: this.tiledSource(desc, undefined, 4, scene) }], {
        interpolation,
      });
    }
    this.imageW = desc.width;
    this.imageH = desc.height;
    // Await on the initial render so getHistogram/autoContrast have data immediately; slice changes
    // refresh fire-and-forget (the histogram pane retries).
    await this.refreshHistogramSamples(z, desc);
  }

  /** Channel `c`'s layer in the additive multichannel composite: tinted by its display colour
   *  (store, else descriptor, else the Fiji palette), with its window, gamma and visibility. */
  private tintedChannelView(
    c: number,
    states: IChannelState[],
    desc: TileDescriptor | null,
    source: ChannelView['source'],
    scale?: [number, number],
  ): ChannelView {
    const st = states.find((s) => s.index === c);
    return {
      source,
      tint: st?.color ?? desc?.channelInfo?.[c]?.color ?? tintFor(c),
      name: st?.name ?? `ch${c}`,
      contrastLimits: [st?.min ?? 0, st?.max ?? 255],
      gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
      visible: st?.visible ?? true,
      invert: this.display.invert,
      ...(scale ? { scale } : {}),
    };
  }

  /** The single grayscale layer: the selected colormap, with the channel's window and gamma. */
  private grayscaleChannelView(
    st: IChannelState | undefined,
    source: ChannelView['source'],
    scale?: [number, number],
  ): ChannelView {
    return {
      source,
      colormap: this.display.grayscaleColormap(),
      contrastLimits: [st?.min ?? 0, st?.max ?? 255],
      gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
      invert: this.display.invert,
      ...(scale ? { scale } : {}),
    };
  }

  /** A pyramidal TiledSource for the image on screen, whose tiles count on the loading badge
   *  while `scene` (the render that asked for it) is current. */
  private tiledSource(
    desc: TileDescriptor, channel: number | undefined, channels: 1 | 4, scene: AbortSignal,
  ): TiledSource {
    return this.tileClient.tiledSource(desc, channel, channels, scene, () => this.badge.begin('Image'));
  }

  /** (Re)fetch a coarse per-channel luminance sample for the histogram (tiled mode has no full
   *  in-memory pixels). One cheap overview tile per channel, fetched together; cached by channel
   *  index. Latest wins: a scrub fires one refresh per slice, and an older slice's samples that
   *  land after a newer one's are dropped rather than shown as the current distribution. */
  private async refreshHistogramSamples(z: number, desc: TileDescriptor): Promise<void> {
    const gen = ++this.histGen;
    this.histSamples.clear();
    if (this.imageMode === 'rgb') return; // RGB uses the displayed-pixel readback (rgbHistogram)
    const multichannel = this.imageMode === 'multichannel';
    const channelCount = multichannel ? desc.channels ?? 1 : 1;
    const samples = await Promise.all(
      Array.from({ length: channelCount }, (_, c) =>
        // budget 1 → coarsest single tile; a failed channel leaves its sample unset.
        this.tileClient.fetchChannelData(this.info(), z, multichannel ? c : undefined, 1).then(
          (d) => d.data,
          () => null,
        ),
      ),
    );
    if (gen !== this.histGen) return;
    samples.forEach((data, c) => {
      if (data) this.histSamples.set(c, data);
    });
  }

  /**
   * The one display-state subscription every image/volume/surface mode uses: channel states,
   * colormap (+ reverse), invert and the selected channel. Records the colormap/reverse/invert the
   * builders read, then hands the mode its own layer updates. Replaces any prior subscription
   * (the spatial modes' marker subscription also records the colormap — see subscribeSpatial).
   */
  private watchDisplayState(apply: (channels: IChannelState[], selected: number) => void): void {
    this.displaySub?.unsubscribe();
    this.displaySub = this.display.watch(apply);
  }

  /** Subscribe channel states + grayscale colormap → live-apply to the rendered layers (no
   *  re-fetch; only z changes re-fetch). Replaces any prior subscription. */
  private subscribeDisplayState(): void {
    this.watchDisplayState((channels) => {
      this.applyDisplayState(channels);
      this.recolorNavigator();
    });
  }

  /** Subscribe the store colormap (+reverse), invert, and channel state → the volume/isosurface
   *  transfer function: colour (channel tint or selected colormap), the intensity **window
   *  (min/max → contrastLimits)** and **gamma**, mirroring the grayscale image's display controls
   *  so the histogram pane drives the 3D render. Replaces any prior subscription. */
  private subscribeVolumeDisplayState(): void {
    this.watchDisplayState((channels) => {
      const view = this.volumeView;
      if (!view) return;
      if (this.volumeMultichannel) {
        // Each channel's layer is tinted by its colour and gets its own window/gamma/visibility.
        view.layers.forEach((_, c) => {
          const st = channels.find((s) => s.index === c);
          view.updateChannel(c, {
            colormap: this.display.channelTintColormap(st?.color ?? '#ffffff'),
            ...(st
              ? {
                  contrastLimits: [st.min, st.max] as [number, number],
                  gamma: toNapariGamma(st.gamma), // ImageJ γ → napari-js γ
                  visible: st.visible,
                }
              : {}),
          });
        });
      } else {
        const st = channels[0];
        view.updateChannel(0, {
          colormap: this.display.volumeColormap(st),
          ...(st ? { contrastLimits: [st.min, st.max] as [number, number], gamma: toNapariGamma(st.gamma) } : {}),
        });
      }
    });
  }

  /** Apply the current channel states / colormap to the live layers (no re-fetch), delegating the
   *  per-channel layer mutations to the {@link MultiChannelImageView}. */
  private applyDisplayState(channels: IChannelState[]): void {
    const view = this.channelView;
    if (!this.viewer || !view) return;
    if (this.imageMode === 'multichannel') {
      view.layers.forEach((_, c) => {
        const st = channels.find((s) => s.index === c);
        if (!st) return;
        view.updateChannel(c, {
          tint: st.color,
          contrastLimits: [st.min, st.max],
          gamma: toNapariGamma(st.gamma), // ImageJ γ → napari-js γ
          visible: st.visible,
          invert: this.display.invert,
        });
      });
    } else if (this.imageMode === 'grayscale') {
      const st = channels[0];
      view.updateChannel(0, {
        colormap: this.display.grayscaleColormap(),
        invert: this.display.invert,
        ...(st ? { contrastLimits: [st.min, st.max] as [number, number], gamma: toNapariGamma(st.gamma) } : {}),
      });
    }
  }

  /** (Re)install the physical scale bar over the 2D image, sized from the image's µm/pixel
   *  (`/tiles/info` mppX, falling back to the image metadata). No-op without a physical size. */
  private installScaleBar(): void {
    this.scaleBar?.destroy();
    this.scaleBar = null;
    const mppX = this.tileClient.mppX(this.info());
    if (this.viewer && this.host && mppX > 0) {
      this.scaleBar = new NapariScaleBar(this.host, this.viewer.camera, mppX);
    }
  }

  /**
   * The overview navigator for a 2D view with an image: a coarse thumbnail of the whole
   * image with the viewport on it; click or drag to pan at the current zoom (as OSD).
   */
  private installNavigator(z: number): void {
    this.navigator?.destroy();
    this.navigator = null;
    if (!this.viewer || !this.host || !this.imageW || !this.imageH) return;
    this.navigator = new NapariNavigator(
      this.host, this.viewer, this.imageW, this.imageH, () => this.spatialTooltip?.hide(),
    );
    this.navigator.setVisible(this.navigatorVisible);
    void this.refreshNavigatorImage(z);
  }

  /**
   * Draw the navigator's thumbnail from the coarsest pyramid level. A multichannel image
   * is composited from its channels in their display colours (see {@link recolorNavigator}),
   * so the overview looks like the view rather than like channel 0 in grey.
   */
  private async refreshNavigatorImage(z: number): Promise<void> {
    const nav = this.navigator;
    if (!nav) return;
    const token = ++this.navigatorToken;
    try {
      const desc = await this.tileClient.ensureDescriptor(this.info());
      // Superseded (a newer slice, or the scene was torn down): fetch nothing.
      if (token !== this.navigatorToken || this.navigator !== nav) return;
      const channels = desc?.multichannel ? desc.channelInfo ?? [] : [];
      if (channels.length > 1) {
        const bitmaps = await Promise.all(
          channels.map((_c, c) => this.tileClient.fetchSlice(this.info(), z, c, 1)),
        );
        if (token !== this.navigatorToken || this.navigator !== nav) return;
        this.setNavigatorChannels(bitmaps);
        this.recolorNavigator();
      } else {
        const image = await this.tileClient.fetchSlice(this.info(), z, undefined, 1);
        if (token !== this.navigatorToken || this.navigator !== nav) return;
        this.setNavigatorChannels(null);
        nav.setImage(image);
      }
    } catch (err) {
      console.warn('[napari-js] navigator thumbnail unavailable', err);
    }
  }

  /** Replace the per-channel thumbnail bitmaps (closing the previous ones). */
  private setNavigatorChannels(bitmaps: ImageBitmap[] | null): void {
    for (const bmp of this.navigatorChannels ?? []) bmp.close?.();
    this.navigatorChannels = bitmaps;
    this.navigatorTintKey = '';
  }

  /**
   * Composite the multichannel thumbnail in the channels' CURRENT display tints, skipping hidden
   * channels — the store's channel states, as the 2D layers use, not the server's defaults.
   * Re-run on every display-state change; it only redraws (never re-fetches), and only when a
   * tint or a visibility actually changed, so a window/gamma drag costs a string compare.
   */
  private recolorNavigator(): void {
    const nav = this.navigator;
    const bitmaps = this.navigatorChannels;
    if (!nav || !bitmaps) return;
    const info = this.currentDescriptor()?.channelInfo;
    const states = this.store.currentChannelStates();
    const shown = bitmaps
      .map((bmp, c) => {
        const st = states.find((s) => s.index === c);
        return { bmp, visible: st?.visible ?? true, color: st?.color ?? info?.[c]?.color ?? tintFor(c) };
      })
      .filter((ch) => ch.visible);
    const key = shown.map((ch) => `${bitmaps.indexOf(ch.bmp)}:${ch.color}`).join('|');
    if (key === this.navigatorTintKey) return;
    this.navigatorTintKey = key;
    nav.setImage(tintedComposite(shown.map((ch) => ch.bmp), shown.map((ch) => ch.color)));
  }

  /** Show/hide the overview navigator (same setting as OSD's). */
  setNavigatorVisible(visible: boolean): void {
    this.navigatorVisible = visible;
    this.navigator?.setVisible(visible);
  }

  /**
   * Mount the 3D volume/isosurface. A multichannel image becomes one additive, tinted
   * {@link VolumeLayer} per channel (so each channel's colour composites into the render); a
   * grayscale/composite image uses a single volume. Adds the axes gizmo + labels and wires the
   * display-state subscription. The caller owns `viewer.ready`.
   */
  private async mountVolume(
    viewer: Viewer,
    info: IImageInfo | undefined,
    plotType: PlotType,
  ): Promise<void> {
    const loading = this.loading.signal; // bail before rendering on a Cancel / new plot
    const desc = await this.tileClient.ensureDescriptor(this.info());
    // Serverless multichannel (tiled:false + channelUrls): no tile descriptor, so
    // derive the channel count from imageMeta and assemble each band from its own
    // channelUrls[z][c] plane (fetchSlice does the per-channel routing).
    const simpleMc = isServerlessMultichannel(this.simpleStack.isSimple(info), info);
    const channelCount = simpleMc ? info!.imageMeta![0].channelCount : (desc?.channels ?? 1);
    const multichannel = simpleMc || (!!desc?.multichannel && channelCount > 1);
    const res = volumeResolutionFor(this.resolutionScale);
    const rendering: 'iso' | 'mip' = isNapariIsosurface(plotType) ? 'iso' : 'mip';
    const states = this.store.currentChannelStates();

    this.volumeChannelData.clear();
    this.volumeMultichannel = multichannel;
    this.imageMode = this.volumeMultichannel ? 'multichannel' : 'grayscale';
    const view = new MultiChannelVolumeView(viewer);
    this.volumeView = view;

    // Assemble per-channel scalar volumes from the server tiles (jit-specific); the napari-js view
    // owns the layer orchestration (one additive tinted volume per channel, or a single grayscale
    // volume). The adapter computes each channel's colormap (incl. invert/reverse flips).
    let dims: { width: number; height: number; depth: number } | null = null;
    const channels: VolumeChannel[] = [];
    this.stackLoading$.next(true);
    this.stackLoadingProgress$.next(0);
    try {
      if (multichannel) {
        for (let c = 0; c < channelCount; c++) {
          const vol = await this.assembleVolume(info, res, c);
          if (!vol) continue;
          dims = vol;
          this.volumeChannelData.set(c, vol.data);
          const st = states.find((s) => s.index === c);
          const color = st?.color ?? desc?.channelInfo?.[c]?.color ?? tintFor(c);
          channels.push({
            data: vol.data,
            width: vol.width,
            height: vol.height,
            depth: vol.depth,
            colormap: this.display.channelTintColormap(color),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
            visible: st?.visible ?? true,
          });
        }
      } else {
        const vol = await this.assembleVolume(info, res);
        if (vol) {
          dims = vol;
          this.volumeChannelData.set(0, vol.data);
          const st = states[0];
          channels.push({
            data: vol.data,
            width: vol.width,
            height: vol.height,
            depth: vol.depth,
            colormap: this.display.volumeColormap(st),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
          });
        }
      }
    } finally {
      this.stackLoading$.next(false);
      this.stackLoadingProgress$.next(0);
    }

    if (!dims || !channels.length || loading.aborted) return; // cancelled → don't render

    // Resolution-invariant world box; the per-axis `voxelSize` (napari `scale`) maps the sampled
    // grid onto it.
    //
    // A stack that declares its physical spacing on ALL THREE axes gets its true
    // extent as the world box — the only way anisotropy survives, and what makes a
    // resampled 40 x 40 x 200 µm volume read as a brain instead of a cube-aspect
    // brick. It needs none of the reference-box arithmetic: a physical box is
    // already independent of the decimate factor.
    //
    // Everything else keeps that arithmetic. Sizing the box by the sampled voxel
    // counts made higher in-plane resolution grow X/Y while the depth stayed the
    // (constant) slice count — so Z appeared to shrink at higher resolution.
    // Anchoring the in-plane long side to a fixed reference and letting Z span the
    // full slice count makes the box shape identical at every decimate factor.
    const meta = this.loaded?.imageInfo.imageMeta?.[0];
    const mppXYZ: [number, number, number] | null =
      meta?.mppX && meta?.mppY && meta?.mppZ ? [meta.mppX, meta.mppY, meta.mppZ] : null;
    // The image's DECLARED pixel dimensions, which is what mpp is per: the sampled
    // dims are decimated, so sizing a physical box by them would make the world
    // box depend on the resolution the user happens to be viewing at.
    const imageDesc = this.currentDescriptor();
    const fullW = imageDesc?.width ?? meta?.x ?? dims.width;
    const fullH = imageDesc?.height ?? meta?.y ?? dims.height;
    const fullD = stackDepth(this.loaded?.imageInfo) || dims.depth;
    let world: { width: number; height: number; depth: number };
    if (mppXYZ) {
      world = {
        width: fullW * mppXYZ[0],
        height: fullH * mppXYZ[1],
        depth: fullD * mppXYZ[2],
      };
    } else {
      const fullLong = Math.max(1, fullW, fullH);
      world = {
        width: (fullW * VOLUME_WORLD_INPLANE_REF) / fullLong,
        height: (fullH * VOLUME_WORLD_INPLANE_REF) / fullLong,
        depth: fullD,
      };
    }
    // Base box (Z-scale = 1) + the sampled depth drive the live Z-height handle below; the persisted
    // `volumeZScale` (user drag) applies on top so changing resolution keeps the chosen height.
    this.volumeWorldBase = world;
    this.volumeSampledDepth = Math.max(1, dims.depth);
    const worldZ = world.depth * this.volumeZScale;
    const voxelSize: [number, number, number] = [
      world.width / dims.width,
      world.height / dims.height,
      worldZ / this.volumeSampledDepth,
    ];
    for (const ch of channels) ch.voxelSize = voxelSize;

    view.render(this.volumeMultichannel ? 'multichannel' : 'grayscale', channels, { rendering });
    this.imageW = dims.width;
    this.imageH = dims.height;
    this.volumeDims = dims;

    // 3D coordinate-axes / scale gizmo + labels, sharing the volume's world box so the gizmo tracks
    // the rendered proportions. Physical scale text still comes from the FULL image extent.
    this.axesLayer = viewer.addAxes(world.width, world.height, worldZ, { visible: this.axesVisible });
    if (this.host) {
      this.axesLabels = new NapariAxesLabels(
        this.host,
        viewer.camera3d,
        this.buildAxesLabels({ width: world.width, height: world.height, depth: worldZ }),
      );
      this.axesLabels.setVisible(this.axesVisible);
      // In-view drag handle at the TOP END OF THE Z AXIS (the box's min-XY corner, where the blue
      // "Z" axis + label live), so it reads as the Z-height control. Floated a little past the axis
      // tip (×1.12) so the grip clears the "Z · …" label. Drag ↕ to restretch Z live.
      this.zHandle = new NapariVolumeZHandle(this.host, viewer.camera3d, {
        topAnchor: () => [
          -this.volumeWorldBase!.width / 2,
          -this.volumeWorldBase!.height / 2,
          ((this.volumeWorldBase!.depth * this.volumeZScale) / 2) * 1.12,
        ],
        getScale: () => this.volumeZScale,
        setScale: (s) => this.setVolumeZScale(s),
      });
    }
    this.subscribeVolumeDisplayState();
  }

  /**
   * Restretch the volume's Z height live (driven by the in-view {@link NapariVolumeZHandle}). Only
   * the per-axis `voxelSize` / axes depth change — the voxel textures are untouched — so dragging is
   * smooth. `factor` is relative to the volume's natural proportions (1). Persists across re-mounts
   * (resolution changes) so the chosen height sticks.
   */
  private setVolumeZScale(factor: number): void {
    this.volumeZScale = Math.min(10, Math.max(0.1, factor));
    const base = this.volumeWorldBase;
    if (!base || !this.volumeView) return;
    const worldZ = base.depth * this.volumeZScale;
    const vsZ = worldZ / this.volumeSampledDepth;
    for (const layer of this.volumeView.layers) {
      const [sx, sy] = layer.voxelSize;
      layer.voxelSize = [sx, sy, vsZ];
    }
    if (this.axesLayer) this.axesLayer.depth = worldZ;
    this.axesLabels?.updateAnchors(
      this.buildAxesLabels({ width: base.width, height: base.height, depth: worldZ }),
    );
    this.zHandle?.reposition();
    this.viewer?.requestRender();
  }

  /** Build the X/Y/Z axis-end label specs for the 3D gizmo. Anchors are in the volume's centred
   *  world box (matching the AxesLayer geometry); the scale text reflects the FULL image extent —
   *  physical µm when µm/pixel is known, else pixel (X/Y) / slice (Z) counts. */
  private buildAxesLabels(
    vol: { width: number; height: number; depth: number },
  ): AxisLabelSpec[] {
    const hx = vol.width / 2;
    const hy = vol.height / 2;
    const hz = vol.depth / 2;
    // Measured from the IMAGE's own extent, never from the world box: the box is a
    // shape (and for a physically sized volume it is already in µm, so reading a
    // pixel count off it and multiplying by mpp would scale the label twice).
    const { px, mpp } = this.imageExtent();
    const len = (n: number, um: number): string => (um > 0 ? formatUm(n * um) : `${n} px`);
    return [
      { anchor: [hx, -hy, -hz], text: `X · ${len(px[0], mpp[0])}`, color: '#ed4545' },
      { anchor: [-hx, hy, -hz], text: `Y · ${len(px[1], mpp[1])}`, color: '#4dd959' },
      // Physical when the stack declares its slice spacing (`mppZ`) — a resampled
      // volume knows how thick it is; a plain z-stack can only say how many slices.
      { anchor: [-hx, -hy, hz], text: `Z · ${len(px[2], mpp[2])}`, color: '#668cff' },
    ];
  }

  /**
   * The image's declared extent in pixels/slices, and its physical spacing per
   * axis in µm (0 = undeclared, and then that axis reads in pixels).
   *
   * One place, because the volume world box and the axis labels have to agree
   * about what the image's real dimensions are — the sampled grid is decimated and
   * says nothing about either.
   */
  private imageExtent(): { px: [number, number, number]; mpp: [number, number, number] } {
    const meta = this.loaded?.imageInfo.imageMeta?.[0];
    const dims = this.volumeDims;
    const desc = this.currentDescriptor();
    const mppX = desc?.mppX || meta?.mppX || 0;
    return {
      px: [
        desc?.width ?? meta?.x ?? dims?.width ?? 1,
        desc?.height ?? meta?.y ?? dims?.height ?? 1,
        stackDepth(this.loaded?.imageInfo) || dims?.depth || 1,
      ],
      // A descriptor that reports only mppX is square-pixel by convention, which is
      // what the 2D scale bar already assumes of it.
      mpp: [mppX, desc?.mppY || meta?.mppY || mppX, meta?.mppZ || 0],
    };
  }

  /** Assemble the stack into a uint8 volume, driving {@link stackLoadingProgress$}; null on a
   *  Cancel or a new plot. */
  private assembleVolume(
    info: IImageInfo | undefined,
    opts: { maxSlice?: number; sliceStep?: number } = {},
    channel?: number,
  ): Promise<AssembledVolume | null> {
    return this.tileClient.assembleVolume(info, opts, channel, {
      signal: this.loading.signal, // bail on a Cancel / new plot while we fetch
      progress: (p) => this.stackLoadingProgress$.next(p),
    });
  }

  /**
   * Mount the NAPARI_SCATTER 2D scatter: the slice image with a points layer at each region's
   * centroid (napari-js analog of Plotly's region-centroid scatter). Rebuilds the points live as
   * regions change.
   */
  private async mountScatter(viewer: Viewer, host: HTMLElement, z: number): Promise<void> {
    await this.renderImage(z);
    this.fitCameraSoon();
    this.subscribeDisplayState();
    this.installScaleBar();
    this.installNavigator(z);
    // This mode plots REGION centroids, so without the region tools there is no
    // way to produce a point — drawing a region now adds one immediately.
    this.tools.install2dInteraction(viewer, host);
    this.rebuildScatterPoints();
    this.scatterRegionSub = this.regionStore
      .getRegionUpdateEvent()
      .subscribe(() => this.rebuildScatterPoints());
    this.tools.scheduleReadback();
  }

  /** (Re)build the 2D scatter's point layer at the current region centroids. */
  private rebuildScatterPoints(): void {
    const v = this.viewer;
    if (!v) return;
    if (this.scatter2dPoints) {
      v.layers.remove(this.scatter2dPoints);
      this.scatter2dPoints = null;
    }
    const centroids = regionCentroids(this.regionStore.getRegions());
    if (centroids.length === 0) return;
    this.scatter2dPoints = v.addPoints(centroids, {
      size: 12,
      faceColor: [1, 0.85, 0.2, 1],
      borderColor: [0, 0, 0, 1],
      borderWidth: 2,
    });
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
  private async mountSpatialOmics(viewer: Viewer, host: HTMLElement, z: number, noImage = false): Promise<void> {
    // With no image loaded there is nothing to render under the observations; they are
    // framed on their own extent, as for any dataset that brings no image.
    if (!noImage) await this.renderImage(z);
    // Only fit to the image when this dataset actually has one. Otherwise there is
    // nothing to fit, `imageW`/`imageH` still hold the LAST image's dimensions, and
    // this fits to those — and because it defers to a frame, it lands AFTER the points
    // are added and overwrites the framing they set. That is what left an image-less
    // dataset as a ten-pixel speck off to one side.
    if (this.spatialLatest?.[0]?.imageRef) this.fitCameraSoon();
    this.subscribeDisplayState();
    // The scale bar and navigator describe an image; with none loaded, whatever they would
    // read is left over from the last one.
    if (!noImage) {
      this.installScaleBar();
      this.installNavigator(z);
    }
    this.tools.install2dInteraction(viewer, host);
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
    const view = this.spatialLatest?.[1];
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
      latest: () => this.spatialLatest,
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

  /** Movement, in screen pixels, under which a press-release is a CLICK and not a
   *  drag. An orbit or a pan starts the same way, so the two have to be told
   *  apart by how far the pointer travelled. */
  private static readonly CLICK_SLOP_PX = 4;
  /** Longest press-release still treated as a click. A long press with the mouse
   *  held still is more likely an interrupted drag than a selection. */
  private static readonly CLICK_MAX_MS = 600;
  /** Pointer distance, in screen pixels, that still counts as "on" a marker.
   *  Generous relative to a 1.5px disc: the cursor is a blunt instrument, and a
   *  tooltip you have to hunt for is worse than none. */
  private static readonly HOVER_RADIUS_PX = 10;

  /**
   * Cursor tooltip for the spatial views: hover a marker, read its class.
   *
   * A 34-entry legend cannot be read back from a dot — several classes get
   * similar colours, and matching one to a swatch by eye is exactly the task this
   * removes. It reports whatever the cloud is CURRENTLY coloured by, so it and
   * the legend can never say different things.
   *
   * Listens on the HOST rather than the canvas so it keeps working over the region
   * overlay (an SVG covering the canvas, which would otherwise swallow every
   * move), and throttles to one hit-test per animation frame: a pointermove can
   * fire far more often than that, and each test is a pass over the cloud.
   */
  private installSpatialHover(host: HTMLElement): void {
    this.removeSpatialHover();
    this.spatialTooltip = new NapariSpatialTooltip(host);

    const onMove = (e: PointerEvent) => {
      if (!this.canvas) return;
      this.hoverPointer = { clientX: e.clientX, clientY: e.clientY };
      if (this.hoverFrame) return;
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0;
        this.updateHover(host);
      });
    };
    const onLeave = () => {
      this.hoverPointer = null;
      this.spatialTooltip?.hide();
    };

    // A click on a marker selects its class, exactly as clicking that class in the
    // panel's legend does — including clicking again to clear, so a click is
    // always reversible. Tracked as down/up rather than bound to `click` so a DRAG
    // (an orbit in 3D, a pan in 2D) can be told apart from a click: the gesture
    // has to move less than a few pixels and be over quickly.
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const onUp = (e: MouseEvent) => {
      const start = down;
      down = null;
      if (!start) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moved > NapariVisualizerService.CLICK_SLOP_PX) return;
      if (Date.now() - start.t > NapariVisualizerService.CLICK_MAX_MS) return;
      // A region tool owns the pointer while it is active, and placing a polygon
      // vertex is also a click that does not move.
      if (this.tools.regionOverlay?.toolActive) return;
      this.inZone(() => this.selectClassAt(e.clientX, e.clientY));
    };

    // Outside the zone: a pointermove fires far more often than anything here changes what
    // Angular renders (the tooltip is plain DOM); a selecting click re-enters it.
    this.zone.runOutsideAngular(() => {
      host.addEventListener('pointermove', onMove);
      host.addEventListener('pointerleave', onLeave);
      host.addEventListener('pointerdown', onDown);
      host.addEventListener('pointerup', onUp);
    });
    this.hoverOff.push(() => host.removeEventListener('pointermove', onMove));
    this.hoverOff.push(() => host.removeEventListener('pointerleave', onLeave));
    this.hoverOff.push(() => host.removeEventListener('pointerdown', onDown));
    this.hoverOff.push(() => host.removeEventListener('pointerup', onUp));

    // In 3D the cached positions are screen pixels, so an orbit invalidates them.
    const camera = this.viewer?.camera3d;
    if (camera && isSpatialOmics3d(this.currentPlotType)) {
      const off = camera.changed.connect(() => {
        this.spatialSceneRev++;
      });
      this.hoverOff.push(off);
    }
  }

  private removeSpatialHover(): void {
    for (const off of this.hoverOff) off();
    this.hoverOff = [];
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.hoverPointer = null;
    this.spatialTooltip?.dispose();
    this.spatialTooltip = null;
    this.hoverPositions = null;
    this.hoverPositionsRev = -1;
    this.hoverIndex = null;
    this.hoverGrid2d = null;
  }

  /** Hit-test the last pointer position and show or hide the tooltip. */
  private updateHover(host: HTMLElement): void {
    const tip = this.spatialTooltip;
    const pointer = this.hoverPointer;
    const dataset = this.spatialLatest?.[0];
    if (!tip || !pointer || !dataset) return;

    const is3d = isSpatialOmics3d(this.currentPlotType);
    // Transcript markers sit on top of everything, so they are asked first.
    if (!is3d && this.spatialTilesMgr && this.viewer) {
      const world = this.viewer.canvasToWorld(pointer.clientX, pointer.clientY);
      const zoom = this.viewer.camera.zoom;
      const radius = NapariVisualizerService.HOVER_RADIUS_PX / (zoom > 0 ? zoom : 1);
      const lines = world ? this.spatialTilesMgr.hoverAt(world[0], world[1], radius, (details) => {
        const p = this.hoverPointer;
        if (!p || !this.spatialTooltip) return;
        const r = host.getBoundingClientRect();
        this.spatialTooltip.show(details, p.clientX - r.left, p.clientY - r.top);
      }) : null;
      if (lines) {
        const rect = host.getBoundingClientRect();
        tip.show(lines, pointer.clientX - rect.left, pointer.clientY - rect.top);
        return;
      }
    }

    const hit = this.hitTest(dataset.observations, pointer.clientX, pointer.clientY);
    const lines = hoverText(this.hoverSource, hit);
    if (!lines) {
      tip.hide();
      return;
    }
    const rect = host.getBoundingClientRect();
    tip.show(lines, pointer.clientX - rect.left, pointer.clientY - rect.top);
  }

  /**
   * Select the class of the marker at a client position — the canvas equivalent of
   * clicking that class in the panel's legend, and the same selection object, so
   * the two controls cannot produce different results.
   *
   * Clicking a class that is already the whole selection CLEARS it, which is what
   * the legend does. Compared against the selection itself rather than against a
   * remembered click, so selecting from the legend and then clicking the same
   * class on the canvas still toggles.
   */
  private selectClassAt(clientX: number, clientY: number): void {
    const source = this.hoverSource;
    const store = this.selectionStore;
    const dataset = this.spatialLatest?.[0];
    // Only a categorical source has classes to select. A gene is continuous:
    // there is no set of cells that "is" a value.
    if (!store || !dataset || source?.kind !== 'categorical') return;

    // The same pick the tooltip makes — depth-aware in 3D — so a click selects the class the
    // tooltip names, not an occluded marker's.
    const hit = this.hitTest(dataset.observations, clientX, clientY);
    if (hit < 0) return;
    const code = source.codes[hit];
    // A cell the annotation does not cover has no class to select.
    if (code === undefined || code === NO_CATEGORY) return;

    const next = selectByCategory(source.codes, code);
    const current = store.current();
    if (sameSelection(current, next)) {
      store.clear();
      return;
    }
    store.set(next);
  }

  /**
   * The observation under a client position, or -1: the one hit-test the hover tooltip and the
   * click-to-select share. 3D compares canvas pixels against the projected cloud; 2D holds world
   * positions, so the pointer and the radius are converted once instead of projecting the cloud.
   */
  private hitTest(obs: SpatialObservations, clientX: number, clientY: number): number {
    const positions = this.hoverPositionsFor(obs);
    const canvas = this.canvas;
    if (!positions || !canvas) return -1;
    const is3d = isSpatialOmics3d(this.currentPlotType);
    const zoom = is3d ? 1 : (this.viewer?.camera.zoom ?? 1);
    const radius = NapariVisualizerService.HOVER_RADIUS_PX / (zoom > 0 ? zoom : 1);
    if (is3d) {
      const rect = canvas.getBoundingClientRect();
      return this.pickObservation(positions, clientX - rect.left, clientY - rect.top, radius, true);
    }
    const world = this.viewer?.canvasToWorld(clientX, clientY);
    if (!world) return -1;
    return this.pickObservation(positions, world[0], world[1], radius, false);
  }

  /**
   * Which observation is under the cursor.
   *
   * In 3D this defers to napari-js's {@link nearestProjectedIndex} WITH the depths the
   * projection produced, so the front-most candidate wins. That matters more than it
   * sounds: the renderer depth-tests the billboards, and in a 3.7M-point cloud the cursor
   * covers many of them — picking the one nearest the cursor's centre regularly names a
   * cell that something else is drawn over, which reads as a wrong tooltip rather than as
   * a subtlety of picking.
   *
   * In 2D the positions are WORLD coordinates on one plane, so there is no depth to break
   * ties with and the existing nearest-marker rule is the right one.
   */
  private pickObservation(
    positions: Float32Array,
    x: number,
    y: number,
    radius: number,
    is3d: boolean,
  ): number {
    if (!is3d) {
      return this.hoverGrid2d
        ? this.hoverGrid2d.nearest(x, y, radius)
        : nearestObservation(positions, x, y, radius);
    }
    // The cloud draws a selected marker LARGER, so the pick has to use the same radius the
    // renderer used — otherwise the highlighted cells, the ones a reader is most likely to
    // be pointing at, are the hardest to hover.
    const scale = SPATIAL_SELECTED_SIZE_SCALE;
    const mask = this.selectionStore?.current()?.mask;
    const opts = mask?.length
      ? { radiusAt: (i: number) => (mask[i] ? radius * scale : radius) }
      : undefined;
    // `radius` still bounds which buckets are visited, so it has to be the LARGEST any
    // point can claim, not the base one.
    const reach = mask?.length ? radius * scale : radius;
    if (this.hoverIndex) return this.hoverIndex.pick(x, y, reach, opts);
    return nearestProjectedIndex(positions, x, y, reach, this.spatialDepths3d, opts);
  }

  /**
   * Positions to hit-test against, rebuilt only when the scene or camera moved.
   *
   * A pass over 3.7M observations is not something to do per pointermove, and the
   * cloud does not move between frames unless something says it did.
   */
  private hoverPositionsFor(obs: SpatialObservations): Float32Array | null {
    if (this.hoverPositions && this.hoverPositionsRev === this.spatialSceneRev) {
      return this.hoverPositions;
    }
    const is3d = isSpatialOmics3d(this.currentPlotType);
    const built = is3d
      ? this.getSpatialScreenProjection(obs)
      : this.hoverWorldPositions(obs);
    this.hoverPositions = built;
    this.hoverPositionsRev = this.spatialSceneRev;
    // Built here, in the same lazy slot, so it is paid for on the first hover after the
    // scene moved and not on every frame of an orbit. Only worth it past the point where
    // the linear scan stops being free; below that the build costs more than it saves.
    this.hoverIndex = null;
    // 2D: the world positions only change with the dataset or section, so a grid built once
    // replaces a linear scan of every observation per pointermove.
    this.hoverGrid2d = !is3d && built ? PointGridIndex.build(built) : null;
    if (is3d && built && this.canvas && built.length / 2 >= SCREEN_INDEX_MIN_POINTS) {
      const w = this.canvas.clientWidth || this.canvas.width;
      const h = this.canvas.clientHeight || this.canvas.height;
      if (w && h) {
        this.hoverIndex = new ScreenIndex(
          { screen: built, depth: this.spatialDepths3d ?? new Float32Array(built.length / 2) },
          w,
          h,
          // The largest radius any pick here can claim: the base hover radius, times the
          // scale a SELECTED marker is drawn at. Stated rather than left to the default,
          // because it is what decides whether a marker straddling the canvas edge is
          // found — its centre is off screen while part of it is not.
          {
            maxReach: NapariVisualizerService.HOVER_RADIUS_PX
              * SPATIAL_SELECTED_SIZE_SCALE,
          },
        );
      }
    }
    return built;
  }

  /**
   * The 2D markers' WORLD positions, indexed by observation, NaN for any not on
   * the displayed plane — the same affine and the same subset the marker layer was
   * built from, so the tooltip cannot point at a cell that is not drawn.
   */
  private hoverWorldPositions(obs: SpatialObservations): Float32Array | null {
    const dataset = this.spatialLatest?.[0];
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

  /**
   * What the tooltip says, resolved once per colour source rather than per hover.
   *
   * Fetched separately from the colouring on purpose: the reference port caches
   * columns, but a host's need not, and re-fetching a 3.7M-element vector because
   * the pointer moved would be indefensible either way.
   */
  private async resolveHoverSource(
    dataset: SpatialDataset | null, view: SpatialViewState,
  ): Promise<void> {
    const port = this.spatialData;
    const colorBy = view.colorBy;
    const key = dataset && colorBy
      ? `${dataset.id}|${colorBy.kind}:${colorBy.name}`
      : null;
    if (key === this.hoverSourceKey) return;
    // The key is committed only where a value is actually stored. Setting it up
    // front would mean a resolution that loses the race leaves the key claiming a
    // source that was never stored — and since every later emission carries the
    // same key, it would short-circuit here forever and the tooltip would stay
    // silent for the rest of the session.
    const token = ++this.hoverSourceToken;
    // No colour source means nothing is being said about the cells, so there is no
    // cluster to name and the tooltip stays silent.
    if (!key || !dataset || !colorBy || !port) {
      this.hoverSource = null;
      this.hoverSourceKey = key;
      return;
    }
    try {
      if (colorBy.kind === 'column') {
        const column = await port.getColumn(colorBy.name);
        if (token !== this.hoverSourceToken) return;
        this.hoverSource = isCategoricalColumn(column)
          ? {
            kind: 'categorical',
            name: colorBy.name,
            categories: column.meta.categories,
            codes: column.codes,
          }
          : {
            kind: 'continuous',
            name: colorBy.name,
            values: column.values,
            ...(column.meta.unit ? { unit: column.meta.unit } : {}),
          };
        this.hoverSourceKey = key;
        return;
      }
      const values = await port.getFeatureVector(colorBy.name);
      if (token !== this.hoverSourceToken) return;
      this.hoverSource = {
        kind: 'continuous',
        name: colorBy.name,
        values,
        ...(dataset.features?.unit ? { unit: dataset.features.unit } : {}),
      };
      this.hoverSourceKey = key;
    } catch {
      if (token !== this.hoverSourceToken) return;
      // The tooltip is an extra; a failed fetch must not disturb the render. The
      // key is left unset so a later emission retries rather than inheriting a
      // permanent silence.
      this.hoverSource = null;
      this.hoverSourceKey = null;
    }
  }

  /**
   * Project every observation to canvas pixels under the current 3D camera.
   *
   * The projection itself is the renderer's: `viewer.projectPoints` owns the camera, the
   * viewport in CSS pixels, the perspective divide and the y-flip. This used to be fifteen
   * lines of column-major matrix arithmetic here, duplicating a second copy in
   * `napari-axes-labels` — and the two had drifted on what to do with a NaN w.
   *
   * What is left is the part that is genuinely this adapter's: SCATTERING the drawn subset
   * back into observation order. The cloud holds only the points of the displayed section,
   * in its own packing; every consumer indexes by observation. NaN stands for "not on
   * screen", which is also the right answer for an observation whose section is hidden.
   *
   * Null when the 3D cloud is not mounted, so the caller falls back to the 2D affine path.
   */
  getSpatialScreenProjection(obs: SpatialObservations): Float32Array | null {
    const viewer = this.viewer;
    if (!viewer || !this.spatialPositions3d) return null;

    const projected = viewer.projectPoints(this.spatialPositions3d, this.spatialProjection3d);
    if (!projected) return null;
    // Reused across camera changes: at 3.7M observations this is a 30 MB allocation that
    // would otherwise happen on every orbit.
    this.spatialProjection3d = projected;

    const drawn = this.spatialDrawn3d;
    const { screen, depth } = projected;
    const count = screen.length >> 1;
    const out = new Float32Array(obs.count * 2).fill(NaN);
    const depths = new Float32Array(obs.count).fill(NaN);
    for (let k = 0; k < count; k++) {
      const i = drawn ? drawn[k] : k;
      if (i >= obs.count) continue;
      out[i * 2] = screen[k * 2];
      out[i * 2 + 1] = screen[k * 2 + 1];
      depths[i] = depth[k];
    }
    // Kept beside the screen positions so the hover pick can prefer the FRONT-most point
    // under the cursor rather than the one nearest its centre — which in a dense cloud is
    // regularly something the renderer drew another point over.
    this.spatialDepths3d = depths;
    return out;
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
      this.spatialLatest = [dataset, view, selection];
      // The markers are about to move or change meaning, so both halves of the
      // tooltip — where the points are, and what they are — are stale.
      this.spatialSceneRev++;
      void this.resolveHoverSource(dataset, view);
      void (isSpatialOmics3d(this.currentPlotType)
        ? this.rebuildSpatialPoints3d(dataset, view, selection)
        : this.rebuildSpatialPoints(dataset, view, selection));
      if (!isSpatialOmics3d(this.currentPlotType)) this.spatialTilesMgr?.refresh();
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
    this.navigator?.setVisible(datasetHasPixels && this.navigatorVisible);
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
      ? [dataset.id, gene, slab?.slice ?? '', smoothing, this.selectionRev(selection)].join('|')
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
      this.geneMapField = null;
      this.geneMapFieldKey = null;
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

    if (fieldKey !== this.geneMapFieldKey) {
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
      this.geneMapField = expressionField(dataset.observations, {
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
      this.geneMapFieldKey = fieldKey;
    }
    const field = this.geneMapField;
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
    const latest = this.spatialLatest;
    if (!latest?.[0] || isSpatialOmics3d(this.currentPlotType)) return;
    void this.rebuildSpatialPoints(...latest);
  }

  /**
   * Mount the SPATIAL_OMICS_3D view: observations as a 3D point cloud under the orbit camera.
   *
   * Thinner than the 2D mount: there is no tissue image to render (a registered volume like the
   * Allen CCF has no single reference plane), so no readback and no navigator; the 3D scale bar
   * follows the dataset (see {@link installSpatial3dScaleBar}). The region tools work in SCREEN
   * space through {@link install3dInteraction} — a lasso selects the cells under it, and an orbit
   * clears the shape while keeping the selection. The first 3D layer added frames the camera
   * (`fit3d: 'once'`).
   */
  private async mountSpatialOmics3d(viewer: Viewer, host: HTMLElement): Promise<void> {
    this.tools.install3dInteraction(viewer, host);
    this.installSpatialHover(host);
    this.subscribeSpatial();
  }

  /**
   * Scale bar for the 3D cloud, measured at the ORBIT PIVOT.
   *
   * A perspective camera has no single scale — things farther away are smaller — so a bar can
   * only be true at one depth. The pivot is the honest choice: it is what the camera is framing,
   * what a zoom moves towards, and where the eye is anyway. napari's own 3D scale bar works the
   * same way.
   *
   * `NapariScaleBar` needs CSS px per world unit, which an orbit camera does not expose, but at
   * the pivot it is exactly `viewportHeight / (2 * distance * tan(fov / 2))` — the same
   * relationship `Camera3D.pan` uses to track the cursor. The bar then converts through
   * `micronsPerUnit`, and draws nothing at all when the dataset does not declare one, because a
   * bar labelled in microns over unknown units would read as a measurement.
   */
  private installSpatial3dScaleBar(viewer: Viewer, dataset: SpatialDataset | null): void {
    this.scaleBar?.destroy();
    this.scaleBar = null;
    this.navigator?.destroy();
    this.navigator = null;
    const micronsPerUnit = dataset?.micronsPerUnit;
    if (!this.host || !micronsPerUnit || micronsPerUnit <= 0) return;

    const canvas = this.canvas;
    const cam = viewer.camera3d;
    const shim: ScaleBarCamera = {
      get zoom(): number {
        const h = canvas?.clientHeight || canvas?.height || 0;
        const worldPerPx = (2 * cam.distance * Math.tan(cam.fov / 2)) / (h || 1);
        return worldPerPx > 0 ? 1 / worldPerPx : 0;
      },
      changed: cam.changed,
    };
    this.scaleBar = new NapariScaleBar(this.host, shim, micronsPerUnit);
  }

  /** (Re)build the 3D point cloud for the current dataset + view state. */
  private async rebuildSpatialPoints3d(
    dataset: SpatialDataset | null, view: SpatialViewState,
    selection: SpatialSelectionMask = emptySelection(),
  ): Promise<void> {
    const viewer = this.viewer;
    if (!viewer) return;
    const token = ++this.spatialRebuildToken;

    // Resolve the scalar encoding BEFORE touching the scene, for the same reason
    // the 2D path does: a gene fetch can fail or be superseded, and dropping the
    // layer first would blank the view.
    let enc: Spatial3dEncoding | null = null;
    if (dataset) {
      const endLoading = this.badge.begin('Observations');
      try {
        enc = await this.spatialScalar3d(view);
      } catch (err) {
        console.warn('[napari-js] spatial 3D colouring failed — falling back to a flat colour', err);
        enc = null;
      } finally {
        endLoading();
      }
    }
    if (token !== this.spatialRebuildToken || this.viewer !== viewer) return;

    const obs = dataset?.observations;
    // No z means nothing to draw in 3D. The plot type is gated on `requiresSpatial3d`
    // so this should be unreachable from the UI, but a host can set the type directly.
    if (!dataset || !obs || obs.count === 0 || !obs.z) {
      this.removeSpatial3dLayers(viewer);
      return;
    }

    // Anatomy first: on a scene's FIRST layer napari frames the orbit camera, and
    // the reference volume is the framing we want — the brain, not the outermost
    // stray segmentation. Every later add keeps the pose instead (napari-js `fit3d: 'once'`).
    await this.ensureSpatialVolume(viewer, dataset, view);
    if (token !== this.spatialRebuildToken || this.viewer !== viewer) return;
    // Then the cluster density volumes, which can set the centring offset when
    // there is no reference volume — so before any position is computed from it.
    await this.ensureDensityVolumes(viewer, dataset, view, selection);
    if (token !== this.spatialRebuildToken || this.viewer !== viewer) return;
    // Then the gene map, which shares the reference volume's lattice — so it goes
    // after anything that can still move the centring offset.
    await this.ensureGeneMapVolume(viewer, dataset, view, selection);
    if (token !== this.spatialRebuildToken || this.viewer !== viewer) return;
    // Scale depends on the dataset's declared unit, so it waits for the dataset
    // rather than being set up at mount time.
    if (dataset.id !== this.spatialScaleBarKey) {
      this.spatialScaleBarKey = dataset.id;
      this.installSpatial3dScaleBar(viewer, dataset);
    }

    // The reference volume is hidden, not removed: it also fixes the centring
    // offset every position is computed from, and re-fetching a 100 MB template
    // to un-hide it would make a checkbox feel like a load.
    if (this.spatialVolume) {
      this.spatialVolume.visible = view.showVolume;
      this.spatialVolume.opacity = view.volumeOpacity;
    }

    const scale = view.pointScale > 0 ? view.pointScale : 1;
    const size = SPATIAL_3D_BASE_SIZE * scale;
    const scalars = enc?.values ?? new Float32Array(obs.count);
    const colormap = enc?.colormap ?? spatialFlatColormap();
    const contrastLimits: [number, number] = enc?.contrastLimits ?? [0, 1];

    // One imaged section, or the whole stack. The subset IS the geometry, so it
    // belongs in the geometry key rather than being re-derived per frame — and an
    // out-of-range index is clamped rather than dropping the cloud, because the
    // section count changes with the dataset while the view state persists.
    const sections = sectionsOf(obs);
    const section =
      view.pointSection != null && sections && sections.length > 0
        ? sections[Math.max(0, Math.min(sections.length - 1, view.pointSection))]
        : null;
    const shown = section != null ? observationsInSection(obs, section) : null;
    const shownCount = shown ? shown.length : obs.count;

    const key = `${dataset.id}:${obs.count}:${section ?? 'all'}`;
    // Track the scalars' identity separately from the geometry's (`colorBy` plus the
    // transforms feeding the encoding): a new colour source swaps `values` in place
    // (napari-js ≥ 0.14), while a new geometry needs a new layer.
    const clip = view.percentileClip ?? [0.01, 0.99];
    const scalarKey = [
      key,
      view.colorBy ? `${view.colorBy.kind}:${view.colorBy.name}` : 'flat',
      view.logScale ? 'log' : 'lin',
      clip.join(','),
    ].join('|');

    if (key !== this.spatialLayerKey3d) {
      // New geometry: interleave x,y,z (the layer's documented layout, x-fastest)
      // and cache it, so later colour changes rebuild the layer without walking
      // the observations again.
      const [ox, oy, oz] = this.spatialOrigin3d;
      const positions = new Float32Array(shownCount * 3);
      for (let k = 0; k < shownCount; k++) {
        const i = shown ? shown[k] : k;
        positions[k * 3] = obs.x[i] + ox;
        positions[k * 3 + 1] = obs.y[i] + oy;
        positions[k * 3 + 2] = obs.z[i] + oz;
      }
      this.spatialPositions3d = positions;
      this.spatialDrawn3d = shown;
    }

    // The scalars have to follow the geometry: a per-observation vector against one
    // section's positions would colour each cell by a stranger's value.
    const valuesFor = () => (shown ? Float32Array.from(shown, (i) => scalars[i]) : scalars);

    if (!this.spatialPoints3d || key !== this.spatialLayerKey3d) {
      // New GEOMETRY — a different dataset, or a different section — so a new layer.
      if (this.spatialPoints3d) viewer.layers.remove(this.spatialPoints3d);
      this.spatialLayerKey3d = key;
      this.spatialScalarKey3d = scalarKey;
      this.spatialPoints3d = viewer.addPoints3D(this.spatialPositions3d!, valuesFor(), {
        name: 'observations',
        colormap,
        contrastLimits,
        size,
      });
    } else {
      if (scalarKey !== this.spatialScalarKey3d) {
        // A change of colour SOURCE, which used to mean discarding the layer and building
        // another — and, because adding a 3D layer reframes, a camera jump to undo as well.
        // napari-js ≥ 0.14 lets the scalars be replaced in place — the setter bumps the
        // layer's dataVersion so the visual re-uploads — and the positions have not moved,
        // so there is nothing for the camera to reframe.
        this.spatialScalarKey3d = scalarKey;
        this.spatialPoints3d.values = valuesFor();
      }
      this.spatialPoints3d.colormap = colormap;
      this.spatialPoints3d.contrastLimits = contrastLimits;
      this.spatialPoints3d.size = size;
    }

    // Selection is a PER-POINT alpha, in the one layer.
    //
    // It used to be a second layer: with a single opacity for the whole cloud, the only way
    // to highlight a subset was to draw it again on top at full opacity while the parent
    // dropped to the muted level. That second layer had to be kept in step through every
    // colormap, window and size change, and the two then depth-sorted against each other as
    // separate draws. Per-point alphas and sizes give the same reading — muted cloud, bright
    // selection, slightly larger so a small one is findable inside 3.7M points — in one.
    const hasSelection = selection.count > 0 && selection.mask.length === obs.count;
    const cloud = this.spatialPoints3d;
    if (cloud) {
      cloud.opacity = view.opacity;
      if (!hasSelection) {
        cloud.alphas = null;
        cloud.sizes = null;
      } else {
        const alphas = new Float32Array(shownCount);
        const sizes = new Float32Array(shownCount);
        for (let k = 0; k < shownCount; k++) {
          const i = shown ? shown[k] : k;
          const picked = !!selection.mask[i];
          alphas[k] = picked ? 1 : DEFAULT_MUTED_OPACITY;
          sizes[k] = picked ? SPATIAL_SELECTED_SIZE_SCALE : 1;
        }
        cloud.alphas = alphas;
        cloud.sizes = sizes;
      }
    }
    // Last, so it also covers a layer this pass just created.
    if (this.spatialPoints3d) this.spatialPoints3d.visible = view.showPoints;
    viewer.requestRender();
  }

  /**
   * The **3D gene map**: the active gene's expression over the whole sectioned
   * specimen, as one raymarched volume.
   *
   * Two things it can be, and the panel's `Volume rendering` toggle picks which:
   *
   *  - **sheets** — exactly the planes that were imaged, each carrying that
   *    slide's own 2D gene map, with the gaps between sections empty. A stack of
   *    measured fields, at their true z.
   *  - **volume** — the same fields smoothed along z, so the planes between the
   *    sections carry an interpolated value. An estimate, and drawn as a
   *    translucent cloud for the same reason the density volumes are.
   *
   * One `VolumeLayer` rather than a textured quad per section: an `ImageLayer`
   * renders only at `ndisplay === 2`, so 53 sheets in the orbit view would need a
   * new layer type upstream — while a scalar volume whose z sampling already IS
   * the section spacing expresses the sheets exactly, and the same lattice then
   * gives the interpolated version for free.
   *
   * Estimated on the reference volume's own lattice (`densityGrid` at stride 1),
   * so the field lands voxel-for-voxel on the anatomy and needs no offset — a
   * `VolumeLayer` has no translate, and napari centres both boxes on the world
   * origin.
   */
  private async ensureGeneMapVolume(
    viewer: Viewer, dataset: SpatialDataset, view: SpatialViewState,
    selection: SpatialSelectionMask,
  ): Promise<void> {
    const gene = view.geneMap && view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
    const port = this.spatialData;
    const smoothing = view.geneMapSmoothing > 0 ? view.geneMapSmoothing : 1;
    const clip = view.percentileClip ?? [0.01, 0.99];
    const obs = dataset.observations;
    // A volume built from ONE section would smear that slide through the whole
    // depth, so the section restriction only applies to the sheets.
    const interpolate = !!view.geneMapVolume;
    const sections = sectionsOf(obs);
    const section =
      !interpolate && view.geneMapSection != null && sections && sections.length > 0
        ? sections[Math.max(0, Math.min(sections.length - 1, view.geneMapSection))]
        : null;

    const fieldKey = gene
      ? [
        dataset.id, gene, smoothing, section ?? 'all', interpolate ? 'vol' : 'sheets',
        this.selectionRev(selection),
      ].join('|')
      : null;
    const key = fieldKey
      ? [
        fieldKey, clip.join(','), view.logScale ? 'log' : 'lin', view.geneMapOpacity,
        this.display.continuousColormapKey(view),
      ].join('|')
      : null;
    if (key === this.geneMapVolumeKey) return;

    if (this.geneMapVolumeLayer) {
      viewer.layers.remove(this.geneMapVolumeLayer);
      this.geneMapVolumeLayer = null;
    }
    this.geneMapVolumeKey = key;
    if (!key || !gene || !port) {
      this.geneMapVolumeField = null;
      this.geneMapVolumeFieldKey = null;
      return;
    }

    // Coarsened in-plane but NOT along z: the sheets need one plane per imaged
    // section, while the field they carry is smooth by construction and gains
    // nothing from the template's 40 µm detail. At full resolution the estimate is
    // a 5.7M-voxel pair of blurs on the main thread — seconds of frozen UI for a
    // checkbox; an eighth of the voxels is an eighth of the work.
    const grid = densityGrid(dataset, GENE_MAP_VOLUME_STRIDE, 128, 1);
    if (!grid) return;

    if (fieldKey !== this.geneMapVolumeFieldKey) {
      let values: Float32Array;
      try {
        values = await port.getFeatureVector(gene);
      } catch (err) {
        console.warn(`[napari-js] 3D gene map: "${gene}" unavailable`, err);
        this.geneMapVolumeKey = null;
        return;
      }
      if (this.viewer !== viewer || this.geneMapVolumeKey !== key) return;
      const inSelection = selection.count > 0 ? maskToIndices(selection.mask) : undefined;
      // In-plane σ is a PHYSICAL bandwidth, anchored to the reference volume's own
      // voxel — the resolution the 2D map estimates at — so a sheet and the 2D
      // view of the same section are the same field whatever lattice this is
      // rasterised on. Along z it is the density path's 1.5 voxels: the smallest σ
      // that bridges one section gap.
      const inPlane = dataset.volume?.voxelSize ?? grid.voxelSize;
      this.geneMapVolumeField = expressionVolume(obs, grid, {
        sigma: [
          inPlane[0] * GENE_MAP_SIGMA * smoothing,
          inPlane[1] * GENE_MAP_SIGMA * smoothing,
          grid.voxelSize[2] * 1.5 * smoothing,
        ],
        values,
        indices: section != null ? observationsInSection(obs, section) : inSelection,
        interpolate,
      });
      this.geneMapVolumeFieldKey = fieldKey;
    }
    const field = this.geneMapVolumeField;
    if (!field) return;

    // The high end over the MEASURED voxels only (the unmeasured zeros would pull it down and
    // saturate the map), but the low end stays 0: in a volume the value is also the opacity and
    // 0 reads as "nothing here", so starting at the lowest measured value would erase it.
    const [, hi] = fieldContrastWindow(field, clip[0], clip[1]);
    const lo = 0;
    const data = encodeExpressionVolume(field, [lo, hi], { log: view.logScale });
    const lut = this.display.spatialLut(view);
    this.geneMapVolumeLayer = viewer.addVolume(
      data, field.width, field.height, field.depth,
      {
        name: `gene map · ${gene}${interpolate ? ' · volume' : ''}`,
        colormap: colormapFromLut(`gene-map-${gene}`, lut),
        // The encoding already applied the window, so the layer must not apply a
        // second one: 0..255 is the whole of what it was given.
        contrastLimits: [0, 255],
        rendering: 'translucent',
        // Additive like the density volumes, and for the same reason: the sheets
        // have to read THROUGH each other and through the anatomy, which a
        // translucent blend would occlude one sheet at a time.
        blending: 'additive',
        opacity: view.geneMapOpacity,
        voxelSize: grid.voxelSize,
      },
    );
    viewer.requestRender();
  }

  /**
   * Cluster density volumes: each cluster rasterised into a smooth scalar field and
   * raymarched alongside the cloud, tinted with the cluster's own legend colour.
   *
   * This is what makes a serially sectioned dataset readable as an anatomical
   * distribution. The cloud shows measured cells and nothing else — but at 200 µm
   * section spacing the eye cannot integrate a stack of discs into a shape, and
   * every gap reads as absence. A density field is a different object from a cell:
   * an estimate, defined between the imaged planes, drawn as a translucent cloud so
   * it cannot be mistaken for measurement. Individual cells are never interpolated —
   * consecutive sections sample different cells, so there is nothing to interpolate
   * along.
   *
   * One volume per cluster rather than one for everything: additive blending is what
   * makes two clusters' territories comparable, and a single blended field would
   * answer no question anyone asks of a taxonomy. Capped at
   * {@link DENSITY_MAX_CLUSTERS} by cell count.
   *
   * Keyed so it rebuilds only when the field would actually differ — the dataset,
   * the colour column, the bandwidth, or the selection.
   */
  private async ensureDensityVolumes(
    viewer: Viewer, dataset: SpatialDataset, view: SpatialViewState,
    selection: SpatialSelectionMask,
  ): Promise<void> {
    const on = !!view.densityVolume && !!dataset.observations.z;
    const smoothing = view.densitySmoothing > 0 ? view.densitySmoothing : 1;
    const column = view.colorBy?.kind === 'column' ? view.colorBy.name : null;
    // The selection enters the key by IDENTITY, not by count: two different ROIs
    // holding the same number of cells would otherwise look like the same key and
    // leave the previous ROI's fields on screen.
    const key = on
      ? [dataset.id, column ?? 'all', smoothing, this.selectionRev(selection)].join('|')
      : null;
    if (key === this.densityKey) return;

    for (const layer of this.densityLayers) viewer.layers.remove(layer);
    this.densityLayers = [];
    this.densityKey = key;
    if (!key) return;

    const grid = densityGrid(dataset);
    if (!grid) return;
    // With no reference volume there is no offset yet, and a VolumeLayer has no
    // translate — napari centres its box on the world origin. So the POINTS move by
    // half the density box, exactly as they do for a reference volume, and the
    // cached geometry is invalidated because that offset just changed.
    if (!this.spatialVolume) {
      this.spatialOrigin3d = [
        -(grid.width * grid.voxelSize[0]) / 2,
        -(grid.height * grid.voxelSize[1]) / 2,
        -(grid.depth * grid.voxelSize[2]) / 2,
      ];
      this.spatialLayerKey3d = null;
    }

    let groups: { name: string; color: string; indices?: Uint32Array }[];
    try {
      groups = await this.densityGroups(dataset, column, selection);
    } catch (err) {
      console.warn('[napari-js] density volumes: column unavailable', err);
      this.densityKey = null;
      return;
    }
    if (this.viewer !== viewer || this.densityKey !== key) return;

    const sigma = defaultSigma(grid, smoothing);
    // Additive blending SUMS, so a fixed per-layer opacity blows out to white as
    // soon as several broad clusters overlap — six subclasses at 0.55 each turned
    // the brain into one cyan mass. Splitting the budget keeps n fully overlapping
    // peaks inside the display's range, so overlap reads as overlap; a single
    // cluster still gets the full 0.55. It only mitigates: a translucent raymarch
    // integrates along the ray, so clusters that are ubiquitous rather than
    // regional (the largest subclasses are glia, which are everywhere) still pile
    // up, and one cluster at a time is the readable way to look at those.
    const opacity = Math.min(0.55, 0.9 / Math.max(1, groups.length));
    for (const group of groups) {
      const data = rasterizeDensity(dataset.observations, grid, { sigma, indices: group.indices });
      // A cluster with nothing on the grid draws no layer, rather than an empty box.
      if (!data) continue;
      if (this.viewer !== viewer || this.densityKey !== key) return;
      this.densityLayers.push(
        (
          viewer.addVolume(data, grid.width, grid.height, grid.depth, {
            name: `density · ${group.name}`,
            colormap: this.display.channelTintColormap(group.color),
            // Translucent, not MIP: a cluster's interior is the readable part, and MIP
            // would flatten every cloud to its brightest shell.
            rendering: 'translucent',
            opacity,
            // Additive, so two clusters overlapping read as both being there instead
            // of the nearer one hiding the other.
            blending: 'additive',
            voxelSize: grid.voxelSize,
          })),
      );
    }
    viewer.requestRender();
  }

  /**
   * A revision number for a selection object.
   *
   * The store hands out a NEW mask object per change, so object identity is the
   * cheap and exact way to tell two selections apart — a fingerprint over 3.7M
   * mask bytes would be neither. Counting revisions keeps the cache key a short
   * string.
   */
  private selectionRev(selection: SpatialSelectionMask): number {
    if (selection !== this.lastSelectionSeen) {
      this.lastSelectionSeen = selection;
      this.selectionRevision++;
    }
    return this.selectionRevision;
  }

  /**
   * The clusters to rasterise: the categories of the active categorical colouring,
   * biggest first and capped, each with its legend colour.
   *
   * Restricted to the current selection when there is one, so "select a region,
   * check the box" answers which clusters live there. With no categorical colouring
   * there is one group — total cell density, which is a real question on its own
   * ("where is the tissue dense?") and the honest thing to show when the view is
   * not encoding a taxonomy.
   */
  private async densityGroups(
    dataset: SpatialDataset, column: string | null, selection: SpatialSelectionMask,
  ): Promise<DensityGroup[]> {
    const port = this.spatialData;
    const meta = column ? findColumnMeta(dataset, column) : undefined;
    if (!port || !column || !meta || meta.kind !== 'categorical') return [totalDensityGroup(selection)];
    const loaded = await port.getColumn(column);
    if (!isCategoricalColumn(loaded)) return [];
    return rankDensityGroups(column, loaded, dataset.observations.count, selection);
  }

  /**
   * Add (or keep) the dataset's reference volume, and derive the offset that sits the
   * observations inside it.
   *
   * `VolumeLayer` has no translate: napari-js maps the volume's unit cube to a world box
   * **centred on the origin**, sized `dims x voxelSize`. The observations, by contract, are in
   * the volume's own frame with its near corner at the coordinate origin. So the two only line
   * up if the POINTS move — by half the box — which is what {@link spatialOrigin3d} is.
   *
   * A failed or absent volume is not fatal: the cloud renders on its own, at its own
   * coordinates, and the camera frames the points instead.
   */
  private async ensureSpatialVolume(
    viewer: Viewer, dataset: SpatialDataset, view: SpatialViewState,
  ): Promise<void> {
    const meta = dataset.volume;
    const port = this.spatialData;
    const key = meta ? `${dataset.id}:${meta.width}x${meta.height}x${meta.depth}` : null;
    if (key && key === this.spatialVolumeKey) return;

    if (this.spatialVolume) {
      viewer.layers.remove(this.spatialVolume);
      this.spatialVolume = null;
      this.spatialVolumeKey = null;
    }
    this.spatialOrigin3d = [0, 0, 0];
    if (!meta || !port?.getVolume) return;

    let voxels: Uint8Array;
    try {
      voxels = await port.getVolume();
    } catch (err) {
      console.warn('[napari-js] reference volume unavailable — drawing the cloud alone', err);
      return;
    }
    if (this.viewer !== viewer) return;

    const [vx, vy, vz] = meta.voxelSize;
    this.spatialVolumeKey = key;
    this.spatialVolume = (
      viewer.addVolume(voxels, meta.width, meta.height, meta.depth, {
      name: 'reference volume',
      colormap: 'gray',
      // MIP would draw the brightest voxel along each ray, which for an averaged
      // template means a flat white shell that hides the cloud. Translucent lets
      // the points read through the tissue, which is the entire point of drawing
      // them together.
      rendering: 'translucent',
      opacity: view.volumeOpacity,
        voxelSize: [vx, vy, vz],
      }));
    // Half the box, negated: the observations' origin is the box's near corner,
    // and the box is centred on the world origin.
    this.spatialOrigin3d = [
      -(meta.width * vx) / 2,
      -(meta.height * vy) / 2,
      -(meta.depth * vz) / 2,
    ];
    // Force a geometry rebuild: the offset changed, so cached positions are stale.
    this.spatialLayerKey3d = null;
  }

  private removeSpatial3dLayers(viewer: Viewer): void {
    for (const layer of [
      this.spatialPoints3d, this.spatialVolume,
      this.geneMapVolumeLayer, ...this.densityLayers,
    ]) {
      if (layer) viewer.layers.remove(layer);
    }
    this.geneMapVolumeLayer = null;
    this.geneMapVolumeKey = null;
    this.geneMapVolumeField = null;
    this.geneMapVolumeFieldKey = null;
    this.densityLayers = [];
    this.densityKey = null;
    // The scene is gone, so the next 3D layer should frame itself again. That used to be
    // `spatialFramed = null` next to a hand-rolled save/restore; the renderer owns the
    // policy now, and this is the same statement addressed to it.
    viewer.resetFit3D();
    this.spatial2dFramed = null;
    this.spatialVolume = null;
    this.spatialVolumeKey = null;
    this.spatialOrigin3d = [0, 0, 0];
    this.spatialPoints3d = null;
    this.spatialLayerKey3d = null;
    this.spatialScalarKey3d = null;
    this.spatialPositions3d = null;
    this.spatialDrawn3d = null;
  }

  /**
   * The per-point scalar + colormap + window that colour the 3D cloud.
   *
   * Continuous data is the natural fit: values go straight through the active colormap with the
   * same percentile window the 2D path uses. Categorical data has to be smuggled through the same
   * scalar channel — see {@link SPATIAL_3D_MAX_CATEGORIES}. Codes map to LUT blocks, and
   * `contrastLimits` of `[-0.5, K - 0.5]` puts code `i` at the centre of block `i`, which is what
   * makes the round-trip exact instead of approximately right.
   */
  private async spatialScalar3d(view: SpatialViewState): Promise<Spatial3dEncoding | null> {
    const port = this.spatialData;
    const colorBy = view.colorBy;
    if (!port || !colorBy) return null;

    if (colorBy.kind === 'column') {
      const column: SpatialColumn = await port.getColumn(colorBy.name);
      if (isCategoricalColumn(column)) {
        return encodeSpatial3dCategorical(column.codes, resolveCategoryColors(column.meta));
      }
      return this.encodeSpatial3dContinuous(column.values, view);
    }
    return this.encodeSpatial3dContinuous(await port.getFeatureVector(colorBy.name), view);
  }

  /** Continuous values → the active colormap over a percentile-clipped window (3D cloud). */
  private encodeSpatial3dContinuous(source: Float32Array, view: SpatialViewState): Spatial3dEncoding {
    return encodeSpatial3dContinuous(source, view, this.display.spatialLut(view), this.contrastWindows);
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
    return encodeSpatialContinuous(values, view, this.display.spatialLut(view), this.contrastWindows, muted);
  }

  /**
   * Mount the NAPARI_SCATTER3D 3D scatter: the downsampled voxel grid as a 3D point cloud colored
   * by intensity (napari-js analog of Plotly's voxel scatter3d). Assembles a coarse volume, then
   * emits a flat-strided sample of voxels (capped at {@link SCATTER3D_MAX_POINTS}) via `addPoints3D`.
   */
  private async mountScatter3d(viewer: Viewer, info: IImageInfo | undefined): Promise<void> {
    this.imageMode = 'grayscale';
    this.volumeMultichannel = false;
    const res = volumeResolutionFor(this.resolutionScale);
    this.stackLoading$.next(true);
    this.stackLoadingProgress$.next(0);
    let vol: { data: Uint8Array; width: number; height: number; depth: number } | null = null;
    try {
      vol = await this.assembleVolume(info, {
        maxSlice: Math.min(res.maxSlice, SCATTER3D_MAX_XY),
        sliceStep: res.sliceStep,
      });
    } finally {
      this.stackLoading$.next(false);
      this.stackLoadingProgress$.next(0);
    }
    if (!vol || this.viewer !== viewer) return;

    const { data, width, height, depth } = vol;
    const zScale = Math.max(width, height) / Math.max(1, depth); // ≈ cubic aspect
    const total = width * height * depth;
    const stride = Math.max(1, Math.ceil(total / SCATTER3D_MAX_POINTS));
    const pos: number[] = [];
    const val: number[] = [];
    for (let i = 0; i < total; i += stride) {
      const x = i % width;
      const y = Math.floor(i / width) % height;
      const zi = Math.floor(i / (width * height));
      pos.push(x, y, zi * zScale);
      val.push(data[i]);
    }

    const st = this.store.currentChannelStates()[0];
    this.scatter3dLayer = viewer.addPoints3D(new Float32Array(pos), new Float32Array(val), {
      colormap: this.display.volumeColormap(st),
      contrastLimits: [st?.min ?? 0, st?.max ?? 255],
      size: 3,
    });
    this.imageW = width;
    this.imageH = height;
    this.volumeDims = { width, height, depth };
    // Feed the intensity histogram from the assembled volume (key 0).
    this.volumeChannelData.clear();
    this.volumeChannelData.set(0, data);
    this.subscribeScatter3dDisplayState();
    this.tools.scheduleReadback();
  }

  /** Store colormap / reverse / invert / channel window → the 3D scatter's colormap + contrast. */
  private subscribeScatter3dDisplayState(): void {
    this.watchDisplayState((channels) => {
      const layer = this.scatter3dLayer;
      if (!layer) return;
      const st = channels[0];
      layer.colormap = this.display.volumeColormap(st);
      if (st) layer.contrastLimits = [st.min, st.max];
      this.viewer?.requestRender();
    });
  }

  /**
   * Mount the NAPARI_SURFACE height-field surface. A height field is single-scalar, so for a
   * multichannel image the surface follows ONE band — the first visible channel (fallback 0) —
   * coloured by that channel's window/colormap (like the Plotly SURFACE, which is grayscale-only).
   * Pre-loads every slice's height data with a progress bar (as the volume does) so the stack
   * slider re-slices instantly, then builds the mesh for the current slice. All mesh + GPU work
   * lives in napari-js (`heightField` + `Viewer.addSurface`); this backend supplies scalar slices.
   */
  private async mountSurface(viewer: Viewer): Promise<void> {
    const desc = await this.tileClient.ensureDescriptor(this.info());
    const info = this.loaded?.imageInfo;
    // Serverless multichannel (tiled:false + channelUrls) has no descriptor — detect
    // it from imageMeta so the Surface still follows one band.
    const simpleMc = isServerlessMultichannel(this.simpleStack.isSimple(info), info);
    const multichannel = simpleMc || (!!desc?.multichannel && (desc?.channels ?? 1) > 1);
    this.surfaceMultichannel = multichannel;
    // A height field is single-scalar → follow the pane-SELECTED channel.
    this.surfaceChannel = multichannel ? this.store.currentSelectedChannel() : undefined;
    this.surfaceMaxGrid = surfaceResolutionFor(this.resolutionScale).maxGrid;
    this.imageMode = 'grayscale';
    this.volumeMultichannel = false;
    await this.preloadSurfacePlanes(viewer);
    if (this.viewer !== viewer) return;
    await this.buildSurface(viewer, this.loaded?.z ?? 0);
    this.installSurfaceAxes(viewer);
    // Subscribe after the first build so display-state edits target a live layer.
    this.subscribeSurfaceDisplayState();
  }

  /** Add the 3D axes gizmo + DOM labels around the (origin-centered) surface mesh, matching the
   *  volume/isosurface. Installed once per mount; the box tracks the mesh bounds, X/Y show the
   *  physical (or pixel) extent, and Z is the intensity/height axis. */
  private installSurfaceAxes(viewer: Viewer): void {
    if (!this.surfaceLayer) return;
    const b = this.surfaceLayer.bounds();
    const boxW = Math.max(1, b.max[0] - b.min[0]);
    const boxH = Math.max(1, b.max[1] - b.min[1]);
    const boxD = Math.max(1, b.max[2] - b.min[2]);
    const desc = this.currentDescriptor();
    const mppX = this.tileClient.mppX(this.info());
    const voxel = mppX > 0 ? (mppX * (desc?.width ?? this.imageW)) / Math.max(1, this.imageW) : 1;
    this.axesLayer = viewer.addAxes(boxW, boxH, boxD, {
      voxelSize: [voxel, voxel, 1],
      visible: this.axesVisible,
    });
    if (this.host) {
      this.axesLabels = new NapariAxesLabels(
        this.host,
        viewer.camera3d,
        this.buildSurfaceAxesLabels(boxW, boxH, boxD, mppX),
      );
      this.axesLabels.setVisible(this.axesVisible);
    }
  }

  /** X/Y/Z end-labels for the surface gizmo: X/Y are the physical (µm) or pixel extent of the FULL
   *  image; Z is the intensity/height axis. Anchors are in the centered box (matching AxesLayer). */
  private buildSurfaceAxesLabels(
    boxW: number,
    boxH: number,
    boxD: number,
    mppX: number,
  ): AxisLabelSpec[] {
    const hx = boxW / 2;
    const hy = boxH / 2;
    const hz = boxD / 2;
    const desc = this.currentDescriptor();
    const descW = desc?.width ?? this.imageW;
    const descH = desc?.height ?? this.imageH;
    const len = (px: number): string => (mppX > 0 ? formatUm(px * mppX) : `${px} px`);
    return [
      { anchor: [hx, -hy, -hz], text: `X · ${len(descW)}`, color: '#ed4545' },
      { anchor: [-hx, hy, -hz], text: `Y · ${len(descH)}`, color: '#4dd959' },
      { anchor: [-hx, -hy, hz], text: 'Z · intensity', color: '#668cff' },
    ];
  }

  /**
   * Pre-fetch every stack slice's luminance plane (decimated to the surface grid) into
   * {@link surfacePlanes}, driving {@link stackLoadingProgress$} — the same load-with-progress UX
   * as the volume, but keeping one 2D plane per slice rather than packing a 3D volume. Bounded
   * concurrency keeps the connection pool busy without flooding it on a deep stack.
   */
  private async preloadSurfacePlanes(viewer: Viewer): Promise<void> {
    // A channel switch starts a new preload while this one may still be in flight: the newer
    // one owns the plane cache and the progress bar from here on.
    this.surfacePreload?.abort();
    const preload = new AbortController();
    this.surfacePreload = preload;
    const loading = this.loading.signal; // bail on a Cancel / new plot while we fetch
    const stale = (): boolean =>
      preload.signal.aborted || loading.aborted || this.viewer !== viewer;
    const info = this.loaded?.imageInfo;
    const depth = stackDepth(info) || 1;
    const { maxGrid } = surfaceResolutionFor(this.resolutionScale);
    this.surfacePlanes.clear();
    this.stackLoading$.next(true);
    this.stackLoadingProgress$.next(0);
    try {
      let done = 0;
      const slices = Array.from({ length: depth }, (_, z) => z);
      await mapPool(slices, VOLUME_FETCH_CONCURRENCY, async (z) => {
        try {
          const plane = await this.fetchSurfacePlane(z, maxGrid);
          // Superseded while in flight: this plane may be the OLD band, and the cache is not
          // this preload's any more.
          if (stale()) return;
          this.surfacePlanes.set(z, plane);
        } catch (err) {
          if (stale()) return;
          console.warn(`[napari-js] surface slice ${z} preload failed`, err);
        }
        done++;
        this.stackLoadingProgress$.next(Math.round((done / depth) * 100));
      }, stale);
    } finally {
      // Only the newest preload ends the progress bar; a superseded one would hide it while
      // its successor is still loading.
      if (this.surfacePreload === preload) {
        this.surfacePreload = null;
        this.stackLoading$.next(false);
        this.stackLoadingProgress$.next(0);
      }
    }
  }

  /** Slice `z` as a whole-image luminance plane of the surface's band, decimated to `maxGrid`. */
  private fetchSurfacePlane(z: number, maxGrid: number): Promise<LumaPlane> {
    return this.tileClient.fetchPlane(this.info(), z, this.surfaceChannel, maxGrid);
  }

  /** The channel state driving the surface: the chosen band for multichannel (matched by index),
   *  else the single grayscale channel. */
  private surfaceState(channels: IChannelState[]): IChannelState | undefined {
    if (this.surfaceChannel == null) return channels[0];
    return channels.find((s) => s.index === this.surfaceChannel) ?? channels[0];
  }

  /**
   * (Re)build the surface mesh for slice `z` from the pre-loaded plane cache (instant — this is
   * what the stack slider calls); a slice missing from the cache is fetched on demand. napari-js's
   * pure `heightField` builds the triangle grid (z = normalized intensity), then `addSurface`
   * renders it. The slice plane also feeds the intensity histogram (key 0).
   */
  private async buildSurface(viewer: Viewer, z: number): Promise<void> {
    let plane = this.surfacePlanes.get(z);
    if (!plane) {
      this.stackLoading$.next(true);
      try {
        plane = await this.fetchSurfacePlane(z, this.surfaceMaxGrid);
        this.surfacePlanes.set(z, plane);
      } catch (err) {
        console.error('[napari-js] surface slice fetch failed:', err);
      } finally {
        this.stackLoading$.next(false);
      }
    }
    if (!plane || plane.width < 2 || plane.height < 2 || this.viewer !== viewer) return;

    const st = this.surfaceState(this.store.currentChannelStates());
    const win: [number, number] = [st?.min ?? 0, st?.max ?? 255];
    this.surfaceWindow = win;
    // Height AND colour are normalized by the same contrast window, so changing min/max reshapes the
    // surface (a pixel's height = its intensity within [min,max]). Center it for the axes gizmo. The
    // plane is already decimated to the grid cap → stride 1.
    const zScale = SURFACE_Z_ASPECT * Math.max(plane.width, plane.height);
    const { vertices, faces, values } = heightField(plane.data, plane.width, plane.height, {
      zScale,
      zLimits: win,
      center: true,
    });

    // A re-slice / window rebuild keeps the orbit camera: the viewer's `fit3d: 'once'` frames only
    // the scene's first 3D add, so stepping the stack or changing the window keeps the pose.
    if (this.surfaceLayer) {
      viewer.layers.remove(this.surfaceLayer);
      this.surfaceLayer = null;
    }
    this.surfaceLayer = viewer.addSurface(vertices, faces, values, {
      colormap: this.display.volumeColormap(st),
      contrastLimits: win,
      gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
      wireframe: this.surfaceWireframe,
    });

    this.imageW = plane.width;
    this.imageH = plane.height;
    this.volumeDims = { width: plane.width, height: plane.height, depth: Math.max(1, Math.round(zScale)) };
    // Reuse the volume intensity-histogram path: the slice's scalar plane is the histogram source.
    this.volumeChannelData.clear();
    this.volumeChannelData.set(0, plane.data);
    this.tools.scheduleReadback();
  }

  /** Subscribe the store colormap / reverse / invert / channel window → the surface, so histogram
   *  & channel-dialog edits update it live without a re-fetch. **min/max reshapes the surface's
   *  height** (a pixel's height = its intensity within [min,max]), so a window change rebuilds the
   *  mesh geometry (from the cached slice); colour-only edits (colormap/LUT, gamma, reverse, invert)
   *  just update the layer's uniforms. */
  private subscribeSurfaceDisplayState(): void {
    this.watchDisplayState((channels, selected) => {
      const layer = this.surfaceLayer;
      if (!layer || !this.viewer) return;
      // Selected channel changed (multichannel): re-fetch THAT band's planes and
      // rebuild the height-field for the current slice.
      if (this.surfaceMultichannel && selected !== this.surfaceChannel) {
        this.surfaceChannel = selected;
        void (async () => {
          await this.preloadSurfacePlanes(this.viewer!);
          if (this.viewer) await this.buildSurface(this.viewer, this.loaded?.z ?? 0);
        })().catch((err) => console.error('[napari-js] surface channel switch failed:', err));
        return;
      }
      const st = this.surfaceState(channels);
      const win: [number, number] = [st?.min ?? 0, st?.max ?? 255];
      const windowChanged =
        !this.surfaceWindow || win[0] !== this.surfaceWindow[0] || win[1] !== this.surfaceWindow[1];
      if (windowChanged) {
        // Height follows the contrast window → rebuild the mesh for the new [min,max] (camera kept).
        void this.buildSurface(this.viewer, this.loaded?.z ?? 0).catch((err) =>
          console.error('[napari-js] surface window rebuild failed:', err),
        );
        return;
      }
      // Colour-only change: update uniforms in place, no geometry rebuild.
      layer.colormap = this.display.volumeColormap(st);
      if (st) {
        layer.contrastLimits = win;
        layer.gamma = toNapariGamma(st.gamma); // ImageJ γ → napari-js γ
      }
      this.viewer.requestRender();
    });
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
    // End the previous scene: its frame loading, descriptor poll, tile counts and awaits.
    this.loading.abort();
    this.loading = new AbortController();
    this.scene.abort();
    this.scene = new AbortController();
    this.displaySub?.unsubscribe();
    this.displaySub = null;
    this.scaleBar?.destroy();
    this.scaleBar = null;
    this.navigator?.destroy();
    this.navigator = null;
    this.setNavigatorChannels(null);
    this.badge.reset();
    this.tools.teardown();
    this.axesLabels?.destroy();
    this.axesLabels = null;
    this.zHandle?.destroy();
    this.zHandle = null;
    this.volumeWorldBase = null;
    this.tileClient.startScene(this.scene.signal);
    this.tiled = false;
    this.histGen++;
    this.histSamples.clear();
    this.channelView = null;
    this.spatialTilesMgr?.detach();
    this.viewer?.dispose();
    this.viewer = null;
    if (this.canvas && this.host?.contains(this.canvas)) this.host.removeChild(this.canvas);
    this.canvas = null;
    this.volumeView = null;
    this.volumeMultichannel = false;
    this.surfaceLayer = null;
    this.surfaceChannel = undefined;
    this.surfacePreload?.abort();
    this.surfacePlanes.clear();
    this.surfaceWindow = null;
    this.scatterRegionSub?.unsubscribe();
    this.scatterRegionSub = null;
    this.spatialSub?.unsubscribe();
    this.spatialSub = null;
    this.removeSpatialHover();
    this.hoverSource = null;
    this.hoverSourceKey = null;
    this.spatialPoints = null;
    this.spatialLayerKey = null;
    this.spatialPoints3d = null;
    this.spatialLayerKey3d = null;
    this.spatialScalarKey3d = null;
    this.spatialVolume = null;
    this.spatialVolumeKey = null;
    // The gene maps' and density volumes' layers belonged to the disposed viewer, so their keys
    // must go with it: kept, the next viewer would see "already built" and never add them back.
    // The estimated FIELDS (geneMapField*, geneMapVolumeField*) are viewer-independent and stay
    // cached, so a re-plot recolours instead of re-estimating.
    this.geneMapLayer = null;
    this.geneMapKey = null;
    this.geneMapVolumeLayer = null;
    this.geneMapVolumeKey = null;
    this.densityLayers = [];
    this.densityKey = null;
    this.spatialOrigin3d = [0, 0, 0];
    this.spatialScaleBarKey = null;
    // Drop the cached interleaved coordinates too: holding 3.7M x 3 floats after
    // a teardown is ~45MB of retained heap for a scene that no longer exists.
    this.spatialPositions3d = null;
    // Invalidate any colour fetch still in flight so it can't attach to the next scene.
    this.spatialRebuildToken++;
    this.scatter2dPoints = null;
    this.scatter3dLayer = null;
    this.axesLayer = null;
    this.volumeDims = null;
    this.volumeChannelData.clear();
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
    this.imageSmoothing = enabled;
    // Apply live to the rendered image layers; baked into the next render too.
    this.channelView?.setInterpolation(enabled ? 'linear' : 'nearest');
  }

  setShowStack(_showstack: boolean): void {
    /* stack navigated via setZIndex */
  }

  setZIndex(zIndex: number): void {
    if (this.loaded) this.loaded.z = zIndex;
    const v = this.viewer;
    if (!v) return;
    if (this.navigator) void this.refreshNavigatorImage(zIndex);
    // Dispatch on WHAT IS MOUNTED, not on which layer handle happens to be non-null: a surface
    // still preloading (or whose first build failed) has no layer yet, and a 3D scatter or cloud
    // has none of them — and both used to fall through to the 2D render below.
    switch (this.mounted) {
      case 'surface':
        // One slice → one mesh: re-build the height field for the new slice. Not built yet →
        // nothing to do; the build at the end of the mount reads `loaded.z`.
        if (this.surfaceLayer) {
          void this.buildSurface(v, zIndex).catch((err) =>
            console.error('[napari-js] setZIndex surface failed:', err),
          );
        }
        return;
      case 'volume':
        // Volume / isosurface: step the volume's z plane in place.
        v.dims.z = zIndex;
        this.tools.scheduleReadback();
        return;
      case 'scatter3d':
      case 'spatial3d':
      case null:
        // The whole stack (or the observations' own z) is already on screen: no plane to step.
        return;
      case 'image2d':
        break;
    }
    // Tiled 2D image: just move the dims plane — the tiled visual fetches the new slice's tiles
    // (cached per z), no layer rebuild. Refresh the coarse histogram sample for the new slice.
    if (this.tiled) {
      v.dims.z = zIndex;
      const desc = this.currentDescriptor();
      if (desc) void this.refreshHistogramSamples(zIndex, desc);
      this.redrawSpatialMarkers();
      this.tools.scheduleReadback();
      return;
    }
    // 2D image (stitch fallback): re-render the slice (re-fetches per-channel / composite).
    // The token lets renderImage drop a superseded scrub so a slow older slice can't clobber a newer one.
    const req = ++this.sliceReq;
    void this.renderImage(zIndex, req)
      .then(() => {
        if (req !== this.sliceReq) return;
        // AFTER the image, never before: the render clears the layer list, so
        // markers drawn first are wiped by the very image meant to sit under them.
        // Over a volume-backed dataset the plane also decides which observations
        // are drawn at all, so this is what moves the cells with the section.
        this.redrawSpatialMarkers();
        // The region-centroid scatter went with the same clear.
        if (this.scatter2dPoints) this.rebuildScatterPoints();
        this.tools.scheduleReadback();
      })
      .catch((err) => console.error('[napari-js] setZIndex slice failed:', err));
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
    const m = mode === 'pan' ? 'pan' : mode === 'zoom' ? 'zoom' : 'rotate'; // orbit/turntable → rotate
    this.viewer.setCameraDragMode(m);
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
    return this.resolutionScale;
  }

  /** Set the decimate factor for the napari 3D types. Takes effect on the next (re)load — the host
   *  re-plots after calling this, since decimation changes the fetched/assembled data. */
  setResolutionScale(scale: number): void {
    this.resolutionScale = Math.max(1, Math.round(scale));
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
    if (!this.volumeView) return null;
    return {
      setIsoRange: (isoMin: number, isoMax: number): void => {
        // Apply to every channel's volume layer.
        for (const layer of this.volumeView?.layers ?? []) {
          layer.contrastLimits = [isoMin, isoMax];
          layer.rendering = 'iso';
          layer.isoThreshold = 0.5;
        }
        this.viewer?.requestRender();
      },
    };
  }
  getIntensityControls(): IIntensityControls | null {
    return null;
  }
  getSurface3dControls(): ISurface3dControls | null {
    if (!this.volumeView && !this.surfaceLayer && !this.scatter3dLayer) return null;
    return {
      setSurfaceDragMode: (mode: string): void => this.setSurfaceDragMode(mode),
      resetSurfaceCamera: (): void => this.resetSurfaceCamera(),
      setAxesVisible: (visible: boolean): void => {
        this.axesVisible = visible;
        this.axesLabels?.setVisible(visible);
        if (this.axesLayer) {
          this.axesLayer.visible = visible;
          this.viewer?.requestRender();
        }
      },
      axesVisible: (): boolean => this.axesVisible,
      // Surface wireframe (napari-js surface only) — a live layer property, no rebuild needed.
      setWireframe: (on: boolean): void => {
        this.surfaceWireframe = on;
        if (this.surfaceLayer) {
          this.surfaceLayer.wireframe = on;
          this.viewer?.requestRender();
        }
      },
      wireframe: (): boolean => this.surfaceWireframe,
    };
  }
  getHistogram(channelIndex: number, bins: number): IHistogram | null {
    const v = this.viewer;
    if (!v) return null;
    // Volume / isosurface: intensity histogram of the assembled (downsampled) uint8 volume for the
    // requested channel (multichannel) or the single grayscale volume (key 0).
    if (this.volumeChannelData.size) {
      const data = this.volumeChannelData.get(channelIndex) ?? this.volumeChannelData.get(0);
      return data ? toIHistogram(histogramScalar(data, bins, 0, 255)) : null;
    }
    // Tiled mode has no full in-memory pixels → use the coarse per-channel sample (RGB: readback).
    if (this.tiled) {
      if (this.imageMode === 'rgb') return this.tools.rgbHistogram(channelIndex, bins);
      const sample = this.histSamples.get(this.imageMode === 'grayscale' ? 0 : channelIndex);
      return sample ? toIHistogram(histogramScalar(sample, bins, 0, 255)) : null;
    }
    // Grayscale/multichannel (stitch): native per-channel histogram straight from the in-memory
    // scalar layer (no GPU readback). RGB: bin the displayed pixels' R/G/B byte (8-bit client path).
    const layer = this.channelView?.layers[this.imageMode === 'grayscale' ? 0 : channelIndex];
    if (layer) {
      const h = v.layerHistogram(layer, bins);
      if (h) return toIHistogram(h);
    }
    if (this.imageMode === 'rgb') return this.tools.rgbHistogram(channelIndex, bins);
    return null;
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

