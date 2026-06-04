import { Injectable, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, Subscription, combineLatest, firstValueFrom } from 'rxjs';
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
import { CachedImageData, WandToolService, WandToolHost } from '../../toolbar/wand-tool.service';
import { VertexEraserToolService, VertexEraserToolHost } from '../../toolbar/vertex-eraser-tool.service';
import { ZoomToBoxToolService, ZoomToBoxToolHost } from '../../toolbar/zoom-to-box-tool.service';
import { WandOptions } from '../../toolbar/wand.service';
import { buildColormapLut, Rgb } from '../../contracts/colormap-lut';

/** One pyramid level from `GET /tiles/info`. */
interface TileLevel { res: number; width: number; height: number; }

/** Tile-source descriptor returned by `GET /tiles/info`. */
interface TileDescriptor {
  width: number;
  height: number;
  tileSize: number;
  z: number;
  channels: number;
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
  /** Per-image intensity window [min,max] used to auto-range grayscale tiles
   *  before the LUT lookup, mirroring the heatmap's auto-stretch. Computed once
   *  per image from the coarsest overview tile (see computeImageWindow). Null =
   *  no windowing (identity 0..255), e.g. RGB images or before it resolves. */
  private imageWindow: [number, number] | null = null;
  private colormapSub: Subscription | null = null;
  /** Bearer token for OSD's own tile fetches (HttpClient calls get it via the
   *  interceptor; OSD's loader does not, so we pass it as an ajax header). */
  private authHeaders: Record<string, string> = {};

  /** Overall deadline for the /tiles/info poll loop. An uncached whole-slide
   *  image (e.g. .ndpi) is cached server-side first (GCS->PVC), which can take
   *  several minutes — we poll (short requests; the cache-progress overlay
   *  shows the wait) until it's ready. Generous because each poll is cheap; on
   *  expiry the render pipeline gives up and the router falls back to Plotly. */
  private readonly tilesInfoTimeoutMs = 600000; // 10 min

  private prefetchTimer: any = null;

  constructor(
    private http: HttpClient,
    @Inject(TILE_ACCESS_PORT) private tiles: TileAccessPort,
    private wandTool: WandToolService,
    private eraserTool: VertexEraserToolService,
    private zoomToBoxTool: ZoomToBoxToolService,
    private session: VisualizerStore,
    private regionStore: RegionStore,
    @Inject(VIZ_CONFIG) config: VizConfig,
  ) {
    this.api = config.slideCropServer;
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

  private warned = new Set<string>();
  private notImplemented(method: string): void {
    if (!this.warned.has(method)) {
      this.warned.add(method);
      console.warn(`[OpenSeadragonVisualizerService] ${method}() is a stub — not implemented yet.`);
    }
  }

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
    this.colormapSub = combineLatest([this.session.getColormap(), this.session.getReverseScale()]).subscribe(
      ([cm, rev]) => {
        this.colorLut = buildColormapLut(cm?.data?.value, !!rev);
        // Already-loaded tiles need a re-run; new tiles run the pipeline on load.
        // requestInvalidate(true) restores each tile to its original (grayscale)
        // data before re-running recolorTile, so a colormap change always maps
        // intensity->LUT afresh rather than compounding the previous colors.
        if (this.viewer && this.isGrayscaleImage) {
          try {
            (this.viewer as any).world.requestInvalidate(true);
          } catch {
            /* no-op */
          }
          // Re-run the recolor pipeline on the overview navigator too, so the
          // minimap updates in lock-step with the main image.
          try {
            (this.viewer as any).navigator?.world?.requestInvalidate(true);
          } catch {
            /* no-op */
          }
        }
      },
    );
  }

