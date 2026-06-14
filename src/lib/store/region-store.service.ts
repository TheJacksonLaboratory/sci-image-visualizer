import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import { IImageInfo } from '../contracts/image.contract';
import { Region, Rectangle, Polygon } from '../models/region';
import { PlotUtilities } from '../plot.utilities';
import { VisualizerStore } from './visualizer-store.service';
import { defaultHandleOffsets } from '../models/bezier';
import { IRegionStore } from '../contracts/visualizer.contract';
import { IRegionEditApi } from '../contracts/region-store.contract';

/**
 * Backend-neutral region store — the single source of truth for region state.
 *
 * Holds the neutral {@link Region} model (never a backend's own shape
 * representation), keyed per image so regions persist as the user switches
 * files and survive a Plotly⇄OpenSeadragon backend switch (both backends read
 * and write *this* store, so no migration is needed). Backends own *rendering*
 * and react to {@link getRegionUpdateEvent}; this service owns *state* and the
 * editing operations.
 *
 * Implements:
 *  - {@link IRegionStore} — the cross-backend CRUD/selection/colour contract
 *    every consumer (Region Editor, segmentation, etc.) already uses.
 *  - {@link IRegionEditApi} — Region-native geometry edits (move/resize, and
 *    add/delete/move vertex) the OSD overlay drives.
 *
 * Classification colours live in {@link VisualizerStore} (shared by both
 * backends); GeoJSON import/export and the closed-polygon projection reuse the
 * neutral {@link PlotUtilities} helpers. All coordinates are image pixels.
 */
@Injectable({ providedIn: 'root' })
export class RegionStore implements IRegionStore, IRegionEditApi {

  private static readonly UNDO_LIMIT = 10;
  private static readonly UNDO_COALESCE_MS = 250;

  /** Per-image region cache. `regions` is always a snapshot of the entry for
   *  `currentImageKey`. */
  private regionsByImageKey = new Map<string, Region[]>();
  private currentImageKey: string | undefined;
  /** The current image's regions — the live, edited array. */
  private regions: Region[] = [];
  /** Last saved snapshot, restorable via plotPreviousShapes(). */
  private previousRegions: Region[] = [];

  /**
   * Undo/redo history (jit-ui#85): up to {@link UNDO_LIMIT} snapshots of the
   * region set, each a deep clone captured immediately *before* a
   * region-editing action. {@link undo} pops the newest off `undoStack`, pushes
   * the current state onto `redoStack`, and restores it — so it can be invoked
   * up to {@link UNDO_LIMIT} times in a row. {@link redo} is the mirror. Any new
   * region action clears `redoStack` (the redo future is no longer reachable).
   *
   * A continuous gesture (a wand/brush/vertex drag commits to the store many
   * times) is coalesced into a single entry: the first commit of a burst
   * captures the pre-burst state and every commit within
   * {@link UNDO_COALESCE_MS} of the previous one is folded into it. History
   * never crosses an image load/switch — {@link resetUndoHistory} clears it.
   */
  private undoStack: Region[][] = [];
  private redoStack: Region[][] = [];
  /** True while a coalescing burst is open (further commits fold into it). */
  private undoBurstOpen = false;
  private undoBurstTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while restoring a snapshot, so the restore records no new history. */
  private restoringUndo = false;
  private readonly canUndo$ = new BehaviorSubject<boolean>(false);
  private readonly canRedo$ = new BehaviorSubject<boolean>(false);

  /** Monotonic id source — ids never repeat within the service lifetime, so
   *  selection stays correct across delete/add cycles even when names collide. */
  private nextId = 1;

  private showShapeLabel = false;
  private shapeColor = '#00FFFF';
  private fillColor = '#ff00ff';
  private isRegionSavedOn = true;

  /** Selection is tracked by region *id* internally (stable across edits) and
   *  projected to array indices on the IRegionStore boundary. */
  private selectedIds: number[] = [];
  private readonly selectedIndices$ = new BehaviorSubject<number[]>([]);
  private readonly regionUpdate$ = new Subject<Region[]>();
  /** Non-coalesced sibling of regionUpdate$: fires on every change even during a
   *  batched drag, so live consumers (intensity inset) update per frame. */
  private readonly regionLiveEdit$ = new Subject<Region[]>();

