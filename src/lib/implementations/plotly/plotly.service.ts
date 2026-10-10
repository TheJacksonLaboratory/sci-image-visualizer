import { Injectable, Inject, Optional } from '@angular/core';

import * as Plotly from 'plotly.js-dist-min';
import { Image } from 'image-js';
import { HttpClient } from '@angular/common/http';

import { Polygon, Rectangle, Region } from '../../models/region';
import { Buffer } from 'buffer';
import { IImageInfo } from '../../contracts/image.contract';
import { TileAccessPort, TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { ImageStatePort, IMAGE_STATE_PORT } from '../../contracts/ports/image-state.port';
import { BehaviorSubject, EMPTY, Observable, Subject, Subscription, combineLatest, of } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ShapeSelection } from '../../models/shape';
import { CONFIG, CONFIG_SURFACE, PlotUtilities } from '../../plot.utilities';
import { WandService, WandOptions } from '../../toolbar/wand/wand.service';
import { CachedImageData, WandToolService, WandToolHost } from '../../toolbar/wand/wand-tool.service';
import { BrushToolService, BrushOptions } from '../../toolbar/brush/brush-tool.service';
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { ICellSegmenter, CELL_SEGMENTER } from '../../contracts/cell-segmenter.contract';
import { VertexEraserToolService, VertexEraserToolHost } from '../../toolbar/vertex-eraser/vertex-eraser-tool.service';
import { ZoomToBoxToolService } from '../../toolbar/zoom-to-box/zoom-to-box-tool.service';
import { PlotType, PLOT_TYPE_DESCRIPTORS, PlotTypeDescriptor } from '../../contracts/plot-type';
import {
  PLOTLY_PLOT_TYPE_IMPLS,
  PlotlyPlotTypeImpl,
  TraceBuildInput,
} from './plotly-trace-builders';
import { IVisualizer, IntensityProfile, IIsosurfaceControls, IIntensityControls } from '../../contracts/visualizer.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { bt601Luminance, histogram256 } from '../../contracts/intensity';
import { ViewerCapabilities, ViewerFeature, capabilitiesOf } from '../../contracts/capabilities.contract';
import { IRegionOverlay } from '../../contracts/region-overlay.contract';
import { PlotlyRegionOverlay } from './plotly-region-overlay';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';
import { PlotlyCoordinateTransform } from './plotly-coordinate-transform';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { BaseStoreVisualizer } from '../base-store-visualizer';
import { ZOOM_BUTTON_STEP } from '../osd/osd-zoom';
import { ColormapNode } from '../../contracts/display-types';
import { VIZ_ALERT_TOAST_KEY } from '../../toast-outlets';
import { firstValueFromAbortable, throwIfAborted } from '../tile-server/transport';

// Re-exported so existing consumers can keep importing PlotType from this
// module while it physically lives in the backend-neutral contracts/ dir.
// TODO(plotting-abstraction): once all consumers import from
// './contracts/plot-type' directly, drop this re-export.
export { PlotType } from '../../contracts/plot-type';

/** Parallel slice fetches when loading a stack (cf. napari's volume fetch pool). */
const PLOTLY_STACK_FETCH_CONCURRENCY = 4;

@Injectable({
  providedIn: 'root'
})
export class PlotlyService extends BaseStoreVisualizer implements IVisualizer {

  /**
   * Plotly is the full-featured data backend: it supports every feature,
   * including 3D scenes, live scalar colormaps, pixel readback and the
   * server-side high-def zoom re-fetch. (OpenSeadragon, the tiled image
   * backend, advertises only image display.)
   */
  readonly capabilities: ViewerCapabilities = capabilitiesOf([
    ViewerFeature.ImageDisplay,
    ViewerFeature.Surface3D,
    ViewerFeature.ScalarColormap,
    ViewerFeature.PixelReadback,
    ViewerFeature.HighDefZoom,
    ViewerFeature.StackSlider,
    ViewerFeature.Isosurface,
  ]);

  private shapes: any[] = [];
  private isRegionSavedOn = true;
  private imageLength!: number;
  private screenHeight!: number;
  private plotDiv!: string;
  private isRealZoom = true;
  private scaleratio = true;
  private trueImgSize!: number[];
  private zoomCoordinates: number[] = [];
  private fileName!: string | undefined;

  private dragMode!: string;
  // Region data (the list + per-image cache), selection, id minting, the region
  // update event and the shape colour/label prefs now live in the shared
  // RegionStore (injected as `this.regionStore`) — the single source of truth
  // both backends delegate to. `this.shapes` below is kept as Plotly's *render
  // projection* of those regions (the dict array Plotly.relayout consumes) and
  // is mirrored into the store on every write. Colormap, reverse-scale, image
  // metadata and classification colours live in the shared VisualizerStore
  // (injected as `this.store`).
  private urls!: string[];
  /**
   * The image currently plotted.
   *
   * The `!` is a definite-assignment ASSERTION, not a guarantee: nothing sets this until
   * an image loads, and a host can clear its image while these paths still run — a
   * spatial-omics dataset that brings no tissue section does exactly that. So reads here
   * are optional and assignments guarded; an unguarded one threw
   * "can't access property isGrayscale" and aborted the load.
   */
  imageInfo!: IImageInfo;
  private plotUtilities = new PlotUtilities();
  private plotType!: PlotType;

  private onPlotMouseDown: (() => void) | null = null;

  // The per-image region cache (regionsByImageKey/currentImageKey) now lives in
  // the shared RegionStore; setActiveImage() delegates to it and re-projects
  // `this.shapes` from the store afterwards.

  /** Pixel data cached for wand sampling. data[zIndex] is a 2-D matrix. */
  private cachedImageFrames?: any[];
  private cachedImageWidth = 0;
  private cachedImageHeight = 0;
  private cachedImageRatios: number[] = [1, 1];
  private cachedIsGrayscale = false;
  /** Data-space coordinate of the cached frame's pixel (0,0). [0,0] for the full
   *  image; a crop's top-left when zoomed (so the intensity profile samples the
   *  zoom-level pixels at the right offset/resolution). */
  private cachedFrameOrigin: [number, number] = [0, 0];
  /** Last visible image-pixel rectangle from the active backend's viewport (set by
   *  the OSD viewport-change hook via refreshIntensitySamplingForRoi). New profile lines are
   *  placed within it so they land on-screen when zoomed in; null → use full image. */
  private lastVisibleRoi: { x: number; y: number; width: number; height: number } | null = null;

  /** events */
  private onRelayoutEvent: any;
  /** Bumped by every render of the plot div (plot, a high-def zoom re-render,
   *  purge, reset). A high-def zoom drops its crop if another render (or the
   *  hand-over of the div to another backend) happened while it was fetching. */
  private renderGen = 0;
  /** Bumped by every write request to the intensity-sampling cache (plot,
   *  ensureIntensitySampling, refreshIntensitySamplingForRoi, reset): an async
   *  sampling fetch lands only if no newer one was requested meanwhile, so a
   *  slow fetch for the previous image can't overwrite the current one. */
  private samplingGen = 0;

  private stackLoading$ = new BehaviorSubject<boolean>(false);
  private stackLoadingProgress$ = new BehaviorSubject<number>(0);
  // current index of image in stack (if stack), 0 if single image
  private zIndex = new BehaviorSubject<number>(0);
  private autoscaleEvent = new Subject<any>();
  // The region update event and selection stream are owned by the shared
  // RegionStore; getRegionUpdateEvent()/getSelectedShapeIndices$() delegate to
  // it so every consumer (and the OSD backend) sees one stream.
  /** Bright, well-separated colours cycled as the user adds profile-line ROIs.
   *  The matching inset trace is drawn in the same colour. */
  private readonly PROFILE_PALETTE = [
    '#FFD400', // yellow
    '#00E5FF', // cyan
    '#FF2D95', // magenta
    '#39FF14', // green
    '#FF9500', // orange
    '#7C4DFF', // violet
    '#FF3B30', // red
    '#18FFFF', // aqua
  ];
  /** Palette cursor for profile lines (never reset on delete, so colours keep
   *  cycling across the session). */
  private profileColorSeq = 0;
  private intensityProfile$ = new Subject<IntensityProfile[]>();
  /** ISOSURFACE band as a 0–255 slider position, mapped onto the volume's real
   *  intensity range at render time (see mapIsoBand). Defaults to the full range
   *  so the first render shows the whole structure regardless of how bright or
   *  dark the volume is; the user then narrows the band to isolate intensities. */
  private isoMin = 0;
  private isoMax = 255;
  /** Actual intensity range of the volume on screen ([min,max] over the loaded
   *  frames). The slider spans 0–255, but a given stack often occupies only a
   *  sub-range, so we clamp the iso band into this range (with a small margin)
   *  to guarantee non-degenerate surfaces — both on first render and on live
   *  slider moves. Null until an isosurface volume has been measured. */
  private isoDataRange: [number, number] | null = null;
  // Id minting and the selection index stream are owned by the shared
  // RegionStore. Selection still drives Plotly's `_activeShapeIndex` (so a
  // single shape gets the edit handles) — see setSelectedShapeIndices().
  private imageCached = false;
  private imageCachedSubscription?: Subscription;
  private filenameSubscription?: Subscription;
  /** Drives the intensity inset off region adds/drags/deletes (both backends). */
  private regionUpdateSubscription?: Subscription;
  /** Live (per-frame, non-coalesced) region edits — so the inset tracks an OSD
   *  line ROI live during a drag (OSD batches regionUpdate$ until release). */
  private regionLiveEditSubscription?: Subscription;
  private channelSub?: Subscription;

  private wandHost!: WandToolHost;
  private eraserHost!: VertexEraserToolHost;
  /** This backend's region renderer (lazily created in getRegionOverlay). */
  private regionOverlay?: IRegionOverlay;
  private readonly coordinateTransform: ICoordinateTransform =
    new PlotlyCoordinateTransform(
      () => document.getElementById(this.plotDiv),
      () => this.getOverlayContainer());

  constructor(@Inject(TILE_ACCESS_PORT) private tiles: TileAccessPort,
              @Inject(IMAGE_STATE_PORT) private state: ImageStatePort,
              public messageService: MessageService, private http: HttpClient,
              private wandService: WandService,
              private wandTool: WandToolService,
              private brushTool: BrushToolService,
              private samTool: SamToolService,
              private samPointTool: SamPointToolService,
              private cellSegmentTool: CellSegmentToolService,
              @Optional() @Inject(CELL_SEGMENTER) private cellSegmenter: ICellSegmenter | null,
              private vertexEraserTool: VertexEraserToolService,
              private zoomToBoxTool: ZoomToBoxToolService,
              store: VisualizerStore,
              regionStore: RegionStore) {
    super(regionStore, store);
    // relayout event router
    this.onRelayoutEvent = (event: any) => { this.relayoutEventHandler(event); };

    // Tool services read/mutate our state via small *Host interfaces. Stored
    // so we can re-bind them to ourselves whenever a Plotly tool is activated
    // (the OpenSeadragon backend re-binds the same singleton tools to itself).
    this.wandHost = {
      getRegions: () => this.regionStore.getRegions(),
      setRegions: (regions) => this.setRegions(regions),
      getCachedImageData: () => this.getCachedImageData(),
      getActiveFrameIndex: () => this.activeFrameIndex(),
      getOverlayContainer: () => this.getOverlayContainer(),
      getCoordinateTransform: () => this.getCoordinateTransform(),
      getFileName: () => this.fileName,
      getShapeColor: () => this.regionStore.getShapeColor(),
    };
    this.eraserHost = {
      getRegions: () => this.regionStore.getRegions(),
      setRegions: (regions) => this.setRegions(regions),
      invalidateWandRegion: () => this.wandTool.clearActiveRegion(),
      getOverlayContainer: () => this.getOverlayContainer(),
      getCoordinateTransform: () => this.getCoordinateTransform(),
      getCachedImageRatio: () => this.cachedImageRatios[0] || 1,
    };
    this.wandTool.bindHost(this.wandHost);
    // The brush reuses the wand host (same coordinate frame + region access).
    this.brushTool.bindHost(this.wandHost);
    this.vertexEraserTool.bindHost(this.eraserHost);
    this.bindZoomToBoxHost();

    this.ensureSubscriptions();
  }

