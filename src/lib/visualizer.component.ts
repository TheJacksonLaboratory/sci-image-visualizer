import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, EventEmitter,
  Inject, Injector, Input, NgZone, OnChanges, OnDestroy, OnInit, Optional, Output, SimpleChanges, ViewChild,
  computed, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { Observable } from 'rxjs';

import { MenuItem, MessageService, SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import { DialogModule } from 'primeng/dialog';
import { DropdownModule } from 'primeng/dropdown';
import { InputNumberModule } from 'primeng/inputnumber';
import { ProgressBarModule } from 'primeng/progressbar';
import { SliderModule } from 'primeng/slider';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { IImageInfo } from './contracts/image.contract';
import { ImageStatePort, IMAGE_STATE_PORT } from './contracts/ports/image-state.port';
import { Polygon } from './models/region';
import { RegionOpsService } from './region-ops.service';
import { VIZ_TOAST_KEY, VIZ_ALERT_TOAST_KEY } from './toast-outlets';
import { VisualizerStore } from './store/visualizer-store.service';
import { SliceScrubber } from './render-orchestrator';
import { ImageRenderSession, errorMessage } from './render-session';
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
  PLOT_TYPE_CONTRIBUTIONS, PlotTypeContribution, PlotTypeOption,
} from './contracts/plot-type-contribution.contract';
import { PlotModeController } from './plot-mode/plot-mode-controller';
import { computePlotTypeMenu, reconcilePlotType } from './plot-mode/plot-type-menu';
import { ToolParamsModel } from './plot-mode/tool-params-model';
import { ContributionHost, PlotModePanelView, ToolDialogView } from './plot-mode/contribution-host';
import { IVisualizer, VISUALIZER, VisualizerHandle } from './contracts/visualizer.contract';
import { SAM_MODELS, getDefaultSamModelId, isSamModelReady } from './toolbar/segmentation/sam-model-registry';
import { SamToolService } from './toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from './toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from './toolbar/segmentation/cell-segment-tool.service';
import { SegmentationRunner } from './toolbar/segmentation/segmentation-runner';
import {
  TOOLBAR_TOOLS, ToolbarContribution, ToolbarDialogToolContribution, ToolbarToolContribution,
  visibleToolContributions,
} from './contracts/toolbar-tool.contract';
import { ToolbarToolVisibility, ALL_TOOLBAR_TOOLS } from './contracts/toolbar-config';
import { VIZ_CONFIG, VizConfig } from './contracts/viz-config';
import { SPATIAL_DATA_PORT, SpatialDataPort } from './contracts/ports/spatial-data.port';
import { applyImageRois } from './visualizer/region-load';
import {
  ContextMenuActions, ContextMenuState, buildContextMenu,
} from './visualizer/visualizer-context-menu';
import { RegionActions } from './visualizer/region-actions';
import { ToolModes } from './visualizer/tool-modes';
import { ShortcutHost, ViewerShortcuts } from './visualizer/viewer-shortcuts';
import { FloatingDragDirective, FloatingPos } from './visualizer/floating-drag.directive';
import { IntensityInsetComponent } from './intensity-inset/intensity-inset.component';
import { SpatialDatasetBinder } from './visualizer/spatial-dataset-binder';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { RegionEditorComponent } from './region-editor/region-editor.component';
import { ChannelHistogramComponent } from './channel-histogram/channel-histogram.component';
import { SpatialControlsComponent } from './spatial-controls/spatial-controls.component';

/** Per-instance plot-div id source. The mount element's id must be unique so two
 *  live viewers (e.g. the main diagram + a modal preview) don't collide on the
 *  same DOM id — `getElementById` would otherwise return whichever came first.
 *  Styling hangs off the `.viz-plot` class instead of the id. */
let plotInstanceSeq = 0;

/**
 * The viewer (`<visualizer>`): the plot surface, its toolbar, the loading overlay and
 * the dialogs it opens (Channels & Histogram, spatial-omics controls, Region Editor,
 * contributed modes and tools). It orchestrates rendering through the `VISUALIZER`
 * contract and reads the image from the host's `IMAGE_STATE_PORT`.
 *
 * OnPush. Template events re-render it; state that lands asynchronously goes through
 * {@link changed} (or a signal: the loading overlay), and the collaborators that must
 * render synchronously (the render session's overlay, a contributed panel's slot, the
 * context menu before it opens) still call `detectChanges()`.
 */