  /** Emit coalescing for live drags (see IRegionEditApi.beginBatch). */
  private batchDepth = 0;
  private pendingEmit = false;

  private readonly plotUtilities = new PlotUtilities();

  constructor(private store: VisualizerStore) {}

  // ── IRegionStore: CRUD ─────────────────────────────────────────────────

  /**
   * Replace (or, with `append`, add to) the current image's regions. Mints ids
   * and default names, applies stored classification colours, and emits. When
   * `isRegionSaveOn` is false the regions are shown transiently (emitted) but
   * not stored — mirrors the previous Plotly behaviour.
   */
  setRegions(regions: Region[], showRegionLabel?: boolean, isRegionSaveOn?: boolean,
             fillColor?: string, append: boolean = false): void {
    if (showRegionLabel === undefined) showRegionLabel = this.showShapeLabel;
    if (isRegionSaveOn === undefined) isRegionSaveOn = this.isRegionSavedOn;
    if (fillColor === undefined) fillColor = this.fillColor;

    for (const region of regions) {
      if (region.id == null) region.id = this.nextId++;
      if (region.name == null) region.name = `shape${region.id}`;
    }
    this.applyClassificationColors(regions);

    this.isRegionSavedOn = isRegionSaveOn;
    if (isRegionSaveOn) {
      this.recordUndoSnapshot();
      this.showShapeLabel = showRegionLabel;
      this.fillColor = fillColor;
      if (append) {
        // Reject by id collision (already tracked) or geometry equality (same
        // coordinates) — the find button can push the same region repeatedly.
        const added = regions.filter(r =>
          !this.regions.some(existing => existing.id === r.id || this.regionsEqual(existing, r)));
        this.regions = this.regions.concat(added);
      } else {
        this.regions = regions.slice();
      }
      this.syncCache();
      this.emitSelection();
      this.emit();
    } else {
      // Transient display only — don't touch stored state.
      this.regionUpdate$.next(regions.slice());
    }
  }

  /** The canonical accessor: current image's regions (live instances). */
  getRegions(): Region[] {
    return this.regions.slice();
  }

  /**
   * Closed polygons projected for image-processing consumers (segmentation,
   * trace builders). Open polylines are annotation-only and excluded. Reuses
   * the neutral PlotUtilities projection so output matches the previous path.
   */
  getRegionPolygons(): any[] {
    const ret: any[] = [];
    for (const region of this.regions) {
      const poly: any = this.plotUtilities.getPolygon({ ...region.getShape(this.showShapeLabel) });
      if (poly == null || poly.closed === false) continue;
      ret.push(poly);
    }
    return ret;
  }

  getRegionUpdateEvent(): Observable<any[]> {
    return this.regionUpdate$.asObservable();
  }

  /** Live (non-coalesced) region-change stream — fires per frame during a drag.
   *  Used by the intensity-profile inset so it tracks line ROIs live. */
  getRegionLiveEdit$(): Observable<Region[]> {
    return this.regionLiveEdit$.asObservable();
  }

  // ── IRegionStore: selection ────────────────────────────────────────────

  /** Select regions by array index (or [] to clear). Stored internally by id
   *  so the selection survives subsequent edits/reorders. */
  setSelectedShapeIndices(indices: number[]): void {
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const i of indices || []) {
      if (!Number.isFinite(i) || i < 0 || i >= this.regions.length) continue;
      const id = this.regions[i].id;
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    this.selectedIds = ids;
    this.emitSelection();
  }

  /** Select a single region by identity (id). Backends call this from their
   *  `selectRegion()`; the OSD overlay + region editor highlight off the
   *  resulting selection emit. No-op if the region isn't in the store. */
  selectRegion(region: Region): void {
    if (region?.id == null || this.indexOfId(region.id) < 0) return;
    this.selectedIds = [region.id];
    this.emitSelection();
  }