  /**
   * Subscribe to the shared stores (cached flag, filename, live channel recolor,
   * profile-inset refresh). Idempotent and self-healing, like OSD's
   * ensureColormapSubscription: this service is a root singleton, but
   * `unsubscribe()` (called on VisualizerComponent destroy) tears these down and
   * the constructor never runs again. So `load()`/`plot()` call this to
   * re-establish them after a component teardown/recreate.
   */
  private ensureSubscriptions(): void {
    if (this.channelSub) return;
    this.imageCachedSubscription = this.state.isImageCached$().subscribe(imageCached => {
      this.imageCached = imageCached;
    });
    this.filenameSubscription = this.state.getFilename$().subscribe(filename => {
      this.fileName = filename;
    });
    // Live recolor from the Channels & Histogram pane: restyle the display window (zmin/zmax for
    // a heatmap, cmin/cmax for isosurface/surface), the colorscale (colormap), and reverse/invert
    // when the channel state OR the colormap changes. (Gamma is applied by the OSD image view; the
    // Plotly colorscale window covers the common contrast case.)
    this.channelSub = combineLatest([
      this.store.getChannelStates(),
      this.store.getReverseScale(),
      this.store.getInvert(),
      this.store.getColormap(),
    ]).subscribe(([channels, rev, inv]) => this.applyChannelDisplay(channels, rev, inv));
    // Profile lines are store regions; any region change (add/drag/delete, on
    // either backend) should refresh the inset traces. The live-edit stream
    // fires per frame during a drag (OSD coalesces regionUpdate$ until release),
    // so the inset tracks an OSD line ROI live as it's moved.
    this.regionUpdateSubscription = this.regionStore.getRegionUpdateEvent().subscribe(() => {
      this.emitProfiles();
    });
    this.regionLiveEditSubscription = this.regionStore.getRegionLiveEdit$().subscribe(() => {
      this.emitProfiles();
    });
  }

  getTrueImageSize(): { width: number; height: number } | null {
     if (!this.trueImgSize) return null;
     return {
       width: this.trueImgSize[1] - this.trueImgSize[0],
       height: this.trueImgSize[3] - this.trueImgSize[2],
     };
  }

