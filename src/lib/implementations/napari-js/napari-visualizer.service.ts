import { Inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, Subject, firstValueFrom, of } from 'rxjs';
import { Image } from 'image-js';
import { Viewer } from 'napari-js';

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
import { buildNapariTiledSource, ServerTileDescriptor } from './napari-tile-source';

/** Opaque handle returned by {@link NapariVisualizerService.load} and passed back to plot(). */
interface NapariLoaded {
  kind: 'tiled' | 'simple';
  descriptor?: ServerTileDescriptor;
  infoB64?: string;
  url?: string;
  z: number;
}

/**
 * A WebGPU image backend built on the published `napari-js` library — the POC engine for
 * jit-ui#102 ("a browser-based napari shipped as a JS library … swap image plotting with
 * OpenSeadragon"). Renders the IMAGE plot type on WebGPU; region state and display options
 * delegate to the shared {@link RegionStore} / {@link VisualizerStore} (exactly as the OSD
 * backend does), so both backends stay in sync and can be swapped live.
 *
 * Scope (POC, opt-in via `VizConfig.useNapariRenderer`): renders server-composited tiles via
 * napari-js. Follow-ups (jit-ui#102): on-canvas tools, region overlay rendering, per-channel
 * GPU recolouring + native histograms, and TIFF export — currently delegated, no-op, or null.
 */
@Injectable({ providedIn: 'root' })
export class NapariVisualizerService implements IVisualizer {
  readonly capabilities: ViewerCapabilities = capabilitiesOf([
    ViewerFeature.ImageDisplay,
    ViewerFeature.StackSlider,
    ViewerFeature.PixelReadback,
  ]);

  private readonly api: string;

  private viewer: Viewer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private host: HTMLElement | null = null;
  private loaded: NapariLoaded | null = null;
  private lastPixels: PixelData | null = null;

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
    private readonly http: HttpClient,
    @Inject(TILE_ACCESS_PORT) private readonly tiles: TileAccessPort,
    private readonly store: VisualizerStore,
    private readonly regionStore: RegionStore,
    @Inject(VIZ_CONFIG) config: VizConfig,
  ) {
    this.api = config.slideCropServer;
  }

  // ── IDataRenderer: load / render / viewport ───────────────────────────────
  async load(imageInfo: IImageInfo, zIndex: number): Promise<NapariLoaded> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (imageInfo.tiled !== false && infoB64) {
      const headers = await this.tiles.getAuthHeaders();
      const descriptor = await firstValueFrom(
        this.http.get<ServerTileDescriptor>(
          `${this.api}tiles/info?info=${encodeURIComponent(infoB64)}`,
          { headers },
        ),
      );
      this.loaded = { kind: 'tiled', descriptor, infoB64, z: zIndex };
    } else {
      this.loaded = { kind: 'simple', url: imageInfo.urls?.[zIndex], z: zIndex };
    }
    return this.loaded;
  }

  async plot(
    plotDiv: string,
    imageLoaded: unknown,
    _imageInfo: IImageInfo,
    screenHeight: number,
    _plotType: PlotType,
    _inPlace?: boolean,
  ): Promise<boolean> {
    const host = document.getElementById(plotDiv);
    if (!host) return false;
    this.reset();
    this.host = host;

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = screenHeight ? `${screenHeight}px` : '100%';
    host.appendChild(canvas);
    this.canvas = canvas;

    const viewer = new Viewer({ canvas });
    this.viewer = viewer;
    await viewer.ready;

    const loaded = imageLoaded as NapariLoaded;
    if (loaded?.kind === 'tiled' && loaded.descriptor && loaded.infoB64) {
      const source = buildNapariTiledSource(loaded.descriptor, {
        apiBase: this.api,
        infoB64: loaded.infoB64,
        authHeaders: () => this.tiles.getAuthHeaders(),
      });
      viewer.addImage(source);
      viewer.dims.z = loaded.z ?? 0;
    } else if (loaded?.url) {
      const bitmap = await createImageBitmap(await (await fetch(loaded.url)).blob());
      viewer.addImage(bitmap);
    }

    this.scheduleReadback();
    return true;
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
  }

  relayout(_trueImageSize?: number[]): void {
    // napari-js auto-resizes via ResizeObserver; just nudge a redraw.
    this.viewer?.requestRender();
  }

  /** @deprecated Plotly-specific axis reset. */
  resetAxes(): void {
    this.fitToView();
  }

  /** @deprecated Plotly-specific autoscale. */
  autoscale(): void {
    this.fitToView();
    this.autoscaleEvent$.next(undefined);
  }

  private fitToView(): void {
    const v = this.viewer;
    const size = this.getTrueImageSize();
    if (!v || !size || !this.canvas) return;
    v.camera.fit(size.width, size.height, this.canvas.clientWidth, this.canvas.clientHeight);
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
    const d = this.loaded?.descriptor;
    return d ? { width: d.width, height: d.height } : null;
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

  setPlotType(_plotType: PlotType): void {
    /* napari-js backend renders the image type only */
  }

  /** @deprecated 3D not yet rendered by this backend. */
  setSurfaceDragMode(_mode: string): void {
    /* no-op */
  }

  /** @deprecated 3D not yet rendered by this backend. */
  resetSurfaceCamera(): void {
    /* no-op */
  }

  getAutoscaleEvent(): Observable<unknown> {
    return this.autoscaleEvent$.asObservable();
  }

  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    return [PLOT_TYPE_DESCRIPTORS[PlotType.IMAGE]!];
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
    // Async GPU readback cached for the synchronous getDisplayedPixelData() contract.
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
    return null;
  }
  getIntensityControls(): IIntensityControls | null {
    return null;
  }
  getSurface3dControls(): ISurface3dControls | null {
    return null;
  }
  getHistogram(_channelIndex: number, _bins: number): IHistogram | null {
    // TODO(jit-ui#102): per-channel native histogram from the source tiles.
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
