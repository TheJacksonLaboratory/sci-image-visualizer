import { Injectable, Inject, Optional } from '@angular/core';

import * as Plotly from 'plotly.js-dist-min';
import { Image } from 'image-js';
import { HttpClient } from '@angular/common/http';

import { Region } from '../../models/region';
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
import { IViewerBackend, IntensityProfile, IIsosurfaceControls, IIntensityControls, PixelData } from '../../contracts/visualizer.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { ViewerCapabilities, ViewerFeature, capabilitiesOf } from '../../contracts/capabilities.contract';
import { IRegionOverlay } from '../../contracts/region-overlay.contract';
import { PlotlyRegionOverlay } from './plotly-region-overlay';
import { PlotlyIsosurfaceControls } from './plotly-isosurface-controls';
import { PlotlyShapeProjection } from './plotly-shape-projection';
import { PlotlyZoomController } from './plotly-zoom-controller';
import { PlotlyImageLoader, PlotlyLoaded } from './plotly-image-loader';
import { axesSourceRect, channelDisplayRestyle, frameHistogram, tracePixels } from './plotly-readback';
import { renderIntensityInset as renderPlotlyIntensityInset } from './plotly-intensity-inset';
import { IntensityProfileService } from '../../intensity/intensity-profile.service';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';
import { PlotlyCoordinateTransform } from './plotly-coordinate-transform';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { BaseStoreVisualizer } from '../base-store-visualizer';
import { ColormapNode } from '../../contracts/display-types';
import { throwIfAborted } from '../tile-server/transport';

