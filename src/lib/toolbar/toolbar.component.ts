import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { RippleModule } from 'primeng/ripple';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';

import { IImageInfo } from '../contracts/image.contract';
import {
  PlotType,
  PlotTypeId,
  isBuiltinPlotType,
  isNapari3d,
  isNapariIsosurface,
  isNapariSurface,
  isNapariScatter,
  NAPARI_DEFAULT_DECIMATE,
  isSpatialOmics,
  isSpatialOmics3d,
} from '../contracts/plot-type';
import { ToolbarToolVisibility, ALL_TOOLBAR_TOOLS } from '../contracts/toolbar-config';
import { ToolbarDialogToolContribution, ToolbarToolContribution } from '../contracts/toolbar-tool.contract';
import { PlotTypeOption } from '../contracts/plot-type-contribution.contract';
import { ToolbarHelpDialogComponent } from './toolbar-help-dialog/toolbar-help-dialog.component';
import { PlotTypeSelectorComponent } from './plot-type-selector/plot-type-selector.component';
import { StackControlsComponent } from './stack-controls/stack-controls.component';
import { ViewControlsComponent } from './view-controls/view-controls.component';
import { RegionToolsComponent } from './region-tools/region-tools.component';
import { SegmentationToolsComponent } from './segmentation-tools/segmentation-tools.component';

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
  selector: 'plotting-toolbar',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    RippleModule,
    ToolbarModule,
    TooltipModule,
    ToolbarHelpDialogComponent,
    PlotTypeSelectorComponent,
    StackControlsComponent,
    ViewControlsComponent,
    RegionToolsComponent,
    SegmentationToolsComponent,
  ],
  templateUrl: './toolbar.component.html',
  styleUrls: ['./toolbar.component.scss'],
  // Purely @Input/@Output: re-check only when an input changes or the toolbar
  // itself handles an event, not on every app tick (its ~15 getters ran each
  // time). Controls bind [ngModel] one-way and report through the outputs, so
  // the host stays the owner of every value (RT-35).
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolbarComponent {
  /** Current image (gates which control groups are shown). */
  @Input() imageInfo: IImageInfo | undefined;
  /** A spatial dataset is on offer: its plot modes are a choice even with no image loaded. */
  @Input() hasSpatialDataset = false;

  /** Whether the plot-type dropdown shows: for an image, or a spatial dataset with none. */
  protected get showPlotTypes(): boolean {
    return !!(this.imageInfo || this.hasSpatialDataset) && !!this.tools.specialTools;
  }
  /** Plot types the active backend advertises, then any contributed modes. */
  @Input() plotTypeOptions: PlotTypeOption[] = [];
  /** The selector's value: a built-in type or a contributed mode's id. */
  @Input() selectedPlotType: PlotTypeId = PlotType.IMAGE;
  /**
   * The built-in type that renders {@link selectedPlotType} — its `baseType`
   * for a contributed mode. Every tool/control decision below reads
   * {@link effectivePlotType}, so a contributed mode gets exactly its base
   * type's toolbar. When unbound, a built-in selection is its own base and
   * anything else is treated as the default Image view.
   */
  @Input() basePlotType: PlotType | null = null;
  /** Isosurface band as a 0–255 slider position (mapped onto the volume's real
   *  intensity range by the renderer). Defaults to the full range. */
  @Input() isoRange: number[] = [0, 255];
  /** The last slice index of a stack. */
  @Input() maxIndex = 0;
  /** The current slice (0-based). */
  @Input() zIndex = 0;
  /** True for any 2D (non Surface-3D) plot type. */
  @Input() isHeatmap = true;
  /**
   * Region tools apply even though this is a 3D view, because they draw a
   * SCREEN-SPACE lasso (the 3D spatial cloud). Separate from {@link isHeatmap},
   * which means "2D view" and also drives the zoom tools and the 3D camera
   * controls — flipping that would show 2D pan/zoom and hide the orbit controls.
   */
  @Input() is3dRegions = false;
  /** The armed tool's mode (zoom, pan, a drawing tool, `samPoint`, …), or null. */
  @Input() activeDragMode: string | null = null;
  /** The 3D camera mode (`turntable` / `orbit` / …). */
  @Input() activeSurface3dMode = 'turntable';
  /** Whether the napari 3D axes/scale gizmo is currently shown (drives the toggle's look). */
  @Input() axesVisible = true;
  /** The napari surface wireframe is on. */
  @Input() wireframeActive = false;
  /** Active napari 3D decimate factor (1 = Full … 8 = ⅛; default ½). */
  @Input() resolutionScale = NAPARI_DEFAULT_DECIMATE;
  /** Magic-wand sensitivity. */
  @Input() wandSensitivity = 2.0;
  /** Brush diameter in image pixels. */
  @Input() brushSize = 40;
  /** Vertex-eraser radius in image pixels. */
  @Input() vertexEraserRadius = 20;
  /** Whether a region action is available to undo (jit-ui#85). Greys out the
   *  Undo button when false (nothing done yet, or all steps already undone). */
  @Input() canUndo = false;
  /** Whether an undone region action is available to redo (jit-ui#85). Greys
   *  out the Redo button when false. */
  @Input() canRedo = false;
  /** The single-image / stack choices of the Plotly stack toggle. */
  @Input() stackOptions: { name: string; val: string }[] = [
    { name: 'Single image', val: 'false' },
    { name: 'Stack', val: 'true' },
  ];
  /** Which toolbar groups to show. Defaults to the full toolbar; the host forwards
   *  the consumer's choice (e.g. the pipeline shows only zoom + region tools). */
  @Input() tools: Required<ToolbarToolVisibility> = ALL_TOOLBAR_TOOLS;
  /** Current image-smoothing state (drives the Smoothen toggle button look).
   *  `false` = nearest-neighbour (crisp raw pixels), the default. */
  @Input() imageSmoothingEnabled = false;
  /** SAM model picker options + current selection (jit-ui#90 P1). */
  @Input() samModels: { id: string; label: string }[] = [];
  /** The selected SAM model id. */
  @Input() samModelId = '';
  /**
   * Tools contributed through {@link TOOLBAR_TOOLS}, already filtered to the
   * ones with models and sorted. The host resolves them so it can own the
   * per-tool parameter state; this component only draws them.
   */
  @Input() contributedTools: ToolbarToolContribution[] = [];
  /** Dialog tools (TOOLBAR_TOOLS, kind: 'dialog'), sorted; shown in the Image view. */
  @Input() dialogTools: ToolbarDialogToolContribution[] = [];
  /** Id of the dialog tool whose dialog is open, or null. */
  @Input() openDialogToolId: string | null = null;
  /** Active checkpoint per contributed tool, keyed by tool id. */
  @Input() toolModelIds: Record<string, string> = {};

  /** A plot type or contributed mode was picked. */
  @Output() selectPlotType = new EventEmitter<PlotTypeId>();
  /** Intensity (LINE) mode: add another colored line ROI + inset trace. */
  @Output() addProfileLine = new EventEmitter<void>();
  /** Toggle image smoothing (bilinear) vs nearest-neighbour (crisp pixels). */
  @Output() toggleImageSmoothing = new EventEmitter<void>();
  // PrimeNG slider/inputNumber change events carry optional values, mirrored by
  // the host handlers (which accept `| undefined`).
  /** The isosurface band slider moved: the new `[low, high]` pair. */
  @Output() isoRangeChange = new EventEmitter<number[] | undefined>();
  /** Open the Channels & Histogram dialog (brightness/contrast, colormap, …). */
  @Output() openChannelHistogram = new EventEmitter<void>();
  /** Open the spatial-omics controls (colour-by, legend, point display). */
  @Output() openSpatialControls = new EventEmitter<void>();
  /** Open the Region Editor dialog. */
  @Output() openRegionEditor = new EventEmitter<void>();
  /** A single-image / stack choice was picked. */
  @Output() selectStackOption = new EventEmitter<{ name: string; val: string }>();
  /** The live slice scrubber moved (fires while dragging). */
  @Output() zScrub = new EventEmitter<number | undefined>();
  /** The live slice scrubber was released on a slice. */
  @Output() zSlide = new EventEmitter<number | undefined>();
  /** A slice number was typed. */
  @Output() zIndexInput = new EventEmitter<number>();
  /** Re-plot at the typed slice. */
  @Output() reloadAndPlot = new EventEmitter<void>();
  /** Download the current view as PNG. */
  @Output() downloadImage = new EventEmitter<void>();
  /** Fit the image to the view. */
  @Output() autoscaleImage = new EventEmitter<void>();
  /** A zoom / pan / drawing tool button was clicked (its mode). */
  @Output() toggleDragMode = new EventEmitter<string>();
  /** Zoom in one step. */
  @Output() zoomIn = new EventEmitter<void>();
  /** Zoom out one step. */
  @Output() zoomOut = new EventEmitter<void>();
  /** A 3D camera mode button was clicked (its mode). */
  @Output() toggleSurface3dMode = new EventEmitter<string>();
  /** Reset the 3D camera. */
  @Output() resetSurfaceCamera = new EventEmitter<void>();
  /** Toggle the napari 3D coordinate-axes / scale gizmo on/off. */
  @Output() toggleAxes = new EventEmitter<void>();
  /** Toggle the napari surface wireframe (edges) on/off. */
  @Output() toggleWireframe = new EventEmitter<void>();
  /** Change the napari 3D decimate factor (reloads at the new resolution). */
  @Output() selectResolution = new EventEmitter<number>();
  /** Delete the selected region. */
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
  /** A dialog tool's button was clicked: open its dialog, or close it if open. */
  @Output() toggleDialogTool = new EventEmitter<string>();
  /** Pick a contributed tool's checkpoint. */
  @Output() toolModelChange = new EventEmitter<{ toolId: string; modelId: string }>();
  /** Open a contributed tool's parameter dialog, by tool id. */
  @Output() openToolParams = new EventEmitter<string>();
  /** SAM model picker (jit-ui#90 P1). */
  @Output() samModelChange = new EventEmitter<string>();
  /** The wand sensitivity slider moved. */
  @Output() wandSensitivityChange = new EventEmitter<number | undefined>();
  /** The brush size slider moved. */
  @Output() brushSizeChange = new EventEmitter<number | undefined>();
  /** The vertex-eraser radius slider moved. */
  @Output() vertexEraserRadiusChange = new EventEmitter<number | undefined>();

  protected displayHelpDialog = false;

  /** trackBy for the dialog tools' buttons. */
  protected trackToolById(_index: number, tool: { id: string }): string {
    return tool.id;
  }

  /** The built-in type whose tools and controls apply to the current selection. */
  protected get effectivePlotType(): PlotType {
    if (this.basePlotType) return this.basePlotType;
    return isBuiltinPlotType(this.selectedPlotType) ? this.selectedPlotType : PlotType.IMAGE;
  }

  /** The Image plot type renders as a natively pan/zoom-able raster, so the
   *  generic zoom/pan tools are hidden. */
  protected get isImageView(): boolean {
    return this.effectivePlotType === PlotType.IMAGE;
  }

  /** Either spatial-omics mode is active, so its controls are worth offering.
   *  The 3D cloud needs the panel MORE than the 2D view does, not less: colouring,
   *  the legend and category show/hide are the only way to make sense of a
   *  million overlapping points. */
  protected get isSpatialMode(): boolean {
    return isSpatialOmics(this.effectivePlotType) || isSpatialOmics3d(this.effectivePlotType);
  }

  /** Backends with a vertex-editing region overlay: OSD Image and napari-js WebGPU image
   *  (jit-ui#102). Gates the polygon / add-vertex / delete-vertex / Bézier-convert tools. */
  protected get supportsRegionVertexTools(): boolean {
    return this.effectivePlotType === PlotType.IMAGE || this.effectivePlotType === PlotType.NAPARI_IMAGE;
  }

  /** Plot types that scrub a z-stack live (the renderer swaps the slice in place): the OSD Image
   *  view, the napari-js WebGPU image, the napari-js surface — which rebuilds the height field
   *  from the picked slice (jit-ui#102) — and the 2D spatial-omics view, where a 3D dataset's
   *  registered volume is the image and the slider picks the section whose observations are
   *  drawn. Drives the per-slice slider. */
  protected get showsLiveSliceScrubber(): boolean {
    return (
      this.effectivePlotType === PlotType.IMAGE ||
      this.effectivePlotType === PlotType.NAPARI_IMAGE ||
      isNapariSurface(this.effectivePlotType) ||
      isNapariScatter(this.effectivePlotType) ||
      isSpatialOmics(this.effectivePlotType)
    );
  }

  /** Any napari-js WebGPU plot type. The single-image/stack toggle + slice-number field are
   *  Plotly-only stack controls, so they're hidden for napari (jit-ui#102). */
  protected get isNapariMode(): boolean {
    return (
      this.effectivePlotType === PlotType.NAPARI_IMAGE ||
      isNapariScatter(this.effectivePlotType) ||
      isNapari3d(this.effectivePlotType)
    );
  }

  /** ISOSURFACE (Plotly or napari-js WebGPU, either resolution) shows the isovalue range slider. */
  protected get isIsosurfaceMode(): boolean {
    return this.effectivePlotType === PlotType.ISOSURFACE || isNapariIsosurface(this.effectivePlotType);
  }

  /** The napari-js WebGPU surface — shows the wireframe toggle. */
  protected get isNapariSurfaceMode(): boolean {
    return isNapariSurface(this.effectivePlotType);
  }

  /** Any napari-js WebGPU 3D type (volume/isosurface/surface) — shows the Resolution control. */
  protected get isNapari3dMode(): boolean {
    return isNapari3d(this.effectivePlotType);
  }

  /** Intensity profile lines are Region-based and available in the Heatmap and
   *  Image plot types, which show the Intensity tool group. */
  protected get isIntensityCapable(): boolean {
    return this.effectivePlotType === PlotType.HEATMAP || this.effectivePlotType === PlotType.IMAGE;
  }

  protected showHelp(): void {
    this.displayHelpDialog = true;
  }
}
