import { Injectable, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, Subscription, combineLatest, firstValueFrom, of } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { Image } from 'image-js';
import * as OpenSeadragon from 'openseadragon';

import { VisualizerStore } from '../../visualizer-store.service';
import { RegionStore } from '../../region-store.service';
import { IImageInfo, IImageMetadata } from '../../contracts/image.contract';
import { TileAccessPort, TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { VizConfig, VIZ_CONFIG } from '../../contracts/viz-config';
import { Region } from '../../models/region';
import { PlotType, PLOT_TYPE_DESCRIPTORS, PlotTypeDescriptor } from '../../contracts/plot-type';
import { IVisualizer, PixelData, IntensityProfile, IIsosurfaceControls, IIntensityControls } from '../../contracts/visualizer.contract';
import { ViewerCapabilities, ViewerFeature, capabilitiesOf } from '../../contracts/capabilities.contract';
import { OsdRegionOverlay } from './osd-region-overlay';
import { OsdScaleBar } from './osd-scale-bar';
import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';
import { OsdCoordinateTransform } from './osd-coordinate-transform';
import { elementToImage, imageRectToViewport, viewportRectToImage } from './osd-coords';
import { buildTileUrl, fetchTileBitmap } from './tile-client';
import { SliceCache } from './slice-cache';
import { DisplayPipeline } from './display-pipeline';
import { HistogramSampler } from './histogram-sampler';
import { CachedImageData, WandToolService, WandToolHost } from '../../toolbar/wand-tool.service';
import { VertexEraserToolService, VertexEraserToolHost } from '../../toolbar/vertex-eraser-tool.service';
import { ZoomToBoxToolService, ZoomToBoxToolHost } from '../../toolbar/zoom-to-box-tool.service';
import { WandOptions } from '../../toolbar/wand.service';
import { buildColormapLut, Rgb } from '../../contracts/colormap-lut';
import { IChannelState, IHistogram } from '../../contracts/channel-histogram-api.contract';
import { saveAs } from 'file-saver';

/**
 * Quiet OpenSeadragon's "[Viewport.*] is not accurate with multi-image" advisories.
 * A multichannel image is composited from one TiledImage per channel — a legitimate
 * multi-image world — and OSD logs that advisory (at error level) from its own
 * navigator/overview rendering on every animation frame, flooding the console. Our
 * own image<->viewport conversions already route through world item 0 (see
 * osd-coords), so the remaining advisories are OSD-internal and only affect the
 * minimap's box accuracy (cosmetic). This wraps OSD's logger in a Proxy that drops
 * only that one message string and forwards every other log untouched. Idempotent.
 */
function silenceOsdMultiImageAdvisory(): void {
  const osd: any = OpenSeadragon as any;
  if (osd.__multiImageFilterInstalled) return;
  const base: any = (osd.console && typeof osd.console.error === 'function')
    ? osd.console
    : (typeof console !== 'undefined' ? console : null);
  if (!base) return;
  const isAdvisory = (a: unknown) =>
    typeof a === 'string' && a.indexOf('not accurate with multi-image') !== -1;
  osd.console = new Proxy(base, {
    get(target: any, prop: string) {
      const orig = target[prop];
      if ((prop === 'error' || prop === 'warn') && typeof orig === 'function') {
        return (...args: any[]) => { if (isAdvisory(args[0])) return; orig.apply(target, args); };
      }
      return typeof orig === 'function' ? orig.bind(target) : orig;
    },
  });
  osd.__multiImageFilterInstalled = true;
}

/** One pyramid level from `GET /tiles/info`. */
interface TileLevel { res: number; width: number; height: number; }

/** Tile-source descriptor returned by `GET /tiles/info`. */
interface TileDescriptor {
  width: number;
  height: number;
  tileSize: number;
  z: number;
  channels: number;
  /** True only for genuine multi-channel composites (indexed/LUT-bearing
   *  fluorescence stacks) the client should split into per-channel layers. The
   *  server sets it; an RGB photo read as separated planes has channels>1 but
   *  multichannel=false, so it stays a single composite tile source. */
  multichannel?: boolean;
  /** Real Bio-Formats resolution levels at the front of `levels`; the remaining
   *  levels are synthetic composited overviews (no per-channel tiles). */
  realLevels?: number;
  /** Per-channel metadata (name/color/bitDepth/min-maxAllowed) for native 16-bit
   *  windowing + histogram; null for plain 8-bit/RGB sources. */
  channelInfo?: Array<{
    name?: string; color?: string; bitDepth?: number; minAllowed?: number; maxAllowed?: number;
  }> | null;
  levels: TileLevel[];
  /** Physical pixel size in µm (0 when the format doesn't report it). */
  mppX?: number;
  mppY?: number;
}

/** What `load()` hands to `plot()`. */
interface OsdLoaded {
  descriptor: TileDescriptor | null;
  infoB64: string;
  z: number;
  /** Mirrors the loaded image's filename — the diagram's render pipeline
   *  guards on `loaded.filename === phaseInfo.fileName` before calling plot(). */
  filename: string | undefined;
}

/**
 * OpenSeadragon visualization backend.
 *
 * Renders the *image* plot type as a natively-tiled, zoomable raster, backed by
 * the jit-service tile endpoints (`GET /tiles/info` + `GET /tile`, which reuse
 * the Bio-Formats ROI renderer). Plotly keeps the scientific/data plot types
 * (scalar heatmap, surface, contour, scatter, line, scatter3d, isosurface) —
 * hence this backend advertises only `ImageDisplay`.
 *
 * Wired: load → descriptor, plot → mount viewer with a custom tile source,
 * zoom/pan → viewport API. NOT wired yet (follow-ups): region overlays + tools
 * (a positioned canvas/SVG overlay or Annotorious), pixel readback, and the
 * per-tile LUT/contrast params. Not registered in DI providers — `PlotlyService`
 * is still the only active backend; this proves the contract supports a second
 * implementation against real endpoints.
 */
@Injectable({ providedIn: 'root' })
export class OpenSeadragonVisualizerService implements IVisualizer {
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
  private coordTransform: ICoordinateTransform | null = null;
  private wandHost!: WandToolHost;
  private eraserHost!: VertexEraserToolHost;
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

  /** Overall deadline for the /tiles/info poll loop. An uncached whole-slide
   *  image (e.g. .ndpi) is cached server-side first (GCS->PVC), which can take
   *  several minutes — we poll (short requests; the cache-progress overlay
   *  shows the wait) until it's ready. Generous because each poll is cheap; on
   *  expiry the render pipeline gives up and the router falls back to Plotly. */
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
    private wandTool: WandToolService,
    private eraserTool: VertexEraserToolService,
    private zoomToBoxTool: ZoomToBoxToolService,
    private store: VisualizerStore,
    private regionStore: RegionStore,
    @Inject(VIZ_CONFIG) config: VizConfig,
  ) {
    this.api = config.slideCropServer;
    this.sampler = new HistogramSampler(this.http, this.api, {
      realLevels: () => this.realLevels,
      channelCount: (d) => this.channelStates.length || (d.channels ?? 1),
      isGrayscale: () => this.isGrayscaleImage,
      // Nudge the channel-states stream so the pane re-reads getHistogram now,
      // in case its bounded retry window already lapsed.
      onChannelHistogramsSampled: () => this.store.setChannelStates(this.store.currentChannelStates()),
      onGrayWindowSampled: (min, max) => this.seedGrayWindow(min, max),
    });
    this.ensureColormapSubscription();
  }

  private readonly stackLoading$ = new BehaviorSubject<boolean>(false);
  private readonly stackLoadingProgress$ = new BehaviorSubject<number>(0);
  private readonly autoscaleEvent$ = new Subject<any>();
  /** Visible image region (full-image pixel coords) emitted when the view
   *  settles, so the intensity inset can re-sample at the current zoom level. */
  private readonly viewportChange$ = new Subject<{ x: number; y: number; width: number; height: number }>();
  // Region state (regions, selection, the update event) lives in the shared
  // RegionStore; the IRegionStore methods below delegate to it.
  private readonly intensityProfile$ = new Subject<IntensityProfile[]>();
  // Image metadata and classification colours live in the shared VisualizerStore.

  /**
   * Subscribe to the shared VisualizerStore colormap/reverse so OSD recolors in
   * lock-step with Plotly. Idempotent and self-healing: this service is a root
   * singleton, but `unsubscribe()` (called on VisualizationComponent destroy)
   * tears the subscription down — and the constructor never runs again. So
   * `plot()` calls this to re-establish it after a component teardown/recreate
   * (e.g. switching images), otherwise colormap changes would be silently
   * dropped on every image after the first switch.
   */
  private ensureColormapSubscription(): void {
    if (this.colormapSub) return;
    // Colormap/reverse live in the shared VisualizerStore — the single source
    // of truth for both backends. Rebuild the LUT and re-run the pixel pipeline
    // whenever either changes, so OSD recolors in lock-step with Plotly.
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
      // grayscale.
      this.invalidateDisplay();
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
      try {
        (this.viewer as any).world.requestInvalidate(true);
      } catch {
        /* no-op */
      }
      try {
        (this.viewer as any).navigator?.world?.requestInvalidate(true);
      } catch {
        /* no-op */
      }
    }
  }

  // ── IDataRenderer ────────────────────────────────────────────────────

  /**
   * Fetch the tile-source descriptor for the selected file. The `info` param is
   * the base64 RawFileInfo the rest of the API uses; the GET goes through the
   * auth interceptor (Bearer). We also grab a token here for OSD's own tile
   * fetches (its loader bypasses HttpClient).
   */
  async load(imageInfo: IImageInfo, zIndex: number): Promise<OsdLoaded> {
    const filename = imageInfo?.fileName;
    // A different image was selected — stop the previous stack's background
    // loading immediately rather than letting it finish behind the new image.
    if (filename && this.currentFileName && filename !== this.currentFileName) {
      this.cache.cancelBackgroundLoad();
    }
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return { descriptor: null, infoB64: '', z: zIndex || 0, filename };

    try {
      this.authHeaders = await this.tiles.getAuthHeaders();
    } catch {
      this.authHeaders = {}; // fall back to cookie auth (ajaxWithCredentials)
    }
    // Poll /tiles/info: the backend returns 202 while the source file is still
    // being cached (GCS->PVC) — it kicks the download off in the background, so
    // each request is short (no long-held connection to trip ingress/proxy or
    // client timeouts), and 200 with the descriptor once it's ready. The
    // cache-progress overlay shows progress during the wait. We give up after
    // tilesInfoTimeoutMs so the render pipeline never hangs (the router then
    // falls back to Plotly for this image).
    const url = `${this.api}tiles/info?info=${infoB64}`;
    const deadline = Date.now() + this.tilesInfoTimeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error('tiles/info not ready before deadline — file still caching');
      }
      try {
        const resp = await firstValueFrom(
          this.http.get<TileDescriptor>(url, { observe: 'response' }).pipe(timeout(45000)),
        );
        if (resp.status === 200 && resp.body) {
          this.descriptor = resp.body;
          return { descriptor: resp.body, infoB64, z: zIndex || 0, filename };
        }
        // 202 Accepted (or empty body) → still caching; fall through and re-poll.
      } catch (err) {
        // Tolerate transient failures WHILE the file is being prepared: a slow
        // metadata read on a multi-GB file (IFD walk), a 5xx mid-pipeline, a
        // proxy hiccup. A single bad poll must NOT drop us to Plotly — a large
        // image always passes through this busy window, so bailing here is why
        // it "always ends up on Plotly". Keep polling until ready or deadline.
        console.warn('[OSD] tiles/info poll retry', err);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
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
    // OSD tiles natively; the diagram's small->large two-pass is a Plotly
    // optimization, so the in-place (large) pass is a no-op once mounted.
    if (inPlace && this.viewer) return Promise.resolve(true);
    this.plotDiv = plotDiv;
    this.currentFileName = imageInfo?.fileName;
    this.descriptor = d;
    this.infoB64 = loaded.infoB64;
    this.currentZ = loaded.z;
    // Use the SAME grayscale flag the colormap dropdown / Plotly use
    // (imageInfo.isGrayscale ← rgbChannels === 1). The descriptor's `channels`
    // (channelCount) diverges from rgbChannels for stacks, which left grayscale
    // stacks un-recolored even though the colormap selector was shown.
    this.isGrayscaleImage = !!imageInfo?.isGrayscale;
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
    // Auto-range grayscale tiles to the image's actual intensity span (like the
    // heatmap), sampling the coarsest tile level so the window matches the raw
    // tile values. Fire-and-forget: it re-invalidates once the window is known;
    // tiles paint unwindowed until then. (Multichannel windows are per-channel,
    // defaulting to full range; the user auto/edits each channel.)
    if (this.isMultiChannel) {
      this.sampler.computeMultiChannelHistograms(d, loaded.infoB64, loaded.z);
    } else {
      this.sampler.computeImageWindow(d, loaded.infoB64, loaded.z);
    }
    this.destroyViewer();
    // Size the slice cache for this image: LRU cap to hold the whole stack
    // (capped) and skip background preloading for stacks too large to preload
    // (would flood full-res reads). Normal stacks keep the flicker-free pre-cache.
    this.cache.configure(d.z ?? 1, coarseTiles);

    // Multichannel opens on channel 0; the open handler swaps in this slice's
    // per-channel group (addChannelSlice) and the background loader pre-fills the
    // rest. Single/RGB/grayscale open their composite source as before.
    const tileSource = this.buildTileSource(
      d, loaded.infoB64, loaded.z, this.isMultiChannel ? 0 : undefined,
    );
    silenceOsdMultiImageAdvisory();
    this.viewer = (OpenSeadragon as any)({
      id: plotDiv,
      // Use the 2D canvas drawer, not WebGL: creating/destroying a viewer on
      // each engine toggle / image load churns WebGL contexts (browsers cap
      // how many exist at once), which surfaces as "WebGL context was lost"
      // and blank tiles. The canvas drawer has no such limit.
      drawer: 'canvas',
      showNavigationControl: false, // avoids needing the icon-image assets
      // Overview thumbnail with the current-viewport rectangle, bottom-right.
      showNavigator: true,
      navigatorPosition: 'BOTTOM_RIGHT',
      navigatorSizeRatio: 0.16,
      navigatorAutoFade: false,
      navigatorBackground: 'rgba(0,0,0,0.5)',
      loadTilesWithAjax: true,
      ajaxWithCredentials: true, // cookie auth (oauth2-proxy)
      ajaxHeaders: this.authHeaders, // bearer auth (Auth0), when available
      crossOriginPolicy: 'Anonymous',
      // Gentler zoom: the default (1.2) feels fast and big jumps cross several
      // pyramid levels at once, firing a burst of tile requests.
      zoomPerScroll: 1.1,
      // Click-to-zoom toward the clicked point (OpenSeadragon's default demo
      // behaviour). Only applies when no region tool is active — an active tool
      // disables OSD mouse-nav so clicks draw/select instead of zooming.
      gestureSettingsMouse: { clickToZoom: true, scrollToZoom: true },
      // Wait for the view to settle before pulling new tiles (less churn).
      immediateRender: false,
      animationTime: 0.4,
      // Release memory aggressively: cap the tile cache so tiles outside the
      // current view (e.g. the coarser levels left behind after zooming in) are
      // evicted instead of accumulating. Large whole-slide tiles — doubled when
      // the colormap pipeline keeps a recolored copy — make an unbounded cache
      // costly. Tunable; lower = less memory, more re-fetch on pan-back.
      // Stacks keep many slices resident (the whole stack is background-loaded),
      // so they get a much larger tile budget — otherwise switching slices evicts
      // each other's tiles and scrubbing back re-fetches. Scaled to the resident
      // slice count; single images keep the lean default.
      maxImageCacheCount: (d.z ?? 1) > 1 ? Math.min(2400, Math.max(600, this.cache.maxSlices() * 40)) : 150,
    });

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
        this.overlay = new OsdRegionOverlay(this.viewer as any, this.regionStore);
        this.coordTransform = new OsdCoordinateTransform(this.viewer as any);
        this.scaleBar = new OsdScaleBar(this.viewer as any, d.mppX ?? 0);
        this.buildToolHosts();
        if (this.isMultiChannel) {
          // Drop the single opened (channel-0) image and add this slice's channel
          // group to the per-slice cache. The shared background loader / LRU then
          // pre-fills the other slices' channel groups so z-scrub is flicker-free.
          try {
            const it0 = (this.viewer as any).world?.getItemAt?.(0);
            if (it0) (this.viewer as any).world.removeItem(it0);
          } catch { /* nothing to remove */ }
          this.cache.addChannelSlice(this.currentZ);
        } else {
          // Seed the slice cache with the just-opened slice (world item 0), so
          // scrubbing back to it later is an instant opacity toggle, not a re-open.
          const firstItem = (this.viewer as any).world?.getItemAt?.(0);
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
        const nav = (this.viewer as any).navigator;
        nav?.addHandler('tile-invalidated', (event: any) => this.recolorTile(event));
        if ((this.isGrayscaleImage && this.colorLut) || this.isMultiChannel) {
          try {
            (this.viewer as any).world.requestInvalidate(true);
          } catch {
            /* no-op */
          }
          try {
            nav?.world?.requestInvalidate(true);
          } catch {
            /* no-op */
          }
        }
        // Prefetch adjacent z-slices once the view settles (and on each settle,
        // so it tracks the current viewport as the user pans/zooms).
        this.viewer!.addHandler('animation-finish', () => this.cache.schedulePrefetch());
        // Tell listeners (the intensity inset) the visible image region whenever
        // the view settles, so they can re-sample at the current zoom resolution.
        this.viewer!.addHandler('animation-finish', () => this.emitViewportChange());
        // Chrome compositor bug: after an OSD zoom the docked toolbar (a sibling of
        // #plot in the <visualization> host) is left laid-out-but-unpainted and
        // vanishes — confirmed via DevTools (DOM intact, region simply not painted).
        // CSS (z-index / isolation / contain) and DOM-reparenting don't fix it; a
        // repaint reliably does. Nudge it each animation frame (so it never visibly
        // drops) and on settle. The synchronous display toggle re-rasters with no
        // visible gone-frame and no layout shift.
        this.viewer!.addHandler('animation', () => this.nudgeToolbarRepaint());
        this.viewer!.addHandler('animation-finish', () => this.nudgeToolbarRepaint());
        this.cache.schedulePrefetch();
        // Force fit-to-view as the split/flex layout settles. A tall
        // non-pyramidal image can otherwise open zoomed-in (image width filling
        // the viewer), making OSD demand slow full-res res=0 tiles for the
        // centre instead of the fast coarse overview → white canvas. goHome
        // fits the whole image so OSD selects the coarse synthetic level. Retry
        // across a few frames because the container may not have its final size
        // on the first frame after 'open'.
        const refit = () => {
          try {
            this.viewer?.viewport.goHome(true);
          } catch {
            /* torn down */
          }
        };
        requestAnimationFrame(refit);
        setTimeout(refit, 150);
        setTimeout(refit, 400);
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
    const ts: any = new (OpenSeadragon as any).TileSource({
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
    const Point = (OpenSeadragon as any).Point;
    ts.getNumTiles = (level: number) => {
      const lvl = levels[resForLevel(level)];
      if (!lvl) return new Point(0, 0);
      return new Point(Math.ceil(lvl.width / t), Math.ceil(lvl.height / t));
    };
    ts.getTileUrl = (level: number, x: number, y: number) =>
      buildTileUrl(base, infoB64, { res: resForLevel(level), col: x, row: y, z, tileSize: t, channel });
    return ts;
  }

  /** Re-apply the display pipeline (window/gamma/colour/invert) after a state change.
   *  Multichannel invalidates ONLY the visible slice's channel images — invalidating
   *  the whole world would re-process every hidden/preloaded slice's tiles (hundreds),
   *  flooding OSD with "[CacheRecord] … InvalidStateError" and wasting work on tiles
   *  that aren't on screen. The other cached slices are marked stale and re-tinted
   *  lazily when revealed. Composite/grayscale invalidate the world as before. */
  private invalidateDisplay(): void {
    const v: any = this.viewer;
    if (!v) return;
    if (this.isMultiChannel) {
      this.cache.invalidateChannelDisplay(this.currentZ);
      return;
    }
    try { v.world.requestInvalidate(true); } catch { /* no-op */ }
    try { v.navigator?.world?.requestInvalidate(true); } catch { /* no-op */ }
  }

  private destroyViewer(): void {
    this.cache.cancelBackgroundLoad();
    // Tear down any active tool overlays (shared singletons).
    this.wandTool.setMode(false);
    this.eraserTool.setMode(false);
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

  /** OSD renders only the image type — no LINE intensity ROIs, so no controls. */
  getIntensityControls(): IIntensityControls | null {
    return null;
  }

  private toOverlayMode(mode: string | false): RegionToolMode {
    switch (mode) {
      case 'drawrect':
        return 'drawrect';
      case 'drawclosedpath':
        return 'drawclosedpath';
      case 'drawopenpath':
        return 'drawopenpath';
      case 'drawpolygon':
        return 'drawpolygon';
      case 'addpoint':
        return 'addpoint';
      case 'deletepoint':
        return 'deletepoint';
      case 'move':
        return 'move';
      case 'select':
        return 'select';
      default:
        return 'none';
    }
  }

  reloadAndPlot(): void {
    /* host re-drives plot() via the image-info stream */
  }
  reset(): void {
    this.destroyViewer();
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
    const restore = () => {
      try {
        this.viewer?.viewport.fitBounds(bounds, true);
        this.viewer?.viewport.applyConstraints(true);
      } catch {
        /* viewer torn down */
      }
    };
    requestAnimationFrame(restore);
    setTimeout(restore, 350);
  }
  resetAxes(): void {
    this.viewer?.viewport.goHome();
  }
  autoscale(): void {
    this.viewer?.viewport.goHome();
    this.autoscaleEvent$.next('autoscale');
  }
  zoomIn(): void {
    this.viewer?.viewport.zoomBy(1.3);
    this.viewer?.viewport.applyConstraints();
  }
  zoomOut(): void {
    this.viewer?.viewport.zoomBy(1 / 1.3);
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

  /**
   * Swap the displayed z-slice live. Slices are kept as separate tiled images in
   * the world, so switching is just an opacity toggle: a previously-visited slice
   * shows instantly (its decoded + recolored tiles are still resident), and a
   * never-seen slice is added once. The region overlay, coordinate transform,
   * scale bar, colormap pipeline and current zoom/pan all persist — the x/y
   * geometry is identical across slices.
   */
  setZIndex(zIndex: number): void {
    const z = zIndex || 0;
    if (z === this.currentZ) return;
    if (!this.viewer || !this.descriptor || !this.infoB64) return;
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
    return this.stackLoadingProgress$.asObservable();
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
    const canvas: HTMLCanvasElement | undefined = (this.viewer as any)?.drawer?.canvas;
    if (!canvas || !canvas.width || !canvas.height) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const { width, height } = canvas;
    const img = ctx.getImageData(0, 0, width, height);
    return { width, height, channels: 4, data: img.data };
  }
  downloadImage(): void {
    // The toolbar download and the Channels & Histogram export both produce the
    // composited PNG.
    void this.exportComposite();
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

  getAutoscaleEvent(): Observable<any> {
    return this.autoscaleEvent$.asObservable();
  }

  /** Visible image region (full-image pixel coords), emitted when the view
   *  settles. The intensity inset re-samples this region at the zoom resolution. */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.viewportChange$.asObservable();
  }

  /** Compute the current viewport's image-pixel rectangle (clamped to the image)
   *  and broadcast it. */
  private emitViewportChange(): void {
    const vp: any = this.viewer?.viewport;
    if (!vp || !this.descriptor) return;
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
      this.viewportChange$.next({ x, y, width, height });
    } catch {
      /* viewport not ready */
    }
  }

  /** OSD targets the image display; the scalar/3D plot types belong to Plotly. */
  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    return [PLOT_TYPE_DESCRIPTORS[PlotType.HEATMAP]!];
  }

  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.intensityProfile$.asObservable();
  }
  /** OSD only renders the image type; the LINE intensity inset is Plotly-only. */
  renderIntensityInset(_divId: string, _profiles: IntensityProfile[]): void {
    /* no LINE mode on OSD */
  }

  // ── IRegionStore ─────────────────────────────────────────────────────
  // All region state is owned by the shared RegionStore — the single source of
  // truth both backends delegate to. The OSD region overlay (constructed in
  // plot()) reads/writes the same store, so regions stay in sync with Plotly
  // and the Region Editor. OSD renders regions as an SVG overlay (its own
  // representation) rather than carrying Plotly shape dicts.
  setRegions(regions: Region[], showRegionLabel?: boolean, isRegionSaveOn?: boolean,
             fillColor?: string, append?: boolean): void {
    this.regionStore.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
  }
  getRegions(): Region[] {
    return this.regionStore.getRegions();
  }
  getRegionPolygons(): any[] {
    return this.regionStore.getRegionPolygons();
  }
  getRegionUpdateEvent(): Observable<any[]> {
    return this.regionStore.getRegionUpdateEvent();
  }

  setSelectedShapeIndices(indices: number[]): void {
    this.regionStore.setSelectedShapeIndices(indices);
  }
  /** Select a region by identity. The overlay highlights the matching SVG
   *  element via its getSelectedShapeIndices$ subscription. */
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

  plotPreviousShapes(): void {
    this.regionStore.plotPreviousShapes();
  }
  setPreviousShapes(shapes: any[]): void {
    this.regionStore.setPreviousShapes(shapes);
  }
  getPreviousShapes(): any[] {
    return this.regionStore.getPreviousShapes();
  }

  importRegions(geoJsonStr: string): Region[] {
    return this.regionStore.importRegions(geoJsonStr);
  }
  exportRegions(regions: Region[]): void {
    this.regionStore.exportRegions(regions);
  }
  getGeoJsonString(regions: Region[]): string {
    return this.regionStore.getGeoJsonString(regions);
  }

  // ── IToolController ──────────────────────────────────────────────────
  // Wand + vertex eraser run over OSD via ICoordinateTransform. They share the
  // singleton tool services with Plotly, so we re-bind to our hosts on activate.
  setWandMode(active: boolean, options?: any): void {
    if (!active) {
      this.wandTool.setMode(false);
      return;
    }
    // Take the pointer from OSD so the drag draws instead of panning. (Nav is
    // re-enabled when the region overlay returns to 'none' on tool switch.)
    this.viewer?.setMouseNavEnabled(false);
    // The wand samples the rendered viewport — read back lazily on first use.
    this.viewportPixels = null;
    this.wandTool.bindHost(this.wandHost);
    this.wandTool.setMode(true, (options ?? {}) as WandOptions);
  }
  setWandOptions(options: any): void {
    this.wandTool.setOptions(options as WandOptions);
  }
  clearActiveWandRegion(): void {
    this.wandTool.clearActiveRegion();
  }
  setVertexEraserMode(active: boolean): void {
    if (active) {
      this.viewer?.setMouseNavEnabled(false); // tool takes the pointer
      this.viewportPixels = null;
      this.eraserTool.bindHost(this.eraserHost);
    }
    this.eraserTool.setMode(active);
  }
  setVertexEraserRadius(radius: number): void {
    this.eraserTool.setRadius(radius);
  }
  setZoomToBoxMode(active: boolean): void {
    if (active) {
      this.viewer?.setMouseNavEnabled(false); // the box drag must not pan
      this.zoomToBoxTool.bindHost(this.zoomBoxHost());
    }
    this.zoomToBoxTool.setMode(active);
    if (!active) this.viewer?.setMouseNavEnabled(true);
  }

  /** Build the wand/eraser host objects bound to this backend. Both tools run
   *  over OSD via the shared coordinate transform + a viewport pixel readback,
   *  and read/write regions directly on the shared RegionStore (neutral model). */
  private buildToolHosts(): void {
    this.wandHost = {
      getRegions: () => this.regionStore.getRegions(),
      setRegions: (regions) => this.regionStore.setRegions(regions),
      getCachedImageData: () => this.readbackViewport(),
      getActiveFrameIndex: () => this.currentZ,
      getOverlayContainer: () => this.getOverlayContainer(),
      getCoordinateTransform: () => this.coordTransform as ICoordinateTransform,
      getFileName: () => this.currentFileName,
      getShapeColor: () => this.regionStore.getShapeColor(),
    };
    this.eraserHost = {
      getRegions: () => this.regionStore.getRegions(),
      setRegions: (regions) => this.regionStore.setRegions(regions),
      invalidateWandRegion: () => this.wandTool.clearActiveRegion(),
      getOverlayContainer: () => this.getOverlayContainer(),
      getCoordinateTransform: () => this.coordTransform as ICoordinateTransform,
      getCachedImageRatio: () => this.readbackViewport()?.ratios[0] ?? 1,
    };
  }

  /** The element the on-canvas tool overlays attach to (OSD is mounted here). */
  private getOverlayContainer(): HTMLElement | null {
    return this.plotDiv ? document.getElementById(this.plotDiv) : null;
  }

  /** Force the docked toolbar to repaint after an OSD zoom. Chrome leaves it
   *  laid-out-but-unpainted (the canvas's compositing churn strands the toolbar's
   *  raster). A synchronous display toggle re-rasters it with no visible gone-frame
   *  and no layout shift. Located via the DOM since this service doesn't own the
   *  toolbar; a no-op when there's no toolbar (e.g. embedded without one). */
  private nudgeToolbarRepaint(): void {
    const plotEl = this.plotDiv ? document.getElementById(this.plotDiv) : null;
    const dock = plotEl?.closest('visualization')?.querySelector<HTMLElement>('.toolbar-dock');
    if (!dock) return;
    const prev = dock.style.display;
    dock.style.display = 'none';
    void dock.offsetHeight; // reflow so the toggle re-rasters on the next paint
    dock.style.display = prev;
  }

  /** Host for the (shared) zoom-to-box tool: convert overlay pixels to image
   *  coords via the viewport, and fit the viewport to the chosen rectangle. */
  private zoomBoxHost(): ZoomToBoxToolHost {
    return {
      getPlotDiv: () => this.plotDiv,
      pixelToData: (px: number, py: number) => elementToImage(this.viewer, px, py),
      applyZoomToBox: (coords: number[]) => this.applyZoomToBox(coords),
    };
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
   * Read back the *currently rendered* OSD canvas as the wand's pixel matrix.
   * The matrix covers only the visible viewport at screen resolution, so when
   * the user is zoomed into a sub-region the wand samples that region's detail
   * (rather than the whole image at preview resolution). `originX/originY` and
   * `ratios` map image coords <-> readback-pixel coords for the wand's
   * data/ratio/origin model. Cached until the viewport changes.
   */
  private readbackViewport(): CachedImageData | null {
    if (this.viewportPixels) return this.viewportPixels;
    const viewer = this.viewer as any;
    const canvas: HTMLCanvasElement | undefined = viewer?.drawer?.canvas;
    const vp = viewer?.viewport;
    if (!canvas || !canvas.width || !canvas.height || !vp) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const w = canvas.width; // device pixels
    const h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data; // RGBA, row-major
    // Build the [y][x] = [r,g,b] matrix the wand expects for RGB frames.
    const matrix: number[][][] = new Array(h);
    for (let y = 0; y < h; y++) {
      const row: number[][] = new Array(w);
      const base = y * w * 4;
      for (let x = 0; x < w; x++) {
        const o = base + x * 4;
        row[x] = [data[o], data[o + 1], data[o + 2]];
      }
      matrix[y] = row;
    }

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
      frames: [matrix],
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
    const gray = this.isGrayscaleImage;
    if (gray) {
      if (!this.colorLut) return;
    } else if (!this.display.rgbNeedsRecolor()) {
      return; // RGB at default (all visible, full window, γ=1, no invert) → passthrough
    }

    // Read the tile's pixels. Prefer the rendering context, but some tile caches
    // (ajax PNG blobs) convert to an *empty* context2d — recoloring that would
    // blank the tile (white canvas). So if the context has no opaque pixels, draw
    // the tile's own bitmap/image and recolor that instead. We never write back
    // unless we actually recolored something, so a tile is never blanked.
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = await event.getData('context2d');
    } catch {
      /* try bitmap below */
    }
    let img: ImageData | null = null;
    if (ctx && ctx.canvas && ctx.canvas.width && ctx.canvas.height) {
      try {
        img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      } catch {
        img = null;
      }
    }
    if (!img || !this.hasOpaque(img.data)) {
      // Fall back to the tile's decoded image/bitmap.
      let src: any = null;
      try {
        src = await event.getData('imageBitmap');
      } catch {
        /* none */
      }
      if (!src || !src.width) {
        try {
          src = await event.getData('image');
        } catch {
          /* none */
        }
      }
      if (!src || !src.width) return; // can't get pixels — leave the tile untouched
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(src, 0, 0);
      img = ctx.getImageData(0, 0, c.width, c.height);
    }

    if (!this.display.applyToRgba(img.data) || !ctx) return; // nothing opaque
    ctx.putImageData(img, 0, 0);
    // The tile's cache can be evicted between the awaits above and here (slice
    // change / invalidation), making setData throw a DOMException on a dead
    // canvas. Swallow it — the tile is gone, so there's nothing to recolor.
    try { await event.setData(ctx, 'context2d'); } catch { /* tile evicted */ }
  }

  /**
   * Tint a single channel's tile in place. Each channel is its own OpenSeadragon
   * TiledImage (a single-band grayscale tile); OSD composites the N images
   * additively ('lighter') in its drawer — so this just maps the tile's intensity
   * through the channel's window/gamma and its pseudo-colour. Synchronous (no
   * cross-tile fetch) → no race, no seams. Channel is parsed from the tile URL.
   */
  private async recolorChannelTile(event: any): Promise<void> {
    const tile = event?.tile;
    const url: string = (tile && (typeof tile.getUrl === 'function' ? tile.getUrl() : tile.url)) || '';
    const m = /[?&]channel=(\d+)/.exec(url);
    const ch = m ? parseInt(m[1], 10) : 0;
    const st = this.channelStates[ch];

    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = await event.getData('context2d'); } catch { /* fallback below */ }
    let img: ImageData | null = null;
    if (ctx && ctx.canvas && ctx.canvas.width && ctx.canvas.height) {
      try { img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height); } catch { img = null; }
    }
    if (!img || !this.hasOpaque(img.data)) {
      let src: any = null;
      try { src = await event.getData('imageBitmap'); } catch { /* none */ }
      if (!src || !src.width) { try { src = await event.getData('image'); } catch { /* none */ } }
      if (!src || !src.width) return;
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(src, 0, 0);
      img = ctx.getImageData(0, 0, c.width, c.height);
    }
    if (!ctx) return;

    // Precompute lum(0..255) → tinted RGB once, then map each pixel by lookup —
    // the channel tile is single-band, so this turns ~262k per-pixel
    // channelIntensity() (with Math.pow for gamma) calls into 256 — the difference
    // between a snappy and a sluggish slider on a 4-channel stack.
    const { r: rL, g: gL, b: bL } = this.display.channelRgbLut(st);
    const d = img.data;
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
    ctx.putImageData(img, 0, 0);
    // See recolorTile: the tile cache can die between the awaits and here.
    try { await event.setData(ctx, 'context2d'); } catch { /* tile evicted */ }
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
    const all = this.channelStates.length;
    // Omit `channels` when every channel is visible (server default = all).
    const chParam =
      visible.length && visible.length < all ? `&channels=${visible.join(',')}` : '';
    const url = `${this.api}export/tiff?info=${this.infoB64}&z=${this.currentZ}${chParam}`;
    const stem = (this.currentFileName || 'image').replace(/\.[^.]+$/, '');
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
      if (blob) saveAs(blob, `${stem}_16bit.ome.tif`);
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
   */
  async exportComposite(): Promise<void> {
    const desc = this.descriptor;
    const levels = desc?.levels ?? [];
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
    const jobs: Promise<void>[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const url = buildTileUrl(this.api, this.infoB64, { res, col, row, z, tileSize: t });
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
    try {
      const imageData = ctx.getImageData(0, 0, lw, lh);
      if (this.display.applyToRgba(imageData.data)) ctx.putImageData(imageData, 0, 0);
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
  // Colormap / metadata state is shared (the VisualizerStore) so OSD and Plotly
  // stay in lock-step; OSD applies the colormap to grayscale tiles via the LUT
  // (see the constructor sub).
  getColormap(): Observable<any> {
    return this.store.getColormap();
  }
  setColormap(colormap: any): void {
    this.store.setColormap(colormap);
  }
  getColormapOptions(): any {
    return this.store.getColormapOptions();
  }
  getReverseScale(): Observable<boolean> {
    return this.store.getReverseScale();
  }
  setReverseScale(reverscale: any): void {
    this.store.setReverseScale(reverscale);
  }
  setImageMeta(imageMeta: IImageMetadata[]): void {
    this.store.setImageMeta(imageMeta);
  }
  getImageMeta(): Observable<IImageMetadata[]> {
    return this.store.getImageMeta();
  }

  // ── IVisualizer ──────────────────────────────────────────────────────
  unsubscribe(): void {
    this.colormapSub?.unsubscribe();
    this.colormapSub = null;
    this.destroyViewer();
  }
}
