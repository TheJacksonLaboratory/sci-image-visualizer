import { Observable } from 'rxjs';

import { IDisplayOptions, IRegionStore } from '../contracts/visualizer.contract';
import { Region } from '../models/region';
import {
  CanvasToolId, CanvasToolOptions, ColormapNode, IBrushOptions, IWandOptions,
} from '../contracts/display-types';
import type { CanvasToolManager } from '../toolbar/tool-kit/canvas-tool-manager';
import type { SamPointTool } from '../toolbar/segmentation/sam-point-tool.service';
import { IImageMetadata } from '../contracts/image.contract';
import { RegionStore } from '../store/region-store.service';
import { VisualizerStore } from '../store/visualizer-store.service';

/**
 * Shared store-delegation base for the OpenSeadragon, napari-js and Plotly
 * `IVisualizer` backends. The entire `IRegionStore` and `IDisplayOptions`
 * surfaces (plus the two classification-colour members) are pure forwarders to
 * the shared `RegionStore` / `VisualizerStore` — so they live here once, as a
 * single source of truth, rather than being copied per backend. (This is the
 * "cross-backend behaviour that isn't rendering belongs in a shared
 * abstraction" convention from CLAUDE.md; see
 * docs/history/2026-07-shared-backend-refactor.md.)
 *
 * The on-canvas tool controls (`setActiveTool` and the per-tool setters) live
 * here too: each subclass creates its own {@link CanvasToolManager} over its own
 * tool host and gates pointer/readback in {@link beforeToolChange}.
 *
 * Backend-specific members — `load`/`plot`/`reset`/zoom/`setZIndex`/readback,
 * the region OVERLAY, the tool host, SAM/Cellpose runs, histograms, scale bar,
 * tiling, colormap LUT application — deliberately stay in each subclass. Plotly keeps a Plotly-shape
 * working-set beside the store, so it overrides the handful of members that
 * must also redraw it (`setRegions`, selection, delete, colormap, reverse
 * scale, and `exportRegions` for the file name).
 *
 * NOT `@Injectable`: an abstract base doesn't participate in Angular DI. Each
 * subclass stays `@Injectable`, declares its own injected dependencies
 * (including the two stores), and passes them to `super(...)`.
 */
export abstract class BaseStoreVisualizer implements IRegionStore, IDisplayOptions {
  protected constructor(
    protected readonly regionStore: RegionStore,
    protected readonly store: VisualizerStore,
  ) {}

  // ── IRegionStore → shared RegionStore ────────────────────────────────────
  setRegions(regions: Region[], showRegionLabel?: boolean, isRegionSaveOn?: boolean,
             fillColor?: string, append?: boolean): void {
    this.regionStore.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
  }
  getRegions(): Region[] { return this.regionStore.getRegions(); }
  getRegionPolygons(): any[] { return this.regionStore.getRegionPolygons(); }
  getRegionUpdateEvent(): Observable<any[]> { return this.regionStore.getRegionUpdateEvent(); }
  setSelectedShapeIndices(indices: number[]): void { this.regionStore.setSelectedShapeIndices(indices); }
  getSelectedShapeIndices$(): Observable<number[]> { return this.regionStore.getSelectedShapeIndices$(); }
  selectRegion(region: Region): void { this.regionStore.selectRegion(region); }
  deleteActiveShape(): void { this.regionStore.deleteActiveShape(); }
  getShowShapeLabel(): boolean { return this.regionStore.getShowShapeLabel(); }
  getShapeColor(): string { return this.regionStore.getShapeColor(); }
  getFillColor(): string { return this.regionStore.getFillColor(); }
  // Undo/redo replace the regions a stroke or SAM prompt was building on.
  undo(): void { this.regionStore.undo(); this.canvasTools.resetAll(); }
  redo(): void { this.regionStore.redo(); this.canvasTools.resetAll(); }
  canUndo(): boolean { return this.regionStore.canUndo(); }
  canRedo(): boolean { return this.regionStore.canRedo(); }
  getCanUndo$(): Observable<boolean> { return this.regionStore.getCanUndo$(); }
  getCanRedo$(): Observable<boolean> { return this.regionStore.getCanRedo$(); }
  resetUndoHistory(): void { this.regionStore.resetUndoHistory(); }
  importRegions(geoJsonStr: string): Region[] { return this.regionStore.importRegions(geoJsonStr); }
  exportRegions(regions: Region[]): void { this.regionStore.exportRegions(regions); }
  getGeoJsonString(regions: Region[]): string { return this.regionStore.getGeoJsonString(regions); }