// Re-exported so existing consumers can keep importing PlotType from this
// module while it physically lives in the backend-neutral contracts/ dir.
// TODO(plotting-abstraction): once all consumers import from
// './contracts/plot-type' directly, drop this re-export.
export { PlotType } from '../../contracts/plot-type';

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
  /** Step/box zoom, autoscale and the high-def zoom re-fetch (see PlotlyZoomController). */
  private readonly zoom: PlotlyZoomController;
  private imageLength!: number;
  private screenHeight!: number;
  private plotDiv!: string;
  private scaleratio = true;
  private trueImgSize!: number[];
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
  /** Slice fetch + decode, the stack pool and its loading flag/progress. */
  private readonly loader: PlotlyImageLoader;
  // current index of image in stack (if stack), 0 if single image
  private zIndex = new BehaviorSubject<number>(0);
  private autoscaleEvent = new Subject<any>();
  /** The ISOSURFACE band, mapped onto the measured volume (see PlotlyIsosurfaceControls). */
  private readonly iso = new PlotlyIsosurfaceControls(
    () => this.plotType === PlotType.ISOSURFACE && !!this.plotDiv && !!this.liveGd(),
    (update) => void Plotly.restyle(this.liveGd(), update as Plotly.Data),
  );
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
    this.loader = new PlotlyImageLoader(http);
    this.zoom = new PlotlyZoomController({
      plotDiv: () => this.plotDiv,
      trueImgSize: () => this.trueImgSize,
      imageInfo: () => this.imageInfo,
      fileName: () => this.fileName,
      imageCached: () => this.imageCached,
      zIndex: () => this.zIndex.value,
      nextRenderGen: () => ++this.renderGen,
      isCurrentRender: (gen) => gen === this.renderGen,
      heatmapLayout: (x, y) => this.getHeatmapLayout(x, y),
      setScreenHeight: (h) => { this.screenHeight = h; },
      cropSampler: () => {
        const gen = this.intensity.supersede();
        return (frames, ratios, origin) => {
          if (!this.intensity.isCurrent(gen)) return;
          this.setSamplingFrames(frames, ratios, origin);
          this.intensity.emitProfiles();
        };
      },
      renderCrop: (frame, ratios, size, imageSize, fileName) =>
        this.renderZoomCrop(frame, ratios, size, imageSize, fileName),
      reset: () => this.reset(),
    }, state, tiles, messageService);
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
      pixelToData: (px, py) => this.zoom.pixelToData(px, py),
      applyZoomToBox: (coords) => this.zoom.applyZoomToBox(coords),
    };
    this.canvasTools = createCanvasToolManager(this.toolHost, {
      wandService, regionStore, samPoint: samPointTool,
    });

    this.ensureSubscriptions();
    // Service-lifetime, unlike ensureSubscriptions(): the shapes follow the
    // store across a view teardown (they no-op while no Plotly graph is live).
    this.shapeProjection.connect();
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
   * Load slice `zIndex`, or the whole shown stack (see PlotlyImageLoader).
   * `signal` aborts the requests: the load then rejects with an `AbortError`.
   */
  public async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<PlotlyLoaded> {
    throwIfAborted(signal);
    // Re-establish the store subscriptions if a prior component teardown
    // (unsubscribe()) tore them down — see ensureSubscriptions().
    this.ensureSubscriptions();
    return this.loader.load(imageInfo, zIndex, signal, () => {
      // [x0, x1, y0, y1]
      this.trueImgSize = [0, imageInfo.trueImageSize[0], 0, imageInfo.trueImageSize[1]];
      this.fileName = imageInfo.fileName;
    }, () => this.fileName === imageInfo.fileName);
  }

  /**
   * Plot a loaded image (see {@link load}) as `plotType`. `inPlace` updates the
   * existing plot via Plotly.react instead of purge + newPlot — the multi-tier
   * swap (small → large) — so the canvas doesn't briefly blank between phases.
   */
  public plot(plotDiv: string, imageLoaded: any, imageInfo: IImageInfo, screenHeight: number,
              plotType: PlotType, inPlace: boolean = false) {
    this.ensureSubscriptions();
    // A new image: a stroke or SAM prompt in progress belonged to the old one.
    if (!inPlace) this.canvasTools.resetAll();
    this.renderGen++;
    this.zoom.zoomCoordinates = [];
    const trueImageSize = [0, imageInfo.trueImageSize[0], 0, imageInfo.trueImageSize[1]]; // [x0, x1, y0, y1]
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
   * IIntensityControls: add another profile line (see IntensityProfileService).
   * It is a store region, so a Plotly plot on screen draws it from the store's
   * region-update event, like the OSD/napari overlays.
   */
  public addProfileLine(): Region | null {
    return this.intensity.addProfileLine();
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

  /**
   * {@link IIntensitySampling} stub — the viewport-change signal is OpenSeadragon's
   * (it re-samples on OSD zoom/pan). Plotly's own high-def zoom updates the
   * sampling frames inline, so it never emits here; returns EMPTY so a uniform
   * `IVisualizer` consumer can subscribe regardless of the active backend.
   */
  public getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return EMPTY;
  }

  /** Autoscale the plot (see PlotlyZoomController). */
  public autoscale() {
    this.zoom.autoscale();
  }

  /** Re-apply the image layout at the current height, over the zoom box if any. */
  public relayout(trueImageSize?: number[]) {
    this.zoom.relayout(trueImageSize);
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
    // Drag-zoom: remember the box and re-fetch it at high definition.
    this.zoom.onRelayout(event);
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

  /** Re-render a high-def zoom crop in the plot type on screen. Without this the
   *  re-fetch always fell back to a heatmap, so zooming in contour (or any
   *  registry type) reverted to heatmap. */
  private renderZoomCrop(frame: any[], ratios: number[], size: [number, number], imageSize: number[],
                         fileName?: string): { rendered: Promise<unknown>; reapplyRange: boolean } {
    const impl = PLOTLY_PLOT_TYPE_IMPLS[this.plotType];
    const rendered = impl
      ? this.plotViaRegistry(this.plotDiv, impl, this.buildTraceInput(this.imageInfo, {
          data: [frame], ratios, sizes: size, filename: fileName,
        }, imageSize), this.screenHeight)
      : (this.imageInfo?.isGrayscale
          ? this.plotHeatmap(this.plotDiv, this.urls, [frame], imageSize, ratios, this.screenHeight)
          : this.plotRGBHeatmap(this.plotDiv, this.urls, [frame], imageSize, ratios,
              size[0], size[1], this.screenHeight));
    // plotViaRegistry already applies the type's own layout/range for non-image
    // layouts (chart/overlay); only the image-aligned paths re-apply the range.
    return { rendered, reapplyRange: !impl || impl.layoutKind === '2d-image' };
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
   * added while it was off-screen. The switch is not redrawn onto the plot on
   * screen — that still shows the outgoing image, and the next plot draws the
   * incoming one's shapes. Called from `plot()` and from the router before any
   * backend renders.
   */
  public setActiveImage(imageInfo: IImageInfo) {
    this.shapeProjection.quietly(() => this.regionStore.setActiveImage(imageInfo));
    this.shapeProjection.syncFromStore();
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
   * Get the currently displayed image as an image-js Image instance.
   * Used by the processing pipeline to obtain the input image.
   */
  public async getCurrentImage(): Promise<Image | null> {
    if (!this.imageInfo || !this.imageInfo.urls || this.imageInfo.urls.length === 0) {
      return null;
    }
    const zIdx = this.zIndex.value || 0;
    const url = this.imageInfo.urls[zIdx] || this.imageInfo.urls[0];
    return this.loader.loadImage(url);
  }

  /**
   * Get the currently displayed plot pixel data as a flat Uint8ClampedArray.
   * This captures whatever is actually rendered — including zoomed regions.
   * Returns { width, height, channels, data } or null if no plot is displayed.
   */
  public getDisplayedPixelData(): PixelData | null {
    const gd: any = this.plotDiv ? document.getElementById(this.plotDiv) : null;
    if (!gd?.data || gd.data.length === 0) return null;
    return tracePixels(gd.data[this.activeFrameIndex()] || gd.data[0]);
  }

  /** The image rect the displayed `z` grid covers, in full-image pixel coords —
   *  read off the live axis ranges (a high-def zoom relays them out to the crop),
   *  else the whole image (see axesSourceRect). */
  public getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    const gd: any = this.plotDiv ? document.getElementById(this.plotDiv) : null;
    return axesSourceRect(gd?._fullLayout?.xaxis?.range, gd?._fullLayout?.yaxis?.range, this.trueImgSize);
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
    this.zoom.resetAxes();
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
    this.zoom.zoomIn();
  }

  public zoomOut() {
    this.zoom.zoomOut();
  }

  public isStackLoading$(): Observable<boolean> {
    return this.loader.stackLoading$.asObservable();
  }
  public setStackLoading(stackLoading: boolean) {
    this.loader.stackLoading$.next(stackLoading);
  }
  public getStackLoadingProgress$(): Observable<number> {
    return this.loader.stackLoadingProgress$.asObservable();
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
    this.loader.stackLoading$.next(showstack);
    Plotly.relayout(this.plotDiv, { 'showstack': showstack } as any);
  }

  getAutoscaleEvent() {
    return this.autoscaleEvent.asObservable();
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
    void Plotly.restyle(gd, channelDisplayRestyle(channels, rev, inv,
      this.store.currentColormap()?.data?.value, this.plotType) as Plotly.Data);
  }

  /** Binned intensity histogram for a channel from the cached source frames
   *  (raw, pre-LUT). Grayscale cells are numbers; RGB cells are [r,g,b]. */
  getHistogram(channelIndex: number, _bins: number): IHistogram | null {
    const frames = this.cachedImageFrames;
    if (!frames?.length) return null;
    const frame = frames[this.activeFrameIndex()] ?? frames[0];
    if (!frame?.length) return null;
    return frameHistogram(frame, channelIndex);
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
