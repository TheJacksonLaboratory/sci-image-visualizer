import { Injectable, Inject, Optional } from '@angular/core';

import * as Plotly from 'plotly.js-dist-min';
import { Image } from 'image-js';
import { HttpClient } from '@angular/common/http';

import { Region } from '../../models/region';
import { Buffer } from 'buffer';
import { IImageInfo } from '../../contracts/image.contract';
import { TileAccessPort, TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { ImageStatePort, IMAGE_STATE_PORT } from '../../contracts/ports/image-state.port';
import { BehaviorSubject, EMPTY, Observable, Subject, Subscription, combineLatest, of } from 'rxjs';
import { MessageService } from 'primeng/api';
import { CONFIG, CONFIG_SURFACE, PlotUtilities } from '../../plot.utilities';
import { WandService } from '../../toolbar/wand/wand.service';
import { CachedImageData, CanvasToolHost } from '../../toolbar/tool-kit/canvas-tool';
import { CanvasToolManager } from '../../toolbar/tool-kit/canvas-tool-manager';
import { createCanvasToolManager } from '../../toolbar/canvas-tools';
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { ICellSegmenter, CELL_SEGMENTER } from '../../contracts/cell-segmenter.contract';
import { PlotType, PLOT_TYPE_DESCRIPTORS, PlotTypeDescriptor } from '../../contracts/plot-type';
import {
  PLOTLY_PLOT_TYPE_IMPLS,
  PlotlyPlotTypeImpl,
  TraceBuildInput,
  buildHeatmapTraces,
  buildRgbImageTraces,
  buildSurfaceTraces,
} from './plotly-trace-builders';
import {
  ImageLayoutContext, chartLayout, heatmapLayout, overlayLayout, surfaceLayout, volumeLayout,
} from './plotly-layouts';
import { IViewerBackend, IntensityProfile, IIsosurfaceControls, IIntensityControls } from '../../contracts/visualizer.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { bt601Luminance, histogram256 } from '../../contracts/intensity';
import { ViewerCapabilities, ViewerFeature, capabilitiesOf } from '../../contracts/capabilities.contract';
import { IRegionOverlay } from '../../contracts/region-overlay.contract';
import { PlotlyRegionOverlay } from './plotly-region-overlay';
import { PlotlyIsosurfaceControls } from './plotly-isosurface-controls';
import { PlotlyShapeProjection } from './plotly-shape-projection';
import { renderIntensityInset as renderPlotlyIntensityInset } from './plotly-intensity-inset';
import { IntensityProfileService } from '../../intensity/intensity-profile.service';
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
export class PlotlyService extends BaseStoreVisualizer implements IViewerBackend {

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

  /** Plotly's render projection of the shared RegionStore (the shape dicts) and
   *  the selection ↔ active-shape mapping (see PlotlyShapeProjection). */
  private readonly shapeProjection = new PlotlyShapeProjection(
    { plotDiv: () => this.plotDiv, fileName: () => this.fileName }, this.regionStore);
  private imageLength!: number;
  private screenHeight!: number;
  private plotDiv!: string;
  private isRealZoom = true;
  private scaleratio = true;
  private trueImgSize!: number[];
  private zoomCoordinates: number[] = [];
  private fileName!: string | undefined;

  private dragMode!: string;
  // Region data lives in the shared RegionStore (`this.regionStore`), Plotly's
  // shape dicts in `shapeProjection`; colormap, image metadata and
  // classification colours in the shared VisualizerStore (`this.store`).
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

  /** Pixel data cached for wand sampling. data[zIndex] is a 2-D matrix. */
  private cachedImageFrames?: any[];
  private cachedImageWidth = 0;
  private cachedImageHeight = 0;
  private cachedImageRatios: number[] = [1, 1];
  private cachedIsGrayscale = false;
  /** Data-space coordinate of the cached frame's pixel (0,0). [0,0] for the full
   *  image; a crop's top-left after a high-def zoom (so the tools sample the
   *  zoom-level pixels at the right offset/resolution). */
  private cachedFrameOrigin: [number, number] = [0, 0];
  /** events */
  private onRelayoutEvent: any;
  /** Bumped by every render of the plot div (plot, a high-def zoom re-render,
   *  purge, reset). A high-def zoom drops its crop if another render (or the
   *  hand-over of the div to another backend) happened while it was fetching. */
  private renderGen = 0;
  private stackLoading$ = new BehaviorSubject<boolean>(false);
  private stackLoadingProgress$ = new BehaviorSubject<number>(0);
  // current index of image in stack (if stack), 0 if single image
  private zIndex = new BehaviorSubject<number>(0);
  private autoscaleEvent = new Subject<any>();
  // The region update event and selection stream are owned by the shared
  // RegionStore; getRegionUpdateEvent()/getSelectedShapeIndices$() delegate to
  // it so every consumer (and the OSD backend) sees one stream.
  /** The ISOSURFACE band, mapped onto the measured volume (see PlotlyIsosurfaceControls). */
  private readonly iso = new PlotlyIsosurfaceControls(
    () => this.plotType === PlotType.ISOSURFACE && !!this.plotDiv && !!this.liveGd(),
    (update) => void Plotly.restyle(this.liveGd(), update as Plotly.Data),
  );
  // Id minting and the selection index stream are owned by the shared
  // RegionStore. Selection still drives Plotly's `_activeShapeIndex` (so a
  // single shape gets the edit handles) — see setSelectedShapeIndices().
  private imageCached = false;
  private imageCachedSubscription?: Subscription;
  private filenameSubscription?: Subscription;
  private channelSub?: Subscription;

  /** What this backend's canvas tools read and write (one host for every tool). */
  private readonly toolHost: CanvasToolHost;
  /** This backend's own wand, brush, eraser, zoom-to-box and SAM point tools. */
  protected readonly canvasTools: CanvasToolManager;
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
              private samTool: SamToolService,
              private samPointTool: SamPointToolService,
              private cellSegmentTool: CellSegmentToolService,
              @Optional() @Inject(CELL_SEGMENTER) private cellSegmenter: ICellSegmenter | null,
              store: VisualizerStore,
              regionStore: RegionStore,
              private intensity: IntensityProfileService) {
    super(regionStore, store);
    // relayout event router
    this.onRelayoutEvent = (event: any) => { this.relayoutEventHandler(event); };

    // The canvas tools read/mutate our state through one host, and this backend
    // owns its own tool instances (RT-21) — nothing to re-bind on activation.
    this.toolHost = {
      getRegions: () => this.regionStore.getRegions(),
      setRegions: (regions) => this.setRegions(regions),
      getCachedImageData: () => this.getCachedImageData(),
      getActiveFrameIndex: () => this.activeFrameIndex(),
      getOverlayContainer: () => this.getOverlayContainer(),
      getCoordinateTransform: () => this.getCoordinateTransform(),
      getFileName: () => this.fileName,
      getShapeColor: () => this.regionStore.getShapeColor(),
      pixelToData: (px, py) => this.zoomBoxPixelToData(px, py),
      applyZoomToBox: (coords) => this.applyZoomToBox(coords),
    };
    this.canvasTools = createCanvasToolManager(this.toolHost, {
      wandService, regionStore, samPoint: samPointTool,
    });

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
    // A new image: a stroke or SAM prompt in progress belonged to the old one.
    if (!inPlace) this.canvasTools.resetAll();
    this.renderGen++;
    const trueImageSize: number[] = [];
    this.zoomCoordinates = [];
    // [x0, x1, y0, y1]
    trueImageSize[0] = 0;
    trueImageSize[1] = imageInfo.trueImageSize[0];
    trueImageSize[2] = 0;
    trueImageSize[3] = imageInfo.trueImageSize[1];
    // Save the current image's regions and pull in any cached regions for the
    // image we're about to display, before Plotly.newPlot reads the shape projection.
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
    // The profiles sample the image on screen from now on (superseding any
    // sampling fetch still in flight for the previous one).
    this.intensity.supersede();
    this.intensity.setSamplingElement(plotDiv);
    this.intensity.setFrames({ frames: imageLoaded.data, ratios: imageLoaded.ratios },
      { imageInfo, extent: trueImageSize, frameIndex: () => this.activeFrameIndex() });

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

  /** Grayscale heatmap, one trace per z-plane (`trueImgSize` is [x0, x1, y0, y1]). */
  private plotHeatmap(plotDiv: string, urls: string[], images: any[], trueImgSize: number[],
                      ratios: number[], screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    const traces = buildHeatmapTraces(images, trueImgSize, ratios,
      this.store.currentColormap().data.value, this.store.currentReverseScale());
    const layout = () => this.getHeatmapLayout([trueImgSize[0], trueImgSize[1]], [trueImgSize[3], trueImgSize[2]]);
    return this.renderPlot(plotDiv, urls, images.length, screenHeight, inPlace, traces, layout, CONFIG, true);
  }

  /** Grayscale surface. */
  private plotSurface(plotDiv: string, urls: string[], images: any[], _trueImgSize: number[],
                      _ratios: number[], screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    const traces = buildSurfaceTraces(images, this.store.currentColormap().data.value,
      this.store.currentReverseScale());
    return this.renderPlot(plotDiv, urls, images.length, screenHeight, inPlace, traces,
      () => surfaceLayout(0.4), CONFIG_SURFACE, true);
  }

  /** RGB image, one trace per z-plane. */
  private plotRGBHeatmap(plotDiv: string, urls: string[], images: any[], trueImgSize: number[],
                         ratios: number[], width: number, height: number,
                         screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    // As autorange is off and the axis not reversed, the y range is set here.
    const traces = buildRgbImageTraces(images, trueImgSize, ratios, width, height);
    const layout = () => this.getHeatmapLayout([trueImgSize[0], trueImgSize[1]], [trueImgSize[3], trueImgSize[2]]);
    return this.renderPlot(plotDiv, urls, images.length, screenHeight, inPlace, traces, layout, CONFIG, false);
  }

  /**
   * Render `traces` into the plot div and wire the relayout/click events. In
   * place (`Plotly.react`) for the multi-tier small → large swap — `Plotly.purge`
   * + `Plotly.newPlot` blanks the canvas for ~100ms, which looks like a
   * regression to "loading" before the sharper version appears. The layout is
   * built after the per-plot state (screen height, slice count) is set.
   */
  private renderPlot(plotDiv: string, urls: string[], sliceCount: number, screenHeight: number,
                     inPlace: boolean, traces: any[], layout: () => any, config: unknown,
                     isGrayscale: boolean): Promise<boolean> {
    if (!inPlace) Plotly.purge(plotDiv);
    this.plotDiv = plotDiv;
    this.imageLength = sliceCount;
    this.urls = urls;
    this.screenHeight = screenHeight;
    const render = inPlace ? Plotly.react : Plotly.newPlot;
    return (render as any)(plotDiv, traces as any, layout(), config as any).then(() => {
      // handle the relayout event for zoom / rois and the click event
      this.setEvents(plotDiv, isGrayscale, screenHeight);
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
      this.iso.measure(imageLoaded.data, !!imageInfo.isGrayscale);
    }
    const [isoMin, isoMax] = this.iso.band();
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

  /** Update the isosurface intensity band (see PlotlyIsosurfaceControls). */
  public setIsoRange(isoMin: number, isoMax: number): void {
    this.iso.setIsoRange(isoMin, isoMax);
  }

  /** Plotly renders isosurfaces, so it exposes the isosurface controls (itself). */
  public getIsosurfaceControls(): IIsosurfaceControls | null { return this.iso; }

  /**
   * Render a registry-backed plot type: build its traces from the input, pick
   * the matching layout, render, and wire the usual relayout/click events.
   * Mirrors the structure of the dedicated heatmap/surface renderers.
   */
  private plotViaRegistry(plotDiv: string, impl: PlotlyPlotTypeImpl, input: TraceBuildInput,
                          screenHeight: number, inPlace: boolean = false): Promise<boolean> {
    const [x0, x1, y0, y1] = input.trueImageSize;
    const layout = (): any => {
      switch (impl.layoutKind) {
        case '3d-volume': return volumeLayout(this.screenHeight);
        case '2d-chart': return chartLayout(this.screenHeight);
        case '2d-overlay': return overlayLayout(this.layoutContext(), [x0, x1], [y1, y0]); // reversed y
        default: return this.getHeatmapLayout([x0, x1], [y1, y0]); // '2d-image'
      }
    };
    return this.renderPlot(plotDiv, this.imageInfo?.urls ?? this.urls, input.frames.length, screenHeight,
      inPlace, impl.buildTraces(input), layout, impl.threeD ? CONFIG_SURFACE : CONFIG, input.isGrayscale);
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
    return this.intensity.getIntensityProfile$();
  }

  /** Plotly renders the line ROIs + inset, so it exposes the intensity controls. */
  public getIntensityControls(): IIntensityControls | null { return this; }

  /** Render the floating intensity-profile inset (see plotly-intensity-inset.ts),
   *  so the consumer never touches Plotly directly. */
  public renderIntensityInset(divId: string, profiles: IntensityProfile[]): void {
    renderPlotlyIntensityInset(divId, profiles);
  }

  /** Region shapes for the image on screen (profile lines included: they are
   *  ordinary store regions). */
  private currentRenderShapes(showLabel = this.regionStore.getShowShapeLabel()): any[] {
    return this.shapeProjection.shapesToRedraw(showLabel);
  }

  /**
   * IIntensityControls: add another profile line (see IntensityProfileService),
   * and draw it at once when a Plotly plot is on screen (the OSD/napari overlays
   * render it from the store's region-update event).
   */
  public addProfileLine(): Region | null {
    const region = this.intensity.addProfileLine();
    if (region && this.plotDiv) {
      this.shapeProjection.syncFromStore();
      const gd = this.liveGd();
      if (gd) void Plotly.relayout(gd, { shapes: this.currentRenderShapes() } as any);
    }
    return region;
  }

  /**
   * Point the pixel tools at these frames (e.g. a high-def zoom crop whose pixel
   * (0,0) sits at image `origin`), and sample the intensity profiles from them.
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
    this.intensity.setFrames({ frames, ratios: this.cachedImageRatios, origin });
  }

  /** IIntensitySampling → IntensityProfileService (its own sampling frames). */
  public ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void> {
    return this.intensity.ensureIntensitySampling(imageInfo, zIndex);
  }

  /**
   * {@link IIntensitySampling} stub — the viewport-change signal is OpenSeadragon's
   * (it re-samples on OSD zoom/pan). Plotly's own high-def zoom updates the
   * sampling frames inline, so it never emits here; returns EMPTY so a uniform
   * `IVisualizer` consumer can subscribe regardless of the active backend.
   */
  public getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return EMPTY;
  }

  /** IIntensitySampling → IntensityProfileService: re-sample from a display-resolution
   *  crop of the visible region, sized from this viewer's plot div. */
  public refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number,
                                        zIndex: number): void {
    if (this.plotDiv) this.intensity.setSamplingElement(this.plotDiv);
    this.intensity.refreshIntensitySamplingForRoi(x, y, width, height, zIndex);
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
      this.onPlotMouseDown = () => setTimeout(() => this.shapeProjection.syncSelectionFromPlot(), 0);
      plot.addEventListener('mousedown', this.onPlotMouseDown);
    }
  }

  private relayoutEventHandler(event: any) {
    if (Object.keys(event).includes('dragmode')) {
      this.dragMode = event.dragmode;
    }
    const keys = Object.keys(event);
    // In-place shape edits and natively drawn shapes, mirrored into the store.
    this.shapeProjection.applyRelayout(event);
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
    this.shapeProjection.syncSelectionFromPlot();
  }

  public reloadAndPlot() {
    this.setImageInfo();
  }


  // ── Tool delegations ────────────────────────────────────────────────
  // The canvas tools (setActiveTool and the per-tool setters) are run by
  // BaseStoreVisualizer over this.canvasTools; Plotly needs no pointer gating.

  /** Box-prompted SAM: segment the drawn rectangles against our tool host
   *  (cached frame + coordinate transform + region store). */
  public segmentRectangles(): Promise<number> {
    return this.samTool.segmentBoxes(this.toolHost);
  }
  public segmentRectanglesCellpose(): Promise<number> {
    if (!this.cellSegmenter) return Promise.resolve(0);
    return this.cellSegmentTool.segmentBoxes(this.toolHost, this.cellSegmenter);
  }
  public setSamModel(id: string): void {
    this.samTool.setModel(id);
    this.samPointTool.setModel(id);
  }

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

  // ── Canvas tool host ────────────────────────────────────────────────

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
    const samplingGen = this.intensity.supersede();
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
          if (this.intensity.isCurrent(samplingGen)) {
            this.setSamplingFrames([frame], [xRatio, yRatio], [imageSize[0], imageSize[2]]);
            this.intensity.emitProfiles();
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
    this.shapeProjection.syncFromStore();
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
    this.shapeProjection.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
  }

  /** The plot div while it hosts a live Plotly graph, else null. `plotDiv`
   *  stays set after purgePlot() hands the div to another backend (OSD,
   *  napari-js), and Plotly.relayout/restyle throw on a non-Plotly div. */
  private liveGd(): any | null {
    const gd: any = this.plotDiv ? document.getElementById(this.plotDiv) : null;
    return gd?._fullLayout ? gd : null;
  }

  /** The live state an image-aligned layout is built from. */
  private layoutContext(): ImageLayoutContext {
    return {
      screenHeight: this.screenHeight,
      scaleratio: this.scaleratio,
      dragMode: this.dragMode,
      shapes: this.currentRenderShapes(this.regionStore.getShowShapeLabel()),
      fillColor: this.regionStore.getFillColor(),
      shapeColor: this.regionStore.getShapeColor(),
    };
  }

  private getHeatmapLayout(xRange: number[], yRange: number[]): any {
    return heatmapLayout(this.layoutContext(), xRange, yRange, this.imageLength);
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
    this.intensity.supersede();
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
      void Plotly.downloadImage(this.plotDiv, { format: 'png', filename: this.fileName || 'image' });
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
    this.shapeProjection.deleteActiveShape();
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
    this.shapeProjection.setSelectedShapeIndices(indices);
  }

  /** Select a region (IRegionStore.selectRegion), giving its shape the edit handles. */
  public override selectRegion(region: Region): void {
    this.shapeProjection.selectRegion(region);
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
    this.regionStore.exportRegions(regions, this.fileName);
  }

  getStackLoadingProgress() {
    return this.getStackLoadingProgress$();
  }

  isStackLoading() {
    return this.isStackLoading$();
  }

}
