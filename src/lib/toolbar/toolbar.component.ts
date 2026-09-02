import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { MenuItem } from 'primeng/api';

import { IImageInfo } from '../contracts/image.contract';
import {
  PlotType,
  PlotTypeDescriptor,
  isNapari3d,
  isNapariIsosurface,
  isNapariSurface,
  isNapariScatter,
  NAPARI_DECIMATE_OPTIONS,
  NAPARI_DEFAULT_DECIMATE,
} from '../contracts/plot-type';
import { ToolbarToolVisibility, ALL_TOOLBAR_TOOLS } from '../contracts/toolbar-config';
import { ToolbarToolContribution } from '../contracts/toolbar-tool.contract';
import { MODEL_INFO } from './model-info';

/**
 * Presentational toolbar for the plotting viewport.
 *
 * Renders the plot-type selector, colormap/LUT controls, stack navigation,
 * image actions (download / autoscale / pipeline), viewport zoom/pan, the
 * Surface-3D camera controls, and the region-drawing tools — plus the plotting
 * help dialog. It owns no rendering or visualization state: the host
 * (VisualizerComponent) stays the orchestrator, passing state in via `@Input` and
 * handling every action via `@Output`. The same actions are also driven by the
 * diagram's right-click context menu and keyboard shortcuts, so keeping the
 * handlers in the host avoids duplicating that logic.
 */
@Component({
  // Canonical prefixed selector first; the unprefixed original is kept as an
  // alias for one release (pre-publication back-compat).
  selector: 'plotting-toolbar',
  templateUrl: './toolbar.component.html',
  styleUrls: ['./toolbar.component.scss'],
})
export class ToolbarComponent implements OnChanges {
  /** Current image (gates which control groups are shown). */
  @Input() imageInfo: IImageInfo | undefined;
  /** Plot types the active backend advertises. */
  @Input() plotTypeOptions: PlotTypeDescriptor[] = [];
  @Input() selectedPlotType: PlotType = PlotType.IMAGE;
  /** Isosurface band as a 0–255 slider position (mapped onto the volume's real
   *  intensity range by the renderer). Defaults to the full range. */
  @Input() isoRange: number[] = [0, 255];
  @Input() maxIndex = 0;
  @Input() zIndex = 0;
  /** True for any 2D (non Surface-3D) plot type. */
  @Input() isHeatmap = true;
  @Input() activeDragMode: string | null = null;
  @Input() activeSurface3dMode = 'turntable';
  /** Whether the napari 3D axes/scale gizmo is currently shown (drives the toggle's look). */
  @Input() axesVisible = true;
  @Input() wireframeActive = false;
  /** Active napari 3D decimate factor (1 = Full … 8 = ⅛; default ½). */
  @Input() resolutionScale = NAPARI_DEFAULT_DECIMATE;
  /** Decimate-factor options for the Resolution dropdown. */
  readonly decimateOptions = NAPARI_DECIMATE_OPTIONS;
  @Input() wandSensitivity = 2.0;
  @Input() brushSize = 40;
  @Input() vertexEraserRadius = 20;
  /** Whether a region action is available to undo (jit-ui#85). Greys out the
   *  Undo button when false (nothing done yet, or all steps already undone). */
  @Input() canUndo = false;
  /** Whether an undone region action is available to redo (jit-ui#85). Greys
   *  out the Redo button when false. */
  @Input() canRedo = false;
  @Input() stackOptions: { name: string; val: string }[] =
    [{ name: 'Single image', val: 'false' }, { name: 'Stack', val: 'true' }];
  /** Which toolbar groups to show. Defaults to the full toolbar; the host forwards
   *  the consumer's choice (e.g. the pipeline shows only zoom + region tools). */
  @Input() tools: Required<ToolbarToolVisibility> = ALL_TOOLBAR_TOOLS;
  /** Current image-smoothing state (drives the Smoothen toggle button look).
   *  `false` = nearest-neighbour (crisp raw pixels), the default. */
  @Input() imageSmoothingEnabled = false;
  /** SAM model picker options + current selection (jit-ui#90 P1). */
  @Input() samModels: { id: string; label: string }[] = [];
  @Input() samModelId = '';
  /**
   * Tools contributed through {@link TOOLBAR_TOOLS}, already filtered to the
   * ones with models and sorted. The host resolves them so it can own the
   * per-tool parameter state; this component only draws them.
   */
  @Input() contributedTools: ToolbarToolContribution[] = [];
  /** Active checkpoint per contributed tool, keyed by tool id. */
  @Input() toolModelIds: Record<string, string> = {};

