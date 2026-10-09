import { ChangeDetectorRef, Component, AfterViewInit, ElementRef, EventEmitter, Inject, Injector, Input, NgZone, OnChanges, OnDestroy, OnInit, Optional, Output, SimpleChanges, Type, ViewChild } from '@angular/core';

import { Observable, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { MenuItem, MessageService } from 'primeng/api';
import { ContextMenu } from 'primeng/contextmenu';
import { IImageInfo } from './contracts/image.contract';
import { ImageStatePort, IMAGE_STATE_PORT } from './contracts/ports/image-state.port';
import { Polygon, Rectangle, MultiPolygon, Region } from './models/region';
import { RegionOpsService } from './region-ops.service';
import { VIZ_TOAST_KEY, VIZ_ALERT_TOAST_KEY } from './toast-outlets';
import { VisualizerStore } from './store/visualizer-store.service';
import { RenderOrchestrator, SliceScrubber } from './render-orchestrator';
import {
  PlotType,
  PlotTypeDescriptor,
  PlotTypeId,
  getPlotTypeDescriptor,
  isBuiltinPlotType,
  isNapari3d,
  isSpatialOmics,
  isSpatialOmics3d,
  rendererOwnsWheel,
  NAPARI_DEFAULT_DECIMATE,
} from './contracts/plot-type';
import {
  PLOT_MODE_CONTEXT,
  PLOT_MODE_SESSION,
  PLOT_TYPE_CONTRIBUTIONS,
  PlotModeBrushClass,
  PlotModeContext,
  PlotModeTools,
  PlotTypeContribution,
  PlotTypeOption,
  contributedPlotTypeOption,
} from './contracts/plot-type-contribution.contract';
import { ActivePlotMode, PlotModeController } from './plot-mode/plot-mode-controller';
import { ViewerFeature } from './contracts/capabilities.contract';
import { IntensityProfile, IVisualizer, VISUALIZER, VisualizerHandle } from './contracts/visualizer.contract';
import { SAM_MODELS, getDefaultSamModelId, isSamModelReady } from './toolbar/segmentation/sam-model-registry';
import { SamToolService } from './toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from './toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from './toolbar/segmentation/cell-segment-tool.service';
import {
  TOOLBAR_TOOLS,
  NumberParamSpec,
  SelectParamSpec,
  ToolParamSpec,
  ToolbarContribution,
  ToolbarDialogToolContribution,
  ToolbarToolContribution,
  ToolDialogContext,
  dialogToolContributions,
  visibleToolContributions,
} from './contracts/toolbar-tool.contract';
import { RegionToolMode } from './contracts/region-overlay.contract';
import { ToolbarToolVisibility, ALL_TOOLBAR_TOOLS } from './contracts/toolbar-config';
import { VIZ_CONFIG, VizConfig } from './contracts/viz-config';
import { SPATIAL_DATA_PORT, SpatialDataPort } from './contracts/ports/spatial-data.port';
import { SpatialDataset } from './contracts/spatial-dataset.contract';
import { buildVolumeStackImage } from './spatial/spatial-volume-image';

/** Per-instance plot-div id source. The mount element's id must be unique so two
 *  live viewers (e.g. the main diagram + a modal preview) don't collide on the
 *  same DOM id — `getElementById` would otherwise return whichever came first.
 *  Styling hangs off the `.viz-plot` class instead of the id. */
let plotInstanceSeq = 0;

/** A user-facing message for a failure: an HttpErrorResponse's server message, an
 *  Error's message, or the status text, else the value itself. */
function errorMessage(err: unknown): string {
  const e = err as { error?: { message?: string }; message?: string; statusText?: string } | null;
  return e?.error?.message || e?.message || e?.statusText || String(err);
}

@Component({
  selector: 'visualizer',
  templateUrl: './visualizer.component.html',
  styleUrls: ['./visualizer.component.scss'],
})
export class VisualizerComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  /** Per-instance toast key. MessageService is a global singleton, so two live
   *  `<visualizer>` instances (main viewer + pipeline-dialog preview) sharing
   *  one key would each render the same message — a duplicate toast. A unique
   *  key per instance scopes the toast to the component that raised it. */
  private static nextToastId = 0;

  /**
   * The library also raises notices from places that have no instance of their
   * own to key against: {@link PlotlyService} is `providedIn: 'root'`, and the
   * region editor is a child dialog. Those use the fixed
   * {@link VIZ_TOAST_KEY} / {@link VIZ_ALERT_TOAST_KEY} outlets.
   *
   * For the same reason the per-instance key above exists, exactly ONE mounted
   * visualizer may render those shared outlets — otherwise a message from the
   * root service would be shown once per live viewer (jit-ui runs a main view
   * and a pipeline-preview at the same time). The first to init claims them and
   * releases on destroy, so the surviving viewer picks them up.
   */
  private static readonly liveInstances = new Set<VisualizerComponent>();
  readonly vizToastKey = VIZ_TOAST_KEY;
  readonly vizAlertToastKey = VIZ_ALERT_TOAST_KEY;
  /**
   * Whether this instance renders the shared outlets. The owner is simply the
   * oldest live visualizer — a `Set` iterates in insertion order, so when the
   * owner is destroyed the next one takes over on its following change-detection
   * pass. Tracking a set rather than a single owner matters: with a lone
   * `owner` reference, tearing down the owner while a sibling was already
   * initialised would leave nobody rendering the outlets, and every notice from
   * the root service would silently vanish again.
   */
  get ownsSharedToasts(): boolean {
    const oldest = VisualizerComponent.liveInstances.values().next();
    return !oldest.done && oldest.value === this;
  }

  @Output()
  isStackEvent = new EventEmitter(false);
  @Output()
  isGrayscaleEvent = new EventEmitter(false);

  /** Which toolbar groups to show. A partial override merges over the full set,
   *  so `{ specialTools: false }` hides only that group. Defaults to everything. */
  @Input()
  set toolbarTools(v: ToolbarToolVisibility | undefined) {
    this._toolbarTools = { ...ALL_TOOLBAR_TOOLS, ...(v ?? {}) };
  }

  get toolbarTools(): Required<ToolbarToolVisibility> {
    return this._toolbarTools;
  }
  private _toolbarTools: Required<ToolbarToolVisibility> = ALL_TOOLBAR_TOOLS;

  /** Expose test-only plot modes in the selector (e.g. the napari `Image`
   *  mode, otherwise hidden). The host app sets this from a `?test=1` URL
   *  toggle. Off by default, so production users never see them. */
  @Input()
  testMode = false;

  /** Image-smoothing state for the toolbar's Smoothen toggle (OSD only).
   *  Defaults to `false` so OSD shows raw pixels (nearest-neighbour). */
  imageSmoothingEnabled = false;
  loadingMessage = 'Loading image...';
  zoom = false;
  fileName: string | undefined;
  private loadedFileName: string | undefined;
  imageInfo: IImageInfo | undefined;

  /** Completes on destroy; every subscription the component makes is `takeUntil` it. */
  private unsub = new Subject<void>();

  public stackLoading = false;
  public imgLoading = false;
  public loadingPercentage = 0;
  // Non-null (0..100) while jit-service is copying the source file into the
  // local cache PVC on first click. When set, the loading overlay swaps the
  // spinner for a determinate progress bar with a "Caching image" message.
  public cacheProgress: number | null = null;
  // True between the small-tier render landing and the large-tier render
  // landing in the multi-tier rendering path. The template uses this to
  // overlay a translucent spinner on top of the blurry small-tier image so
  // the user doesn't mistake it for the final preview.
  public sharpening = false;
  /** A jit-service cache copy is actively in progress (determinate 0..99). Drives the cache
   *  progress bar independently of `imgLoading` so the bar can't be dropped — or masked by the
   *  "Sharpening preview..." overlay — mid-download if the loading flag flips early. */
  get isCaching(): boolean {
    return this.cacheProgress !== null && this.cacheProgress < 100;
  }
  private running = false;

  /**
   * Monotonic render generation. Bumped when a render starts, so a render that
   * has been superseded by a newer image can be recognised and made inert: its
   * callbacks return early instead of painting, clearing `running`, releasing
   * the newer render's overlay, or applying its ROIs.
   */
  private renderToken = 0;
  /** Aborts the current render's backend loads; replaced with each new render. */
  private renderAbort: AbortController | null = null;
  /** Host image-info objects whose one-shot `initialZIndex` was already applied. */
  private readonly consumedSliceHints = new WeakSet<IImageInfo>();
  /** Set once the template, and with it the plot div, exists (see ngAfterViewInit). */
  private viewReady = false;
  /** An image-less dataset whose draw waits for the view: see plotSpatialWithoutImage. */
  private pendingSpatialDraw: SpatialDataset | null = null;
  public zIndex = 0;
  public maxIndex = 0;

  @ViewChild('cm') contextMenu!: ContextMenu;
  contextMenuItems: MenuItem[] = [];

  activeDragMode: string | null = null;

  /** Whether a region action is available to undo (jit-ui#85). Mirrors the
   *  shared RegionStore's history depth; drives the toolbar Undo button. */
  canUndoRegion = false;
  /** Whether an undone region action is available to redo (jit-ui#85). */
  canRedoRegion = false;

  /** Custom-threshold Simplify dialog (jit-ui#85). */
  displaySimplifyDialog = false;
  simplifyThreshold = 3;
  /** Current region selection (array indices) — mirrored from the store so the
   *  context-menu region actions can read it synchronously (jit-ui#85). */
  private selectedIndices: number[] = [];

  /** Wand sensitivity — higher = stricter (smaller selection). Matches QuPath default. */
  wandSensitivity = 2.0;
  /** Brush diameter in image-pixel coordinates (drives the painted disc size). */
  brushSize = 40;
  /** Class the brush paints while a plot mode armed it (PlotModeTools.armBrush); null = plain brush. */
  private brushClass: PlotModeBrushClass | null = null;
  /** SAM model picker options + current selection (jit-ui#90 P1). Only models
   *  with a hosted ONNX pair (configured via setSamModelUrls at app init) are
   *  offered, so the picker can't select a model that can't run. */
  samModels = SAM_MODELS.filter(isSamModelReady).map((m) => ({ id: m.id, label: m.label }));
  samModelId = getDefaultSamModelId();

  /**
   * No-prompt tools registered through {@link TOOLBAR_TOOLS}, filtered to those
   * with configured models and sorted. This library registers none — a host
   * supplies them — so an open build has an empty array here and the toolbar
   * and help dialog simply omit that group.
   */
  contributedTools: ToolbarToolContribution[] = [];
  /**
   * Dialog tools registered through {@link TOOLBAR_TOOLS} (`kind: 'dialog'`),
   * sorted. Their buttons sit with the host's own actions and show in the Image
   * view only; each opens a floating dialog the tool fills.
   */
  dialogTools: ToolbarDialogToolContribution[] = [];
  /** The dialog tool the user has open (its session may be between renders). */
  openDialogToolId: string | null = null;
  /** The open dialog tool's live dialog, as the template renders it. */
  toolDialog: { title: string; width: string; host: HTMLElement } | null = null;
  /** Dialog-tool sessions: the same lifecycle and isolation as contributed plot modes. */
  private readonly toolDialogs: PlotModeController;
  /** Active checkpoint per contributed tool. */
  toolModelIds: Record<string, string> = {};
  /**
   * Parameter values per contributed tool, seeded from each tool's own defaults
   * — which encode the scale and crowding its checkpoint was trained for.
   */
  toolParams: Record<string, Record<string, unknown>> = {};
  /**
   * The open parameter dialog, built once by {@link openToolParams}: the tool, its
   * live values, and each field's spec already narrowed for the template (an
   * `*ngSwitchCase` does not narrow a union in the template type checker). Null
   * while closed. Built up front so change detection only reads properties.
   */
  openParams: {
    tool: ToolbarToolContribution;
    values: Record<string, unknown>;
    fields: { spec: ToolParamSpec; number: NumberParamSpec | null; select: SelectParamSpec | null }[];
  } | null = null;
  /** SAM download/segment toast state (bound by the `sam` p-toast template). */
  samStatus = '';
  samProgress = 0; // 0..100, encoder download
  samDownloading = false;
  samBusy = false; // any SAM work in flight (drives the indeterminate spinner)
  /** Whether the shared `sam` toast is currently shown (avoids stacking it on
   *  every point click, which re-runs inference). */
  private samToastShown = false;

  readonly samToastKey = `sam-${VisualizerComponent.nextToastId++}`;
  /**
   * Outlet for the library's own result/error notices.
   *
   * PrimeNG routes a message to a `<p-toast>` only when the keys match — a
   * keyless message reaches a keyless toast and nothing else. These notices used
   * to be emitted with no key, so they rendered only in hosts that happen to
   * mount a bare `<p-toast>` (jit-ui does, in its file-tree component). Every
   * other host — including this repo's own browser example — dropped them
   * silently, which made a failed or no-op segmentation look like a dead button:
   * the sticky progress toast is cleared in the same tick by hideSamToast, and
   * the message explaining why never appeared anywhere.
   *
   * Keyed to this component instance so the library renders its own outlet and
   * is not dependent on host markup. Deliberately NOT the sticky toast's key:
   * {@link hideSamToast} clears that key in the `finally`, which would wipe the
   * result the moment it was posted, and the sticky toast's custom template is
   * built for the live status + progress bar.
   */
  readonly resultToastKey = `${this.samToastKey}-result`;
  /** Vertex eraser radius in image-pixel coordinates. */
  vertexEraserRadius = 20;

  /** Channels & Histogram dialog visibility (opened from the toolbar). */
  showChannelHistogram = false;
  /** Spatial-omics controls dialog visibility (toolbar button). */
  showSpatialControls = false;
  /** Region Editor dialog visibility (opened from the toolbar). */
  showRegionEditor = false;
  /** Region Editor dialog width. On open it is set to the configured host
   *  element's current width, or — when no selector is configured / the element
   *  isn't found — to a quarter of the page (see openRegionEditor). */
  regionEditorWidth = '25vw';
  readonly plotDivName = `viz-plot-${plotInstanceSeq++}`;
  plotType = PlotType.IMAGE;
  isHeatmap = true;
  activeSurface3dMode = 'turntable';
  /** Whether the napari 3D coordinate-axes / scale gizmo is shown (volume/isosurface). */
  axesVisible = true;
  wireframeActive = false;
  /** napari 3D decimate factor (1 = Full … 8 = ⅛; default ½); changing it re-plots. */
  resolutionScale = NAPARI_DEFAULT_DECIMATE;

  /** The selector's entries: the built-in plot types the active backend
   *  advertises (3D gated by capability), then any contributed modes
   *  ({@link PLOT_TYPE_CONTRIBUTIONS}). */
  plotTypeMenu: PlotTypeOption[] = [];
  /**
   * The built-in plot types on offer — {@link plotTypeMenu} without contributed
   * modes. Kept with its original type so existing readers are unaffected.
   */
  plotTypeOptions: PlotTypeDescriptor[] = [];
  /**
   * What the selector shows: a built-in type or a contributed mode's id. Every
   * rendering and tool decision goes through {@link basePlotType} instead, so a
   * contributed mode behaves exactly like the built-in type it rides on.
   */
  selectedPlotTypeId: PlotTypeId = PlotType.IMAGE;

  /**
   * The built-in plot type being rendered. With no contributed mode active this
   * is the selection itself; during one it is the mode's `baseType`. Kept with its
   * original `PlotType` type for existing readers — use {@link selectedPlotTypeId}
   * for the selector's id. Assigning selects that built-in type.
   */
  get selectedPlotType(): PlotType {
    return this.basePlotType;
  }
  set selectedPlotType(type: PlotType) {
    this.selectedPlotTypeId = type;
  }

  /** Contributed plot modes and their single live session. */
  readonly plotModes: PlotModeController;
  /**
   * The live contributed mode's side panel, as the template renders it: an
   * Angular component with its own injector, or a plain host element a `mount`
   * panel rendered into. Null while no contributed session is live.
   */
  plotModePanel: {
    title: string;
    component: Type<unknown> | null;
    injector: Injector | null;
    host: HTMLElement | null;
  } | null = null;
  private destroying = false;

  /** Where a `mount` panel's host element is attached once the dialog renders. */
  @ViewChild('plotModePanelSlot')
  set plotModePanelSlot(ref: ElementRef<HTMLElement> | undefined) {
    const host = this.plotModePanel?.host;
    if (ref && host && host.parentElement !== ref.nativeElement) ref.nativeElement.appendChild(host);
  }

  /** The built-in type actually rendered for {@link selectedPlotTypeId}: itself
   *  for a built-in type, `baseType` for a contributed mode. */
  get basePlotType(): PlotType {
    return this.plotModes.baseTypeOf(this.selectedPlotTypeId);
  }

  /** Div the floating intensity-profile inset is charted into. Per instance, like
   *  {@link plotDivName}: the backend resolves it by id, so a fixed id made two live
   *  viewers draw both insets into whichever div came first in the document. */
  readonly intensityInsetDiv = `${this.plotDivName}-inset`;
  profilePanelPos = { x: 20, y: 70 };
  private profilePanelDragging = false;
  private profilePanelStart = { mx: 0, my: 0, x: 0, y: 0 };

  /** Toolbar docking: docked across the top by default; dragging its handle
   *  detaches it into a floating, movable window (frees the top row for the
   *  visualization). */
  toolbarFloating = false;
  toolbarPos = { x: 8, y: 8 };
  private toolbarDragging = false;
  private toolbarStart = { mx: 0, my: 0, x: 0, y: 0 };
  private latestProfiles: IntensityProfile[] = [];
  /** Drives the intensity inset panel's visibility — true whenever any
   *  intensity-profile line exists (independent of the current plot type). */
  hasProfiles = false;
  private profileDragMoveListener?: (e: MouseEvent) => void;
  private profileDragUpListener?: () => void;
  private profileResizeListener?: () => void;

  /** True while the 3D spatial cloud is the active mode. The controls drop the ROI
   *  selection there: region tools are screen-space, and against an orbiting
   *  camera a drawn rectangle has no fixed meaning in the data. */
  get isSpatial3dMode(): boolean {
    return isSpatialOmics3d(this.basePlotType);
  }

  /** True for the Image plot type, which renders as a natively pan/zoom-able
   *  raster — so the backend-agnostic zoom/pan toolbar tools are hidden. The
   *  component drives this off the plot type, not the active backend. */
  get isImageView(): boolean {
    return this.basePlotType === PlotType.IMAGE;
  }

  /** Isosurface band as a 0–255 slider position, mapped onto the volume's real
   *  intensity range by the renderer. Defaults to the full range. */
  isoRange: number[] = [0, 255];

  /** Whether a spatial-omics dataset is currently published on
   *  `SPATIAL_DATA_PORT` — gates the spatial plot types in the selector. Also bound
   *  by the toolbar, which offers the plot modes for a dataset with no image too. */
  hasSpatialDataset = false;
  /** The spatial dataset on offer, for drawing one that brings no image (see reloadAndPlot). */
  private spatialDataset: SpatialDataset | null = null;
  /** Whether that dataset's observations carry a z, gating the 3D spatial mode. */
  private hasSpatial3dDataset = false;
  /** Whether it carries a registered volume. Change detection only: a volume
   *  appearing is what publishes it as the image, and the plot-type gates then
   *  see an ordinary grayscale stack. */
  private hasSpatialVolume = false;
  /** Dataset identity + capability shape the last emission was handled at, so a
   *  switch between two datasets of the same shape is not mistaken for a repeat. */
  private spatialDatasetKey: string | null = null;
  /** Dataset + geometry the currently published volume image was built from, so a
   *  re-emitted dataset doesn't re-fetch megabytes or reset the user's scrub. */
  private volumeImageKey: string | null = null;
  /** Blob URLs backing that image — ours to revoke. */
  private volumeImageUrls: string[] = [];

  private plotContextMenuListener?: (e: MouseEvent) => void;
  private keydownListener?: (e: KeyboardEvent) => void;
  private wheelListener?: (e: WheelEvent) => void;

  /** Debounced z-slice scrubbing (see SliceScrubber — refactoring plan Step 7). */
  private readonly scrubber = new SliceScrubber((z) => {
    this.plotService.setZIndex(z);
    // In a per-slice z-stack session the store swaps the live region set to this
    // slice (preserving edits made on the previous one); outside stack mode this
    // just records the slice, leaving single-plane regions untouched (jit-ui#93).
    this.plotService.setDisplaySlice(z);
  });

  constructor(
    @Inject(IMAGE_STATE_PORT) private state: ImageStatePort,
    @Inject(VISUALIZER) public plotService: IVisualizer,
    public messageService: MessageService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private session: VisualizerStore,
    private samTool: SamToolService,
    private cellSegmentTool: CellSegmentToolService,
    private samPointTool: SamPointToolService,
    private regionOps: RegionOpsService,
    @Optional() @Inject(VIZ_CONFIG) private vizConfig?: VizConfig,
    // A constructor parameter rather than a field `inject()`: this component is
    // also constructed directly with `new` in its own specs, which is outside
    // an injection context and would throw NG0203 on a field initializer.
    @Optional() @Inject(TOOLBAR_TOOLS) toolContributions?: readonly ToolbarContribution[],
    // Optional like the rest: a host that shows only images never provides it,
    // and the spatial plot types simply stay hidden.
    @Optional() @Inject(SPATIAL_DATA_PORT) private spatialData?: SpatialDataPort,
    // Contributed plot modes. Like TOOLBAR_TOOLS the token has no factory, so a
    // host that provides none gets null here and the selector is unchanged.
    @Optional() @Inject(PLOT_TYPE_CONTRIBUTIONS) plotTypeContributions?: readonly PlotTypeContribution[],
    // Parent of a contributed panel component's injector. Optional only so the
    // specs can construct this component with `new`.
    @Optional() private injector?: Injector,
  ) {
    this.plotModes = new PlotModeController(plotTypeContributions, {
      onActivated: (active) => this.showPlotModePanel(active),
      onDeactivating: () => this.hidePlotModePanel(),
      onFailed: (contribution) => this.fallBackFromPlotMode(contribution),
    });
    this.contributedTools = visibleToolContributions(toolContributions);
    this.dialogTools = dialogToolContributions(toolContributions);
    // A dialog tool's session is run by the plot-mode lifecycle, adapted: its "base
    // type" is the Image view it draws over. Its body is NOT a controller panel: the
    // controller would mount into a detached host, and a body must be able to measure
    // itself. The dialog is rendered first and the body mounted once its host is in the
    // document (showToolDialog).
    this.toolDialogs = new PlotModeController(
      this.dialogTools.map((t): PlotTypeContribution => ({
        descriptor: { type: t.id, label: t.label, dimensions: '2d', baseType: PlotType.IMAGE },
        activate: (ctx) => t.activate(ctx as ToolDialogContext),
      })),
      {
        onActivated: (active) => this.showToolDialog(active),
        onDeactivating: () => this.hideToolDialog(),
        onFailed: (contribution) => this.dialogToolFailed(contribution.descriptor.type),
      },
    );
    this.computePlotTypeOptions();
  }

  /**
   * Track whether a spatial-omics dataset is available. A dataset appearing (or
   * being cleared) changes which plot types make sense, so it drives the same
   * recompute + reconcile that the image stream and the test-mode toggle do.
   *
   * No-op when the host provides no `SPATIAL_DATA_PORT` — the spatial types then
   * stay hidden for the life of the component.
   */
  private watchSpatialDataset(): void {
    this.spatialData?.getDataset$().pipe(takeUntil(this.unsub)).subscribe((dataset) => {
      this.spatialDataset = dataset ?? null;
      const has = !!dataset;
      // Only a dataset whose observations carry a z can be drawn as a cloud, so
      // the 3D mode is gated on the coordinates, not merely on a dataset being
      // present. Most spatial assays are one plane.
      const has3d = !!dataset?.observations.z;
      const hasVolume = !!dataset?.volume;
      // The port publishes its current value on subscribe, so the initial `null`
      // would otherwise recompute the selector for no change. Keyed by dataset
      // IDENTITY as well as capability shape: two 3D datasets that both carry a
      // volume have the same shape, and comparing only that skipped the switch —
      // leaving the previous dataset's volume image on screen underneath the new
      // one's observations.
      const key = dataset
        ? `${dataset.id}|${has3d}|${hasVolume}|${dataset.volume
          ? `${dataset.volume.width}x${dataset.volume.height}x${dataset.volume.depth}` : ''}`
        : null;
      if (key === this.spatialDatasetKey) return;
      this.spatialDatasetKey = key;
      this.hasSpatialDataset = has;
      this.hasSpatial3dDataset = has3d;
      // Whether the dataset says it registers onto a tissue image. Distinct from an
      // image being LOADED: a registered dataset's image may still be on its way, and
      // the pixel modes must not flicker out of the selector while it arrives.
      // A registered dataset draws over a tissue image; a volume-backed one publishes its
      // volume AS a grayscale z-stack image (`buildVolumeStackImage`). Either way pixels
      // exist, so the pixel modes stay on offer — Volume and Isosurface are exactly how
      // a 3D omics dataset is read.
      this.spatialDatasetHasPixels = !!dataset?.imageRef || hasVolume;
      this.hasSpatialVolume = hasVolume;
      this.computePlotTypeOptions();
      // A dataset with no reference image has nothing to draw observations OVER:
      // a cloud registered into a common frame (the Allen CCF) has coordinates
      // but no one section. What it does have is its registered VOLUME, which is
      // a 3D image in one file — so make that the image and open on it, slice bar
      // and all, rather than leaving the host on an Image view showing whatever
      // slide was loaded before. Ordered after computePlotTypeOptions so the type
      // is on offer before it is selected.
      if (dataset && !dataset.imageRef && hasVolume) {
        void this.showVolumeAsImage(dataset);
      } else {
        // Anything else — a dataset with its own section image, a volume-less
        // cloud, or none at all — means a published volume image is no longer what
        // is on screen. Forget it, or coming BACK to the volume dataset would
        // short-circuit on a matching key and leave the other dataset's slide up.
        this.dropVolumeImage();
        if (dataset && !dataset.imageRef) {
          // No reference image and no volume to slice: the observations are the only
          // thing there is to draw, so open on whichever spatial mode their
          // coordinates support. Leaving the type alone strands the host on an Image
          // view showing whatever slide was loaded BEFORE — the observations never
          // appear, and the previous dataset's tissue does, which reads as this
          // dataset failing to load.
          //
          // Gated on the coordinates, not on the dataset merely existing: a
          // one-plane assay has no z and cannot be a cloud. That case only turned up
          // with an image-less 2D dataset, which is why it went unhandled — before
          // it, image-less meant 3D.
          const target = has3d ? PlotType.SPATIAL_OMICS_3D : PlotType.SPATIAL_OMICS;
          if (this.selectedPlotTypeId !== target) this.onSelectPlotType(target);
          // Same mode, another image-less dataset, nothing loaded: re-plot so its placeholder
          // image info (and with it the regions' key) is this dataset's, not the last one's.
          else if (!this.imageInfo) this.reloadAndPlot();
        }
      }
      // Clearing the dataset while a spatial mode is active leaves a type that is
      // no longer offered — fall back to Image, as turning test mode off does.
      this.reconcileSelectedPlotType();
      this.cdr.detectChanges();
    });
  }

  /**
   * Publish a dataset's reference volume AS the image, and open the 2D Image view
   * on it.
   *
   * The volume is a 3D image delivered in one file, so for a dataset that has no
   * section image it is the honest thing to put on screen: the slice bar scrubs z,
   * and the contrast window, colormaps and region tools all work because the
   * volume genuinely is the image now. The 3D cloud stays one menu pick away.
   *
   * Keyed by dataset + geometry: the dataset stream re-emits on things like a
   * colour-column change, and rebuilding then would re-fetch the voxels and throw
   * the user back to the middle slice.
   */
  private async showVolumeAsImage(dataset: SpatialDataset): Promise<void> {
    const meta = dataset.volume;
    if (!meta || !this.spatialData?.getVolume) return;
    const key = `${dataset.id}:${meta.width}x${meta.height}x${meta.depth}`;
    if (key === this.volumeImageKey) return;
    // Claim the key BEFORE awaiting: the stream can emit again while the voxels
    // are in flight, and two builds of the same volume would race to publish.
    this.volumeImageKey = key;
    this.state.setImageLoading(true);
    try {
      const built = await buildVolumeStackImage(dataset, await this.spatialData.getVolume());
      // A different dataset was selected while this one encoded — its image is the
      // one that belongs on screen, so drop what we just built.
      if (this.volumeImageKey !== key) {
        built?.urls.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      if (!built) {
        this.volumeImageKey = null;
        return;
      }
      // Pick the mode first so the image lands in the view that will show it,
      // instead of rendering once into whatever mode the last dataset left active.
      if (this.selectedPlotTypeId !== PlotType.IMAGE) this.onSelectPlotType(PlotType.IMAGE);
      this.revokeVolumeImageUrls();
      this.volumeImageUrls = built.urls;
      this.state.setImageInfo(built.info);
    } catch (err) {
      // No volume served after all: the cloud is still renderable, so fall back to
      // it rather than leaving the host on an Image view with nothing in it.
      console.warn('[visualizer] reference volume unavailable — falling back to the 3D cloud', err);
      this.volumeImageKey = null;
      if (this.hasSpatial3dDataset && !isSpatialOmics3d(this.basePlotType)) {
        this.onSelectPlotType(PlotType.SPATIAL_OMICS_3D);
      }
    } finally {
      // Only the build still on screen (or one that failed and released its key) may
      // drop the overlay: a newer volume build that superseded this one is still encoding.
      if (this.volumeImageKey === key || this.volumeImageKey === null) this.state.setImageLoading(false);
      this.cdr.detectChanges();
    }
  }

  /** Forget the published volume image so re-selecting the dataset rebuilds it.
   *  The URLs deliberately stay alive: the host may still be displaying that image
   *  at this instant, and revoking under it would break every later tile read. They
   *  are freed when the next volume replaces them, or on destroy. */
  private dropVolumeImage(): void {
    this.volumeImageKey = null;
  }

  private revokeVolumeImageUrls(): void {
    this.volumeImageUrls.forEach((u) => URL.revokeObjectURL(u));
    this.volumeImageUrls = [];
  }

  /**
   * Plot types offered in the selector for the current image:
   *  - Outside **test mode**, only the curated default set (descriptors with a
   *    `productionLabel`) is offered, shown under suffix-free names — Image,
   *    Heatmap, Contour and the napari Surface / Volume / Isosurface. Test mode
   *    exposes every backend's type under its full (backend-suffixed) label.
   *  - 3D types hidden when the backend can't render a 3D scene.
   *  - stack-only types (volume, isosurface) hidden unless the file is a stack —
   *    a volume needs multiple z-slices.
   *  - scalar-intensity types (contour, surface, isosurface) hidden for RGB
   *    images — they map a single intensity per pixel. Image and Heatmap render
   *    any image.
   *  - spatial-omics types hidden until a `SpatialDataset` is published on
   *    `SPATIAL_DATA_PORT` — the mode has nothing to draw without observations,
   *    exactly as a volume has nothing to draw without a stack.
   */
  private computePlotTypeOptions() {
    const caps = this.plotService.capabilities;
    const isStack = !!this.imageInfo?.isStack;
    const isGrayscale = !!this.imageInfo?.isGrayscale;
    // A multichannel image's bands are each single-band (scalar), so the scalar
    // plot modes (Heatmap / Surface / Volume / Isosurface) apply per channel even
    // though the RGB composite isn't grayscale — don't gate them out.
    const m0 = this.imageInfo?.imageMeta?.[0];
    const isMultichannel = (m0?.channelCount ?? 1) > 1 && (m0?.rgbChannels ?? 1) < 3;
    const passesGates = (d: PlotTypeDescriptor): boolean => {
      if (d.dimensions === '3d' && !caps.has(ViewerFeature.Surface3D)) return false;
      // Volume and Isosurface raymarch the IMAGE STACK, and nothing else: these
      // two gates are about the loaded image, full stop. A 3D omics dataset
      // reaches them because its registered volume is published AS a grayscale
      // z-stack image (`buildVolumeStackImage`), not through a second voxel
      // source hiding behind the same modes.
      if (d.requiresStack && !isStack) return false;
      if (d.requiresGrayscale && !isGrayscale && !isMultichannel) return false;
      if (d.requiresSpatialData && !this.hasSpatialDataset) return false;
      if (d.requiresSpatial3d && !this.hasSpatial3dDataset) return false;
      // An image-sourced mode reads PIXELS. A spatial dataset that brings no tissue
      // image (seqFISH records unitless coordinates, not a section) leaves nothing for
      // one to draw, so offering Image / Heatmap / Surface there offers modes that can
      // only come up blank — or worse, showing whatever slide was loaded before.
      //
      // Narrowed to "a dataset is up AND there is no image": with no dataset at all,
      // Image stays on offer, because a host that has not loaded anything yet needs a
      // default and an empty selector would be worse than a blank view.
      if (d.source === 'image' && this.hasSpatialDataset
        && !this.spatialDatasetHasPixels) return false;
      return true;
    };
    // Outside test mode, only the curated set (those with a productionLabel)
    // is offered; test mode exposes every backend's type.
    const curated = (d: { productionLabel?: string }): boolean => this.testMode || !!d.productionLabel;
    const builtIn = this.plotService.getPlotTypeDescriptors()
      .filter((d) => curated(d) && passesGates(d));
    // Contributed modes come after every built-in one, under the same label rule
    // and their own stack/grayscale/spatial gates. A mode also needs whatever its base
    // view needs (pixels, a 3D-capable backend), so the base type's gates apply
    // too — a contributed Image-based mode goes wherever Image goes.
    const contributed: PlotTypeOption[] = [];
    for (const d of this.plotModes.descriptors()) {
      if (!curated(d)) continue;
      if (d.requiresStack && !isStack) continue;
      if (d.requiresGrayscale && !isGrayscale && !isMultichannel) continue;
      if (d.requiresSpatialData && !this.hasSpatialDataset) continue;
      if (d.requiresSpatial3d && !this.hasSpatial3dDataset) continue;
      const base = getPlotTypeDescriptor(d.baseType);
      if (base && passesGates(base)) contributed.push(contributedPlotTypeOption(d, base));
    }
    // Default selector shows the suffix-free productionLabel; test mode keeps
    // the full backend-suffixed label so same-named modes stay distinguishable.
    const labelled = <T extends { label: string; productionLabel?: string }>(d: T): T =>
      (this.testMode ? d : { ...d, label: d.productionLabel! });
    this.plotTypeOptions = builtIn.map(labelled);
    this.plotTypeMenu = [...this.plotTypeOptions, ...contributed.map(labelled)];
  }

  ngOnChanges(changes: SimpleChanges): void {
    // The constructor computes the options with testMode still at its default;
    // recompute once the host binds it (and on any later change) so the selector
    // reflects test mode immediately, without waiting for an image to (re)load.
    if (changes['testMode']) {
      this.computePlotTypeOptions();
      // If test mode is turned off while a test-only type (e.g. NAPARI_IMAGE) is
      // active, that type is no longer offered — fall back to Image.
      this.reconcileSelectedPlotType();
    }
  }

  /** Whether the live spatial dataset brings pixels of its own — a tissue image it
   *  registers onto, or a volume that is published as a z-stack image. */
  private spatialDatasetHasPixels = false;

  /**
   * The host published NO image — a spatial dataset that brings none does this.
   *
   * Without handling the empty emission, `imageInfo` keeps the LAST image's metadata: the
   * selector goes on offering pixel modes for pixels that are gone, and every
   * `isStack`/`isGrayscale` decision is made against a file that is no longer loaded.
   */
  private onImageCleared(): void {
    // The image a contributed mode was drawing over is gone. An open dialog
    // tool stays open and restarts once the next image has plotted.
    this.plotModes.deactivate();
    this.toolDialogs.deactivate();
    this.imageInfo = undefined;
    this.loadedFileName = undefined;
    this.computePlotTypeOptions();
    // Deliberately NOT reconciling the selected type here. Reconciling calls
    // `setPlotType`, which drives a re-plot — and there is nothing to plot, so the
    // Plotly backend read its own now-unset `imageInfo` and threw
    // ("can't access property isGrayscale"), aborting the load with no observations
    // drawn. Ignoring the empty emission entirely is what used to avoid that.
    //
    // Nothing is left stranded: an image is cleared because a spatial dataset that
    // brings none is being opened, and that dataset's own subscription selects the
    // mode its coordinates support a moment later.
    this.cdr.detectChanges();
  }

  /** If the active plot type is no longer in the offered options (e.g. test mode
   *  turned off while a test-only type was active, or a scalar type carried onto
   *  an RGB image), fall back to the default 2D Image view. */
  private reconcileSelectedPlotType(): void {
    if (this.plotTypeMenu.some((d) => d.type === this.selectedPlotTypeId)) return;
    // Image is the usual fallback, but it is not always ON OFFER: with no image loaded
    // the pixel modes are gone, and falling back to one would select a mode the selector
    // does not list and nothing can draw. Take the first type still offered instead.
    const fallback = this.plotTypeMenu.some((d) => d.type === PlotType.IMAGE)
      ? PlotType.IMAGE
      : this.plotTypeMenu[0]?.type;
    if (!fallback) return;
    // Leaving a contributed mode (its gates stopped passing, or its provider is
    // gone): its session ends before anything else draws.
    this.plotModes.deactivate();
    const base = this.plotModes.baseTypeOf(fallback);
    if (base !== PlotType.IMAGE) this.closeDialogTool();
    this.selectedPlotTypeId = fallback;
    this.plotType = base;
    this.isHeatmap = base === PlotType.IMAGE;
    this.plotService.setPlotType(base);
  }

  ngOnInit(): void {
    // Join the live set; the oldest member renders the shared notice outlets.
    VisualizerComponent.liveInstances.add(this);
    this.state.setDiagram(this.hostHandle);
    this.watchSpatialDataset();
    // OSD and napari-js emit this from their own "fit to view": disarm the tool on
    // the backend too, not only the toolbar's highlight.
    this.plotService.getAutoscaleEvent().pipe(takeUntil(this.unsub)).subscribe(() => {
      this.applyDragMode(null);
    });
    this.state.isImageLoading$().pipe(takeUntil(this.unsub)).subscribe((isImageLoading) => {
      this.imgLoading = isImageLoading;
    });
    // Undo availability (jit-ui#85): the shared RegionStore emits whenever its
    // history depth changes; greys out the toolbar Undo button accordingly.
    this.plotService
      .getCanUndo$()
      .pipe(takeUntil(this.unsub))
      .subscribe((canUndo) => {
        this.canUndoRegion = canUndo;
        this.cdr.detectChanges();
      });
    this.plotService
      .getCanRedo$()
      .pipe(takeUntil(this.unsub))
      .subscribe((canRedo) => {
        this.canRedoRegion = canRedo;
        this.cdr.detectChanges();
      });
    // Mirror the region selection so the right-click action group (jit-ui#85)
    // can read it synchronously when the menu is built.
    this.plotService
      .getSelectedShapeIndices$()
      .pipe(takeUntil(this.unsub))
      .subscribe((indices) => {
        this.selectedIndices = indices || [];
      });
    // Interactive point-prompt segmentation runs inside the renderer on each
    // click; surface its live status + download progress in the shared `sam`
    // toast so the user sees it working (the first click pulls the encoder).
    this.samPointTool.progress$.pipe(takeUntil(this.unsub)).subscribe((f) => {
      this.samDownloading = f >= 0 && f < 1;
      if (f >= 0) this.samProgress = Math.min(100, Math.round(f * 100));
      this.cdr.detectChanges();
    });
    this.samPointTool.status$.pipe(takeUntil(this.unsub)).subscribe((m) => {
      this.samStatus = m;
      this.cdr.detectChanges();
    });
    this.samPointTool.busy$.pipe(takeUntil(this.unsub)).subscribe((busy) => {
      this.samBusy = busy;
      if (busy) this.showSamToast('SAM point segmentation');
      this.cdr.detectChanges();
    });
    this.plotService.getStackLoadingProgress().pipe(takeUntil(this.unsub)).subscribe((loadingProgress) => {
      this.loadingPercentage = loadingProgress;
    });
    this.plotService.isStackLoading().pipe(takeUntil(this.unsub)).subscribe((stackLoading) => {
      this.stackLoading = stackLoading;
    });
    this.state.getPanelWidth$().pipe(takeUntil(this.unsub)).subscribe(() => {
      this.plotService.relayout();
      // The intensity inset is a separate Plotly chart in a floating panel; reflow
      // it to its current size when the canvas resizes, else it keeps the stale
      // size and blanks out. Defer a tick so the panel layout has settled.
      if (this.hasProfiles) {
        setTimeout(() => this.renderIntensityInset(), 0);
      }
    });
    this.state.getImageLoadingMessage$().pipe(takeUntil(this.unsub)).subscribe((message) => {
      this.loadingMessage = message;
    });
    this.state
      .getCacheProgress$()
      .pipe(takeUntil(this.unsub))
      .subscribe((progress) => {
        this.cacheProgress = progress;
      });
    this.state.isZoom$().pipe(takeUntil(this.unsub)).subscribe((zoom) => {
      this.zoom = zoom;
    });
    this.state.getFilename$().pipe(takeUntil(this.unsub)).subscribe((filename) => {
      if (filename) {
        this.fileName = filename;
      }
    });
    this.plotService.getIntensityProfile$().pipe(takeUntil(this.unsub)).subscribe((profiles) => {
      this.latestProfiles = profiles;
      this.hasProfiles = profiles.length > 0;
      // The panel div is behind *ngIf="hasProfiles". detectChanges() materializes
      // it synchronously (the subscription may fire outside Angular's zone — e.g.
      // from an OSD drag — so CD wouldn't run on its own). Then render on the next
      // animation frame, AFTER the browser lays the panel out: a synchronous draw
      // hits a zero-size container on first create and Plotly keeps that size, so
      // the inset stays blank and live updates redraw into the same zero box.
      this.cdr.detectChanges();
      requestAnimationFrame(() => this.renderIntensityInset());
    });
    // When the OSD view settles at a new zoom/pan, re-sample the intensity lines
    // from a crop of the visible region so the inset reflects the zoom-level
    // resolution (Plotly's own high-def zoom updates the sampling cache inline).
    this.plotService.getViewportChange$().pipe(takeUntil(this.unsub)).subscribe((roi) => {
      if (this.hasProfiles && this.isImageView) {
        this.plotService.refreshIntensitySamplingForRoi(roi.x, roi.y, roi.width, roi.height, this.zIndex);
      }
    });
    this.state.getImageInfo$().pipe(takeUntil(this.unsub)).subscribe({
      next: (imgInfo) => {
        if (!imgInfo) {
          this.onImageCleared();
          return;
        }
        if (imgInfo) {
          this.imageInfo = imgInfo;
          // Stack-only plot types (isosurface, scatter3d) depend on whether this
          // file is a stack — recompute the selector options.
          this.computePlotTypeOptions();
          // If the active plot type isn't valid for this image (e.g. a scalar
          // type like Contour carried over to an RGB image), fall back to Image.
          this.reconcileSelectedPlotType();
          // Read from `imgInfo`, the value this emission carried, rather than from the
          // field. Handling the empty emission means the field CAN be nulled part-way
          // through this branch: `reconcileSelectedPlotType` may call `setPlotType`,
          // which can make the host publish a new image state, re-entering this very
          // subscription. Reading the field then threw on `isGrayscale` and aborted the
          // handler, so the observations were never drawn.
          this.isGrayscaleEvent.emit(imgInfo.isGrayscale);
          this.isStackEvent.emit(imgInfo.isStack);
          // Reset to the default 2D Image view when a different image is
          // selected while a 3D type is active.
          if (!this.isHeatmap && imgInfo.fileName !== this.loadedFileName) {
            this.isHeatmap = true;
            this.plotType = PlotType.IMAGE;
            this.selectedPlotTypeId = PlotType.IMAGE;
            this.plotService.setPlotType(this.plotType);
            this.activeSurface3dMode = 'turntable';
          }
          this.loadedFileName = imgInfo.fileName;
          this.plotService.setImageMeta(imgInfo.imageMeta, imgInfo.fileName);
          const urls = imgInfo.urls;
          // A newer image ALWAYS preempts an in-flight render. This was
          // `if (!this.running)`, which DROPPED the new image while the old one
          // finished: identity above had already flipped to the new file, so the
          // app reported image B as loaded while image A stayed on screen. Worse,
          // a cold image holds the slot for its whole server-side cache fill, so
          // every click for 1-2 minutes was discarded against a blank viewport
          // and a "Loading image..." overlay that never resolved.
          if (urls) {
            const token = ++this.renderToken;
            const isCurrent = () => this.renderToken === token;
            const signal = this.restartRenderAbort();
            if (this.running) {
              // Stop the previous render's frame streaming (napari volume/surface
              // preload keeps fetching otherwise) and clear its sharpen flag. Its
              // callbacks are already inert via the token, so it can neither paint
              // nor release the overlay this render now owns.
              this.plotService.cancelLoading?.();
              this.sharpening = false;
            }
            // image size — measure the plot div directly so the toolbar height is excluded
            const plotDiv: HTMLElement | null = document.getElementById(this.plotDivName);
            const screenHeight = plotDiv?.offsetHeight || 500;
            // A contributed mode's session is bound to the base view about to be
            // torn down, so it ends here — before reset(), before anything new
            // draws. If the mode is still selected once this render lands, a
            // fresh session starts for it (see activateSelectedPlotMode).
            this.plotModes.deactivate();
            this.toolDialogs.deactivate();
            this.plotService.reset();
            this.stackLoading = imgInfo.isStack && imgInfo.showStack;
            // set max index of stack — computed before updateZIndex so a
            // fresh stack (shorter or longer than whatever was previously
            // loaded) clamps against ITS bounds, not the stale ones.
            // One URL per slice (0-indexed), so the last reachable index is
            // length-1 — earlier `length-2` dropped the final slice.
            this.maxIndex = urls.length > 1 ? urls.length - 1 : 0;
            // One-shot hint: jump straight to a specific slice (e.g. the
            // file the user actually clicked within a numbered series).
            // Consumed immediately so redelivering the same ImageInfo later
            // (a plot-type switch, reloadAndPlot) doesn't reset the user's
            // current scrub position back to it.
            // The host's object is never written to (a host store may freeze it):
            // keep a copy without the hint as the component's own image info, which
            // is what reloadAndPlot re-emits, and remember the host object so the
            // very same emission repeated does not jump again.
            if (imgInfo.initialZIndex !== undefined) {
              if (!this.consumedSliceHints.has(imgInfo)) {
                this.consumedSliceHints.add(imgInfo);
                this.zIndex = imgInfo.initialZIndex;
              }
              this.imageInfo = { ...imgInfo, initialZIndex: undefined };
            }
            // make sure the zindex is within bounds
            this.updateZIndex();
            this.running = true;
            // Multi-tier rendering (small blurry tier first, then sharpen in
            // place) — sequencing lives in RenderOrchestrator; this component
            // supplies the phase render and owns the UI flags via callbacks.
            // 3D plot types render single-pass: the in-place large pass doesn't
            // rebuild a 3D gl-mesh isosurface, so the sharpen step blanked it.
            const hasSmallTier =
              this.isHeatmap &&
              (imgInfo.smallUrls?.length ?? 0) === urls.length &&
              (imgInfo.smallUrls?.length ?? 0) > 0;
            const smallImgInfo = hasSmallTier ? { ...imgInfo, urls: imgInfo.smallUrls as string[] } : null;

            // Enter per-slice stack mode with the given slice→regions map.
            // enterStackMode makes zIndex's slice live and resets undo (jit-ui#93).
            const enterStack = (
              slices: Map<number, Region[]>,
              layout: 'combined' | 'per-slice-file',
            ) => this.plotService.enterStackMode(slices, this.zIndex, layout);

            const applyRoi = () => {
              // Folder stack: a stack of self-contained per-slice files
              // (tiled === false; see loadSeriesAsStack). Each slice-file may
              // carry its own sibling "<stem>.geojson" (roiJsonStrs[z]), but a
              // fresh folder with none yet leaves roiJsonStrs undefined — key
              // off `tiled === false`, NOT roiJsonStrs, so an unannotated
              // folder stack still enters the per-slice-file layout (and saves
              // back one geojson per slice-file) rather than falling through to
              // the single-file combined path (jit-ui#93).
              if (imgInfo.isStack && imgInfo.tiled === false) {
                const perSlice = imgInfo.roiJsonStrs;
                const sliceCount = imgInfo.urls?.length ?? perSlice?.length ?? 0;
                const slices = new Map<number, Region[]>();
                for (let z = 0; z < sliceCount; z++) {
                  const json = perSlice?.[z] ?? null;
                  slices.set(z, json ? this.plotService.importRegions(json) : []);
                }
                enterStack(slices, 'per-slice-file');
                return;
              }
              // Single-file z-stack: one sibling geojson holding every slice's
              // regions indexed by QuPath's geometry.plane.z. Enter per-slice
              // mode (saving back one combined z-indexed geojson) when the
              // geojson actually carries slice indices, or when there's nothing
              // yet to author against. A legacy geojson whose regions are all on
              // the default plane stays global (shown on every slice) so
              // existing single-plane annotations aren't confined to slice 0.
              const roiJson = imgInfo.roiJsonStr;
              if (imgInfo.isStack) {
                const regions = roiJson ? this.plotService.importRegions(roiJson) : [];
                const hasSliceInfo = regions.some((r) => (r.z ?? 0) !== 0);
                if (!roiJson || hasSliceInfo) {
                  const slices = new Map<number, Region[]>();
                  for (const r of regions) {
                    const z = r.z ?? 0;
                    const bucket = slices.get(z);
                    if (bucket) bucket.push(r);
                    else slices.set(z, [r]);
                  }
                  enterStack(slices, 'combined');
                  return;
                }
              }
              // Single-plane image (or a legacy global z-stack geojson): one
              // region set for the whole image.
              if (roiJson) {
                this.plotService.setRegions(this.plotService.importRegions(roiJson));
              }
              // Loading an image's saved ROIs is not a user edit — start the
              // undo history fresh so the first undo can't wipe them (jit-ui#85).
              this.plotService.resetUndoHistory();
            };
            let overlayReleased = false;
            const releaseOverlay = () => {
              if (overlayReleased) return;
              overlayReleased = true;
              if (imgInfo.isStack && imgInfo.showStack) this.stackLoading = false;
              this.state.setImageLoading(false);
            };

            new RenderOrchestrator({
              // inPlace=true updates the existing render instead of rebuilding
              // it, so the canvas doesn't blank during the small→large swap.
              renderPhase: (phaseInfo, inPlace) => {
                // Superseded BEFORE this phase started — don't even issue the load.
                // RenderOrchestrator calls renderPhase once per tier and retries the
                // sharpen pass on failure, so checking only after the load resolves
                // would let a preempted render keep fetching slices/tiles for an
                // image nobody is looking at.
                if (!isCurrent()) return Promise.resolve(null);
                return this.plotService.load(phaseInfo, this.zIndex, signal).then((loadedImage) => {
                  // Preempted while this phase was loading — drop it on the floor.
                  if (!isCurrent()) return null;
                  // Guard against a newer click reaching us mid-render.
                  if (phaseInfo.fileName !== loadedImage.filename) return null;
                  return this.plotService.plot(
                    this.plotDivName,
                    loadedImage,
                    phaseInfo,
                    screenHeight,
                    this.plotType,
                    inPlace,
                  ).then((drawn) => {
                    // A backend that cannot draw (no plot target, no WebGPU, no tile
                    // descriptor) resolves false rather than throwing. That is a failed
                    // phase, not a finished one: reject so the retry/failure paths run.
                    if (drawn === false && isCurrent()) throw new Error('the renderer could not draw the image');
                    return drawn;
                  });
                });
              },
              smallShown: () => {
                if (!isCurrent()) return; // superseded by a newer image
                // If the file is still being cached/prepared server-side, keep the full
                // cache-progress overlay up instead of dropping to the translucent "Sharpening
                // preview..." spinner over a blank canvas (a large uncached image renders its
                // small preview before its tiles exist). finished() releases the overlay once
                // the real render lands.
                if (this.isCaching) return;
                // Small tier on screen — drop the full overlay but keep a translucent spinner so
                // the blurry render isn't mistaken for the final image.
                releaseOverlay();
                this.sharpening = true;
              },
              sharpenSettled: () => {
                if (!isCurrent()) return; // superseded by a newer image
                this.sharpening = false;
              },
              finished: () => {
                if (!isCurrent()) return; // superseded by a newer image
                // Idempotent — releases now if smallShown deferred it (caching) or was skipped.
                releaseOverlay();
                this.running = false;
                applyRoi();
                this.activateSelectedPlotMode();
                this.activateOpenDialogTool();
              },
              sharpenFailed: (err: unknown) => {
                if (!isCurrent()) return; // superseded by a newer image
                // The small tier stays on screen as the fallback — tell the
                // user the sharper version isn't coming.
                const msg = errorMessage(err);
                this.messageService.add({
                  key: this.vizAlertToastKey,
                  severity: 'warn',
                  summary: 'Preview not sharpened',
                  detail: `The full-resolution preview did not load (${msg}). The low-resolution preview is still shown. Try clicking the image again.`,
                });
                this.running = false;
                applyRoi();
                this.activateSelectedPlotMode();
                this.activateOpenDialogTool();
              },
              renderFailed: (err: unknown) => {
                if (!isCurrent()) return; // superseded by a newer image
                const msg = errorMessage(err);
                this.messageService.add({
                  key: this.vizAlertToastKey,
                  severity: 'error',
                  summary: 'Could not draw the image',
                  detail: `${imgInfo.fileName ?? 'The image'}: ${msg}. Try opening it again.`,
                });
              },
            }).render(imgInfo, smallImgInfo);
          }
        }
      },
      error: (err: unknown) => {
        const msg = errorMessage(err);
        console.error('Error occured when getting image info', err);
        this.messageService.add({
          key: this.vizAlertToastKey,
          sticky: true,
          severity: 'error',
          summary: 'An error occured',
          detail: `The following error occured while getting image info: ${msg}.
                   Please try to open the image again through the file navigator.`,
        });
        this.stackLoading = false;
        this.state.setImageLoading(false);
        this.running = false;
        this.plotService.reset();
      },
    });
  }

  ngAfterViewInit() {
    // Window listeners are registered OUTSIDE the Angular zone: zone-patched, every
    // mousemove anywhere in the host app ran app-wide change detection. Each handler
    // re-enters the zone (ngZone.run) only when it actually changes view state.
    this.ngZone.runOutsideAngular(() => this.addWindowListeners());
    this.onViewReady();
  }

  private addWindowListeners(): void {
    this.plotContextMenuListener = (event: MouseEvent) => {
      const plotEl = document.getElementById(this.plotDivName);
      if (!plotEl?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.ngZone.run(() => {
        this.contextMenuItems = this.buildContextMenuItems();
        this.cdr.detectChanges();
        this.contextMenu.show(event);
      });
    };
    window.addEventListener('contextmenu', this.plotContextMenuListener, true);

    this.keydownListener = (event: KeyboardEvent) => {
      if (this.isSliceStepKey(event)) {
        event.preventDefault();
        this.ngZone.run(() => this.stepSlice(event.key === 'ArrowRight' ? 1 : -1));
        return;
      }
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      // SAM point mode: Enter commits the object, Esc clears the prompt.
      if (this.activeDragMode === 'samPoint' && (event.key === 'Enter' || event.key === 'Escape')) {
        this.ngZone.run(() => {
          if (event.key === 'Enter') this.plotService.commitSamPoints();
          else this.plotService.clearSamPoints();
          this.hideSamToast(); // prompt resolved → dismiss the status toast
        });
        return;
      }
      // Region history (jit-ui#85): Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z or
      // Ctrl/Cmd+Y redoes.
      if (event.ctrlKey || event.metaKey) {
        const k = event.key.toLowerCase();
        if (k === 'z' && !event.shiftKey) {
          event.preventDefault();
          this.ngZone.run(() => this.undoRegion());
          return;
        }
        if ((k === 'z' && event.shiftKey) || k === 'y') {
          event.preventDefault();
          this.ngZone.run(() => this.redoRegion());
          return;
        }
      }
      // The bare-key shortcuts below must not fire on browser/OS shortcuts
      // (Cmd/Ctrl+D would delete the selected region, Ctrl+S toggle Select, …).
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'd' || event.key === 'D') {
        this.ngZone.run(() => this.deleteRegion());
      } else if (event.key === '+' || event.key === '=') {
        this.ngZone.run(() => this.zoomIn());
      } else if (event.key === '-' || event.key === '_') {
        this.ngZone.run(() => this.zoomOut());
      } else if (event.key === 'p') {
        this.ngZone.run(() => this.toggleDragMode('pan'));
      } else if (event.key === 'b') {
        this.ngZone.run(() => this.toggleDragMode('zoomToBox'));
      } else if (event.key === 'r') {
        this.ngZone.run(() => this.toggleDragMode('drawrect'));
      } else if (event.key === 'f') {
        this.ngZone.run(() => this.toggleDragMode('drawclosedpath'));
      } else if (event.key === 'w') {
        this.ngZone.run(() => this.toggleDragMode('wand'));
      } else if (event.key === 'e') {
        this.ngZone.run(() => this.toggleDragMode('eraseVertex'));
      } else if (event.key === 's') {
        this.ngZone.run(() => this.toggleDragMode('select'));
      } else if (event.key === 'l') {
        this.ngZone.run(() => this.toggleDragMode('drawopenpath'));
      }
    };
    window.addEventListener('keydown', this.keydownListener);

    this.wheelListener = (event: WheelEvent) => {
      const plotEl = document.getElementById(this.plotDivName);
      if (!plotEl?.contains(event.target as Node)) return;
      // Intercepting here fires a FIXED zoom step per wheel event, which is far
      // too sensitive for a renderer that reads the scroll delta — so anything
      // drawn by such a renderer keeps its own wheel. See `rendererOwnsWheel`.
      if (rendererOwnsWheel(this.basePlotType)) return;
      // 3D plot types (surface, scatter3d, isosurface) render in a Plotly scene
      // that orbits/zooms natively on scroll. The 2D step-zoom doesn't apply and
      // would throw (no xaxis on a scene), so let Plotly handle the wheel.
      if (!this.isHeatmap) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.deltaY < 0) {
        this.ngZone.run(() => this.zoomIn());
      } else if (event.deltaY > 0) {
        this.ngZone.run(() => this.zoomOut());
      }
    };
    window.addEventListener('wheel', this.wheelListener, { capture: true, passive: false });

    // Drag handling for the floating intensity-profile panel.
    this.profileDragMoveListener = (e: MouseEvent) => {
      if (this.profilePanelDragging) {
        this.ngZone.run(() => {
          this.profilePanelPos = {
            x: this.profilePanelStart.x + (e.clientX - this.profilePanelStart.mx),
            y: this.profilePanelStart.y + (e.clientY - this.profilePanelStart.my),
          };
        });
      } else if (this.toolbarDragging) {
        this.ngZone.run(() => {
          this.toolbarPos = {
            x: this.toolbarStart.x + (e.clientX - this.toolbarStart.mx),
            y: this.toolbarStart.y + (e.clientY - this.toolbarStart.my),
          };
        });
      }
    };
    this.profileDragUpListener = () => {
      this.profilePanelDragging = false;
      this.toolbarDragging = false;
    };
    window.addEventListener('mousemove', this.profileDragMoveListener);
    window.addEventListener('mouseup', this.profileDragUpListener);

    // On any window resize, reflow the intensity inset to its (fixed) panel size
    // on the next frame, once layout has settled. Without this the inset can be
    // left at a stale/zero size by a mid-reflow resize and stop showing.
    this.profileResizeListener = () => {
      if (!this.hasProfiles) return;
      requestAnimationFrame(() => this.renderIntensityInset());
    };
    window.addEventListener('resize', this.profileResizeListener);
  }

  /** The plot div exists now: run an image-less draw that arrived before it did. */
  private onViewReady(): void {
    this.viewReady = true;
    const pending = this.pendingSpatialDraw;
    this.pendingSpatialDraw = null;
    // Only if it is still the dataset on offer and no image has arrived meanwhile. By id, not by
    // object: the port may re-emit the same dataset as a new object (a colour-column change does),
    // and then the current object is the one to draw.
    const current = this.spatialDataset;
    if (pending && current && current.id === pending.id && !this.imageInfo) {
      void this.plotSpatialWithoutImage(current);
    }
  }

  onProfilePanelDragStart(e: MouseEvent) {
    this.profilePanelDragging = true;
    this.profilePanelStart = {
      mx: e.clientX,
      my: e.clientY,
      x: this.profilePanelPos.x,
      y: this.profilePanelPos.y,
    };
    e.preventDefault();
  }

  /** Grab the toolbar handle: detach it into a floating window (if still docked)
   *  and start dragging. */
  onToolbarDragStart(e: MouseEvent) {
    if (!this.toolbarFloating) {
      this.toolbarFloating = true;
      this.toolbarPos = { x: 8, y: 8 };
    }
    this.toolbarDragging = true;
    this.toolbarStart = {
      mx: e.clientX,
      my: e.clientY,
      x: this.toolbarPos.x,
      y: this.toolbarPos.y,
    };
    e.preventDefault();
  }

  /** Snap the floating toolbar back to its docked position across the top. */
  dockToolbar() {
    this.toolbarFloating = false;
  }

  /** Render the intensity inset chart from the latest profile data. The actual
   *  charting is owned by the visualizer service — the component just decides
   *  when (profile mode + a fresh profile). */
  private renderIntensityInset(): void {
    if (!this.hasProfiles) return;
    this.plotService.renderIntensityInset(this.intensityInsetDiv, this.latestProfiles);
  }

  /** Toolbar "Intensity" group: add another line ROI (next bright colour). */
  async addProfileLine(): Promise<void> {
    // Park the floating inset near the plot's top-right when the first line is
    // added (it's position:fixed, so use viewport coords from the plot rect).
    if (!this.hasProfiles) {
      const rect = document.getElementById(this.plotDivName)?.getBoundingClientRect();
      this.profilePanelPos = rect
        ? { x: Math.max(10, rect.right - 300), y: rect.top + 10 }
        : { x: 20, y: 70 };
    }
    // Image (OSD) mode: Plotly never rendered, so it has no pixel cache / extent.
    // Load the current slice's frames for sampling + line placement first.
    if (this.isImageView && this.imageInfo) {
      await this.plotService.ensureIntensitySampling(this.imageInfo, this.zIndex);
    }
    const region = this.plotService.getIntensityControls()?.addProfileLine();
    // Auto-select the new line on the active backend (Plotly handles / OSD
    // highlight) so it's ready to move or delete immediately.
    if (region) {
      this.plotService.selectRegion(region);
      // OSD only draws a selected region's handles in an edit mode, so a line in
      // 'none' mode looks unselected. Switch to 'select' so the new line shows
      // its endpoint handles and can be dragged/deleted right away.
      if (this.isImageView && this.activeDragMode !== 'select') {
        this.toggleDragMode('select');
      }
    }
  }

  ngOnDestroy() {
    // A contributed mode's session ends first, while the viewer it drew over
    // still exists. The panel goes with this view, so no change detection.
    this.destroying = true;
    this.plotModes.deactivate();
    this.toolDialogs.deactivate();
    // Leave the live set so the next-oldest visualizer picks up the outlets.
    VisualizerComponent.liveInstances.delete(this);
    this.state.setDiagram(null);
    this.renderAbort?.abort();
    this.revokeVolumeImageUrls();
    this.scrubber.cancel();
    this.unsub.next();
    this.unsub.complete();
    if (this.plotContextMenuListener) {
      window.removeEventListener('contextmenu', this.plotContextMenuListener, true);
    }
    if (this.keydownListener) {
      window.removeEventListener('keydown', this.keydownListener);
    }
    if (this.wheelListener) {
      window.removeEventListener('wheel', this.wheelListener, true);
    }
    if (this.profileDragMoveListener) {
      window.removeEventListener('mousemove', this.profileDragMoveListener);
    }
    if (this.profileDragUpListener) {
      window.removeEventListener('mouseup', this.profileDragUpListener);
    }
    if (this.profileResizeListener) {
      window.removeEventListener('resize', this.profileResizeListener);
    }
    this.plotService.unsubscribe();
  }

  /** What the host gets through `setDiagram` — see {@link VisualizerHandle}. */
  private readonly hostHandle: VisualizerHandle = {
    visualizer: this.plotService,
    plotService: this.plotService,
    hasRegions: () => this.hasRegions(),
    getRegionPolygons: () => this.getRegionPolygons(),
  };

  public hasRegions(): boolean {
    // Use the contract's framework-neutral region accessor, not the raw
    // Plotly-shaped getShapes() — the component only needs to know whether any
    // region exists, and must not depend on a backend's wire format.
    return this.plotService.getRegions().length > 0;
  }

  /** The current regions as polygons (also on the host handle). */
  public getRegionPolygons(): Polygon[] {
    return this.plotService.getRegionPolygons();
  }

  /** Open the Channels & Histogram dialog (toolbar button). */
  openChannelHistogram() {
    this.showChannelHistogram = true;
  }

  /** Toolbar → open the spatial-omics controls. */
  openSpatialControls(): void {
    this.showSpatialControls = true;
  }

  /** Open the Region Editor dialog (toolbar button). The editor stays linked to
   *  this plotting instance through the root RegionStore singleton, so it works
   *  the same as the former right-panel Regions tab. */
  openRegionEditor() {
    // Size the dialog to match the host's configured element (e.g. the app's
    // right panel) at open time. Measured once — it intentionally does not
    // track later browser/split resizes. Falls back to a quarter of the page
    // when no selector is configured or the element isn't present.
    const selector = this.vizConfig?.regionEditorWidthSelector;
    const width = selector
      ? document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width
      : undefined;
    this.regionEditorWidth = width && width > 0 ? `${Math.round(width)}px` : '25vw';
    this.showRegionEditor = true;
  }

  /** The toolbar's Single image / Stack toggle. */
  selectStackOption(selectedStackOption: { name: string; val: string }) {
    const showstack = selectedStackOption.val === 'true';
    this.stackLoading = showstack;
    this.state.setImageLoading(!showstack);
    // Stack mode is always a 2D heatmap — reset surface mode if active
    if (!this.isHeatmap) {
      this.isHeatmap = true;
      this.plotType = PlotType.HEATMAP;
      this.selectedPlotTypeId = PlotType.HEATMAP;
      this.plotService.setPlotType(this.plotType);
    }
    this.plotService.setShowStack(showstack);
  }

  /** Clamp the slice index into [0, maxIndex] and push it to the renderer. */
  updateZIndex() {
    if (this.zIndex > this.maxIndex) {
      this.zIndex = this.maxIndex;
    }
    if (this.zIndex < 0) {
      this.zIndex = 0;
    }
    this.plotService.setZIndex(this.zIndex);
  }

  /**
   * Live z-slice scrub for the Image view: the renderer swaps the displayed
   * slice in place (no re-mount), so dragging the slider steps through the
   * stack the same way the heatmap frame slider does.
   */
  onZSlide(z: number | undefined) {
    if (z === undefined) return;
    this.zIndex = z;
    this.scrubber.commit(z);
    // Keep the intensity inset in sync with the displayed slice (Image/OSD mode,
    // where the profile sampler is fed from the loaded preview frames).
    if (this.hasProfiles && this.isImageView && this.imageInfo) {
      this.plotService.ensureIntensitySampling(this.imageInfo, z);
    }
  }

  /**
   * Live (debounced) scrub while dragging the Image-view z-slider: update the
   * slice as the user drags, but coalesce rapid changes so we don't fire a
   * slice swap on every pixel. The final value also lands via onZSlide (onSlideEnd).
   */
  onZScrub(z: number | undefined) {
    if (z === undefined) return;
    this.zIndex = z;
    this.scrubber.scrub(z);
  }

  /**
   * Keyboard stack navigation: ←/→ step the z-slice in the Image view, the same
   * way the slider does. Only active for a loaded stack in Image view, and
   * ignored while a form field is focused so typing isn't hijacked. Up/Down are
   * left to OpenSeadragon (panning).
   */
  private isSliceStepKey(e: KeyboardEvent): boolean {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
    if (!this.imageInfo?.isStack || !this.isImageView) return false;
    const t = e.target as HTMLElement | null;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return false;
    // The slice slider handles arrows natively when focused (also a +1 step) —
    // skip here so we don't double-step it.
    if (t && (t.getAttribute('role') === 'slider' || t.closest('.p-slider'))) return false;
    return true;
  }

  /** Move the displayed slice by `delta`, clamped to the stack bounds. */
  stepSlice(delta: number): void {
    const next = Math.min(this.maxIndex, Math.max(0, this.zIndex + delta));
    if (next === this.zIndex) return;
    this.onZSlide(next);
  }

  reloadAndPlot() {
    this.state.setImageLoading(true);
    // Re-drive the render pipeline from the current image info (the source of
    // truth, with real urls/fileName). Don't use plotService.reloadAndPlot():
    // that rebuilds the info from the renderer's internal state, which can be
    // stale (e.g. after switching plot type Image -> Heatmap) and re-emit
    // empty/old urls, failing to hand the div over to the new renderer.
    if (this.imageInfo) {
      this.state.setImageInfo(this.imageInfo);
    } else if (this.spatialDataset && (isSpatialOmics(this.plotType) || isSpatialOmics3d(this.plotType))) {
      // A spatial dataset that brings no image, opened with no image loaded (a host's
      // first view): there is no image info to re-drive, so draw the spatial mode itself.
      void this.plotSpatialWithoutImage(this.spatialDataset);
    } else {
      this.plotService.reloadAndPlot();
    }
  }

  /**
   * Draw a spatial mode with no image behind it: the observations alone, framed on their own
   * extent, as the seqFISH example shows them. The image info is a placeholder naming the
   * dataset, so regions drawn here are kept per dataset like any image's.
   */
  private async plotSpatialWithoutImage(dataset: SpatialDataset): Promise<void> {
    if (!this.viewReady) {
      // A host that creates the visualizer AFTER publishing the dataset (jit-ui opening a file
      // from its tree) has it replayed into ngOnInit, before the template and its plot div
      // exist; drawing now finds no target. Draw once the view is ready (onViewReady).
      this.pendingSpatialDraw = dataset;
      return;
    }
    // The same generation as the image pipeline: a newer image or dataset supersedes this
    // draw, and a superseded draw neither reports nor releases the newer one's loading state.
    const token = ++this.renderToken;
    this.restartRenderAbort();
    const div = document.getElementById(this.plotDivName);
    const info: IImageInfo = {
      isGrayscale: false, trueImageSize: [0, 0], urls: [], isStack: false, showStack: false,
      scaleRatio: true, fileName: `spatial:${dataset.id}`, imageMeta: [],
    };
    let failure: unknown = null;
    try {
      // A backend that cannot draw (no WebGPU, no plot target) resolves false rather than throwing.
      if (!(await this.plotService.plot(this.plotDivName, null, info, div?.offsetHeight || 500, this.plotType))) {
        failure = 'the renderer could not start';
      }
    } catch (err) {
      failure = err;
    }
    if (token !== this.renderToken) return;
    if (failure) {
      console.warn('[visualizer] could not draw the spatial dataset', failure);
      const e = failure as { message?: string };
      this.messageService.add({
        key: this.vizAlertToastKey,
        severity: 'error',
        summary: 'Could not draw the dataset',
        // An image-less dataset has no tissue image to fall back on, so say so rather than
        // leave an empty canvas that looks finished.
        detail: `${dataset.name ?? dataset.id}: ${e?.message ?? String(failure)}.`,
      });
    }
    this.state.setImageLoading(false);
    this.cdr.detectChanges();
  }

  /** Abort the previous render's loads and arm a fresh signal for the next one. */
  private restartRenderAbort(): AbortSignal {
    this.renderAbort?.abort();
    this.renderAbort = new AbortController();
    return this.renderAbort.signal;
  }

  cancelLoading() {
    // Stop any in-flight frame streaming (napari-js volume/surface preload) so the fetch loops
    // actually abort — clearing the flag alone only routed to Plotly and left napari fetching.
    this.plotService.cancelLoading?.();
    this.renderAbort?.abort();
    this.stackLoading = false;
    this.imgLoading = false;
    this.state.setImageLoading(false);
    this.zIndex = 0;
    this.plotService.setZIndex(this.zIndex);
    this.running = false;
    this.plotService.setStackLoading(false);
  }

  downloadImage() {
    this.plotService.downloadImage();
  }

  autoscaleImage() {
    this.plotService.autoscale();
  }

  /** Toolbar pixel/smooth toggle: flip smoothing and apply to the active backend. */
  onToggleImageSmoothing(): void {
    this.imageSmoothingEnabled = !this.imageSmoothingEnabled;
    this.plotService.setImageSmoothingEnabled(this.imageSmoothingEnabled);
  }

  resetAxes() {
    this.plotService.resetAxes();
  }

  toggleDragMode(mode: string) {
    // A tool picked by the user is always the plain tool, never a plot mode's
    // brush class.
    this.brushClass = null;
    // Toggle off if the same mode is re-selected.
    this.applyDragMode(this.activeDragMode === mode ? null : mode);
  }

  /** Arm `mode` (or nothing) across every tool, keeping the toolbar in step. */
  private applyDragMode(mode: string | null) {
    this.activeDragMode = mode;
    const active = this.activeDragMode;
    // Record the armed tool in the shared session store.
    this.session.setActiveTool(active);

    // Region draw/select run through the renderer's region overlay.
    this.plotService
      .getRegionOverlay()
      ?.setMode(this.isRegionMode(active) ? (active as RegionToolMode) : 'none');

    // Viewport drag modes (pan/box-zoom). Region modes own the drag mode via
    // the overlay, so don't also set one here.
    if (!this.isRegionMode(active)) {
      const viewportDrag = active === 'pan' || active === 'zoom';
      this.plotService.setDragMode(viewportDrag ? active : false);
    }

    // On-canvas tool overlays.
    this.plotService.setZoomToBoxMode(active === 'zoomToBox');
    this.plotService.setWandMode(active === 'wand', { sensitivity: this.wandSensitivity });
    this.plotService.setBrushMode(active === 'brush', { size: this.brushSize, ...this.brushClass });
    this.plotService.setSamPointMode(active === 'samPoint');
    // Leaving point mode dismisses any lingering status toast.
    if (active !== 'samPoint') this.hideSamToast();
    this.plotService.setVertexEraserMode(active === 'eraseVertex');
    if (active === 'eraseVertex') {
      this.plotService.setVertexEraserRadius(this.vertexEraserRadius);
    }
  }

  /** Region draw/select/edit modes routed through the region overlay. The
   *  The vertex tools (drawpolygon/addpoint/deletepoint/move) are
   *  handled by the OpenSeadragon overlay; Plotly's overlay maps them to no-op. */
  private isRegionMode(mode: string | null): boolean {
    return (
      mode === 'drawrect' ||
      mode === 'drawclosedpath' ||
      mode === 'drawopenpath' ||
      mode === 'select' ||
      mode === 'drawpolygon' ||
      mode === 'addpoint' ||
      mode === 'deletepoint' ||
      mode === 'move'
    );
  }

  /** Live-update the isosurface as the range slider moves. The control is only
   *  available when the active backend renders isosurfaces (ISOSURFACE mode). */
  onIsoRangeChange(values: number[] | undefined) {
    if (!values || values.length < 2) return;
    this.isoRange = values;
    this.plotService.getIsosurfaceControls()?.setIsoRange(values[0], values[1]);
  }

  onWandSensitivityChange(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return;
    this.wandSensitivity = value;
    this.plotService.setWandOptions({ sensitivity: value });
  }

  onBrushSizeChange(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return;
    this.brushSize = value;
    this.plotService.setBrushOptions({ size: value });
  }

  onVertexEraserRadiusChange(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) return;
    this.vertexEraserRadius = value;
    this.plotService.setVertexEraserRadius(value);
  }

  zoomIn() {
    this.plotService.zoomIn();
  }

  zoomOut() {
    this.plotService.zoomOut();
  }

  deleteRegion() {
    this.plotService.deleteActiveShape();
  }

  /** Undo the most recent region action (jit-ui#85). Up to 10 steps back. */
  undoRegion() {
    this.plotService.undo();
  }

  /** Redo the most recently undone region action (jit-ui#85). */
  redoRegion() {
    this.plotService.redo();
  }

  // ── Region set-operations on the current selection (jit-ui#85) ──────────

  /** The currently-selected regions (live store instances). */
  private get selectedRegions(): Region[] {
    const all = this.plotService.getRegions();
    return this.selectedIndices
      .map((i) => all[i])
      .filter((r): r is Region => !!r);
  }

  /** Regions eligible for set-ops: closed areas (rect / closed polygon /
   *  multi-polygon), excluding intensity-profile lines. */
  private opEligible(regions: Region[]): Region[] {
    return regions.filter((r) => r.kind !== 'profile' && (
      r.bounds instanceof Rectangle ||
      r.bounds instanceof MultiPolygon ||
      (r.bounds instanceof Polygon && r.bounds.closed !== false)
    ));
  }

  /** Image pixel dimensions for the raster ops; falls back to the selection's
   *  extent when the image size isn't known (keeps clamping sane). */
  private opImageDims(regions: Region[]): { w: number; h: number } {
    let [w, h] = this.imageInfo?.trueImageSize ?? [0, 0];
    if (!(w > 0) || !(h > 0)) {
      let maxX = 0, maxY = 0;
      const scan = (xs: number[], ys: number[]) => {
        for (const x of xs) maxX = Math.max(maxX, x);
        for (const y of ys) maxY = Math.max(maxY, y);
      };
      for (const r of regions) {
        const b = r.bounds;
        if (b instanceof Rectangle) scan([b.x + b.width], [b.y + b.height]);
        else if (b instanceof Polygon) scan(b.xpoints, b.ypoints);
        else if (b instanceof MultiPolygon) for (const p of b.polygons) scan(p.xpoints, p.ypoints);
      }
      w = Math.max(w, Math.ceil(maxX) + 2);
      h = Math.max(h, Math.ceil(maxY) + 2);
    }
    return { w, h };
  }

  /** Select every region on the image (excludes intensity-profile lines). */
  selectAllRegions(): void {
    const all = this.plotService.getRegions();
    const indices: number[] = [];
    all.forEach((r, i) => { if (r.kind !== 'profile') indices.push(i); });
    this.plotService.setSelectedShapeIndices(indices);
  }

  /** Merge the selected regions into a single (possibly multi-part) region. */
  mergeRegions(): void {
    const sel = this.opEligible(this.selectedRegions);
    if (sel.length < 2) return;
    const { w, h } = this.opImageDims(sel);
    const merged = this.regionOps.merge(sel, w, h);
    if (merged) this.replaceRegions(sel, [merged]);
  }

  /** Split each selected multi-part region into one region per part. */
  ungroupRegions(): void {
    const sel = this.selectedRegions.filter((r) => this.regionOps.canUngroup(r));
    if (sel.length === 0) return;
    const results: Region[] = [];
    for (const r of sel) results.push(...this.regionOps.ungroup(r));
    this.replaceRegions(sel, results);
  }

  /** Replace the selection with its inverse inside the image rectangle. */
  inverseRegions(): void {
    const sel = this.opEligible(this.selectedRegions);
    if (sel.length === 0) return;
    const { w, h } = this.opImageDims(sel);
    const inv = this.regionOps.inverse(sel, w, h);
    if (!inv) {
      this.messageService.add({
        key: this.resultToastKey,
        severity: 'warn', summary: 'Inverse',
        detail: 'Nothing to invert — select one or more closed regions first.',
      });
      return;
    }
    this.replaceRegions(sel, [inv]);
  }

  /** Douglas–Peucker simplify each selected region by `thresholdPx`. */
  simplifyRegions(thresholdPx: number): void {
    const sel = this.opEligible(this.selectedRegions);
    if (sel.length === 0) return;
    this.replaceRegions(sel, sel.map((r) => this.regionOps.simplify(r, thresholdPx)));
    this.displaySimplifyDialog = false;
  }

  /** Open the custom-threshold simplify dialog. */
  openSimplifyDialog(): void { this.displaySimplifyDialog = true; }

  /**
   * Commit a set-op: drop the `remove` regions, append `add`, and select the
   * results. Goes through setRegions so it's undo-tracked and re-rendered;
   * profile lines and unselected regions are preserved.
   */
  private replaceRegions(remove: Region[], add: Region[]): void {
    if (add.length === 0) return;
    const removeSet = new Set(remove);
    const kept = this.plotService.getRegions().filter((r) => !removeSet.has(r));
    this.plotService.setRegions([...kept, ...add]); // mints ids on `add`, records undo
    const stored = this.plotService.getRegions();
    const sel = add.map((r) => stored.indexOf(r)).filter((i) => i >= 0);
    this.plotService.setSelectedShapeIndices(sel);
  }

  /** Box-prompted SAM segmentation of the drawn rectangles (jit-ui#90). A sticky
   *  `sam` toast shows live status + a download progress bar (first run pulls the
   *  encoder, ~170 MB); it stays open until the run finishes (bar hits 100%). */
  async segmentRegions() {
    await this.runSegmentWithToast('SAM', this.samTool, () => this.plotService.segmentRectangles());
  }

  /** Auto-segment cells inside each drawn rectangle with cellpose-SAM, client-side
   *  (jit-ui#90). Each box is cropped (browser slide-crop) then run through the
   *  cellpose-js model; the same sticky `sam` toast + progress bar is reused. */
  async segmentCellpose() {
    await this.runSegmentWithToast('Cellpose', this.cellSegmentTool, () =>
      this.plotService.segmentRectanglesCellpose(),
    );
  }

  /**
   * Parameters currently bound by the generic parameter dialog, for whichever
   * tool is open. Seeded lazily: a tool's defaults are only asked for when the
   * user first touches it, so registering a tool costs nothing until used.
   */
  paramsFor(toolId: string): Record<string, unknown> {
    const tool = this.contributedTools.find((t) => t.id === toolId);
    if (!tool) return {};
    if (!this.toolParams[toolId]) {
      // Through `seedParams`, not `defaultParams` directly: the active
      // checkpoint's own `ToolModelOption.defaults` have to be merged on top.
      // Calling `defaultParams` here bypassed them, so the very first run of a
      // tool used the tool's baseline thresholds and tiling rather than the
      // model's — and it only corrected itself once the user switched
      // checkpoints or hit Reset. Every entry point now goes through one path.
      this.toolParams[toolId] = this.seedParams(tool, this.modelIdFor(tool));
    }
    return this.toolParams[toolId]!;
  }

  /** Active checkpoint for a tool, falling back to the tool's own default. */
  modelIdFor(tool: ToolbarToolContribution): string {
    return this.toolModelIds[tool.id] ?? tool.defaultModelId();
  }

  /** Switching checkpoint re-seeds the parameters, since the defaults belong to
   *  the model rather than to the tool. */
  onToolModelChange(e: { toolId: string; modelId: string }): void {
    const tool = this.contributedTools.find((t) => t.id === e.toolId);
    if (!tool) return;
    // Reassigned rather than mutated so the toolbar's ngOnChanges sees a new
    // reference and rebuilds that tool's model menu with the check mark moved.
    this.toolModelIds = { ...this.toolModelIds, [e.toolId]: e.modelId };
    tool.onModelChange?.(e.modelId);
    this.toolParams[e.toolId] = this.seedParams(tool, e.modelId);
    this.rebindOpenParams(e.toolId);
  }

  /** A tool's defaults for a checkpoint, with that checkpoint's own overrides
   *  applied on top — per-model defaults beat per-tool ones. */
  private seedParams(tool: ToolbarToolContribution, modelId: string): Record<string, unknown> {
    const model = tool.models().find((m) => m.id === modelId);
    return { ...tool.defaultParams(modelId), ...(model?.defaults ?? {}) };
  }

  openToolParams(toolId: string): void {
    const tool = this.contributedTools.find((t) => t.id === toolId);
    if (!tool) return;
    this.openParams = {
      tool,
      values: this.paramsFor(toolId), // seeds them on first use
      fields: tool.params.map((spec) => ({
        spec,
        number: spec.type === 'number' ? spec : null,
        select: spec.type === 'select' ? spec : null,
      })),
    };
  }

  closeToolParams(): void {
    this.openParams = null;
  }

  /** A tool's values object was replaced (reset / checkpoint switch): point an
   *  open dialog for it at the new one. */
  private rebindOpenParams(toolId: string): void {
    if (this.openParams?.tool.id === toolId) {
      this.openParams = { ...this.openParams, values: this.paramsFor(toolId) };
    }
  }

  resetToolParams(toolId: string): void {
    const tool = this.contributedTools.find((t) => t.id === toolId);
    if (!tool) return;
    this.toolParams[toolId] = this.seedParams(tool, this.modelIdFor(tool));
    this.rebindOpenParams(toolId);
  }

  /** Run a contributed tool over the current view. No prompt: these sweep the
   *  whole view rather than being pointed at something. Reuses the shared
   *  segmentation toast so progress reads the same as the SAM/cellpose tools. */
  async runTool(toolId: string): Promise<void> {
    const tool = this.contributedTools.find((t) => t.id === toolId);
    if (!tool) return;
    const params = { ...this.paramsFor(toolId), modelId: this.modelIdFor(tool) };
    await this.runSegmentWithToast(tool.label, tool.progress, () =>
      tool.run(this.plotService, params),
    );
  }

  /** Shared driver for the box-prompt segment tools: wires the tool's status +
   *  download progress into the sticky `sam` toast, runs `op`, and reports the
   *  region count. Keeps the toast open until the run settles (bar hits 100%). */
  private async runSegmentWithToast(
    label: string,
    // Observables rather than BehaviorSubjects: a contributed tool implements
    // ToolProgress, and requiring a concrete subject would force every plugin
    // to expose its internals just to drive this toast.
    tool: { status$: Observable<string>; progress$: Observable<number> },
    op: () => Promise<number>,
  ) {
    this.samStatus = 'Starting…';
    this.samProgress = 0;
    this.samDownloading = false;
    this.samBusy = true;
    const psub = tool.progress$.subscribe((f) => {
      this.samDownloading = f >= 0 && f < 1;
      if (f >= 0) this.samProgress = Math.min(100, Math.round(f * 100));
      this.cdr.detectChanges();
    });
    // Tracked here rather than read off the subject at the end: `tool` is only
    // an Observable pair now, so there is no `.value` to sample once the run
    // settles. The last non-empty status is what the result toast reports.
    let lastStatus = '';
    const ssub = tool.status$.subscribe((m) => {
      if (m) {
        lastStatus = m;
        this.samStatus = m;
        this.cdr.detectChanges();
      }
    });
    this.showSamToast(label);
    try {
      const n = await op();
      this.messageService.add({
        key: this.resultToastKey,
        severity: n > 0 ? 'success' : 'warn',
        summary: label,
        detail: lastStatus || (n > 0 ? `Added ${n} region(s).` : 'No regions added.'),
      });
    } catch (e) {
      this.messageService.add({
        key: this.resultToastKey,
        severity: 'error', summary: `${label} failed`, detail: String(e),
      });
    } finally {
      psub.unsubscribe();
      ssub.unsubscribe();
      this.hideSamToast();
    }
  }

  /** Show the shared sticky `sam` toast once (idempotent — re-adding would stack
   *  a new toast on every point click). */
  private showSamToast(summary: string): void {
    if (this.samToastShown) return;
    this.samToastShown = true;
    this.messageService.add({ key: this.samToastKey, sticky: true, severity: 'info', summary });
  }

  /** Dismiss the shared `sam` toast and reset its progress/spinner state. */
  private hideSamToast(): void {
    this.samToastShown = false;
    this.samBusy = false;
    this.samDownloading = false;
    this.samProgress = 0;
    this.messageService.clear(this.samToastKey);
    this.cdr.detectChanges();
  }

  /** Pick the SAM model the segment tools use (jit-ui#90 P1). */
  onSamModelChange(id: string) {
    this.samModelId = id;
    this.plotService.setSamModel(id);
  }

  /** Convert the selected region to a smooth bezier curve. */
  toBezierRegion() {
    this.plotService.getRegionOverlay()?.setSelectedBezier(true);
  }

  /** Convert the selected region back to a straight-edged polygon. */
  toPolygonRegion() {
    this.plotService.getRegionOverlay()?.setSelectedBezier(false);
  }

  /**
   * Immediate region actions on the current selection (jit-ui#85): merge,
   * ungroup, inverse, simplify, the Bézier conversions, and delete — the
   * one-shot geometry transforms, grouped apart from the tool/mode toggles and
   * shown only when something is selected. Each item is gated on what the
   * selection supports.
   */
  private buildRegionActionItems(): MenuItem[] {
    const all = this.plotService.getRegions();
    const selectable = all.filter((r) => r.kind !== 'profile');
    if (selectable.length === 0) return [];
    const items: MenuItem[] = [];

    // Select all — available whenever the image has regions, regardless of the
    // current selection.
    items.push({
      label: 'Select all regions', icon: 'pi pi-check-square',
      command: () => this.selectAllRegions(),
    });

    const selAll = this.selectedRegions;
    if (selAll.length === 0) return items;
    const eligible = this.opEligible(selAll);

    if (eligible.length >= 2) {
      items.push({ label: 'Merge / group', icon: 'pi pi-link', command: () => this.mergeRegions() });
    }
    if (selAll.some((r) => this.regionOps.canUngroup(r))) {
      items.push({ label: 'Ungroup', icon: 'pi pi-sitemap', command: () => this.ungroupRegions() });
    }
    if (eligible.length >= 1) {
      items.push(
        { label: 'Inverse', icon: 'pi pi-clone', command: () => this.inverseRegions() },
        {
          label: 'Simplify', icon: 'pi pi-chart-line',
          items: [
            { label: 'Light (1 px)', command: () => this.simplifyRegions(1) },
            { label: 'Medium (3 px)', command: () => this.simplifyRegions(3) },
            { label: 'Strong (8 px)', command: () => this.simplifyRegions(8) },
            { separator: true },
            { label: 'Custom…', command: () => this.openSimplifyDialog() },
          ],
        },
      );
    }
    // Bézier conversions are vertex-level edits — Image (OpenSeadragon) view
    // only — gated on the selection's current form.
    if (this.basePlotType === PlotType.IMAGE) {
      const hasStraight = selAll.some((r) =>
        (r.bounds instanceof Polygon && !r.bounds.bezier) || r.bounds instanceof Rectangle);
      const hasBezier = selAll.some((r) => r.bounds instanceof Polygon && r.bounds.bezier);
      if (hasStraight) {
        items.push({ label: 'Convert to Bézier', icon: 'to-bezier-icon', command: () => this.toBezierRegion() });
      }
      if (hasBezier) {
        items.push({ label: 'Convert to polygon', icon: 'to-polygon-icon', command: () => this.toPolygonRegion() });
      }
    }
    items.push({ label: 'Delete region', icon: 'pi pi-trash', command: () => this.deleteRegion() });
    return items;
  }

  private buildContextMenuItems(): MenuItem[] {
    const active = this.activeDragMode;
    const activeClass = 'context-menu-active';
    const items: MenuItem[] = [];
    // Selected-region actions lead the menu (separated from the tool toggles).
    if (this.isHeatmap) {
      const actions = this.buildRegionActionItems();
      if (actions.length) items.push(...actions, { separator: true });
    }
    if (this.isHeatmap) {
      items.push(
        { label: 'Autoscale', icon: 'pi pi-window-maximize', command: () => this.autoscaleImage() },
        { separator: true },
      );
      // 'Zoom selection' is Plotly's rubber-band zoom; it doesn't apply to the
      // OpenSeadragon-backed Image view (use 'Zoom to box' there instead).
      if (!this.isImageView) {
        items.push({
          label: 'Zoom selection',
          icon: 'pi pi-search',
          styleClass: active === 'zoom' ? activeClass : '',
          command: () => this.toggleDragMode('zoom'),
        });
      }
      items.push({
        label: 'Zoom to box',
        icon: 'zoom-box-off-icon',
        styleClass: active === 'zoomToBox' ? activeClass : '',
        command: () => this.toggleDragMode('zoomToBox'),
      });
    }
    if (this.isHeatmap) {
      items.push({
        label: 'Pan',
        icon: 'pi pi-arrows-alt',
        styleClass: active === 'pan' ? activeClass : '',
        command: () => this.toggleDragMode('pan'),
      });
    } else {
      const s3d = this.activeSurface3dMode;
      items.push(
        {
          label: 'Zoom',
          icon: 'pi pi-search',
          styleClass: s3d === 'zoom' ? activeClass : '',
          command: () => this.toggleSurface3dMode('zoom'),
        },
        {
          label: 'Pan',
          icon: 'pi pi-arrows-alt',
          styleClass: s3d === 'pan' ? activeClass : '',
          command: () => this.toggleSurface3dMode('pan'),
        },
        {
          label: 'Orbital rotation',
          icon: 'pi pi-globe',
          styleClass: s3d === 'orbit' ? activeClass : '',
          command: () => this.toggleSurface3dMode('orbit'),
        },
        {
          label: 'Turntable rotation',
          icon: 'pi pi-sync',
          styleClass: s3d === 'turntable' ? activeClass : '',
          command: () => this.toggleSurface3dMode('turntable'),
        },
        { separator: true },
        { label: 'Reset camera', icon: 'pi pi-home', command: () => this.resetSurfaceCamera() },
      );
    }
    if (this.isHeatmap) {
      items.push(
        { label: 'Zoom in', icon: 'pi pi-search-plus', command: () => this.zoomIn() },
        { label: 'Zoom out', icon: 'pi pi-search-minus', command: () => this.zoomOut() },
        { separator: true },
        {
          label: 'Select',
          icon: 'pi pi-arrow-up-right',
          styleClass: active === 'select' ? activeClass : '',
          command: () => this.toggleDragMode('select'),
        },
        {
          label: 'Freeform',
          icon: 'pi pi-pencil',
          styleClass: active === 'drawclosedpath' ? activeClass : '',
          command: () => this.toggleDragMode('drawclosedpath'),
        },
        {
          label: 'Brush',
          icon: 'brush-icon',
          styleClass: active === 'brush' ? activeClass : '',
          command: () => this.toggleDragMode('brush'),
        },
        {
          label: 'Polyline',
          icon: 'polyline-icon',
          styleClass: active === 'drawopenpath' ? activeClass : '',
          command: () => this.toggleDragMode('drawopenpath'),
        },
        {
          label: 'Rectangle',
          icon: 'pi pi-stop',
          styleClass: active === 'drawrect' ? activeClass : '',
          command: () => this.toggleDragMode('drawrect'),
        },
        {
          label: 'Wand',
          icon: 'wand-icon',
          styleClass: active === 'wand' ? activeClass : '',
          command: () => this.toggleDragMode('wand'),
        },
        {
          label: 'Vertex eraser',
          icon: 'pi pi-eraser',
          styleClass: active === 'eraseVertex' ? activeClass : '',
          command: () => this.toggleDragMode('eraseVertex'),
        },
      );
      // Vertex editing runs on the OpenSeadragon overlay, which
      // backs the Image plot type. Hidden for other 2D types (Plotly), where
      // these modes are no-ops.
      if (this.basePlotType === PlotType.IMAGE) {
        items.push(
          {
            label: 'Polygon (click vertices)',
            icon: 'polygon-vertices-icon',
            styleClass: active === 'drawpolygon' ? activeClass : '',
            command: () => this.toggleDragMode('drawpolygon'),
          },
          {
            label: 'Add vertex',
            icon: 'vertex-add-icon',
            styleClass: active === 'addpoint' ? activeClass : '',
            command: () => this.toggleDragMode('addpoint'),
          },
          {
            label: 'Delete vertex',
            icon: 'vertex-delete-icon',
            styleClass: active === 'deletepoint' ? activeClass : '',
            command: () => this.toggleDragMode('deletepoint'),
          },
        );
      }
      // Bézier conversions + Delete are immediate selection *actions*, now in the
      // "Selected region(s)" group at the top (see buildRegionActionItems).
    }
    return items;
  }

  toggleSurface3dMode(mode: string) {
    this.activeSurface3dMode = mode;
    this.plotService.setSurfaceDragMode(mode);
  }

  resetSurfaceCamera() {
    this.plotService.resetSurfaceCamera();
  }

  /** Toggle the napari 3D coordinate-axes / scale gizmo (volume/isosurface). No-op on backends
   *  that don't render one (the control method is optional). */
  toggleAxes() {
    this.axesVisible = !this.axesVisible;
    this.plotService.getSurface3dControls()?.setAxesVisible?.(this.axesVisible);
  }

  /** Toggle the napari surface wireframe (edges vs filled). No-op on backends without a surface. */
  toggleWireframe() {
    this.wireframeActive = !this.wireframeActive;
    this.plotService.getSurface3dControls()?.setWireframe?.(this.wireframeActive);
  }

  /** Change the napari 3D decimate factor. Decimation changes the fetched/assembled data, so this
   *  re-plots the current 3D type at the new resolution (unlike axes/wireframe, which are live). */
  selectResolution(scale: number) {
    if (scale === this.resolutionScale) return;
    this.resolutionScale = scale;
    this.plotService.setResolutionScale?.(scale);
    this.reloadAndPlot();
  }

  /**
   * Switch the active plot type (heatmap, surface, contour, scatter, line,
   * scatter3d, isosurface). Keeps `isHeatmap` as the 2D-vs-3D flag the rest of
   * the toolbar/context-menu logic relies on, deactivates 2D-only tools when
   * moving to a 3D type, then re-plots.
   */
  onSelectPlotType(selected: PlotTypeId) {
    // A contributed id whose provider is gone (e.g. restored from a previous
    // session) has nothing to activate — take the default Image view instead.
    if (!isBuiltinPlotType(selected) && !this.plotModes.find(selected)) {
      console.warn(`[visualizer] unknown plot type '${selected}' — showing '${PlotType.IMAGE}' instead.`);
      selected = PlotType.IMAGE;
    }
    // An explicit choice retries a mode whose earlier cleanup failed; only
    // automatic re-activations (re-render, image switch) fall back for that.
    this.plotModes.clearCleanupFailures();
    // Whatever was selected before, a contributed session ends before the next
    // mode draws. (Re-selecting the same contributed mode re-plots, so it gets a
    // fresh session too.)
    this.plotModes.deactivate();
    // Everything below decides how to RENDER, so it works on the built-in type
    // that draws `selected`: a contributed mode behaves exactly like its base.
    const type = this.plotModes.baseTypeOf(selected);
    // A dialog tool draws over the Image view: leaving it closes the dialog. Staying
    // on it, the session ends here and restarts once the re-plot lands.
    if (type === PlotType.IMAGE) this.toolDialogs.deactivate();
    else this.closeDialogTool();
    this.plotType = type;
    this.selectedPlotTypeId = selected;
    const descriptor = isBuiltinPlotType(selected)
      ? this.plotTypeMenu.find((d) => d.type === type)
      : getPlotTypeDescriptor(type);
    const is3d = descriptor?.dimensions === '3d';
    this.isHeatmap = !is3d;
    this.plotService.setPlotType(type);
    // Switching plot type cancels the active tool — not every type supports the
    // same tools (line/scatter charts and 3D scenes have no box zoom or region
    // drawing), so leaving a tool armed would misbehave on the new plot.
    this.deactivateActiveTool();
    if (is3d) {
      this.activeSurface3dMode = 'turntable';
    }
    // napari-js volume/isosurface assemble their own 3D texture from the slice endpoint, so
    // they take the normal re-plot path — NOT Plotly's stack-frame loader (whose "Loading
    // frames" overlay would never clear, since Plotly isn't the active backend) (jit-ui#102).
    const isNapari = type === PlotType.NAPARI_IMAGE || isNapari3d(type);
    if (descriptor?.requiresStack && !isNapari) {
      // Volume types (isosurface, scatter3d) need the whole z-stack loaded as a
      // 3D array, and they always render on Plotly. Drive the stack reload
      // directly through the image-info stream rather than the active renderer's
      // setShowStack: when OpenSeadragon owns the Image view its setShowStack is
      // a no-op, so the reload never fired and the loader spun forever. We arm
      // Plotly's stack-loading flag (keeps its frame-fetch loop alive) and
      // re-emit the image info with showStack on so the pipeline reloads on
      // Plotly regardless of which backend was on screen.
      this.stackLoading = true;
      this.plotService.setStackLoading(true);
      if (this.imageInfo) {
        // A copy: the image info may be the host's own (possibly frozen) object.
        this.state.setImageInfo({ ...this.imageInfo, showStack: true });
      }
      return;
    }
    this.reloadAndPlot();
  }

  // ── contributed plot modes ─────────────────────────────────────────────

  /**
   * Start the selected contributed mode's session, once its base view has
   * plotted. No-op for a built-in type, or when the base on screen is not the
   * one the mode rides on. A backend that cannot provide a viewport for it
   * (e.g. OSD fell back to Plotly) counts as a failed activation.
   */
  private activateSelectedPlotMode(): void {
    const contribution = this.plotModes.find(this.selectedPlotTypeId);
    if (!contribution || this.plotType !== contribution.descriptor.baseType) return;
    const viewport = this.plotService.getPlotModeViewport?.() ?? null;
    if (!viewport) {
      console.error(`[visualizer] plot-type contribution '${contribution.descriptor.type}': the backend `
        + 'on screen provides no viewport to draw over — falling back.');
      this.fallBackFromPlotMode(contribution);
      return;
    }
    const ctx: PlotModeContext = {
      visualizer: this.plotService,
      viewport,
      imageInfo$: this.state.getImageInfo$(),
      tools: this.plotModeTools,
    };
    void this.plotModes.activate(contribution, ctx);
  }

  /** Render the live mode's panel. Activation can resolve outside Angular (an
   *  OSD callback, a contribution's own promise), hence the zone re-entry. */
  private showPlotModePanel(active: ActivePlotMode): void {
    const panel = active.contribution.panel;
    if (!panel) return;
    this.ngZone.run(() => {
      if ('component' in panel && panel.component) {
        this.plotModePanel = {
          title: panel.title,
          component: panel.component,
          injector: Injector.create({
            providers: [
              { provide: PLOT_MODE_CONTEXT, useValue: active.ctx },
              { provide: PLOT_MODE_SESSION, useValue: active.session },
            ],
            parent: this.injector,
          }),
          host: null,
        };
      } else if (active.panelHost) {
        this.plotModePanel = { title: panel.title, component: null, injector: null, host: active.panelHost };
      } else {
        return;
      }
      // A component panel is created and first rendered right here; if that throws,
      // the mode is not usable — end it and fall back rather than leave it selected.
      const err = this.detectChangesSafely();
      if (err !== null) this.plotModes.failActive(err);
    });
  }

  /** Drop the panel (destroying a component panel) before the session ends. */
  private hidePlotModePanel(): void {
    if (!this.plotModePanel) return;
    this.plotModePanel = null;
    this.detectChangesSafely();
  }

  /**
   * A contributed mode could not start. Its base type is already on screen —
   * the base plotted first — so just select it: nothing needs to re-plot.
   */
  private fallBackFromPlotMode(contribution: PlotTypeContribution): void {
    if (this.destroying || this.selectedPlotTypeId !== contribution.descriptor.type) return;
    this.ngZone.run(() => {
      const base = contribution.descriptor.baseType;
      this.selectedPlotTypeId = base;
      this.plotType = base;
      this.messageService.add({
        key: this.resultToastKey,
        severity: 'warn',
        summary: `${contribution.descriptor.productionLabel ?? contribution.descriptor.label} is unavailable`,
        detail: 'The plot mode could not start, so the plain image is shown instead. See the browser console for details.',
      });
      this.detectChangesSafely();
    });
  }

  /** Run change detection; returns what it threw (logged), or null. */
  private detectChangesSafely(): unknown | null {
    if (this.destroying) return null;
    try {
      this.cdr.detectChanges();
      return null;
    } catch (err) {
      console.error('[visualizer] change detection failed while updating a contributed plot mode panel.', err);
      return err ?? new Error('change detection failed');
    }
  }

  // ── dialog tools (TOOLBAR_TOOLS, kind: 'dialog') ─────────────────────────

  /** The toolbar button: open the tool's dialog, or close it if it is open. */
  toggleDialogTool(id: string): void {
    if (this.openDialogToolId === id) {
      this.closeDialogTool();
      return;
    }
    this.closeDialogTool();
    if (!this.dialogTools.some((t) => t.id === id)) return;
    this.openDialogToolId = id;
    this.toolDialogs.clearCleanupFailures(); // an explicit open gets a fresh attempt
    this.activateOpenDialogTool();
  }

  /** Close the open dialog tool: its body is torn down, then its session ends. */
  closeDialogTool(): void {
    this.openDialogToolId = null;
    this.toolDialogs.deactivate();
  }

  /** Start (or restart, after a re-render) the open dialog tool's session. */
  private activateOpenDialogTool(): void {
    const id = this.openDialogToolId;
    const contribution = id ? this.toolDialogs.find(id) : undefined;
    if (!contribution || this.plotType !== PlotType.IMAGE) return;
    if (this.toolDialogs.current?.contribution === contribution || this.toolDialogs.pending) return;
    const viewport = this.plotService.getPlotModeViewport?.() ?? null;
    if (!viewport) {
      console.error(`[visualizer] dialog tool '${id}': the backend on screen provides no viewport to draw over.`);
      this.dialogToolFailed(id!);
      return;
    }
    const ctx: ToolDialogContext = {
      visualizer: this.plotService,
      viewport,
      imageInfo$: this.state.getImageInfo$(),
      tools: this.plotModeTools,
    };
    void this.toolDialogs.activate(contribution, ctx);
  }

  /** The live dialog body's teardown, and a pending wait for its host to connect. */
  private toolDialogTeardown: (() => void) | null = null;
  private toolDialogFrame: number | null = null;

  /**
   * The session is live: render the dialog, then mount the tool's body once the host
   * element is in the document, so `mount()` can measure it and start widgets that need
   * a connected element.
   */
  private showToolDialog(active: ActivePlotMode): void {
    const tool = this.dialogTools.find((t) => t.id === active.contribution.descriptor.type);
    if (!tool) return;
    const host = document.createElement('div');
    host.className = 'tool-dialog-body';
    this.ngZone.run(() => {
      this.toolDialog = {
        title: tool.dialog?.title ?? tool.label,
        width: tool.dialog?.width ?? '22rem',
        host,
      };
      const err = this.detectChangesSafely();
      if (err !== null) {
        this.toolDialogs.failActive(err);
        return;
      }
      this.mountToolDialogBody(tool, active, host, 0);
    });
  }

  /** How many animation frames to wait for the dialog to attach the body's host. */
  private static readonly TOOL_DIALOG_ATTACH_FRAMES = 60;

  /**
   * Mount `tool`'s body into `host` once it is connected (the dialog may attach it a
   * frame later, when it moves itself to `<body>`). If it never connects within
   * {@link TOOL_DIALOG_ATTACH_FRAMES} it is mounted anyway, with a warning, rather than
   * leaving an empty dialog. A throwing `mount()` fails the session like a failed start.
   */
  private mountToolDialogBody(tool: ToolbarDialogToolContribution, active: ActivePlotMode,
                              host: HTMLElement, frames: number): void {
    this.toolDialogFrame = null;
    // The session ended (or was replaced) while waiting: nothing to mount into.
    if (this.toolDialogs.current !== active || this.toolDialog?.host !== host) return;
    if (!host.isConnected) {
      if (frames < VisualizerComponent.TOOL_DIALOG_ATTACH_FRAMES) {
        this.toolDialogFrame = requestAnimationFrame(
          () => this.mountToolDialogBody(tool, active, host, frames + 1));
        return;
      }
      console.warn(`[visualizer] dialog tool '${tool.id}': the dialog body never attached; mounting it detached.`);
    }
    try {
      const teardown = tool.mount(host, active.ctx as ToolDialogContext, active.session);
      this.toolDialogTeardown = typeof teardown === 'function' ? teardown : null;
    } catch (err) {
      console.error(`[visualizer] dialog tool '${tool.id}' mount() threw.`, err);
      this.toolDialogs.failActive(err);
    }
  }

  /** The session is about to end: tear the body down first, then drop the dialog. */
  private hideToolDialog(): void {
    if (this.toolDialogFrame !== null) cancelAnimationFrame(this.toolDialogFrame);
    this.toolDialogFrame = null;
    const teardown = this.toolDialogTeardown;
    this.toolDialogTeardown = null;
    if (teardown) {
      try {
        teardown();
      } catch (err) {
        console.error('[visualizer] dialog tool body teardown threw.', err);
      }
    }
    if (!this.toolDialog) return;
    this.toolDialog.host.remove();
    this.toolDialog = null;
    if (!this.destroying) this.detectChangesSafely();
  }

  /** A dialog tool could not start: close it and say so. */
  private dialogToolFailed(id: string): void {
    if (this.destroying || this.openDialogToolId !== id) return;
    this.ngZone.run(() => {
      this.openDialogToolId = null;
      const tool = this.dialogTools.find((t) => t.id === id);
      this.messageService.add({
        key: this.resultToastKey,
        severity: 'warn',
        summary: `${tool?.label ?? id} is unavailable`,
        detail: 'The tool could not start. See the browser console for details.',
      });
      this.detectChangesSafely();
    });
  }

  /** Where the open dialog tool's host element is attached once its dialog renders. */
  @ViewChild('toolDialogSlot')
  set toolDialogSlot(ref: ElementRef<HTMLElement> | undefined) {
    const host = this.toolDialog?.host;
    if (ref && host && host.parentElement !== ref.nativeElement) ref.nativeElement.appendChild(host);
  }

  /** Toolbar tools for contributed modes. Calls can come from outside Angular, hence the zone. */
  private readonly plotModeTools: PlotModeTools = {
    armBrush: (brushClass?: PlotModeBrushClass) => this.ngZone.run(() => {
      this.brushClass = { label: brushClass?.label, color: brushClass?.color };
      if (this.activeDragMode === 'brush') {
        this.plotService.setBrushOptions({ size: this.brushSize, ...this.brushClass });
      } else {
        this.applyDragMode('brush');
      }
      this.cdr.markForCheck();
    }),
    disarm: () => this.ngZone.run(() => {
      this.brushClass = null;
      if (this.activeDragMode !== null) this.applyDragMode(null);
      this.cdr.markForCheck();
    }),
    activeTool$: this.session.getActiveTool$(),
  };

  /** Deactivate whatever tool is armed and clear every tool mode. */
  private deactivateActiveTool() {
    this.brushClass = null;
    this.activeDragMode = null;
    this.session.setActiveTool(null);
    this.plotService.getRegionOverlay()?.setMode('none');
    this.plotService.setDragMode(false);
    this.plotService.setZoomToBoxMode(false);
    this.plotService.setWandMode(false);
    this.plotService.setBrushMode(false);
    this.plotService.setSamPointMode(false);
    this.plotService.setVertexEraserMode(false);
  }
}

