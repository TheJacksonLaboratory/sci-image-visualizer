import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { NAPARI_DECIMATE_OPTIONS, NAPARI_DEFAULT_DECIMATE } from '../../contracts/plot-type';

/**
 * The toolbar's view group: 2D zoom / pan tools, or for a 3D view the camera
 * modes and reset, the napari axes and wireframe toggles and the 3D
 * resolution. Presentational: the host owns every value.
 */
@Component({
  selector: 'toolbar-view-controls',
  templateUrl: './view-controls.component.html',
  styleUrls: ['./view-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewControlsComponent {
  /** A 2D view (zoom tools) rather than a 3D one (camera controls). */
  @Input() isHeatmap = true;
  /** The host shows the zoom tools. */
  @Input() zoomTools = true;
  /** The OSD Image view (pans natively; no Plotly drag-zoom). */
  @Input() isImageView = true;
  @Input() activeDragMode: string | null = null;
  @Input() activeSurface3dMode = 'turntable';
  @Input() isNapariMode = false;
  @Input() isNapariSurfaceMode = false;
  @Input() isNapari3dMode = false;
  @Input() axesVisible = true;
  @Input() wireframeActive = false;
  /** Active napari 3D decimate factor (1 = Full … 8 = ⅛). */
  @Input() resolutionScale = NAPARI_DEFAULT_DECIMATE;

  @Output() toggleDragMode = new EventEmitter<string>();
  @Output() zoomIn = new EventEmitter<void>();
  @Output() zoomOut = new EventEmitter<void>();
  @Output() toggleSurface3dMode = new EventEmitter<string>();
  @Output() resetSurfaceCamera = new EventEmitter<void>();
  @Output() toggleAxes = new EventEmitter<void>();
  @Output() toggleWireframe = new EventEmitter<void>();
  @Output() selectResolution = new EventEmitter<number>();

  /** Decimate-factor options for the Resolution dropdown. */
  readonly decimateOptions = NAPARI_DECIMATE_OPTIONS;
}