  @Output() selectPlotType = new EventEmitter<PlotType>();
  /** Intensity (LINE) mode: add another colored line ROI + inset trace. */
  @Output() addProfileLine = new EventEmitter<void>();
  /** Toggle image smoothing (bilinear) vs nearest-neighbour (crisp pixels). */
  @Output() toggleImageSmoothing = new EventEmitter<void>();
  // PrimeNG slider/inputNumber change events carry optional values, mirrored by
  // the host handlers (which accept `| undefined`).
  @Output() isoRangeChange = new EventEmitter<number[] | undefined>();
  /** Open the Channels & Histogram dialog (brightness/contrast, colormap, …). */
  @Output() openChannelHistogram = new EventEmitter<void>();
  /** Open the spatial-omics controls (colour-by, legend, point display). */
  @Output() openSpatialControls = new EventEmitter<void>();
  @Output() openRegionEditor = new EventEmitter<void>();
  @Output() selectStackOption = new EventEmitter<{ name: string; val: string }>();
  @Output() zScrub = new EventEmitter<number | undefined>();
  @Output() zSlide = new EventEmitter<number | undefined>();
  @Output() zIndexInput = new EventEmitter<number>();
  @Output() reloadAndPlot = new EventEmitter<void>();
  @Output() downloadImage = new EventEmitter<void>();
  @Output() autoscaleImage = new EventEmitter<void>();
  @Output() toggleDragMode = new EventEmitter<string>();
  @Output() zoomIn = new EventEmitter<void>();
  @Output() zoomOut = new EventEmitter<void>();
  @Output() toggleSurface3dMode = new EventEmitter<string>();
  @Output() resetSurfaceCamera = new EventEmitter<void>();
  /** Toggle the napari 3D coordinate-axes / scale gizmo on/off. */
  @Output() toggleAxes = new EventEmitter<void>();
  /** Toggle the napari surface wireframe (edges) on/off. */
  @Output() toggleWireframe = new EventEmitter<void>();
  /** Change the napari 3D decimate factor (reloads at the new resolution). */
  @Output() selectResolution = new EventEmitter<number>();
  @Output() deleteRegion = new EventEmitter<void>();
  /** Undo the last region action (jit-ui#85). */
  @Output() undoRegion = new EventEmitter<void>();
  /** Redo the last undone region action (jit-ui#85). */
  @Output() redoRegion = new EventEmitter<void>();
  /** Run box-prompted SAM segmentation on the drawn rectangles (jit-ui#90). */
  @Output() segmentRegions = new EventEmitter<void>();
  /** Run cellpose-SAM (auto) inside each drawn rectangle's crop (jit-ui#90). */
  @Output() segmentCellpose = new EventEmitter<void>();
  /** Run a contributed tool over the current view, by tool id. */
  @Output() runTool = new EventEmitter<string>();
  /** Pick a contributed tool's checkpoint. */
  @Output() toolModelChange = new EventEmitter<{ toolId: string; modelId: string }>();
  /** Open a contributed tool's parameter dialog, by tool id. */
  @Output() openToolParams = new EventEmitter<string>();
  /** SAM model picker (jit-ui#90 P1). */
  @Output() samModelChange = new EventEmitter<string>();
  @Output() wandSensitivityChange = new EventEmitter<number | undefined>();
  @Output() brushSizeChange = new EventEmitter<number | undefined>();
  @Output() vertexEraserRadiusChange = new EventEmitter<number | undefined>();

  /** Sliders' bounds — toolbar UI constants (the values are host-owned). */
  readonly wandSensitivityMin = 0.5;
  readonly wandSensitivityMax = 10.0;
  readonly wandSensitivityStep = 0.1;
  readonly brushSizeMin = 5;
  readonly brushSizeMax = 300;
  readonly brushSizeStep = 5;
  readonly vertexEraserRadiusMin = 5;
  readonly vertexEraserRadiusMax = 300;
  readonly vertexEraserRadiusStep = 5;
  readonly isoValueMin = 0;
  readonly isoValueMax = 255;
  readonly isoValueStep = 1;

  displayHelpDialog = false;

  /** Model picker for the Segment button's dropdown menu. The active model
   *  (`samModelId`) is marked with a check; selecting an item emits
   *  `samModelChange` (jit-ui#90 P1).
   *
   *  Held as a stable array (rebuilt only when `samModels`/`samModelId` change),
   *  NOT a getter: a getter returns a fresh array with new `command` closures on
   *  every change-detection tick, which makes the bound `p-menu` overlay rebuild
   *  its DOM mid-interaction and swallow the click on a menu item.
   *
   *  `tooltip` carries the model's description from {@link MODEL_INFO}; the
   *  menus' shared item template turns it into the hover info icon. p-menu's own
   *  rendering ignores the field (it reads `item.title`), so it is free to use. */
  samMenuItems: MenuItem[] = [];
  /**
   * Model menus for the contributed tools, keyed by tool id. Same stable-array
   * reasoning as {@link samMenuItems} — and it is why this is a map rebuilt in
   * `ngOnChanges` rather than a method called from the template, which would
   * hand `p-menu` a new array every tick.
   *
   * A contributed tool supplies its own per-model description, so unlike the
   * SAM menu these do not consult {@link MODEL_INFO}: this library has no
   * copy for checkpoints it does not know about.
   */
  toolMenuItems: Record<string, MenuItem[]> = {};

