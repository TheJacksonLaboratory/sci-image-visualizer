import { NgZone } from '@angular/core';
import { Observable } from 'rxjs';

import { CanvasToolOptions } from '../contracts/display-types';
import { PlotModeBrushClass, PlotModeTools } from '../contracts/plot-type-contribution.contract';
import { RegionToolMode } from '../contracts/region-overlay.contract';
import { IVisualizer } from '../contracts/visualizer.contract';

/** The backend members tool arming drives. */
export type ToolModesTarget = Pick<IVisualizer, 'getRegionOverlay' | 'setDragMode' | 'setActiveTool' |
  'setWandOptions' | 'setBrushOptions' | 'setVertexEraserRadius'>;

/** Where the armed tool is recorded for everyone else (the shared session store). */
export interface ActiveToolRecord {
  setActiveTool(id: string | null): void;
  getActiveTool$(): Observable<string | null>;
}

/** Region draw/select/edit modes, routed through the backend's region overlay. The vertex
 *  tools (drawpolygon/addpoint/deletepoint/move) are handled by the OpenSeadragon overlay;
 *  Plotly's overlay maps them to no-op. */
const REGION_MODES: ReadonlySet<string> = new Set([
  'drawrect', 'drawclosedpath', 'drawopenpath', 'select', 'drawpolygon', 'addpoint', 'deletepoint', 'move',
]);

/**
 * The armed tool mode (one at a time across the region overlay, the viewport drag
 * modes and the on-canvas tools) and the toolbar's tool settings it arms them with.
 */
export class ToolModes {
  /** The armed mode, or null. */
  active: string | null = null;
  /** Wand sensitivity — higher = stricter (smaller selection). Matches QuPath default. */
  wandSensitivity = 2.0;
  /** Brush diameter in image-pixel coordinates (drives the painted disc size). */
  brushSize = 40;
  /** Vertex eraser radius in image-pixel coordinates. */
  vertexEraserRadius = 20;
  /** The toolbar tools a contributed plot mode may arm. Calls can come from outside
   *  Angular, hence the zone. */
  readonly plotModeTools: PlotModeTools;
  /** Class the brush paints while a plot mode armed it; null = plain brush. */
  private brushClass: PlotModeBrushClass | null = null;

  constructor(
    private readonly target: ToolModesTarget,
    private readonly record: ActiveToolRecord,
    zone: NgZone,
    /** Runs after every arm/disarm with the newly armed mode. */
    private readonly armed: (mode: string | null) => void,
    markForCheck: () => void,
  ) {
    this.plotModeTools = {
      armBrush: (brushClass?: PlotModeBrushClass) => zone.run(() => {
        this.brushClass = { label: brushClass?.label, color: brushClass?.color };
        if (this.active === 'brush') this.target.setBrushOptions({ size: this.brushSize, ...this.brushClass });
        else this.apply('brush');
        markForCheck();
      }),
      disarm: () => zone.run(() => {
        this.brushClass = null;
        if (this.active !== null) this.apply(null);
        markForCheck();
      }),
      activeTool$: record.getActiveTool$(),
    };
  }

  /** A tool picked by the user (always the plain tool, never a plot mode's brush class);
   *  re-picking the armed one disarms it. */
  toggle(mode: string): void {
    this.brushClass = null;
    this.apply(this.active === mode ? null : mode);
  }

  /** Arm `mode` (or nothing) across every tool. */
  apply(mode: string | null): void {
    this.active = mode;
    this.record.setActiveTool(mode);
    const regionMode = mode !== null && REGION_MODES.has(mode);
    this.target.getRegionOverlay()?.setMode(regionMode ? (mode as RegionToolMode) : 'none');
    // Viewport drag modes (pan/box-zoom). Region modes own the drag mode via the overlay.
    if (!regionMode) this.target.setDragMode(mode === 'pan' || mode === 'zoom' ? mode : false);
    // On-canvas tools: arm the one this mode names (none for a region or viewport mode).
    this.target.setActiveTool(mode, this.options(mode));
    this.armed(mode);
  }

  /** Disarm whatever is armed and clear every tool mode (a plot-type switch). */
  deactivate(): void {
    this.brushClass = null;
    this.active = null;
    this.record.setActiveTool(null);
    this.target.getRegionOverlay()?.setMode('none');
    this.target.setDragMode(false);
    this.target.setActiveTool(null);
  }

  setWandSensitivity(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value)) return;
    this.wandSensitivity = value;
    this.target.setWandOptions({ sensitivity: value });
  }

  setBrushSize(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value)) return;
    this.brushSize = value;
    this.target.setBrushOptions({ size: value });
  }

  setVertexEraserRadius(value: number | undefined): void {
    if (value === undefined || !Number.isFinite(value)) return;
    this.vertexEraserRadius = value;
    this.target.setVertexEraserRadius(value);
  }

  /** The options a canvas tool is armed with, from the toolbar's settings. */
  private options(mode: string | null): CanvasToolOptions | undefined {
    switch (mode) {
      case 'wand': return { sensitivity: this.wandSensitivity };
      case 'brush': return { size: this.brushSize, ...this.brushClass };
      case 'eraseVertex': return { radius: this.vertexEraserRadius };
      default: return undefined;
    }
  }
}
