import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { Region } from '../models/region';
import { ClassPreset, PresetSet } from '../models/class-preset';
import { IImageMetadata } from './image.contract';
import type { RegionSourceView } from '../region-source/region-source';
import type { RegionIndexPage, RegionIndexQuery } from '../region-source/region-tiles';

/**
 * Public, implementation-agnostic surface that the Region Editor (an *external*
 * consumer of the visualization package) depends on. It deals only in
 * **annotation** regions — intensity-profile lines (`Region.isProfile()`) are
 * owned by the intensity tool and are filtered out / preserved internally, so
 * the editor never sees or disturbs them.
 *
 * The editor injects this via {@link REGION_EDITOR_API} (bound to the concrete
 * `RoutingVisualizerService` with `useExisting`) instead of importing the
 * service class, so it cannot reach the implementation. This is the boundary
 * that lets `services/visualization` become a library whose only public surface
 * is the contracts.
 *
 * Selection is expressed in terms of {@link Region}s, not array indices — the
 * index space (which includes profile lines) stays internal to the package.
 */
export interface IRegionEditorApi {
  // ── display defaults ─────────────────────────────────────────────────
  getShowShapeLabel(): boolean;
  getShapeColor(): string;
  getFillColor(): string;

  // ── annotation regions (profile lines excluded & preserved internally) ─
  /** Annotation regions for the current image. Intensity-profile lines are
   *  never included. */
  getAnnotationRegions(): Region[];
  /** Replace the annotation regions. Intensity-profile lines in the store are
   *  preserved (the editor must not be able to drop them). */
  setAnnotationRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
  ): void;
  /** Change signal — fires whenever regions change on any backend. */
  getRegionUpdateEvent(): Observable<Region[]>;

  // ── selection (by region identity; index space stays internal) ────────
  /** The currently-selected annotation regions (profile lines never appear). */
  getSelectedRegions$(): Observable<Region[]>;
  /** Set the selection to these regions. */
  setSelectedRegions(regions: Region[]): void;

  // ── classification colours ────────────────────────────────────────────
  getClassificationColors(): Map<string, string>;
  setClassificationColor(label: string, color: string): void;

  // ── annotation-class presets (jit-ui#70) ───────────────────────────────
  /** The current per-user preset set (source of truth for region colours). */
  getPresetSet(): PresetSet;
  /** Emits the preset set on every change (BehaviorSubject-backed). */
  getPresetSet$(): Observable<PresetSet>;
  /** Replace the whole preset set (persists per-user). */
  setPresetSet(set: PresetSet): void;
  /** Add or update one class by name (persists). */
  upsertClass(preset: ClassPreset): void;
  /** Remove a class by name (persists). */
  removeClass(name: string): void;
  /** Restore the default preset set (persists). */
  resetPresets(): void;

  // ── image metadata (for region areas in µm²) ──────────────────────────
  getImageMeta(): Observable<IImageMetadata[]>;

  // ── import / export ────────────────────────────────────────────────────
  importRegions(geoJsonStr: string): Region[];
  getGeoJsonString(regions: Region[]): string;

  // ── per-slice z-stacks (jit-ui#93) ──────────────────────────────────────
  /** True while a per-slice z-stack region session is active — the editor then
   *  saves/edits regions per displayed slice. */
  isStackMode(): boolean;
  /** How the current stack persists: `combined` = one z-indexed geojson
   *  (single-file z-stack, QuPath schema); `per-slice-file` = one geojson per
   *  slice-file (folder stack). */
  getStackSaveLayout(): 'combined' | 'per-slice-file';
  /** Every slice's annotation regions (profile lines excluded), each tagged
   *  with its zero-based {@link Region.z}, for a combined z-indexed save. */
  getSliceAnnotationRegions(): Region[];
  /** Per-slice annotation regions for a folder-stack (`per-slice-file`) save:
   *  zero-based slice index → that slice's annotation regions. Includes
   *  now-empty slices loaded non-empty, so their file is overwritten empty. */
  getStackSaveAnnotationSlices(): Map<number, Region[]>;
  /**
   * Full-resolution image size (image-pixel dimensions) used to size an exported
   * region mask. Backend-neutral: prefers the active renderer's reported size
   * and falls back to the image metadata. Returns null when no size is known.
   *
   * The mask itself is rasterized off the main thread (see the Region Editor's
   * mask worker) from the region geometry and this size.
   */
  getMaskImageSize(): { width: number; height: number } | null;

  // ── region sources: large region sets, tiled by level of detail (optional) ─
  /**
   * Load `geoJsonStr` as the slice's region source when it is large enough
   * (`VizConfig.regionSourceMinChars`): resolves true once it is open, false when it is small
   * and should be imported as regions; rejects when it is not a GeoJSON FeatureCollection.
   */
  importRegionSource?(geoJsonStr: string): Promise<boolean>;
  /** The slice's region source (null without one) and every change of it. */
  getRegionSourceView$?(): Observable<RegionSourceView | null>;
  /** A page of the slice source's features that were not taken from it. */
  getRegionSourceIndex?(query: Omit<RegionIndexQuery, 'exclude'>): Promise<RegionIndexPage>;
  /** Take source features into the regions and select them (added with `additive`). */
  selectSourceFeatures?(ids: readonly string[], additive?: boolean): Promise<number[]>;
  /** Delete source features without taking them (one undo step). */
  deleteSourceFeatures?(ids: readonly string[]): void;
  /** Features per class still in the slice's region source (not taken). */
  getRegionSourceClassCounts?(): Promise<Record<string, number>>;
  /** Select every region of these classes on the slice, the source's included (taken). */
  selectRegionClasses?(classes: readonly string[], additive?: boolean): Promise<void>;
  /** {@link getGeoJsonString} merged with the region source behind the regions (see
   *  `RegionStore.getGeoJsonWithSource`); `slice` names a folder stack's slice. */
  getGeoJsonStringWithSource?(regions: Region[], slice?: number): Promise<string>;
}

/** DI token the Region Editor injects instead of the concrete service. */
export const REGION_EDITOR_API = new InjectionToken<IRegionEditorApi>('REGION_EDITOR_API');
