import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { REGION_TOOL_BUTTONS, RegionToolButton } from './region-tool-buttons';
import { ToolSliderComponent } from '../tool-slider/tool-slider.component';

/**
 * The toolbar's region group: open the Region Editor, the drawing tools (one
 * table-driven toggle per {@link REGION_TOOL_BUTTONS} entry, with the active
 * tool's parameter slider), undo / redo and delete. Presentational: the host
 * owns the active mode and every value.
 */
@Component({
  selector: 'toolbar-region-tools',
  standalone: true,
  imports: [CommonModule, ButtonModule, TooltipModule, ToolSliderComponent],
  templateUrl: './region-tools.component.html',
  styleUrls: ['./region-tools.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionToolsComponent {
  /** The armed drawing tool's mode, or null. */
  @Input() activeDragMode: string | null = null;
  /** The 3D cloud's screen-space lasso: no brush or polyline. */
  @Input() is3dRegions = false;
  /** The backend has a vertex-editing overlay (OSD + napari-js image). */
  @Input() vertexTools = false;
  /** Magic-wand sensitivity (the wand's slider value). */
  @Input() wandSensitivity = 2.0;
  /** Brush diameter in image pixels. */
  @Input() brushSize = 40;
  /** Vertex-eraser radius in image pixels. */
  @Input() vertexEraserRadius = 20;
  /** A region action can be undone (enables Undo). */
  @Input() canUndo = false;
  /** An undone region action can be redone (enables Redo). */
  @Input() canRedo = false;

  /** Open the Region Editor dialog. */
  @Output() openRegionEditor = new EventEmitter<void>();
  /** A drawing tool's button was clicked (its mode). */
  @Output() toggleDragMode = new EventEmitter<string>();
  /** Undo the last region action. */
  @Output() undoRegion = new EventEmitter<void>();
  /** Redo the last undone region action. */
  @Output() redoRegion = new EventEmitter<void>();
  /** Delete the selected region. */
  @Output() deleteRegion = new EventEmitter<void>();
  /** The wand sensitivity slider moved. */
  @Output() wandSensitivityChange = new EventEmitter<number | undefined>();
  /** The brush size slider moved. */
  @Output() brushSizeChange = new EventEmitter<number | undefined>();
  /** The vertex-eraser radius slider moved. */
  @Output() vertexEraserRadiusChange = new EventEmitter<number | undefined>();

  protected readonly buttons = REGION_TOOL_BUTTONS;

  /** Slider bounds — toolbar UI constants (the values are host-owned). */
  protected readonly wandSensitivityMin = 0.5;
  protected readonly wandSensitivityMax = 10.0;
  protected readonly wandSensitivityStep = 0.1;
  protected readonly brushSizeMin = 5;
  protected readonly brushSizeMax = 300;
  protected readonly brushSizeStep = 5;
  protected readonly vertexEraserRadiusMin = 5;
  protected readonly vertexEraserRadiusMax = 300;
  protected readonly vertexEraserRadiusStep = 5;

  protected readonly trackByMode = (_: number, b: RegionToolButton): string => b.mode;

  protected shown(b: RegionToolButton): boolean {
    if (b.gate === 'not3d') return !this.is3dRegions;
    if (b.gate === 'vertex') return this.vertexTools;
    return true;
  }

  /** A single slider's value (a range slider never feeds these). */
  protected asNumber(v: number | number[] | undefined): number | undefined {
    return Array.isArray(v) ? v[0] : v;
  }
}
