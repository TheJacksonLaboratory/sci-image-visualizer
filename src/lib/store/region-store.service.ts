import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import { IImageInfo } from '../contracts/image.contract';
import { Region, Rectangle, Polygon, MultiPolygon, hydrateBounds } from '../models/region';
import {
  GeoJsonFeature,
  downloadGeoJson,
  featureFromRegion,
  regionFromGeoJsonFeature,
  regionsFromGeoJson,
  regionsToGeoJson,
} from '../models/region-geojson';
import { VisualizerStore } from './visualizer-store.service';
import { IRegionStore } from '../contracts/visualizer.contract';
import { IRegionEditApi, IRegionSourceApi } from '../contracts/region-store.contract';
import { applyPresetColors, colorForLabel } from './class-color.util';
import { cloneBounds, makePolygon, rectToRing, regionPolygons, replaceBounds } from '../models/polygon-factory';
import * as edit from '../models/polygon-edit';
import { regionsEqual, withRegionPatch, withRegionZ } from '../models/region-clone';
import { RegionHistory } from './region-history';
import { RegionSelection } from './region-selection';
import { RegionScopeCache, StackSaveLayout } from './region-scope-cache';
import { RegionSourceOpener, RegionSourceScope, RegionSourceSlices } from './region-source-scope';
import type { RegionSource, RegionSourceView } from '../region-source/region-source';
import type { RegionIndexPage, RegionIndexQuery, RegionSourceStyle } from '../region-source/region-tiles';
import { DEFAULT_REGION_STYLE, RegionStyle } from '../region-overlay/region-style';

/** Selecting classes takes at most this many region-source features into the regions. */
export const SELECT_CLASSES_LIMIT = 5000;

/** One undo step: the region set and, for a slice with a region source, what was taken from it. */
interface RegionSnapshot {
  regions: Region[];
  taken: ReadonlySet<string>;
}

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
export class RegionStore implements IRegionStore, IRegionEditApi, IRegionSourceApi {
  private static readonly UNDO_LIMIT = 10;
  private static readonly UNDO_COALESCE_MS = 250;

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
  private readonly history = new RegionHistory<RegionSnapshot>(
    RegionStore.UNDO_LIMIT,
    RegionStore.UNDO_COALESCE_MS,
  );

  /** Monotonic id source — ids never repeat within the service lifetime, so
   *  selection stays correct across delete/add cycles even when names collide. */
  private nextId = 1;

  private showShapeLabel = false;
  private shapeColor = '#00FFFF';
  private fillColor = '#ff00ff';
  private isRegionSavedOn = true;

  /**
   * Per-image cache and, for z-stacks, per-slice regions (jit-ui#93). In stack
   * mode the live `regions` array holds ONE slice — the display slice — so the
   * overlays, the selection projection and the Regions table work unchanged
   * (they all read {@link getRegions}); {@link setDisplaySlice} swaps the live
   * set on scrub and {@link getSliceRegions} flattens every slice (each tagged
   * with its zero-based {@link Region.z}) for save/export. Off by default, so
   * single-plane images are unaffected.
   */
  private readonly scope = new RegionScopeCache();

  /** Selection by region *id* (stable across edits), projected to array
   *  indices on the IRegionStore boundary. */
  private readonly selection = new RegionSelection();
  private readonly regionUpdate$ = new Subject<Region[]>();
  /** Non-coalesced sibling of regionUpdate$: fires on every change even during a
   *  batched drag, so live consumers (intensity inset) update per frame. */
  private readonly regionLiveEdit$ = new Subject<Region[]>();
  /** See {@link getRegionSetReplaced$}. */
  private readonly regionSetReplaced$ = new Subject<void>();

  /** Emit coalescing for live drags (see IRegionEditApi.beginBatch). */
  private batchDepth = 0;
  private pendingEmit = false;

