import { IImageInfo } from '../contracts/image.contract';
import { IRegionStore } from '../contracts/visualizer.contract';
import { Region } from '../models/region';

/** The region-store members {@link applyImageRois} writes through. */
export type RegionLoadTarget = Pick<IRegionStore, 'importRegions' | 'enterStackMode' | 'setRegions' |
  'resetUndoHistory'>;

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
 * `z` is the slice shown now; entering stack mode makes it live and resets undo.
 */
export function applyImageRois(info: IImageInfo, target: RegionLoadTarget, z: number): void {
  if (info.isStack && info.tiled === false) {
    const perSlice = info.roiJsonStrs;
    const sliceCount = info.urls?.length ?? perSlice?.length ?? 0;
    const slices = new Map<number, Region[]>();
    for (let s = 0; s < sliceCount; s++) {
      const json = perSlice?.[s] ?? null;
      slices.set(s, json ? target.importRegions(json) : []);
    }
    target.enterStackMode(slices, z, 'per-slice-file');
    return;
  }
  const roiJson = info.roiJsonStr;
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