  getSelectedShapeIndices$(): Observable<number[]> {
    return this.selectedIndices$.asObservable();
  }

  /** Synchronous current selection (array indices) — for callers that need to
   *  read the selection without subscribing. */
  getSelectedShapeIndices(): number[] {
    return this.selectedIndices$.value;
  }

  /** Delete the currently selected regions and clear the selection. */
  deleteActiveShape(): void {
    if (this.selectedIds.length === 0) return;
    this.recordUndoSnapshot();
    const ids = new Set(this.selectedIds);
    this.regions = this.regions.filter(r => !ids.has(r.id));
    this.selectedIds = [];
    this.syncCache();
    this.emitSelection();
    this.emit();
  }

  // ── IRegionStore: colours / labels ─────────────────────────────────────

  getShowShapeLabel(): boolean { return this.showShapeLabel; }
  getShapeColor(): string { return this.shapeColor; }
  getFillColor(): string { return this.fillColor; }

  /** Convenience setters (not on the contract) for toolbar wiring. */
  setShowShapeLabel(show: boolean): void { this.showShapeLabel = show; }
  setShapeColor(color: string): void { this.shapeColor = color; }
  setFillColor(color: string): void { this.fillColor = color; }

  getClassificationColors(): Map<string, string> { return this.store.getClassificationColors(); }
  setClassificationColor(label: string, color: string): void { this.store.setClassificationColor(label, color); }

  // ── IRegionStore: previous-shapes buffer ───────────────────────────────

  /** Re-show the last saved snapshot (transient — does not alter stored state). */
  plotPreviousShapes(): void {
    this.regionUpdate$.next(this.previousRegions.slice());
  }
  setPreviousShapes(shapes: any[]): void { this.previousRegions = (shapes as Region[]).slice(); }
  getPreviousShapes(): any[] { return this.previousRegions.slice(); }

  // ── IRegionStore: undo / redo (jit-ui#85) ──────────────────────────────

  /** Emits whether an undo step is currently available — drives the toolbar
   *  Undo button's enabled state (greyed out when false). */
  getCanUndo$(): Observable<boolean> {
    return this.canUndo$.asObservable();
  }

  /** Emits whether a redo step is currently available — drives the toolbar
   *  Redo button's enabled state. */
  getCanRedo$(): Observable<boolean> {
    return this.canRedo$.asObservable();
  }

  /** Synchronous read of {@link getCanUndo$} — true when at least one region
   *  action can be undone. */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Synchronous read of {@link getCanRedo$} — true when an undone action can
   *  be re-applied. */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Undo the most recent region action, restoring the region set to its state
   * just before that action and pushing the current state onto the redo stack.
   * Up to {@link UNDO_LIMIT} steps are retained, so this can be called up to
   * {@link UNDO_LIMIT} times in a row before the history empties. No-op when
   * nothing is left to undo.
   */
  undo(): void {
    if (this.undoStack.length === 0) return;
    const snapshot = this.undoStack.pop() as Region[];
    // Stash the current (post-action) state so redo can re-apply it.
    this.redoStack.push(this.cloneRegions(this.regions));
    if (this.redoStack.length > RegionStore.UNDO_LIMIT) this.redoStack.shift();
    this.restoreSnapshot(snapshot);
  }

  /**
   * Redo the action most recently undone, restoring the region set to the state
   * it had before that undo and pushing the current state back onto the undo
   * stack. No-op when there's nothing to redo (the redo stack is cleared by any
   * fresh region action).
   */
  redo(): void {
    if (this.redoStack.length === 0) return;
    const snapshot = this.redoStack.pop() as Region[];
    this.undoStack.push(this.cloneRegions(this.regions));
    if (this.undoStack.length > RegionStore.UNDO_LIMIT) this.undoStack.shift();
    this.restoreSnapshot(snapshot);
  }

