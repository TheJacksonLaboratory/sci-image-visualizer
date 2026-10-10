import { Injectable, Inject, Optional } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, Observable, Subject, Subscription, combineLatest, defer, firstValueFrom, of } from 'rxjs';
import { startWith, timeout } from 'rxjs/operators';
import { Image } from 'image-js';
import * as OpenSeadragon from 'openseadragon';
import { OSD, quiet } from './osd-lib';
import { ZOOM_BUTTON_STEP } from './osd-zoom';
import { buildViewerOptions, silenceOsdMultiImageAdvisory } from './openseadragon-viewer-options';


import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { IImageInfo } from '../../contracts/image.contract';
import { TileAccessPort, TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { VizConfig, VIZ_CONFIG } from '../../contracts/viz-config';
import { PlotType, PLOT_TYPE_DESCRIPTORS, PlotTypeDescriptor } from '../../contracts/plot-type';
import { IViewerBackend, PixelData, IntensityProfile, IIsosurfaceControls, IIntensityControls, ISurface3dControls } from '../../contracts/visualizer.contract';
import { ViewerCapabilities, ViewerFeature, capabilitiesOf } from '../../contracts/capabilities.contract';
import { OsdRegionOverlay } from './osd-region-overlay';
import { OsdScaleBar } from './osd-scale-bar';
import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';
import { OsdCoordinateTransform } from './osd-coordinate-transform';
import { PlotModeRect, PlotModeViewport } from '../../contracts/plot-type-contribution.contract';
import { elementToImage, imageRectToViewport, viewportRectToImage } from './osd-coords';
import { buildTileUrl, fetchTileBitmap, readRgba } from './tile-client';
import { SliceCache } from './slice-cache';
import { DisplayPipeline } from './display-pipeline';
import { HistogramSampler } from './histogram-sampler';
import {
  TileDescriptor, exportTiffFilename, exportTiffUrl, httpFetchJson, pollDescriptor, throwIfAborted,
  tilesInfoUrl,
} from '../tile-server';
import { BaseStoreVisualizer } from '../base-store-visualizer';
import { CanvasToolId } from '../../contracts/display-types';
import { SimpleSliceAccessService } from '../simple-slice-access.service';
import { CachedImageData, CanvasToolHost } from '../../toolbar/tool-kit/canvas-tool';
import { CanvasToolManager } from '../../toolbar/tool-kit/canvas-tool-manager';
import { createCanvasToolManager } from '../../toolbar/canvas-tools';
import { WandService } from '../../toolbar/wand/wand.service';
import { packedFrame } from '../../toolbar/tool-kit/frame-pixels';
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { ICellSegmenter, CELL_SEGMENTER } from '../../contracts/cell-segmenter.contract';
import { buildColormapLut, Rgb } from '../../contracts/colormap-lut';
import { IChannelState, IHistogram } from '../../contracts/channel-histogram-api.contract';
import { saveAs } from 'file-saver';

/** Wait between two `/tiles/info` polls while the server answers 202. */
const OSD_TILES_INFO_POLL_INTERVAL_MS = 1500;

/** The drag modes the SVG region overlay handles itself (see setDragMode). */
const OVERLAY_MODES = new Set<RegionToolMode>([
  'drawrect', 'drawclosedpath', 'drawopenpath', 'drawpolygon', 'addpoint', 'deletepoint', 'move', 'select',
]);

/** One decoded single-band channel plane (serverless multichannel). */
interface SimplePlane { data: Uint8ClampedArray; width: number; height: number; }

/** What `load()` hands to `plot()`. `load()` only computes it: the image on
 *  screen keeps its own state until `plot()` commits this payload. */
interface OsdLoaded {
  descriptor: TileDescriptor | null;
  infoB64: string;
  z: number;
  /** Mirrors the loaded image's filename — the diagram's render pipeline
   *  guards on `loaded.filename === phaseInfo.fileName` before calling plot(). */
  filename: string | undefined;
  /** Simple (non-tiled) image: `plot()` opens {@link url} directly via OSD's
   *  single-image source — no tile pyramid, no server. Set when the image
   *  carries `tiled === false` (see {@link IImageInfo.tiled}). */
  simple?: boolean;
  /** The directly-loadable image URL (`blob:`/`data:`/`http`) for simple mode. */
  url?: string;
  /** Serverless multichannel only: every slice's per-channel plane URLs, and
   *  the loaded slice's decoded planes ({@link url} is their composite). */
  channelUrls?: string[][];
  channelPlanes?: SimplePlane[];
}

/**
 * OpenSeadragon visualization backend.
 *
 * Renders the *image* plot type as a natively-tiled, zoomable raster, backed by
 * the jit-service tile endpoints (`GET /tiles/info` + `GET /tile`, which reuse
 * the Bio-Formats ROI renderer), or — for a `tiled: false` image — by
 * self-contained per-slice URLs. Plotly keeps the scientific/data plot types
 * (scalar heatmap, surface, contour, scatter, line, scatter3d, isosurface) —
 * hence this backend advertises only `ImageDisplay`.
 *
 * Display settings (window/gamma/colormap/invert, per-channel tints) are applied
 * client-side by recoloring tiles; regions are drawn by {@link OsdRegionOverlay}
 * and the canvas tools read back the rendered viewport. The collaborators
 * (slice cache, display pipeline, histogram sampler, tile client) and the
 * recolor invariant are described in this folder's README.
 */
@Injectable({ providedIn: 'root' })
export class OpenSeadragonVisualizerService extends BaseStoreVisualizer implements IViewerBackend {
  /** OSD's strength is displaying a large zoomable image — nothing else here. */
  readonly capabilities: ViewerCapabilities = capabilitiesOf([ViewerFeature.ImageDisplay]);

  private readonly api: string;
  private viewer: OpenSeadragon.Viewer | null = null;
  private overlay: IRegionOverlay | null = null;
  private scaleBar: OsdScaleBar | null = null;
  private descriptor: TileDescriptor | null = null;
  /** Base64 RawFileInfo + current z-slice, kept so setZIndex can rebuild the
   *  tile source and swap slices live (stack navigation). */
  private infoB64 = '';
  private currentZ = 0;
  /** True while the current image is "simple" (tiled:false — self-contained
   *  per-slice URLs, no tile server; e.g. a numbered image series assembled
   *  client-side into a stack). setZIndex swaps the single-image source for
   *  the new slice's URL instead of updating a tiled z-param. */
  private simpleMode = false;
  /** urls[] for the current simple-mode image, so setZIndex can look up the
   *  slice being scrubbed to (via {@link SimpleSliceAccessService.urlFor}).
   *  Unused (and left stale, harmlessly) in tiled mode. */
  private simpleUrls: string[] = [];
  /** preview blob URL → full-res upscaled blob URL (see toFullResUrl), so
   *  re-visiting a simple-mode slice doesn't re-upscale. Revoked on file change. */
  private readonly simpleFullResUrls = new Map<string, string>();
  /** SERVERLESS multichannel (tiled:false + channelCount>1): the stack's
   *  per-slice per-channel plane URLs, the current slice's decoded planes, and
   *  the last composite blob URL. Composited client-side via display.channelRgbLut
   *  (no tile server); kept OFF the tiled isMultiChannel path. */
  private simpleMultichannel = false;
  private simpleChannelUrls: string[][] = [];
  private simpleChannelPlanes: SimplePlane[] = [];
  private simpleCompositeUrl: string | null = null;
  /** Skip the full-res upscale above this longest-side dimension — a folder
   *  stack is per-file previews (well under this); this only guards against an
   *  accidental enormous canvas allocation. */
  private readonly SIMPLE_UPSCALE_MAX_DIM = 8192;
  private coordTransform: OsdCoordinateTransform | null = null;
  /** What this backend's canvas tools read and write (one host for every tool). */
  private readonly toolHost: CanvasToolHost;
  /** This backend's own wand, brush, eraser, zoom-to-box and SAM point tools. */
  protected readonly canvasTools: CanvasToolManager;
  /** Wand sampling matrix read back from the rendered viewport; cached until
   *  the viewport changes (see readbackViewport). */
  private viewportPixels: CachedImageData | null = null;
  /** The DOM id of the element OSD is mounted in (shared with Plotly); the
   *  on-canvas tools attach their overlays here. */
  private plotDiv = '';
  /** Current file name, tagged onto wand-created shapes. */
  private currentFileName: string | undefined;
  /** 256-entry RGB LUT for the active colormap, applied to grayscale tiles via
   *  the tile-invalidated pixel pipeline (mirrors Plotly's heatmap colorscale).
   *  Null while options resolve; recoloring is skipped until it's built. */
  private colorLut: Rgb[] | null = null;
  /** Only grayscale images get a colormap (RGB tiles pass through untouched). */
  private isGrayscaleImage = false;
  private colormapSub: Subscription | null = null;
  /** Bumped by every display invalidation. A recolor round captures it and, after
   *  each `await`, abandons the tile once a newer round has started. Writing a
   *  superseded context back is not merely wasted work: OSD's conversion sees a
   *  canvas the newer round already replaced, throws `DOMException`, and
   *  `_handleConversionError` DESTROYS the cache record and unloads the tile
   *  (unlike the drawer's rasterBlob path, it does not re-prepare). Enough of
   *  those and the viewer goes white mid-drag. */
  private displayToken = 0;
  /** Pending coalesced invalidation (see {@link scheduleInvalidate}). */
  private invalidateHandle: number | null = null;
  /** Latest per-channel display state (window/gamma/visibility) from the store,
   *  read synchronously by recolorTile. Channel 0 drives grayscale windowing;
   *  R/G/B (indices 0-2) drive RGB per-channel windowing. */
  private channelStates: IChannelState[] = [];
  /** True for multichannel fluorescence (channelCount > 1, not RGB): tiles are
   *  composited client-side from per-channel single-band fetches (see
   *  recolorMultiChannelTile) rather than recolored in place. */
  private isMultiChannel = false;
  /** Count of real Bio-Formats resolution levels (per-channel tiles exist only
   *  here). For multichannel images the tile source is built from these alone so
   *  every displayed tile supports a per-channel fetch. */
  private realLevels = 0;
  /** Inverted background (white = zero): inverts the display value before the
   *  LUT (grayscale) / per channel (RGB). */
  private invertBg = false;
  /** Bearer token for OSD's own tile fetches (HttpClient calls get it via the
   *  interceptor; OSD's loader does not, so we pass it as an ajax header). */
  private authHeaders: Record<string, string> = {};
  /** Whether the overview navigator (minimap) is shown. Read at viewer creation;
   *  a consumer that doesn't want it (e.g. a small embedded preview) sets it off
   *  via {@link setNavigatorVisible} before the first render. */
  private navigatorVisible = true;
  /** Image smoothing (bilinear). `false` → nearest-neighbour, so zoomed-in pixels
   *  render as crisp blocks (pixel inspection). Defaults to `false` so the image
   *  opens showing raw pixels. Read at viewer creation; toggled via
   *  {@link setImageSmoothingEnabled}. */
  private smoothingEnabled = false;
  /** The host's docked toolbar (see nudgeToolbarRepaint): undefined until looked
   *  up for the current mount, null when there is none. */
  private toolbarDock: HTMLElement | null | undefined = undefined;
  private lastToolbarNudge = 0;
  private static readonly TOOLBAR_NUDGE_INTERVAL_MS = 100;

  /** Overall deadline for the /tiles/info poll loop. An uncached whole-slide
   *  image (e.g. .ndpi) is cached server-side first (GCS->PVC), which can take
   *  several minutes — we poll (short requests; the cache-progress overlay
   *  shows the wait) until it's ready. Generous because each poll is cheap; on
   *  expiry the render pipeline gives up and the router falls back to Plotly.
   *  (napari-js waits less — it falls back to a single tile, not a backend.) */
  private readonly tilesInfoTimeoutMs = 600000; // 10 min

  /** Per-channel fit-view tile budget (tiles at the coarsest real level × channels).
   *  Above it, a multichannel image renders server-composited instead of per-channel
   *  — its full-res reads (it has no overview pyramid) would be too many × N channels.
   *  64 (e.g. a 4x4 single-FOV z-stack × 4ch) stays per-channel; a whole-slide
   *  (hundreds–thousands) falls back. */
  private readonly MAX_MULTICHANNEL_FIT_TILES = 256;

  /** Pixel display pipeline (window/gamma/invert/colormap + additive tint) —
   *  shared by tile recoloring and the composite export so they stay identical
   *  (see DisplayPipeline). Host closures read the service's live fields. */
  private readonly display = new DisplayPipeline({
    isGrayscale: () => this.isGrayscaleImage,
    colorLut: () => this.colorLut,
    channelStates: () => this.channelStates,
    invertBg: () => this.invertBg,
  });

  /** Histogram + auto-window sampling (see HistogramSampler). Constructed in
   *  the ctor body because it captures the resolved API base URL. */
  private sampler!: HistogramSampler;

  /** Stack-slice cache + background preloader (see SliceCache — refactoring
   *  plan Step 3). The host accessors are live closures, so the cache always
   *  reads the service's current viewer/descriptor/z — exactly the fields the
   *  moved code used to read directly. */
  private readonly cache = new SliceCache({
    viewer: () => this.viewer,
    hasImage: () => !!(this.viewer && this.descriptor && this.infoB64),
    sliceCount: () => this.descriptor?.z ?? 1,
    currentZ: () => this.currentZ,
    isMultiChannel: () => this.isMultiChannel,
    channelCount: () => Math.max(1, this.channelStates.length || (this.descriptor?.channels ?? 1)),
    channelVisible: (c: number) => this.channelStates[c]?.visible !== false,
    buildTileSource: (z: number, channel?: number) =>
      this.buildTileSource(this.descriptor!, this.infoB64, z, channel),
    onCompositeSliceAdded: (z: number) => this.sampler.computeImageWindow(this.descriptor!, this.infoB64, z),
  });

  constructor(
    private http: HttpClient,
    @Inject(TILE_ACCESS_PORT) private tiles: TileAccessPort,
    wandService: WandService,
    private samTool: SamToolService,
    private samPointTool: SamPointToolService,
    private cellSegmentTool: CellSegmentToolService,
    @Optional() @Inject(CELL_SEGMENTER) private cellSegmenter: ICellSegmenter | null,
    store: VisualizerStore,
    regionStore: RegionStore,
    private simpleStack: SimpleSliceAccessService,
    @Inject(VIZ_CONFIG) config: VizConfig,
  ) {
    super(regionStore, store);
    // The canvas tools run over OSD through the shared coordinate transform and a
    // viewport readback, and read/write the shared RegionStore. This backend owns
    // its own tool instances (RT-21); the host reads live state, so it is built once.
    this.toolHost = {
      getRegions: () => this.regionStore.getRegions(),
      setRegions: (regions) => this.regionStore.setRegions(regions),
      getCachedImageData: () => this.readbackViewport(),
      getActiveFrameIndex: () => this.currentZ,
      getOverlayContainer: () => this.getOverlayContainer(),
      getCoordinateTransform: () => this.coordTransform as ICoordinateTransform,
      getFileName: () => this.currentFileName,
      getShapeColor: () => this.regionStore.getShapeColor(),
      // Zoom-to-box: overlay pixels -> image coords, and fit the viewport to the box.
      pixelToData: (px, py) => elementToImage(this.viewer, px, py),
      applyZoomToBox: (coords) => this.applyZoomToBox(coords),
    };
    this.canvasTools = createCanvasToolManager(this.toolHost, {
      wandService, regionStore, samPoint: samPointTool,
    });
    this.api = config.slideCropServer;
    this.sampler = new HistogramSampler(this.http, this.api, {
      realLevels: () => this.realLevels,
      channelCount: (d) => this.channelStates.length || (d.channels ?? 1),
      isGrayscale: () => this.isGrayscaleImage,
      // Nudge the channel-states stream so the pane re-reads getHistogram now,
      // in case its bounded retry window already lapsed.
      onChannelHistogramsSampled: () => this.store.setChannelStates(this.store.currentChannelStates()),
      // Background-preloaded slices are sampled too (histograms per slice), but
      // only the displayed slice's window may seed or re-invalidate the display.
      onGrayWindowSampled: (min, max, z) => {
        if (z === this.currentZ) this.seedGrayWindow(min, max);
      },
    });
    this.ensureColormapSubscription();
  }

  private readonly stackLoading$ = new BehaviorSubject<boolean>(false);
  /** Visible image region (full-image pixel coords) emitted when the view
   *  settles, so the intensity inset can re-sample at the current zoom level. */
  private readonly viewportChange$ = new Subject<{ x: number; y: number; width: number; height: number }>();
  /** The visible rect on every redraw, coalesced to one emission per animation
   *  frame. Feeds {@link PlotModeViewport.frame$}. */
  private readonly frame$ = new Subject<PlotModeRect>();
  private frameRaf: number | null = null;
  private plotModeViewport: PlotModeViewport | null = null;
  // Region state (regions, selection, the update event) lives in the shared
  // RegionStore; image metadata and classification colours in the shared
  // VisualizerStore — the inherited IRegionStore/display methods delegate there.

  /**
   * Subscribe to the shared VisualizerStore colormap/reverse so OSD recolors in
   * lock-step with Plotly. Idempotent and self-healing: this service is a root
   * singleton, but `unsubscribe()` (called on VisualizerComponent destroy)
   * tears the subscription down — and the constructor never runs again. So
   * `plot()` calls this to re-establish it after a component teardown/recreate
   * (e.g. switching images), otherwise colormap changes would be silently
   * dropped on every image after the first switch.
   */
  private ensureColormapSubscription(): void {
    if (this.colormapSub) return;
    // Colormap/reverse + per-channel window/gamma/visibility + invert all live in
    // the shared VisualizerStore. Rebuild the LUT and re-run the pixel pipeline
    // whenever any of them changes, so the Channels & Histogram pane updates the
    // image live and OSD stays in lock-step with Plotly.
    this.colormapSub = combineLatest([
      this.store.getColormap(),
      this.store.getReverseScale(),
      this.store.getChannelStates(),
      this.store.getInvert(),
    ]).subscribe(([cm, rev, channels, invert]) => {
      this.colorLut = buildColormapLut(cm?.data?.value, !!rev);
      this.channelStates = channels;
      this.invertBg = !!invert;
      // Multichannel: each channel is its own TiledImage — visibility is the
      // image's opacity (window/gamma/colour are applied by recolorChannelTile
      // on the invalidate below). Re-applying the current slice's reveal picks up
      // the new per-channel visibility (cached slices stay hidden).
      if (this.isMultiChannel) {
        this.cache.revealChannelSlice(this.currentZ);
      }
      // requestInvalidate(true) restores each tile to its original data before
      // re-running recolorTile, so a change always maps afresh (no compounding).
      // RGB now recolors too (per-channel window/visibility), so don't gate on
      // grayscale. Coalesced: PrimeNG's slider fires (onChange) continuously, so
      // a single drag would otherwise queue dozens of overlapping restore +
      // re-process rounds over every channel image. (Serverless multichannel
      // re-composites from its cached planes instead — see invalidateDisplay.)
      this.scheduleInvalidate();
    });
  }

  /** Seed the Intensity channel with a measured auto-window while it's still
   *  at full range (never clobber the user's manual window); if the user
   *  already windowed, just re-invalidate so painted tiles pick the LUT up. */
  private seedGrayWindow(min: number, max: number): void {
    const ch0 = this.store.currentChannelStates()[0];
    if (ch0 && ch0.min === 0 && ch0.max === 255) {
      this.store.setChannelState(0, { min, max });
    } else if (this.viewer && this.colorLut) {
      // Coalesced (and visible-slice-only for multichannel) — not a raw
      // whole-world restore + re-recolor per sampled slice.
      this.scheduleInvalidate();
    }
  }

  // ── IDataRenderer ────────────────────────────────────────────────────

  /**
   * Fetch the tile-source descriptor for the selected file. The `info` param is
   * the base64 RawFileInfo the rest of the API uses; the GET goes through the
   * auth interceptor (Bearer). We also grab a token here for OSD's own tile
   * fetches (its loader bypasses HttpClient).
   *
   * `signal` (the host's render supersession) cancels the `/tiles/info` poll and
   * the simple-image fetches: the load then rejects with an `AbortError`.
   */
  async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<OsdLoaded> {
    throwIfAborted(signal);
    const filename = imageInfo?.fileName;
    // A different image was selected — stop the previous stack's background
    // loading immediately rather than letting it finish behind the new image.
    if (filename && this.currentFileName && filename !== this.currentFileName) {
      this.cache.cancelBackgroundLoad();
      this.revokeSimpleFullResUrls();
    }
    this.simpleStack.noteActiveFile(filename);
    // Simple (in-memory / non-tiled) image: skip the tile server entirely — no
    // getSelectedInfoB64, no /tiles/info poll. `urls[zIndex]` is a complete image
    // OSD opens via its single-image source (see plot()).
    if (this.simpleStack.isSimple(imageInfo)) {
      return this.loadSimple(imageInfo, zIndex, signal);
    }
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return { descriptor: null, infoB64: '', z: zIndex || 0, filename };

    try {
      this.authHeaders = await this.tiles.getAuthHeaders();
    } catch {
      this.authHeaders = {}; // fall back to cookie auth (ajaxWithCredentials)
    }
    throwIfAborted(signal);
    // Poll /tiles/info (the shared jit-service client): the backend returns 202
    // while the source file is still being cached (GCS->PVC) — it kicks the
    // download off in the background, so each request is short (no long-held
    // connection to trip ingress/proxy or client timeouts), and 200 with the
    // descriptor once it's ready. The cache-progress overlay shows progress
    // during the wait. Transport failures (a proxy hiccup, a slow metadata read
    // timing a request out) are retried until the deadline; a non-202 status
    // means this server won't describe the file.
    //
    // No descriptor (deadline, or a status other than 202) is a load failure, so
    // the router falls back to Plotly for this image, as before. Not committed to
    // `this.descriptor` here: the previous image stays mounted (and keeps using
    // its own descriptor) until plot().
    const descriptor = await pollDescriptor(httpFetchJson(this.http), tilesInfoUrl(this.api, infoB64), {
      deadlineMs: this.tilesInfoTimeoutMs,
      intervalMs: OSD_TILES_INFO_POLL_INTERVAL_MS,
      signal,
      tag: '[OSD]',
    });
    if (!descriptor) throw new Error('tiles/info gave no descriptor — file still caching or not tileable');
    return { descriptor, infoB64, z: zIndex || 0, filename };
  }

  /** Forget the simple (tiled:false) image's state: mode, slice URLs and the
   *  serverless-multichannel flag, URLs and decoded planes. Called when a tiled
   *  image is mounted and on teardown; plot() commits a simple image's state
   *  from its {@link OsdLoaded} payload. */
  private resetSimpleState(): void {
    this.simpleMode = false;
    this.simpleUrls = [];
    this.simpleMultichannel = false;
    this.simpleChannelUrls = [];
    this.simpleChannelPlanes = [];
  }

  /** Build the `plot()` payload for a simple (tiled:false) image: a single-level
   *  descriptor sized from `trueImageSize`, plus the directly-loadable URL —
   *  resolved and fetched via {@link SimpleSliceAccessService} (shared with
   *  napari-js; see its docs for why this can't be a raw `fetch()`/`<img>`).
   *  Those fetches take no signal, so an abort is honoured once they settle. */
  private async loadSimple(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<OsdLoaded> {
    const z = zIndex || 0;
    const filename = imageInfo?.fileName;
    this.authHeaders = {};
    const [width, height] = imageInfo.trueImageSize ?? [0, 0];
    const meta = imageInfo.imageMeta?.[0];
    // SERVERLESS MULTICHANNEL: composite the slice's per-channel planes
    // client-side (no tile server), driven by the channel pane. Kept OFF the
    // tiled isMultiChannel path (see compositeSimpleMultichannel).
    // Everything is computed into locals and returned: the image on screen keeps
    // its state until plot() commits this payload.
    const chUrls = imageInfo.channelUrls;
    const multichannel = !!chUrls?.length && (meta?.channelCount ?? 1) > 1;
    let url: string | undefined;
    let channelPlanes: SimplePlane[] | undefined;
    if (multichannel) {
      try {
        channelPlanes = await this.loadSimpleChannelPlanes(chUrls![z] ?? chUrls![0]);
        url = await this.compositeSimpleMultichannel(channelPlanes);
        // NB: histograms are binned in plot(), AFTER destroyViewer clears the
        // sampler — computing them here would be wiped by that clear.
      } catch (err) {
        console.warn('[OSD] simple multichannel composite failed', err);
      }
    } else {
      const rawUrl = this.simpleStack.urlFor(imageInfo, z);
      if (rawUrl) {
        try {
          const previewUrl = await this.simpleStack.fetchAsBlobUrl(rawUrl);
          // Upscale the (downscaled) preview to full resolution so OSD's world
          // matches the full-res ROI coordinate space — see toFullResUrl.
          url = await this.toFullResUrl(previewUrl, width, height);
        } catch (err) {
          console.warn('[OSD] simple-mode slice fetch failed', err);
        }
      }
    }
    throwIfAborted(signal);
    // No loadable URL (empty urls[] or the fetch failed): signal "couldn't
    // load" with a null descriptor — same as the tiled path when there's no
    // selected-file info — so plot() returns false (its `if (!d)` guard) and
    // the router can fall back, instead of mounting an <img> with an undefined
    // src that throws at runtime.
    if (!url) {
      console.warn('[OSD] simple-mode slice has no loadable URL; skipping OSD render', filename);
      return { descriptor: null, infoB64: '', z, filename };
    }
    const descriptor: TileDescriptor = {
      width,
      height,
      tileSize: 0,            // unused: simple mode never calls buildTileSource
      z: 1,                   // single frame
      channels: meta?.rgbChannels ?? (imageInfo.isGrayscale ? 1 : 3),
      multichannel: false,
      realLevels: 1,
      levels: [{ res: 0, width, height }],
      mppX: meta?.mppX ?? 0,
      mppY: meta?.mppY ?? 0,
    };
    return {
      descriptor,
      infoB64: '',
      z,
      filename,
      simple: true,
      url,
      ...(multichannel ? { channelUrls: chUrls as string[][], channelPlanes: channelPlanes ?? [] } : {}),
    };
  }

  /**
   * OSD's `{type:'image'}` source sizes its coordinate world to the image's
   * NATURAL pixels. A folder-stack slice is a server `/preview` whose pixel size
   * needn't match the full-resolution image — it may be downscaled (large
   * images) OR larger than the dimensions `/metadata` reports. Either way OSD's
   * world would differ from the full-res ROI coordinate space (QuPath geojson,
   * in level-0 pixels): a smaller preview renders ROIs oversized, a larger one
   * renders them undersized/offset. Resample the preview to EXACTLY the
   * full-resolution dimensions (blurry but positionally exact — scaling up or
   * down as needed) so OSD's world matches the ROI coordinate space, while still
   * using OSD's reliable single-image renderer. Cached per preview URL (revoked
   * on file change); a no-op when the preview is already exactly full-res (small
   * images, in-memory pipeline blobs), when the dims are unknown, or when
   * they're implausibly large (guards against an enormous canvas). (jit-ui#93)
   */
  private async toFullResUrl(previewUrl: string, width: number, height: number): Promise<string> {
    if (!width || !height || Math.max(width, height) > this.SIMPLE_UPSCALE_MAX_DIM) return previewUrl;
    const cached = this.simpleFullResUrls.get(previewUrl);
    if (cached) return cached;
    let img: HTMLImageElement;
    try {
      img = await this.loadImageEl(previewUrl);
    } catch {
      return previewUrl; // couldn't decode — let OSD try the URL as-is
    }
    // Already the exact full-res world — no resample needed. (A preview that is
    // larger OR smaller than full-res must still be resized so OSD's world ==
    // the ROI coordinate space; only an exact match is skippable.)
    if (img.naturalWidth === width && img.naturalHeight === height) return previewUrl;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return previewUrl;
    ctx.drawImage(img, 0, 0, width, height); // scale preview (up or down) to full-res
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
    if (!blob) return previewUrl;
    const fullResUrl = URL.createObjectURL(blob);
    this.simpleFullResUrls.set(previewUrl, fullResUrl);
    return fullResUrl;
  }

  /** Sample a SIMPLE-mode slice's own decoded pixels into the histogram — the
   *  serverless analog of the tiled samplers (no tile server). Fire-and-forget;
   *  a decode failure just leaves the pane empty rather than throwing. */
  private async sampleSimpleHistogram(url: string | undefined, z: number): Promise<void> {
    if (!url) return;
    try {
      const px = await this.decodeUrlToRgba(url);
      if (px) this.sampler.computeSimpleHistogram(z, px.data, this.isGrayscaleImage);
    } catch (err) {
      console.warn('[OSD] simple-mode histogram sample failed', err);
    }
  }

  /** Fetch + decode a slice's per-channel planes (single-band grayscale) into
   *  pixel buffers, for the SERVERLESS multichannel compositor. Auth-safe: goes
   *  through SimpleSliceAccessService (blob:/data: as-is; http via HttpClient).
   *  The channels are fetched in parallel; plane c stays at index c, and a
   *  plane that fails to load is empty (the compositor skips it). */
  private async loadSimpleChannelPlanes(urls: string[] | undefined): Promise<SimplePlane[]> {
    const empty = (): SimplePlane => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    return Promise.all((urls ?? []).map(async (u) => {
      try {
        const px = await this.decodeUrlToRgba(await this.simpleStack.fetchAsBlobUrl(u));
        return px ? { data: px.data, width: px.width, height: px.height } : empty();
      } catch (err) {
        console.warn('[OSD] channel plane decode failed', err);
        return empty();
      }
    }));
  }

  /** Composite per-channel planes into ONE RGBA image using the
   *  current channel states (colour/window/gamma/visibility) — the client-side,
   *  serverless analog of the tiled per-channel 'lighter' compositor
   *  (same display.channelRgbLut math as recolorChannelTile, applied per-plane).
   *  Returns a new blob: URL of the composite PNG, owned by the caller (see
   *  {@link openSimpleComposite}). */
  private async compositeSimpleMultichannel(planes: SimplePlane[]): Promise<string | undefined> {
    if (!planes.length) return undefined;
    const w = planes[0].width, h = planes[0].height;
    if (!w || !h) return undefined;
    const out = this.display.compositeChannels(
      planes.map((p) => (p.width === w && p.height === h ? p.data : null)),
      this.store.currentChannelStates(),
    );
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.putImageData(new ImageData(out, w, h), 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return undefined;
    return URL.createObjectURL(blob);
  }

  /** Re-composite the current slice from its cached planes (new channel states)
   *  and re-open — the serverless analog of the tiled invalidate-on-channel-change.
   *  Runs from {@link invalidateDisplay}, so it is coalesced per frame, and drops
   *  its composite once a newer display round (`token`) has started. */
  private async recompositeAndOpen(token: number): Promise<void> {
    const url = await this.compositeSimpleMultichannel(this.simpleChannelPlanes);
    if (!url) return;
    if (token !== this.displayToken || !this.viewer) {
      URL.revokeObjectURL(url); // superseded — never displayed
      return;
    }
    this.openSimpleComposite(url);
  }

  /** Open a serverless-multichannel composite and take ownership of its URL. The
   *  previously displayed composite is revoked only once this open settles: an
   *  `open()` still decoding a revoked blob: URL fails. */
  private openSimpleComposite(url: string): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const prev = this.simpleCompositeUrl;
    this.simpleCompositeUrl = url;
    if (prev && prev !== url) {
      const revokePrev = () => {
        viewer.removeHandler('open', revokePrev);
        viewer.removeHandler('open-failed', revokePrev);
        URL.revokeObjectURL(prev);
      };
      viewer.addHandler('open', revokePrev);
      viewer.addHandler('open-failed', revokePrev);
    }
    viewer.open({ type: 'image', url } as any);
  }

  /** Decode an image URL to RGBA pixels (null for an empty image or no 2d
   *  context). Throws when the URL can't be decoded. */
  private async decodeUrlToRgba(url: string): Promise<ImageData | null> {
    const img = await this.loadImageEl(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    return w && h ? readRgba(img, w, h) : null;
  }

  /** Load a URL into an HTMLImageElement (resolves once decoded). Uses
   *  document.createElement rather than `new Image()` because this file's
   *  `Image` import is image-js's decoder, not the DOM element. */
  private loadImageEl(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = document.createElement('img');
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = url;
    });
  }

  /** Commit a simple image's serverless-multichannel state from its
   *  {@link OsdLoaded} payload (cleared for any other image). */
  private commitSimpleMultichannel(loaded: OsdLoaded): void {
    this.simpleMultichannel = !!loaded.channelPlanes;
    this.simpleChannelUrls = loaded.channelUrls ?? [];
    this.simpleChannelPlanes = loaded.channelPlanes ?? [];
  }

  private revokeSimpleFullResUrls(): void {
    for (const u of this.simpleFullResUrls.values()) URL.revokeObjectURL(u);
    this.simpleFullResUrls.clear();
    if (this.simpleCompositeUrl) { URL.revokeObjectURL(this.simpleCompositeUrl); this.simpleCompositeUrl = null; }
  }

  /** Mount the viewer with a custom tile source pointing at `GET /tile`. */
  plot(
    plotDiv: string,
    imageLoaded: any,
    imageInfo: IImageInfo,
    _screenHeight: number,
    _plotType: PlotType,
    inPlace?: boolean,
  ): Promise<boolean> {
    const loaded = imageLoaded as OsdLoaded;
    const d = loaded?.descriptor;
    if (!d) return Promise.resolve(false);
    // Re-establish the colormap subscription if a prior component teardown
    // (unsubscribe()) tore it down — this service is a root singleton, so the
    // constructor won't run again to recreate it.
    this.ensureColormapSubscription();
    // A new image: a stroke or SAM prompt in progress belonged to the old one.
    if (!inPlace) this.canvasTools.resetAll();
    // OSD tiles natively, so the in-place (large) pass is normally a no-op
    // once mounted — the tile pyramid IS the full resolution regardless of
    // which ImageInfo tier requested it. Simple mode has no pyramid to fall
    // back on: it displays literally whatever URL was last opened, so
    // without this swap the small tier's 128px placeholder would stay on
    // screen forever (pixelated, never "sharpening" like the tiled path).
    if (inPlace && this.viewer) {
      if (loaded.simple && loaded.url) {
        // Also refresh simpleUrls to THIS phase's (large-tier) urls[] — it was
        // set from the small tier's 128px urls on the initial mount below,
        // which never runs again for the in-place pass. Without this,
        // setZIndex's later slider scrubs would keep reading the small
        // tier's low-res URLs forever, even though the initial slice was
        // correctly swapped to full resolution here.
        this.simpleUrls = imageInfo?.urls ?? this.simpleUrls;
        if (loaded.channelPlanes) {
          this.commitSimpleMultichannel(loaded);
          this.openSimpleComposite(loaded.url);
        } else {
          this.viewer.open({ type: 'image', url: loaded.url } as any);
        }
      }
      return Promise.resolve(true);
    }
    this.plotDiv = plotDiv;
    this.toolbarDock = undefined; // re-located for this mount (nudgeToolbarRepaint)
    this.currentFileName = imageInfo?.fileName;
    this.descriptor = d;
    this.infoB64 = loaded.infoB64;
    this.currentZ = loaded.z;
    this.simpleMode = !!loaded.simple;
    this.simpleUrls = loaded.simple ? (imageInfo?.urls ?? []) : [];
    this.commitSimpleMultichannel(loaded);
    // The descriptor's physical pixel size (server Bio-Formats `/tiles/info`) is
    // authoritative — push it into the shared meta so the Region Editor reports
    // areas in µm²/mm², matching the scale bar built from `d.mppX` below.
    this.store.setPhysicalPixelSize(d.mppX, d.mppY);
    // Use the SAME grayscale flag the colormap dropdown / Plotly use
    // (imageInfo.isGrayscale ← rgbChannels === 1). The descriptor's `channels`
    // (channelCount) diverges from rgbChannels for stacks, which left grayscale
    // stacks un-recolored even though the colormap selector was shown.
    this.isGrayscaleImage = !!imageInfo?.isGrayscale;
    // Simple (non-tiled, in-memory) image: no pyramid, no per-channel tiles, and
    // no server-side intensity sampling — OSD's single-image source decodes
    // urls[z] directly. Skip the whole tiled-setup path below.
    const simple = !!loaded.simple;
    if (simple) {
      this.realLevels = 1;
      this.isMultiChannel = false;
      this.cache.clearChannelGroups();
      this.destroyViewer();
      // The new viewer opens this image's composite (serverless multichannel):
      // the old viewer is gone, so its composite can go now.
      if (this.simpleCompositeUrl && this.simpleCompositeUrl !== loaded.url) {
        URL.revokeObjectURL(this.simpleCompositeUrl);
      }
      this.simpleCompositeUrl = this.simpleMultichannel ? (loaded.url ?? null) : null;
      // Serverless histogram — AFTER destroyViewer (its last act is sampler.clear()).
      // Multichannel bins each cached channel plane; single-band / RGB bins the
      // decoded frame's own pixels.
      if (this.simpleMultichannel) {
        this.sampler.computeSimpleMultichannelHistograms(loaded.z, this.simpleChannelPlanes);
      } else {
        void this.sampleSimpleHistogram(loaded.url, loaded.z);
      }
    } else {
      // A tiled image is going on screen: no simple-mode state may survive it
      // (load() normally cleared it already; plot() is what mounts the image).
      this.resetSimpleState();
      // Multichannel fluorescence (indexed/LUT-bearing stacks) composite client-side
      // from per-channel tiles. Trust the server's explicit `multichannel` flag — the
      // old `channels>1 && grayscale` heuristic also matched RGB photos Bio-Formats
      // reads as separated planes (channels>1, rgbChannels==1), splitting them into N
      // per-channel TiledImages that flooded the tile endpoint and hung on load.
      this.realLevels = d.realLevels ?? d.levels.length;
      // Tiles to cover the whole image at the coarsest REAL Bio-Formats level (the
      // smallest level that has real, per-channel-fetchable tiles — synthetic overview
      // levels are server-composited only). A pyramidal image's coarsest real level is
      // tiny (few tiles); a flat/no-pyramid image's is the full-res grid (many tiles).
      const coarse = d.levels[this.realLevels - 1] ?? d.levels[d.levels.length - 1];
      const coarseW = coarse ? Math.ceil(coarse.width / d.tileSize) : 1;
      const coarseH = coarse ? Math.ceil(coarse.height / d.tileSize) : 1;
      const coarseTiles = coarseW * coarseH;
      this.isMultiChannel = !!d.multichannel;
      if (this.isMultiChannel) {
        // Per-channel rendering can only use the REAL levels, so OSD requests the
        // coarsest real level's whole tile grid × N channels at fit. When that's large
        // (a whole-slide), it's too many (often slow, pyramid-less) full-res reads —
        // fall back to the single server-composited source (which keeps the fast
        // synthetic overviews). A small single-FOV z-stack stays per-channel. Size in
        // BYTES isn't the signal — tile count is.
        const fitTiles = coarseTiles * Math.max(1, d.channels ?? 1);
        if (fitTiles > this.MAX_MULTICHANNEL_FIT_TILES) {
          this.isMultiChannel = false;
          console.warn(
            '[OSD] multichannel composite too large for per-channel rendering: ' +
            `${coarseW}x${coarseH} tiles x ${d.channels} channels = ${fitTiles} at the coarsest ` +
            `real level (> ${this.MAX_MULTICHANNEL_FIT_TILES}); rendering server-composited for speed.`,
          );
        }
      }
      this.cache.clearChannelGroups();
      this.destroyViewer();
      // Auto-range grayscale tiles to the image's actual intensity span (like the
      // heatmap), sampling the coarsest tile level so the window matches the raw
      // tile values. Fire-and-forget: it re-invalidates once the window is known;
      // tiles paint unwindowed until then. (Multichannel windows are per-channel,
      // defaulting to full range; the user auto/edits each channel.) Started
      // AFTER destroyViewer: its sampler.clear() supersedes every run in flight.
      if (this.isMultiChannel) {
        void this.sampler.computeMultiChannelHistograms(d, loaded.infoB64, loaded.z);
      } else {
        void this.sampler.computeImageWindow(d, loaded.infoB64, loaded.z);
      }
      // Size the slice cache for this image: LRU cap to hold the whole stack
      // (capped) and skip background preloading for stacks too large to preload
      // (would flood full-res reads). Normal stacks keep the flicker-free pre-cache.
      this.cache.configure(d.z ?? 1, coarseTiles);
    }

    // Simple mode: OSD's single-image source decodes the URL (blob:/data:/http)
    // directly — no pyramid, no server. Tiled mode: the custom server-backed tile
    // source (multichannel opens on channel 0; the open handler then swaps in this
    // slice's per-channel group and the background loader pre-fills the rest).
    const tileSource = simple
      ? { type: 'image', url: loaded.url }
      : this.buildTileSource(d, loaded.infoB64, loaded.z, this.isMultiChannel ? 0 : undefined);
    silenceOsdMultiImageAdvisory();
    this.viewer = (OSD as any)(buildViewerOptions({
      id: plotDiv,
      navigatorVisible: this.navigatorVisible,
      smoothing: this.smoothingEnabled,
      authHeaders: this.authHeaders,
      sliceCount: d.z ?? 1,
      maxSlices: this.cache.maxSlices(),
    }));

    return new Promise<boolean>((resolve) => {
      // Always settle: if OSD never emits open/open-failed (a bad tile source,
      // a viewer torn down mid-open), the render pipeline must not hang — a hang
      // leaves imageLoading=true, sticking the spinner and the 500ms
      // cache-progress poll forever (NS_BINDING_ABORTED storm).
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      this.viewer!.addOnceHandler('open', () => {
        // Region overlay reads/writes the shared RegionStore, so regions stay
        // in sync with Plotly and the Region Editor. Recreate it per open() so
        // it binds to the freshly-opened viewer's canvas/MouseTracker.
        this.overlay?.destroy();
        this.overlay = new OsdRegionOverlay(this.viewer, this.regionStore);
        this.coordTransform = new OsdCoordinateTransform(this.viewer);
        this.scaleBar = new OsdScaleBar(this.viewer, d.mppX ?? 0);
        // Simple mode is a single, self-contained image — no slice cache to seed.
        // Its z-scrub and recomposite re-open the viewer; one persistent handler
        // reports a failed re-open (a once-handler per scrub would pile up).
        if (simple) {
          this.viewer!.addHandler('open-failed', (e: any) => {
            console.warn('[OSD] slice re-open failed', this.currentZ, e?.message ?? e);
          });
        } else if (this.isMultiChannel) {
          // Drop the single opened (channel-0) image and add this slice's channel
          // group to the per-slice cache. The shared background loader / LRU then
          // pre-fills the other slices' channel groups so z-scrub is flicker-free.
          quiet(() => {
            const it0 = this.viewer!.world?.getItemAt?.(0);
            if (it0) this.viewer!.world.removeItem(it0);
          });
          this.cache.addChannelSlice(this.currentZ);
        } else {
          // Seed the slice cache with the just-opened slice (world item 0), so
          // scrubbing back to it later is an instant opacity toggle, not a re-open.
          const firstItem = this.viewer!.world?.getItemAt?.(0);
          if (firstItem) this.cache.seedComposite(this.currentZ, firstItem);
        }
        // The wand samples the *rendered viewport*, so its pixel matrix is only
        // valid for the current view — drop it whenever the viewport changes.
        this.viewer!.addHandler('viewport-change', () => {
          this.viewportPixels = null;
        });
        // Grayscale tiles get the active colormap via the pixel pipeline. The
        // handler runs per tile on load (and on requestInvalidate); recoloring
        // is a no-op for RGB images or before the LUT resolves.
        // (isGrayscaleImage is set from imageInfo.isGrayscale in plot() above.)
        this.viewer!.addHandler('tile-invalidated', (event: any) => this.recolorTile(event));
        // The overview navigator is a separate mini-viewer with its own tiles,
        // so it doesn't receive the main viewer's tile-invalidated events. Apply
        // the same recolor pipeline to it so the minimap tracks the main image's
        // colormap/LUT instead of staying grayscale.
        const nav = this.viewer!.navigator;
        nav?.addHandler('tile-invalidated', (event: any) => this.recolorTile(event));
        if ((this.isGrayscaleImage && this.colorLut) || this.isMultiChannel) this.invalidateWorld();
        // Prefetch adjacent z-slices once the view settles (and on each settle,
        // so it tracks the current viewport as the user pans/zooms). Simple mode
        // has a single frame, so there's nothing to prefetch.
        if (!simple) this.viewer!.addHandler('animation-finish', () => this.cache.schedulePrefetch());
        // Tell listeners (the intensity inset) the visible image region whenever
        // the view settles, so they can re-sample at the current zoom resolution.
        this.viewer!.addHandler('animation-finish', () => this.emitViewportChange());
        // Every redraw (pan/zoom animation frames, resize) — for a contributed
        // plot mode's overlay, which has to move with the image, not after it.
        this.viewer!.addHandler('update-viewport', () => this.scheduleFrame());
        // Chrome compositor bug: after an OSD zoom the docked toolbar (a sibling of
        // #plot in the <visualizer> host) is left laid-out-but-unpainted and
        // vanishes — confirmed via DevTools (DOM intact, region simply not painted).
        // CSS (z-index / isolation / contain) and DOM-reparenting don't fix it; a
        // repaint reliably does. Nudge it during the animation (throttled — each
        // nudge forces a layout) and on settle. The synchronous display toggle
        // re-rasters with no visible gone-frame and no layout shift.
        this.viewer!.addHandler('animation', () => this.nudgeToolbarRepaint(true));
        this.viewer!.addHandler('animation-finish', () => this.nudgeToolbarRepaint());
        if (!simple) this.cache.schedulePrefetch();
        // Force fit-to-view as the split/flex layout settles. A tall
        // non-pyramidal image can otherwise open zoomed-in (image width filling
        // the viewer), making OSD demand slow full-res res=0 tiles for the
        // centre instead of the fast coarse overview → white canvas. goHome
        // fits the whole image so OSD selects the coarse synthetic level. Retry
        // across a few frames because the container may not have its final size
        // on the first frame after 'open'.
        const refit = () => quiet(() => {
          this.viewer?.viewport.goHome(true);
          // The navigator was sized in the Viewer constructor — BEFORE the
          // layout settled — so its element can carry a stale (even
          // wrong-aspect) size that floats the visible minimap above the
          // corner. Re-size it from the settled container.
          this.resizeNavigator();
        });
        requestAnimationFrame(refit);
        setTimeout(refit, 150);
        setTimeout(refit, 400);
        // The timed retries above miss the case where the container is STILL
        // zero-size at 400ms — which happens when the render starts while the
        // file viewer is mid-switch from the folder view to the diagram (e.g.
        // "Load as Stack" from a folder, with no image open first). Because
        // preserveViewport suppresses OSD's own open-time fit, the image would
        // then be left un-fitted at the top-left ("a tile"). A one-shot
        // ResizeObserver fits the instant the container first has a real size,
        // regardless of when the render began (jit-ui#106).
        this.fitWhenContainerSized(document.getElementById(plotDiv), refit);
        // Keep the navigator sized to the container as the panel resizes.
        this.viewer!.addHandler('resize', () => this.resizeNavigator());
        done(true);
      });
      this.viewer!.addOnceHandler('open-failed', (e: any) => {
        console.warn('[OSD] open-failed', e?.message ?? e);
        done(false);
      });
      setTimeout(() => {
        if (!settled) console.warn('[OSD] viewer open timed out');
        done(false);
      }, 8000);
      this.viewer!.open(tileSource as any);
    });
  }

  /**
   * Fit-to-home once `el` first has a non-zero size. If it's already sized we
   * rely on the timed refits the caller scheduled; otherwise a one-shot
   * ResizeObserver runs `refit` the moment the container is laid out (then
   * disconnects), so the initial fit doesn't depend on the render's start time
   * relative to the diagram container's layout. No-op without a container or
   * ResizeObserver (the timed refits remain the fallback). One-shot + only
   * attached on a fresh mount, so slice-scrub re-opens keep the user's zoom.
   */
  private fitWhenContainerSized(el: HTMLElement | null, refit: () => void): void {
    if (!el || typeof ResizeObserver === 'undefined') return;
    if (el.clientWidth > 0 && el.clientHeight > 0) return; // already sized — timed refits suffice
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        ro.disconnect();
        refit();
      }
    });
    ro.observe(el);
    // Safety net: stop observing even if it never gains a size.
    setTimeout(() => ro.disconnect(), 5000);
  }

  /**
   * Custom tile source built from the descriptor. OSD numbers levels
   * coarsest-first; the backend numbers resolutions full-res-first, so
   * `res = (levels-1) - osdLevel`. Overriding getLevelScale/getNumTiles lets us
   * honour Bio-Formats' actual per-level dimensions (not assume power-of-two).
   */
  private buildTileSource(d: TileDescriptor, infoB64: string, z: number, channel?: number): any {
    // Multichannel images composite from per-channel tiles, which only exist at
    // real Bio-Formats resolutions — so drive OSD off the real levels alone and
    // skip the synthetic (server-composited) overviews. Every displayed tile is
    // then per-channel-fetchable at any zoom.
    const levels = this.isMultiChannel ? d.levels.slice(0, this.realLevels) : d.levels;
    const n = levels.length;
    const t = d.tileSize;
    const base = this.api;

    // OSD level i (0 = coarsest) <-> backend resolution (n-1-i) (res 0 = full).
    // The backend pyramid is NOT necessarily power-of-two, so we drive OSD off
    // the backend's real per-level dimensions. We override ONLY getLevelScale:
    // OSD derives getNumTiles, getTileBounds AND its per-zoom level selection
    // from getLevelScale, so they all stay consistent — requesting exactly the
    // tiles each resolution actually has (no out-of-range 400s, no flood).
    const resForLevel = (level: number) => n - 1 - level;
    const ts: any = new (OSD as any).TileSource({
      width: d.width,
      height: d.height,
      tileSize: t,
      tileOverlap: 0,
      minLevel: 0,
      maxLevel: n - 1,
    });
    ts.getLevelScale = (level: number) => {
      const lvl = levels[resForLevel(level)];
      return lvl ? lvl.width / d.width : 1;
    };
    // Drive the tile COUNT off each level's own (independently-rounded) dimensions,
    // not OSD's default `ceil(scale * fullDimension / tileSize)`. Synthetic AND real
    // Bio-Formats levels aren't exact proportional scales of the full image, so
    // `scale * fullHeight` can round up to one more row (or column) than the level
    // actually has — OSD then requests an out-of-range tile that the server 400s
    // ("Tile (col,row) out of range"). Using the level's real w/h matches the
    // server's own bounds check exactly.
    const Point = (OSD as any).Point;
    ts.getNumTiles = (level: number) => {
      const lvl = levels[resForLevel(level)];
      if (!lvl) return new Point(0, 0);
      return new Point(Math.ceil(lvl.width / t), Math.ceil(lvl.height / t));
    };
    ts.getTileUrl = (level: number, x: number, y: number) =>
      buildTileUrl(base, infoB64, { res: resForLevel(level), col: x, row: y, z, tileSize: t, channel });
    return ts;
  }

  /** Collapse a burst of display-state changes into ONE invalidation on the next
   *  frame. Dragging a window slider emits per pixel of travel, and each round
   *  restores and re-processes every tile of every channel — so the burst is both
   *  wasted work and the race that breaks cache records (see {@link displayToken}).
   *  The store write stays live, so the pane itself remains responsive. */
  private scheduleInvalidate(): void {
    if (this.invalidateHandle !== null) return; // already queued for this frame
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    this.invalidateHandle = raf(() => {
      this.invalidateHandle = null;
      this.invalidateDisplay();
    });
  }

  /** Re-apply the display pipeline (window/gamma/colour/invert) after a state change.
   *  Multichannel invalidates ONLY the visible slice's channel images — invalidating
   *  the whole world would re-process every hidden/preloaded slice's tiles (hundreds),
   *  flooding OSD with "[CacheRecord] … InvalidStateError" and wasting work on tiles
   *  that aren't on screen. The other cached slices are marked stale and re-tinted
   *  lazily when revealed. Composite/grayscale invalidate the world; serverless
   *  multichannel re-composites its cached planes. */
  private invalidateDisplay(): void {
    // Supersede any in-flight recolor round before restarting one (see displayToken).
    this.displayToken++;
    const v = this.viewer;
    if (!v) return;
    if (this.simpleMultichannel) {
      void this.recompositeAndOpen(this.displayToken);
      return;
    }
    if (this.isMultiChannel) {
      this.cache.invalidateChannelDisplay(this.currentZ);
      return;
    }
    this.invalidateWorld();
  }

  /** Restore and re-recolor every tile of the main viewer and the navigator. */
  private invalidateWorld(): void {
    const v = this.viewer;
    if (!v) return;
    quiet(() => v.world.requestInvalidate(true));
    quiet(() => v.navigator?.world?.requestInvalidate(true));
  }

  private destroyViewer(): void {
    this.cache.cancelBackgroundLoad();
    if (this.frameRaf !== null) {
      cancelAnimationFrame(this.frameRaf);
      this.frameRaf = null;
    }
    // Tear down an armed pixel tool's overlay (zoom-to-box stays armed, as before).
    if (this.canvasTools.activeId !== 'zoomToBox') this.canvasTools.deactivate();
    if (this.overlay) {
      this.overlay.destroy();
      this.overlay = null;
    }
    if (this.scaleBar) {
      this.scaleBar.destroy();
      this.scaleBar = null;
    }
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
    this.coordTransform = null;
    this.cache.reset();
    this.sampler.clear();
  }

  /** This backend's region renderer (the SVG overlay), once a plot is mounted. */
  getRegionOverlay(): IRegionOverlay | null {
    return this.overlay;
  }

  /** OSD renders only the image type — no isosurface, so no controls. */
  getIsosurfaceControls(): IIsosurfaceControls | null {
    return null;
  }

  /** OSD renders only the image type — no 3D scenes, so no controls. */
  getSurface3dControls(): ISurface3dControls | null {
    return null;
  }

  /** OSD renders only the image type — no LINE intensity ROIs, so no controls. */
  getIntensityControls(): IIntensityControls | null {
    return null;
  }

  private toOverlayMode(mode: string | false): RegionToolMode {
    return OVERLAY_MODES.has(mode as RegionToolMode) ? (mode as RegionToolMode) : 'none';
  }


  reloadAndPlot(): void {
    /* host re-drives plot() via the image-info stream */
  }
  reset(): void {
    this.destroyViewer();
    this.resetSimpleState();
  }
  relayout(_trueImageSize?: number[]): void {
    const vp = this.viewer?.viewport;
    if (!vp) return;
    // Keep the user's current view across a container/split resize instead of
    // snapping home. Viewport bounds are image-relative (image width = 1), so
    // they're independent of the container's pixel size — capture the visible
    // region now and re-fit it once the new size has settled. OSD's autoResize
    // fires asynchronously and the angular-split transition animates the width
    // over a few hundred ms, so restore on the next frame and again after the
    // transition completes.
    const bounds = vp.getBounds(true);
    const restore = () => quiet(() => {
      this.viewer?.viewport.fitBounds(bounds, true);
      this.viewer?.viewport.applyConstraints(true);
    });
    requestAnimationFrame(restore);
    setTimeout(restore, 350);
  }
  resetAxes(): void {
    this.viewer?.viewport.goHome();
  }
  autoscale(): void {
    this.viewer?.viewport.goHome();
  }
  zoomIn(): void {
    this.viewer?.viewport.zoomBy(ZOOM_BUTTON_STEP);
    this.viewer?.viewport.applyConstraints();
  }
  zoomOut(): void {
    this.viewer?.viewport.zoomBy(1 / ZOOM_BUTTON_STEP);
    this.viewer?.viewport.applyConstraints();
  }
  setDragMode(mode: string | false): void {
    // Rectangle/polygon drawing run on the SVG overlay; wand/eraser/zoom-box
    // (custom Plotly overlays) are routed to Plotly by the router and aren't
    // handled here yet.
    this.overlay?.setMode(this.toOverlayMode(mode));
  }

  setShowStack(_showstack: boolean): void {
    /* OSD navigates the stack via the z-slider -> setZIndex */
  }

  /** Show/hide the overview navigator. Stored for the next viewer creation, and
   *  applied live when a viewer is already mounted (hides/reveals its element —
   *  the navigator instance itself only exists when created with showNavigator). */
  setNavigatorVisible(visible: boolean): void {
    this.navigatorVisible = visible;
    const navEl: HTMLElement | undefined = this.viewer?.navigator?.element;
    if (navEl) navEl.style.display = visible ? '' : 'none';
  }

  /** Toggle bilinear smoothing vs nearest-neighbour (crisp pixels). Stored for the
   *  next viewer creation, and applied live (with a redraw) to a mounted viewer. */
  setImageSmoothingEnabled(enabled: boolean): void {
    this.smoothingEnabled = enabled;
    const drawer = this.viewer?.drawer;
    if (drawer?.setImageSmoothingEnabled) {
      drawer.setImageSmoothingEnabled(enabled);
      this.viewer?.forceRedraw();
    }
  }

  /**
   * Swap the displayed z-slice live. Slices are kept as separate tiled images in
   * the world, so switching is just an opacity toggle: a previously-visited slice
   * shows instantly (its decoded + recolored tiles are still resident), and a
   * never-seen slice is added once. The region overlay, coordinate transform,
   * scale bar, colormap pipeline and current zoom/pan all persist — the x/y
   * geometry is identical across slices.
   *
   * Simple mode (tiled:false — a numbered image series assembled client-side,
   * each slice its own complete image with no shared tile server) has no
   * pyramid to toggle opacity on, so it re-opens the viewer on the new
   * slice's URL instead. preserveViewport (viewer option, see plot()) keeps
   * the current zoom/pan across that reopen.
   */
  setZIndex(zIndex: number): void {
    const z = zIndex || 0;
    if (z === this.currentZ) return;
    if (!this.viewer) return;
    if (this.simpleMode) {
      if (this.simpleMultichannel) {
        const urls = this.simpleChannelUrls[z] ?? this.simpleChannelUrls[0];
        if (!urls) return;
        this.currentZ = z;
        this.viewportPixels = null;
        // A different image commits a new channelUrls array (see plot()).
        const image = this.simpleChannelUrls;
        void (async () => {
          const planes = await this.loadSimpleChannelPlanes(urls);
          // Scrubs can resolve out of order: only the current slice's planes
          // may land, or a later recomposite would show the wrong slice.
          if (this.currentZ !== z || this.simpleChannelUrls !== image || !this.viewer) return;
          this.simpleChannelPlanes = planes;
          this.sampler.computeSimpleMultichannelHistograms(z, planes);
          this.scheduleInvalidate(); // recomposite + open, coalesced with slider changes
        })();
        return;
      }
      const rawUrl = this.simpleUrls[z] ?? this.simpleUrls[0];
      if (!rawUrl) return;
      this.currentZ = z;
      this.viewportPixels = null;
      // Fetched via SimpleSliceAccessService (auth interceptor applies) then
      // upscaled to full-res (same as the initial load — see toFullResUrl) so
      // the world stays full-res across slices and ROIs keep aligning. Guard
      // against a newer scrub landing first.
      this.simpleStack.fetchAsBlobUrl(rawUrl)
        .then((previewUrl) =>
          this.toFullResUrl(previewUrl, this.descriptor?.width ?? 0, this.descriptor?.height ?? 0),
        )
        .then((url) => {
          if (this.currentZ !== z || !this.viewer) return;
          this.viewer.open({ type: 'image', url } as any);
          void this.sampleSimpleHistogram(url, z); // re-bin the scrubbed slice
        })
        .catch((err) => console.warn('[OSD] slice fetch failed', err));
      return;
    }
    if (!this.descriptor || !this.infoB64) return;
    this.currentZ = z;
    this.viewportPixels = null; // wand readback is slice-specific
    this.cache.showSlice(z);
    if (this.isMultiChannel) {
      this.sampler.computeMultiChannelHistograms(this.descriptor, this.infoB64, z);
    }
  }

  setStackLoading(stackLoading: boolean): void {
    this.stackLoading$.next(stackLoading);
  }
  isStackLoading(): Observable<boolean> {
    return this.stackLoading$.asObservable();
  }
  getStackLoadingProgress(): Observable<number> {
    return of(0); // OSD loads a stack's slices lazily (SliceCache); no progress to report
  }

  getTrueImageSize(): { width: number; height: number } | null {
    return this.descriptor ? { width: this.descriptor.width, height: this.descriptor.height } : null;
  }
  getCurrentImage(): Promise<Image | null> {
    return Promise.resolve(null);
  }

  /**
   * The currently displayed pixels — the rendered viewport (what the user sees,
   * including the current zoom and any colormap recolor), as RGBA. Feeds the
   * processing-pipeline dialog's "use current view". Returns null until tiles
   * are drawn.
   */
  getDisplayedPixelData(): PixelData | null {
    const canvas: HTMLCanvasElement | undefined = this.viewer?.drawer?.canvas;
    if (!canvas || !canvas.width || !canvas.height) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const { width, height } = canvas;
    const img = ctx.getImageData(0, 0, width, height);
    return { width, height, channels: 4, data: img.data };
  }

  /**
   * Image-pixel rectangle the drawer canvas (what {@link getDisplayedPixelData}
   * reads) currently covers. Unlike {@link emitViewportChange}, this is NOT
   * clamped to the image bounds: the canvas maps 1:1 to the viewport rectangle,
   * so leaving it unclamped keeps `canvasPx -> imagePx` an exact affine map
   * (clamping would skew coordinates near the image edges). Routed through world
   * item 0 (see {@link viewportRectToImage}) for multi-layer accuracy.
   */
  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    const vp = this.viewer?.viewport;
    if (!vp || !this.descriptor) return null;
    try {
      const r = viewportRectToImage(this.viewer, vp.getBounds(true));
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    } catch {
      return null;
    }
  }

  downloadImage(): void {
    // Snapshot the currently rendered OSD view as a PNG (WYSIWYG) — the parallel
    // to Plotly's downloadImage. OSD uses the 2D canvas drawer and bakes the
    // active display settings (window / gamma / colormap / per-channel colours /
    // invert) into the tiles via the recolor pipeline, so the drawer canvas
    // already reflects exactly what's on screen at the current zoom/pan. The
    // full-resolution stitched export lives in exportComposite() (Channels &
    // Histogram dialog).
    const canvas: HTMLCanvasElement | undefined = this.viewer?.drawer?.canvas;
    if (!canvas || !canvas.width || !canvas.height) return;
    const stem = (this.currentFileName || 'image').replace(/\.[^.]+$/, '');
    canvas.toBlob((blob) => {
      if (blob) saveAs(blob, `${stem}.png`);
    }, 'image/png');
  }

  setPlotType(_plotType: PlotType): void {
    /* OSD only renders the image type */
  }
  setSurfaceDragMode(_mode: string): void {
    /* 3D not supported by OSD */
  }
  resetSurfaceCamera(): void {
    /* 3D not supported by OSD */
  }

  /** The router reads the autoscale event from Plotly only. */
  getAutoscaleEvent(): Observable<any> {
    return EMPTY;
  }

  /** Visible image region (full-image pixel coords), emitted when the view
   *  settles. The intensity inset re-samples this region at the zoom resolution. */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.viewportChange$.asObservable();
  }

  /** {@link IIntensitySampling} stub — intensity sampling lives in the Plotly
   *  backend (it owns pixel readback). OSD feeds it only via getViewportChange$;
   *  the sampling-cache priming itself is a no-op here. */
  async ensureIntensitySampling(_imageInfo: IImageInfo, _zIndex: number): Promise<void> {
    /* no-op: Plotly owns intensity sampling (see IIntensitySampling) */
  }

  /** {@link IIntensitySampling} stub — see {@link ensureIntensitySampling}. */
  refreshIntensitySamplingForRoi(_x: number, _y: number, _width: number, _height: number,
                                 _zIndex: number): void {
    /* no-op: Plotly owns intensity sampling (see IIntensitySampling) */
  }

  /** Compute the current viewport's image-pixel rectangle (clamped to the image)
   *  and broadcast it. */
  private emitViewportChange(): void {
    const rect = this.visibleImageRect();
    if (rect) this.viewportChange$.next(rect);
  }

  /** The current viewport's image-pixel rectangle, clamped to the image, or
   *  null when there is no laid-out viewport. */
  private visibleImageRect(): PlotModeRect | null {
    const vp = this.viewer?.viewport;
    if (!vp || !this.descriptor) return null;
    try {
      // Route through world item 0 (osd-coords): vp.viewportToImageRectangle is
      // inaccurate and warns when the world holds multiple images (per-channel
      // multichannel layers), which fed the intensity inset a wrong ROI.
      const r = viewportRectToImage(this.viewer, vp.getBounds(true));
      const iw = this.descriptor.width, ih = this.descriptor.height;
      const x = Math.max(0, Math.min(iw, r.x));
      const y = Math.max(0, Math.min(ih, r.y));
      const width = Math.max(1, Math.min(iw - x, r.width));
      const height = Math.max(1, Math.min(ih - y, r.height));
      return { x, y, width, height };
    } catch {
      return null; /* viewport not ready */
    }
  }

  /** Coalesce redraws into one {@link frame$} emission per animation frame.
   *  Skipped entirely while nothing listens. */
  private scheduleFrame(): void {
    if (this.frameRaf !== null || !this.frame$.observed) return;
    this.frameRaf = requestAnimationFrame(() => {
      this.frameRaf = null;
      const rect = this.visibleImageRect();
      if (rect) this.frame$.next(rect);
    });
  }

  /**
   * The viewport a contributed plot mode draws over. One stable object per
   * service: every method reads the CURRENT viewer, so it stays valid across a
   * viewer rebuild and reports `isReady() === false` while none is mounted
   * (conversions then return NaN rather than throwing).
   */
  getPlotModeViewport(): PlotModeViewport {
    if (this.plotModeViewport) return this.plotModeViewport;
    const nan = { x: NaN, y: NaN };
    const ready = () => !!this.coordTransform?.isReady();
    this.plotModeViewport = {
      getOverlayContainer: () => this.getOverlayContainer(),
      dataToClient: (x, y) => (ready() ? this.coordTransform!.dataToClient(x, y) : nan),
      clientToData: (cx, cy) => (ready() ? this.coordTransform!.clientToData(cx, cy) : nan),
      dataLengthToScreen: (len) => (ready() ? this.coordTransform!.dataLengthToScreen(len) : NaN),
      isReady: ready,
      // Both start with the current visible rect when the viewport is ready: a mode
      // activates after the base render has gone idle, so without it an overlay
      // following `frame$.subscribe(redraw)` would stay blank until the next pan/zoom.
      frame$: this.withCurrentRect(this.frame$, ready),
      settled$: this.withCurrentRect(this.viewportChange$, ready),
      fitBounds: (rect, options) => {
        const viewer = this.viewer;
        if (!viewer || !ready() || !(rect.width > 0) || !(rect.height > 0)) return;
        const vpRect = imageRectToViewport(viewer, rect.x, rect.y, rect.width, rect.height);
        viewer.viewport.fitBoundsWithConstraints(vpRect, !!options?.immediately);
      },
    };
    return this.plotModeViewport;
  }

  /** `source`, preceded by the current visible rect for each subscriber (when ready). */
  private withCurrentRect(source: Subject<PlotModeRect>, ready: () => boolean): Observable<PlotModeRect> {
    return defer(() => {
      const rect = ready() ? this.visibleImageRect() : null;
      return rect ? source.pipe(startWith(rect)) : source.asObservable();
    });
  }

  /** OSD targets the image display; the scalar/3D plot types belong to Plotly. */
  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    return [PLOT_TYPE_DESCRIPTORS[PlotType.HEATMAP]!];
  }

  /** The intensity profiles live in Plotly (see IIntensitySampling); the
   *  router reads them from there. */
  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return EMPTY;
  }
  /** OSD only renders the image type; the LINE intensity inset is Plotly-only. */
  renderIntensityInset(_divId: string, _profiles: IntensityProfile[]): void {
    /* no LINE mode on OSD */
  }

  // ── IRegionStore + classification colours ────────────────────────────
  // Inherited from BaseStoreVisualizer — pure delegations to the shared
  // RegionStore / VisualizerStore (identical to napari-js). The OSD region
  // overlay (constructed in plot()) reads/writes that same store, so regions
  // stay in sync with Plotly and the Region Editor; OSD renders them as an SVG
  // overlay rather than carrying Plotly shape dicts.

  // ── IToolController ──────────────────────────────────────────────────
  // setActiveTool and the per-tool setters run in BaseStoreVisualizer over
  // this.canvasTools; OSD gates mouse-nav and its readback here.

  /**
   * Mouse-nav is off while a canvas tool holds the pointer (its drag must draw,
   * not pan) and on otherwise — also when a region draw mode is armed on the
   * overlay, as the old per-tool fan-out left it (its setZoomToBoxMode(false)
   * re-enabled nav after the overlay's setMode). A pixel tool samples the
   * rendered viewport, read back lazily on first use.
   */
  protected override beforeToolChange(next: CanvasToolId | null): boolean {
    this.viewer?.setMouseNavEnabled(next === null);
    if (next !== null && next !== 'zoomToBox') this.viewportPixels = null;
    return true;
  }
  /** Box-prompted SAM: segment the drawn rectangles against our tool host
   *  (viewport readback + coordinate transform + region store). */
  segmentRectangles(): Promise<number> {
    this.viewportPixels = null; // segment against the current viewport readback
    return this.samTool.segmentBoxes(this.toolHost);
  }
  segmentRectanglesCellpose(): Promise<number> {
    if (!this.cellSegmenter) return Promise.resolve(0);
    this.viewportPixels = null; // crop against the current viewport readback
    return this.cellSegmentTool.segmentBoxes(this.toolHost, this.cellSegmenter);
  }
  setSamModel(id: string): void {
    this.samTool.setModel(id);
    this.samPointTool.setModel(id);
  }

  /** The element the on-canvas tool overlays attach to (OSD is mounted here). */
  private getOverlayContainer(): HTMLElement | null {
    return this.plotDiv ? document.getElementById(this.plotDiv) : null;
  }

  /** Size the navigator from the CURRENT container (navigatorSizeRatio of the
   *  viewer element) and keep it pinned to the corner. OSD computes the size
   *  once in the Viewer constructor — before the host flex layout settles —
   *  and never corrects it, leaving a stale-size element whose visible minimap
   *  floats above the bottom-right corner. */
  private resizeNavigator(): void {
    const v = this.viewer;
    const nav = v?.navigator;
    const el: HTMLElement | undefined = v?.element;
    if (!nav?.element || !el?.clientWidth || !el?.clientHeight) return;
    const w = Math.round(el.clientWidth * 0.16);
    const h = Math.round(el.clientHeight * 0.16);
    if (nav.element.style.width !== `${w}px` || nav.element.style.height !== `${h}px`) {
      quiet(() => {
        nav.setWidth(w);
        nav.setHeight(h);
      });
    }
    // Normalize OSD's control-corner stack so the minimap sits flush in the
    // corner, inset 12px to line up with the scale bar:
    //  - the inline-block wrapper carries line-box struts and can retain stale
    //    sizing → make it a tight block;
    //  - anything else OSD left in the corner would stack below the navigator
    //    and float it up → hide it;
    //  - inset the corner itself (bottom/right 12px), keeping the element in
    //    normal flow.
    const wrapper = nav.element.parentElement as HTMLElement | null;
    const corner = wrapper?.parentElement as HTMLElement | null;
    if (wrapper && corner) {
      wrapper.style.display = 'block';
      wrapper.style.lineHeight = '0';
      wrapper.style.fontSize = '0';
      // The wrapper keeps the navigator's stale pre-settle height as an
      // explicit size (the nav was 0.16x the UNSETTLED container at creation),
      // leaving an empty band under the resized minimap — measured live:
      // navH=87 inside wrapH=167. Force it to hug its content.
      wrapper.style.height = 'auto';
      wrapper.style.width = 'auto';
      for (const child of Array.from(corner.children) as HTMLElement[]) {
        if (child !== wrapper) child.style.display = 'none';
      }
      for (const child of Array.from(wrapper.children) as HTMLElement[]) {
        if (child !== nav.element) child.style.display = 'none';
      }
      corner.style.bottom = '12px';
      corner.style.right = '12px';
    }
    Object.assign(nav.element.style, { position: 'relative', top: '', left: '', bottom: '', right: '', margin: '0' });
  }

  /** Force the docked toolbar to repaint after an OSD zoom. Chrome leaves it
   *  laid-out-but-unpainted (the canvas's compositing churn strands the toolbar's
   *  raster). A synchronous display toggle re-rasters it with no visible gone-frame
   *  and no layout shift. Located via the DOM since this service doesn't own the
   *  toolbar; a no-op when there's no toolbar (e.g. embedded without one). The
   *  element is looked up once per mount. `throttled` (animation frames) nudges
   *  at most every {@link TOOLBAR_NUDGE_INTERVAL_MS}: each nudge forces a layout. */
  private nudgeToolbarRepaint(throttled = false): void {
    if (throttled) {
      const now = performance.now();
      if (now - this.lastToolbarNudge < OpenSeadragonVisualizerService.TOOLBAR_NUDGE_INTERVAL_MS) return;
      this.lastToolbarNudge = now;
    }
    if (this.toolbarDock === undefined || (this.toolbarDock && !this.toolbarDock.isConnected)) {
      const plotEl = this.plotDiv ? document.getElementById(this.plotDiv) : null;
      this.toolbarDock = plotEl?.closest('visualization')?.querySelector<HTMLElement>('.toolbar-dock') ?? null;
    }
    const dock = this.toolbarDock;
    if (!dock) return;
    const prev = dock.style.display;
    dock.style.display = 'none';
    void dock.offsetHeight; // reflow so the toggle re-rasters on the next paint
    dock.style.display = prev;
  }

  /** Fit the OSD viewport to an image-space rectangle (coords ordered
   *  [xMin, xMax, yMax, yMin]). */
  private applyZoomToBox(coordinates: number[]): void {
    if (!this.viewer || coordinates.length < 4) return;
    const [a, b, c, d] = coordinates;
    const x = Math.min(a, b);
    const w = Math.abs(b - a);
    const y = Math.min(c, d);
    const h = Math.abs(c - d);
    if (w <= 0 || h <= 0) return;
    const rect = imageRectToViewport(this.viewer, x, y, w, h);
    this.viewer.viewport.fitBounds(rect, false);
  }

  /**
   * Read back the *currently rendered* OSD canvas as the pixel tools' frame.
   * The matrix covers only the visible viewport at screen resolution, so when
   * the user is zoomed into a sub-region the wand samples that region's detail
   * (rather than the whole image at preview resolution). `originX/originY` and
   * `ratios` map image coords <-> readback-pixel coords for the wand's
   * data/ratio/origin model. Cached until the viewport changes.
   */
  private readbackViewport(): CachedImageData | null {
    if (this.viewportPixels) return this.viewportPixels;
    const viewer = this.viewer;
    const canvas: HTMLCanvasElement | undefined = viewer?.drawer?.canvas;
    const vp = viewer?.viewport;
    if (!canvas || !canvas.width || !canvas.height || !vp) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const w = canvas.width; // device pixels
    const h = canvas.height;
    // The RGBA readback is the tools' frame as-is (packed, RT-17): no per-pixel arrays.
    const data = ctx.getImageData(0, 0, w, h).data;

    // Image-coord span the readback covers (CSS px in, image coords out). Route
    // through world item 0 (osd-coords) so it stays accurate — and quiet — when
    // the world holds multiple images (per-channel multichannel layers).
    const elW = canvas.clientWidth || w;
    const elH = canvas.clientHeight || h;
    const tl = elementToImage(this.viewer, 0, 0);
    const br = elementToImage(this.viewer, elW, elH);
    const ratioX = (br.x - tl.x) / w; // image px per readback px
    const ratioY = (br.y - tl.y) / h;

    this.viewportPixels = {
      frames: [packedFrame(data, w, h)],
      width: w,
      height: h,
      ratios: [ratioX, ratioY],
      isGrayscale: false, // canvas readback is always RGBA
      originX: tl.x,
      originY: tl.y,
    };
    return this.viewportPixels;
  }

  /**
   * Recolor a grayscale tile through the active colormap LUT, using OSD's
   * tile-invalidated pixel pipeline (OSD 5+/6). Maps each pixel's grayscale
   * value (r==g==b) to the LUT's RGB. No-op for RGB images or until the LUT is
   * built. Handler is async — OSD awaits it (raiseEventAwaiting).
   */
  private async recolorTile(event: any): Promise<void> {
    if (this.isMultiChannel) {
      await this.recolorChannelTile(event);
      return;
    }
    const token = this.displayToken;
    const gray = this.isGrayscaleImage;
    if (gray) {
      if (!this.colorLut) return;
    } else if (!this.display.rgbNeedsRecolor()) {
      return; // RGB at default (all visible, full window, γ=1, no invert) → passthrough
    }

    const px = await this.readTilePixels(event);
    if (!px || !this.display.applyToRgba(px.img.data)) return; // nothing opaque
    await this.writeTilePixels(event, px, token);
  }

  /**
   * Tint a single channel's tile in place. Each channel is its own OpenSeadragon
   * TiledImage (a single-band grayscale tile); OSD composites the N images
   * additively ('lighter') in its drawer — so this just maps the tile's intensity
   * through the channel's window/gamma and its pseudo-colour. Synchronous (no
   * cross-tile fetch) → no race, no seams. Channel is parsed from the tile URL.
   */
  private async recolorChannelTile(event: any): Promise<void> {
    const token = this.displayToken;
    const tile = event?.tile;
    const url: string = (tile && (typeof tile.getUrl === 'function' ? tile.getUrl() : tile.url)) || '';
    const m = /[?&]channel=(\d+)/.exec(url);
    const ch = m ? parseInt(m[1], 10) : 0;
    const st = this.channelStates[ch];

    const px = await this.readTilePixels(event);
    if (!px) return;

    // Precompute lum(0..255) → tinted RGB once, then map each pixel by lookup —
    // the channel tile is single-band, so this turns ~262k per-pixel
    // channelIntensity() (with Math.pow for gamma) calls into 256 — the difference
    // between a snappy and a sluggish slider on a 4-channel stack.
    const { r: rL, g: gL, b: bL } = this.display.channelRgbLut(st);
    const d = px.img.data;
    let changed = false;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = r >= g ? (r >= b ? r : b) : g >= b ? g : b; // single-band → max
      d[i] = rL[lum];
      d[i + 1] = gL[lum];
      d[i + 2] = bL[lum];
      changed = true;
    }
    if (!changed) return;
    await this.writeTilePixels(event, px, token);
  }

  /**
   * Read a tile's pixels for recoloring. Prefers the tile's rendering context,
   * but some tile caches (ajax PNG blobs) convert to an *empty* context2d —
   * recoloring that would blank the tile (white canvas). So if the context has
   * no opaque pixels, the tile's own bitmap/image is drawn to a scratch canvas
   * and read instead. Null when no pixels can be read: leave the tile untouched.
   */
  private async readTilePixels(event: any): Promise<{ ctx: CanvasRenderingContext2D; img: ImageData } | null> {
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = await event.getData('context2d'); } catch { /* try the bitmap below */ }
    if (ctx && ctx.canvas && ctx.canvas.width && ctx.canvas.height) {
      let img: ImageData | null = null;
      try { img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height); } catch { /* tainted/gone */ }
      if (img && this.hasOpaque(img.data)) return { ctx, img };
    }
    let src: any = null;
    try { src = await event.getData('imageBitmap'); } catch { /* try the image below */ }
    if (!src || !src.width) { try { src = await event.getData('image'); } catch { /* none */ } }
    if (!src || !src.width) return null;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const scratch = c.getContext('2d', { willReadFrequently: true });
    if (!scratch) return null;
    scratch.drawImage(src, 0, 0);
    return { ctx: scratch, img: scratch.getImageData(0, 0, c.width, c.height) };
  }

  /** Write recolored pixels back to the tile — unless a newer display round
   *  (`token`, see {@link displayToken}) has already restored it: writing a
   *  superseded context back makes OSD's conversion throw DOMException, which
   *  destroys the cache record and unloads the tile. */
  private async writeTilePixels(
    event: any, px: { ctx: CanvasRenderingContext2D; img: ImageData }, token: number,
  ): Promise<void> {
    if (token !== this.displayToken) return;
    px.ctx.putImageData(px.img, 0, 0);
    // The tile's cache can still be evicted between the awaits and here (a
    // slice change), making setData throw a DOMException on a dead canvas.
    // Swallow it — the tile is gone, so there's nothing to recolor.
    try { await event.setData(px.ctx, 'context2d'); } catch { /* tile evicted */ }
  }

  /** Per-channel histogram for the Channels & Histogram pane, from the current
   *  slice's sampled tiles (grayscale → channel 0; RGB → R/G/B). Null until the
   *  async sampling resolves or if it was skipped. */
  getHistogram(channelIndex: number, _bins: number): IHistogram | null {
    return this.sampler.get(this.currentZ, channelIndex);
  }

  /** Native bit depth of a channel from the tile descriptor (8 when unknown). */
  private channelBitDepth(channelIndex: number): number {
    return this.descriptor?.channelInfo?.[channelIndex]?.bitDepth ?? 8;
  }

  /**
   * Async histogram for the Channels & Histogram pane. For >8-bit images it
   * fetches the **native** distribution from the server `/histogram` endpoint
   * (the 8-bit canvas tiles can't carry 16-bit values) and caches it per
   * slice+channel; for 8-bit/RGB it returns the existing client-sampled 8-bit
   * histogram. Read-only — it never touches the tile/display pipeline.
   */
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null> {
    if (this.channelBitDepth(channelIndex) <= 8 || !this.infoB64) {
      return of(this.getHistogram(channelIndex, bins));
    }
    return this.sampler.native$(this.infoB64, this.currentZ, channelIndex, bins);
  }

  /**
   * Export the underlying image data as a data-preserving multi-band TIFF at
   * native bit depth via `GET /export/tiff` (the server reads the raw 16-bit
   * planes — the client never sees them). Sends only the visible channels; the
   * existing 8-bit composite PNG export is unaffected.
   */
  async exportData(): Promise<void> {
    if (!this.infoB64) return;
    const visible = this.channelStates.filter((c) => c.visible).map((c) => c.index);
    const url = exportTiffUrl(this.api, this.infoB64, this.currentZ, visible, this.channelStates.length);
    const saveName = exportTiffFilename(this.currentFileName);
    try {
      const resp = await firstValueFrom(
        this.http
          .get(url, { observe: 'response', responseType: 'blob' })
          .pipe(timeout(600000)), // large exports stream slowly; generous deadline
      );
      if (resp.status === 202) {
        console.warn('[OSD] 16-bit export: file still caching — try again shortly.');
        return;
      }
      const blob = resp.body;
      if (blob) saveAs(blob, saveName);
    } catch (err) {
      console.warn('[OSD] 16-bit TIFF export failed', err);
    }
  }

  /**
   * Export the current slice as a publication-ready PNG composited with the
   * active display settings (window / gamma / colormap or per-channel pseudo-
   * colours / invert). Picks the largest pyramid level under a pixel cap (the
   * coarser overview for huge whole-slides), fetches that level's tile grid,
   * stitches it into one canvas, runs the shared display pipeline, and saves it.
   * A per-channel (multichannel) image is exported the way it is drawn: each
   * visible channel's tiles are stitched and merged additively with its tint.
   */
  async exportComposite(): Promise<void> {
    const desc = this.descriptor;
    // Per-channel tiles exist only at the real Bio-Formats levels.
    const levels = (this.isMultiChannel ? desc?.levels.slice(0, this.realLevels) : desc?.levels) ?? [];
    if (!desc || !this.infoB64 || !levels.length) return;
    const CAP = 32_000_000; // ~32 MP — bounds memory for whole-slide images
    let res = levels.length - 1; // coarsest fallback
    for (let i = 0; i < levels.length; i++) {
      if (levels[i].width * levels[i].height <= CAP) { res = i; break; }
    }
    const lw = levels[res].width;
    const lh = levels[res].height;
    const t = desc.tileSize;
    const cols = Math.max(1, Math.ceil(lw / t));
    const rows = Math.max(1, Math.ceil(lh / t));
    const canvas = document.createElement('canvas');
    canvas.width = lw;
    canvas.height = lh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const z = this.currentZ;
    const infoB64 = this.infoB64;
    /** Stitch the level's tile grid (server composite, or one channel) into the canvas. */
    const stitch = async (channel?: number): Promise<void> => {
      ctx.clearRect(0, 0, lw, lh);
      const jobs: Promise<void>[] = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const url = buildTileUrl(this.api, infoB64, { res, col, row, z, tileSize: t, channel });
          jobs.push(
            (async () => {
              try {
                const bmp = await fetchTileBitmap(this.http, url, 30000);
                ctx.drawImage(bmp, col * t, row * t);
                bmp.close?.();
              } catch (err) {
                // Skip a failed tile — the exported composite has a gap there.
                console.warn('[viz:export] composite tile fetch failed, skipping', url, err);
              }
            })(),
          );
        }
      }
      await Promise.all(jobs);
    };
    try {
      if (this.isMultiChannel) {
        const states = this.channelStates;
        const nCh = Math.max(1, states.length || (desc.channels ?? 1));
        let out: Uint8ClampedArray | null = null;
        let imageData: ImageData | null = null;
        for (let c = 0; c < nCh; c++) {
          if (states[c]?.visible === false) continue;
          await stitch(c);
          imageData = ctx.getImageData(0, 0, lw, lh);
          out ??= new Uint8ClampedArray(imageData.data.length);
          this.display.addChannel(out, imageData.data, states[c]);
        }
        if (imageData && out) {
          for (let i = 3; i < out.length; i += 4) out[i] = 255; // opaque
          imageData.data.set(out);
          ctx.putImageData(imageData, 0, 0);
        } else {
          ctx.clearRect(0, 0, lw, lh); // every channel hidden
        }
      } else {
        await stitch();
        const imageData = ctx.getImageData(0, 0, lw, lh);
        if (this.display.applyToRgba(imageData.data)) ctx.putImageData(imageData, 0, 0);
      }
    } catch (err) {
      // Keep the un-recolored composite if readback fails — but say why.
      console.warn('[viz:export] composite recolor readback failed — exporting raw tiles', err);
    }
    const stem = (this.currentFileName || 'image').replace(/\.[^.]+$/, '');
    canvas.toBlob((blob) => {
      if (blob) saveAs(blob, `${stem}_composite.png`);
    }, 'image/png');
  }

  /** True if any pixel in the RGBA buffer is non-transparent. */
  private hasOpaque(d: Uint8ClampedArray): boolean {
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] !== 0) return true;
    }
    return false;
  }

  // ── IDisplayOptions ──────────────────────────────────────────────────
  // Inherited from BaseStoreVisualizer — pure delegations to the shared
  // VisualizerStore, so OSD and Plotly stay in lock-step. OSD applies the
  // colormap to grayscale tiles via the LUT reactively (see the constructor's
  // colormap subscription), not in setColormap.

  // ── IVisualizer ──────────────────────────────────────────────────────
  unsubscribe(): void {
    this.colormapSub?.unsubscribe();
    this.colormapSub = null;
    // Drop a queued invalidation so it can't fire against a torn-down viewer.
    if (this.invalidateHandle !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.invalidateHandle);
      else clearTimeout(this.invalidateHandle as unknown as ReturnType<typeof setTimeout>);
      this.invalidateHandle = null;
    }
    this.destroyViewer();
    this.resetSimpleState();
  }
}