  // ── Per-slice z-stack regions → RegionStore (jit-ui#93) ──────────────────
  enterStackMode(slices: Map<number, Region[]>, initialZ?: number,
                 saveLayout?: 'combined' | 'per-slice-file'): void {
    this.regionStore.enterStackMode(slices, initialZ, saveLayout);
  }
  exitStackMode(): void { this.regionStore.exitStackMode(); }
  isStackMode(): boolean { return this.regionStore.isStackMode(); }
  getStackSaveLayout(): 'combined' | 'per-slice-file' { return this.regionStore.getStackSaveLayout(); }
  setDisplaySlice(z: number): void {
    this.regionStore.setDisplaySlice(z);
    this.canvasTools.resetAll(); // another slice's regions
  }
  getSliceRegions(): Region[] { return this.regionStore.getSliceRegions(); }
  getStackSaveSlices(): Map<number, Region[]> { return this.regionStore.getStackSaveSlices(); }

  // ── IToolController: on-canvas tools → this backend's CanvasToolManager ──

  /** This backend's canvas tools, created by the subclass over its own host. */
  protected abstract readonly canvasTools: CanvasToolManager;

  /**
   * Runs before every tool change, for the backend's pointer and readback
   * gating (pan/zoom off while a tool holds the pointer, a fresh pixel
   * readback). Return false to arm nothing; the armed tool is disarmed anyway.
   */
  protected beforeToolChange(_next: CanvasToolId | null): boolean {
    return true;
  }

  /**
   * Arm one on-canvas tool, disarming the armed one; null — or any id that is
   * not a canvas tool (a region draw mode, pan) — disarms only. Re-arming the
   * armed tool applies `options` and keeps its work in progress.
   */
  setActiveTool(id: string | null, options?: CanvasToolOptions): void {
    const next = this.canvasTools.has(id) ? id : null;
    if (!this.beforeToolChange(next)) {
      this.canvasTools.deactivate();
      return;
    }
    this.canvasTools.activate(next, options);
  }

  /** @deprecated Use {@link setActiveTool}(`'wand'`, options) / (null). */
  setWandMode(active: boolean, options?: IWandOptions): void { this.setToolMode('wand', active, options); }
  setWandOptions(options: IWandOptions): void { this.canvasTools.setOptions('wand', options); }
  clearActiveWandRegion(): void { this.canvasTools.reset('wand'); }
  /** @deprecated Use {@link setActiveTool}(`'brush'`, options) / (null). */
  setBrushMode(active: boolean, options?: IBrushOptions): void { this.setToolMode('brush', active, options); }
  setBrushOptions(options: IBrushOptions): void { this.canvasTools.setOptions('brush', options ?? {}); }
  /** @deprecated Use {@link setActiveTool}(`'eraseVertex'`, { radius }) / (null). */
  setVertexEraserMode(active: boolean): void { this.setToolMode('eraseVertex', active); }
  setVertexEraserRadius(radius: number): void { this.canvasTools.setOptions('eraseVertex', { radius }); }
  /** @deprecated Use {@link setActiveTool}(`'zoomToBox'`) / (null). */
  setZoomToBoxMode(active: boolean): void { this.setToolMode('zoomToBox', active); }
  /** @deprecated Use {@link setActiveTool}(`'samPoint'`) / (null). */
  setSamPointMode(active: boolean): void { this.setToolMode('samPoint', active); }
  commitSamPoints(): void { this.canvasTools.get<SamPointTool>('samPoint')?.commit(); }
  clearSamPoints(): void { this.canvasTools.get<SamPointTool>('samPoint')?.clear(); }

  /** A per-tool setter: arm `id`, or disarm it if it is the armed tool. */
  private setToolMode(id: CanvasToolId, active: boolean, options?: CanvasToolOptions): void {
    if (active) this.setActiveTool(id, options);
    else if (this.canvasTools.activeId === id) this.setActiveTool(null);
  }

  // ── View lifetime ─────────────────────────────────────────────────────────

  /** Drop what is bound to the view (each backend's own teardown). */
  abstract unsubscribe(): void;

  /** The view is going away: release what is bound to it (`IViewerBackend.detach`). */
  detach(): void { this.unsubscribe(); }

  // ── Classification colours → shared VisualizerStore ──────────────────────
  getClassificationColors(): Map<string, string> { return this.store.getClassificationColors(); }
  setClassificationColor(label: string, color: string): void {
    this.store.setClassificationColor(label, color);
  }

  // ── IDisplayOptions → shared VisualizerStore ─────────────────────────────
  getColormap(): Observable<ColormapNode | null> { return this.store.getColormap(); }
  setColormap(colormap: ColormapNode): void { this.store.setColormap(colormap); }
  getColormapOptions(): ColormapNode[] { return this.store.getColormapOptions(); }
  getReverseScale(): Observable<boolean> { return this.store.getReverseScale(); }
  setReverseScale(reverscale: boolean): void { this.store.setReverseScale(reverscale); }
  setImageMeta(imageMeta: IImageMetadata[]): void { this.store.setImageMeta(imageMeta); }
  getImageMeta(): Observable<IImageMetadata[]> { return this.store.getImageMeta(); }
}
