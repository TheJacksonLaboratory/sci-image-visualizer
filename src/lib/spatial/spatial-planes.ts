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

/**
 * The planes' mean spacing, `|last − first| / (n − 1)`, in their units: what one slice of a class's
 * volume is thick (see {@link planeWeights}). Null for fewer than two planes, or planes all at one z.
 */
export function planeSpacing(planes: readonly number[]): number | null {
  const n = planes.length;
  if (n < 2) return null;
  const spacing = Math.abs(planes[n - 1] - planes[0]) / (n - 1);
  return Number.isFinite(spacing) && spacing > 0 ? spacing : null;
}

/**
 * How thick each plane's slab of a volume is, in mean spacings ({@link planeSpacing}): its band
 * ({@link planeBand}), the first and the last plane as thick as the gap to their one neighbour.
 * All 1 for evenly spaced planes, so a volume summed over slices (area × weight) is the area times
 * the spacing either way. Null where {@link planeSpacing} is.
 */
export function planeWeights(planes: readonly number[]): number[] | null {
  const spacing = planeSpacing(planes);
  if (spacing == null) return null;
  const n = planes.length;
  return planes.map((z, k) => {
    const [lo, hi] = planeBand(planes, k);
    const gap = Math.abs(k === 0 ? planes[1] - z : planes[n - 2] - z);
    const thick = Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : gap;
    return thick / spacing;
  });
}