  /** Rebuild the SAM model menu when the model list or active selection
   *  changes (keeps the array reference stable across other CD ticks). */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['samModels'] || changes['samModelId']) {
      this.samMenuItems = this.samModels.map((m) => ({
        label: m.label,
        icon: m.id === this.samModelId ? 'pi pi-check' : 'pi pi-fw',
        tooltip: MODEL_INFO[m.id],
        command: () => this.samModelChange.emit(m.id),
      }));
    }
    if (changes['contributedTools'] || changes['toolModelIds']) {
      this.toolMenuItems = {};
      for (const tool of this.contributedTools) {
        const active = this.toolModelIds[tool.id] ?? tool.defaultModelId();
        this.toolMenuItems[tool.id] = tool.models().map((m) => ({
          label: m.label,
          icon: m.id === active ? 'pi pi-check' : 'pi pi-fw',
          tooltip: m.info,
          command: () => this.toolModelChange.emit({ toolId: tool.id, modelId: m.id }),
        }));
      }
    }
  }

  /**
   * Strip markup from a model description so it can be read aloud.
   *
   * The copy in MODEL_INFO and in a contribution's `ToolModelOption.info` is
   * written for a visual tooltip rendered with `[escape]="false"`, so it carries
   * `<b>` and `<br>`. Passed to `aria-label` verbatim a screen reader announces
   * the tags, so they are removed and `<br>` becomes a sentence break. Entities
   * used in that copy (`&nbsp;`, `&times;`, `&amp;`) are decoded for the same
   * reason.
   */
  plainText(html: string): string {
    return (html ?? '')
      .replace(/<br\s*\/?>/gi, '. ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&times;/g, 'x')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Contributed tool names for the help dialog's prompted/no-prompt contrast,
   *  e.g. "YOLO, Retinal layers". Empty when nothing is registered, which is
   *  why the sentence that uses it is itself conditional. */
  get contributedToolNames(): string {
    return this.contributedTools.map((t) => t.label).join(', ');
  }

  /** Keeps each contributed tool's `p-menu` overlay alive across CD ticks —
   *  re-creating it mid-interaction swallows the click on a menu item. */
  trackToolById(_index: number, tool: ToolbarToolContribution): string {
    return tool.id;
  }

  /** The Image plot type renders as a natively pan/zoom-able raster, so the
   *  generic zoom/pan tools are hidden. */
  get isImageView(): boolean {
    return this.selectedPlotType === PlotType.IMAGE;
  }

  /** The spatial-omics mode is active, so its controls are worth offering. */
  get isSpatialMode(): boolean {
    return this.selectedPlotType === PlotType.SPATIAL_OMICS;
  }

  /** A plot-type icon is a PrimeNG font glyph (e.g. `pi pi-image`) rather than an
   *  SVG asset path — drives which element the selector item template renders. */
  isPiIcon(icon: string | undefined): boolean {
    return !!icon && icon.startsWith('pi ');
  }

  /** Backends with a vertex-editing region overlay: OSD Image and napari-js WebGPU image
   *  (jit-ui#102). Gates the polygon / add-vertex / delete-vertex / Bézier-convert tools. */
  get supportsRegionVertexTools(): boolean {
    return (
      this.selectedPlotType === PlotType.IMAGE ||
      this.selectedPlotType === PlotType.NAPARI_IMAGE
    );
  }

  /** Plot types that scrub a z-stack live (the renderer swaps the slice in place): the OSD Image
   *  view, the napari-js WebGPU image, and the napari-js surface — which rebuilds the height field
   *  from the picked slice (jit-ui#102). Drives the per-slice slider. */
  get showsLiveSliceScrubber(): boolean {
    return (
      this.selectedPlotType === PlotType.IMAGE ||
      this.selectedPlotType === PlotType.NAPARI_IMAGE ||
      isNapariSurface(this.selectedPlotType) ||
      isNapariScatter(this.selectedPlotType)
    );
  }

  /** Any napari-js WebGPU plot type. The single-image/stack toggle + slice-number field are
   *  Plotly-only stack controls, so they're hidden for napari (jit-ui#102). */
  get isNapariMode(): boolean {
    return (
      this.selectedPlotType === PlotType.NAPARI_IMAGE ||
      isNapariScatter(this.selectedPlotType) ||
      isNapari3d(this.selectedPlotType)
    );
  }

  /** ISOSURFACE (Plotly or napari-js WebGPU, either resolution) shows the isovalue range slider. */
  get isIsosurfaceMode(): boolean {
    return (
      this.selectedPlotType === PlotType.ISOSURFACE || isNapariIsosurface(this.selectedPlotType)
    );
  }

  /** The napari-js WebGPU surface — shows the wireframe toggle. */
  get isNapariSurfaceMode(): boolean {
    return isNapariSurface(this.selectedPlotType);
  }

  /** Any napari-js WebGPU 3D type (volume/isosurface/surface) — shows the Resolution control. */
  get isNapari3dMode(): boolean {
    return isNapari3d(this.selectedPlotType);
  }

  /** Intensity profile lines are Region-based and available in the Heatmap and
   *  Image plot types, which show the Intensity tool group. */
  get isIntensityCapable(): boolean {
    return this.selectedPlotType === PlotType.HEATMAP || this.selectedPlotType === PlotType.IMAGE;
  }

  showHelp(): void {
    this.displayHelpDialog = true;
  }
}