  /** Discard the undo/redo history (e.g. on image load/switch — history never
   *  crosses images). */
  resetUndoHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.closeUndoBurst();
    if (this.canUndo$.value) this.canUndo$.next(false);
    if (this.canRedo$.value) this.canRedo$.next(false);
  }

  /** Make `snapshot` the live region set and notify both backends. Shared by
   *  {@link undo} and {@link redo}; the snapshot is already a detached deep
   *  clone, so it becomes the live array directly. */
  private restoreSnapshot(snapshot: Region[]): void {
    // Close any open coalescing burst so the next edit starts a fresh entry,
    // and flag the restore so it doesn't record itself back into the history.
    this.closeUndoBurst();
    this.restoringUndo = true;
    this.regions = snapshot;
    // Drop any selected ids the restored set no longer contains.
    this.selectedIds = this.selectedIds.filter(id => this.indexOfId(id) >= 0);
    this.syncCache();
    this.emitSelection();
    this.restoringUndo = false;
    this.emitUndoState();
    // Notify the live + coalesced streams so whichever backend is on screen
    // re-renders from the restored store state.
    this.regionLiveEdit$.next(this.regions.slice());
    this.regionUpdate$.next(this.getRegions());
  }

  /**
   * Capture the pre-action region set into the bounded undo history. Called at
   * the top of every mutating operation, *before* it changes `regions`, so the
   * snapshot is the state to return to. Rapid commits from one gesture coalesce
   * into a single entry (see {@link undoStack}). A fresh action also abandons
   * any redo future.
   */
  private recordUndoSnapshot(): void {
    if (this.restoringUndo) return;
    const startsBurst = !this.undoBurstOpen;
    this.armUndoBurst();
    if (!startsBurst) return;                      // mid-burst — keep first snapshot
    this.undoStack.push(this.cloneRegions(this.regions));
    if (this.undoStack.length > RegionStore.UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];                           // a new edit invalidates redo
    this.emitUndoState();
  }

  /** Push the current can-undo / can-redo availability to subscribers. */
  private emitUndoState(): void {
    const canUndo = this.undoStack.length > 0;
    const canRedo = this.redoStack.length > 0;
    if (this.canUndo$.value !== canUndo) this.canUndo$.next(canUndo);
    if (this.canRedo$.value !== canRedo) this.canRedo$.next(canRedo);
  }

  /** (Re)arm the idle timer that closes the current coalescing burst. */
  private armUndoBurst(): void {
    this.undoBurstOpen = true;
    if (this.undoBurstTimer) clearTimeout(this.undoBurstTimer);
    this.undoBurstTimer = setTimeout(() => {
      this.undoBurstOpen = false;
      this.undoBurstTimer = null;
    }, RegionStore.UNDO_COALESCE_MS);
  }

  private closeUndoBurst(): void {
    this.undoBurstOpen = false;
    if (this.undoBurstTimer) { clearTimeout(this.undoBurstTimer); this.undoBurstTimer = null; }
  }

  private cloneRegions(regions: Region[]): Region[] {
    return regions.map(r => this.cloneRegion(r));
  }

  /** Deep clone a region so an in-place geometry edit can't mutate a stored
   *  history snapshot (bounds are cloned via {@link cloneBounds}). */
  private cloneRegion(r: Region): Region {
    const c = new Region();
    Object.assign(c, r);
    c.bounds = r.bounds ? this.cloneBounds(r.bounds) : r.bounds;
    if (Array.isArray(r.tileCoordinates)) c.tileCoordinates = r.tileCoordinates.slice();
    return c;
  }

  // ── IRegionStore: GeoJSON I/O (neutral helpers) ────────────────────────

  importRegions(geoJsonStr: string): Region[] {
    return this.plotUtilities.importROIsFromGeoJson(geoJsonStr);
  }
  exportRegions(regions: Region[]): void {
    this.plotUtilities.saveToFile(this.plotUtilities.exportROIsToGeoJson(regions));
  }
  getGeoJsonString(regions: Region[]): string {
    return this.plotUtilities.exportROIsToGeoJson(regions);
  }

  // ── IRegionEditApi: structural edits ───────────────────────────────────

  addRegion(region: Region): number {
    this.recordUndoSnapshot();
    if (region.id == null) region.id = this.nextId++;
    if (region.name == null) region.name = `shape${region.id}`;
    this.applyClassificationColors([region]);
    this.regions.push(region);
    this.selectedIds = [region.id];
    this.syncCache();
    this.emitSelection();
    this.emit();
    return region.id;
  }

  removeRegion(id: number): void {
    const idx = this.indexOfId(id);
    if (idx < 0) return;
    this.recordUndoSnapshot();
    this.regions.splice(idx, 1);
    this.selectedIds = this.selectedIds.filter(s => s !== id);
    this.syncCache();
    this.emitSelection();
    this.emit();
  }

  updateBounds(id: number, bounds: Rectangle | Polygon): void {
    const r = this.findById(id);
    if (!r) return;
    this.recordUndoSnapshot();
    r.bounds = this.cloneBounds(bounds);
    this.syncCache();
    this.emit();
  }

  moveRegion(id: number, dx: number, dy: number): void {
    const r = this.findById(id);
    if (!r || !r.bounds) return;
    this.recordUndoSnapshot();
    const b = r.bounds;
    if (b instanceof Rectangle) {
      b.x += dx;
      b.y += dy;
    } else if (b instanceof Polygon) {
      b.xpoints = b.xpoints.map(x => x + dx);
      b.ypoints = b.ypoints.map(y => y + dy);
      b.coordinates = b.xpoints.map((x, i) => [x, b.ypoints[i]]);
    }
    this.syncCache();
    this.emit();
  }

  // ── IRegionEditApi: vertex edits (polygons only) ───────────────────────

  moveVertex(id: number, index: number, x: number, y: number): void {
    const poly = this.polygonOf(id);
    if (!poly || index < 0 || index >= poly.xpoints.length) return;
    this.recordUndoSnapshot();
    poly.xpoints[index] = x;
    poly.ypoints[index] = y;
    poly.coordinates[index] = [x, y];
    this.syncCache();
    this.emit();
  }

  addVertex(id: number, segIndex: number, x: number, y: number): void {
    const poly = this.polygonOf(id);
    if (!poly) return;
    this.recordUndoSnapshot();
    // Insert after segIndex (the start vertex of the edge). Clamp to range.
    const at = Math.max(0, Math.min(segIndex + 1, poly.xpoints.length));
    poly.xpoints.splice(at, 0, x);
    poly.ypoints.splice(at, 0, y);
    poly.coordinates = poly.xpoints.map((xx, i) => [xx, poly.ypoints[i]]);
    poly.npoints = poly.xpoints.length;
    // Give the new vertex smooth handles from its neighbours; keep the others'
    // (possibly hand-edited) handles intact.
    if (poly.bezier && poly.handlesIn && poly.handlesOut) {
      const n = poly.xpoints.length;
      const closed = poly.closed !== false;
      const prev = closed ? (at - 1 + n) % n : Math.max(0, at - 1);
      const next = closed ? (at + 1) % n : Math.min(n - 1, at + 1);
      const tx = (poly.xpoints[next] - poly.xpoints[prev]) / 6;
      const ty = (poly.ypoints[next] - poly.ypoints[prev]) / 6;
      poly.handlesIn.splice(at, 0, [-tx, -ty]);
      poly.handlesOut.splice(at, 0, [tx, ty]);
    }
    this.syncCache();
    this.emit();
  }

  deleteVertex(id: number, index: number): void {
    const poly = this.polygonOf(id);
    if (!poly || index < 0 || index >= poly.xpoints.length) return;
    const min = poly.closed === false ? 2 : 3;
    if (poly.xpoints.length <= min) return; // refuse to degenerate the polygon
    this.recordUndoSnapshot();
    poly.xpoints.splice(index, 1);
    poly.ypoints.splice(index, 1);
    poly.coordinates = poly.xpoints.map((xx, i) => [xx, poly.ypoints[i]]);
    poly.npoints = poly.xpoints.length;
    if (poly.bezier && poly.handlesIn && poly.handlesOut) {
      poly.handlesIn.splice(index, 1);
      poly.handlesOut.splice(index, 1);
    }
    this.syncCache();
    this.emit();
  }

  setBezier(id: number, bezier: boolean): void {
    const r = this.findById(id);
    if (!r || !r.bounds) return;
    if (r.bounds instanceof Polygon) {
      if (r.bounds.bezier === bezier) return;
      this.recordUndoSnapshot();
      this.applyBezier(r.bounds, bezier);
    } else if (r.bounds instanceof Rectangle && bezier) {
      this.recordUndoSnapshot();
      // Smoothing a rectangle: convert it to a 4-anchor closed polygon first.
      const b = r.bounds;
      const xs = [b.x, b.x + b.width, b.x + b.width, b.x];
      const ys = [b.y, b.y, b.y + b.height, b.y + b.height];
      const poly = new Polygon();
      poly.npoints = 4;
      poly.xpoints = xs;
      poly.ypoints = ys;
      poly.coordinates = xs.map((x, i) => [x, ys[i]]);
      poly.closed = true;
      this.applyBezier(poly, true);
      r.bounds = poly;
    } else {
      return; // bezier=false on a rectangle: nothing to do
    }
    this.syncCache();
    this.emit();
  }

  /** Turn bezier on (and seed editable handles from the smooth default) or off
   *  (and drop the handles). */
  private applyBezier(poly: Polygon, bezier: boolean): void {
    poly.bezier = bezier;
    if (bezier) {
      const off = defaultHandleOffsets(poly.xpoints, poly.ypoints, poly.closed !== false);
      poly.handlesIn = off.in;
      poly.handlesOut = off.out;
    } else {
      poly.handlesIn = undefined;
      poly.handlesOut = undefined;
    }
  }

  moveBezierHandle(id: number, index: number, side: 'in' | 'out', x: number, y: number): void {
    const poly = this.polygonOf(id);
    if (!poly || !poly.bezier || index < 0 || index >= poly.xpoints.length) return;
    this.recordUndoSnapshot();
    if (!poly.handlesIn || !poly.handlesOut) {
      const off = defaultHandleOffsets(poly.xpoints, poly.ypoints, poly.closed !== false);
      poly.handlesIn = off.in;
      poly.handlesOut = off.out;
    }
    const offset = [x - poly.xpoints[index], y - poly.ypoints[index]];
    if (side === 'in') poly.handlesIn[index] = offset;
    else poly.handlesOut[index] = offset;
    this.syncCache();
    this.emit();
  }

  beginBatch(): void { this.batchDepth++; }
  endBatch(): void {
    if (this.batchDepth > 0) this.batchDepth--;
    if (this.batchDepth === 0 && this.pendingEmit) {
      this.pendingEmit = false;
      this.regionUpdate$.next(this.getRegions());
    }
  }

  // ── per-image lifecycle ────────────────────────────────────────────────

  /**
   * Switch the active image: snapshot the outgoing regions, restore the
   * incoming image's (or [] if none), clear selection, and notify. Idempotent
   * for the same image (so repeated replots of one image keep its regions).
   */
  setActiveImage(imageInfo: IImageInfo): void {
    const newKey = this.deriveImageKey(imageInfo);
    if (this.currentImageKey === newKey) return;
    if (this.currentImageKey) {
      this.regionsByImageKey.set(this.currentImageKey, this.regions.slice());
    }
    this.currentImageKey = newKey;
    this.regions = (newKey && this.regionsByImageKey.get(newKey))
      ? (this.regionsByImageKey.get(newKey) as Region[]).slice()
      : [];
    this.previousRegions = this.regions.slice();
    this.selectedIds = [];
    // Undo never crosses an image switch.
    this.resetUndoHistory();
    this.emitSelection();
    this.regionUpdate$.next(this.getRegions());
  }

  /** Drop the entire per-image cache (logout / project switch). */
  clearRegionsByImageKey(): void {
    this.regionsByImageKey.clear();
    this.currentImageKey = undefined;
    this.regions = [];
    this.selectedIds = [];
    this.resetUndoHistory();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private deriveImageKey(imageInfo: IImageInfo | undefined): string | undefined {
    if (!imageInfo) return undefined;
    if (imageInfo.urls && imageInfo.urls.length > 0 && imageInfo.urls[0]) {
      return imageInfo.urls[0];
    }
    return imageInfo.fileName || undefined;
  }

  private applyClassificationColors(regions: Region[]): void {
    const classColors = this.store.getClassificationColors();
    for (const region of regions) {
      if (region.label && classColors.has(region.label)) {
        region.color = classColors.get(region.label)!;
      }
    }
  }

  private syncCache(): void {
    if (this.currentImageKey) {
      this.regionsByImageKey.set(this.currentImageKey, this.regions.slice());
    }
  }

  private emit(): void {
    // Live-edit listeners (e.g. the intensity-profile inset) react on EVERY
    // change — including per-frame during a batched drag — so they track the
    // region live. The main regionUpdate$ stays coalesced during a batch (fires
    // once on endBatch) to keep heavier consumers (Regions tab) calm.
    this.regionLiveEdit$.next(this.regions.slice());
    if (this.batchDepth > 0) { this.pendingEmit = true; return; }
    this.regionUpdate$.next(this.getRegions());
  }

  /** Project selected ids to current array indices, pruning ids that no longer
   *  exist, and emit if the index set changed. */
  private emitSelection(): void {
    const indices: number[] = [];
    const liveIds: number[] = [];
    for (const id of this.selectedIds) {
      const idx = this.indexOfId(id);
      if (idx >= 0) { indices.push(idx); liveIds.push(id); }
    }
    this.selectedIds = liveIds;
    if (!this.indicesEqual(this.selectedIndices$.value, indices)) {
      this.selectedIndices$.next(indices);
    }
  }

  private indicesEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  private findById(id: number): Region | undefined {
    return this.regions.find(r => r.id === id);
  }

  private indexOfId(id: number): number {
    return this.regions.findIndex(r => r.id === id);
  }

  /** The region's bounds as a Polygon, or undefined if it isn't a polygon. */
  private polygonOf(id: number): Polygon | undefined {
    const r = this.findById(id);
    return r && r.bounds instanceof Polygon ? r.bounds : undefined;
  }

  private cloneBounds(bounds: Rectangle | Polygon): Rectangle | Polygon {
    if (bounds instanceof Rectangle) {
      const rect = new Rectangle();
      rect.x = bounds.x; rect.y = bounds.y; rect.width = bounds.width; rect.height = bounds.height;
      return rect;
    }
    const poly = new Polygon();
    poly.npoints = bounds.npoints;
    poly.xpoints = bounds.xpoints.slice();
    poly.ypoints = bounds.ypoints.slice();
    poly.coordinates = bounds.coordinates.map(c => c.slice());
    poly.closed = bounds.closed;
    poly.bezier = bounds.bezier;
    if (bounds.handlesIn) poly.handlesIn = bounds.handlesIn.map(o => o.slice());
    if (bounds.handlesOut) poly.handlesOut = bounds.handlesOut.map(o => o.slice());
    return poly;
  }

  private regionsEqual(a: Region, b: Region): boolean {
    const ba = a.bounds, bb = b.bounds;
    if (ba instanceof Rectangle && bb instanceof Rectangle) {
      return ba.x === bb.x && ba.y === bb.y && ba.width === bb.width && ba.height === bb.height;
    }
    if (ba instanceof Polygon && bb instanceof Polygon) {
      if ((ba.closed !== false) !== (bb.closed !== false)) return false;
      if (ba.xpoints.length !== bb.xpoints.length) return false;
      for (let i = 0; i < ba.xpoints.length; i++) {
        if (ba.xpoints[i] !== bb.xpoints[i] || ba.ypoints[i] !== bb.ypoints[i]) return false;
      }
      return true;
    }
    return false;
  }
}
