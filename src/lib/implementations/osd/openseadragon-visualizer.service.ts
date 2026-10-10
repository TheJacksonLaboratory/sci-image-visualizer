import { Injectable, Inject, Optional } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, Observable, of } from 'rxjs';
import { Image } from 'image-js';
import * as OpenSeadragon from 'openseadragon';
import { OSD, quiet } from './osd-lib';
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
import { OsdViewportAdapter } from './osd-viewport';
import { OsdNavigatorChrome } from './osd-navigator-chrome';
import { PlotModeViewport } from '../../contracts/plot-type-contribution.contract';
import { elementToImage } from './osd-coords';
import { buildOsdTileSource, planTiledMount } from './osd-tile-source';
import { SliceCache } from './slice-cache';
import { OsdTileRecolorer } from './tile-recolor';
import { OsdLoaded, OsdSimpleSource } from './simple-source';
import { readDrawerPixels, readbackViewportFrame, saveDrawerSnapshot } from './osd-pixel-readback';
import { fetchTiffExport, fileStem, renderCompositePng } from './osd-export';
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
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { ICellSegmenter, CELL_SEGMENTER } from '../../contracts/cell-segmenter.contract';

import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { saveAs } from 'file-saver';

/** Wait between two `/tiles/info` polls while the server answers 202. */
const OSD_TILES_INFO_POLL_INTERVAL_MS = 1500;

