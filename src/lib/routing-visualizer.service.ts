import { Inject, Injectable, NgZone, OnDestroy, Optional, inject } from '@angular/core';
import { EMPTY, Observable, Subject, Subscription, combineLatest, merge, BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';
import { Image } from 'image-js';
import { resolveColormap } from 'napari-js';

import { IImageInfo, IImageMetadata } from './contracts/image.contract';
import { Polygon, Region } from './models/region';
import { ClassPreset, PresetSet } from './models/class-preset';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import {
  PlotType,
  PlotTypeDescriptor,
  isNapari3d,
  isNapariScatter,
  isSpatialOmics,
  isSpatialOmics3d,
  isNapariIsosurface,
  isNapariVolume,
} from './contracts/plot-type';
import {
  IViewerBackend,
  IVisualizer,
  LoadedImage,
  PixelData,
  IntensityProfile,
  IIsosurfaceControls,
  IIntensityControls,
  ISurface3dControls,
  ISpatialControls,
  IIntensitySampling,
  IOsdViewOptions,
  IVolumeResolution,
} from './contracts/visualizer.contract';
import { SPATIAL_DATA_PORT, SpatialDataPort } from './contracts/ports/spatial-data.port';
import type { SpatialDataset } from './contracts/spatial-dataset.contract';
import { drawnCellSets } from './spatial/lod';
import { CanvasToolOptions, ColormapNode, IBrushOptions, IWandOptions } from './contracts/display-types';
import { SpatialControlsFacade } from './spatial/spatial-controls.facade';
import { RegionStore } from './store/region-store.service';
import { RegionScopeCache } from './store/region-scope-cache';
import { REGION_SOURCE_MIN_CHARS, RegionSource, RegionSourceView } from './region-source/region-source';
import type { RegionIndexPage, RegionIndexQuery, RegionSourceInfo } from './region-source/region-tiles';
import type { RegionStyle } from './region-overlay/region-style';
import type { Mesh } from 'napari-js/geometry';
import { openGeoJsonRegionSource } from './region-source/worker-region-source';
import type { RegionSourceOpener, RegionSourceSlices } from './store/region-source-scope';
import { SpatialSelectionStore } from './store/spatial-selection.service';
import { ViewerCapabilities } from './contracts/capabilities.contract';
import { IRegionOverlay } from './contracts/region-overlay.contract';
import { IRegionEditorApi, SliceScale } from './contracts/region-editor-api.contract';
import { planeSpacing, planeWeights } from './spatial/spatial-planes';
import { IChannelHistogramApi, IChannelState, IHistogram } from './contracts/channel-histogram-api.contract';
import { autoWindowFromHistogram } from './contracts/intensity';
import { VisualizerStore } from './store/visualizer-store.service';
import { NapariVisualizerService } from './implementations/napari-js/napari-visualizer.service';
import { channelTintColormap, volumeColormap } from './implementations/napari-js/napari-display-state';
import { VIZ_CONFIG, VizConfig } from './contracts/viz-config';
import { PlotModeViewport } from './contracts/plot-type-contribution.contract';
import { IntensityProfileService } from './intensity/intensity-profile.service';
import { changedClasses, classSignatures } from './store/class-signatures';
import { VolumeSections } from './visualizer/volume-sections';
import { WebGlSpatialLayer } from './implementations/spatial-webgl/webgl-spatial-layer';
import { WEBGPU_PROBE } from './util/webgpu-support';
import type { SectionAxis, SectionViews } from './contracts/section-view.contract';

/** How long after the last edit the surfaces of the classes it touched are rebuilt (ms). */
export const REGION_SURFACE_REBUILD_MS = 600;

/** Intensity-profile line ROIs are owned by the intensity tool, not the editor.
 *  Package-internal predicate (property-based so it also matches plain objects
 *  after a drag round-trip). */
function isProfileRegion(r: { kind?: string } | null | undefined): boolean {
  return r?.kind === 'profile';
}

/**
 * The visualizer chain's front door: implements `IVisualizer`, `IRegionEditorApi`
 * and `IChannelHistogramApi` (bound to the `VISUALIZER` / `REGION_EDITOR_API` /
 * `CHANNEL_HISTOGRAM_API` tokens) over three rendering backends, chosen per plot type:
 *  - **Image** renders through OpenSeadragon (natively tiled, region tools,
 *    client-side colormap), or through napari-js when `VizConfig.useNapariRenderer`
 *    opts in; the napari image types and the 2D spatial-omics mode render through
 *    napari-js. A failed load falls back napari-js → OSD → Plotly for that image only
 *    (see `napariFellBack` / `osdFellBack`, cleared by `reset()`).
 *  - the napari 3D types (volume, isosurface, surface, 3D scatter, the 3D spatial
 *    cloud) render through napari-js, falling back to Plotly.
 *  - every other plot type (heatmap, contour, surface, scatter, line, …) renders
 *    through Plotly.
 *
 * Only rendering and the viewport are routed to the backend on screen. Region state
 * lives in the shared `RegionStore` and display state (colormap, channels, presets,
 * spatial view) in the shared `VisualizerStore`, so every backend sees the same
 * values; the backends subscribe to them to redraw.
 *
 * Package-internal: hosts depend on the tokens, not on this class.
 */
@Injectable({ providedIn: 'root' })
export class RoutingVisualizerService implements IVisualizer, IRegionEditorApi, IChannelHistogramApi, OnDestroy {
  private currentPlotType: PlotType = PlotType.IMAGE;
  private lastRendered: IViewerBackend | null = null;
  /** OSD failed for the *current* render cycle (e.g. a fresh file still caching
   *  past the deadline) → fall back to Plotly for this image only. Reset by
   *  reset() at the start of every render cycle, so the next file — or a
   *  re-select once the file is cached — retries OSD. (Was a permanent flag,
   *  which left the whole session stuck on Plotly after one slow load.) */
  private osdFellBack = false;
  /** napari-js failed for the current render cycle → fall back to OSD (then Plotly).
   *  Reset by reset() at the start of every cycle, like {@link osdFellBack}. */
  private napariFellBack = false;
  /** Whether this browser can run napari-js; asked before any plot is routed to it. */
  private readonly webGpu = inject(WEBGPU_PROBE);
  private readonly zone = inject(NgZone);
  /** The spatial markers over OpenSeadragon when napari-js cannot draw them (no WebGPU). Built on
   *  first use, and only when a spatial port is bound. */
  private webglSpatial: WebGlSpatialLayer | null = null;
  /** Counts plot() calls: a plot's completion acts only while it is still the latest. */
  private plotRequest = 0;
  /** The file name of the image last plotted (names a GeoJSON export). */
  private plottedFileName: string | undefined;
  /** The div the backends render into (every backend shares it); '' before the first plot. */
  private plotDiv = '';
  /**
   * Whether regions can be shown in 3D on screen: a napari volume (or isosurface) view, or the 3D
   * spatial cloud over a stack image (its reference volume's, see showVolumeAsImage). Both draw the
   * region reconstructions the same way (VolumeRegionMeshes), in the volume's box.
   */
  private readonly volumeView$ = new BehaviorSubject<boolean>(false);
  /** Whether a napari volume (or isosurface) view is the current plot type: the slice pane's. */
  private imageVolumeView = false;
  /** Whether the volume view's slice pane is wanted (see {@link setSliceEditor}). */
  private readonly sliceEditor$ = new BehaviorSubject<boolean>(false);
  /** Whether the volume view draws the region reconstructions through the volume. */
  private readonly regionsThroughVolume$ = new BehaviorSubject<boolean>(false);
  /** Region reconstructions built so far, by image, resolution and classes (with those classes). */
  private readonly meshCache = new Map<string, { mesh: Mesh; classes: readonly string[] }>();
  /** Bumped per {@link showRegionClasses3d} (and per new image), so only the latest one shows. */
  private meshRequest = 0;
  /** The class groups shown in 3D, and the image they belong to. */
  private readonly classes3d$ = new BehaviorSubject<ReadonlyArray<{ key: string; classes: readonly string[] }>>(
    [],
  );
  private classes3dImage: string | undefined;
  /**
   * The spatial dataset's region set attached to its image (see attachDatasetRegionSet): the image
   * (its region scope key), the set's key, and where its slices are when it says (its `sliceZ`),
   * which places its surfaces in spatial 3D on an image of one plane. `shown3d` once its classes
   * were shown in 3D by themselves, which happens once per image.
   */
  private datasetRegionSet: DatasetRegionSetState | null = null;
  /**
   * Each image's attached region set, kept across image switches: coming back to the image finds
   * its source still in the store (with what was taken from it, or deleted) and restores the set
   * rather than attaching it again, which would start the source afresh.
   */
  private readonly attachedRegionSets = new Map<string, DatasetRegionSetState>();
  /** The spatial dataset on offer (the port's), for the boundary set its region set is. */
  private spatialDataset: SpatialDataset | null = null;
  /**
   * Whether the Annotations switch last hid every class in a spatial view (see syncAnnotations), so
   * a change of it, not every view emission, hides or shows them.
   */
  private annotationsHidden = false;
  /** The 3D view's global cells switch as last applied (see updateCells3d). */
  private cells3dMode: 'types' | 'cells' = 'types';
  /** Classes set the other way than the global switch in the Region Editor. */
  private readonly cells3dOverrides = new Map<string, boolean>();
  /** The classes drawn as individual cells in spatial 3D, as last applied. */
  private readonly individual3d$ = new BehaviorSubject<ReadonlySet<string>>(new Set());
  /** The classes that can be drawn as individual cells now (see getCellableClasses3d$). */
  private readonly cellable3d$ = new BehaviorSubject<ReadonlySet<string>>(new Set());
  /** Follows the dataset and the spatial view for {@link updatePlaneCells}. */
  private readonly planeCellsSub: Subscription | null;
  /** The dataset region set's planes while they slice the plotted image (see getDatasetPlanes$). */
  private readonly datasetPlanes$ = new BehaviorSubject<readonly number[] | null>(null);
  /** The groups last asked for in 3D, with their colours: what an edit's rebuild shows again. */
  private shown3d: ReadonlyArray<{ key: string; classes: readonly string[]; color: string; label?: string }> = [];
  /**
   * Each class's fingerprint on the live slice (see classSignatures), which image and slice, and
   * what the region sources hold (see RegionStore.getSourceStateKey). Null while nothing follows
   * the edits (no surface built, no sections).
   */
  private liveClasses: { at: string; signatures: Map<string, number>; sources: string } | null = null;
  /** The pending rebuild of the surfaces an edit touched. */
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly regionUpdates: Subscription;

  // ── The slice pane (the volume view's split): OSD editing one slice beside the 3D view ──
  /** The div the slice pane renders into while it is wanted (null: no split). */
  private sliceDiv: string | null = null;
  /** Whether OSD is mounted in the slice pane: region, tool and overlay calls go to it. */
  private sliceMounted = false;
  /** The image the slice pane shows. */
  private sliceFile: string | undefined;
  /** Bumped per slice-pane mount or teardown, so only the latest one lands. */
  private sliceRequest = 0;
  /** The sections beside the split volume view (the planes x and y through the stack). */
  private readonly sections: VolumeSections;
  /** The z plane dragged in the volume: the slice to show (see {@link getSliceDrag$}). */
  private readonly sliceDrag$ = new Subject<number>();
  private readonly sectionSubs = new Subscription();
  /** The image info and screen height of the last plot (what the slice pane mounts). */
  private plottedInfo: IImageInfo | null = null;
  /** The current region import (see regionImportTicket): its id and the image it was taken for. */
  private importTicket: { id: number; image: string | undefined } = { id: 0, image: undefined };
  private plottedHeight = 0;

  constructor(
    private plotly: PlotlyService,
    private osd: OpenSeadragonVisualizerService,
    private napari: NapariVisualizerService,
    private store: VisualizerStore,
    @Inject(VIZ_CONFIG) private config: VizConfig,
    // Optional: a host that serves no spatial-omics data binds nothing,
    // and `getSpatialControls()` then returns null.
    private regionStore: RegionStore,
    private selectionStore: SpatialSelectionStore,
    private intensity: IntensityProfileService,
    @Optional()
    @Inject(SPATIAL_DATA_PORT)
    private spatialData: SpatialDataPort | null = null,
  ) {
    this.regionUpdates = this.regionStore.getRegionUpdateEvent().subscribe(() => this.onRegionsChanged());
    this.planeCellsSub = this.spatialData
      ? combineLatest([this.spatialData.getDataset$(), this.store.getSpatialView$()]).subscribe(([dataset]) => {
          this.spatialDataset = dataset ?? null;
          this.updatePlaneCells();
          this.syncAnnotations();
          this.updateCells3d();
        })
      : null;
    this.sections = new VolumeSections({
      volume: () => this.napari.volumeVoxels(),
      image: () => this.plottedFileName,
      showPlanes: (planes) => this.napari.setSlicePlanes(planes),
      outlinesByClass: (level) => this.regionStore.outlinesByClass(level),
      isClassHidden: (label) => this.regionStore.isClassHidden(label),
      colorOf: (label) => this.classColor(label),
      channelStates: () => this.store.currentChannelStates(),
      colormap: (st, multichannel) => {
        // As the volume scene colours the channel (invert is applied before the colormap).
        const display = {
          colormap: this.store.currentColormap(),
          reverse: this.store.currentReverseScale(),
          invert: false,
        };
        return resolveColormap(
          multichannel ? channelTintColormap(st?.color ?? '#ffffff', display) : volumeColormap(st, display),
        );
      },
      invert: () => this.store.currentInvert(),
      slice: () => this.currentZIndex,
    });
    // A plane dragged in the volume: the z plane picks the slice (through the host's slider, so
    // the store and the slice pane follow), the others move their section.
    this.sectionSubs.add(
      this.napari.getSlicePlaneMove$().subscribe(({ axis, value }) => {
        if (axis === 'z') this.sliceDrag$.next(Math.round(value));
        else this.sections.setPlane(axis, value);
      }),
    );
    this.sectionSubs.add(this.store.getChannelStates().subscribe(() => this.sections.schedule()));
    this.sectionSubs.add(this.store.getInvert().subscribe(() => this.sections.schedule()));
    this.sectionSubs.add(this.store.getColormap().subscribe(() => this.sections.schedule()));
    this.sectionSubs.add(this.store.getReverseScale().subscribe(() => this.sections.schedule()));
  }

  /** A class's colour: its classification colour, else its region source's, else a default. */
  private classColor(label: string): string {
    return (
      this.store.getClassificationColors().get(label) ??
      this.regionStore.getRegionSourceView()?.colorOf({ label, color: null }) ??
      '#ffcc00'
    );
  }

  /** The sections beside the split volume view (nulls while it is not split). */
  getSectionViews$(): Observable<SectionViews> {
    return this.sections.getViews$();
  }

  /** Move a section's plane to `at` (image px). */
  setSectionPlane(axis: SectionAxis, at: number): void {
    this.sections.setPlane(axis, at);
  }

  /** The slice picked by dragging the z plane in the volume: the host shows it (its slider). */
  getSliceDrag$(): Observable<number> {
    return this.sliceDrag$.asObservable();
  }

  private isImageType(t: PlotType): boolean {
    return t === PlotType.IMAGE;
  }

  /** The 2D napari types (image, region-centroid scatter, spatial omics) — a 2D fallback chain
   *  (OSD, then Plotly).
   *
   *  SPATIAL_OMICS without WebGPU: OpenSeadragon draws the tissue image and the WebGL fallback
   *  ({@link WebGlSpatialLayer}) draws the observation markers and the gene map over it — what
   *  napari-js alone draws (cell outlines, transcripts, density, per-gene icons) is absent. Should
   *  OSD fail too, Plotly shows the image alone. */
  private isNapariImageType(t: PlotType): boolean {
    return t === PlotType.NAPARI_IMAGE || isNapariScatter(t) || isSpatialOmics(t);
  }

  /** The 3D napari types (volume/isosurface/surface/scatter, plus the 3D spatial cloud) — no 2D
   *  fallback exists (OSD is image-only), so they fall straight to Plotly. */
  private isNapari3dType(t: PlotType): boolean {
    return isNapari3d(t) || isSpatialOmics3d(t);
  }

  /**
   * Backend to attempt for the current plot type this render. The fallback chains below are
   * mirrored exactly by {@link load} so the handle `plot()` receives always comes from the
   * backend `plot()` selects (no load/plot backend mismatch):
   *  - 2D image (explicit `NAPARI_IMAGE`, or `IMAGE` with the WebGPU opt-in): napari-js → OSD → Plotly.
   *  - plain `IMAGE` (no opt-in): OSD → Plotly.
   *  - 3D napari (`NAPARI_VOLUME`/`NAPARI_ISOSURFACE`): napari-js → Plotly (OSD can't render 3D).
   */
  private imageBackend(): IViewerBackend {
    const t = this.currentPlotType;
    // 2D image with a napari-js attempt (explicit napari image, or opt-in on the Image type).
    if (this.isNapariImageType(t) || (this.isImageType(t) && this.config.useNapariRenderer)) {
      if (!this.napariFellBack) return this.napari;
      if (!this.osdFellBack) return this.osd;
      return this.plotly;
    }
    // Plain Image type (no napari opt-in): OSD, then Plotly.
    if (this.isImageType(t)) {
      return this.osdFellBack ? this.plotly : this.osd;
    }
    // 3D napari types: napari-js, with Plotly as the only viable fallback.
    if (this.isNapari3dType(t)) {
      return this.napariFellBack ? this.plotly : this.napari;
    }
    return this.plotly;
  }

  /** Backend currently on screen — what ongoing zoom/tool/region ops act on. */
  private renderer(): IViewerBackend {
    return this.lastRendered ?? this.plotly;
  }

  /**
   * Backend region, tool and overlay calls act on: the slice pane's OSD while the volume view is
   * split (regions are edited there), else the backend on screen. View calls (zoom, fit, colour,
   * export) stay with {@link renderer}.
   */
  private regionBackend(): IViewerBackend {
    return this.sliceMounted ? this.osd : this.renderer();
  }

  // System capabilities are Plotly's (the full-featured backend) so the UI
  // keeps offering every plot type regardless of which one is on screen.
  get capabilities(): ViewerCapabilities {
    return this.plotly.capabilities;
  }

  // ── render / viewport → active renderer ──────────────────────────────
  async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<LoadedImage> {
    // A stack can open away from slice 0 (`initialZIndex` — a volume opens
    // mid-specimen), and that arrives here rather than through setZIndex.
    this.currentZIndex = zIndex;
    this.spatialViewChanged$.next();
    zIndex = this.imageSlice(zIndex, imageInfo);
    const backend = this.imageBackend();
    if (backend === this.napari) {
      try {
        // napari-js only records the image in load(); without WebGPU its viewer fails later, in
        // plot(), where nothing falls back. Asking here sends the render down the fallback chain.
        if (!(await this.webGpu())) throw new Error('WebGPU is not available in this browser');
        return await this.napari.load(imageInfo, zIndex, signal);
      } catch (err) {
        // Aborted: nobody wants this image any more, so don't go on to load it elsewhere.
        if (signal?.aborted) throw err;
        this.napariFellBack = true;
        // Mirror imageBackend()'s fallback so load + plot pick the same backend:
        //  - 3D napari types have no 2D fallback → straight to Plotly.
        //  - 2D image → OSD, then Plotly.
        if (this.isNapari3dType(this.currentPlotType)) {
          console.warn('[visualizer] napari-js load failed — falling back to Plotly.', err);
          return this.plotly.load(imageInfo, zIndex, signal);
        }
        console.warn('[visualizer] napari-js load failed — falling back to OpenSeadragon.', err);
        return this.loadViaOsdThenPlotly(imageInfo, zIndex, signal);
      }
    }
    if (backend === this.osd) {
      return this.loadViaOsdThenPlotly(imageInfo, zIndex, signal);
    }
    return this.plotly.load(imageInfo, zIndex, signal);
  }

  /** Try OSD; on failure fall back to Plotly for this image (not permanent — see reset()). */
  private async loadViaOsdThenPlotly(
    imageInfo: IImageInfo,
    zIndex: number,
    signal?: AbortSignal,
  ): Promise<LoadedImage> {
    try {
      return await this.osd.load(imageInfo, zIndex, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[visualizer] OpenSeadragon load failed — falling back to Plotly for this image.', err);
      this.osdFellBack = true;
      return this.plotly.load(imageInfo, zIndex, signal);
    }
  }
  plot(
    plotDiv: string,
    imageLoaded: unknown,
    imageInfo: IImageInfo,
    screenHeight: number,
    plotType: PlotType,
    inPlace?: boolean,
  ): Promise<boolean> {
    this.currentPlotType = plotType;
    const request = ++this.plotRequest;
    this.spatialViewChanged$.next();
    this.plottedFileName = imageInfo?.fileName;
    this.plottedInfo = imageInfo ?? null;
    this.plottedHeight = screenHeight;
    this.updateVolumeView(plotType);
    // The slice pane belongs to the volume view: another plot type takes it down (OSD may be
    // about to draw the main view, which must not find the pane's viewer still mounted).
    if (!this.imageVolumeView) this.unmountSlice();
    // Region surfaces belong to the image they were built from: another image drops them.
    if (this.classes3d$.value.length && this.plottedFileName !== this.classes3dImage) this.clearRegionClasses3d();
    // So does a dataset's region set: where its planes are is no other image's. Its attachment is
    // kept (attachedRegionSets), to be restored when its image is back.
    if (this.datasetRegionSet && this.datasetRegionSet.image !== this.importImageKey()) {
      this.datasetRegionSet = null;
      this.napari.setRegionPlanes(null);
      this.datasetPlanes$.next(null);
      this.spatialViewChanged$.next();
      this.updateVolumeView(plotType);
      this.updateCells3d();
    }
    this.updatePlaneCells();
    this.syncAnnotations();
    this.updateCells3d();
    this.plotDiv = plotDiv;
    // Apply the per-image region cache (snapshot old regions, restore the new
    // image's, clear selection) for whichever backend renders — Plotly does
    // this inside its own plot(), but OSD doesn't, so drive it here. Idempotent
    // for the same image, so it's safe to call on every (re)plot.
    this.plotly.setActiveImage(imageInfo);
    const next = this.imageBackend();
    // Both backends share the same div — tear down the outgoing one on switch.
    // Plotly must be *purged* (not reset, which re-draws empty axes) before OSD
    // takes the div.
    if (this.lastRendered && this.lastRendered !== next) {
      if (this.lastRendered === this.plotly) this.plotly.purgePlot();
      else this.lastRendered.reset();
    }
    this.lastRendered = next;
    // The WebGL spatial markers belong to an OSD viewer showing the spatial type: anything else,
    // or a new OSD viewer (a non-in-place plot rebuilds it), takes them down; a re-attach follows.
    const spatialOnOsd = isSpatialOmics(plotType) && next === this.osd;
    if (!spatialOnOsd || !inPlace) this.detachWebGlSpatial();
    const drawn = next.plot(plotDiv, imageLoaded, imageInfo, screenHeight, plotType, inPlace).then((ok) => {
      // Only for the latest plot: a slow spatial plot overtaken by an image plot on the same OSD
      // viewer must not put the markers over that image.
      const latest = request === this.plotRequest && isSpatialOmics(this.currentPlotType);
      if (ok && spatialOnOsd && latest && this.lastRendered === this.osd && !this.webglSpatial?.attached)
        this.attachWebGlSpatial();
      return ok;
    });
    // A dataset's region set is shown in 3D once the cloud's scene is up: its voxel step is the scene's.
    const plotted = this.datasetRegionSet?.planes
      ? drawn.then((ok) => {
          if (ok) this.showDatasetRegionSet3d();
          return ok;
        })
      : drawn;
    if (!this.sliceDiv || !this.imageVolumeView) return plotted;
    // The split volume view: the slice pane follows the image (a new one, or its sharper pass).
    return plotted.then((ok) => {
      if (ok && (!this.sliceMounted || this.sliceFile !== imageInfo?.fileName || inPlace)) {
        void this.mountSlice(!!inPlace && this.sliceMounted && this.sliceFile === imageInfo?.fileName);
      }
      // The volume was assembled again (another image, or resolution): cut the sections from it.
      if (ok) this.sections.schedule();
      return ok;
    });
  }

  /**
   * Split the volume view: show the slice being edited in `div` (OpenSeadragon, with every region
   * tool) beside the 3D view, or stop (null). Kept across re-plots of a volume view; another plot
   * type takes the pane down and a volume view brings it back. Resolves whether the pane shows.
   */
  async setSliceEditor(div: string | null): Promise<boolean> {
    this.sliceDiv = div;
    if (this.sliceEditor$.value !== !!div) this.sliceEditor$.next(!!div);
    if (!div) {
      this.unmountSlice();
      return false;
    }
    return this.mountSlice(false);
  }

  /** Mount (or refresh in place) OSD in the slice pane on the displayed slice. */
  private async mountSlice(inPlace: boolean): Promise<boolean> {
    const div = this.sliceDiv;
    const info = this.plottedInfo;
    if (!div || !info?.urls?.length || !this.imageVolumeView) return false;
    const request = ++this.sliceRequest;
    try {
      const loaded = await this.osd.load(info, this.currentZIndex);
      if (request !== this.sliceRequest) return false;
      const ok = await this.osd.plot(div, loaded, info, this.plottedHeight, PlotType.IMAGE, inPlace);
      if (request !== this.sliceRequest) return false;
      this.sliceMounted = ok;
      this.sliceFile = info.fileName;
      if (ok) {
        // The slice may have moved while the pane loaded.
        this.osd.setZIndex(this.currentZIndex);
        this.trackLiveClasses();
        this.sections.start();
      }
      return ok;
    } catch (err) {
      if (request === this.sliceRequest)
        console.warn('[visualizer] The slice pane could not show the image.', err);
      return false;
    }
  }

  /** Take the slice pane's viewer down (the split stays wanted while {@link sliceDiv} is set). */
  private unmountSlice(): void {
    this.sliceRequest++;
    if (this.sliceMounted) {
      this.osd.reset();
      this.sections.stop();
    }
    this.sliceMounted = false;
    this.sliceFile = undefined;
  }
  reloadAndPlot(): void {
    this.plotly.reloadAndPlot();
  }
  reset(): void {
    // Start of a render cycle: re-enable napari-js/OSD attempts (clear any prior
    // per-image fallback) and tear down whatever's on screen.
    this.osdFellBack = false;
    this.napariFellBack = false;
    this.detachWebGlSpatial();
    this.renderer().reset();
  }
  relayout(trueImageSize?: number[]): void {
    this.renderer().relayout(trueImageSize);
  }
  resetAxes(): void {
    this.renderer().resetAxes();
  }
  fitToView(): void {
    this.renderer().fitToView();
  }
  /** @deprecated Use {@link fitToView}. */
  autoscale(): void {
    this.fitToView();
  }
  zoomIn(): void {
    this.renderer().zoomIn();
  }
  zoomOut(): void {
    this.renderer().zoomOut();
  }
  setDragMode(mode: string | false): void {
    this.renderer().setDragMode(mode);
    if (this.sliceMounted) this.osd.setDragMode(mode);
  }
  /** Every backend, on screen or not. */
  private backends(): IViewerBackend[] {
    return [this.plotly, this.osd, this.napari];
  }

  /**
   * The navigator / smoothing options, applied to EVERY backend that has them (not
   * just the active renderer): consumers set them before the first render, when
   * `renderer()` is still the Plotly default, and OSD/napari-js must receive them
   * to honour them at viewer creation.
   */
  getOsdViewOptions(): IOsdViewOptions {
    return this.viewOptions;
  }
  private readonly viewOptions: IOsdViewOptions = {
    setNavigatorVisible: (visible) => {
      for (const b of this.backends()) b.getOsdViewOptions()?.setNavigatorVisible(visible);
    },
    setImageSmoothingEnabled: (enabled) => {
      for (const b of this.backends()) b.getOsdViewOptions()?.setImageSmoothingEnabled(enabled);
    },
  };
  /** @deprecated Use `getOsdViewOptions().setNavigatorVisible()`. */
  setNavigatorVisible(visible: boolean): void {
    this.viewOptions.setNavigatorVisible(visible);
  }
  /** @deprecated Use `getOsdViewOptions().setImageSmoothingEnabled()`. */
  setImageSmoothingEnabled(enabled: boolean): void {
    this.viewOptions.setImageSmoothingEnabled(enabled);
  }
  setShowStack(showstack: boolean): void {
    this.renderer().setShowStack(showstack);
  }
  setZIndex(zIndex: number): void {
    this.currentZIndex = zIndex;
    this.spatialViewChanged$.next();
    const slice = this.imageSlice(zIndex);
    this.renderer().setZIndex(slice);
    this.webglSpatial?.setZ();
    if (this.datasetRegionSet?.planes) this.napari.setRegionPlane(zIndex);
    if (this.sliceMounted) {
      this.osd.setZIndex(slice);
      this.sections.schedule();
    }
  }

  /**
   * The image's own slice for slider position `z`: 0 while the dataset region set's planes slice an
   * image of one plane (the slider then picks the plane, see getDatasetPlanes$), else `z`.
   */
  private imageSlice(z: number, info: IImageInfo | null | undefined = this.plottedInfo): number {
    return this.datasetRegionSet?.planes && !info?.isStack ? 0 : z;
  }

  /**
   * The planes of the spatial dataset's region set (its `sliceZ`, in observation units) while they
   * slice the plotted image, an image of one plane; null otherwise. The host's slice slider then
   * runs over them: each position shows that plane's regions and, in the 2D spatial view, the
   * observations and transcripts nearest it, over the same image.
   */
  getDatasetPlanes$(): Observable<readonly number[] | null> {
    return this.datasetPlanes$.asObservable();
  }
  getTrueImageSize(): { width: number; height: number } | null {
    return this.renderer().getTrueImageSize();
  }
  getCurrentImage(): Promise<Image | null> {
    return this.renderer().getCurrentImage();
  }
  getDisplayedPixelData(): PixelData | null {
    return this.renderer().getDisplayedPixelData();
  }
  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    return this.renderer().getDisplayedSourceRect();
  }
  downloadImage(): void {
    this.renderer().downloadImage();
  }
  exportComposite(): void {
    this.renderer().exportComposite();
  }

  setPlotType(plotType: PlotType): void {
    this.currentPlotType = plotType;
    this.spatialViewChanged$.next();
    this.updateVolumeView(plotType);
    this.updatePlaneCells();
    this.syncAnnotations();
    this.updateCells3d();
    this.plotly.setPlotType(plotType);
  }
  /** @deprecated Use `getSurface3dControls()`. */
  setSurfaceDragMode(mode: string): void {
    this.getSurface3dControls()?.setSurfaceDragMode(mode);
  }
  /** @deprecated Use `getSurface3dControls()`. */
  resetSurfaceCamera(): void {
    this.getSurface3dControls()?.resetSurfaceCamera();
  }
  /** The 3D decimate factor of the backend on screen (napari-js), else null. */
  getVolumeResolution(): IVolumeResolution | null {
    return this.renderer().getVolumeResolution();
  }
  /** @deprecated Use `getVolumeResolution()?.set()`. */
  setResolutionScale(scale: number): void {
    this.getVolumeResolution()?.set(scale);
  }
  /** @deprecated Use `getVolumeResolution()?.get()`. */
  getResolutionScale(): number {
    return this.getVolumeResolution()?.get() ?? 1;
  }
  /** The viewport of the backend on screen, for a contributed plot mode. Null
   *  when that backend cannot provide one (e.g. OSD fell back to Plotly). */
  getPlotModeViewport(): PlotModeViewport | null {
    return this.renderer().getPlotModeViewport?.() ?? null;
  }
  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    // Plotly enumerates the full PLOT_TYPE_DESCRIPTORS map, which already includes the
    // napari-js WebGPU types (jit-ui#102) — so this single source covers them (no duplicates).
    return this.plotly.getPlotTypeDescriptors();
  }

  // ── long-lived observables + stack flags ──────────────────────────────────
  setStackLoading(b: boolean): void {
    this.plotly.setStackLoading(b);
  }
  // Cancel in-flight loading on every backend — the user's Cancel shouldn't depend on which one is
  // active. Only backends that stream frames (napari-js) do real work; the rest no-op. The concrete
  // backend classes don't all declare the optional contract method, so call it via IViewerBackend.
  cancelLoading(): void {
    for (const backend of [this.plotly, this.osd, this.napari] as IViewerBackend[]) {
      backend.cancelLoading?.();
    }
  }
  // Loading state is surfaced from whichever backend is doing the work: OSD and napari-js (volume
  // assembly) drive their own subjects, so merge all three into one stable stream the host
  // subscribes to once. (Previously hardcoded to Plotly, so napari/OSD progress never showed.)
  isStackLoading(): Observable<boolean> {
    return combineLatest([
      this.plotly.isStackLoading(),
      this.osd.isStackLoading(),
      this.napari.isStackLoading(),
    ]).pipe(map((flags) => flags.some(Boolean)));
  }
  getStackLoadingProgress(): Observable<number> {
    // Report the progress of whichever backend is ACTIVELY loading (max across active ones). A plain
    // merge let an idle backend's stale value win the stream on a re-load — leaving the bar below the
    // active backend's real progress (e.g. stuck ~⅓ while the % read 100). Gating by the loading flag
    // ignores idle backends, so the bar tracks the one doing the work and reaches 100%.
    const track = (v: IViewerBackend): Observable<[number, boolean]> =>
      combineLatest([v.getStackLoadingProgress(), v.isStackLoading()]);
    return combineLatest([track(this.plotly), track(this.osd), track(this.napari)]).pipe(
      map((pairs) => {
        const active = pairs.filter(([, loading]) => loading).map(([p]) => p);
        return active.length ? Math.max(...active) : 0;
      }),
    );
  }
  // Every backend fits to view on its own (Plotly's autoscale, OSD's goHome, napari's camera
  // fit) and each emits from its own subject, so merge all three: listening to Plotly alone
  // missed the context-menu Autoscale on the Image and napari views.
  getAutoscaleEvent(): Observable<void> {
    return merge(
      this.plotly.getAutoscaleEvent(),
      this.osd.getAutoscaleEvent(),
      this.napari.getAutoscaleEvent(),
    ).pipe(map(() => undefined));
  }
  /** The line-ROI profiles: sampled by the backend-neutral IntensityProfileService. */
  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.intensity.getIntensityProfile$();
  }
  // The intensity inset is a Plotly LINE chart — render it through Plotly whichever
  // backend draws the main image.
  renderIntensityInset(divId: string, profiles: IntensityProfile[]): void {
    this.plotly.renderIntensityInset(divId, profiles);
  }

  // ── regions ──────────────────────────────────────────────────────────
  // Region state lives in the shared RegionStore, so every read and write goes
  // straight to it. Every backend draws from the store's events: the OSD and
  // napari-js overlays and Plotly's shape projection redraw on its region-update
  // and selection streams, and the canvas tools reset on getRegionSetReplaced$
  // (undo, redo, a slice switch).
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
  getRegionPolygons(): Polygon[] {
    return this.regionStore.getRegionPolygons();
  }
  getRegionUpdateEvent(): Observable<Region[]> {
    return this.regionStore.getRegionUpdateEvent();
  }
  setSelectedShapeIndices(indices: number[]): void {
    this.regionStore.setSelectedShapeIndices(indices);
  }
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
  // Annotation-class presets live in the shared VisualizerStore (backend-neutral
  // session state), so route straight to it rather than through renderer(). (jit-ui#70)
  getPresetSet(): PresetSet {
    return this.store.getPresetSet();
  }
  getPresetSet$(): Observable<PresetSet> {
    return this.store.getPresetSet$();
  }
  setPresetSet(set: PresetSet): void {
    this.store.setPresetSet(set);
  }
  upsertClass(preset: ClassPreset): void {
    this.store.upsertClass(preset);
  }
  removeClass(name: string): void {
    this.store.removeClass(name);
  }
  resetPresets(): void {
    this.store.resetPresets();
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
  /** Download `regions` as GeoJSON, named after the image last plotted. */
  exportRegions(regions: Region[]): void {
    this.regionStore.exportRegions(regions, this.plottedFileName);
  }
  getGeoJsonString(regions: Region[]): string {
    return this.regionStore.getGeoJsonString(regions);
  }

  /** Hold a large region set as a tiled region source (see RegionStore.attachRegionSource). */
  attachRegionSource(source: RegionSource | RegionSourceOpener, slices?: RegionSourceSlices): void {
    this.regionStore.attachRegionSource(source, slices);
  }
  async importRegionSource(geoJsonStr: string): Promise<boolean> {
    if (geoJsonStr.length < (this.config?.regionSourceMinChars ?? REGION_SOURCE_MIN_CHARS)) return false;
    let opened: RegionSource | null = await openGeoJsonRegionSource(geoJsonStr);
    // The first open is the one just made; a source closed to save memory parses again.
    this.regionStore.attachRegionSource(() => {
      const source = opened;
      opened = null;
      return source ? Promise.resolve(source) : openGeoJsonRegionSource(geoJsonStr);
    });
    return true;
  }
  dropRegionSource(): Promise<void> {
    return this.regionStore.dropSliceRegionSource();
  }

  /**
   * A ticket for a region import that is about to read or decode its files: the import methods
   * given it change nothing once it is stale — another import took a ticket since, another image
   * was plotted, or the service was destroyed — so an import that finishes late never lands on an
   * image it was not started for.
   */
  regionImportTicket(): number {
    this.importTicket = { id: this.importTicket.id + 1, image: this.importImageKey() };
    return this.importTicket.id;
  }

  /** Whether `ticket` is still the current import's, on the image it was taken for. */
  private importTicketValid(ticket: number): boolean {
    return ticket === this.importTicket.id && this.importTicket.image === this.importImageKey();
  }

  private importImageKey(): string | undefined {
    return RegionScopeCache.imageKey(this.plottedInfo ?? undefined);
  }

  /**
   * Replace the image's regions and region sources with one source per slice, as an imported label
   * volume or folder of per-slice region files gives them: `openers` by slice index, each opened
   * the first time its slice is shown. A single image takes slice 0's. Returns how many slices
   * have a source, or null (changing nothing) when `ticket` is stale (see
   * {@link regionImportTicket}). The sources are marked imported, so a save writes every slice.
   */
  importSliceRegionSources(openers: ReadonlyMap<number, RegionSourceOpener>, ticket?: number): number | null {
    if (ticket !== undefined && !this.importTicketValid(ticket)) return null;
    this.regionImportTicket(); // supersedes any import still in flight
    const info = this.plottedInfo;
    this.regionStore.detachRegionSources();
    if (!info?.isStack) {
      const first = openers.get(0) ?? openers.values().next().value;
      this.regionStore.setRegions([]);
      this.regionStore.resetUndoHistory();
      if (!first) return 0;
      this.regionStore.attachRegionSource(first, { slice: 0 }, true);
      return 1;
    }
    this.enterImportedStack(info);
    for (const [z, open] of openers) this.regionStore.attachRegionSource(open, { slice: z }, true);
    return openers.size;
  }

  /**
   * Replace the image's regions and region sources with one imported source (a region set the
   * host's server serves): over every slice of a stack when it is z-indexed, else on the slice
   * shown, as {@link applyImageRois} lays out an image's own. Resolves false, changing nothing
   * (and disposing the source), when the import went stale while it opened: another import, or
   * another image (see {@link regionImportTicket}; one is taken here when `ticket` is not given).
   */
  async importRegionSourceOpener(open: RegionSourceOpener, ticket?: number): Promise<boolean> {
    const mine = ticket ?? this.regionImportTicket();
    if (!this.importTicketValid(mine)) return false;
    let first: RegionSource | null = await open();
    if (!this.importTicketValid(mine)) {
      first.dispose();
      return false;
    }
    const reuse: RegionSourceOpener = () => {
      const source = first;
      first = null;
      return source ? Promise.resolve(source) : open();
    };
    const info = this.plottedInfo;
    const planes = first.info.planes;
    const zIndexed = !!info?.isStack && planes.some((p) => p !== 0);
    this.regionStore.detachRegionSources();
    if (zIndexed) {
      this.enterImportedStack(info as IImageInfo);
      this.regionStore.attachRegionSource(reuse, 'planes', [...planes]);
      return true;
    }
    this.regionStore.setRegions([]);
    this.regionStore.resetUndoHistory();
    this.regionStore.attachRegionSource(reuse, { slice: this.regionStore.getDisplaySlice() }, true);
    return true;
  }

  /**
   * Attach a spatial dataset's region set (a 3D segmentation's cells, outlined on every plane they
   * span) to its image, the image plotted now, as the image's own regions are: over every slice
   * from the set's planes (`'planes'`), not marked imported (it is the dataset's, nothing to save),
   * leaving the image's drawn regions as they are. Once per image and set: called again (the
   * dataset re-emitted, the image re-plotted) it changes nothing. Where the set's slices are (its
   * `sliceZ`) places its surfaces among the observations in spatial 3D, where the region editor then
   * offers its classes in 3D; there, every class is shown once by itself (see showDatasetRegionSet3d).
   * Back on an image the set was attached to, with its source still the store's, it is restored as
   * it was (what was taken from the source, or deleted, stays so), not attached again.
   * Resolves false, changing nothing (the source disposed), when another image was plotted or
   * another set attached while it opened, it could not be opened, or the image has region sources
   * of its own (which it would replace, see keepsOwnSources).
   */
  async attachDatasetRegionSet(open: RegionSourceOpener, key: string): Promise<boolean> {
    const image = this.importImageKey();
    if (!image) return false;
    const current = this.datasetRegionSet;
    if (current?.image === image && current.key === key) {
      this.showDatasetRegionSet3d();
      return true;
    }
    // Back on an image whose set is attached: its source is still the store's, with what was taken
    // from it. Restored, not attached again.
    const known = this.attachedRegionSets.get(image);
    if (known?.key === key && known.opener && known.opener === this.regionStore.getPlanesSourceOpener()) {
      this.useDatasetRegionSet(known);
      return true;
    }
    if (this.keepsOwnSources(key)) return false;
    // Claimed before the source opens: a second call meanwhile changes nothing.
    const claim: DatasetRegionSetState = {
      image,
      key,
      planes: null,
      planeIds: null,
      micronsPerUnit: null,
      groups: [],
      shown3d: false,
      opener: null,
    };
    this.datasetRegionSet = claim;
    let first: RegionSource | null;
    try {
      first = await open();
    } catch (err) {
      if (this.datasetRegionSet === claim) this.datasetRegionSet = null;
      console.warn("[visualizer] the dataset's region set could not be opened", err);
      return false;
    }
    if (this.datasetRegionSet !== claim || this.importImageKey() !== image || this.keepsOwnSources(key)) {
      if (this.datasetRegionSet === claim) this.datasetRegionSet = null;
      first.dispose();
      return false;
    }
    const info = first.info;
    const reuse: RegionSourceOpener = () => {
      const source = first;
      first = null;
      return source ? Promise.resolve(source) : open();
    };
    const planes = info.sliceZ?.length && info.sliceZ.length === info.planes.length ? info.sliceZ : null;
    // Sliced by its planes, the image's regions are held per plane (see useDatasetRegionSet): stack
    // mode first, so the source is laid out on the plane shown.
    if (planes && planes.length > 1 && !this.plottedInfo?.isStack && !this.regionStore.isStackMode()) {
      const z = this.currentZIndex < planes.length ? this.currentZIndex : 0;
      this.regionStore.enterStackMode(new Map([[z, this.regionStore.getRegions()]]), z, 'combined');
    }
    this.regionStore.attachRegionSource(reuse, 'planes');
    const micronsPerUnit = info.micronsPerUnit && info.micronsPerUnit > 0 ? info.micronsPerUnit : null;
    const set: DatasetRegionSetState = {
      ...claim,
      planes,
      planeIds: planes ? [...info.planes] : null,
      micronsPerUnit,
      groups: regionSetGroups(info),
      opener: reuse,
    };
    this.attachedRegionSets.set(image, set);
    this.useDatasetRegionSet(set);
    return true;
  }

  /**
   * Whether the plotted image has region sources of its own (a served set, large saved ROIs, an
   * annotation folder's slices), which attaching the dataset's set over every plane would replace,
   * dropping them and what was taken from them: they are kept, and the set is not attached.
   */
  private keepsOwnSources(key: string): boolean {
    if (!this.regionStore.hasAnyRegionSource()) return false;
    console.warn(
      `[visualizer] the image has region sources of its own: the dataset's region set (${key}) is not attached over them`,
    );
    return true;
  }

  /**
   * Make `set` the plotted image's region set: its planes slice the image (its regions per plane,
   * as a stack's per slice: those drawn before go to the plane shown), place its surfaces in
   * spatial 3D and drive the slider.
   */
  private useDatasetRegionSet(set: DatasetRegionSetState): void {
    this.datasetRegionSet = set;
    const planes = set.planes;
    const sliced = !!planes && planes.length > 1 && !this.plottedInfo?.isStack;
    if (sliced && !this.regionStore.isStackMode()) {
      const z = this.currentZIndex < planes.length ? this.currentZIndex : 0;
      this.regionStore.enterStackMode(new Map([[z, this.regionStore.getRegions()]]), z, 'combined');
    }
    this.napari.setRegionPlanes(planes);
    if (planes) this.napari.setRegionPlane(this.currentZIndex);
    this.datasetPlanes$.next(sliced ? planes : null);
    this.spatialViewChanged$.next();
    // Regions switched off in a spatial view before the set came: its classes are hidden as the
    // rest are.
    if (
      this.annotationsHidden &&
      (isSpatialOmics(this.currentPlotType) || isSpatialOmics3d(this.currentPlotType))
    ) {
      this.setClassesHidden(
        set.groups.flatMap((g) => g.classes),
        true,
      );
    }
    this.updateVolumeView(this.currentPlotType);
    this.showDatasetRegionSet3d();
    this.updatePlaneCells();
    this.updateCells3d();
  }

  /**
   * The dataset no longer names the attached set while its image is still plotted (see
   * IVisualizer.releaseDatasetRegionSet): its planes, its surfaces and cells in 3D go, as on another
   * image. Its attachment is kept (attachedRegionSets): the same set asked for again is restored.
   */
  releaseDatasetRegionSet(keep: string | null): void {
    const set = this.datasetRegionSet;
    if (!set || set.key === keep) return;
    // One still opening (the claim) is dropped when it opens.
    this.datasetRegionSet = null;
    if (set.planes && this.classes3d$.value.length && this.classes3dImage === this.plottedFileName) {
      this.clearRegionClasses3d();
    }
    this.napari.setRegionPlanes(null);
    this.datasetPlanes$.next(null);
    this.spatialViewChanged$.next();
    this.updateVolumeView(this.currentPlotType);
    this.updateCells3d();
    this.updatePlaneCells();
  }

  /** The dataset region set's classes while in spatial 3D: those that can be drawn as cells. */
  getCellableClasses3d$(): Observable<ReadonlySet<string>> {
    return this.cellable3d$.asObservable();
  }

  /** The classes the spatial 3D view draws as individual cells (see updateCells3d). */
  getIndividualClasses3d$(): Observable<ReadonlySet<string>> {
    return this.individual3d$.asObservable();
  }

  /** Draw these classes as individual cells in spatial 3D, or merged again (the global switch aside). */
  setClassesIndividual3d(classes: readonly string[], individual: boolean): void {
    const global = this.cells3dMode === 'cells';
    for (const c of classes) {
      if (individual === global) this.cells3dOverrides.delete(c);
      else this.cells3dOverrides.set(c, individual);
    }
    this.updateCells3d(true);
  }

  /**
   * Which of the dataset region set's classes the spatial 3D view draws as individual cells: every
   * one with the panel's global switch on "cells", none on "types", each class the Region Editor
   * set the other way excepted. Turning the global switch resets those. The individual classes'
   * merged surfaces are left out (see showRegionClasses3d); their cells are drawn instead.
   */
  private updateCells3d(force = false): void {
    const mode = this.store.currentSpatialView().cells3d ?? 'types';
    if (mode !== this.cells3dMode) {
      this.cells3dMode = mode;
      this.cells3dOverrides.clear();
      force = true;
    }
    const classes = new Set<string>();
    for (const g of this.datasetRegionSet?.planes ? this.datasetRegionSet.groups : []) {
      for (const c of g.classes) {
        if (this.cells3dOverrides.get(c) ?? mode === 'cells') classes.add(c);
      }
    }
    const cellable = new Set<string>(
      isSpatialOmics3d(this.currentPlotType) && this.datasetRegionSet?.planes
        ? this.datasetRegionSet.groups.flatMap((g) => g.classes)
        : [],
    );
    const had = this.cellable3d$.value;
    if (had.size !== cellable.size || [...cellable].some((c) => !had.has(c))) this.cellable3d$.next(cellable);
    const before = this.individual3d$.value;
    const same = before.size === classes.size && [...classes].every((c) => before.has(c));
    if (same && !force) return;
    if (!same) this.individual3d$.next(classes);
    this.napari.setRegionCells(classes.size ? [...classes] : null);
    // The merged surfaces follow: an individual class's leaves them, a merged one's comes back.
    if (!same && this.shown3d.length && this.classes3dImage === this.plottedFileName) {
      void this.showRegionClasses3d(this.shown3d);
    }
  }

  /**
   * In the spatial views (2D and 3D), the spatial panel's Regions switch (`showAnnotations`, off by
   * default) is every class's in the Region Editor's list, as their eyes are: off, every class is
   * hidden (the drawn regions' and the dataset region set's cell types alike: their regions in 2D,
   * their surfaces in 3D, and the eyes show it); on again, every class is shown. Applied when the
   * switch changes, or on entering a spatial view with it off (so by default), so a class hidden or
   * shown by its own eye meanwhile stays as it was set.
   */
  private syncAnnotations(): void {
    if (!isSpatialOmics(this.currentPlotType) && !isSpatialOmics3d(this.currentPlotType)) return;
    const hide = this.store.currentSpatialView().showAnnotations === false;
    if (hide === this.annotationsHidden) return;
    this.annotationsHidden = hide;
    const classes = this.knownClasses();
    if (classes.length) this.setClassesHidden(classes, hide);
  }

  /**
   * Every class the Region Editor lists for the image: the dataset region set's, those shown in 3D,
   * the drawn regions', and any hidden now.
   */
  private knownClasses(): string[] {
    const out = new Set<string>(this.regionStore.getHiddenClasses());
    for (const g of this.datasetRegionSet?.groups ?? []) g.classes.forEach((c) => out.add(c));
    for (const g of this.shown3d) g.classes.forEach((c) => out.add(c));
    for (const r of this.regionStore.getRegions()) if (r.label) out.add(r.label);
    return [...out];
  }

  /**
   * The Cells panel's boundary set that is the dataset's region set (the one naming it as its
   * `regionSource`), while its planes are shown on the plotted image with its source still the
   * store's; null otherwise.
   */
  private planeCellSet(): string | null {
    const set = this.datasetRegionSet;
    if (!set?.planes || !set.opener || set.opener !== this.regionStore.getPlanesSourceOpener()) return null;
    return this.spatialDataset?.polygonTiles?.sets.find((s) => s.regionSource === set.key)?.name ?? null;
  }

  /**
   * While the dataset region set's planes are shown, the Cells panel draws each plane's cells from
   * it (its boundary set, see `CellLayers.setPlane`):
   *  - that set is the panel's boundaries by default: a view that has not chosen a set (none yet, or
   *    after a reset) is given it;
   *  - in the 2D spatial view, while the panel draws them, the overlays do not draw the same
   *    outlines a second time (`RegionStore.setRegionSourceDrawn`). They stay listed and editable
   *    in the Region Editor, and are drawn by the overlays everywhere else.
   */
  private updatePlaneCells(): void {
    const name = this.planeCellSet();
    const view = this.store.currentSpatialView();
    if (name && view.cellSet == null) {
      // Emits the view, which comes back here with the set chosen.
      this.store.setSpatialView({ cellSet: name });
      return;
    }
    const drawn = drawnCellSets(this.spatialDataset?.polygonTiles, view.cellSet);
    const byCells =
      !!name &&
      isSpatialOmics(this.currentPlotType) &&
      (view.showCells ?? true) &&
      drawn?.set === name &&
      !drawn.nucleusSet;
    this.regionStore.setRegionSourceDrawn(!byCells);
  }

  /**
   * In spatial 3D, with the dataset's region set placed there: show each of its classes in 3D, in
   * its colour, once per image, unless classes are shown already (the region editor's choice
   * stands, and hiding them all stays hidden).
   */
  private showDatasetRegionSet3d(): void {
    const set = this.datasetRegionSet;
    if (!set?.planes || set.shown3d || !set.groups.length) return;
    if (!isSpatialOmics3d(this.currentPlotType) || this.classes3d$.value.length) return;
    set.shown3d = true;
    this.showRegionClasses3d(set.groups).catch((err) =>
      console.warn('[visualizer] the cells could not be shown in 3D', err),
    );
  }

  /** Empty every slice of a stack (its regions and undo history) for regions imported over it. */
  private enterImportedStack(info: IImageInfo): void {
    const layout = this.regionStore.isStackMode()
      ? this.regionStore.getStackSaveLayout()
      : info.tiled === false
        ? 'per-slice-file'
        : 'combined';
    this.regionStore.enterStackMode(new Map(), this.regionStore.getDisplaySlice(), layout);
  }
  getRegionSourceView$(): Observable<RegionSourceView | null> {
    return this.regionStore.getRegionSourceView$();
  }
  getRegionSourceIndex(query: Omit<RegionIndexQuery, 'exclude'>): Promise<RegionIndexPage> {
    return this.regionStore.getRegionSourceIndex(query);
  }
  selectSourceFeatures(ids: readonly string[], additive?: boolean): Promise<number[]> {
    return this.regionStore.selectSourceFeatures(ids, additive);
  }
  deleteSourceFeatures(ids: readonly string[]): void {
    this.regionStore.deleteSourceFeatures(ids);
  }
  getRegionStyle$(): Observable<RegionStyle> {
    return this.regionStore.getRegionStyle$();
  }
  setRegionStyle(patch: Partial<RegionStyle>): void {
    this.regionStore.setRegionStyle(patch);
  }
  // ── Regions in 3D: their reconstructions shown in the volume view ─────

  /** Recompute which 3D view is on screen for `plotType` (see {@link volumeView$}). */
  private updateVolumeView(plotType: PlotType): void {
    this.imageVolumeView = isNapariVolume(plotType) || isNapariIsosurface(plotType);
    // The spatial cloud places the surfaces of a stack's slices, or of a region set's planes.
    const placed = !!this.plottedInfo?.isStack || !!this.datasetRegionSet?.planes;
    const regions3d = this.imageVolumeView || (isSpatialOmics3d(plotType) && placed);
    // Every plot, as before: the Region Editor drops its per-class volumes on each (a new image).
    this.volumeView$.next(regions3d);
  }

  /** Whether a napari volume (or isosurface) view is on screen: regions can be shown in 3D. */
  getVolumeView$(): Observable<boolean> {
    return this.volumeView$.asObservable();
  }

  /** Whether the volume view's slice pane is wanted (it shows while a volume view is on screen). */
  getSliceEditor$(): Observable<boolean> {
    return this.sliceEditor$.asObservable();
  }

  /** Whether the volume view draws the region reconstructions through the volume. */
  getRegionsThroughVolume$(): Observable<boolean> {
    return this.regionsThroughVolume$.asObservable();
  }

  /**
   * Draw the region reconstructions through the volume (it hides none of them: surfaces inside its
   * bright structures, an OCT's layer boundaries) or hidden behind what it shows (the default).
   */
  setRegionsThroughVolume(through: boolean): void {
    if (this.regionsThroughVolume$.value === through) return;
    this.regionsThroughVolume$.next(through);
    this.napari.setRegionsThroughVolume(through);
  }

  /** The class groups shown in 3D on this image ([] after a switch to another image). */
  getRegionClasses3d$(): Observable<ReadonlyArray<{ key: string; classes: readonly string[] }>> {
    return this.classes3d$.asObservable();
  }

  /** Hide every region surface and forget them (a build still running is dropped). */
  private clearRegionClasses3d(): void {
    this.meshRequest++;
    this.shown3d = [];
    this.classes3d$.next([]);
    this.classes3dImage = undefined;
    this.napari.setRegionMeshes([], undefined);
    this.napari.setRegionHighlight([]);
  }

  /** Highlight the surfaces of these group keys in the volume view (none: all as usual). */
  highlightRegionClasses3d(keys: readonly string[]): void {
    this.napari.setRegionHighlight(keys);
  }

  /** A surface clicked in the volume view with the selection tool (its group key), or none (null). */
  getRegionPicked3d$(): Observable<{ key: string | null; additive: boolean }> {
    return this.napari.getRegionMeshPick$();
  }

  /**
   * Show these groups of classes in the volume view as 3D reconstructions (each group one surface
   * in its colour: an atlas structure with its substructures), and only these; [] hides them.
   * Reconstructed from every slice's outlines at the volume's resolution, cached per image.
   */
  async showRegionClasses3d(
    groups: ReadonlyArray<{ key: string; classes: readonly string[]; color: string; label?: string }>,
  ): Promise<void> {
    const request = ++this.meshRequest;
    this.classes3dImage = this.plottedFileName;
    this.shown3d = groups;
    // What an edit from now on is compared with (the live slice may not have changed yet).
    this.liveClasses = null;
    this.trackLiveClasses();
    this.classes3d$.next(groups.map((g) => ({ key: g.key, classes: g.classes })));
    const width = this.getTrueImageSize()?.width ?? 1024;
    const step = this.napari.regionVoxelStep() ?? Math.max(1, width / 256);
    const image = this.plottedFileName ?? '';
    const cacheKey = (g: { classes: readonly string[] }) => `${image}|${step.toFixed(3)}|${g.classes.join(',')}`;
    // A group of classes drawn as individual cells has no merged surface (its cells are drawn).
    const individual = this.individual3d$.value;
    const merged = groups.filter((g) => !g.classes.length || !g.classes.every((c) => individual.has(c)));
    const missing = merged.filter((g) => !this.meshCache.has(cacheKey(g)));
    if (missing.length) {
      const names = missing.map((g) => g.key);
      const what = names.length > 3 ? `${names.length} regions` : names.join(', ');
      const done = this.napari.beginTask(`Building ${what} in 3D…`);
      try {
        const built = await this.regionStore.reconstructClasses(
          missing.map((g) => ({ key: cacheKey(g), classes: g.classes })),
          step,
        );
        const classesOf = new Map(missing.map((g) => [cacheKey(g), g.classes]));
        for (const b of built) this.meshCache.set(b.key, { mesh: b.mesh, classes: classesOf.get(b.key) ?? [] });
      } finally {
        done();
      }
    }
    if (request !== this.meshRequest) return;
    this.napari.setRegionMeshes(
      merged.map((g) => {
        const mesh = this.meshCache.get(cacheKey(g))!.mesh;
        return { key: g.key, color: g.color, label: g.label, vertices: mesh.vertices, faces: mesh.faces };
      }),
      this.plottedFileName,
    );
  }

  /**
   * The regions changed: when the live slice's regions of some classes did (an edit, an undo, not
   * a slice or image switch), their reconstructions are stale. They are dropped, and those shown
   * in 3D are rebuilt once the edits pause.
   */
  private onRegionsChanged(): void {
    // Nothing follows the edits (no surface built or shown, no sections): skip the fingerprints.
    if (!this.sliceMounted && !this.shown3d.length && !this.meshCache.size) {
      this.liveClasses = null;
      return;
    }
    const before = this.liveClasses;
    this.liveClasses = null;
    const now = this.trackLiveClasses();
    // Another slice or image came up: no region changed (the sections recut for the slice).
    if (!before || before.at !== now.at) return;
    const changed = changedClasses(before.signatures, now.signatures);
    // Source features deleted (or that undone) change no live region, and which classes they were
    // is not known here: every class is stale. A feature taken shows as its class's change.
    const everyClass = !changed.size && before.sources !== now.sources;
    if (!changed.size && !everyClass) return;
    const touched = (c: string) => everyClass || changed.has(c);
    if (this.sliceMounted) this.sections.regionsChanged();
    for (const [key, entry] of [...this.meshCache]) {
      if (entry.classes.some(touched)) this.meshCache.delete(key);
    }
    if (!this.shown3d.some((g) => g.classes.some(touched))) return;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.shown3d.length && this.classes3dImage === this.plottedFileName) {
        void this.showRegionClasses3d(this.shown3d);
      }
    }, REGION_SURFACE_REBUILD_MS);
  }

  /** Fingerprint the live slice's classes, unless already: what the next edit is compared with. */
  private trackLiveClasses(): { at: string; signatures: Map<string, number>; sources: string } {
    this.liveClasses ??= {
      at: this.liveSliceKey(),
      signatures: classSignatures(this.regionStore.getRegions()),
      sources: this.regionStore.getSourceStateKey(),
    };
    return this.liveClasses;
  }

  /** Which slice of which image the live regions are. */
  private liveSliceKey(): string {
    return `${this.regionStore.getDisplaySlice()}\n${this.plottedFileName ?? ''}`;
  }

  /**
   * Each class's volume over the whole stack, in px² × slices (see RegionStore.classVolumes). Over
   * the planes of the dataset's region set, slices of their mean spacing ({@link getSliceScale$}),
   * each plane weighted by its share of the depth when they are not evenly spaced.
   */
  async getClassVolumes(classes: readonly string[]): Promise<Record<string, number>> {
    const planes = this.datasetPlanes$.value;
    const ids = this.datasetRegionSet?.planeIds;
    // A slice of the set's source is its plane id (the store binds slice z to plane z), which need
    // not be its ordinal: `sliceZ[i]` is where plane `planes[i]` is, so each weight goes by its id.
    const weights = planes && ids?.length === planes.length ? planeWeights(planes) : null;
    const byPlane = weights && ids ? new Map(ids.map((id, i) => [id, weights[i]])) : null;
    return Object.fromEntries(
      await this.regionStore.classVolumes(classes, byPlane ? (z) => byPlane.get(z) ?? 1 : undefined),
    );
  }

  /**
   * While the dataset's region set slices the image (see getDatasetPlanes$), its planes' mean
   * spacing and µm per unit: what a class volume's slice is, in µm, the image having no slice
   * spacing of its own. Null otherwise.
   */
  getSliceScale$(): Observable<SliceScale | null> {
    return this.datasetPlanes$.pipe(
      map((planes) => {
        const spacing = planes ? planeSpacing(planes) : null;
        return spacing == null ? null : { spacing, micronsPerUnit: this.datasetRegionSet?.micronsPerUnit ?? null };
      }),
    );
  }

  getRegionSourceClassCounts(stack?: boolean): Promise<Record<string, number>> {
    return this.regionStore.getRegionSourceClassCounts(stack);
  }
  getHiddenClasses$(): Observable<ReadonlySet<string>> {
    return this.regionStore.getHiddenClasses$();
  }
  setClassesHidden(classes: readonly string[], hidden: boolean): void {
    this.regionStore.setClassesHidden(classes, hidden);
    // A surface is its class's (its group key is the class name).
    this.napari.setRegionHidden([...this.regionStore.getHiddenClasses()]);
    this.sections.schedule();
  }
  async selectRegionClasses(classes: readonly string[], additive?: boolean): Promise<void> {
    await this.regionStore.selectClasses(classes, additive);
  }
  getPickedRegionClasses$(): Observable<readonly string[]> {
    return this.regionStore.getPickedClasses$();
  }
  getGeoJsonStringWithSource(regions: Region[], slice?: number): Promise<string> {
    return this.regionStore.getGeoJsonWithSource(regions, slice);
  }

  // ── Per-slice z-stack regions (jit-ui#93), from the shared RegionStore. ──
  enterStackMode(
    slices: Map<number, Region[]>,
    initialZ?: number,
    saveLayout?: 'combined' | 'per-slice-file',
  ): void {
    this.regionStore.enterStackMode(slices, initialZ, saveLayout);
  }
  exitStackMode(): void {
    this.regionStore.exitStackMode();
  }
  isStackMode(): boolean {
    return this.regionStore.isStackMode();
  }
  /** The slice the regions are shown for (recorded outside stack mode too). */
  getDisplaySlice(): number {
    return this.regionStore.getDisplaySlice();
  }
  getStackSaveLayout(): 'combined' | 'per-slice-file' {
    return this.regionStore.getStackSaveLayout();
  }
  setDisplaySlice(z: number): void {
    this.regionStore.setDisplaySlice(z);
  }
  getSliceRegions(): Region[] {
    return this.regionStore.getSliceRegions();
  }
  getStackSaveSlices(): Map<number, Region[]> {
    return this.regionStore.getStackSaveSlices();
  }
  /** All slices' ANNOTATION regions for a z-stack save (jit-ui#93), each tagged
   *  with its zero-based Region.z; profile lines excluded. Flat annotation set
   *  outside stack mode. */
  getSliceAnnotationRegions(): Region[] {
    return this.regionStore.getSliceRegions().filter((r) => !isProfileRegion(r));
  }
  /** Per-slice annotation regions to write on a folder-stack save (jit-ui#93):
   *  slice index → that slice's annotation regions (profile lines excluded),
   *  including now-empty slices that were loaded non-empty (so they overwrite). */
  getStackSaveAnnotationSlices(): Map<number, Region[]> {
    const out = new Map<number, Region[]>();
    for (const [z, regs] of this.regionStore.getStackSaveSlices()) {
      out.set(
        z,
        regs.filter((r) => !isProfileRegion(r)),
      );
    }
    return out;
  }

  /** Authoritative full-resolution image size for mask export. Prefers the
   *  active renderer's reported size, falling back to the image metadata (x/y
   *  are the full-res pixel dimensions used across the app). Rejects non-finite
   *  or non-positive sizes — the Plotly bounds can yield NaN before a plot is
   *  fully laid out, which would otherwise crash mask creation. */
  getMaskImageSize(): { width: number; height: number } | null {
    const valid = (s: { width: number; height: number } | null | undefined) =>
      s && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width >= 1 && s.height >= 1
        ? { width: Math.round(s.width), height: Math.round(s.height) }
        : null;

    const fromRenderer = valid(this.getTrueImageSize());
    if (fromRenderer) return fromRenderer;

    let meta: IImageMetadata[] = [];
    this.getImageMeta()
      .subscribe((m) => (meta = m))
      .unsubscribe();
    const m0 = meta?.[0];
    return m0 ? valid({ width: m0.x, height: m0.y }) : null;
  }

  // ── IRegionEditorApi: annotation-only surface for the Region Editor ───
  // Intensity-profile lines (kind='profile') belong to the intensity tool, not
  // the editor. These methods give external consumers an annotation-only view
  // and guarantee profile lines are preserved. The writes land in the store like
  // any other, and every backend redraws from its events.

  getAnnotationRegions(): Region[] {
    return this.regionStore.getRegions().filter((r) => !isProfileRegion(r));
  }
  setAnnotationRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
  ): void {
    // Re-append the store's profile lines so an editor save/delete can't drop them.
    const profiles = this.regionStore.getRegions().filter((r) => isProfileRegion(r));
    const annotations = (regions || []).filter((r) => !isProfileRegion(r));
    this.setRegions([...annotations, ...profiles], showRegionLabel, isRegionSaveOn, fillColor, false);
  }
  getSelectedRegions$(): Observable<Region[]> {
    // Map the internal index-based selection to the selected annotation regions.
    return this.getSelectedShapeIndices$().pipe(
      map((idxs) => {
        const regs = this.regionStore.getRegions();
        return idxs.map((i) => regs[i]).filter((r): r is Region => !!r && !isProfileRegion(r));
      }),
    );
  }
  setSelectedRegions(regions: Region[]): void {
    const regs = this.regionStore.getRegions();
    const indices = (regions || []).map((r) => regs.findIndex((x) => x.id === r.id)).filter((i) => i >= 0);
    this.setSelectedShapeIndices(indices);
  }

  // ── tools → active renderer (run on either backend) ─────────────────
  // The wand, vertex eraser and zoom-to-box are implemented on both backends
  // via ICoordinateTransform (+ a viewport pixel readback for the wand), so they
  // follow the active renderer — the slice pane's while the volume view is split.
  setActiveTool(id: string | null, options?: CanvasToolOptions): void {
    this.regionBackend().setActiveTool(id, options);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setWandMode(active: boolean, options?: IWandOptions): void {
    this.regionBackend().setWandMode(active, options);
  }
  setWandOptions(options: IWandOptions): void {
    this.regionBackend().setWandOptions(options);
  }
  clearActiveWandRegion(): void {
    this.regionBackend().clearActiveWandRegion();
  }
  /** @deprecated Use {@link setActiveTool}. */
  setBrushMode(active: boolean, options?: IBrushOptions): void {
    this.regionBackend().setBrushMode(active, options);
  }
  setBrushOptions(options: IBrushOptions): void {
    this.regionBackend().setBrushOptions(options);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setVertexEraserMode(active: boolean): void {
    this.regionBackend().setVertexEraserMode(active);
  }
  setVertexEraserRadius(radius: number): void {
    this.regionBackend().setVertexEraserRadius(radius);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setZoomToBoxMode(active: boolean): void {
    this.regionBackend().setZoomToBoxMode(active);
  }
  segmentRectangles(): Promise<number> {
    return this.regionBackend().segmentRectangles();
  }
  segmentRectanglesCellpose(): Promise<number> {
    return this.regionBackend().segmentRectanglesCellpose();
  }
  setSamModel(id: string): void {
    this.regionBackend().setSamModel(id);
  }
  /** @deprecated Use {@link setActiveTool}. */
  setSamPointMode(active: boolean): void {
    this.regionBackend().setSamPointMode(active);
  }
  commitSamPoints(): void {
    this.regionBackend().commitSamPoints();
  }
  clearSamPoints(): void {
    this.regionBackend().clearSamPoints();
  }

  // ── display options ──────────────────────────────────────────────────
  // State lives in the shared VisualizerStore — reads go straight to it.
  // The two SETTERS still route through Plotly because its implementations
  // carry render glue beyond the store write (a live Plotly.restyle of
  // colorscale/reversescale on the mounted heatmap); OSD recolors via its own
  // store subscription either way.
  getColormap(): Observable<ColormapNode | null> {
    return this.store.getColormap();
  }
  setColormap(colormap: ColormapNode): void {
    this.plotly.setColormap(colormap);
  }
  getColormapOptions(): ColormapNode[] {
    return this.store.getColormapOptions();
  }
  getReverseScale(): Observable<boolean> {
    return this.store.getReverseScale();
  }
  setReverseScale(reverse: boolean): void {
    this.plotly.setReverseScale(reverse);
  }
  setImageMeta(imageMeta: IImageMetadata[], imageKey?: string): void {
    this.store.setImageMeta(imageMeta, imageKey);
  }
  getImageMeta(): Observable<IImageMetadata[]> {
    return this.store.getImageMeta();
  }

  // ── IChannelHistogramApi: Channels & Histogram pane surface ───────────
  // Channel/grayscale/invert state lives in the shared VisualizerStore; both
  // backends subscribe and recolor live, so setters just write the store. The
  // histogram comes from whichever backend is on screen (its native pixels).
  getHistogram(channelIndex: number, bins: number): IHistogram | null {
    return this.renderer().getHistogram(channelIndex, bins);
  }
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null> {
    return this.renderer().getHistogram$(channelIndex, bins);
  }
  /** Export the underlying data (16-bit multi-band TIFF) via the active backend. */
  exportData(): void {
    this.renderer().exportData();
  }
  getChannels$(): Observable<IChannelState[]> {
    return this.store.getChannelStates();
  }
  setSelectedChannel(index: number): void {
    this.store.setSelectedChannel(index);
  }
  setChannelState(index: number, partial: Partial<IChannelState>): void {
    this.store.setChannelState(index, partial);
  }
  resetContrast(indices: number[]): void {
    // Full reset: window (0..255), gamma (1) AND the channel's default tint.
    for (const i of indices) this.store.resetChannelState(i);
  }
  /** Auto-window each channel by saturating `saturation` (0..1) of pixels at each
   *  end of its histogram (skipping outlier first/last bins). */
  autoContrast(indices: number[], saturation: number): void {
    for (const i of indices) {
      const h = this.renderer().getHistogram(i, 256);
      if (!h) continue;
      const [min, max] = autoWindowFromHistogram(h, saturation, [0, 255]);
      if (max > min) this.store.setChannelState(i, { min, max });
    }
  }
  getGrayscale$(): Observable<boolean> {
    return this.store.getGrayscale();
  }
  setGrayscale(on: boolean): void {
    this.store.setGrayscale(on);
  }
  getInvert$(): Observable<boolean> {
    return this.store.getInvert();
  }
  setInvert(on: boolean): void {
    this.store.setInvert(on);
  }

  /**
   * The active backend's region overlay (the slice pane's while the volume view is split). Falls
   * back to Plotly's when the active backend
   * (OSD or napari-js) is selected but a plot isn't mounted yet, so callers always get a
   * usable overlay.
   */
  getRegionOverlay(): IRegionOverlay {
    const r = this.regionBackend();
    if (r === this.osd) {
      return this.osd.getRegionOverlay() ?? this.plotly.getRegionOverlay();
    }
    if (r === this.napari) {
      return this.napari.getRegionOverlay() ?? this.plotly.getRegionOverlay();
    }
    return this.plotly.getRegionOverlay();
  }

  /** Isosurface controls of the backend on screen, when it renders isosurfaces. */
  getIsosurfaceControls(): IIsosurfaceControls | null {
    return this.renderer().getIsosurfaceControls();
  }

  /** 3D scene controls of the backend on screen (Plotly or napari-js), or null on a
   *  2D-only one. */
  getSurface3dControls(): ISurface3dControls | null {
    return this.renderer().getSurface3dControls();
  }

  /** Intensity (line-ROI) controls, whichever backend draws the image: the
   *  IntensityProfileService adds the line to the store, and every backend
   *  (Plotly included) draws it from the store's update event. */
  getIntensityControls(): IIntensityControls | null {
    return this.intensity;
  }

  /**
   * Spatial-omics controls, or null when no `SPATIAL_DATA_PORT` is bound. Served by a
   * backend-neutral {@link SpatialControlsFacade} (state in the shared stores), so the
   * controls work across a plot-type switch and before any backend has mounted.
   */
  getSpatialControls(): ISpatialControls | null {
    if (!this.spatialData) return null;
    this.spatialFacade ??= new SpatialControlsFacade(this.spatialData, {
      store: this.store,
      regionStore: this.regionStore,
      selectionStore: this.selectionStore,
      napari: this.napari,
      plotType: () => this.currentPlotType,
      zIndex: () => this.currentZIndex,
      planes: () => (this.plottedInfo?.isStack ? null : (this.datasetRegionSet?.planes ?? null)),
      slicePlanes: () => this.datasetRegionSet?.planes ?? null,
      viewChanged$: this.spatialViewChanged$.asObservable(),
    });
    return this.spatialFacade.controls;
  }

  /** Created on first use; owns the dataset subscription. */
  private spatialFacade: SpatialControlsFacade | null = null;
  /** Displayed slice. Only a volume-backed spatial dataset reads it, to keep a
   *  region drawn over one section from selecting the whole depth behind it. */
  private currentZIndex = 0;
  /** The slice shown, the plot type or the dataset's planes changed (the spatial controls recount). */
  private readonly spatialViewChanged$ = new Subject<void>();

  /** Angular calls this when the injector providing the router is destroyed — the host
   *  component for a `provideVisualization()` chain. The dataset subscription would
   *  otherwise keep the whole isolated chain reachable from the root data port. */
  ngOnDestroy(): void {
    this.importTicket = { id: this.importTicket.id + 1, image: undefined }; // a late import changes nothing
    this.spatialFacade?.dispose();
    this.spatialFacade = null;
    this.detachWebGlSpatial();
    this.regionUpdates.unsubscribe();
    this.planeCellsSub?.unsubscribe();
    this.sectionSubs.unsubscribe();
    this.sections.stop();
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
  }

  /**
   * Intensity-profile sampling, whichever backend is on screen: the sampling is the
   * backend-neutral IntensityProfileService's; the viewport changes come from every
   * backend that reports them (OpenSeadragon, napari-js), merged into one stable
   * stream the inset subscribes to once.
   */
  getIntensitySampling(): IIntensitySampling {
    return this.intensitySampling;
  }
  private readonly intensitySampling: IIntensitySampling = {
    // Load the displayed slice's pixels for a backend that has no frames of its own
    // (OpenSeadragon, napari-js; Plotly feeds its frames to the service when it plots).
    ensureIntensitySampling: (imageInfo, zIndex) => {
      this.pointSamplingAtPlot();
      return this.intensity.ensureIntensitySampling(imageInfo, zIndex);
    },
    // Re-sample from a fresh crop of the image-pixel ROI at display resolution.
    refreshIntensitySamplingForRoi: (x, y, width, height, zIndex) => {
      this.pointSamplingAtPlot();
      this.intensity.refreshIntensitySamplingForRoi(x, y, width, height, zIndex);
    },
    getViewportChange$: () =>
      merge(...this.backends().map((b) => b.getIntensitySampling()?.getViewportChange$() ?? EMPTY)),
  };
  /** @deprecated Use `getIntensitySampling().ensureIntensitySampling()`. */
  ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void> {
    return this.intensitySampling.ensureIntensitySampling(imageInfo, zIndex);
  }

  /** Crops for sampling are sized from the plot div (whichever backend renders into it). */
  private pointSamplingAtPlot(): void {
    if (this.plotDiv) this.intensity.setSamplingElement(this.plotDiv);
  }

  /** @deprecated Use `getIntensitySampling().getViewportChange$()`. */
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.intensitySampling.getViewportChange$();
  }

  /** @deprecated Use `getIntensitySampling().refreshIntensitySamplingForRoi()`. */
  refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number, zIndex: number): void {
    this.intensitySampling.refreshIntensitySamplingForRoi(x, y, width, height, zIndex);
  }

  /** The visualizer view is going away: detach every backend — dropping their view-bound
   *  subscriptions and disposing the napari-js viewer, whose canvas, render loop and GPU
   *  buffers would otherwise outlive the view (for a component-scoped chain, forever).
   *  Nothing is on screen afterwards, so the next plot starts from the default backend. */
  detach(): void {
    this.sliceRequest++;
    this.sections.stop();
    this.sliceMounted = false;
    this.sliceDiv = null;
    this.detachWebGlSpatial();
    this.plotly.detach();
    this.osd.detach();
    this.napari.detach();
    this.lastRendered = null;
  }

  /**
   * Draw the spatial markers over OpenSeadragon with WebGL (the SPATIAL_OMICS fallback when
   * napari-js cannot run). Click-to-zoom goes off while they are up: a click selects the class
   * under the cursor, as it does over napari-js.
   */
  private attachWebGlSpatial(): void {
    if (!this.spatialData) return;
    this.webglSpatial ??= new WebGlSpatialLayer({
      viewport: this.osd.getPlotModeViewport(),
      container: () => this.osd.getSpatialLayerHost(),
      pointerHost: () => (this.plotDiv ? document.getElementById(this.plotDiv) : null),
      onRedraw: (redraw) => this.osd.onViewportRedraw(redraw),
      store: this.store,
      port: this.spatialData,
      selection: this.selectionStore,
      imageSize: () => this.osd.getTrueImageSize(),
      z: () => this.imageSlice(this.currentZIndex),
      toolActive: () => this.osd.regionToolActive(),
      setImageVisible: (visible) => this.osd.setImageVisible(visible),
      outsideZone: (fn) => this.zone.runOutsideAngular(fn),
      inZone: (fn) => this.zone.run(fn),
    });
    if (this.webglSpatial.attach()) {
      this.osd.setClickToZoom(false);
      console.warn(
        '[visualizer] spatial view drawn with WebGL (no WebGPU): cell outlines, transcripts and density need WebGPU.',
      );
    }
  }

  /**
   * Take the WebGL spatial markers down, giving OpenSeadragon back its click-to-zoom (the viewer
   * may be reused in place by an ordinary image plot) and its tissue tiles.
   */
  private detachWebGlSpatial(): void {
    const layer = this.webglSpatial;
    if (!layer) return;
    const wasAttached = layer.attached;
    layer.detach();
    if (wasAttached) this.osd.setClickToZoom(true);
  }

  /** @deprecated Use {@link detach}. */
  unsubscribe(): void {
    this.detach();
  }
}