  /**
   * Compute a per-image intensity window [min,max] for grayscale auto-ranging,
   * mirroring the heatmap's auto-stretch. Two constraints force the sampling
   * strategy:
   *  - The window MUST be in the same value space as the displayed tiles: the
   *    `/preview` endpoint is server-normalized (e.g. a 16-bit DICOM stretched to
   *    0..240) while `/tile` serves raw un-normalized Bio-Formats 8-bit (the same
   *    DICOM collapsed to 0..6) — so a window from the preview wouldn't match.
   *  - It must read FULL-RESOLUTION tiles, not a downsampled overview: averaging
   *    sparse low values (label masks: 0,1,2 over mostly-0 background) toward 0
   *    wipes the signal (the coarsest level came back all-zero for masks).
   * So we sample the full-res level (res 0) across the whole image — bounded to
   * 64 tiles (small masks/DICOM are a handful; a huge grayscale image is skipped
   * rather than flooding the network). A single corner tile misses centred mask
   * content, hence the full grid. A per-image window is seamless across tiles.
   * Fire-and-forget; on resolve we re-invalidate so already-painted tiles pick it
   * up. Failures leave it null (identity 0..255).
   */
  private async computeImageWindow(d: TileDescriptor, infoB64: string, z: number): Promise<void> {
    this.imageWindow = null;
    if (!this.isGrayscaleImage) return; // RGB images render untouched
    try {
      const res = 0; // full resolution — preserves raw tile values (no averaging)
      const t = d.tileSize;
      const cols = Math.max(1, Math.ceil(d.width / t));
      const rows = Math.max(1, Math.ceil(d.height / t));
      if (cols * rows > 64) return; // huge image — skip rather than flood the network
      const coords: Array<[number, number]> = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) coords.push([col, row]);
      }
      let min = 255;
      let max = 0;
      await Promise.all(
        coords.map(async ([col, row]) => {
          const url = `${this.api}tile?info=${infoB64}&res=${res}&col=${col}&row=${row}&z=${z}&tileSize=${t}`;
          try {
            const blob = await firstValueFrom(this.http.get(url, { responseType: 'blob' }).pipe(timeout(20000)));
            const bmp = await createImageBitmap(blob);
            const c = document.createElement('canvas');
            c.width = bmp.width;
            c.height = bmp.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(bmp, 0, 0);
            bmp.close?.();
            const data = ctx.getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] === 0) continue; // skip transparent padding
              const v =
                data[i] >= data[i + 1]
                  ? data[i] >= data[i + 2] ? data[i] : data[i + 2]
                  : data[i + 1] >= data[i + 2] ? data[i + 1] : data[i + 2];
              if (v < min) min = v;
              if (v > max) max = v;
            }
          } catch {
            /* skip this tile */
          }
        }),
      );
      // Only keep a window that actually narrows the range; a full 0..255 image
      // maps identically anyway, so skip it to avoid pointless re-invalidation.
      if (max > min && (min > 0 || max < 255)) {
        this.imageWindow = [min, max];
        if (this.viewer && this.colorLut) {
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
    } catch {
      this.imageWindow = null; // fall back to identity 0..255
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
    // Auto-range grayscale tiles to the image's actual intensity span (like the
    // heatmap), sampling the coarsest tile level so the window matches the raw
    // tile values. Fire-and-forget: it re-invalidates once the window is known;
    // tiles paint unwindowed until then.
    this.computeImageWindow(d, loaded.infoB64, loaded.z);
    this.destroyViewer();

    const tileSource = this.buildTileSource(d, loaded.infoB64, loaded.z);
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
      maxImageCacheCount: 150,
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
        if (this.isGrayscaleImage && this.colorLut) {
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
        this.viewer!.addHandler('animation-finish', () => this.schedulePrefetch());
        // Tell listeners (the intensity inset) the visible image region whenever
        // the view settles, so they can re-sample at the current zoom resolution.
        this.viewer!.addHandler('animation-finish', () => this.emitViewportChange());
        this.schedulePrefetch();
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
  private buildTileSource(d: TileDescriptor, infoB64: string, z: number): any {
    const n = d.levels.length;
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
      const lvl = d.levels[resForLevel(level)];
      return lvl ? lvl.width / d.width : 1;
    };
    ts.getTileUrl = (level: number, x: number, y: number) =>
      `${base}tile?info=${infoB64}&res=${resForLevel(level)}&col=${x}&row=${y}&z=${z}&tileSize=${t}`;
    return ts;
  }

  /** Build a tile URL for an explicit (level, x, y, z) — used by prefetch. */
  private tileUrl(infoB64: string, level: number, x: number, y: number, z: number): string {
    const d = this.descriptor!;
    const res = d.levels.length - 1 - level;
    return `${this.api}tile?info=${infoB64}&res=${res}&col=${x}&row=${y}&z=${z}&tileSize=${d.tileSize}`;
  }

  /**
   * Warm the tile cache for the adjacent z-slices (z±1) over the *current
   * viewport*, so scrubbing the stack loads near-instantly. Fire-and-forget;
   * 404s/errors are ignored. Debounced via schedulePrefetch.
   *
   * Yields to the current view: while the visible slice isn't fully loaded yet,
   * it reschedules instead of fetching, so the on-screen tiles (which OSD loads
   * lowest-resolution-first, viewport-only, thanks to immediateRender:false)
   * always win the connection over background neighbor-slice prefetch.
   */
  private prefetchNeighborSlices(): void {
    const viewer: any = this.viewer;
    if (!viewer || !this.descriptor || !this.infoB64) return;
    const sliceCount = this.descriptor.z ?? 1;
    if (sliceCount <= 1) return; // not a stack — nothing to prefetch
    const item = viewer.world?.getItemAt?.(0);
    if (!item) return;
    if (typeof item.getFullyLoaded === 'function' && !item.getFullyLoaded()) {
      // Current view still loading — defer so we don't compete with it.
      this.schedulePrefetch();
      return;
    }
    const drawn: any[] = item.getTilesToDraw?.() ?? [];
    const tiles = drawn.map((i) => i?.tile).filter(Boolean);
    if (!tiles.length) return;
    const neighbors = [this.currentZ - 1, this.currentZ + 1].filter((z) => z >= 0 && z < sliceCount);
    const seen = new Set<string>();
    for (const z of neighbors) {
      for (const t of tiles) {
        const url = this.tileUrl(this.infoB64, t.level, t.x, t.y, z);
        if (seen.has(url)) continue;
        seen.add(url);
        // Warm the browser + server cache; we don't use the body.
        fetch(url, { headers: this.authHeaders, credentials: 'include' }).catch(() => {
          /* ignore */
        });
      }
    }
  }

  /** Debounce prefetch so a burst of viewport events fires it once. */
  private schedulePrefetch(): void {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      this.prefetchNeighborSlices();
    }, 400);
  }

  private destroyViewer(): void {
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
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
    this.viewer?.viewport.goHome(true);
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
   * Swap the displayed z-slice live. Rebuilds the tile source for the new z and
   * re-opens it on the existing viewer (no full re-mount), so the region
   * overlay, coordinate transform, scale bar and colormap pipeline all persist —
   * the x/y geometry is identical across slices. New tiles recolor on load.
   */
  setZIndex(zIndex: number): void {
    const z = zIndex || 0;
    if (z === this.currentZ) return;
    this.currentZ = z;
    if (!this.viewer || !this.descriptor || !this.infoB64) return;
    this.viewportPixels = null; // wand readback is slice-specific
    const ts = this.buildTileSource(this.descriptor, this.infoB64, z);
    const vp: any = (this.viewer as any).viewport;
    // Keep the current zoom/pan across slices — scrubbing a zoomed-in stack
    // should stay on the same ROI rather than snapping back to full view.
    const bounds = vp?.getBounds ? vp.getBounds() : null;
    try {
      (this.viewer as any).addOnceHandler('open', () => {
        if (bounds) {
          try {
            vp.fitBounds(bounds, true);
          } catch {
            /* viewport gone */
          }
        }
        this.schedulePrefetch(); // warm the new current slice's neighbors
      });
      (this.viewer as any).open(ts);
    } catch (err) {
      console.warn('[OSD] failed to swap z-slice', err);
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
    this.notImplemented('downloadImage');
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
      const r = vp.viewportToImageRectangle(vp.getBounds(true));
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
    return this.session.getClassificationColors();
  }
  setClassificationColor(label: string, color: string): void {
    this.session.setClassificationColor(label, color);
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

  /** Host for the (shared) zoom-to-box tool: convert overlay pixels to image
   *  coords via the viewport, and fit the viewport to the chosen rectangle. */
  private zoomBoxHost(): ZoomToBoxToolHost {
    const osd = OpenSeadragon as any;
    return {
      getPlotDiv: () => this.plotDiv,
      pixelToData: (px: number, py: number) => {
        const img = this.viewer!.viewport.viewerElementToImageCoordinates(new osd.Point(px, py));
        return { x: img.x, y: img.y };
      },
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
    const osd = OpenSeadragon as any;
    const rect = this.viewer.viewport.imageToViewportRectangle(new osd.Rect(x, y, w, h));
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

    // Image-coord span the readback covers (CSS px in, image coords out).
    const osd = OpenSeadragon as any;
    const elW = canvas.clientWidth || w;
    const elH = canvas.clientHeight || h;
    const tl = vp.viewerElementToImageCoordinates(new osd.Point(0, 0));
    const br = vp.viewerElementToImageCoordinates(new osd.Point(elW, elH));
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
    const lut = this.colorLut;
    if (!lut || !this.isGrayscaleImage) {
      return;
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

    const d = img.data;
    let changed = false;
    // Per-image auto-range (window/level), mirroring the heatmap's auto-stretch:
    // map the raw value through [min,max] before the LUT so low-range images
    // (label masks 0,1,2; un-normalized DICOM) spread across the colormap
    // instead of collapsing onto a single flat LUT entry. A per-image window
    // (not per-tile) keeps it seamless across tiles. Null → identity 0..255.
    const win = this.imageWindow;
    const wMin = win ? win[0] : 0;
    const wSpan = win && win[1] > win[0] ? win[1] - win[0] : 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue; // leave transparent padding alone
      // Intensity from the brightest channel, not just red: a single-channel
      // grayscale tile has r==g==b (so this == r), but a multi-channel
      // "grayscale" image (channelCount > 1) renders its signal into green/blue
      // with red == 0 — reading red alone would map every pixel to lut[0]
      // (a flat white/blue canvas).
      const raw =
        d[i] >= d[i + 1] ? (d[i] >= d[i + 2] ? d[i] : d[i + 2]) : d[i + 1] >= d[i + 2] ? d[i + 1] : d[i + 2];
      let v = raw;
      if (wSpan) {
        v = Math.round((255 * (raw - wMin)) / wSpan);
        v = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      const c = lut[v];
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      changed = true;
    }
    if (!changed || !ctx) return; // nothing opaque — don't blank the tile
    ctx.putImageData(img, 0, 0);
    await event.setData(ctx, 'context2d');
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
    return this.session.getColormap();
  }
  setColormap(colormap: any): void {
    this.session.setColormap(colormap);
  }
  getColormapOptions(): any {
    return this.session.getColormapOptions();
  }
  getReverseScale(): Observable<boolean> {
    return this.session.getReverseScale();
  }
  setReverseScale(reverscale: any): void {
    this.session.setReverseScale(reverscale);
  }
  setImageMeta(imageMeta: IImageMetadata[]): void {
    this.session.setImageMeta(imageMeta);
  }
  getImageMeta(): Observable<IImageMetadata[]> {
    return this.session.getImageMeta();
  }

  // ── IVisualizer ──────────────────────────────────────────────────────
  unsubscribe(): void {
    this.colormapSub?.unsubscribe();
    this.colormapSub = null;
    this.destroyViewer();
  }
}