  /**
   * Large region sets held as tiled region sources rather than as regions (see
   * {@link attachRegionSource}): per image and slice, with the ids taken out of each.
   */
  private readonly sources = new RegionSourceScope();
  private readonly sourceView$ = new BehaviorSubject<RegionSourceView | null>(null);
  /** The region look the user chose (overrides the source's hint), field by field. */
  private userStyle: Partial<RegionStyle> = {};
  /** The current source's style hint. */
  private hintStyle: RegionSourceStyle | undefined;
  private readonly regionStyle$ = new BehaviorSubject<RegionStyle>(DEFAULT_REGION_STYLE);
  /** Bumped on every change of the slice's source, so a late open is dropped. */
  private sourceGeneration = 0;

  constructor(private store: VisualizerStore) {
    // A class colour change recolours the source's features as it recolours regions.
    this.store.getPresetSet$().subscribe(() => {
      const view = this.sourceView$.value;
      if (view) this.sourceView$.next({ ...view });
    });
  }

  // ── IRegionStore: CRUD ─────────────────────────────────────────────────

  /**
   * Replace (or, with `append`, add to) the current image's regions. Mints ids
   * and default names, applies stored classification colours, and emits. When
   * `isRegionSaveOn` is false the regions are shown transiently (emitted) but
   * not stored — mirrors the previous Plotly behaviour.
   */
  setRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
    append: boolean = false,
  ): void {
    if (showRegionLabel === undefined) showRegionLabel = this.showShapeLabel;
    if (isRegionSaveOn === undefined) isRegionSaveOn = this.isRegionSavedOn;
    if (fillColor === undefined) fillColor = this.fillColor;

    regions = this.admit(regions);

    this.isRegionSavedOn = isRegionSaveOn;
    if (isRegionSaveOn) {
      this.recordUndoSnapshot();
      if (this.showShapeLabel !== showRegionLabel) {
        this.showShapeLabel = showRegionLabel;
        this.republishView();
      }
      this.fillColor = fillColor;
      if (append) {
        // Reject by id collision (already tracked) or geometry equality (same
        // coordinates) — the find button can push the same region repeatedly.
        const added = regions.filter(
          (r) => !this.regions.some((existing) => existing.id === r.id || regionsEqual(existing, r)),
        );
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
  isStackMode(): boolean {
    return this.scope.stackMode;
  }

  /** The current display slice (zero-based). */
  getDisplaySlice(): number {
    return this.scope.displaySlice;
  }

  /** How the current stack persists to disk (jit-ui#93): `combined` = one
   *  z-indexed geojson (single-file z-stack); `per-slice-file` = one geojson per
   *  slice-file (folder stack). Meaningless outside stack mode. */
  getStackSaveLayout(): StackSaveLayout {
    return this.scope.saveLayout;
  }

  /**
   * Enter per-slice stack mode. `slices` maps each zero-based slice index to
   * the regions imported for that slice; the store makes `initialZ`'s slice the
   * live set, so the overlays / selection / Regions table are unchanged (they
   * still read {@link getRegions}). Freshly-created regions are tagged with the
   * current slice so they persist on it, and {@link getSliceRegions} returns
   * every slice for save/export. Ids/names/classification colours are minted
   * exactly as {@link setRegions} does.
   */
  enterStackMode(slices: Map<number, Region[]>, initialZ = 0, saveLayout: StackSaveLayout = 'combined'): void {
    const admitted = new Map<number, Region[]>();
    for (const [z, regs] of slices) admitted.set(z, this.normalizeSlice(regs || [], z));
    this.regions = this.scope.enterStack(admitted, initialZ, saveLayout);
    this.selection.replace([]);
    this.syncCache();
    this.resetUndoHistory();
    this.emitSelection();
    this.emit();
    this.refreshSourceView();
  }

  /** Leave stack mode (single-plane image, or the stack was closed). */
  exitStackMode(): void {
    this.scope.exitStack();
    this.refreshSourceView();
  }

  /** The live-set swap of {@link setDisplaySlice}. */
  private showSlice(z: number): void {
    const next = this.scope.showSlice(z, this.regions);
    if (!next) return;
    this.regions = next;
    this.selection.replace([]);
    this.syncCache();
    this.resetUndoHistory();
    this.emitSelection();
    this.emit();
    this.refreshSourceView();
  }

  /**
   * Show a different slice: capture the current slice's (possibly edited)
   * regions back into the per-slice store, then load the target slice's regions
   * as the live set and emit. Undo never crosses a slice. Outside stack mode
   * this only records the requested slice index (a no-op otherwise: single-plane
   * regions stay on the default plane — addRegion tags Region.z only in stack
   * mode, so the recorded index is unused until a stack is entered). (jit-ui#93)
   * Either way {@link getRegionSetReplaced$} emits: the slice on screen changed
   * under any in-progress tool work.
   */
  setDisplaySlice(z: number): void {
    this.showSlice(z);
    this.regionSetReplaced$.next();
  }

  /**
   * Every slice's regions for save/export, each tagged with its zero-based
   * slice index in {@link Region.z}. Captures the current slice's live edits
   * first. Returns the flat single-plane set when not in stack mode. (jit-ui#93)
   */
  getSliceRegions(): Region[] {
    return this.scope.sliceRegions(this.regions);
  }

  /**
   * Slices to write on a per-slice-file save (folder stack, jit-ui#93): every
   * slice that currently has regions, PLUS slices that were loaded non-empty but
   * are now empty (so their file is re-written empty, clearing a slice whose
   * regions the user deleted). Each returned region is tagged with its z, and
   * the current live slice is captured first. Empty outside stack mode.
   */
  getStackSaveSlices(): Map<number, Region[]> {
    const slices = this.scope.stackSaveSlices(this.regions);
    // A slice whose region source lost features (taken, deleted) is re-written too.
    const changed = this.sources.slicesWithTaken(this.scope.activeImage).filter((z) => !slices.has(z));
    if (!changed.length) return slices;
    for (const z of changed) slices.set(z, []);
    return new Map(Array.from(slices).sort((a, b) => a[0] - b[0]));
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

  /**
   * Emits after every {@link undo}, {@link redo} and {@link setDisplaySlice} call
   * (even one that changed nothing): the region set was replaced under whatever
   * a canvas tool was building on (a brush stroke, a SAM point prompt), so the
   * backends reset their canvas tools on it. Not emitted for ordinary edits —
   * a tool's own commit must not reset it.
   */
  getRegionSetReplaced$(): Observable<void> {
    return this.regionSetReplaced$.asObservable();
  }

  // ── IRegionStore: selection ────────────────────────────────────────────

  /** Select regions by array index (or [] to clear). Stored internally by id
   *  so the selection survives subsequent edits/reorders. */
  setSelectedShapeIndices(indices: number[]): void {
    this.selection.selectIndices(indices, this.regions);
  }

  /** Select a single region by identity (id). Backends call this from their
   *  `selectRegion()`; the OSD overlay + region editor highlight off the
   *  resulting selection emit. No-op if the region isn't in the store. */
  selectRegion(region: Region): void {
    if (region?.id == null || this.indexOfId(region.id) < 0) return;
    this.selection.replace([region.id]);
    this.emitSelection();
  }

  getSelectedShapeIndices$(): Observable<number[]> {
    return this.selection.indices$;
  }

  /** Synchronous current selection (array indices) — for callers that need to
   *  read the selection without subscribing. */
  getSelectedShapeIndices(): number[] {
    return this.selection.indices;
  }

  /** Delete the currently selected regions and clear the selection. */
  deleteActiveShape(): void {
    if (this.selection.ids.length === 0) return;
    this.recordUndoSnapshot();
    const ids = new Set(this.selection.ids);
    this.regions = this.regions.filter((r) => !ids.has(r.id));
    this.selection.replace([]);
    this.syncCache();
    this.emitSelection();
    this.emit();
  }

  // ── IRegionStore: colours / labels ─────────────────────────────────────

  getShowShapeLabel(): boolean {
    return this.showShapeLabel;
  }
  getShapeColor(): string {
    return this.shapeColor;
  }
  getFillColor(): string {
    return this.fillColor;
  }

  /** Show or hide region labels (not on the contract; specs drive it directly).
   *  @deprecated Nothing in the library calls it; will be removed next minor. */
  setShowShapeLabel(show: boolean): void {
    this.showShapeLabel = show;
    this.republishView();
  }

  getClassificationColors(): Map<string, string> {
    return this.store.getClassificationColors();
  }
  setClassificationColor(label: string, color: string): void {
    this.store.setClassificationColor(label, color);
  }

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
    const snapshot = this.history.undo(this.snapshot());
    if (snapshot) this.restoreSnapshot(snapshot);
    this.regionSetReplaced$.next();
  }

  /**
   * Redo the action most recently undone, restoring the region set to the state
   * it had before that undo and pushing the current state back onto the undo
   * stack. No-op when there's nothing to redo (the redo stack is cleared by any
   * fresh region action).
   */
  redo(): void {
    const snapshot = this.history.redo(this.snapshot());
    if (snapshot) this.restoreSnapshot(snapshot);
    this.regionSetReplaced$.next();
  }

  /** Discard the undo/redo history (e.g. on image load/switch — history never
   *  crosses images). */
  resetUndoHistory(): void {
    this.history.reset();
  }

  /** Make `snapshot` the live region set and notify both backends. Shared by
   *  {@link undo} and {@link redo}; nothing records history while it runs. */
  private restoreSnapshot(snapshot: RegionSnapshot): void {
    this.history.restore(() => {
      this.regions = snapshot.regions.slice();
      this.setTaken(snapshot.taken);
      this.syncCache();
      // Drops any selected ids the restored set no longer contains.
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
    this.history.record(this.snapshot());
  }

  /** The state an undo step restores. */
  private snapshot(): RegionSnapshot {
    return { regions: this.regions, taken: this.currentTaken() };
  }

  // ── IRegionStore: GeoJSON I/O (models/region-geojson) ──────────────────

  /** Parse GeoJSON into regions, remembering the class colours the file carries so they are
   *  kept for classes with no preset (see VisualizerStore.rememberImportedClassColors). */
  importRegions(geoJsonStr: string): Region[] {
    const regions = regionsFromGeoJson(geoJsonStr);
    const colors = new Map<string, string>();
    for (const r of regions) {
      if (r.label && r.color && !colors.has(r.label)) colors.set(r.label, r.color);
    }
    if (colors.size) this.store.rememberImportedClassColors(colors);
    return regions;
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
    region.bounds = hydrateBounds(region.bounds); // jit-ui#124
    // A region drawn on a stack belongs to the slice currently displayed, so
    // it saves/reloads on that slice (jit-ui#93). No-op for single-plane images
    // (the display slice stays 0).
    if (this.scope.stackMode) region.z = this.scope.displaySlice;
    // The caller's instance becomes the stored one (completed in place).
    const [stored] = this.withClassificationColors([region], () => true);
    this.regions = [...this.regions, stored];
    this.selection.replace([stored.id]);
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
    this.selection.retain((s) => !drop.has(s));
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

  // ── Region sources: large region sets, tiled by level of detail ─────────

  /**
   * Hold a large region set as a tiled region source instead of as regions: the backends that
   * draw sources (OpenSeadragon, napari) draw its features at the detail the zoom shows, from
   * the tiles in view, and a feature joins the regions — exactly, as an ordinary editable
   * {@link Region} with its {@link Region.sourceId} — only when it is selected or edited
   * ({@link takeSourceFeatures}). Until then {@link getRegions} does not include it.
   *
   * `source` may be an opener, called the first time its slice is shown (and again if the
   * source was closed to save memory). `slices` says which slice of the current image it
   * serves: one (default: the slice shown; plane 0 of the source), or `'planes'`, every slice z
   * from plane z of a z-indexed source. Replaces the source those slices had.
   */
  attachRegionSource(
    source: RegionSource | RegionSourceOpener,
    slices: RegionSourceSlices = { slice: this.sourceSlice },
  ): void {
    const image = this.scope.activeImage;
    if (!image) return;
    const open: RegionSourceOpener = typeof source === 'function' ? source : () => Promise.resolve(source);
    this.sources.attach(image, open, slices);
    this.refreshSourceView();
  }

  /** Drop the current image's region sources (closing them) and what was taken from them. */
  detachRegionSources(): void {
    const image = this.scope.activeImage;
    if (!image) return;
    this.sources.detachImage(image);
    this.refreshSourceView();
  }

  /** Whether the slice shown has a region source. */
  hasRegionSource(): boolean {
    return this.sources.has(this.scope.activeImage, this.sourceSlice);
  }

  /** The slice's region source as a source layer draws it; null without one (or until it opens). */
  getRegionSourceView(): RegionSourceView | null {
    return this.sourceView$.value;
  }

  /** {@link getRegionSourceView} and every change of it (slice, taken ids, class colours). */
  getRegionSourceView$(): Observable<RegionSourceView | null> {
    return this.sourceView$.asObservable();
  }

  /**
   * Take source features into the working set for editing: their exact geometry becomes
   * ordinary regions (minted, coloured and slice-tagged as any region entering the store) and
   * the source stops drawing them. Not an undo step of its own — undoing past it puts the
   * features back in the source. Resolves the region ids, in the order asked (a feature already
   * taken resolves to its region); [] when the slice changed meanwhile.
   */
  async takeSourceFeatures(ids: readonly string[]): Promise<number[]> {
    const view = this.sourceView$.value;
    if (!view || !ids.length) return [];
    const generation = this.sourceGeneration;
    const wanted = ids.filter((id) => !view.taken.has(id));
    const features = wanted.length ? await view.source.getFeatures(wanted) : [];
    if (generation !== this.sourceGeneration) return [];
    const taken = this.currentTaken();
    const fresh = features.filter((f) => !taken.has(f.id));
    if (fresh.length) {
      const regions = fresh.map((f) => {
        const region = regionFromGeoJsonFeature(f.feature as GeoJsonFeature, 0, f.id);
        if (this.scope.stackMode) region.z = this.scope.displaySlice;
        return region;
      });
      const admitted = this.admit(regions);
      // Fresh instances, completed in place: named after their new id like a drawn region.
      for (const r of admitted) r.name = `shape${r.id}`;
      this.regions = this.regions.concat(admitted);
      this.setTaken(new Set([...taken, ...fresh.map((f) => f.id)]));
      this.syncCache();
      this.emitSelection();
      this.emit();
    }
    const bySource = new Map(this.regions.filter((r) => r.sourceId !== undefined).map((r) => [r.sourceId, r.id]));
    return ids.map((id) => bySource.get(id)).filter((id): id is number => id !== undefined);
  }

  /** {@link takeSourceFeatures}, then select them (added to the selection with `additive`). */
  async selectSourceFeatures(ids: readonly string[], additive = false): Promise<number[]> {
    const taken = await this.takeSourceFeatures(ids);
    if (!taken.length) return taken;
    this.selection.replace(additive ? [...new Set([...this.selection.ids, ...taken])] : taken);
    this.emitSelection();
    return taken;
  }

  /** Features per class still in the slice's region source (not taken); {} without one. */
  async getRegionSourceClassCounts(): Promise<Record<string, number>> {
    const view = this.sourceView$.value;
    if (!view) return {};
    return view.source.getClassCounts(view.plane, Array.from(view.taken));
  }

  /**
   * Select every region of these classes on the slice — the regions', and the region source's,
   * which are taken into the regions (at most {@link SELECT_CLASSES_LIMIT} of them). Added to the
   * selection with `additive`. Resolves the selected region ids.
   */
  async selectClasses(classes: readonly string[], additive = false): Promise<number[]> {
    const wanted = new Set(classes);
    const view = this.sourceView$.value;
    if (view && classes.length) {
      const page = await view.source.getIndex(view.plane, {
        offset: 0,
        limit: SELECT_CLASSES_LIMIT,
        classes,
        exclude: Array.from(view.taken),
      });
      if (page.rows.length) await this.takeSourceFeatures(page.rows.map((r) => r.id));
    }
    const ids = this.regions.filter((r) => !r.isProfile?.() && r.label && wanted.has(r.label)).map((r) => r.id);
    this.selection.replace(additive ? [...new Set([...this.selection.ids, ...ids])] : ids);
    this.emitSelection();
    return ids;
  }

  /** Delete source features without taking them (one undo step). */
  deleteSourceFeatures(ids: readonly string[]): void {
    const taken = this.currentTaken();
    const drop = ids.filter((id) => !taken.has(id));
    if (!drop.length || !this.sourceView$.value) return;
    this.recordUndoSnapshot();
    this.setTaken(new Set([...taken, ...drop]));
    this.emit();
  }

  /**
   * A page of the slice source's features not taken from it (file order), e.g. for the Region
   * Editor's list; an empty page without a source.
   */
  async getRegionSourceIndex(query: Omit<RegionIndexQuery, 'exclude'>): Promise<RegionIndexPage> {
    const view = this.sourceView$.value;
    if (!view) return { total: 0, rows: [] };
    return view.source.getIndex(view.plane, { ...query, exclude: Array.from(view.taken) });
  }

  /**
   * `regions` as a GeoJSON FeatureCollection string merged with the region source behind them:
   * the source's features that were not taken (or deleted), then `regions`. Without a source,
   * {@link getGeoJsonString}. `slice` names a folder stack's slice (default the one shown);
   * on a z-indexed stack's source (`'planes'`) the export spans every slice.
   */
  async getGeoJsonWithSource(regions: Region[], slice = this.sourceSlice): Promise<string> {
    const image = this.scope.activeImage;
    const planes = this.scope.stackMode && this.sources.hasPlanesSource(image);
    const binding = await this.sources.binding(image, slice);
    if (!binding) return regionsToGeoJson(regions);
    const features = regions
      .filter((r) => !r.isProfile?.())
      .map((r) => featureFromRegion(r))
      .filter((f): f is object => !!f);
    const exclude = planes ? this.sources.allTaken(image) : Array.from(this.sources.taken(image, slice));
    return binding.source.exportGeoJson(exclude, features);
  }

  // ── Region look ────────────────────────────────────────────────────────

  /** The region look: outlines, or filled (an atlas's look); see `region-style`. */
  getRegionStyle(): RegionStyle {
    return this.regionStyle$.value;
  }

  /** {@link getRegionStyle} and every change of it. */
  getRegionStyle$(): Observable<RegionStyle> {
    return this.regionStyle$.asObservable();
  }

  /**
   * Choose the region look, field by field; it overrides a region source's hint for the session.
   * The overlays redraw.
   */
  setRegionStyle(patch: Partial<RegionStyle>): void {
    this.userStyle = { ...this.userStyle, ...patch };
    this.restyle();
  }

  /** The look now: the user's choice, else the source's hint, else outlines. */
  private effectiveStyle(): RegionStyle {
    const hint = this.hintStyle ?? {};
    return {
      fillOpacity: this.userStyle.fillOpacity ?? hint.fillOpacity ?? DEFAULT_REGION_STYLE.fillOpacity,
      stroke: this.userStyle.stroke !== undefined ? this.userStyle.stroke : (hint.stroke ?? null),
      strokeWidth:
        this.userStyle.strokeWidth !== undefined ? this.userStyle.strokeWidth : (hint.strokeWidth ?? null),
      highlight: this.userStyle.highlight !== undefined ? this.userStyle.highlight : (hint.highlight ?? null),
    };
  }

  /** Publish the look when it changed: the overlays redraw the regions, the source layer its features. */
  private restyle(redraw = false): void {
    const next = this.effectiveStyle();
    const cur = this.regionStyle$.value;
    const same = (Object.keys(next) as Array<keyof RegionStyle>).every((k) => next[k] === cur[k]);
    if (!same) this.regionStyle$.next(next);
    const view = this.sourceView$.value;
    if (redraw || !same || (view && view.labels !== this.showShapeLabel)) {
      this.republishView();
      this.regionUpdate$.next(this.getRegions());
    }
  }

  /** Re-emit the source view with the current look and label setting. */
  private republishView(): void {
    const view = this.sourceView$.value;
    if (view) this.sourceView$.next({ ...view, style: this.regionStyle$.value, labels: this.showShapeLabel });
  }

  /** The slice a region source is keyed by: the display slice in stack mode, else 0. */
  private get sourceSlice(): number {
    return this.scope.stackMode ? this.scope.displaySlice : 0;
  }

  private currentTaken(): ReadonlySet<string> {
    return this.sources.taken(this.scope.activeImage, this.sourceSlice);
  }

  /** Replace the slice's taken ids and tell the source layers. */
  private setTaken(taken: ReadonlySet<string>): void {
    if (taken === this.currentTaken()) return;
    this.sources.setTaken(this.scope.activeImage, this.sourceSlice, taken);
    const view = this.sourceView$.value;
    if (view) this.sourceView$.next({ ...view, taken });
  }

  /** Look up (opening it if needed) the slice's source and publish it as the source view. */
  private refreshSourceView(): void {
    const generation = ++this.sourceGeneration;
    const image = this.scope.activeImage;
    const slice = this.sourceSlice;
    if (!this.sources.has(image, slice)) {
      if (this.sourceView$.value) this.sourceView$.next(null);
      this.hintStyle = undefined;
      this.restyle();
      return;
    }
    this.sources.binding(image, slice).then(
      (binding) => {
        if (generation !== this.sourceGeneration) return;
        if (!binding) {
          this.sourceView$.next(null);
          return;
        }
        const info = binding.source.info;
        const classColors = Object.entries(info.classColors);
        if (classColors.length) this.store.rememberImportedClassColors(new Map(classColors));
        // A source that asks for labels gets them when it opens (the toggle still turns them off).
        const labelsOn =
          !!info.style?.labels && !this.showShapeLabel && this.sourceView$.value?.source !== binding.source;
        if (labelsOn) this.showShapeLabel = true;
        this.hintStyle = info.style;
        this.sourceView$.next({
          source: binding.source,
          plane: binding.plane,
          taken: this.sources.taken(image, slice),
          colorOf: (f) =>
            f.label ? colorForLabel(f.label, this.store.getPresetSet()) : f.color || this.shapeColor,
          style: this.regionStyle$.value,
          labels: this.showShapeLabel,
        });
        this.restyle(labelsOn);
      },
      (err) => {
        if (generation !== this.sourceGeneration) return;
        console.warn('[regions] could not open the region source', err);
        this.sourceView$.next(null);
      },
    );
  }

  // ── per-image lifecycle ────────────────────────────────────────────────

  /**
   * Switch the active image: snapshot the outgoing regions, restore the
   * incoming image's (or [] if none), clear selection, and notify. Idempotent
   * for the same image (so repeated replots of one image keep its regions).
   */
  setActiveImage(imageInfo: IImageInfo): void {
    // Switching images also ends any per-slice stack session (jit-ui#93).
    const incoming = this.scope.switchImage(RegionScopeCache.imageKey(imageInfo), this.regions);
    if (!incoming) return;
    this.regions = incoming;
    this.selection.replace([]);
    // Undo never crosses an image switch.
    this.resetUndoHistory();
    this.emitSelection();
    this.regionUpdate$.next(this.getRegions());
    this.refreshSourceView();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Apply the preset set's class colours (see {@link applyPresetColors}),
   *  promoting unknown classes into the shared store when the set asks for it. */
  private withClassificationColors(regions: Region[], inPlace: (r: Region) => boolean): Region[] {
    return applyPresetColors(regions, this.store.getPresetSet(), {
      inPlace,
      onPromote: (preset) => this.store.upsertClass(preset),
    });
  }

  private syncCache(): void {
    this.scope.sync(this.regions);
  }

  private emit(): void {
    // Live-edit listeners (e.g. the intensity-profile inset) react on EVERY
    // change — including per-frame during a batched drag — so they track the
    // region live. The main regionUpdate$ stays coalesced during a batch (fires
    // once on endBatch) to keep heavier consumers (Regions tab) calm.
    this.regionLiveEdit$.next(this.regions.slice());
    if (this.batchDepth > 0) {
      this.pendingEmit = true;
      return;
    }
    this.regionUpdate$.next(this.getRegions());
  }

  /** Project the selected ids onto the current regions (pruning gone ones);
   *  emits only if the index set changed. */
  private emitSelection(): void {
    this.selection.sync(this.regions);
  }

  private findById(id: number): Region | undefined {
    return this.regions.find((r) => r.id === id);
  }

  private indexOfId(id: number): number {
    return this.regions.findIndex((r) => r.id === id);
  }
}
