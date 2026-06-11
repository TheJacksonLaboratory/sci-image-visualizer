import { Component, EventEmitter, Input, Output } from '@angular/core';

import { IImageInfo } from '../contracts/image.contract';
import { PlotType, PlotTypeDescriptor } from '../contracts/plot-type';

/**
 * Presentational toolbar for the plotting viewport.
 *
 * Renders the plot-type selector, colormap/LUT controls, stack navigation,
 * image actions (download / autoscale / pipeline), viewport zoom/pan, the
 * Surface-3D camera controls, and the region-drawing tools — plus the plotting
 * help dialog. It owns no rendering or visualization state: the host
 * (VisualizationComponent) stays the orchestrator, passing state in via `@Input` and
 * handling every action via `@Output`. The same actions are also driven by the
 * diagram's right-click context menu and keyboard shortcuts, so keeping the
 * handlers in the host avoids duplicating that logic.
 */
@Component({
  // Canonical prefixed selector first; the unprefixed original is kept as an
  // alias for one release (pre-publication back-compat).
  selector: 'jaxviz-toolbar, plotting-toolbar',
  templateUrl: './toolbar.component.html',
  styleUrls: ['./toolbar.component.scss'],
})
export class ToolbarComponent {
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
  @Input() wandSensitivity = 2.0;
  @Input() vertexEraserRadius = 20;
  @Input() stackOptions: { name: string; val: string }[] =
    [{ name: 'Single image', val: 'false' }, { name: 'Stack', val: 'true' }];

  @Output() selectPlotType = new EventEmitter<PlotType>();
  /** Intensity (LINE) mode: add another colored line ROI + inset trace. */
  @Output() addProfileLine = new EventEmitter<void>();
  // PrimeNG slider/inputNumber change events carry optional values, mirrored by
  // the host handlers (which accept `| undefined`).
  @Output() isoRangeChange = new EventEmitter<number[] | undefined>();
  /** Open the Channels & Histogram dialog (brightness/contrast, colormap, …). */
  @Output() openChannelHistogram = new EventEmitter<void>();
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
  @Output() deleteRegion = new EventEmitter<void>();
  /** Convert the selected region to/from a bezier curve (toBezier / toPolygon). */
  @Output() toBezierRegion = new EventEmitter<void>();
  @Output() toPolygonRegion = new EventEmitter<void>();
  @Output() wandSensitivityChange = new EventEmitter<number | undefined>();
  @Output() vertexEraserRadiusChange = new EventEmitter<number | undefined>();

  /** Sliders' bounds — toolbar UI constants (the values are host-owned). */
  readonly wandSensitivityMin = 0.5;
  readonly wandSensitivityMax = 10.0;
  readonly wandSensitivityStep = 0.1;
  readonly vertexEraserRadiusMin = 5;
  readonly vertexEraserRadiusMax = 300;
  readonly vertexEraserRadiusStep = 5;
  readonly isoValueMin = 0;
  readonly isoValueMax = 255;
  readonly isoValueStep = 1;

  displayHelpDialog = false;

  /** The Image plot type renders as a natively pan/zoom-able raster, so the
   *  generic zoom/pan tools are hidden. */
  get isImageView(): boolean {
    return this.selectedPlotType === PlotType.IMAGE;
  }

  /** ISOSURFACE shows the isovalue range slider. */
  get isIsosurfaceMode(): boolean {
    return this.selectedPlotType === PlotType.ISOSURFACE;
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