  /**
   * Load image
   * @param imageInfo
   * @param zIndex index of the image to load
   * @param signal aborts the image (and stack-slice) requests: the load then
   *   rejects with an `AbortError`
   * @return an object with data and ratio keys
   */
  public async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal) {
    throwIfAborted(signal);
    // Re-establish the store subscriptions if a prior component teardown
    // (unsubscribe()) tore them down — see ensureSubscriptions().
    this.ensureSubscriptions();
    const urls = imageInfo.urls;
    // use zIndex provided if any, 0 otherwise
    let imageUrl;
    if (zIndex) {
      imageUrl = urls[zIndex];
    } else {
      imageUrl = urls[0];
    }
    const isGrayscale = imageInfo.isGrayscale;
    const image = await this.loadImage(imageUrl, signal);
    const xRatio = imageInfo.trueImageSize[0] / image.width;
    const yRatio = imageInfo.trueImageSize[1] / image.height;

    const trueImageSize = [];
    // [x0, x1, y0, y1]
    trueImageSize[0] = 0;
    trueImageSize[1] = imageInfo.trueImageSize[0];
    trueImageSize[2] = 0;
    trueImageSize[3] = imageInfo.trueImageSize[1];
    this.trueImgSize = trueImageSize;
    this.fileName = imageInfo.fileName;
    if (imageInfo.isStack && imageInfo.showStack) {
      const toMatrix = (img: any) => isGrayscale
        ? this.plotUtilities.arrayToMatrix(Array.from(img.grey().data), img.width)
        : this.plotUtilities.arrayToMatrix(img.getPixelsArray(), img.width);
      // Stop loading once a new file is selected, stack loading is switched off,
      // or the host aborts the load.
      const wanted = () =>
        this.fileName === imageInfo.fileName && this.stackLoading$.value && !signal?.aborted;
      const images: any[] = new Array(urls.length);
      let next = 0;
      let loaded = 0;
      this.stackLoadingProgress$.next(0);
      // One URL per slice, fetched by a small pool of workers; each slice keeps
      // its index.
      const worker = async () => {
        while (next < urls.length && wanted()) {
          const i = next++;
          images[i] = toMatrix(await this.loadImage(urls[i], signal));
          this.stackLoadingProgress$.next(Math.round((++loaded * 100) / urls.length));
        }
      };
      const poolSize = Math.min(PLOTLY_STACK_FETCH_CONCURRENCY, urls.length);
      try {
        await Promise.all(Array.from({ length: poolSize }, () => worker()));
      } catch (err) {
        this.stackLoadingProgress$.next(0);
        throw err;
      }
      throwIfAborted(signal);
      // A cancelled load keeps the contiguous run of slices from the start.
      const firstGap = images.findIndex((m) => m === undefined);
      if (firstGap >= 0) images.length = firstGap;
      // reset stackLoading progress to 0
      this.stackLoadingProgress$.next(0);
      return { data: images, ratios: [xRatio, yRatio],
               sizes: [image.width, image.height],
               filename: imageInfo.fileName };
    } else {
      let imageData;
      if (isGrayscale) {
        const grey = image.grey();
        imageData = this.plotUtilities.arrayToMatrix(Array.from(grey.data), image.width);
      } else {
        const rgbData = image.getPixelsArray();
        imageData = this.plotUtilities.arrayToMatrix(rgbData, image.width);
      }
      return { data: [imageData],
        ratios: [xRatio, yRatio],
        sizes: [image.width, image.height],
        filename: imageInfo.fileName };
    }
  }

  /**
   *
   * @param plotDiv
   * @param imageLoaded object with data, ratios and sizes key
   * @param imageInfo ImageInfo object
   * @param screenHeight size of the available screen height
   * @param plotType type of plotting
   */
  /**
   * @param inPlace when true, updates the existing plot via Plotly.react
   *   instead of Plotly.purge + Plotly.newPlot. Used by the multi-tier
   *   diagram swap (small → large) so the canvas doesn't briefly blank
   *   between phases.
   */
  public plot(plotDiv: string, imageLoaded: any, imageInfo: IImageInfo, screenHeight: number,
              plotType: PlotType, inPlace: boolean = false) {
    this.ensureSubscriptions();
    this.renderGen++;
    this.samplingGen++;
    const trueImageSize: number[] = [];
    this.zoomCoordinates = [];
    // [x0, x1, y0, y1]
    trueImageSize[0] = 0;
    trueImageSize[1] = imageInfo.trueImageSize[0];
    trueImageSize[2] = 0;
    trueImageSize[3] = imageInfo.trueImageSize[1];
    // Save the current image's regions and pull in any cached regions for the
    // image we're about to display, before Plotly.newPlot reads `this.shapes`.
    this.setActiveImage(imageInfo);
    this.imageInfo = imageInfo;
    this.plotType = plotType;
    // Cache pixel matrices so the wand tool can sample them.
    this.cachedImageFrames = imageLoaded.data;
    this.cachedImageWidth = imageLoaded.sizes[0];
    this.cachedImageHeight = imageLoaded.sizes[1];
    this.cachedImageRatios = imageLoaded.ratios;
    this.cachedFrameOrigin = [0, 0]; // full image — reset any prior zoom-crop origin
    this.cachedIsGrayscale = !!imageInfo.isGrayscale;

    // Pluggable plot types (contour, scatter, scatter3d, isosurface) render
    // through the trace-builder registry. The original HEATMAP/SURFACE/RGB-image
    // renderers keep their dedicated paths below (also reused by the high-def
    // zoom re-fetch). Intensity profiles are no longer a plot type — they're
    // Region-based line ROIs, available in HEATMAP/IMAGE mode.
    const impl = PLOTLY_PLOT_TYPE_IMPLS[plotType];
    if (impl) {
      // Guarded: `imageInfo` is declared with a definite-assignment assertion, so
      // nothing stops it being unset at runtime — a plot driven while no image is
      // loaded reached here and threw on the assignment.
      if (this.imageInfo) this.imageInfo.isGrayscale = !!imageInfo.isGrayscale;
      return this.plotViaRegistry(
        plotDiv, impl, this.buildTraceInput(imageInfo, imageLoaded, trueImageSize),
        screenHeight, inPlace);
    }

    if (imageInfo.isGrayscale) {
      if (plotType === PlotType.SURFACE) {
        return this.plotSurface(plotDiv, imageInfo.urls, imageLoaded.data, trueImageSize,
          imageLoaded.ratios, screenHeight, inPlace);
      }
      return this.plotHeatmap(plotDiv, imageInfo.urls, imageLoaded.data, trueImageSize,
        imageLoaded.ratios, screenHeight, inPlace);
    }
    return this.plotRGBHeatmap(plotDiv, imageInfo.urls, imageLoaded.data, trueImageSize,
      imageLoaded.ratios, imageLoaded.sizes[0], imageLoaded.sizes[1], screenHeight, inPlace);
  }

  /**
   * Function used to plot a grayscale heatmap
   * @param plotDiv
   * @param urls
   * @param images
   * @param trueImgSize array containing the following : [x0, x1, y0, y1]
   * @param ratios
   * @param screenHeight
   * @return Promise true when plotting is finished
   */
  private plotHeatmap(plotDiv: string, urls: string[], images: any[], trueImgSize: number[],
                     ratios: number[], screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    if (!inPlace) Plotly.purge(plotDiv);
    this.plotDiv = plotDiv;
    this.imageLength = images.length;
    this.urls = urls;
    this.screenHeight = screenHeight;
    // plot
    const traces: { z: any; type: string; name: string; visible: boolean; }[] = [];
    images.forEach((dataset, index) => {
      const trace = {
        x0: trueImgSize[0],
        dx: ratios[0],
        y0: trueImgSize[2],
        dy: ratios[0],
        z: dataset,
        type: 'heatmap',
        // No per-cell hover text: building it for every pixel is too slow.
        hoverinfo: 'none',
        colorscale: this.store.currentColormap().data.value,
        reversescale: this.store.currentReverseScale(),
        name: `Slice ${index + 1}`,
        visible: index === 0
      };
      traces.push(trace);
    });
    const render = inPlace ? Plotly.react : Plotly.newPlot;
    return (render as any)(plotDiv, traces as any,
      this.getHeatmapLayout([trueImgSize[0], trueImgSize[1]], [trueImgSize[3],
        trueImgSize[2]]), CONFIG as any).then(() => {
      // handle the relayout event for zoom / rois and the click event
      this.setEvents(plotDiv, true, screenHeight);
      return true;
    });
  }

  /**
   * Function used to plot a grayscale surface
   * @param plotDiv
   * @param urls
   * @param images
   * @param trueImgSize array containing the following : [x0, x1, y0, y1]
   * @param ratios
   * @param screenHeight
   * @return Promise true when plotting is finished
   */
  private plotSurface(plotDiv: string, urls: string[], images: any[], trueImgSize: number[],
                      ratios: number[], screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    if (!inPlace) Plotly.purge(plotDiv);
    this.plotDiv = plotDiv;
    this.imageLength = images.length;
    this.urls = urls;
    this.screenHeight = screenHeight;
    // plot
    const traces: { z: any; type: string;  }[] = [];
    images.forEach((dataset, index) => {
      const trace = {
        z: dataset,
        type: 'surface',
        colorscale: this.store.currentColormap().data.value,
        reversescale: this.store.currentReverseScale(),
      };
      traces.push(trace);
    });
    const render = inPlace ? Plotly.react : Plotly.newPlot;
    return (render as any)(plotDiv, traces as any,
      this.getSurfaceLayout(0.4), CONFIG_SURFACE as any).then(() => {
      // handle the relayout event for zoom / rois and the click event
      this.setEvents(plotDiv, true, screenHeight);
      return true;
    });
  }

  /**
   * Function used to plot an RGB heatmap
   * @param plotDiv
   * @param urls
   * @param images
   * @param trueImgSize
   * @param width
   * @param height
   * @param ratios
   * @param screenHeight
   * @return Promise
   */
  private plotRGBHeatmap(plotDiv: string, urls: string[], images: any[], trueImgSize: number[],
                         ratios: number[], width: number, height: number,
                         screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    // Plotly.react updates in place; Plotly.purge + Plotly.newPlot blanks
    // the canvas for ~100ms which makes the multi-tier small→large swap
    // look like a regression to "loading" before the sharper version
    // appears.
    if (!inPlace) Plotly.purge(plotDiv);
    this.plotDiv = plotDiv;
    this.imageLength = images.length;
    this.urls = urls;
    this.screenHeight = screenHeight;

    // as autorange is set to false, and not reversed we need to set the yrange correcly here
    const layout = this.getHeatmapLayout([trueImgSize[0], trueImgSize[1]],
      [trueImgSize[3], trueImgSize[2]]);
    const traces: { z: any; type: string; name: string; visible: boolean; }[] = [];
    images.forEach((dataset, index) => {
      const trace = {
        x0: trueImgSize[0],
        dx: ratios[0],
        y0: trueImgSize[2],
        dy: ratios[0],
        x: Array.from(Array(width).keys()),
        y: Array.from(Array(height).keys()),
        z: dataset,
        hoverinfo: 'none', // no per-cell hover text: too slow for every pixel
        type: 'image',
        name: `Slice ${index + 1}`,
        visible: index === 0
      };
      traces.push(trace);
    });
    const render = inPlace ? Plotly.react : Plotly.newPlot;
    return (render as any)(plotDiv, traces as any, layout, CONFIG as any).then(() => {
      // handle the relayout event
      this.setEvents(plotDiv, false, screenHeight);
      return true;
    });
  }

  /**
   * Assemble the normalised input the pluggable trace builders consume.
   * Pure data only — no Plotly handles — so the builders stay backend-neutral.
   */
  private buildTraceInput(imageInfo: IImageInfo, imageLoaded: any,
                          trueImageSize: number[]): TraceBuildInput {
    // Measure the volume's real intensity range so the iso band can be clamped
    // into it (the slider is a fixed 0–255 but a stack may occupy only part of
    // that, which would otherwise leave the surfaces with nothing to cross).
    if (this.plotType === PlotType.ISOSURFACE) {
      this.isoDataRange = this.measureIntensityRange(imageLoaded.data, !!imageInfo.isGrayscale);
    }
    const [isoMin, isoMax] = this.mapIsoBand(this.isoMin, this.isoMax);
    return {
      frames: imageLoaded.data,
      width: imageLoaded.sizes[0],
      height: imageLoaded.sizes[1],
      ratios: imageLoaded.ratios,
      trueImageSize,
      isGrayscale: !!imageInfo.isGrayscale,
      colorscale: this.store.currentColormap().data.value,
      reversescale: this.store.currentReverseScale(),
      regions: this.getRegionPolygons(),
      shapeColor: this.regionStore.getShapeColor(),
      isoMin,
      isoMax,
    };
  }

  /** Min/max intensity over every voxel of the loaded frames (RGB → luminance),
   *  used to keep the iso band inside the data. Returns null for empty input. */
  private measureIntensityRange(frames: any[], isGrayscale: boolean): [number, number] | null {
    let min = Infinity, max = -Infinity;
    for (const frame of frames || []) {
      for (const row of frame || []) {
        for (const cell of row || []) {
          const v = isGrayscale ? cell
            : bt601Luminance(cell[0], cell[1], cell[2]);
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    return (Number.isFinite(min) && Number.isFinite(max) && max > min) ? [min, max] : null;
  }

  /** Map the 0–255 slider band onto the volume's actual intensity range. The
   *  slider is fixed 0–255, but a stack often occupies only a narrow sub-range
   *  (e.g. this EDOF volume is ~2–50 with structure near 6–10). Mapping spreads
   *  the data across the whole slider so every intensity is easy to reach and
   *  the band always lands inside the data — a small inset keeps the extreme
   *  surfaces off the exact data edges, which are degenerate and draw nothing. */
  private mapIsoBand(isoMin: number, isoMax: number): [number, number] {
    let lo = Math.min(isoMin, isoMax);
    let hi = Math.max(isoMin, isoMax);
    if (this.isoDataRange) {
      const [vMin, vMax] = this.isoDataRange;
      const span = vMax - vMin;
      const pad = 0.03 * span;
      const usable = span - 2 * pad;
      const SLIDER_MAX = 255; // toolbar slider domain (isoValueMax)
      lo = vMin + pad + (lo / SLIDER_MAX) * usable;
      hi = vMin + pad + (hi / SLIDER_MAX) * usable;
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
    }
    return [lo, hi];
  }

  /**
   * Update the isosurface intensity bounds. When isosurface is on screen this
   * restyles `isomin`/`isomax` in place for a live update (no volume rebuild).
   * Slider values are mapped onto the volume's real range so the surfaces always
   * have data to cross (matching the initial render).
   */
  public setIsoRange(isoMin: number, isoMax: number): void {
    this.isoMin = isoMin;
    this.isoMax = isoMax;
    if (this.plotType === PlotType.ISOSURFACE && this.plotDiv) {
      const [lo, hi] = this.mapIsoBand(isoMin, isoMax);
      const gd = this.liveGd();
      if (gd) void Plotly.restyle(gd, { isomin: [lo], isomax: [hi] } as any);
    }
  }

  /** Plotly renders isosurfaces, so it exposes the isosurface controls (itself). */
  public getIsosurfaceControls(): IIsosurfaceControls | null { return this; }

  /**
   * Render a registry-backed plot type: build its traces from the input, pick
   * the matching layout, render, and wire the usual relayout/click events.
   * Mirrors the structure of the dedicated heatmap/surface renderers.
   */
  private plotViaRegistry(plotDiv: string, impl: PlotlyPlotTypeImpl, input: TraceBuildInput,
                          screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    if (!inPlace) Plotly.purge(plotDiv);
    this.plotDiv = plotDiv;
    this.imageLength = input.frames.length;
    this.urls = this.imageInfo?.urls ?? this.urls;
    this.screenHeight = screenHeight;

    const traces = impl.buildTraces(input);
    const [x0, x1, y0, y1] = input.trueImageSize;
    let layout: any;
    switch (impl.layoutKind) {
      case '3d-volume':
        layout = this.getVolumeLayout();
        break;
      case '2d-chart':
        layout = this.getChartLayout();
        break;
      case '2d-overlay':
        layout = this.getOverlayLayout([x0, x1], [y1, y0]); // reversed y like the image
        break;
      default: // '2d-image'
        layout = this.getHeatmapLayout([x0, x1], [y1, y0]);
    }
    const config = impl.threeD ? CONFIG_SURFACE : CONFIG;
    const render = inPlace ? Plotly.react : Plotly.newPlot;
    return (render as any)(plotDiv, traces as any, layout, config as any).then(() => {
      this.setEvents(plotDiv, input.isGrayscale, screenHeight);
      return true;
    });
  }

  /** Plain 2D chart axes (intensity profile / line plots). */
  private getChartLayout(): any {
    return {
      margin: { t: 30, b: 45, l: 60, r: 20 },
      height: this.screenHeight,
      autosize: true,
      xaxis: { title: 'Position (px)' },
      yaxis: { title: 'Intensity' },
      dragmode: false,
    };
  }

  /** Image-aligned 2D axes without the z-plane slider (region scatter). */
  private getOverlayLayout(xRange: number[], yRange: number[]): any {
    return {
      xaxis: { constrain: 'range', constraintoward: 'center', side: 'top', ticks: '', range: xRange },
      yaxis: {
        constrain: 'range', constraintoward: 'center', range: yRange, ticks: '',
        ticksuffix: '  ', autorange: false, scaleanchor: this.scaleratio ? 'x' : false,
      },
      margin: { t: 30, b: 5, l: 55, r: 5 },
      height: this.screenHeight,
      autosize: true,
      shapes: this.currentRenderShapes(this.regionStore.getShowShapeLabel()),
      dragmode: this.dragMode ? this.dragMode : false,
    };
  }

  /** 3D scene for volumetric plot types (scatter3d, isosurface). */
  private getVolumeLayout(): any {
    return {
      margin: { t: 0, b: 0, l: 0, r: 0 },
      height: this.screenHeight,
      autosize: true,
      scene: {
        xaxis: { title: 'X' },
        yaxis: { title: 'Y' },
        zaxis: { title: 'Z-plane' },
        // 'cube' (not 'data'): a z-stack has far fewer planes than X/Y pixels,
        // so 'data' squashes the volume into a near-flat slab that reads as
        // empty edge-on. A cube gives the z dimension real height so the
        // isosurface/voxels are actually visible.
        aspectmode: 'cube',
      },
    };
  }

  /** Plot types this backend advertises (drives the UI selector). */
  public getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    return Object.values(PLOT_TYPE_DESCRIPTORS).filter((d): d is PlotTypeDescriptor => !!d);
  }

  /** This backend's region renderer. Plotly draws shapes natively, so the
   *  overlay is a thin adapter over this service's drag modes. */
  public getRegionOverlay(): IRegionOverlay {
    if (!this.regionOverlay) this.regionOverlay = new PlotlyRegionOverlay(this);
    return this.regionOverlay;
  }

  // ── Intensity profile (Region-based line ROIs) ──────────────────────

  /** Emits the full set of intensity profiles (one per profile-line region)
   *  whenever a profile line is added, moved, or removed. */
  public getIntensityProfile$(): Observable<IntensityProfile[]> {
    // A recreated VisualizerComponent subscribes here on init, before any Plotly
    // load/plot — and with OSD/napari active none may follow. Re-arm the region
    // subscriptions that drive the profiles (see ensureSubscriptions()).
    this.ensureSubscriptions();
    return this.intensityProfile$.asObservable();
  }

  /** Plotly renders the line ROIs + inset, so it exposes the intensity controls. */
  public getIntensityControls(): IIntensityControls | null { return this; }

  /**
   * Render the floating intensity-profile inset chart into `divId` — one line
   * trace per ROI, each drawn in its ROI's colour. Kept here (not in the diagram
   * component) so the consumer never touches Plotly directly.
   */
  public renderIntensityInset(divId: string, profiles: IntensityProfile[]): void {
    const el = document.getElementById(divId);
    if (!el) return;
    const traces = (profiles ?? []).map((p, i) => ({
      x: p.positions,
      y: p.values,
      type: 'scatter',
      mode: 'lines',
      line: { color: p.color ?? '#FFD400', width: 2 },
      name: `Line ${i + 1}`,
      hoverinfo: 'x+y',
    }));
    // X axis is in microns when the image carries a physical pixel size (mpp),
    // otherwise in pixels — driven by the unit the sampler tagged on the profile.
    const unit = (profiles ?? []).find(p => p.unit)?.unit ?? 'px';
    const xTitle = unit === 'µm' ? 'Position (µm)' : 'Position (px)';
    Plotly.react(el, traces as any, {
      margin: { t: 6, r: 8, b: 38, l: 40 },
      xaxis: { title: xTitle, zeroline: false, color: '#ddd' },
      yaxis: { title: 'Intensity', zeroline: false, color: '#ddd' },
      showlegend: false,
      paper_bgcolor: 'rgba(25,25,25,0.9)',
      plot_bgcolor: 'rgba(25,25,25,0.9)',
      font: { color: '#eee', size: 10 },
    } as any, { displayModeBar: false, responsive: true } as any);
  }

  /**
   * Region shapes (filtered/redrawn for the current file). The profile-line ROIs
   * are ordinary store regions (tagged `kind: 'profile'`), so they are already
   * part of `this.shapes` — no separate append is needed.
   */
  private currentRenderShapes(showLabel = this.regionStore.getShowShapeLabel()): any[] {
    return this.shapesToRedraw(showLabel);
  }

  /**
   * IIntensityControls: add another intensity-profile line as a neutral Region
   * (tagged `kind: 'profile'`). It is a horizontal open 2-point polyline spanning
   * the image width, staggered vertically so successive lines stay distinct, in
   * the next bright palette colour. Added to the shared store so both backends
   * (Plotly + OpenSeadragon) render and drag it; excluded from the Regions tab
   * and exports by its kind.
   */
  public addProfileLine(): Region | null {
    if (!this.trueImgSize) return null;
    const count = this.getProfileRegions().length;
    const imgX0 = this.trueImgSize[0], imgX1 = this.trueImgSize[1];
    const imgTop = this.trueImgSize[2], imgBottom = this.trueImgSize[3];

    // Place the line within the currently VISIBLE image area, so when zoomed in it
    // lands on-screen instead of spanning the whole (mostly off-screen) image, at
    // 2/3 of the visible width and horizontally centred. Falls back to the full
    // image when no viewport ROI is known (Plotly heatmap) or a stale ROI no longer
    // overlaps the image.
    const roi = this.lastVisibleRoi;
    const overlaps = !!roi && roi.width > 0 && roi.height > 0
      && roi.x < imgX1 && roi.x + roi.width > imgX0
      && roi.y < imgBottom && roi.y + roi.height > imgTop;
    const x0v = overlaps ? Math.max(imgX0, roi!.x) : imgX0;
    const x1v = overlaps ? Math.min(imgX1, roi!.x + roi!.width) : imgX1;
    const topV = overlaps ? Math.max(imgTop, roi!.y) : imgTop;
    const bottomV = overlaps ? Math.min(imgBottom, roi!.y + roi!.height) : imgBottom;

    const cx = (x0v + x1v) / 2;
    const half = ((x1v - x0v) * (2 / 3)) / 2; // line spans 2/3 of the visible width
    const x0 = cx - half, x1 = cx + half;

    const bandH = bottomV - topV;
    const midY = (topV + bottomV) / 2;
    // Stagger successive lines across the visible band so they stay distinct.
    const y = Math.min(bottomV, Math.max(topV, midY + count * bandH * 0.12));

    const poly = new Polygon();
    poly.npoints = 2;
    poly.xpoints = [x0, x1];
    poly.ypoints = [y, y];
    poly.coordinates = [[x0, y], [x1, y]];
    poly.closed = false;

    const region = new Region();
    region.bounds = poly;
    region.kind = 'profile';
    region.color = this.PROFILE_PALETTE[this.profileColorSeq++ % this.PROFILE_PALETTE.length];
    // Leave region.label undefined so applyClassificationColors won't recolor it.

    this.regionStore.addRegion(region);

    // If a Plotly plot is on screen, re-render shapes so the new line appears.
    // (The OSD overlay renders automatically via its region-update subscription.)
    if (this.plotDiv) {
      this.syncShapesFromStore();
      const gd = this.liveGd();
      if (gd) void Plotly.relayout(gd, { shapes: this.currentRenderShapes() } as any);
    }
    return region;
  }

  /** The profile-line ROIs currently in the store (kind === 'profile'). */
  private getProfileRegions(): Region[] {
    return this.regionStore.getRegions().filter(r => (r as any).kind === 'profile');
  }

  /** Recompute and broadcast a profile for every profile-line region (id + colour
   *  tagged so the inset trace matches its line). */
  private emitProfiles(): void {
    this.intensityProfile$.next(this.getProfileRegions().map(r => ({
      ...this.computeIntensityProfileForRegion(r),
      id: r.id,
      color: r.color,
    })));
  }

  /**
   * Sample the intensity profile for a profile-line region: extract its two
   * polygon endpoints and reuse the shared `computeIntensityProfile` sampling.
   */
  private computeIntensityProfileForRegion(region: Region): IntensityProfile {
    // Duck-typed (not `instanceof Polygon`): after a drag round-trips through the
    // store the bounds can be a plain object, so match on the point arrays.
    const poly: any = region.bounds;
    if (!poly || !Array.isArray(poly.xpoints) || !Array.isArray(poly.ypoints) ||
        poly.xpoints.length < 2 || poly.ypoints.length < 2) {
      return { positions: [], values: [] };
    }
    return this.computeIntensityProfile({
      x0: poly.xpoints[0], y0: poly.ypoints[0],
      x1: poly.xpoints[1], y1: poly.ypoints[1],
    });
  }

  /**
   * Supply pixel frames for intensity sampling (used by the OSD/image backend,
   * whose cached frames may be empty). Optionally also sets the data/pixel ratios.
   */
  public setSamplingFrames(frames: any[], ratios: number[], origin: [number, number] = [0, 0]): void {
    this.cachedImageFrames = frames;
    if (ratios) this.cachedImageRatios = ratios;
    this.cachedFrameOrigin = origin;
    // The wand/brush bounds-check against these, so they must describe THESE
    // frames (e.g. a zoom crop), not the image cached before.
    const frame = frames?.[0];
    if (frame?.length) {
      this.cachedImageHeight = frame.length;
      this.cachedImageWidth = frame[0]?.length ?? 0;
    }
  }

  /**
   * Populate the sampling cache for the intensity profiles when OpenSeadragon is
   * the active backend (the Image plot type). In OSD mode Plotly never rendered,
   * so `cachedImageFrames`/`trueImgSize` are unset — fetch the current slice's
   * preview (the same pixels the heatmap would sample) so the line ROIs have
   * pixel data and a placement extent. Re-emits the profiles once loaded.
   */
  public async ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void> {
    if (!imageInfo?.urls?.length) return;
    // Sample just the displayed slice (showStack off → single frame); `load`
    // also sets `this.trueImgSize`, which addProfileLine needs for placement.
    const single = { ...imageInfo, showStack: false } as IImageInfo;
    const gen = ++this.samplingGen;
    const loaded = await this.load(single, zIndex || 0);
    if (gen !== this.samplingGen) return; // superseded (another image / a crop)
    this.cachedImageFrames = loaded.data;
    this.cachedImageRatios = loaded.ratios;
    this.cachedImageWidth = loaded.sizes?.[0] ?? this.cachedImageWidth;
    this.cachedImageHeight = loaded.sizes?.[1] ?? this.cachedImageHeight;
    this.cachedFrameOrigin = [0, 0]; // full preview
    this.cachedIsGrayscale = !!imageInfo.isGrayscale;
    this.emitProfiles();
  }

  /**
   * {@link IIntensitySampling} stub — the viewport-change signal is OpenSeadragon's
   * (it re-samples on OSD zoom/pan). Plotly's own high-def zoom updates the
   * sampling cache inline, so it never emits here; returns EMPTY so a uniform
   * `IVisualizer` consumer can subscribe regardless of the active backend.
   */
  public getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return EMPTY;
  }

  /**
   * Re-fetch the given image-pixel ROI at the display resolution and use it as
   * the intensity-sampling source, so the profile reflects the data at the
   * current zoom level. Shared by both backends: the OSD viewport-change hook
   * calls it on zoom/pan; Plotly's own high-def zoom (triggerZoom) updates the
   * same cache inline. `roi` is in full-image pixel coordinates.
   */
  public refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number,
                                        zIndex: number): void {
    if (width <= 0 || height <= 0) return;
    // Remember the visible region so a new profile line is placed inside it.
    this.lastVisibleRoi = { x, y, width, height };
    const roi = new Rectangle();
    roi.x = Math.round(x); roi.y = Math.round(y);
    roi.width = Math.round(width); roi.height = Math.round(height);
    // Sized from this viewer's own plot div, not jit-ui's `#diagram` wrapper,
    // which other hosts (and the pipeline preview) don't have.
    const screen = this.plotUtilities.getDomRectangle(this.plotDiv);
    // Snapshot the filename so a response that arrives after the user switched
    // files is dropped (the request carried the file selected at call time).
    const reqName = this.fileName;
    const gen = ++this.samplingGen;
    this.tiles.zoomOnRegion(roi, screen, zIndex || 0).subscribe({
      next: (zoomData) => {
        Image.load(Buffer.from(new Uint8Array(zoomData))).then((image: any) => {
          if (this.fileName !== reqName || gen !== this.samplingGen) return;
          const isGray = !!this.imageInfo?.isGrayscale;
          const frame = isGray
            ? this.plotUtilities.arrayToMatrix(image.grey().data, image.width)
            : this.plotUtilities.arrayToMatrix(image.getPixelsArray(), image.width);
          this.setSamplingFrames([frame], [roi.width / image.width, roi.height / image.height],
            [roi.x, roi.y]);
          this.emitProfiles();
        });
      },
      error: () => { /* keep the previous sampling frame on a failed crop fetch */ },
    });
  }

  /**
   * Sample the active frame's intensity (grayscale value or RGB luminance)
   * along the line ROI. Returns distance-along-line positions and values.
   */
  private computeIntensityProfile(line: any): IntensityProfile {
    const empty: IntensityProfile = { positions: [], values: [] };
    if (!this.cachedImageFrames?.length || !line) return empty;
    const frame = this.cachedImageFrames[this.activeFrameIndex()] ?? this.cachedImageFrames[0];
    if (!frame?.length) return empty;
    const rx = this.cachedImageRatios[0] || 1;
    const ry = this.cachedImageRatios[1] || rx;
    const [ox, oy] = this.cachedFrameOrigin;
    const x0 = +line.x0, y0 = +line.y0, x1 = +line.x1, y1 = +line.y1;
    const dxData = x1 - x0, dyData = y1 - y0;
    // Scale the along-line distance by the physical pixel size (microns/pixel)
    // when the image carries one — anisotropic mppX/mppY are applied per axis so
    // diagonal lines measure the true physical length. Falls back to pixels.
    const { mppX, mppY } = this.currentMpp();
    const useMicrons = mppX != null;
    const lenData = useMicrons
      ? Math.hypot(dxData * mppX, dyData * (mppY ?? mppX))
      : Math.hypot(dxData, dyData);
    const lenPx = Math.hypot(dxData / rx, dyData / ry);
    const n = Math.max(2, Math.round(lenPx));
    const h = frame.length;
    const w = frame[0].length;
    const positions: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // Map data coords to the cached frame's pixel grid, offset by the frame's
      // origin (non-zero when the frame is a zoomed crop).
      const px = Math.round((x0 + t * dxData - ox) / rx);
      const py = Math.round((y0 + t * dyData - oy) / ry);
      let v = 0;
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const cell = frame[py][px];
        v = Array.isArray(cell) ? bt601Luminance(cell[0], cell[1], cell[2]) : cell;
      }
      positions.push(t * lenData);
      values.push(v);
    }
    return { positions, values, unit: useMicrons ? 'µm' : 'px' };
  }

  /** Physical pixel size (microns/pixel) for the current image, if known.
   *  mpp is constant across frames/channels, so the first metadata entry that
   *  carries a positive mppX wins. Returns nulls when the image is unscaled. */
  private currentMpp(): { mppX: number | null; mppY: number | null } {
    const meta = this.imageInfo?.imageMeta;
    const m = Array.isArray(meta)
      ? (meta.find(e => e && (e.mppX ?? 0) > 0) ?? meta[0])
      : undefined;
    const mppX = m && (m.mppX ?? 0) > 0 ? (m.mppX as number) : null;
    const mppY = m && (m.mppY ?? 0) > 0 ? (m.mppY as number) : null;
    return { mppX, mppY };
  }

  /**
   * autoscale the plot
   */
  public autoscale() {
    if (this.plotDiv) {
      this.zoomCoordinates = [];
      Plotly.relayout(this.plotDiv, {
        'xaxis.autorange': true,
        'yaxis.autorange': false }
      );
    }
  }

  /**
   * relayout the plot
   */
  public relayout(trueImageSize?: number[]) {
    let imgSize;
    if (trueImageSize) {
      imgSize = trueImageSize;
    } else {
      imgSize = this.trueImgSize;
    }
    if (this.plotDiv) {
      // Refresh height from current DOM so panel resizes are reflected
      const plotEl = document.getElementById(this.plotDiv);
      if (plotEl?.offsetHeight) {
        this.screenHeight = plotEl.offsetHeight;
      }
      try {
        if (this.zoomCoordinates.length > 0) {
          Plotly.relayout(this.plotDiv, this.getHeatmapLayout(
            [this.zoomCoordinates[0], this.zoomCoordinates[1]],
            [this.zoomCoordinates[2], this.zoomCoordinates[3]]));    // reverse the y range
        } else {
          // as autorange is set to false, and not reversed we need to set the yrange correcly here
          Plotly.relayout(this.plotDiv, this.getHeatmapLayout(
            [imgSize[0], imgSize[1]], [imgSize[3], imgSize[2]]));
        }
      } catch (err: any) {
        const msg = err?.error?.message || err?.message || err?.statusText || String(err);
        console.error('Error occured', err);
        this.messageService.add({ key: VIZ_ALERT_TOAST_KEY, sticky: true, severity:'error', summary:'An error occured', detail:`The following
                                  error occured: ${msg}. Please try to open the image again through the
                                  file navigator.` });
        // TODO correctly clear the plot
        this.reset();
      }
    }
  }

  private setEvents(plotDiv: string, isGrayscale: boolean, screenHeight: number) {
    if (this.imageInfo) this.imageInfo.isGrayscale = isGrayscale;
    this.screenHeight = screenHeight;
    const plot: any = document.getElementById(plotDiv);
    if (plot) {
      // Rebind the relayout handler. gd.on() registers on Plotly's own
      // EventEmitter, so it must be unbound with removeListener — the DOM's
      // removeEventListener is a no-op for it, and every in-place render
      // (Plotly.react keeps the emitter) used to add another handler.
      plot.removeListener?.('plotly_relayout', this.onRelayoutEvent);
      plot.on('plotly_relayout', this.onRelayoutEvent);

      // Clicking on a shape activates it but Plotly doesn't fire a dedicated
      // event — sample _activeShapeIndex on the next microtask so subscribers
      // (Region Editor) can mirror the selection.
      plot.removeEventListener('mousedown', this.onPlotMouseDown);
      this.onPlotMouseDown = () => setTimeout(() => this.maybeEmitActiveShapeIndex(), 0);
      plot.addEventListener('mousedown', this.onPlotMouseDown);
    }
  }

  private relayoutEventHandler(event: any) {
    if (Object.keys(event).includes('dragmode')) {
      this.dragMode = event.dragmode;
    }
    // when relayout event occurs
    // update the region selection udpdates
    const keys = Object.keys(event);
    let shapesModified = false;
    keys.forEach((key: any) => {
      if (typeof key === 'string' && key.startsWith('shapes[')) {
        const shapeNumber = +key.split('[')[1].split(']')[0];
        const shapeChange = key.split('.')[1];
        if (this.shapes && this.shapes[shapeNumber]) {
          if (shapeChange === 'path') {
            this.shapes[shapeNumber][shapeChange] = this.plotUtilities.roundPathCoordinates(event[key]);
          } else {
            this.shapes[shapeNumber][shapeChange] = Math.round(+event[key]);
          }
          shapesModified = true;
        }
      }
    });
    if (shapesModified) {
      // Mirror the in-place edit into the shared store (syncs its cache + emits).
      this.commitShapesToStore();
    }
    // manage high def zoom (not if we are showing a stack)
    if (keys.length === 4 && this.isRealZoom) {
      const coordinates: any[] = [];
      keys.forEach(key => {
        if (key.startsWith('xaxis.range[')) {
          coordinates.push(event[key]);
        }
        if (key.startsWith('yaxis.range[')) {
          coordinates.push(event[key]);
        }
      });
      this.zoomCoordinates = coordinates;
      if (!this.imageInfo?.showStack) {
        this.triggerZoom(coordinates);
      }
    }
    // when shape is created
    if (keys.length === 1 && 'shapes' in event) {
      this.shapes = event.shapes as any[];
      for (let i = 0; i < this.shapes.length; i++) {
        // A freshly Plotly-drawn shape has no id yet — give it a label object
        // (when labels are on) before the store mints id + default name.
        const isNew = this.shapes[i].id == null;
        this.shapes[i].fileName = this.fileName;
        this.shapes[i] = this.plotUtilities.snapRegion(this.shapes[i]);
        if (isNew && this.regionStore.getShowShapeLabel()) {
          this.shapes[i].label = { text: this.shapes[i].label,
            texttemplate: this.shapes[i].label,
            font: { color: this.regionStore.getShapeColor() },
            textposition: 'top left'
          };
        }
      }
      // Mint ids/names in the store, write them back onto the dicts, and emit.
      this.commitShapesToStore();
    }
    // if autoscale
    if (keys.includes('xaxis.autorange') && keys.includes('yaxis.autorange')) {
      // trigger an autoscale event to reset the selected image mode dropdown
      this.autoscaleEvent.next('an autoscale has happened');
      // select display type to trigger a new plotting update with all the necessary plotting parameters set
      this.tiles.selectDiagramDisplay();
    }
    // if showstack or aspectratio event
    if (event.showstack !== undefined || event.aspectratio !== undefined) {
      // Set new image info to trigger a plot update
      this.setImageInfo(event.showstack, event.aspectratio);
    }

    // Plotly may have updated the active shape index as part of the relayout
    // (e.g. clicking a shape's edit handle, or finishing a draw) — surface
    // that change to the Region Editor.
    this.maybeEmitActiveShapeIndex();
  }

  public reloadAndPlot() {
    this.setImageInfo();
  }


  // ── Tool delegations ────────────────────────────────────────────────

  public setWandMode(active: boolean, options: WandOptions = {}) {
    // Re-bind to ourselves in case the OSD backend last used these singletons.
    if (active) this.wandTool.bindHost(this.wandHost);
    this.wandTool.setMode(active, options);
  }

  public setWandOptions(options: WandOptions) {
    this.wandTool.setOptions(options);
  }

  public clearActiveWandRegion() {
    this.wandTool.clearActiveRegion();
  }

  public setBrushMode(active: boolean, options: BrushOptions = {}) {
    // Re-bind to ourselves in case the OSD backend last used this singleton.
    if (active) this.brushTool.bindHost(this.wandHost);
    this.brushTool.setMode(active, options);
  }

  public setBrushOptions(options: BrushOptions) {
    this.brushTool.setOptions(options);
  }

  public setVertexEraserMode(active: boolean) {
    if (active) this.vertexEraserTool.bindHost(this.eraserHost);
    this.vertexEraserTool.setMode(active);
  }

  public setVertexEraserRadius(radius: number) {
    this.vertexEraserTool.setRadius(radius);
  }

  public setZoomToBoxMode(active: boolean) {
    // The zoom-to-box tool is a root singleton shared with the OSD backend,
    // which rebinds it to its own host on activation. Rebind to ours when we
    // activate so a prior OSD zoom-to-box doesn't leave the singleton pointing
    // at OSD's coordinate/zoom handlers (which would break box-zoom on heatmaps).
    if (active) this.bindZoomToBoxHost();
    this.zoomToBoxTool.setMode(active);
  }

  /** Bind the shared zoom-to-box tool to this (Plotly) backend's host. */
  private bindZoomToBoxHost() {
    this.zoomToBoxTool.bindHost({
      getPlotDiv: () => this.plotDiv,
      pixelToData: (px, py) => this.zoomBoxPixelToData(px, py),
      applyZoomToBox: (coords) => this.applyZoomToBox(coords),
    });
  }

  /** Box-prompted SAM: segment the drawn rectangles. The SAM tool reuses the
   *  wand host (cached frame + coordinate transform + region store). */
  public segmentRectangles(): Promise<number> {
    this.samTool.bindHost(this.wandHost);
    return this.samTool.segmentBoxes();
  }
  public segmentRectanglesCellpose(): Promise<number> {
    if (!this.cellSegmenter) return Promise.resolve(0);
    this.cellSegmentTool.bindHost(this.wandHost);
    return this.cellSegmentTool.segmentBoxes(this.cellSegmenter);
  }
  public setSamModel(id: string): void {
    this.samTool.setModel(id);
    this.samPointTool.setModel(id);
  }
  public setSamPointMode(active: boolean): void {
    if (active) this.samPointTool.bindHost(this.wandHost);
    this.samPointTool.setMode(active);
  }
  public commitSamPoints(): void { this.samPointTool.commit(); }
  public clearSamPoints(): void { this.samPointTool.clear(); }

  /** Overlay-pixel -> Plotly data coords via the axis objects (subtracting the
   *  plot margin offset). The zoom-to-box tool calls this through its host. */
  private zoomBoxPixelToData(px: number, py: number): { x: number; y: number } {
    const gd: any = document.getElementById(this.plotDiv);
    const xaxis = gd._fullLayout.xaxis;
    const yaxis = gd._fullLayout.yaxis;
    return { x: xaxis.p2d(px - xaxis._offset), y: yaxis.p2d(py - yaxis._offset) };
  }

  /**
   * Tool-host callback: apply the zoom-to-box selection. Stack mode does a
   * pure axis-range relayout; non-stack mode goes through the high-def
   * triggerZoom pipeline so the image is re-fetched at the new resolution.
   */
  private applyZoomToBox(coordinates: number[]) {
    this.zoomCoordinates = coordinates;
    if (this.imageInfo?.showStack) {
      Plotly.relayout(this.plotDiv, {
        'xaxis.range[0]': coordinates[0],
        'xaxis.range[1]': coordinates[1],
        'yaxis.range[0]': coordinates[2],
        'yaxis.range[1]': coordinates[3],
      } as any);
    } else {
      this.triggerZoom(coordinates);
    }
  }

  // ── IViewportHost implementation (for the on-canvas tools) ──────────

  /** The plot element the tool canvas overlays attach to. */
  public getOverlayContainer(): HTMLElement | null {
    return this.plotDiv ? document.getElementById(this.plotDiv) : null;
  }

  /** Plotly coordinate transform (screen <-> data via the axis objects). */
  public getCoordinateTransform(): ICoordinateTransform {
    return this.coordinateTransform;
  }

  // ── WandToolHost implementation ─────────────────────────────────────

  /** Pixel data the wand needs for sampling. null = no image loaded. */
  private getCachedImageData(): CachedImageData | null {
    if (!this.cachedImageFrames || this.cachedImageFrames.length === 0) return null;
    return {
      frames: this.cachedImageFrames,
      width: this.cachedImageWidth,
      height: this.cachedImageHeight,
      ratios: this.cachedImageRatios,
      isGrayscale: this.cachedIsGrayscale,
      // A high-def zoom caches the crop, whose pixel (0,0) is not image (0,0).
      originX: this.cachedFrameOrigin[0],
      originY: this.cachedFrameOrigin[1],
    };
  }

  // ── shared-store sync helpers ──────────────────────────────────────────
  //
  // `this.shapes` is Plotly's own representation (the dict array Plotly.relayout
  // consumes). The shared RegionStore is the single source of truth, holding the
  // neutral Region model. These helpers bridge the two: writes mirror
  // `this.shapes` INTO the store; image switches/external changes project the
  // store back OUT to `this.shapes`.

  /** Build Plotly shape dicts from the store's regions (the render projection). */
  private regionsToShapeDicts(): any[] {
    const showLabel = this.regionStore.getShowShapeLabel();
    return this.regionStore.getRegions().map(r => {
      r.filename = this.fileName;
      return { ...r.getShape(showLabel) };
    });
  }

  /** Rebuild the dict working-set from the store (after an image switch, or when
   *  regions changed while another backend was rendering). */
  private syncShapesFromStore(): void {
    this.shapes = this.regionsToShapeDicts();
  }

  /**
   * Make the shared store authoritative for the current dict working-set: convert
   * `this.shapes` to neutral regions and replace the store's list (the store
   * mints ids, applies class colours, syncs its per-image cache and emits the
   * region-update event). Store-minted ids are written back onto the dicts so the
   * two representations stay aligned. Profile-line ROIs are ordinary regions
   * (tagged `kind: 'profile'`) and round-trip through here too.
   */
  private commitShapesToStore(): void {
    const regions = this.shapes
      .map(s => Object.assign(new ShapeSelection(), s).getRegion());
    this.regionStore.setRegions(regions, this.regionStore.getShowShapeLabel(), true,
      this.regionStore.getFillColor(), false);
    const stored = this.regionStore.getRegions();
    for (let i = 0; i < this.shapes.length && i < stored.length; i++) {
      if (this.shapes[i].id == null) this.shapes[i].id = stored[i].id;
      if (this.shapes[i].name == null) this.shapes[i].name = stored[i].name;
    }
  }

  /** Active frame index in the cached image stack. */
  private activeFrameIndex(): number {
    if (!this.cachedImageFrames || this.cachedImageFrames.length <= 1) return 0;
    const gd: any = document.getElementById(this.plotDiv);
    const sliderActive = gd?._fullLayout?.sliders?.[0]?.active;
    if (typeof sliderActive === 'number') return sliderActive;
    return this.zIndex.value || 0;
  }

  /** Capability-gated 3D scene controls (Plotly renders the 3D plot types). */
  getSurface3dControls() {
    return {
      setSurfaceDragMode: (mode: string) => this.setSurfaceDragMode(mode),
      resetSurfaceCamera: () => this.resetSurfaceCamera(),
    };
  }

  public setSurfaceDragMode(mode: string) {
    if (this.plotDiv) {
      Plotly.relayout(this.plotDiv, { 'scene.dragmode': mode } as any);
    }
  }

  public resetSurfaceCamera() {
    if (this.plotDiv) {
      Plotly.relayout(this.plotDiv, { 'scene.camera': {} } as any);
    }
  }

  private triggerZoom(coordinates: number[]) {
    if (coordinates.length === 0 || !this.trueImgSize) return;
    this.zoomCoordinates = coordinates;
    const rect = this.plotUtilities.getRectangle(coordinates, this.trueImgSize);
    if (this.plotUtilities.isZoomSameAsImgSize(rect, this.trueImgSize)) {
      this.autoscale();
      return;
    }
    // A brief "Caching image..." message for uncached files (large files take a
    // moment to cache); just a spinner otherwise.
    this.state.setImageLoadingMessage(this.imageCached ? '' : 'Caching image...');
    // Sized from this viewer's own plot div, not jit-ui's `#diagram` wrapper,
    // which other hosts (and the pipeline preview) don't have.
    const screen = this.plotUtilities.getDomRectangle(this.plotDiv);
    const imageSize: any[] = [];
    imageSize[0] = rect.x;
    imageSize[1] = rect.x + rect.width;
    imageSize[2] = rect.y;
    imageSize[3] = rect.y + rect.height;
    // Snapshot the filename so a response that arrives after the user switched
    // files is dropped (the request carried the file selected at call time).
    const reqName = this.fileName;
    // A newer render (another zoom, a new plot, or the div handed to another
    // backend — even for the same file) supersedes this crop.
    const gen = ++this.renderGen;
    const samplingGen = ++this.samplingGen;
    this.state.setImageLoading(true);
    this.state.setZoom(true);
    this.tiles.zoomOnRegion(rect, screen, this.zIndex.value).subscribe({ next: zoomData => {
      const uint8Array = new Uint8Array(zoomData);
      const buffer = Buffer.from(uint8Array);
      Image.load(buffer).then((image: any) => {
        const xRatio = rect.width / image.width;
        const yRatio = rect.height / image.height;
        const gd: any = document.getElementById(this.plotDiv);
        if (this.fileName === reqName && gen === this.renderGen && gd?._fullLayout) {
          const isGray = this.imageInfo?.isGrayscale;
          const frame = isGray
            ? this.plotUtilities.arrayToMatrix(image.grey().data, image.width)
            : this.plotUtilities.arrayToMatrix(image.getPixelsArray(), image.width);
          // Also sample the intensity profiles from this high-def crop so the
          // inset reflects the zoom-level resolution (origin = crop top-left).
          if (samplingGen === this.samplingGen) {
            this.setSamplingFrames([frame], [xRatio, yRatio], [imageSize[0], imageSize[2]]);
            this.emitProfiles();
          }
          // Re-render the high-def crop in the SAME plot type the user is
          // viewing. Without this the zoom re-fetch always fell back to a
          // heatmap, so zooming in contour (or any registry type) reverted
          // to heatmap.
          const impl = PLOTLY_PLOT_TYPE_IMPLS[this.plotType];
          const renderPromise = impl
            ? this.plotViaRegistry(this.plotDiv, impl,
                this.buildTraceInput(this.imageInfo, {
                  data: [frame], ratios: [xRatio, yRatio],
                  sizes: [image.width, image.height], filename: reqName,
                }, imageSize), this.screenHeight)
            : (isGray
                ? this.plotHeatmap(this.plotDiv, this.urls, [frame], imageSize, [xRatio, yRatio],
                    this.screenHeight)
                : this.plotRGBHeatmap(this.plotDiv, this.urls, [frame], imageSize, [xRatio, yRatio],
                    image.width, image.height, this.screenHeight));
          // plotViaRegistry already applies the type's own layout/range for
          // non-image layouts (chart/overlay); only re-apply the heatmap
          // range for the image-aligned paths.
          const reapplyRange = !impl || impl.layoutKind === '2d-image';
          renderPromise.then(() => {
            this.state.setImageCached(true);
            this.state.setImageLoading(false);
            image = null;
            if (reapplyRange) this.relayout(imageSize);
          });
        }
      });
    }, error: err => {
      const msg = err?.error?.message || err?.message || err?.statusText || String(err);
      console.error('Error occured when zooming', err);
      this.messageService.add({ key: VIZ_ALERT_TOAST_KEY, sticky: true, severity:'error', summary:'An error occured',
        detail:`The following error occured while zooming: ${msg}.
                          Please try to open the image again through the file navigator and
                          zoom on the selected area once more.` });
      this.state.setLoadingError(true);
      this.state.setImageLoading(false);
    } });
  }

  public setPlotType(plotType: PlotType) {
    this.plotType = plotType;
  }

  private setImageInfo(showStack?: boolean, scaleratio?: boolean) {
    // Nothing plotted yet (a host's first view is an image-less spatial dataset): there is no
    // image to describe, so nothing to re-plot — stop the spinner rather than throw.
    if (!this.trueImgSize) {
      this.state.setImageLoading(false);
      return;
    }
    // Build a partial image descriptor and push it to the host via the port.
    const imgInfo: Partial<IImageInfo> = {
      isGrayscale: this.imageInfo?.isGrayscale,
      trueImageSize: [this.trueImgSize[1], this.trueImgSize[3]],
      urls: this.urls,
      isStack: this.urls.length > 1,
      scaleRatio: scaleratio !== undefined ? scaleratio : this.scaleratio,
    };
    if (showStack !== undefined) imgInfo.showStack = showStack;
    if (this.fileName) imgInfo.fileName = this.fileName;
    this.state.setImageInfo(imgInfo);
  }

  /**
   * Switch the active image. The shared RegionStore owns the per-image region
   * cache (snapshot outgoing / restore incoming / clear selection / emit); we
   * delegate to it, then re-project the store's regions into Plotly's dict
   * working-set. Re-projecting unconditionally (even when the store no-ops for
   * the same image) means Plotly also picks up regions another backend (OSD)
   * added while it was off-screen. Called from `plot()` and from the router
   * before any backend renders.
   */
  public setActiveImage(imageInfo: IImageInfo) {
    this.regionStore.setActiveImage(imageInfo);
    this.syncShapesFromStore();
  }

  /**
   * Set plot regions. Delegates the state change to the shared RegionStore
   * (id/name minting, classification colours, append de-duplication, per-image
   * cache and the region-update event all live there), then re-projects the
   * store's regions into Plotly's dict working-set and renders.
   *
   * When `isRegionSaveOn` is false the regions are shown transiently — rendered
   * without altering the stored working-set (preserves the prior behaviour).
   */
  public override setRegions(regions: Region[], showRegionLabel?: boolean,
                             isRegionSaveOn?: boolean, fillColor?: string,
                             append: boolean = false) {
    const showLabel = showRegionLabel === undefined ? this.regionStore.getShowShapeLabel() : showRegionLabel;
    const save = isRegionSaveOn === undefined ? this.isRegionSavedOn : isRegionSaveOn;

    this.regionStore.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
    this.isRegionSavedOn = save;

    if (save) {
      // Re-project the authoritative regions into Plotly's working-set and render.
      this.syncShapesFromStore();
      this.renderShapes();
    } else {
      // Transient display only — render the passed regions, don't touch the
      // working-set (and the store didn't store them either).
      const dicts = regions.map(r => { r.filename = this.fileName; return { ...r.getShape(showLabel) }; });
      const gd = this.liveGd();
      if (gd) void Plotly.relayout(gd, this.shapesRelayout(dicts) as any);
    }
  }

  /** The shapes-relayout payload: region shapes (profile-line ROIs included, as
   *  they are ordinary regions) plus the active-shape fill colour. */
  private shapesRelayout(shapeDicts: any[]): any {
    return {
      shapes: shapeDicts,
      activeshape: { fillcolor: this.regionStore.getFillColor() },
    };
  }

  /** Push the current dict working-set to Plotly (no-op when another backend
   *  owns the div). */
  private renderShapes(): void {
    const gd = this.liveGd();
    if (!gd) return; // another backend's overlay renders the regions
    const dictArray = this.shapes.map(s => ({ ...s }));
    void Plotly.relayout(gd, this.shapesRelayout(dictArray) as any);
  }

  /** The plot div while it hosts a live Plotly graph, else null. `plotDiv`
   *  stays set after purgePlot() hands the div to another backend (OSD,
   *  napari-js), and Plotly.relayout/restyle throw on a non-Plotly div. */
  private liveGd(): any | null {
    const gd: any = this.plotDiv ? document.getElementById(this.plotDiv) : null;
    return gd?._fullLayout ? gd : null;
  }

  private getHeatmapLayout(xRange: number[], yRange: number[]): any {
    return {
      xaxis: {
        constrain: 'range',
        constraintoward: 'center',
        side: 'top',
        ticks: '',
        range: xRange
      },
      yaxis: {
        constrain: 'range',
        constraintoward: 'center',
        range: yRange,
        ticks: '',
        ticksuffix: '  ',
				// set autorange to false so that plotly does not overwrite the range for the y axis
				autorange: false,
        scaleanchor: this.scaleratio ? 'x' : false
     },
      margin: { t: 30, b: 5, l: 55, r: 5 },
      height: this.screenHeight,
      sliders: [{
        pad: { t: 50 },
        currentvalue: {
          visible: true,
          prefix: 'Z-plane:',
          xanchor: 'right',
        },
        steps: this.getSteps()
      }],
      autosize: true,
      shapes: this.currentRenderShapes(this.regionStore.getShowShapeLabel()),
      activeshape: { fillcolor: this.regionStore.getFillColor() },
      dragmode: this.dragMode ? this.dragMode : false,
      newshape: { line: { color: this.regionStore.getShapeColor(), width: 3 } }
    };
  }

  private shapesToRedraw(showLabel: boolean) {
    const shapesToRedraw: ShapeSelection[] = [];
    for (const shape of this.shapes) {
      if (JSON.stringify(shape.fileName) === JSON.stringify(this.fileName)) {
        // Set label
        if (showLabel) {
          shape.label = {
            text: `${shape.legend}`,
            texttemplate: `${shape.legend}`,
            textposition: 'top left',
            font: { color: `${shape.line.color}` }
          };
        } else {
          shape.label = {};
        }
        shapesToRedraw.push(shape);
      }
    }
    // convert to dict so that plotly recognises the shapes
    return shapesToRedraw.map(s => ({ ...s }));
  }
  /**
   * Scene layout for the surface plot (plotSurface): light-grey axis planes and
   * a manual aspect ratio whose z extent is `zRatio` of the x/y extent.
   */
  private getSurfaceLayout(zRatio: number): any {
    return {
      margin: { t: 0, b: 0, l: 0, r: 0 },
      scene: {
        xaxis: {
          gridcolor: 'rgb(255, 255, 255)',
          zerolinecolor: 'rgb(255, 255, 255)',
          showbackground: true,
          backgroundcolor: 'rgb(230, 230,230)',
        },
        yaxis: {
          gridcolor: 'rgb(255, 255, 255)',
          zerolinecolor: 'rgb(255, 255, 255)',
          showbackground: true,
          backgroundcolor: 'rgb(230, 230, 230)',
        },
        zaxis: {
          gridcolor: 'rgb(255, 255, 255)',
          zerolinecolor: 'rgb(255, 255, 255)',
          showbackground: true,
          backgroundcolor: 'rgb(230, 230,230)'
        },
        aspectratio: { x: 1, y: 1, z: zRatio },
        aspectmode: 'manual',
      }
    };
  }

  private getSteps() {
    const steps = [];
    for (let i = 0; i < this.imageLength; i++) {
      steps.push({
        label: i + 1,
        method: 'restyle',
        args: ['visible', Array(this.imageLength).fill(false).fill(true, i, i + 1)],
      });
    }
    return steps;
  }

  /**
   * Fetch an image via Angular HttpClient so that auth interceptors (Bearer token)
   * are applied, then decode it with image-js. This avoids raw browser fetch()
   * calls that bypass the interceptor chain and fail behind an OAuth2 proxy.
   */
  private async loadImage(url: string, signal?: AbortSignal): Promise<Image> {
    const buffer = await firstValueFromAbortable(
      this.http.get(url, { responseType: 'arraybuffer' }), signal,
    );
    return Image.load(Buffer.from(buffer));
  }

  /**
   * Get the currently displayed image as an image-js Image instance.
   * Used by the processing pipeline to obtain the input image.
   */
  public async getCurrentImage(): Promise<Image | null> {
    if (!this.imageInfo || !this.imageInfo.urls || this.imageInfo.urls.length === 0) {
      return null;
    }
    const zIdx = this.zIndex.value || 0;
    const url = this.imageInfo.urls[zIdx] || this.imageInfo.urls[0];
    return this.loadImage(url);
  }

  /**
   * Get the currently displayed plot pixel data as a flat Uint8ClampedArray.
   * This captures whatever is actually rendered — including zoomed regions.
   * Returns { width, height, channels, data } or null if no plot is displayed.
   */
  public getDisplayedPixelData(): { width: number; height: number; channels: number;
    data: Uint8ClampedArray } | null {
    if (!this.plotDiv) return null;
    const gd: any = document.getElementById(this.plotDiv);
    if (!gd?.data || gd.data.length === 0) return null;

    // Find the visible trace
    const frameIdx = this.activeFrameIndex();
    const trace = gd.data[frameIdx] || gd.data[0];
    if (!trace || !trace.z) return null;

    const zData: any[][] = trace.z;
    const height = zData.length;
    if (height === 0) return null;
    const width = zData[0].length;

    if (trace.type === 'image') {
      // RGB image: z[row][col] = [r, g, b] or [r, g, b, a]
      const sample = zData[0][0];
      const channels = Array.isArray(sample) ? sample.length : 3;
      const data = new Uint8ClampedArray(width * height * channels);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const pixel = zData[y][x];
          const offset = (y * width + x) * channels;
          for (let c = 0; c < channels; c++) {
            data[offset + c] = pixel[c];
          }
        }
      }
      return { width, height, channels, data };
    } else {
      // Heatmap (grayscale): z[row][col] = scalar value
      const data = new Uint8ClampedArray(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          data[y * width + x] = Math.round(zData[y][x]);
        }
      }
      return { width, height, channels: 1, data };
    }
  }

  /**
   * Region of the original image that the displayed `z` grid covers, in
   * full-image pixel coords. On a server zoom (`triggerZoom`) the trace `z` is
   * replaced with the high-def crop and the axes are relaid out to the crop's
   * original-image bounds (`imageSize`), so the live axis ranges ARE that
   * rectangle; when the whole image is in view the ranges span `trueImgSize`.
   * Reading the ranges therefore yields the crop origin + extent without
   * tracking zoom state separately. Falls back to the full image, then `null`.
   */
  public getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    const gd: any = this.plotDiv ? document.getElementById(this.plotDiv) : null;
    const xr: number[] | undefined = gd?._fullLayout?.xaxis?.range;
    const yr: number[] | undefined = gd?._fullLayout?.yaxis?.range;
    if (xr && yr) {
      const x0 = Math.min(xr[0], xr[1]);
      const y0 = Math.min(yr[0], yr[1]); // y axis is reversed for image layouts
      return { x: x0, y: y0, width: Math.abs(xr[1] - xr[0]), height: Math.abs(yr[1] - yr[0]) };
    }
    if (!this.trueImgSize) return null;
    return {
      x: this.trueImgSize[0],
      y: this.trueImgSize[2],
      width: this.trueImgSize[1] - this.trueImgSize[0],
      height: this.trueImgSize[3] - this.trueImgSize[2],
    };
  }

  public reset() {
    this.renderGen++;
    this.samplingGen++;
    if (this.plotDiv) {
      Plotly.newPlot(this.plotDiv, [],
        this.getHeatmapLayout([0, 100], [100, 0]), CONFIG as any);
    }
  }

  /**
   * Fully remove Plotly's DOM from the plot div (axes included). Used when
   * handing the div to another backend (OpenSeadragon) — unlike `reset()`,
   * which re-renders an empty plot and would leave the Plotly axes showing.
   */
  public purgePlot() {
    this.renderGen++;
    if (this.plotDiv) {
      Plotly.purge(this.plotDiv);
    }
  }

  /** Export the heatmap as a PNG (the rendered plot already reflects the active
   *  colormap/window). The full-res tile composite is OSD's job. */
  public exportComposite(): void {
    this.downloadImage();
  }

  public downloadImage() {
    if (this.plotDiv) {
      (Plotly as any).downloadImage(this.plotDiv, { format: 'png', filename: this.fileName || 'image' });
    }
  }

  public resetAxes() {
    this.zoomCoordinates = [];
    this.relayout();
  }

  public setDragMode(mode: string | false) {
    this.dragMode = mode ? (mode as string) : '';
    if (!this.plotDiv) return;
    // Only relayout a LIVE Plotly graph. When another backend (OSD / napari-js) owns the view the
    // div id is still set but has no Plotly plot attached, and Plotly.relayout throws
    // ("can't access property _guiEditing, n is undefined"). That throw aborted the caller
    // (deactivateActiveTool → onSelectPlotType) before the re-plot ran, wedging the plot type
    // (e.g. stuck switching napari volume ↔ isosurface). Guard on `_fullLayout` like the zoom
    // helpers do so it safely no-ops when Plotly isn't the active renderer.
    const gd = document.getElementById(this.plotDiv) as unknown as { _fullLayout?: unknown } | null;
    if (!gd?._fullLayout) return;
    Plotly.relayout(this.plotDiv, { dragmode: mode } as any);
  }

  /** {@link IDataRenderer} stub — Plotly has no overview navigator (it's an
   *  OpenSeadragon feature), so toggling it is a no-op here. */
  public setNavigatorVisible(_visible: boolean): void {
    /* no-op: navigator is OpenSeadragon-only */
  }

  /** {@link IDataRenderer} stub — image smoothing is an OpenSeadragon canvas-drawer
   *  setting; the Plotly image/heatmap traces don't expose it, so it's a no-op. */
  public setImageSmoothingEnabled(_enabled: boolean): void {
    /* no-op: smoothing toggle is OpenSeadragon-only */
  }

  public zoomIn() {
    if (!this.plotDiv) return;
    const gd: any = document.getElementById(this.plotDiv);
    if (!gd?._fullLayout) return;
    const xl = gd._fullLayout.xaxis;
    const yl = gd._fullLayout.yaxis;
    // 3D scenes have no 2D xaxis/yaxis (they live under `scene`); the step-zoom
    // is meaningless there and would throw on `xl.range`. Plotly's scene handles
    // scroll-zoom natively, so just bail.
    if (!xl?.range || !yl?.range) return;
    const xc = (xl.range[0] + xl.range[1]) / 2;
    const yc = (yl.range[0] + yl.range[1]) / 2;
    const dx = (xl.range[1] - xl.range[0]) / ZOOM_BUTTON_STEP;
    const dy = (yl.range[1] - yl.range[0]) / ZOOM_BUTTON_STEP;
    const x0 = xc - dx / 2, x1 = xc + dx / 2;
    const y0 = yc - dy / 2, y1 = yc + dy / 2;
    this.zoomCoordinates = [x0, x1, y0, y1];
    Plotly.relayout(this.plotDiv, {
      'xaxis.range[0]': x0, 'xaxis.range[1]': x1,
      'yaxis.range[0]': y0, 'yaxis.range[1]': y1
    } as any);
  }

  /**
   * Delete every currently selected shape. Falls back to the single
   * `_activeShapeIndex` when no multi-selection is active (covers the case
   * where Plotly clicked a shape without going through the table).
   */
  public override deleteActiveShape() {
    // Note: no `plotDiv` guard — when OpenSeadragon is the renderer, Plotly
    // never plotted (plotDiv is unset), but deletion only needs the shape list
    // + the current selection; the Plotly relayout below is guarded.
    const gd: any = this.plotDiv ? document.getElementById(this.plotDiv) : null;

    // Resolve what to delete: the store's selection, else the shape Plotly
    // tracks as clicked (when the user clicked a shape without going through the
    // Region Editor table).
    if (this.regionStore.getSelectedShapeIndices().length === 0) {
      const activeIndex: number = gd?._fullLayout?._activeShapeIndex;
      if (activeIndex === undefined || activeIndex < 0) return;
      this.regionStore.setSelectedShapeIndices([activeIndex]);
    }
    // The store removes the selected regions, clears the selection, syncs its
    // cache and emits the region-update event.
    this.regionStore.deleteActiveShape();

    // Re-project the remaining regions and render on the Plotly plot (a no-op
    // when another backend owns the div — its overlay re-renders via the
    // store's update event).
    this.syncShapesFromStore();
    const live = this.liveGd();
    if (!live) return;
    live._fullLayout._activeShapeIndex = -1;
    const dictArray = this.shapes.map(s => ({ ...s }));
    Plotly.relayout(live, { shapes: dictArray } as any).then(
      () => { if (live._fullLayout) (Plotly as any).redraw(live); },
      (err: unknown) => console.warn('[viz:plotly] shape relayout after delete failed', err),
    );
  }

  public zoomOut() {
    if (!this.plotDiv) return;
    const gd: any = document.getElementById(this.plotDiv);
    if (!gd?._fullLayout) return;
    const xl = gd._fullLayout.xaxis;
    const yl = gd._fullLayout.yaxis;
    // 3D scenes have no 2D xaxis/yaxis — see zoomIn().
    if (!xl?.range || !yl?.range) return;
    const xc = (xl.range[0] + xl.range[1]) / 2;
    const yc = (yl.range[0] + yl.range[1]) / 2;
    const dx = (xl.range[1] - xl.range[0]) * ZOOM_BUTTON_STEP;
    const dy = (yl.range[1] - yl.range[0]) * ZOOM_BUTTON_STEP;
    const x0 = xc - dx / 2, x1 = xc + dx / 2;
    const y0 = yc - dy / 2, y1 = yc + dy / 2;
    this.zoomCoordinates = [x0, x1, y0, y1];
    Plotly.relayout(this.plotDiv, {
      'xaxis.range[0]': x0, 'xaxis.range[1]': x1,
      'yaxis.range[0]': y0, 'yaxis.range[1]': y1
    } as any);
  }

  public isStackLoading$(): Observable<boolean> {
    return this.stackLoading$.asObservable();
  }
  public setStackLoading(stackLoading: boolean) {
    this.stackLoading$.next(stackLoading);
  }
  public getStackLoadingProgress$(): Observable<number> {
    return this.stackLoadingProgress$.asObservable();
  }

  // Colormap / reverse-scale state lives in the shared VisualizerStore (the
  // base class forwards the getters); these setters add the Plotly-specific
  // live restyle as render glue.
  override setColormap(colormap: ColormapNode) {
    super.setColormap(colormap);
    const gd = this.liveGd(); // OSD/napari recolor via their own LUT
    const scale = colormap.data?.value;
    if (gd && scale != null) void Plotly.restyle(gd, { colorscale: [scale] } as Plotly.Data);
  }

  override setReverseScale(reverscale: boolean) {
    super.setReverseScale(reverscale);
    const gd = this.liveGd(); // OSD/napari recolor via their own LUT
    if (gd) void Plotly.restyle(gd, { 'reversescale': reverscale });
  }

  setShowStack(showstack: boolean) {
    if (!showstack) {
      this.zIndex.next(0);
    }
    if (this.imageInfo) this.imageInfo.showStack = showstack;
    this.stackLoading$.next(showstack);
    Plotly.relayout(this.plotDiv, { 'showstack': showstack } as any);
  }

  getAutoscaleEvent() {
    return this.autoscaleEvent.asObservable();
  }

  /**
   * Programmatically select regions (or clear with []). The shared store owns
   * the selection state (validates/dedupes/emits); here we additionally point
   * Plotly's `_activeShapeIndex` at the last selected shape so it gets the edit
   * handles. No visual change to non-active shapes — Plotly's own active-shape
   * rendering is the only highlight.
   */
  public override setSelectedShapeIndices(indices: number[]) {
    const valid = (indices || [])
      .filter(i => Number.isFinite(i) && i >= 0 && i < this.shapes.length);
    const seen = new Set<number>();
    const cleaned: number[] = [];
    for (const i of valid) {
      if (!seen.has(i)) { seen.add(i); cleaned.push(i); }
    }
    if (this.plotDiv) {
      const gd: any = document.getElementById(this.plotDiv);
      if (gd?._fullLayout) {
        gd._fullLayout._activeShapeIndex = cleaned.length > 0 ? cleaned[cleaned.length - 1] : -1;
        try { (Plotly as any).redraw(gd); } catch { /* noop in tests */ }
      }
    }
    this.regionStore.setSelectedShapeIndices(cleaned);
  }

  /**
   * Select a specific region (IRegionStore.selectRegion). Sets the shared store
   * selection by identity and points Plotly's active-shape at the matching
   * rendered shape so its edit handles appear.
   */
  public override selectRegion(region: Region): void {
    this.regionStore.selectRegion(region);
    if (this.plotDiv) {
      const idx = this.shapes.findIndex(s => s.id === region?.id);
      const gd: any = document.getElementById(this.plotDiv);
      if (gd?._fullLayout && idx >= 0) {
        gd._fullLayout._activeShapeIndex = idx;
        try { (Plotly as any).redraw(gd); } catch { /* noop in tests */ }
      }
    }
  }

  /**
   * Read Plotly's `_activeShapeIndex` and push it as the selection. Called from
   * the relayout handler and the post-click tick — Plotly doesn't fire a
   * dedicated active-shape event for clicks, so we sample. The store no-ops if
   * the selection is unchanged.
   */
  private maybeEmitActiveShapeIndex() {
    if (!this.plotDiv) return;
    const gd: any = document.getElementById(this.plotDiv);
    const raw = gd?._fullLayout?._activeShapeIndex;
    const idx = (typeof raw === 'number' && raw >= 0 && raw < this.shapes.length) ? raw : -1;
    this.regionStore.setSelectedShapeIndices(idx >= 0 ? [idx] : []);
  }
  setZIndex(zIndex: number) {
    this.zIndex.next(zIndex);
  }

  /**
   * Unsubscribe Subscriptions
   */
  unsubscribe() {
    this.imageCachedSubscription?.unsubscribe();
    this.imageCachedSubscription = undefined;
    this.filenameSubscription?.unsubscribe();
    this.filenameSubscription = undefined;
    this.regionUpdateSubscription?.unsubscribe();
    this.regionUpdateSubscription = undefined;
    this.regionLiveEditSubscription?.unsubscribe();
    this.regionLiveEditSubscription = undefined;
    this.channelSub?.unsubscribe();
    this.channelSub = undefined;
  }

  /** Live-apply the channel display window (zmin/zmax) + reverse/invert to the
   *  heatmap. No-op when no Plotly plot is mounted (OSD owns the div). */
  private applyChannelDisplay(channels: any[], rev: boolean, inv: boolean): void {
    const gd = this.liveGd();
    if (!gd) return;
    const ch = channels?.[0];
    const colorscale = this.store.currentColormap()?.data?.value;
    // reverse-scale and invert each flip the ramp; both together cancel.
    const update: any = { reversescale: rev !== inv };
    if (colorscale != null) update.colorscale = colorscale; // live colormap recolor
    if (ch) {
      // Surface/isosurface/scatter3d colour-map via cmin/cmax; heatmap/contour via zmin/zmax.
      const threeD =
        this.plotType === PlotType.ISOSURFACE ||
        this.plotType === PlotType.SURFACE ||
        this.plotType === PlotType.SCATTER3D;
      if (threeD) {
        update.cmin = ch.min;
        update.cmax = ch.max;
        update.cauto = false;
      } else {
        update.zmin = ch.min;
        update.zmax = ch.max;
        update.zauto = false;
      }
    }
    // A trace without a colour scale just ignores these attributes.
    void Plotly.restyle(gd, update);
  }

  /** Binned intensity histogram for a channel from the cached source frames
   *  (raw, pre-LUT). Grayscale cells are numbers; RGB cells are [r,g,b]. */
  getHistogram(channelIndex: number, _bins: number): IHistogram | null {
    const frames = this.cachedImageFrames;
    if (!frames?.length) return null;
    const frame = frames[this.activeFrameIndex()] ?? frames[0];
    if (!frame?.length) return null;
    const counts = new Array(256).fill(0);
    for (const row of frame) {
      if (!row) continue;
      for (const cell of row) {
        let v: number;
        if (Array.isArray(cell)) {
          v = channelIndex >= 0 && channelIndex < cell.length
            ? cell[channelIndex]
            : Math.round(bt601Luminance(cell[0], cell[1], cell[2]));
        } else {
          v = cell;
        }
        v = v | 0;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        counts[v]++;
      }
    }
    return histogram256(counts);
  }

  /** Async histogram stream — Plotly renders heatmap frame data (already in
   *  memory, 8-bit luminance), so this just wraps the synchronous 8-bit
   *  histogram. Native 16-bit histograms only apply to the OSD tile path. */
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null> {
    return of(this.getHistogram(channelIndex, bins));
  }

  /** Data export (16-bit TIFF) is an OSD-tile-path feature backed by the server.
   *  Plotly renders heatmaps from frame data, so there's nothing to export here. */
  exportData(): void {
    console.warn('[plotly] 16-bit data export is not available for the heatmap backend.');
  }

  /** As the base class, but the file is named after the image on screen. */
  override exportRegions(regions: Region[]) {
    const jsonString = this.plotUtilities.exportROIsToGeoJson(regions);
    this.plotUtilities.saveToFile(jsonString, this.fileName);
  }

  getStackLoadingProgress() {
    return this.getStackLoadingProgress$();
  }

  isStackLoading() {
    return this.isStackLoading$();
  }

}