/**
 * A spatial dataset's region set on an image (see `attachDatasetRegionSet`): the image (its region
 * scope key), the set's key, its planes' z (its `sliceZ`, when it says) and µm per unit, its class groups, whether
 * they were shown in 3D by themselves, and the opener it was attached to the store with (null while
 * it opens): while the store's source over every plane is that one, the set is still attached.
 */
interface DatasetRegionSetState {
  image: string;
  key: string;
  planes: readonly number[] | null;
  /** The set's plane ids (`RegionSourceInfo.planes`), `planes[i]` being where plane `planeIds[i]` is. */
  planeIds: readonly number[] | null;
  /** Microns per unit of the set's coordinates, when it says. */
  micronsPerUnit: number | null;
  groups: ReadonlyArray<{ key: string; classes: readonly string[]; color: string }>;
  shown3d: boolean;
  opener: RegionSourceOpener | null;
}

/**
 * A region set's classes as 3D groups, as the region editor's class tree shows them: one per root of
 * its hierarchy with every class under it (one per class of a flat one), in the hierarchy's order;
 * without a hierarchy, one per class its features have. Each in the colour the set gives it (its
 * hierarchy's, else its features').
 */
export function regionSetGroups(info: RegionSourceInfo): Array<{ key: string; classes: string[]; color: string }> {
  const colors = new Map(Object.entries(info.classColors ?? {}));
  const nodes = [...(info.hierarchy ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!nodes.length) {
    return [...colors.entries()].map(([name, color]) => ({ key: name, classes: [name], color }));
  }
  for (const n of nodes) if (n.color) colors.set(n.name, n.color);
  const names = new Set(nodes.map((n) => n.name));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent || !names.has(n.parent)) continue;
    children.set(n.parent, [...(children.get(n.parent) ?? []), n.name]);
  }
  const subtree = (name: string): string[] => [name, ...(children.get(name) ?? []).flatMap(subtree)];
  return nodes
    .filter((n) => !n.parent || !names.has(n.parent))
    .map((n) => ({ key: n.name, classes: subtree(n.name), color: colors.get(n.name) ?? '#cccccc' }));
}