/** The drag modes the SVG region overlay handles itself (see setDragMode). */
const OVERLAY_MODES = new Set<RegionToolMode>([
  'drawrect', 'drawclosedpath', 'drawopenpath', 'drawpolygon', 'addpoint', 'deletepoint', 'move', 'select',
]);

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
  /** Only grayscale images get a colormap (RGB tiles pass through untouched). */
  private isGrayscaleImage = false;
  /** True for multichannel fluorescence (channelCount > 1, not RGB): tiles are
   *  composited client-side from per-channel single-band fetches (see
   *  recolorMultiChannelTile) rather than recolored in place. */
  private isMultiChannel = false;
  /** Count of real Bio-Formats resolution levels (per-channel tiles exist only
   *  here). For multichannel images the tile source is built from these alone so
   *  every displayed tile supports a per-channel fetch. */
  private realLevels = 0;
  /** Bearer token for OSD's own tile fetches (HttpClient calls get it via the
   *  interceptor; OSD's loader does not, so we pass it as an ajax header). */
  private authHeaders: Record<string, string> = {};
  /** Navigator, smoothing, initial fit and the toolbar repaint workaround
   *  (see OsdNavigatorChrome). */
  private readonly chrome = new OsdNavigatorChrome({
    viewer: () => this.viewer,
    plotDiv: () => this.plotDiv,
  });

  /** Overall deadline for the /tiles/info poll loop. An uncached whole-slide
   *  image (e.g. .ndpi) is cached server-side first (GCS->PVC), which can take
   *  several minutes — we poll (short requests; the cache-progress overlay
   *  shows the wait) until it's ready. Generous because each poll is cheap; on
   *  expiry the render pipeline gives up and the router falls back to Plotly.
   *  (napari-js waits less — it falls back to a single tile, not a backend.) */
  private readonly tilesInfoTimeoutMs = 600000; // 10 min


  /** Window/gamma/colormap/invert and per-channel tints, applied to the tiles
   *  through OSD's pixel pipeline (see OsdTileRecolorer and the README's recolor
   *  invariant). Its DisplayPipeline also drives the compositor and the export. */
  private readonly recolor: OsdTileRecolorer = new OsdTileRecolorer({
    viewer: () => this.viewer,
    isGrayscale: () => this.isGrayscaleImage,
    isMultiChannel: () => this.isMultiChannel,
    isSimpleMultichannel: () => this.simple.multichannel,
    currentZ: () => this.currentZ,
    revealChannelSlice: (z) => this.cache.revealChannelSlice(z),
    invalidateChannelDisplay: (z) => this.cache.invalidateChannelDisplay(z),
    recomposite: (token) => void this.simple.recompositeAndOpen(token),
  }, this.store);

  /** The serverless (`tiled: false`) image source and all its state (see
   *  OsdSimpleSource). */
  private readonly simple: OsdSimpleSource = new OsdSimpleSource({
    viewer: () => this.viewer,
    descriptor: () => this.descriptor,
    isGrayscale: () => this.isGrayscaleImage,
    currentZ: () => this.currentZ,
    setCurrentZ: (z) => {
      this.currentZ = z;
      this.viewportPixels = null; // the readback is slice-specific
    },
    sampler: () => this.sampler,
    display: () => this.recolor.display,
    channelStates: () => this.store.currentChannelStates(),
    isCurrentDisplay: (token) => this.recolor.isCurrent(token),
    scheduleInvalidate: () => this.recolor.scheduleInvalidate(),
  }, this.simpleStack);

  /** Histogram + auto-window sampling (see HistogramSampler). Constructed in
   *  the ctor body because it captures the resolved API base URL. */
  private sampler!: HistogramSampler;

  /** Stack-slice cache + background preloader (see SliceCache — refactoring
   *  plan Step 3). The host accessors are live closures, so the cache always
   *  reads the service's current viewer/descriptor/z — exactly the fields the
   *  moved code used to read directly. */
  private readonly cache: SliceCache = new SliceCache({
    viewer: () => this.viewer,
    hasImage: () => !!(this.viewer && this.descriptor && this.infoB64),
    sliceCount: () => this.descriptor?.z ?? 1,
    currentZ: () => this.currentZ,
    isMultiChannel: () => this.isMultiChannel,
    channelCount: () => Math.max(1, this.recolor.channelStates.length || (this.descriptor?.channels ?? 1)),
    channelVisible: (c: number) => this.recolor.channelStates[c]?.visible !== false,
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
      applyZoomToBox: (coords) => this.viewport.applyZoomToBox(coords),
    };
    this.canvasTools = createCanvasToolManager(this.toolHost, {
      wandService, regionStore, samPoint: samPointTool,
    });
    this.api = config.slideCropServer;
    this.sampler = new HistogramSampler(this.http, this.api, {
      realLevels: () => this.realLevels,
      channelCount: (d) => this.recolor.channelStates.length || (d.channels ?? 1),
      isGrayscale: () => this.isGrayscaleImage,
      // Nudge the channel-states stream so the pane re-reads getHistogram now,
      // in case its bounded retry window already lapsed.
      onChannelHistogramsSampled: () => this.store.setChannelStates(this.store.currentChannelStates()),
      // Background-preloaded slices are sampled too (histograms per slice), but
      // only the displayed slice's window may seed or re-invalidate the display.
      onGrayWindowSampled: (min, max, z) => {
        if (z === this.currentZ) this.recolor.seedGrayWindow(min, max);
      },
    });
    this.recolor.ensureSubscription();
  }

  private readonly stackLoading$ = new BehaviorSubject<boolean>(false);
  /** The viewport as the library sees it: visible rects, the plot-mode
   *  viewport, zoom/fit (see OsdViewportAdapter). */
  private readonly viewport = new OsdViewportAdapter({
    viewer: () => this.viewer,
    descriptor: () => this.descriptor,
    coordTransform: () => this.coordTransform,
    overlayContainer: () => this.getOverlayContainer(),
  });
  // Region state (regions, selection, the update event) lives in the shared
  // RegionStore; image metadata and classification colours in the shared
  // VisualizerStore — the inherited IRegionStore/display methods delegate there.

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
      this.simple.revokeUrls();
    }
    this.simpleStack.noteActiveFile(filename);
    // Simple (in-memory / non-tiled) image: skip the tile server entirely — no
    // getSelectedInfoB64, no /tiles/info poll. `urls[zIndex]` is a complete image
    // OSD opens via its single-image source (see plot()).
    if (this.simpleStack.isSimple(imageInfo)) {
      this.authHeaders = {};
      return this.simple.load(imageInfo, zIndex, signal);
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
    this.recolor.ensureSubscription();
    // A new image: a stroke or SAM prompt in progress belonged to the old one.
    if (!inPlace) this.canvasTools.resetAll();
    // OSD tiles natively, so the in-place (large) pass is normally a no-op
    // once mounted — the tile pyramid IS the full resolution regardless of
    // which ImageInfo tier requested it. Simple mode has no pyramid to fall
    // back on: it displays literally whatever URL was last opened, so
    // without this swap the small tier's 128px placeholder would stay on
    // screen forever (pixelated, never "sharpening" like the tiled path).
    if (inPlace && this.viewer) {
      this.simple.refreshInPlace(loaded, imageInfo);
      return Promise.resolve(true);
    }
    this.plotDiv = plotDiv;
    this.chrome.onMount(); // the toolbar is re-located for this mount
    this.currentFileName = imageInfo?.fileName;
    this.descriptor = d;
    this.infoB64 = loaded.infoB64;
    this.currentZ = loaded.z;
    this.simple.commit(loaded, imageInfo);
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
      // Take over the composite URL and bin the histograms — AFTER destroyViewer
      // (its last act is sampler.clear()).
      this.simple.mount(loaded);
    } else {
      // A tiled image is going on screen: no simple-mode state may survive it
      // (load() normally cleared it already; plot() is what mounts the image).
      this.simple.reset();
      const plan = planTiledMount(d);
      this.realLevels = plan.realLevels;
      this.isMultiChannel = plan.multiChannel;
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
      this.cache.configure(d.z ?? 1, plan.coarseTiles);
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
      navigatorVisible: this.chrome.navigatorVisible,
      smoothing: this.chrome.smoothingEnabled,
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
        // Recolor every tile (main viewer and navigator) through the display pipeline.
        this.recolor.attach(this.viewer!);
        // Prefetch adjacent z-slices once the view settles (and on each settle,
        // so it tracks the current viewport as the user pans/zooms). Simple mode
        // has a single frame, so there's nothing to prefetch.
        if (!simple) this.viewer!.addHandler('animation-finish', () => this.cache.schedulePrefetch());
        // Tell listeners (the intensity inset) the visible image region whenever
        // the view settles, so they can re-sample at the current zoom resolution.
        this.viewer!.addHandler('animation-finish', () => this.viewport.emitViewportChange());
        // Every redraw (pan/zoom animation frames, resize) — for a contributed
        // plot mode's overlay, which has to move with the image, not after it.
        this.viewer!.addHandler('update-viewport', () => this.viewport.scheduleFrame());
        if (!simple) this.cache.schedulePrefetch();
        // Toolbar nudges, fit-to-view as the layout settles, navigator sizing.
        this.chrome.attach(this.viewer!, plotDiv);
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

  /** The `GET /tile` source for slice `z` (one channel's, when given) — see
   *  {@link buildOsdTileSource}. Multichannel draws off the real levels only. */
  private buildTileSource(d: TileDescriptor, infoB64: string, z: number,
                          channel?: number): Record<string, unknown> {
    return buildOsdTileSource(d, {
      api: this.api, infoB64, z, channel,
      realLevelsOnly: this.isMultiChannel ? this.realLevels : undefined,
    });
  }

  private destroyViewer(): void {
    this.cache.cancelBackgroundLoad();
    this.viewport.cancelFrame();
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
    this.simple.reset();
  }
  relayout(_trueImageSize?: number[]): void {
    this.viewport.keepViewAcrossResize();
  }
  resetAxes(): void {
    this.viewport.goHome();
  }
  autoscale(): void {
    this.viewport.goHome();
  }
  zoomIn(): void {
    this.viewport.zoomBy(1);
  }
  zoomOut(): void {
    this.viewport.zoomBy(-1);
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

  /** Show/hide the overview navigator (now, and for the next viewer). */
  setNavigatorVisible(visible: boolean): void {
    this.chrome.setNavigatorVisible(visible);
  }

  /** Toggle bilinear smoothing vs nearest-neighbour (now, and for the next viewer). */
  setImageSmoothingEnabled(enabled: boolean): void {
    this.chrome.setImageSmoothingEnabled(enabled);
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
    if (this.simple.active) {
      this.simple.setZIndex(z);
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
    return readDrawerPixels(this.viewer);
  }

  /** Image-pixel rectangle the drawer canvas (what {@link getDisplayedPixelData}
   *  reads) currently covers — unclamped, see OsdViewportAdapter.displayedSourceRect. */
  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    return this.viewport.displayedSourceRect();
  }

  /** Snapshot the currently rendered view as a PNG (WYSIWYG) — the parallel to
   *  Plotly's downloadImage. The drawer canvas already carries the display
   *  settings (the recolor pipeline bakes them into the tiles); the full-resolution
   *  stitched export is exportComposite(). */
  downloadImage(): void {
    saveDrawerSnapshot(this.viewer, (blob) => saveAs(blob, `${fileStem(this.currentFileName)}.png`));
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
    return this.viewport.viewportChange$.asObservable();
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

  /** The viewport a contributed plot mode draws over: one stable object that
   *  always reads the current viewer (see OsdViewportAdapter.plotModeViewportFor). */
  getPlotModeViewport(): PlotModeViewport {
    return this.viewport.plotModeViewportFor();
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

  /** The pixel tools' frame: the rendered viewport, read back once and cached
   *  until the viewport changes (see readbackViewportFrame). */
  private readbackViewport(): CachedImageData | null {
    return this.viewportPixels ??= readbackViewportFrame(this.viewer);
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
    const states = this.recolor.channelStates;
    const visible = states.filter((c) => c.visible).map((c) => c.index);
    const url = exportTiffUrl(this.api, this.infoB64, this.currentZ, visible, states.length);
    const saveName = exportTiffFilename(this.currentFileName);
    const blob = await fetchTiffExport(this.http, url);
    if (blob) saveAs(blob, saveName);
  }

  /**
   * Export the current slice as a publication-ready PNG composited with the
   * active display settings, the way it is drawn (see renderCompositePng).
   */
  async exportComposite(): Promise<void> {
    if (!this.descriptor) return;
    const blob = await renderCompositePng({
      http: this.http, api: this.api, descriptor: this.descriptor, infoB64: this.infoB64, z: this.currentZ,
      multiChannel: this.isMultiChannel, realLevels: this.realLevels,
      channelStates: this.recolor.channelStates, display: this.recolor.display,
    });
    if (blob) saveAs(blob, `${fileStem(this.currentFileName)}_composite.png`);
  }

  // ── IDisplayOptions ──────────────────────────────────────────────────
  // Inherited from BaseStoreVisualizer — pure delegations to the shared
  // VisualizerStore, so OSD and Plotly stay in lock-step. OSD applies the
  // colormap to grayscale tiles via the LUT reactively (see the constructor's
  // colormap subscription), not in setColormap.

  // ── IVisualizer ──────────────────────────────────────────────────────
  unsubscribe(): void {
    // The store subscription, and a queued invalidation that must not fire
    // against a torn-down viewer.
    this.recolor.unsubscribe();
    this.destroyViewer();
    this.simple.reset();
  }
}
