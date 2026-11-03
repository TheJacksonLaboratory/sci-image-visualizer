import { SpatialObservations } from '../contracts/spatial-dataset.contract';

/**
 * The planes a spatial dataset's region set was outlined on (its `sliceZ`, in observation units,
 * one per slice in slice order), as the 2D view slices them over an image of one plane: plane `k`
 * holds whatever lies nearer to it than to its neighbours, so each z belongs to exactly one plane
 * and the planes together hold the whole depth.
 *
 * Pure, like `spatial-sections.ts` (which offers a sectioned dataset's own z values; these are the
 * planes its segmentation was imaged at).
 */

/**
 * The z band of plane `k`: from halfway to the plane before to halfway to the one after (open
 * ended past the first and the last). The planes may run either way; `[lo, hi)` comes out ordered.
 */
export function planeBand(planes: readonly number[], k: number): [number, number] {
  const n = planes.length;
  if (!n) return [-Infinity, Infinity];
  const i = Math.max(0, Math.min(n - 1, k));
  const z = planes[i];
  const before = i > 0 ? (planes[i - 1] + z) / 2 : null;
  const after = i < n - 1 ? (z + planes[i + 1]) / 2 : null;
  // Ascending planes: the one before is below. Descending: above.
  const ascending = n < 2 || planes[n - 1] >= planes[0];
  const lo = ascending ? before : after;
  const hi = ascending ? after : before;
  return [lo ?? -Infinity, hi ?? Infinity];
}

/** Whether `z` lies in `band` (`[lo, hi)`; a non-finite z lies in none). */
export function inBand(z: number, band: readonly [number, number]): boolean {
  return Number.isFinite(z) && z >= band[0] && z < band[1];
}

/**
 * Indices of the observations on plane `k` (see {@link planeBand}). Every observation is when the
 * dataset carries no z: a flat dataset has nothing to slice.
 */
export function observationsOnPlane(obs: SpatialObservations, planes: readonly number[], k: number): Uint32Array {
  const z = obs.z;
  if (!z) return Uint32Array.from({ length: obs.count }, (_, i) => i);
  const band = planeBand(planes, k);
  const out = new Uint32Array(obs.count);
  let n = 0;
  for (let i = 0; i < obs.count; i++) {
    if (inBand(z[i], band)) out[n++] = i;
  }
  return out.subarray(0, n);
}
