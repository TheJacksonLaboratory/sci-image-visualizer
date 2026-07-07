import { Observable } from 'rxjs';

import { IDisplayOptions, IRegionStore } from '../contracts/visualizer.contract';
import { Region } from '../models/region';
import { ColormapNode } from '../contracts/display-types';
import { IImageMetadata } from '../contracts/image.contract';
import { RegionStore } from '../store/region-store.service';
import { VisualizerStore } from '../store/visualizer-store.service';

/**
 * Shared store-delegation base for the OpenSeadragon and napari-js
 * `IVisualizer` backends. The entire `IRegionStore` and `IDisplayOptions`
 * surfaces (plus the two classification-colour members) are pure forwarders to
 * the shared `RegionStore` / `VisualizerStore` in BOTH backends — so they live
 * here once, as a single source of truth, rather than being copied per backend.
 * (This is the "cross-backend behaviour that isn't rendering belongs in a
 * shared abstraction" convention from CLAUDE.md; the extraction closes
 * SHARED-BACKEND-REFACTOR.md.)
 *
 * Backend-specific members — `load`/`plot`/`reset`/zoom/`setZIndex`/readback,
 * the region OVERLAY, tool wiring, histograms, scale bar, tiling, colormap LUT
 * application — deliberately stay in each subclass.
 *
 * NOT `@Injectable`: an abstract base doesn't participate in Angular DI. Each
 * subclass stays `@Injectable`, declares its own injected dependencies
 * (including the two stores), and passes them to `super(...)`. Plotly is
 * intentionally not a subclass — it has its own region model.
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
  plotPreviousShapes(): void { this.regionStore.plotPreviousShapes(); }
  setPreviousShapes(shapes: any[]): void { this.regionStore.setPreviousShapes(shapes); }
  getPreviousShapes(): any[] { return this.regionStore.getPreviousShapes(); }
  undo(): void { this.regionStore.undo(); }
  redo(): void { this.regionStore.redo(); }
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
  setDisplaySlice(z: number): void { this.regionStore.setDisplaySlice(z); }
  getSliceRegions(): Region[] { return this.regionStore.getSliceRegions(); }

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
  setReverseScale(reverscale: any): void { this.store.setReverseScale(reverscale); }
  setImageMeta(imageMeta: IImageMetadata[]): void { this.store.setImageMeta(imageMeta); }
  getImageMeta(): Observable<IImageMetadata[]> { return this.store.getImageMeta(); }
}
