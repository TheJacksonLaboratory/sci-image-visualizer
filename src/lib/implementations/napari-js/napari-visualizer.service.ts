import { Inject, Injectable } from '@angular/core';
import { Observable, BehaviorSubject, Subject, of } from 'rxjs';
import { Image } from 'image-js';
import { Viewer } from 'napari-js';
import type { VolumeLayer } from 'napari-js';

import { IImageInfo, IImageMetadata } from '../../contracts/image.contract';
import { Region } from '../../models/region';
import { PlotType, PlotTypeDescriptor, PLOT_TYPE_DESCRIPTORS } from '../../contracts/plot-type';
import {
  IVisualizer,
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
import { ColormapNode, IWandOptions, IBrushOptions } from '../../contracts/display-types';
import { VIZ_CONFIG, VizConfig } from '../../contracts/viz-config';
import { TILE_ACCESS_PORT, TileAccessPort } from '../../contracts/ports/tile-access.port';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';

/** Opaque handle from {@link NapariVisualizerService.load}, passed back to plot(). */
interface NapariLoaded {
  imageInfo: IImageInfo;
  z: number;
}

const VOLUME_MAX_SLICE = 256; // downsample volume slices for a tractable 3D preview

/**
 * A WebGPU image backend built on the published `napari-js` library — the POC engine for
 * jit-ui#102 (a browser-based napari shipped as a JS library, swapping image plotting with
 * OpenSeadragon and 3D slicing/isosurfaces with Plotly).
 *
 * Render strategy: rather than re-implement the server's tile/pyramid protocol (which OSD
 * already handles), this backend renders the **complete per-slice image URLs the app already
 * produces** (`IImageInfo.urls`) — `urls[z]` for the 2D image, and the full `urls` stack
 * assembled into a downsampled volume for the 3D types. Region state and display options
 * delegate to the shared {@link RegionStore} / {@link VisualizerStore}, exactly as OSD does.
 *
 * Follow-ups (jit-ui#102): native-resolution pyramidal tiling, on-canvas tools, region
 * overlay rendering, per-channel histograms, TIFF export.
 */
@Injectable({ providedIn: 'root' })
export class NapariVisualizerService implements IVisualizer {
  readonly capabilities: ViewerCapabilities = capabilitiesOf([
    ViewerFeature.ImageDisplay,
    ViewerFeature.StackSlider,
    ViewerFeature.PixelReadback,
    ViewerFeature.Surface3D,
    ViewerFeature.Isosurface,
  ]);

  private viewer: Viewer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private host: HTMLElement | null = null;
  private loaded: NapariLoaded | null = null;
  private lastPixels: PixelData | null = null;
  private currentPlotType: PlotType = PlotType.NAPARI_IMAGE;
  private volumeLayer: VolumeLayer | null = null;
  private volumeDims: { width: number; height: number; depth: number } | null = null;
  private imageW = 0;
  private imageH = 0;

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
    private readonly store: VisualizerStore,
    private readonly regionStore: RegionStore,
    @Inject(VIZ_CONFIG) _config: VizConfig,
  ) {}

  // ── IDataRenderer: load / render / viewport ───────────────────────────────
  async load(imageInfo: IImageInfo, zIndex: number): Promise<NapariLoaded> {
    this.loaded = { imageInfo, z: zIndex };
    return this.loaded;
  }

  async plot(
    plotDiv: string,
    imageLoaded: unknown,
    imageInfo: IImageInfo,
    screenHeight: number,
    plotType: PlotType,
    _inPlace?: boolean,
  ): Promise<boolean> {
    const host = document.getElementById(plotDiv);
    if (!host) {
      console.error(`[napari-js] plot target #${plotDiv} not found`);
      return false;
    }
    this.reset();
    this.host = host;
    this.currentPlotType = plotType;

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = screenHeight ? `${screenHeight}px` : '100%';
    host.appendChild(canvas);
    this.canvas = canvas;

    const info = (imageLoaded as NapariLoaded)?.imageInfo ?? imageInfo;
    const z = (imageLoaded as NapariLoaded)?.z ?? 0;

    try {
      const viewer = new Viewer({ canvas, background: { r: 0.07, g: 0.07, b: 0.09, a: 1 } });
      this.viewer = viewer;
      await viewer.ready;

      const isVolume =
        plotType === PlotType.NAPARI_VOLUME || plotType === PlotType.NAPARI_ISOSURFACE;
      if (isVolume) {
        const vol = await this.assembleVolume(info);
        if (vol) {
          this.imageW = vol.width;
          this.imageH = vol.height;
          this.volumeDims = vol;
          this.volumeLayer = viewer.addVolume(vol.data, vol.width, vol.height, vol.depth, {
            colormap: 'magma',
            rendering: plotType === PlotType.NAPARI_ISOSURFACE ? 'iso' : 'mip',
          });
        }
      } else {
        const url = info?.urls?.[z] ?? info?.urls?.[0];
        if (!url) {
          console.warn('[napari-js] no image URL to render for this image');
        } else {
          const bitmap = await this.fetchBitmap(url);
          this.imageW = bitmap.width;
          this.imageH = bitmap.height;
          viewer.addImage(bitmap, { colormap: info?.isGrayscale ? 'gray' : undefined });
          this.fitCameraSoon();
        }
      }
      this.scheduleReadback();
      return true;
    } catch (err) {
      console.error('[napari-js] plot failed:', err);
      return false;
    }
  }

  private async fetchBitmap(url: string): Promise<ImageBitmap> {
    const headers = await this.tiles.getAuthHeaders().catch(() => ({}) as Record<string, string>);
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`image fetch failed: ${resp.status} ${url}`);
    return createImageBitmap(await resp.blob());
  }

  /** Assemble a downsampled uint8 volume from the per-slice image URLs (luminance). */
  private async assembleVolume(
    info: IImageInfo | undefined,
  ): Promise<{ data: Uint8Array; width: number; height: number; depth: number } | null> {
    const urls = info?.urls ?? [];
    if (urls.length === 0) {
      console.warn('[napari-js] no slice URLs to assemble a volume');
      return null;
    }
    const first = await this.fetchBitmap(urls[0]);
    const scale = Math.min(1, VOLUME_MAX_SLICE / Math.max(first.width, first.height, 1));
    const width = Math.max(1, Math.round(first.width * scale));
    const height = Math.max(1, Math.round(first.height * scale));
    const depth = urls.length;
    const data = new Uint8Array(width * height * depth);

    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('napari-js volume assembly: 2D context unavailable');

    for (let z = 0; z < depth; z++) {
      const bmp = z === 0 ? first : await this.fetchBitmap(urls[z]);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bmp, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const base = z * width * height;
      for (let i = 0; i < width * height; i++) {
        data[base + i] =
          (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
      }
    }
    return { data, width, height, depth };
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
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /** @deprecated Plotly-specific; host re-drives plot() from its image stream. */
  reloadAndPlot(): void {
    /* no-op */
  }

  reset(): void {
    this.viewer?.dispose();
    this.viewer = null;
    if (this.canvas && this.host?.contains(this.canvas)) this.host.removeChild(this.canvas);
    this.canvas = null;
    this.lastPixels = null;
    this.volumeLayer = null;
    this.volumeDims = null;
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
    if (this.viewer) this.viewer.camera.zoom = this.viewer.camera.zoom * 1.3;
  }

  zoomOut(): void {
    if (this.viewer) this.viewer.camera.zoom = this.viewer.camera.zoom / 1.3;
  }

  setDragMode(_mode: string | false): void {
    // POC: on-canvas region tools not yet wired (jit-ui#102 follow-up).
  }

  setNavigatorVisible(_visible: boolean): void {
    /* napari-js has no minimap; no-op */
  }

  setImageSmoothingEnabled(_enabled: boolean): void {
    // TODO(jit-ui#102): map to ImageLayer.interpolation once layers are exposed per-plot.
  }

  setShowStack(_showstack: boolean): void {
    /* stack navigated via setZIndex */
  }

  setZIndex(zIndex: number): void {
    if (this.viewer) this.viewer.dims.z = zIndex;
    if (this.loaded) this.loaded.z = zIndex;
    this.scheduleReadback();
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
    return this.imageW > 0 && this.imageH > 0 ? { width: this.imageW, height: this.imageH } : null;
  }

  getCurrentImage(): Promise<Image | null> {
    return Promise.resolve(null);
  }

  getDisplayedPixelData(): PixelData | null {
    return this.lastPixels;
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

  /** @deprecated 3D not yet rendered by this backend. */
  setSurfaceDragMode(_mode: string): void {
    /* no-op */
  }

  /** @deprecated 3D not yet rendered by this backend. */
  resetSurfaceCamera(): void {
    const d = this.volumeDims;
    if (this.viewer && d) this.viewer.camera3d.frame(d.width, d.height, d.depth);
  }

  getAutoscaleEvent(): Observable<unknown> {
    return this.autoscaleEvent$.asObservable();
  }

  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    // The WebGPU napari-js options, offered alongside (not replacing) the OSD/Plotly types.
    return [
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_IMAGE]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_VOLUME]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_ISOSURFACE]!,
    ];
  }

  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.intensityProfile$.asObservable();
  }

  renderIntensityInset(_divId: string, _profiles: IntensityProfile[]): void {
    /* Plotly owns the intensity inset */
  }

  private scheduleReadback(): void {
    const v = this.viewer;
    if (!v) return;
    const run = (): void => {
      void v
        .readDisplayedPixels()
        .then((px) => {
          this.lastPixels = px;
          const size = this.getTrueImageSize();
          if (size) this.viewportChange$.next({ x: 0, y: 0, width: size.width, height: size.height });
        })
        .catch(() => undefined);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  // ── IRegionStore: delegate to the shared RegionStore ──────────────────────
  setRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
    append?: boolean,
  ): void {
    this.regionStore.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
  }
  getRegions(): Region[] {
    return this.regionStore.getRegions();
  }
  getRegionPolygons(): unknown[] {
    return this.regionStore.getRegionPolygons();
  }
  getRegionUpdateEvent(): Observable<unknown[]> {
    return this.regionStore.getRegionUpdateEvent();
  }
  setSelectedShapeIndices(indices: number[]): void {
    this.regionStore.setSelectedShapeIndices(indices);
  }
  getSelectedShapeIndices$(): Observable<number[]> {
    return this.regionStore.getSelectedShapeIndices$();
  }
  selectRegion(region: Region): void {
    this.regionStore.selectRegion(region);
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
  setPreviousShapes(shapes: unknown[]): void {
    this.regionStore.setPreviousShapes(shapes);
  }
  getPreviousShapes(): unknown[] {
    return this.regionStore.getPreviousShapes();
  }
  undo(): void {
    this.regionStore.undo();
  }
  redo(): void {
    this.regionStore.redo();
  }
  canUndo(): boolean {
    return this.regionStore.canUndo();
  }
  canRedo(): boolean {
    return this.regionStore.canRedo();
  }
  getCanUndo$(): Observable<boolean> {
    return this.regionStore.getCanUndo$();
  }
  getCanRedo$(): Observable<boolean> {
    return this.regionStore.getCanRedo$();
  }
  resetUndoHistory(): void {
    this.regionStore.resetUndoHistory();
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

  // ── IToolController: POC stubs (on-canvas tools are a jit-ui#102 follow-up) ─
  setWandMode(_active: boolean, _options?: IWandOptions): void {}
  setWandOptions(_options: IWandOptions): void {}
  clearActiveWandRegion(): void {}
  setBrushMode(_active: boolean, _options?: IBrushOptions): void {}
  setBrushOptions(_options: IBrushOptions): void {}
  setVertexEraserMode(_active: boolean): void {}
  setVertexEraserRadius(_radius: number): void {}
  setZoomToBoxMode(_active: boolean): void {}
  segmentRectangles(): Promise<number> {
    return Promise.resolve(0);
  }
  segmentRectanglesCellpose(): Promise<number> {
    return Promise.resolve(0);
  }
  setSamModel(_id: string): void {}
  setSamPointMode(_active: boolean): void {}
  commitSamPoints(): void {}
  clearSamPoints(): void {}

  // ── IDisplayOptions: delegate to the shared VisualizerStore ───────────────
  getColormap(): Observable<ColormapNode | null> {
    return this.store.getColormap();
  }
  setColormap(colormap: ColormapNode): void {
    this.store.setColormap(colormap);
  }
  getColormapOptions(): ColormapNode[] {
    return this.store.getColormapOptions();
  }
  getReverseScale(): Observable<boolean> {
    return this.store.getReverseScale();
  }
  setReverseScale(reverse: boolean): void {
    this.store.setReverseScale(reverse);
  }
  setImageMeta(imageMeta: IImageMetadata[]): void {
    this.store.setImageMeta(imageMeta);
  }
  getImageMeta(): Observable<IImageMetadata[]> {
    return this.store.getImageMeta();
  }

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
  ): void {}
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.viewportChange$.asObservable();
  }

  // ── IVisualizer composite members ─────────────────────────────────────────
  getRegionOverlay(): IRegionOverlay | null {
    // TODO(jit-ui#102): render regions as a DOM/canvas overlay positioned via worldToCanvas.
    return null;
  }
  getIsosurfaceControls(): IIsosurfaceControls | null {
    if (!this.volumeLayer) return null;
    return {
      setIsoRange: (isoMin: number, isoMax: number): void => {
        const vol = this.volumeLayer;
        if (!vol) return;
        vol.contrastLimits = [isoMin, isoMax];
        vol.rendering = 'iso';
        vol.isoThreshold = 0.5;
      },
    };
  }
  getIntensityControls(): IIntensityControls | null {
    return null;
  }
  getSurface3dControls(): ISurface3dControls | null {
    if (!this.volumeLayer) return null;
    return {
      setSurfaceDragMode: (): void => undefined,
      resetSurfaceCamera: (): void => this.resetSurfaceCamera(),
    };
  }
  getHistogram(_channelIndex: number, _bins: number): IHistogram | null {
    // TODO(jit-ui#102): per-channel native histogram from the source.
    return null;
  }
  getHistogram$(_channelIndex: number, _bins: number): Observable<IHistogram | null> {
    return of(null);
  }
  exportComposite(): void {
    const v = this.viewer;
    if (!v) return;
    void v.screenshot().then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'napari-js.png';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  exportData(): void {
    // TODO(jit-ui#102): native-bit-depth TIFF export via the server /export/tiff endpoint.
  }
  unsubscribe(): void {
    this.reset();
  }
}
