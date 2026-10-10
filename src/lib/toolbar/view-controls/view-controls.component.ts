import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DropdownModule } from 'primeng/dropdown';
import { TooltipModule } from 'primeng/tooltip';

import { NAPARI_DECIMATE_OPTIONS, NAPARI_DEFAULT_DECIMATE } from '../../contracts/plot-type';

/**
 * The toolbar's view group: 2D zoom / pan tools, or for a 3D view the camera
 * modes and reset, the napari axes and wireframe toggles and the 3D
 * resolution. Presentational: the host owns every value.
 */
@Component({
  selector: 'toolbar-view-controls',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DropdownModule, TooltipModule],
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
  /** The armed zoom/pan tool (`zoom`, `pan`, …), or null. */
  @Input() activeDragMode: string | null = null;
  /** The 3D camera mode (`turntable` / `orbit` / …). */
  @Input() activeSurface3dMode = 'turntable';
  /** A napari-js WebGPU view (axes toggle, napari camera). */
  @Input() isNapariMode = false;
  /** The napari-js surface (shows the wireframe toggle). */
  @Input() isNapariSurfaceMode = false;
  /** A napari-js 3D view (shows the Resolution dropdown). */
  @Input() isNapari3dMode = false;
  /** The napari 3D axes gizmo is shown. */
  @Input() axesVisible = true;
  /** The napari surface wireframe is on. */
  @Input() wireframeActive = false;
  /** Active napari 3D decimate factor (1 = Full … 8 = ⅛). */
  @Input() resolutionScale = NAPARI_DEFAULT_DECIMATE;

  /** A zoom/pan tool button was clicked (its mode). */
  @Output() toggleDragMode = new EventEmitter<string>();
  /** Zoom in one step. */
  @Output() zoomIn = new EventEmitter<void>();
  /** Zoom out one step. */
  @Output() zoomOut = new EventEmitter<void>();
  /** A 3D camera mode button was clicked (its mode). */
  @Output() toggleSurface3dMode = new EventEmitter<string>();
  /** Reset the 3D camera. */
  @Output() resetSurfaceCamera = new EventEmitter<void>();
  /** Toggle the napari 3D axes gizmo. */
  @Output() toggleAxes = new EventEmitter<void>();
  /** Toggle the napari surface wireframe. */
  @Output() toggleWireframe = new EventEmitter<void>();
  /** A napari 3D decimate factor was picked. */
  @Output() selectResolution = new EventEmitter<number>();

  /** Decimate-factor options for the Resolution dropdown. */
  protected readonly decimateOptions = NAPARI_DECIMATE_OPTIONS;
}
