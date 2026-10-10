import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import { IImageInfo } from '../contracts/image.contract';
import { Region, Rectangle, Polygon, MultiPolygon, hydrateBounds } from '../models/region';
import { downloadGeoJson, regionsFromGeoJson, regionsToGeoJson } from '../models/region-geojson';
import { VisualizerStore } from './visualizer-store.service';
import { IRegionStore } from '../contracts/visualizer.contract';
import { IRegionEditApi } from '../contracts/region-store.contract';
import { colorForLabel, presetKey } from './class-color.util';
import { cloneBounds, makePolygon, rectToRing, regionPolygons, replaceBounds } from '../models/polygon-factory';
import * as edit from '../models/polygon-edit';
import { regionsEqual, withRegionPatch, withRegionZ } from '../models/region-clone';
import { RegionHistory } from './region-history';

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
 * Copy-on-write (review RT-13): no operation changes a stored {@link Region}
 * (or the regions array) in place. An edit builds a replacement — the geometry
 * through the pure `models/polygon-edit` functions — and swaps it in, so the
 * undo history ({@link RegionHistory}) can keep shallow snapshots that share
 * every untouched region instead of deep-cloning the whole set per step.
 * Callers must follow the same rule with the instances {@link getRegions}
 * returns: treat them as read-only, and commit a changed copy.
 *
 * Classification colours live in {@link VisualizerStore} (shared by both
 * backends); GeoJSON import/export is `models/region-geojson`. All coordinates
 * are image pixels.
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

  /**
   * Undo/redo history (jit-ui#85): up to {@link UNDO_LIMIT} snapshots of the
   * region set, each taken just *before* a region-editing action; continuous
   * gestures and rapid commits coalesce (see {@link RegionHistory}). Snapshots
   * are shallow — the regions array as it was — which is safe because nothing
   * here mutates a region or an array in place (RT-13). History never crosses an
   * image load/switch — {@link resetUndoHistory} clears it.
   */
  private readonly history = new RegionHistory<Region[]>(RegionStore.UNDO_LIMIT, RegionStore.UNDO_COALESCE_MS);

  /** Monotonic id source — ids never repeat within the service lifetime, so
   *  selection stays correct across delete/add cycles even when names collide. */
  private nextId = 1;

  private showShapeLabel = false;
  private shapeColor = '#00FFFF';
  private fillColor = '#ff00ff';
  private isRegionSavedOn = true;

  /**
   * Per-slice region support for z-stacks (jit-ui#93). While {@link stackMode}
   * is on (a z-stack is loaded), the live `regions` array always holds ONE
   * slice — the {@link currentSliceZ} slice — so the on-canvas overlays, the
   * selection projection, and the Regions table keep working unchanged
   * (they all read {@link getRegions}). The other slices live in
   * {@link regionsBySlice}; {@link setDisplaySlice} swaps the live set on scrub
   * and {@link getSliceRegions} flattens every slice (each tagged with its
   * zero-based {@link Region.z}) for save/export. Off by default (stackMode
   * false, z 0), so single-plane images are completely unaffected.
   */
  private regionsBySlice = new Map<number, Region[]>();
  private stackMode = false;
  private currentSliceZ = 0;
  /** How a stack's regions round-trip to disk (jit-ui#93): `combined` writes one
   *  z-indexed geojson (single-file z-stack, QuPath schema); `per-slice-file`
   *  writes one geojson per slice-file (a folder of numbered images). */
  private stackSaveLayout: 'combined' | 'per-slice-file' = 'combined';
  /** Slices that were loaded with regions (jit-ui#93). A per-slice-file save
   *  re-writes these even when now empty, so clearing a slice's regions and
   *  saving removes its previously-saved geojson (writes an empty one). */
  private stackInitialNonEmpty = new Set<number>();

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

    regions = this.admit(regions);

    this.isRegionSavedOn = isRegionSaveOn;
    if (isRegionSaveOn) {
      this.recordUndoSnapshot();
      this.showShapeLabel = showRegionLabel;
      this.fillColor = fillColor;
      if (append) {
        // Reject by id collision (already tracked) or geometry equality (same
        // coordinates) — the find button can push the same region repeatedly.
        const added = regions.filter(r =>
          !this.regions.some(existing => existing.id === r.id || regionsEqual(existing, r)));
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

  /**
   * The canonical accessor: the current image's regions. A fresh array, but the
   * instances are the stored ones, shared with the undo history: treat them as
   * read-only and change a region through the store's operations (or by
   * committing a copy). Typed `Region[]` rather than
   * `ReadonlyArray<Readonly<Region>>` because the IRegionStore contract and the
   * backends still take a mutable array.
   */
  getRegions(): Region[] {
    return this.regions.slice();
  }

  // ── Per-slice regions for z-stacks (jit-ui#93) ─────────────────────────

  /** True while a z-stack is loaded and the store holds regions per slice. */
  isStackMode(): boolean { return this.stackMode; }

  /** The current display slice (zero-based). */
  getDisplaySlice(): number { return this.currentSliceZ; }

  /** How the current stack persists to disk (jit-ui#93): `combined` = one
   *  z-indexed geojson (single-file z-stack); `per-slice-file` = one geojson per
   *  slice-file (folder stack). Meaningless outside stack mode. */
  getStackSaveLayout(): 'combined' | 'per-slice-file' { return this.stackSaveLayout; }

  /**
   * Enter per-slice stack mode. `slices` maps each zero-based slice index to
   * the regions imported for that slice; the store makes `initialZ`'s slice the
   * live set, so the overlays / selection / Regions table are unchanged (they
   * still read {@link getRegions}). Freshly-created regions are tagged with the
   * current slice so they persist on it, and {@link getSliceRegions} returns
   * every slice for save/export. Ids/names/classification colours are minted
   * exactly as {@link setRegions} does.
   */
  enterStackMode(slices: Map<number, Region[]>, initialZ = 0,
                 saveLayout: 'combined' | 'per-slice-file' = 'combined'): void {
    this.stackMode = true;
    this.stackSaveLayout = saveLayout;
    this.currentSliceZ = initialZ || 0;
    this.regionsBySlice = new Map<number, Region[]>();
    this.stackInitialNonEmpty = new Set<number>();
    for (const [z, regs] of slices) {
      const normalized = this.normalizeSlice(regs || [], z);
      this.regionsBySlice.set(z, normalized);
      if (normalized.length) this.stackInitialNonEmpty.add(z);
    }
    this.regions = (this.regionsBySlice.get(this.currentSliceZ) ?? []).slice();
    this.selectedIds = [];
    this.syncCache();
    this.resetUndoHistory();
    this.emitSelection();
    this.emit();
  }

  /** Leave stack mode (single-plane image, or the stack was closed). */
  exitStackMode(): void {
    if (!this.stackMode) return;
    this.stackMode = false;
    this.currentSliceZ = 0;
    this.regionsBySlice = new Map<number, Region[]>();
    this.stackInitialNonEmpty = new Set<number>();
  }

  /**
   * Show a different slice: capture the current slice's (possibly edited)
   * regions back into the per-slice store, then load the target slice's regions
   * as the live set and emit. Undo never crosses a slice. Outside stack mode
   * this only records the requested slice index (a no-op otherwise: single-plane
   * regions stay on the default plane — addRegion tags Region.z only in stack
   * mode, so the recorded index is unused until a stack is entered). (jit-ui#93)
   */
  setDisplaySlice(z: number): void {
    const next = z || 0;
    if (!this.stackMode) { this.currentSliceZ = next; return; }
    if (this.currentSliceZ === next) return;
    this.regionsBySlice.set(this.currentSliceZ, this.regions.slice());
    this.currentSliceZ = next;
    this.regions = (this.regionsBySlice.get(next) ?? []).slice();
    this.selectedIds = [];
    this.syncCache();
    this.resetUndoHistory();
    this.emitSelection();
    this.emit();
  }

  /**
   * Every slice's regions for save/export, each tagged with its zero-based
   * slice index in {@link Region.z}. Captures the current slice's live edits
   * first. Returns the flat single-plane set when not in stack mode. (jit-ui#93)
   */
  getSliceRegions(): Region[] {
    if (!this.stackMode) return this.regions.slice();
    this.regionsBySlice.set(this.currentSliceZ, this.regions.slice());
    const out: Region[] = [];
    const zs = Array.from(this.regionsBySlice.keys()).sort((a, b) => a - b);
    for (const z of zs) {
      for (const r of this.regionsBySlice.get(z) as Region[]) out.push(withRegionZ(r, z));
    }
    return out;
  }

  /**
   * Slices to write on a per-slice-file save (folder stack, jit-ui#93): every
   * slice that currently has regions, PLUS slices that were loaded non-empty but
   * are now empty (so their file is re-written empty, clearing a slice whose
   * regions the user deleted). Each returned region is tagged with its z, and
   * the current live slice is captured first. Empty outside stack mode.
   */
  getStackSaveSlices(): Map<number, Region[]> {
    const out = new Map<number, Region[]>();
    if (!this.stackMode) return out;
    this.regionsBySlice.set(this.currentSliceZ, this.regions.slice());
    const zs = new Set<number>(this.stackInitialNonEmpty);
    for (const [z, regs] of this.regionsBySlice) if (regs.length) zs.add(z);
    for (const z of Array.from(zs).sort((a, b) => a - b)) {
      const regs = (this.regionsBySlice.get(z) ?? []).map((r) => withRegionZ(r, z));
      out.set(z, regs);
    }
    return out;
  }

  /** Mint ids/names + apply classification colours + tag the slice index, as
   *  {@link setRegions} does, for regions entering the per-slice store. */
  private normalizeSlice(regions: Region[], z: number): Region[] {
    // A fresh (imported) region is tagged in place; a stored one is copied.
    return this.admit(regions.map((r) => (r.id == null ? Object.assign(r, { z }) : withRegionZ(r, z))));
  }

  /**
   * Regions entering the store: mint ids and default names, hydrate JSON bounds
   * into class instances — everything downstream (rendering, geometry de-dup,
   * moveRegion, GeoJSON export) discriminates them with `instanceof`
   * (jit-ui#124) — and apply classification colours. A region that is new to
   * the store (no id yet) is completed in place; one that already has an id may
   * be a stored instance shared with the undo history, so it is copied if it
   * changes.
   */
  private admit(regions: Region[]): Region[] {
    const fresh = new Set<Region>();
    const admitted = regions.map((region) => {
      if (region.id == null) {
        region.id = this.nextId++;
        if (region.name == null) region.name = `shape${region.id}`;
        region.bounds = hydrateBounds(region.bounds);
        fresh.add(region);
        return region;
      }
      const bounds = hydrateBounds(region.bounds);
      return region.name == null || bounds !== region.bounds
        ? withRegionPatch(region, { name: region.name ?? `shape${region.id}`, bounds })
        : region;
    });
    return this.withClassificationColors(admitted, (r) => fresh.has(r));
  }

  /**
   * Closed polygons projected for image-processing consumers (segmentation,
   * crop requests, trace builders), straight from each region's bounds: a
   * rectangle's corners, a polygon with its holes (a bézier as its curve), one
   * polygon per part of a multi-polygon. Open polylines are annotation-only and
   * excluded. Coordinates are rounded to whole pixels.
   */
  getRegionPolygons(): Polygon[] {
    return this.regions.flatMap((region) => regionPolygons(region));
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

  /** Show or hide region labels (not on the contract; specs drive it directly).
   *  @deprecated Nothing in the library calls it; will be removed next minor. */
  setShowShapeLabel(show: boolean): void { this.showShapeLabel = show; }

  getClassificationColors(): Map<string, string> { return this.store.getClassificationColors(); }
  setClassificationColor(label: string, color: string): void { this.store.setClassificationColor(label, color); }

  // ── IRegionStore: undo / redo (jit-ui#85) ──────────────────────────────

  /** Emits whether an undo step is currently available — drives the toolbar
   *  Undo button's enabled state (greyed out when false). */
  getCanUndo$(): Observable<boolean> {
    return this.history.canUndo$;
  }

  /** Emits whether a redo step is currently available — drives the toolbar
   *  Redo button's enabled state. */
  getCanRedo$(): Observable<boolean> {
    return this.history.canRedo$;
  }

  /** Synchronous read of {@link getCanUndo$} — true when at least one region
   *  action can be undone. */
  canUndo(): boolean {
    return this.history.canUndo();
  }

  /** Synchronous read of {@link getCanRedo$} — true when an undone action can
   *  be re-applied. */
  canRedo(): boolean {
    return this.history.canRedo();
  }

  /**
   * Undo the most recent region action, restoring the region set to its state
   * just before that action and pushing the current state onto the redo stack.
   * Up to {@link UNDO_LIMIT} steps are retained, so this can be called up to
   * {@link UNDO_LIMIT} times in a row before the history empties. No-op when
   * nothing is left to undo.
   */
  undo(): void {
    const snapshot = this.history.undo(this.regions);
    if (snapshot) this.restoreSnapshot(snapshot);
  }

  /**
   * Redo the action most recently undone, restoring the region set to the state
   * it had before that undo and pushing the current state back onto the undo
   * stack. No-op when there's nothing to redo (the redo stack is cleared by any
   * fresh region action).
   */
  redo(): void {
    const snapshot = this.history.redo(this.regions);
    if (snapshot) this.restoreSnapshot(snapshot);
  }

  /** Discard the undo/redo history (e.g. on image load/switch — history never
   *  crosses images). */
  resetUndoHistory(): void {
    this.history.reset();
  }

  /** Make `snapshot` the live region set and notify both backends. Shared by
   *  {@link undo} and {@link redo}; nothing records history while it runs. */
  private restoreSnapshot(snapshot: Region[]): void {
    this.history.restore(() => {
      this.regions = snapshot.slice();
      // Drop any selected ids the restored set no longer contains.
      this.selectedIds = this.selectedIds.filter(id => this.indexOfId(id) >= 0);
      this.syncCache();
      this.emitSelection();
    });
    // Notify the live + coalesced streams so whichever backend is on screen
    // re-renders from the restored store state.
    this.regionLiveEdit$.next(this.regions.slice());
    this.regionUpdate$.next(this.getRegions());
  }

  /**
   * Capture the pre-action region set into the bounded undo history. Called at
   * the top of every mutating operation, *before* it changes `regions`. The
   * snapshot is the array itself: every operation replaces `regions` (and any
   * region it edits) rather than changing them, so it never changes after this.
   */
  private recordUndoSnapshot(): void {
    this.history.record(this.regions);
  }

  // ── IRegionStore: GeoJSON I/O (models/region-geojson) ──────────────────

  importRegions(geoJsonStr: string): Region[] {
    return regionsFromGeoJson(geoJsonStr);
  }
  /** Download `regions` as GeoJSON, named after `fileName` (extension
   *  replaced by `.geojson`) or `rois.geojson` without one. */
  exportRegions(regions: Region[], fileName?: string): void {
    downloadGeoJson(regionsToGeoJson(regions), fileName);
  }
  getGeoJsonString(regions: Region[]): string {
    return regionsToGeoJson(regions);
  }

  // ── IRegionEditApi: structural edits ───────────────────────────────────

  addRegion(region: Region): number {
    this.recordUndoSnapshot();
    if (region.id == null) region.id = this.nextId++;
    if (region.name == null) region.name = `shape${region.id}`;
    region.bounds = hydrateBounds(region.bounds);   // jit-ui#124
    // A region drawn on a stack belongs to the slice currently displayed, so
    // it saves/reloads on that slice (jit-ui#93). No-op for single-plane images
    // (currentSliceZ stays 0).
    if (this.stackMode) region.z = this.currentSliceZ;
    // The caller's instance becomes the stored one (completed in place).
    const [stored] = this.withClassificationColors([region], () => true);
    this.regions = [...this.regions, stored];
    this.selectedIds = [stored.id];
    this.syncCache();
    this.emitSelection();
    this.emit();
    return stored.id;
  }

  removeRegion(id: number): void {
    this.removeRegions([id]);
  }

  /**
   * Remove the regions with these ids, if present. With `{ recordUndo: false }`
   * no undo step is taken — for clearing transient shapes that were never the
   * user's work (the 3D view's screen-space lassos on an orbit, NAPARI-SVC-11).
   */
  removeRegions(ids: Iterable<number>, opts: { recordUndo?: boolean } = {}): void {
    const drop = new Set(ids);
    if (!this.regions.some((r) => drop.has(r.id))) return;
    if (opts.recordUndo !== false) this.recordUndoSnapshot();
    this.regions = this.regions.filter((r) => !drop.has(r.id));
    this.selectedIds = this.selectedIds.filter((s) => !drop.has(s));
    this.syncCache();
    this.emitSelection();
    this.emit();
  }

  updateBounds(id: number, bounds: Rectangle | Polygon | MultiPolygon): void {
    const r = this.findById(id);
    if (!r) return;
    this.recordUndoSnapshot();
    // A copy, so the caller can keep using (and changing) the bounds it passed.
    this.replaceRegion(replaceBounds(r, cloneBounds(bounds)));
  }

  moveRegion(id: number, dx: number, dy: number): void {
    const r = this.findById(id);
    if (!r || !r.bounds) return;
    this.recordUndoSnapshot();
    // Every part (and its holes) moves together (jit-ui#85).
    this.replaceRegion(replaceBounds(r, edit.translateBounds(r.bounds, dx, dy)));
  }

  // ── IRegionEditApi: vertex edits (polygons only) ───────────────────────
  // Each one is a pure copy-on-write edit from models/polygon-edit; a null
  // result (out of range, would degenerate) records nothing and emits nothing.

  moveVertex(id: number, index: number, x: number, y: number): void {
    this.editPolygon(id, (p) => edit.moveVertex(p, index, x, y));
  }

  /** Move a vertex on a polygon's interior ring (hole) — jit-ui#85. */
  moveHoleVertex(id: number, holeIndex: number, index: number, x: number, y: number): void {
    this.editPolygon(id, (p) => edit.moveHoleVertex(p, holeIndex, index, x, y));
  }

  /** Insert a vertex on a polygon's interior ring (hole), after `segIndex`
   *  (the edge's start vertex). No-op for an out-of-range hole — jit-ui#85. */
  addHoleVertex(id: number, holeIndex: number, segIndex: number, x: number, y: number): void {
    this.editPolygon(id, (p) => edit.addHoleVertex(p, holeIndex, segIndex, x, y));
  }

  /** Delete the vertex at `index` on a polygon's interior ring (hole). Removing
   *  it below 3 vertices drops the whole hole (a ring with < 3 points bounds no
   *  area) — jit-ui#85. */
  deleteHoleVertex(id: number, holeIndex: number, index: number): void {
    this.editPolygon(id, (p) => edit.deleteHoleVertex(p, holeIndex, index));
  }

  addVertex(id: number, segIndex: number, x: number, y: number): void {
    this.editPolygon(id, (p) => edit.addVertex(p, segIndex, x, y));
  }

  deleteVertex(id: number, index: number): void {
    this.editPolygon(id, (p) => edit.deleteVertex(p, index));
  }

  setBezier(id: number, bezier: boolean): void {
    const r = this.findById(id);
    if (!r || !r.bounds) return;
    let next: Polygon | null = null;
    if (r.bounds instanceof Polygon) {
      next = edit.setBezier(r.bounds, bezier);
    } else if (r.bounds instanceof Rectangle && bezier) {
      // Smoothing a rectangle: convert it to a 4-anchor closed polygon first.
      const ring = rectToRing(r.bounds);
      next = edit.setBezier(makePolygon(ring.xs, ring.ys), true);
    }
    if (!next) return; // already in that state, or bezier=false on a rectangle
    this.recordUndoSnapshot();
    this.replaceRegion(replaceBounds(r, next));
  }

  /** Drag a bezier control point on a hole ring vertex (donut bezier editing). */
  moveHoleBezierHandle(
    id: number,
    holeIndex: number,
    index: number,
    side: 'in' | 'out',
    x: number,
    y: number,
  ): void {
    this.editPolygon(id, (p) => edit.moveHoleBezierHandle(p, holeIndex, index, side, x, y));
  }

  moveBezierHandle(id: number, index: number, side: 'in' | 'out', x: number, y: number): void {
    this.editPolygon(id, (p) => edit.moveBezierHandle(p, index, side, x, y));
  }

  /** Apply a copy-on-write polygon edit to region `id`: record, swap in, emit. */
  private editPolygon(id: number, apply: (p: Polygon) => Polygon | null): void {
    const r = this.findById(id);
    if (!r || !(r.bounds instanceof Polygon)) return;
    const next = apply(r.bounds);
    if (!next) return;
    this.recordUndoSnapshot();
    this.replaceRegion(replaceBounds(r, next));
  }

  /** Swap `next` in for the stored region with its id (a new array), then sync and emit. */
  private replaceRegion(next: Region): void {
    this.regions = this.regions.map((r) => (r.id === next.id ? next : r));
    this.syncCache();
    this.emit();
  }

  /** Coalesce `regionUpdate$` until the matching {@link endBatch} (live drags);
   *  the batch is also one undo gesture ({@link beginGesture}). */
  beginBatch(): void {
    this.batchDepth++;
    this.beginGesture();
  }
  endBatch(): void {
    if (this.batchDepth > 0) this.batchDepth--;
    this.endGesture();
    if (this.batchDepth === 0 && this.pendingEmit) {
      this.pendingEmit = false;
      this.regionUpdate$.next(this.getRegions());
    }
  }

  /**
   * Mark the start of one user gesture (e.g. a wand/brush mousedown): every
   * commit until the matching {@link endGesture} becomes a single undo step,
   * without delaying `regionUpdate$` (tools render through it while dragging).
   * Calls nest. A gesture never folds into an earlier timed burst.
   */
  beginGesture(): void {
    this.history.beginGesture();
  }

  /** End the gesture opened by {@link beginGesture}; the next commit starts a new step. */
  endGesture(): void {
    this.history.endGesture();
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
    // Switching images ends any per-slice stack session (jit-ui#93); the loader
    // re-enters stack mode afterwards if the new image is itself a z-stack.
    this.exitStackMode();
    if (this.currentImageKey) {
      this.regionsByImageKey.set(this.currentImageKey, this.regions.slice());
    }
    this.currentImageKey = newKey;
    this.regions = (newKey && this.regionsByImageKey.get(newKey))
      ? (this.regionsByImageKey.get(newKey) as Region[]).slice()
      : [];
    this.selectedIds = [];
    // Undo never crosses an image switch.
    this.resetUndoHistory();
    this.emitSelection();
    this.regionUpdate$.next(this.getRegions());
  }

  // ── internals ──────────────────────────────────────────────────────────

  private deriveImageKey(imageInfo: IImageInfo | undefined): string | undefined {
    if (!imageInfo) return undefined;
    if (imageInfo.urls && imageInfo.urls.length > 0 && imageInfo.urls[0]) {
      return imageInfo.urls[0];
    }
    return imageInfo.fileName || undefined;
  }

  /**
   * Resolve each region's colour from the annotation-class preset set (jit-ui#70).
   * The presets are the source of truth for colour — this **overrides any colour
   * embedded in the GeoJSON** (which the YOLO worker writes today). A matching
   * preset gives the class colour; an unknown class gets a deterministic fallback
   * colour (and, only when `autoPromote` is on, is added to the editable list).
   * Regions the user explicitly recoloured (`colorOverridden`) are left untouched.
   * A region whose colour changes is copied, unless `inPlace` says it is the
   * caller's fresh instance (not yet stored, so not in any undo snapshot).
   */
  private withClassificationColors(regions: Region[], inPlace: (r: Region) => boolean): Region[] {
    const set = this.store.getPresetSet();
    const known = new Set(set.classes.map((c) => presetKey(set, c.name)));
    return regions.map((region) => {
      if (!region.label || region.colorOverridden) return region;
      const color = colorForLabel(region.label, set);
      if (set.autoPromote && !known.has(presetKey(set, region.label))) {
        known.add(presetKey(set, region.label));
        // In normalized mode, trim the promoted name so leading/trailing
        // whitespace doesn't create invisible duplicates or odd display names.
        const name = set.matchMode === 'normalized' ? region.label.trim() : region.label;
        this.store.upsertClass({ name, color, source: 'auto' });
      }
      if (region.color === color) return region;
      if (!inPlace(region)) return withRegionPatch(region, { color });
      region.color = color;
      return region;
    });
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
}