@Component({
  selector: 'visualizer',
  standalone: true,
  imports: [
    CommonModule, FormsModule, SharedModule, ButtonModule, CheckboxModule, ContextMenuModule, DialogModule,
    DropdownModule, InputNumberModule, ProgressBarModule, SliderModule, ToastModule, TooltipModule,
    FloatingDragDirective, ToolbarComponent, IntensityInsetComponent, ChannelHistogramComponent,
    SpatialControlsComponent, RegionEditorComponent,
  ],
  templateUrl: './visualizer.component.html',
  styleUrls: ['./visualizer.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VisualizerComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy, ContextMenuActions {
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
  protected readonly vizToastKey = VIZ_TOAST_KEY;
  protected readonly vizAlertToastKey = VIZ_ALERT_TOAST_KEY;
  /**
   * Whether this instance renders the shared outlets. The owner is simply the
   * oldest live visualizer — a `Set` iterates in insertion order, so when the
   * owner is destroyed the next one takes over on its following change-detection
   * pass. Tracking a set rather than a single owner matters: with a lone
   * `owner` reference, tearing down the owner while a sibling was already
   * initialised would leave nobody rendering the outlets, and every notice from
   * the root service would silently vanish again.
   */
  protected get ownsSharedToasts(): boolean {
    const oldest = VisualizerComponent.liveInstances.values().next();
    return !oldest.done && oldest.value === this;
  }

  /** Each new image: whether it is a z-stack. */
  @Output()
  isStackEvent = new EventEmitter(false);
  /** Each new image: whether it is single-channel (grayscale). */
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
  protected imageSmoothingEnabled = false;
  fileName: string | undefined;
  private loadedFileName: string | undefined;
  protected imageInfo: IImageInfo | undefined;

  // ── The loading overlay, as signals: it is fed by the host's and the backends' streams
  // and by the render session, all of which land outside this view's template events. ──
  protected readonly loadingMessage = signal('Loading image...');
  /** The host is loading at zoom (the overlay message moves out of the way). */
  protected readonly zoom = signal(false);
  protected readonly stackLoading = signal(false);
  protected readonly imgLoading = signal(false);
  protected readonly loadingPercentage = signal(0);
  // Non-null (0..100) while jit-service is copying the source file into the
  // local cache PVC on first click. When set, the loading overlay swaps the
  // spinner for a determinate progress bar with a "Caching image" message.
  protected readonly cacheProgress = signal<number | null>(null);
  /** A jit-service cache copy is actively in progress (determinate 0..99). Drives the cache
   *  progress bar independently of `imgLoading` so the bar can't be dropped — or masked by the
   *  "Sharpening preview..." overlay — mid-download if the loading flag flips early. */
  protected readonly isCaching = computed(() => {
    const p = this.cacheProgress();
    return p !== null && p < 100;
  });

  /** Emits once when this view is destroyed; the collaborators end their subscriptions on it. */
  private readonly destroyed$ = new Observable<void>((subscriber) => this.destroyRef.onDestroy(() => {
    subscriber.next();
    subscriber.complete();
  }));
  /** Host image-info objects whose one-shot `initialZIndex` was already applied. */
  private readonly consumedSliceHints = new WeakSet<IImageInfo>();
  protected zIndex = 0;
  protected maxIndex = 0;

  @ViewChild('cm') contextMenu!: ContextMenu;
  protected contextMenuItems: MenuItem[] = [];

  /** The armed tool mode and the toolbar's tool settings. */
  protected readonly tools = new ToolModes(this.plotService, this.session, this.ngZone,
    (mode) => { if (mode !== 'samPoint') this.segmentation.hide(); }, // leaving point mode drops its toast
    () => this.cdr.markForCheck());
  protected get activeDragMode(): string | null { return this.tools.active; }
  protected set activeDragMode(mode: string | null) { this.tools.active = mode; }
  protected get wandSensitivity(): number { return this.tools.wandSensitivity; }
  protected set wandSensitivity(v: number) { this.tools.wandSensitivity = v; }
  protected get brushSize(): number { return this.tools.brushSize; }
  protected get vertexEraserRadius(): number { return this.tools.vertexEraserRadius; }
  protected set vertexEraserRadius(v: number) { this.tools.vertexEraserRadius = v; }

  /** Region set-operations on the selection, and the store mirrors they read (jit-ui#85). */
  protected readonly regionActions = new RegionActions(
    this.plotService, this.regionOps, () => this.imageInfo?.trueImageSize,
    (m) => this.messageService.add({ key: this.resultToastKey, ...m }),
  );
  /** Custom-threshold Simplify dialog visibility (see {@link RegionActions}). */
  protected get displaySimplifyDialog(): boolean { return this.regionActions.displaySimplifyDialog; }
  protected set displaySimplifyDialog(v: boolean) { this.regionActions.displaySimplifyDialog = v; }

  /** SAM model picker options + current selection (jit-ui#90 P1). Only models
   *  with a hosted ONNX pair (configured via setSamModelUrls at app init) are
   *  offered, so the picker can't select a model that can't run. */
  protected samModels = SAM_MODELS.filter(isSamModelReady).map((m) => ({ id: m.id, label: m.label }));
  protected samModelId = getDefaultSamModelId();

  /**
   * No-prompt tools registered through {@link TOOLBAR_TOOLS}, filtered to those
   * with configured models and sorted. This library registers none — a host
   * supplies them — so an open build has an empty array here and the toolbar
   * and help dialog simply omit that group.
   */
  protected contributedTools: ToolbarToolContribution[] = [];
  /** Checkpoints and parameter values of {@link contributedTools}, and their dialog. */
  protected readonly toolParams: ToolParamsModel;
  /** Contributed plot modes and dialog tools, and their live sessions. */
  readonly contributions: ContributionHost;
  /** Dialog tools registered through {@link TOOLBAR_TOOLS} (`kind: 'dialog'`). */
  protected get dialogTools(): ToolbarDialogToolContribution[] { return this.contributions.dialogTools; }
  /** The dialog tool the user has open (its session may be between renders). */
  protected get openDialogToolId(): string | null { return this.contributions.openDialogToolId; }
  /** The open dialog tool's live dialog, as the template renders it. */
  protected get toolDialog(): ToolDialogView | null { return this.contributions.toolDialog; }
  protected readonly samToastKey = `sam-${VisualizerComponent.nextToastId++}`;
  /**
   * Outlet for the library's own result/error notices, keyed to this instance so they
   * do not depend on the host mounting a keyless `<p-toast>` (most hosts don't, and a
   * failed segmentation then looked like a dead button). Deliberately NOT the sticky
   * toast's key: that is cleared when a run settles, which would wipe the result.
   */
  protected readonly resultToastKey = `${this.samToastKey}-result`;
  /** Segmentation runs and their sticky progress toast. */
  protected readonly segmentation = new SegmentationRunner(
    this.messageService, this.samToastKey, this.resultToastKey, () => this.changed());

  /** Channels & Histogram dialog visibility (opened from the toolbar). */
  protected showChannelHistogram = false;
  /** Spatial-omics controls dialog visibility (toolbar button). */
  protected showSpatialControls = false;
  /** Region Editor dialog visibility (opened from the toolbar). */
  protected showRegionEditor = false;
  /** Region Editor dialog width. On open it is set to the configured host
   *  element's current width, or — when no selector is configured / the element
   *  isn't found — to a quarter of the page (see openRegionEditor). */
  protected regionEditorWidth = '25vw';
  protected readonly plotDivName = `viz-plot-${plotInstanceSeq++}`;
  /** The render pipeline: the newest image (or image-less dataset) always wins. */
  protected readonly render: ImageRenderSession = new ImageRenderSession({
    plotDivName: this.plotDivName,
    visualizer: this.plotService,
    zIndex: () => this.zIndex,
    plotType: () => this.plotType,
    isHeatmap: () => this.isHeatmap,
    isCaching: () => this.isCaching(),
    beforeReset: () => this.contributions.endSessions(),
    prepare: (info) => this.layOutSlices(info),
    releaseOverlay: (info) => {
      if (info.isStack && info.showStack) this.stackLoading.set(false);
      this.state.setImageLoading(false);
    },
    landed: (info) => {
      applyImageRois(info, this.plotService, this.zIndex);
      this.contributions.activate();
    },
    setImageLoading: (loading) => this.state.setImageLoading(loading),
    alert: (severity, summary, detail) =>
      this.messageService.add({ key: this.vizAlertToastKey, severity, summary, detail }),
    detectChanges: () => this.cdr.detectChanges(),
  });
  plotType = PlotType.IMAGE;
  protected isHeatmap = true;
  protected activeSurface3dMode = 'turntable';
  /** Whether the napari 3D coordinate-axes / scale gizmo is shown (volume/isosurface). */
  protected axesVisible = true;
  protected wireframeActive = false;
  /** napari 3D decimate factor (1 = Full … 8 = ⅛; default ½); changing it re-plots. */
  protected resolutionScale = NAPARI_DEFAULT_DECIMATE;

  /** The selector's entries: the built-in plot types the active backend
   *  advertises (3D gated by capability), then any contributed modes
   *  ({@link PLOT_TYPE_CONTRIBUTIONS}). */
  protected plotTypeMenu: PlotTypeOption[] = [];
  /**
   * The built-in plot types on offer — {@link plotTypeMenu} without contributed
   * modes. Kept with its original type so existing readers are unaffected.
   */
  protected plotTypeOptions: PlotTypeDescriptor[] = [];
  /**
   * What the selector shows: a built-in type or a contributed mode's id. Every
   * rendering and tool decision goes through {@link basePlotType} instead, so a
   * contributed mode behaves exactly like the built-in type it rides on.
   */
  protected selectedPlotTypeId: PlotTypeId = PlotType.IMAGE;

  /**
   * The built-in plot type being rendered. With no contributed mode active this
   * is the selection itself; during one it is the mode's `baseType`. Kept with its
   * original `PlotType` type for existing readers — use {@link selectedPlotTypeId}
   * for the selector's id. Assigning selects that built-in type.
   */
  protected get selectedPlotType(): PlotType {
    return this.basePlotType;
  }
  protected set selectedPlotType(type: PlotType) {
    this.selectedPlotTypeId = type;
  }

  /** Contributed plot modes and their single live session. */
  get plotModes(): PlotModeController { return this.contributions.plotModes; }
  /** The live contributed mode's side panel; null while no contributed session is live. */
  protected get plotModePanel(): PlotModePanelView | null { return this.contributions.plotModePanel; }

  /** Where a `mount` panel's host element is attached once the dialog renders. */
  @ViewChild('plotModePanelSlot')
  set plotModePanelSlot(ref: ElementRef<HTMLElement> | undefined) {
    this.contributions.attachPanelSlot(ref?.nativeElement);
  }

  /** The built-in type actually rendered for {@link selectedPlotTypeId}: itself
   *  for a built-in type, `baseType` for a contributed mode. */
  protected get basePlotType(): PlotType {
    return this.plotModes.baseTypeOf(this.selectedPlotTypeId);
  }

  /** Div the floating intensity-profile inset is charted into. Per instance, like
   *  {@link plotDivName}: the backend resolves it by id, so a fixed id made two live
   *  viewers draw both insets into whichever div came first in the document. */
  protected readonly intensityInsetDiv = `${this.plotDivName}-inset`;

  /** Toolbar docking: docked across the top by default; dragging its handle
   *  detaches it into a floating, movable window (frees the top row for the
   *  visualization). */
  protected toolbarFloating = false;
  protected toolbarPos = { x: 8, y: 8 };
  /** Where a toolbar-handle drag starts from: grabbing the docked toolbar floats it. */
  protected readonly toolbarDragOrigin = (): FloatingPos => {
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
  protected get isSpatial3dMode(): boolean {
    return isSpatialOmics3d(this.basePlotType);
  }

  /** True for the Image plot type, which renders as a natively pan/zoom-able
   *  raster — so the backend-agnostic zoom/pan toolbar tools are hidden. The
   *  component drives this off the plot type, not the active backend. */
  protected get isImageView(): boolean {
    return this.basePlotType === PlotType.IMAGE;
  }

  /** Isosurface band as a 0–255 slider position, mapped onto the volume's real
   *  intensity range by the renderer. Defaults to the full range. */
  protected isoRange: number[] = [0, 255];

  /** The spatial-omics dataset on offer and the gates it puts on the selector. */
  protected readonly spatial: SpatialDatasetBinder;
  /** Whether a spatial-omics dataset is published on `SPATIAL_DATA_PORT` — gates the
   *  spatial plot types; the toolbar offers the plot modes for an image-less one too. */
  protected get hasSpatialDataset(): boolean { return this.spatial.hasDataset; }

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
    // The constructor parameters below are the injection points; none is public API.
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
    // Ends the subscriptions (`takeUntilDestroyed`). A parameter, like the rest, so the
    // specs' `new` can pass one; Angular always provides it.
    private readonly destroyRef: DestroyRef = undefined as unknown as DestroyRef,
  ) {
    this.contributedTools = visibleToolContributions(toolContributions);
    this.toolParams = new ToolParamsModel(this.contributedTools);
    this.contributions = new ContributionHost(plotTypeContributions, toolContributions, {
      visualizer: this.plotService,
      zone: this.ngZone,
      tools: this.tools.plotModeTools,
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
        this.changed();
      },
      detectChanges: () => this.changed(),
    });
    this.computePlotTypeOptions();
  }

  /** Follow the spatial-omics dataset: a dataset appearing, switching or being cleared
   *  re-gates the selector exactly as the image stream and the test-mode toggle do. */
  private watchSpatialDataset(): void {
    this.spatial.bind(this.destroyed$);
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
    this.changed();
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
    this.plotService.getAutoscaleEvent().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.tools.apply(null));
    // Loading/overlay UI mirrors (signals: they re-render the view themselves).
    this.mirror(this.state.isImageLoading$(), (v) => this.imgLoading.set(v));
    this.mirror(this.plotService.getStackLoadingProgress(), (v) => this.loadingPercentage.set(v));
    this.mirror(this.plotService.isStackLoading(), (v) => this.stackLoading.set(v));
    this.mirror(this.state.getImageLoadingMessage$(), (v) => this.loadingMessage.set(v));
    this.mirror(this.state.getCacheProgress$(), (v) => this.cacheProgress.set(v));
    this.mirror(this.state.isZoom$(), (v) => this.zoom.set(v));
    this.mirror(this.state.getFilename$(), (v) => { if (v) this.fileName = v; });
    this.regionActions.bind(this.destroyed$, () => this.changed());
    this.segmentation.bindPointTool(this.samPointTool, this.destroyed$);
    this.mirror(this.state.getPanelWidth$(), () => {
      this.plotService.relayout();
      // The intensity inset is a separate chart in a floating panel; reflow it too.
      this.inset?.reflow();
    });
    this.state.getImageInfo$().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (imgInfo) => {
        if (!imgInfo) {
          this.onImageCleared();
          return;
        }
        // The selector, the stack controls and the inset all follow the image.
        this.changed();
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
          // A newer image always preempts an in-flight render (see ImageRenderSession).
          if (imgInfo.urls) this.render.render(imgInfo);
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
        this.stackLoading.set(false);
        this.state.setImageLoading(false);
        this.render.running = false;
        this.plotService.reset();
      },
    });
  }

  /** Follow `source` until destroy. */
  private mirror<T>(source: Observable<T>, apply: (value: T) => void): void {
    source.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(apply);
  }

  /**
   * State this view shows changed outside one of its template events (a stream, a
   * resolved promise, a host call): mark the OnPush view for check, re-entering the
   * zone when it changed outside it so a change-detection pass follows.
   */
  private changed(): void {
    if (NgZone.isInAngularZone()) this.cdr.markForCheck();
    else this.ngZone.run(() => this.cdr.markForCheck());
  }

  /**
   * Lay a new image out once the old view is gone: the stack flag, the slice bounds (one
   * url per slice, so the last index is length-1), and the one-shot `initialZIndex` hint
   * (e.g. the file the user clicked within a numbered series). The hint is consumed so
   * re-delivering the same info (a plot-type switch, reloadAndPlot) does not reset the
   * user's scrub; the host's object is never written to (a host store may freeze it) —
   * the component keeps a copy without the hint, and remembers the host object.
   */
  private layOutSlices(info: IImageInfo): void {
    this.stackLoading.set(info.isStack && info.showStack);
    this.maxIndex = info.urls.length > 1 ? info.urls.length - 1 : 0;
    if (info.initialZIndex !== undefined) {
      if (!this.consumedSliceHints.has(info)) {
        this.consumedSliceHints.add(info);
        this.zIndex = info.initialZIndex;
      }
      this.imageInfo = { ...info, initialZIndex: undefined };
    }
    this.updateZIndex();
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
    this.render.viewIsReady(this.spatial.dataset, !!this.imageInfo);
  }

  /** What the keyboard, wheel and context-menu shortcuts act on. Their listeners live
   *  outside this view, so every action that changes what it shows marks it for check. */
  private shortcutHost(): ShortcutHost {
    const marked = <A extends unknown[]>(act: (...args: A) => void) => (...args: A): void => {
      act(...args);
      this.changed();
    };
    return {
      plotDivName: this.plotDivName,
      hostElement: this.hostRef?.nativeElement ?? null,
      activeDragMode: () => this.activeDragMode,
      canStepSlice: () => !!this.imageInfo?.isStack && this.isImageView,
      wheelZooms: () => !rendererOwnsWheel(this.basePlotType) && this.isHeatmap,
      stepSlice: marked((delta: number) => this.stepSlice(delta)),
      resolveSamPrompt: marked((commit: boolean) => {
        if (commit) this.plotService.commitSamPoints();
        else this.plotService.clearSamPoints();
        this.segmentation.hide(); // prompt resolved → dismiss the status toast
      }),
      undo: marked(() => this.undoRegion()),
      redo: marked(() => this.redoRegion()),
      deleteRegion: marked(() => this.deleteRegion()),
      zoomIn: marked(() => this.zoomIn()),
      zoomOut: marked(() => this.zoomOut()),
      toggleDragMode: marked((mode: string) => this.toggleDragMode(mode)),
      openContextMenu: (event) => {
        this.contextMenuItems = this.buildContextMenuItems();
        this.cdr.detectChanges();
        this.contextMenu.show(event);
      },
    };
  }

  /** Snap the floating toolbar back to its docked position across the top. */
  protected dockToolbar() {
    this.toolbarFloating = false;
  }

  /** Toolbar "Intensity" group: add another line ROI (next bright colour). */
  protected async addProfileLine(): Promise<void> {
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
    // Leave the live set so the next-oldest visualizer picks up the outlets — on its
    // next check, which an OnPush sibling needs asking for.
    VisualizerComponent.liveInstances.delete(this);
    for (const other of VisualizerComponent.liveInstances) other.cdr.markForCheck();
    this.state.setDiagram(null);
    this.render.cancel();
    this.spatial.dispose();
    this.scrubber.cancel();
    this.shortcuts?.detach();
    this.plotService.detach();
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
  protected openChannelHistogram() {
    this.showChannelHistogram = true;
  }

  /** Toolbar → open the spatial-omics controls. */
  protected openSpatialControls(): void {
    this.showSpatialControls = true;
  }

  /** Open the Region Editor dialog (toolbar button). The editor stays linked to
   *  this plotting instance through the root RegionStore singleton, so it works
   *  the same as the former right-panel Regions tab. */
  protected openRegionEditor() {
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
  protected selectStackOption(selectedStackOption: { name: string; val: string }) {
    const showstack = selectedStackOption.val === 'true';
    this.stackLoading.set(showstack);
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
  protected updateZIndex() {
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
  protected onZSlide(z: number | undefined) {
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
  protected onZScrub(z: number | undefined) {
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

  protected reloadAndPlot() {
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
      void this.render.plotWithoutImage(this.spatial.dataset);
    } else {
      this.plotService.reloadAndPlot();
    }
  }

  protected cancelLoading() {
    // Stop any in-flight frame streaming (napari-js volume/surface preload) so the fetch loops
    // actually abort — clearing the flag alone only routed to Plotly and left napari fetching.
    this.plotService.cancelLoading?.();
    // The cancelled render is superseded, not just aborted: its aborted load must not
    // come back as "Could not draw the image", nor apply ROIs for an image left unshown.
    this.render.cancel();
    this.stackLoading.set(false);
    this.imgLoading.set(false);
    this.state.setImageLoading(false);
    this.zIndex = 0;
    this.plotService.setZIndex(this.zIndex);
    this.plotService.setStackLoading(false);
  }

  protected downloadImage() {
    this.plotService.downloadImage();
  }

  autoscaleImage() {
    this.plotService.fitToView();
  }

  /** Toolbar pixel/smooth toggle: flip smoothing and apply to the active backend. */
  protected onToggleImageSmoothing(): void {
    this.imageSmoothingEnabled = !this.imageSmoothingEnabled;
    this.plotService.setImageSmoothingEnabled(this.imageSmoothingEnabled);
  }

  resetAxes() {
    this.plotService.resetAxes();
  }

  toggleDragMode(mode: string) {
    this.tools.toggle(mode);
  }

  /** Live-update the isosurface as the range slider moves. The control is only
   *  available when the active backend renders isosurfaces (ISOSURFACE mode). */
  protected onIsoRangeChange(values: number[] | undefined) {
    if (!values || values.length < 2) return;
    this.isoRange = values;
    this.plotService.getIsosurfaceControls()?.setIsoRange(values[0], values[1]);
  }

  protected onWandSensitivityChange(value: number | undefined) { this.tools.setWandSensitivity(value); }
  protected onBrushSizeChange(value: number | undefined) { this.tools.setBrushSize(value); }
  protected onVertexEraserRadiusChange(value: number | undefined) { this.tools.setVertexEraserRadius(value); }

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
  protected undoRegion() {
    this.plotService.undo();
  }

  /** Redo the most recently undone region action (jit-ui#85). */
  protected redoRegion() {
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
  protected async segmentRegions() {
    await this.segmentation.run('SAM', this.samTool, () => this.plotService.segmentRectangles());
  }

  /** Auto-segment cells inside each drawn rectangle with cellpose-SAM, client-side
   *  (jit-ui#90). Each box is cropped (browser slide-crop) then run through the
   *  cellpose-js model; the same sticky `sam` toast + progress bar is reused. */
  protected async segmentCellpose() {
    await this.segmentation.run('Cellpose', this.cellSegmentTool, () =>
      this.plotService.segmentRectanglesCellpose(),
    );
  }

  // ── contributed tool parameters (see ToolParamsModel) ─────────────────
  paramsFor(toolId: string): Record<string, unknown> { return this.toolParams.paramsFor(toolId); }
  protected onToolModelChange(e: { toolId: string; modelId: string }): void {
    this.toolParams.setModel(e.toolId, e.modelId);
  }
  protected openToolParams(toolId: string): void { this.toolParams.open(toolId); }
  protected closeToolParams(): void { this.toolParams.close(); }
  protected resetToolParams(toolId: string): void { this.toolParams.reset(toolId); }

  /** Run a contributed tool over the current view. No prompt: these sweep the
   *  whole view rather than being pointed at something. Reuses the shared
   *  segmentation toast so progress reads the same as the SAM/cellpose tools. */
  protected async runTool(toolId: string): Promise<void> {
    const tool = this.toolParams.find(toolId);
    if (!tool) return;
    const params = this.toolParams.runParams(tool);
    await this.segmentation.run(tool.label, tool.progress, () => tool.run(this.plotService, params));
  }

  /** Pick the SAM model the segment tools use (jit-ui#90 P1). */
  protected onSamModelChange(id: string) {
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
    return buildContextMenu(this.contextMenuState(), this);
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

  /** 3D scene interaction mode (orbit / turntable / pan / zoom); no-op on a 2D-only backend. */
  toggleSurface3dMode(mode: string) {
    this.activeSurface3dMode = mode;
    this.plotService.getSurface3dControls()?.setSurfaceDragMode(mode);
  }

  resetSurfaceCamera() {
    this.plotService.getSurface3dControls()?.resetSurfaceCamera();
  }

  /** Toggle the napari 3D coordinate-axes / scale gizmo (volume/isosurface). No-op on backends
   *  that don't render one (the control method is optional). */
  protected toggleAxes() {
    this.axesVisible = !this.axesVisible;
    this.plotService.getSurface3dControls()?.setAxesVisible?.(this.axesVisible);
  }

  /** Toggle the napari surface wireframe (edges vs filled). No-op on backends without a surface. */
  protected toggleWireframe() {
    this.wireframeActive = !this.wireframeActive;
    this.plotService.getSurface3dControls()?.setWireframe?.(this.wireframeActive);
  }

  /** Change the napari 3D decimate factor. Decimation changes the fetched/assembled data, so this
   *  re-plots the current 3D type at the new resolution (unlike axes/wireframe, which are live). */
  protected selectResolution(scale: number) {
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
    // Also called by the host directly, outside this view's events: the selector, the
    // toolbar's tool groups and the dialogs all follow the type.
    this.changed();
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
    this.tools.deactivate();
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
      this.stackLoading.set(true);
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
  protected toggleDialogTool(id: string): void { this.contributions.toggleDialogTool(id); }

  /** Close the open dialog tool: its body is torn down, then its session ends. */
  protected closeDialogTool(): void { this.contributions.closeDialogTool(); }

  /** Where the open dialog tool's host element is attached once its dialog renders. */
  @ViewChild('toolDialogSlot')
  set toolDialogSlot(ref: ElementRef<HTMLElement> | undefined) {
    this.contributions.attachToolDialogSlot(ref?.nativeElement);
  }
}
