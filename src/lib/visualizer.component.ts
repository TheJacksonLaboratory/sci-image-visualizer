import {
  AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Inject, Injector, Input, NgZone,
  OnChanges, OnDestroy, OnInit, Optional, Output, SimpleChanges, ViewChild,
} from '@angular/core';

import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { MenuItem, MessageService } from 'primeng/api';
import { ContextMenu } from 'primeng/contextmenu';
import { IImageInfo } from './contracts/image.contract';
import { ImageStatePort, IMAGE_STATE_PORT } from './contracts/ports/image-state.port';
import { Polygon } from './models/region';
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
  PLOT_TYPE_CONTRIBUTIONS, PlotModeBrushClass, PlotModeTools, PlotTypeContribution, PlotTypeOption,
} from './contracts/plot-type-contribution.contract';
import { PlotModeController } from './plot-mode/plot-mode-controller';
import { computePlotTypeMenu, reconcilePlotType } from './plot-mode/plot-type-menu';
import { ToolParamsModel } from './plot-mode/tool-params-model';
import { ContributionHost, PlotModePanelView, ToolDialogView } from './plot-mode/contribution-host';
import { IVisualizer, VISUALIZER, VisualizerHandle } from './contracts/visualizer.contract';
import { CanvasToolOptions } from './contracts/display-types';
import { SAM_MODELS, getDefaultSamModelId, isSamModelReady } from './toolbar/segmentation/sam-model-registry';
import { SamToolService } from './toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from './toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from './toolbar/segmentation/cell-segment-tool.service';
import { SegmentationRunner } from './toolbar/segmentation/segmentation-runner';
import {
  TOOLBAR_TOOLS, ToolbarContribution, ToolbarDialogToolContribution, ToolbarToolContribution,
  visibleToolContributions,
} from './contracts/toolbar-tool.contract';
import { RegionToolMode } from './contracts/region-overlay.contract';
import { ToolbarToolVisibility, ALL_TOOLBAR_TOOLS } from './contracts/toolbar-config';
import { VIZ_CONFIG, VizConfig } from './contracts/viz-config';
import { SPATIAL_DATA_PORT, SpatialDataPort } from './contracts/ports/spatial-data.port';
import { SpatialDataset } from './contracts/spatial-dataset.contract';
import { applyImageRois } from './visualizer/region-load';
import {
  ContextMenuActions, ContextMenuState, buildContextMenu, buildRegionActionItems,
} from './visualizer/visualizer-context-menu';
import { RegionActions } from './visualizer/region-actions';
import { ShortcutHost, ViewerShortcuts } from './visualizer/viewer-shortcuts';
import { FloatingPos } from './visualizer/floating-drag.directive';
import { IntensityInsetComponent } from './intensity-inset/intensity-inset.component';
import { SpatialDatasetBinder } from './visualizer/spatial-dataset-binder';

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

  /** Region set-operations on the selection, and the store mirrors they read (jit-ui#85). */
  readonly regionActions = new RegionActions(
    this.plotService, this.regionOps, () => this.imageInfo?.trueImageSize,
    (m) => this.messageService.add({ key: this.resultToastKey, ...m }),
  );
  /** Custom-threshold Simplify dialog visibility (see {@link RegionActions}). */
  get displaySimplifyDialog(): boolean { return this.regionActions.displaySimplifyDialog; }
  set displaySimplifyDialog(v: boolean) { this.regionActions.displaySimplifyDialog = v; }

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
  /** Checkpoints and parameter values of {@link contributedTools}, and their dialog. */
  readonly toolParams: ToolParamsModel;
  /** Contributed plot modes and dialog tools, and their live sessions. */
  readonly contributions: ContributionHost;
  /** Dialog tools registered through {@link TOOLBAR_TOOLS} (`kind: 'dialog'`). */
  get dialogTools(): ToolbarDialogToolContribution[] { return this.contributions.dialogTools; }
  /** The dialog tool the user has open (its session may be between renders). */
  get openDialogToolId(): string | null { return this.contributions.openDialogToolId; }
  /** The open dialog tool's live dialog, as the template renders it. */
  get toolDialog(): ToolDialogView | null { return this.contributions.toolDialog; }
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
   * the sticky progress toast is cleared in the same tick by its teardown, and
   * the message explaining why never appeared anywhere.
   *
   * Keyed to this component instance so the library renders its own outlet and
   * is not dependent on host markup. Deliberately NOT the sticky toast's key:
   * `SegmentationRunner.hide` clears that key in the `finally`, which would wipe the
   * result the moment it was posted, and the sticky toast's custom template is
   * built for the live status + progress bar.
   */
  readonly resultToastKey = `${this.samToastKey}-result`;
  /** Segmentation runs and their sticky progress toast. */
  readonly segmentation = new SegmentationRunner(
    this.messageService, this.samToastKey, this.resultToastKey, () => this.cdr.detectChanges());
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
  get plotModes(): PlotModeController { return this.contributions.plotModes; }
  /** The live contributed mode's side panel; null while no contributed session is live. */
  get plotModePanel(): PlotModePanelView | null { return this.contributions.plotModePanel; }

  /** Where a `mount` panel's host element is attached once the dialog renders. */
  @ViewChild('plotModePanelSlot')
  set plotModePanelSlot(ref: ElementRef<HTMLElement> | undefined) {
    this.contributions.attachPanelSlot(ref?.nativeElement);
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

  /** Toolbar docking: docked across the top by default; dragging its handle
   *  detaches it into a floating, movable window (frees the top row for the
   *  visualization). */
  toolbarFloating = false;
  toolbarPos = { x: 8, y: 8 };
  /** Where a toolbar-handle drag starts from: grabbing the docked toolbar floats it. */
  readonly toolbarDragOrigin = (): FloatingPos => {
    if (!this.toolbarFloating) {
      this.toolbarFloating = true;
      this.toolbarPos = { x: 8, y: 8 };
    }
    return this.toolbarPos;
  };
  /** The floating intensity-profile inset (always mounted; shows itself while lines exist). */
  @ViewChild(IntensityInsetComponent, { static: true }) inset?: IntensityInsetComponent;

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

  /** The spatial-omics dataset on offer and the gates it puts on the selector. */
  readonly spatial: SpatialDatasetBinder;
  /** Whether a spatial-omics dataset is published on `SPATIAL_DATA_PORT` — gates the
   *  spatial plot types; the toolbar offers the plot modes for an image-less one too. */
  get hasSpatialDataset(): boolean { return this.spatial.hasDataset; }

  /** Keyboard, wheel and context-menu handling; created once the view exists. */
  private shortcuts?: ViewerShortcuts;

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
    // The `<visualizer>` element: keyboard shortcuts are scoped to it (CORE-2).
    @Optional() private hostRef?: ElementRef<HTMLElement>,
  ) {
    this.contributedTools = visibleToolContributions(toolContributions);
    this.toolParams = new ToolParamsModel(this.contributedTools);
    this.contributions = new ContributionHost(plotTypeContributions, toolContributions, {
      visualizer: this.plotService,
      zone: this.ngZone,
      tools: this.plotModeTools,
      injector: this.injector,
      imageInfo$: () => this.state.getImageInfo$(),
      selectedId: () => this.selectedPlotTypeId,
      renderedType: () => this.plotType,
      selectBase: (base) => {
        this.selectedPlotTypeId = base;
        this.plotType = base;
      },
      notify: (m) => this.messageService.add({ key: this.resultToastKey, ...m }),
      detectChanges: () => this.cdr.detectChanges(),
    });
    this.spatial = new SpatialDatasetBinder(this.spatialData, {
      gatesChanged: () => this.computePlotTypeOptions(),
      selectedId: () => this.selectedPlotTypeId,
      basePlotType: () => this.basePlotType,
      hasImage: () => !!this.imageInfo,
      selectPlotType: (type) => this.onSelectPlotType(type),
      replot: () => this.reloadAndPlot(),
      publishImage: (info) => this.state.setImageInfo(info),
      setImageLoading: (loading) => this.state.setImageLoading(loading),
      settled: () => {
        this.reconcileSelectedPlotType();
        this.cdr.detectChanges();
      },
      detectChanges: () => this.cdr.detectChanges(),
    });
    this.computePlotTypeOptions();
  }

  /** Follow the spatial-omics dataset: a dataset appearing, switching or being cleared
   *  re-gates the selector exactly as the image stream and the test-mode toggle do. */
  private watchSpatialDataset(): void {
    this.spatial.bind(this.unsub);
  }

  /** Recompute the selector's entries for the current image, dataset and test mode
   *  (see {@link computePlotTypeMenu}). */
  private computePlotTypeOptions() {
    const { builtIn, menu } = computePlotTypeMenu({
      descriptors: this.plotService.getPlotTypeDescriptors(),
      contributions: this.plotModes.descriptors(),
      caps: this.plotService.capabilities,
      imageInfo: this.imageInfo,
      spatial: this.spatial,
      testMode: this.testMode,
    });
    this.plotTypeOptions = builtIn;
    this.plotTypeMenu = menu;
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
    this.contributions.endSessions();
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
    const fallback = reconcilePlotType(this.plotTypeMenu, this.selectedPlotTypeId);
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
    this.regionActions.bind(this.unsub, () => this.cdr.detectChanges());
    this.segmentation.bindPointTool(this.samPointTool, this.unsub);
    this.plotService.getStackLoadingProgress().pipe(takeUntil(this.unsub)).subscribe((loadingProgress) => {
      this.loadingPercentage = loadingProgress;
    });
    this.plotService.isStackLoading().pipe(takeUntil(this.unsub)).subscribe((stackLoading) => {
      this.stackLoading = stackLoading;
    });
    this.state.getPanelWidth$().pipe(takeUntil(this.unsub)).subscribe(() => {
      this.plotService.relayout();
      // The intensity inset is a separate chart in a floating panel; reflow it too.
      this.inset?.reflow();
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
            this.contributions.endSessions();
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

            const applyRoi = () => applyImageRois(imgInfo, this.plotService, this.zIndex);
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
                this.contributions.activate();
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
                this.contributions.activate();
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
    this.shortcuts = new ViewerShortcuts(this.shortcutHost(), this.ngZone);
    this.shortcuts.attach();
    this.onViewReady();
  }

  /** The plot div exists now: run an image-less draw that arrived before it did. */
  private onViewReady(): void {
    this.viewReady = true;
    const pending = this.pendingSpatialDraw;
    this.pendingSpatialDraw = null;
    // Only if it is still the dataset on offer and no image has arrived meanwhile. By id, not by
    // object: the port may re-emit the same dataset as a new object (a colour-column change does),
    // and then the current object is the one to draw.
    const current = this.spatial.dataset;
    if (pending && current && current.id === pending.id && !this.imageInfo) {
      void this.plotSpatialWithoutImage(current);
    }
  }

  /** What the keyboard, wheel and context-menu shortcuts act on. */
  private shortcutHost(): ShortcutHost {
    return {
      plotDivName: this.plotDivName,
      hostElement: this.hostRef?.nativeElement ?? null,
      activeDragMode: () => this.activeDragMode,
      canStepSlice: () => !!this.imageInfo?.isStack && this.isImageView,
      wheelZooms: () => !rendererOwnsWheel(this.basePlotType) && this.isHeatmap,
      stepSlice: (delta) => this.stepSlice(delta),
      resolveSamPrompt: (commit) => {
        if (commit) this.plotService.commitSamPoints();
        else this.plotService.clearSamPoints();
        this.segmentation.hide(); // prompt resolved → dismiss the status toast
      },
      undo: () => this.undoRegion(),
      redo: () => this.redoRegion(),
      deleteRegion: () => this.deleteRegion(),
      zoomIn: () => this.zoomIn(),
      zoomOut: () => this.zoomOut(),
      toggleDragMode: (mode) => this.toggleDragMode(mode),
      openContextMenu: (event) => {
        this.contextMenuItems = this.buildContextMenuItems();
        this.cdr.detectChanges();
        this.contextMenu.show(event);
      },
    };
  }

  /** Snap the floating toolbar back to its docked position across the top. */
  dockToolbar() {
    this.toolbarFloating = false;
  }

  /** Toolbar "Intensity" group: add another line ROI (next bright colour). */
  async addProfileLine(): Promise<void> {
    const region = await this.inset?.addProfileLine();
    // OSD only draws a selected region's handles in an edit mode, so a line in
    // 'none' mode looks unselected. Switch to 'select' so the new line shows its
    // endpoint handles and can be dragged/deleted right away.
    if (region && this.isImageView && this.activeDragMode !== 'select') this.toggleDragMode('select');
  }

  ngOnDestroy() {
    // A contributed mode's session ends first, while the viewer it drew over
    // still exists. The panel goes with this view, so no change detection.
    this.contributions.destroy();
    // Leave the live set so the next-oldest visualizer picks up the outlets.
    VisualizerComponent.liveInstances.delete(this);
    this.state.setDiagram(null);
    this.renderAbort?.abort();
    this.spatial.dispose();
    this.scrubber.cancel();
    this.unsub.next();
    this.unsub.complete();
    this.shortcuts?.detach();
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
    // The contract's framework-neutral region accessor: the component only needs to
    // know whether any region exists, never a backend's wire format.
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
    // Keep the intensity inset sampling the displayed slice (Image view).
    this.inset?.sliceCommitted(z);
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
    } else if (this.spatial.dataset && (isSpatialOmics(this.plotType) || isSpatialOmics3d(this.plotType))) {
      // A spatial dataset that brings no image, opened with no image loaded (a host's
      // first view): there is no image info to re-drive, so draw the spatial mode itself.
      void this.plotSpatialWithoutImage(this.spatial.dataset);
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

    // On-canvas tool overlays: arm the one this mode names (none for a region or
    // viewport mode), disarming whichever was armed.
    this.plotService.setActiveTool(active, this.canvasToolOptions(active));
    // Leaving point mode dismisses any lingering status toast.
    if (active !== 'samPoint') this.segmentation.hide();
  }

  /** The options a canvas tool is armed with, from the toolbar's settings. */
  private canvasToolOptions(mode: string | null): CanvasToolOptions | undefined {
    switch (mode) {
      case 'wand': return { sensitivity: this.wandSensitivity };
      case 'brush': return { size: this.brushSize, ...this.brushClass };
      case 'eraseVertex': return { radius: this.vertexEraserRadius };
      default: return undefined;
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
  selectAllRegions(): void { this.regionActions.selectAll(); }
  mergeRegions(): void { this.regionActions.merge(); }
  ungroupRegions(): void { this.regionActions.ungroup(); }
  inverseRegions(): void { this.regionActions.inverse(); }
  simplifyRegions(thresholdPx: number): void { this.regionActions.simplify(thresholdPx); }
  openSimplifyDialog(): void { this.regionActions.openSimplifyDialog(); }

  /** Box-prompted SAM segmentation of the drawn rectangles (jit-ui#90). A sticky
   *  `sam` toast shows live status + a download progress bar (first run pulls the
   *  encoder, ~170 MB); it stays open until the run finishes (bar hits 100%). */
  async segmentRegions() {
    await this.segmentation.run('SAM', this.samTool, () => this.plotService.segmentRectangles());
  }

  /** Auto-segment cells inside each drawn rectangle with cellpose-SAM, client-side
   *  (jit-ui#90). Each box is cropped (browser slide-crop) then run through the
   *  cellpose-js model; the same sticky `sam` toast + progress bar is reused. */
  async segmentCellpose() {
    await this.segmentation.run('Cellpose', this.cellSegmentTool, () =>
      this.plotService.segmentRectanglesCellpose(),
    );
  }

  // ── contributed tool parameters (see ToolParamsModel) ─────────────────
  paramsFor(toolId: string): Record<string, unknown> { return this.toolParams.paramsFor(toolId); }
  onToolModelChange(e: { toolId: string; modelId: string }): void {
    this.toolParams.setModel(e.toolId, e.modelId);
  }
  openToolParams(toolId: string): void { this.toolParams.open(toolId); }
  closeToolParams(): void { this.toolParams.close(); }
  resetToolParams(toolId: string): void { this.toolParams.reset(toolId); }

  /** Run a contributed tool over the current view. No prompt: these sweep the
   *  whole view rather than being pointed at something. Reuses the shared
   *  segmentation toast so progress reads the same as the SAM/cellpose tools. */
  async runTool(toolId: string): Promise<void> {
    const tool = this.toolParams.find(toolId);
    if (!tool) return;
    const params = this.toolParams.runParams(tool);
    await this.segmentation.run(tool.label, tool.progress, () => tool.run(this.plotService, params));
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

  /** The right-click menu for the current view, armed mode and selection. */
  private buildContextMenuItems(): MenuItem[] {
    return buildContextMenu(this.contextMenuState(), this.contextMenuActions);
  }

  private buildRegionActionItems(): MenuItem[] {
    return buildRegionActionItems(this.contextMenuState(), this.contextMenuActions);
  }

  private contextMenuState(): ContextMenuState {
    return {
      isHeatmap: this.isHeatmap,
      basePlotType: this.basePlotType,
      activeDragMode: this.activeDragMode,
      activeSurface3dMode: this.activeSurface3dMode,
      regions: this.plotService.getRegions(),
      selectedIndices: this.regionActions.selectedIndices,
      canUngroup: (r) => this.regionOps.canUngroup(r),
    };
  }

  private readonly contextMenuActions: ContextMenuActions = {
    autoscale: () => this.autoscaleImage(),
    zoomIn: () => this.zoomIn(),
    zoomOut: () => this.zoomOut(),
    toggleDragMode: (mode) => this.toggleDragMode(mode),
    toggleSurface3dMode: (mode) => this.toggleSurface3dMode(mode),
    resetSurfaceCamera: () => this.resetSurfaceCamera(),
    selectAllRegions: () => this.selectAllRegions(),
    mergeRegions: () => this.mergeRegions(),
    ungroupRegions: () => this.ungroupRegions(),
    inverseRegions: () => this.inverseRegions(),
    simplifyRegions: (px) => this.simplifyRegions(px),
    openSimplifyDialog: () => this.openSimplifyDialog(),
    toBezierRegion: () => this.toBezierRegion(),
    toPolygonRegion: () => this.toPolygonRegion(),
    deleteRegion: () => this.deleteRegion(),
  };

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
    if (type === PlotType.IMAGE) this.contributions.toolDialogs.deactivate();
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

  // ── dialog tools (TOOLBAR_TOOLS, kind: 'dialog') ─────────────────────────

  /** The toolbar button: open the tool's dialog, or close it if it is open. */
  toggleDialogTool(id: string): void { this.contributions.toggleDialogTool(id); }

  /** Close the open dialog tool: its body is torn down, then its session ends. */
  closeDialogTool(): void { this.contributions.closeDialogTool(); }

  /** Where the open dialog tool's host element is attached once its dialog renders. */
  @ViewChild('toolDialogSlot')
  set toolDialogSlot(ref: ElementRef<HTMLElement> | undefined) {
    this.contributions.attachToolDialogSlot(ref?.nativeElement);
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
    this.plotService.setActiveTool(null);
  }
}

