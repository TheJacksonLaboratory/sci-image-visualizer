import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { REGION_TOOL_BUTTONS, RegionToolButton } from './region-tool-buttons';

/**
 * The toolbar's region group: open the Region Editor, the drawing tools (one
 * table-driven toggle per {@link REGION_TOOL_BUTTONS} entry, with the active
 * tool's parameter slider), undo / redo and delete. Presentational: the host
 * owns the active mode and every value.
 */
@Component({
  selector: 'toolbar-region-tools',
  templateUrl: './region-tools.component.html',
  styleUrls: ['./region-tools.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionToolsComponent {
  @Input() activeDragMode: string | null = null;
  /** The 3D cloud's screen-space lasso: no brush or polyline. */
  @Input() is3dRegions = false;
  /** The backend has a vertex-editing overlay (OSD + napari-js image). */
  @Input() vertexTools = false;
  @Input() wandSensitivity = 2.0;
  @Input() brushSize = 40;
  @Input() vertexEraserRadius = 20;
  @Input() canUndo = false;
  @Input() canRedo = false;

  @Output() openRegionEditor = new EventEmitter<void>();
  @Output() toggleDragMode = new EventEmitter<string>();
  @Output() undoRegion = new EventEmitter<void>();
  @Output() redoRegion = new EventEmitter<void>();
  @Output() deleteRegion = new EventEmitter<void>();
  @Output() wandSensitivityChange = new EventEmitter<number | undefined>();
  @Output() brushSizeChange = new EventEmitter<number | undefined>();
  @Output() vertexEraserRadiusChange = new EventEmitter<number | undefined>();

  readonly buttons = REGION_TOOL_BUTTONS;

  /** Slider bounds — toolbar UI constants (the values are host-owned). */
  readonly wandSensitivityMin = 0.5;
  readonly wandSensitivityMax = 10.0;
  readonly wandSensitivityStep = 0.1;
  readonly brushSizeMin = 5;
  readonly brushSizeMax = 300;
  readonly brushSizeStep = 5;
  readonly vertexEraserRadiusMin = 5;
  readonly vertexEraserRadiusMax = 300;
  readonly vertexEraserRadiusStep = 5;

  readonly trackByMode = (_: number, b: RegionToolButton): string => b.mode;

  shown(b: RegionToolButton): boolean {
    if (b.gate === 'not3d') return !this.is3dRegions;
    if (b.gate === 'vertex') return this.vertexTools;
    return true;
  }

  /** A single slider's value (a range slider never feeds these). */
  asNumber(v: number | number[] | undefined): number | undefined {
    return Array.isArray(v) ? v[0] : v;
  }
}
