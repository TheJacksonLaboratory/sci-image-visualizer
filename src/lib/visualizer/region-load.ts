import type { HttpClient } from '@angular/common/http';
import { IImageInfo } from '../contracts/image.contract';
import { IRegionStore } from '../contracts/visualizer.contract';
import { Region } from '../models/region';
import { openHttpRegionSource } from '../region-source/http-region-source';
import { REGION_SOURCE_MIN_CHARS, RegionSource } from '../region-source/region-source';
import { openGeoJsonRegionSource } from '../region-source/worker-region-source';
import type { RegionSourceOpener, RegionSourceSlices } from '../store/region-source-scope';

/** The region-store members {@link applyImageRois} writes through. A target without
 *  `attachRegionSource` loads every ROI file as regions. */
export type RegionLoadTarget = Pick<
  IRegionStore,
  'importRegions' | 'enterStackMode' | 'setRegions' | 'resetUndoHistory'
> & {
  attachRegionSource?(source: RegionSource | RegionSourceOpener, slices?: RegionSourceSlices): void;
  /** The slice shown now (what a stack's source, laid out once it opens, makes live). */
  getDisplaySlice?(): number;
};

/** Per target, the latest {@link applyImageRois}: a stack source that opens after a later load is dropped. */
const loads = new WeakMap<RegionLoadTarget, number>();

/**
 * Apply an image's saved ROIs once its render has landed, choosing the region
 * layout from the image's shape:
 *
 *  - **Folder stack** (`isStack && tiled === false`, see loadSeriesAsStack): a stack
 *    of self-contained per-slice files. Each slice-file may carry its own sibling
 *    `<stem>.geojson` (`roiJsonStrs[z]`), but a fresh folder with none yet leaves
 *    `roiJsonStrs` undefined — so this keys off `tiled === false`, NOT `roiJsonStrs`,
 *    and an unannotated folder stack still enters the per-slice-file layout (saving
 *    back one geojson per slice-file) rather than the combined one (jit-ui#93).
 *  - **Single-file z-stack**: one sibling geojson holding every slice's regions,
 *    indexed by QuPath's `geometry.plane.z`. Per-slice (combined) mode is entered when
 *    the geojson actually carries slice indices, or when there is nothing yet to
 *    author against. A legacy geojson whose regions are all on the default plane
 *    stays global (shown on every slice), so existing single-plane annotations are
 *    not confined to slice 0.
 *  - **Single plane** (or that legacy global stack): one region set for the image.
 *    Loading saved ROIs is not a user edit, so the undo history starts fresh and the
 *    first undo cannot wipe them (jit-ui#85).
 *
 * Large ROI files (`minSourceChars` and up) and a server-side source (`regionSourceUrl`)
 * become tiled region sources instead of regions; a z-indexed one serves each slice its own
 * plane. On a single-file stack the source is opened first, to tell which: one on the default
 * plane only stays global, as its regions would. A folder stack's sources open lazily, the first
 * time their slice is shown.
 *
 * `z` is the slice shown now; entering stack mode makes it live and resets undo. `http`, the
 * host's `HttpClient`, carries a server-side source's requests, so the host's interceptors (its
 * auth) apply to them as to the image tiles.
 */
export function applyImageRois(
  info: IImageInfo,
  target: RegionLoadTarget,
  z: number,
  minSourceChars = REGION_SOURCE_MIN_CHARS,
  http?: HttpClient,
): void {
  const attach = target.attachRegionSource?.bind(target);
  const load = (loads.get(target) ?? 0) + 1;
  loads.set(target, load);
  const asSource = (json: string | null | undefined): json is string =>
    !!attach && !!json && json.length >= minSourceChars;

  if (info.isStack && info.tiled === false) {
    const perSlice = info.roiJsonStrs;
    const sliceCount = info.urls?.length ?? perSlice?.length ?? 0;
    const slices = new Map<number, Region[]>();
    const sourced: number[] = [];
    for (let s = 0; s < sliceCount; s++) {
      const json = perSlice?.[s] ?? null;
      if (asSource(json)) sourced.push(s);
      slices.set(s, json && !asSource(json) ? target.importRegions(json) : []);
    }
    target.enterStackMode(slices, z, 'per-slice-file');
    for (const s of sourced) attach?.(() => openGeoJsonRegionSource(perSlice?.[s] as string), { slice: s });
    return;
  }

  const roiJson = info.roiJsonStr;
  if (attach && (info.regionSourceUrl || asSource(roiJson))) {
    const url = info.regionSourceUrl;
    const open: RegionSourceOpener = url
      ? () => openHttpRegionSource(url, { http })
      : () => openGeoJsonRegionSource(roiJson as string);
    // As loading a file of regions replaces the regions, a source starts the image afresh.
    target.setRegions([]);
    target.resetUndoHistory();
    if (!info.isStack) {
      attach(open, { slice: 0 });
      return;
    }
    // A stack: per slice when the source is z-indexed, else global (as its regions would be).
    let first: Promise<RegionSource> | null = open();
    const reuse: RegionSourceOpener = () => {
      const opening = first;
      first = null;
      return opening ?? open();
    };
    const lay = (zIndexed: boolean) => {
      if (loads.get(target) !== load) {
        void first?.then(
          (source) => source.dispose(),
          () => undefined,
        );
        return;
      }
      if (zIndexed) {
        target.enterStackMode(new Map(), target.getDisplaySlice?.() ?? z, 'combined');
        attach(reuse, 'planes');
      } else {
        attach(reuse, { slice: 0 });
      }
    };
    // One that cannot be opened is attached as a single plane (its slice reports the failure).
    first.then(
      (source) => lay(source.info.planes.some((p) => p !== 0)),
      () => lay(false),
    );
    return;
  }
  if (info.isStack) {
    const regions = roiJson ? target.importRegions(roiJson) : [];
    if (!roiJson || regions.some((r) => (r.z ?? 0) !== 0)) {
      target.enterStackMode(bySlice(regions), z, 'combined');
      return;
    }
  }
  if (roiJson) target.setRegions(target.importRegions(roiJson));
  target.resetUndoHistory();
}

/** Bucket regions by their zero-based {@link Region.z} (unset = slice 0). */
function bySlice(regions: Region[]): Map<number, Region[]> {
  const slices = new Map<number, Region[]>();
  for (const r of regions) {
    const z = r.z ?? 0;
    const bucket = slices.get(z);
    if (bucket) bucket.push(r);
    else slices.set(z, [r]);
  }
  return slices;
}
