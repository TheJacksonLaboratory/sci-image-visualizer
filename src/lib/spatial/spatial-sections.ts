import { SpatialObservations } from '../contracts/spatial-dataset.contract';

/**
 * The planes a **serially sectioned** dataset was actually imaged at.
 *
 * A 3D spatial-omics dataset of this kind is not a cloud that happens to have a z:
 * it is a stack of thin sections, hundreds of microns apart, each one a separate
 * slide. Every observation on a given slide shares that slide's registered z
 * exactly, so the distinct z values ARE the sections — no binning, no tolerance,
 * and no need for a dataset-specific section-label column.
 *
 * That matters for the 3D view, where the cloud reads as a stack of discs and the
 * discs hide the density volumes drawn between them. Being able to show one
 * section's cells against the estimated field is how you check the estimate against
 * the measurement; being able to hide them is how you see the field at all.
 *
 * Deliberately NOT a binning of a continuous z (that is
 * `observationsInSlice`'s job, against a volume's voxel planes). If the z is
 * continuous rather than sectioned there are no sections to offer, and
 * {@link sampledSections} says so by returning null rather than inventing some.
 *
 * Pure — no Angular, no GPU — like `spatial-density.ts`, and tested the same way.
 */

/**
 * Distinct z values beyond which the data is treated as continuous rather than
 * sectioned. Serial sectioning runs to tens or low hundreds of slides (53 for the
 * ABC whole-brain MERFISH atlas); a z that keeps producing new values is a
 * measurement axis, and a "pick one section" control over it would be a lie.
 */
export const MAX_SAMPLED_SECTIONS = 512;

/**
 * The dataset's sampled section positions, ascending — or null when it has no z,
 * no observations, or a z too finely divided to be sections at all.
 *
 * Bails out as soon as the distinct count passes `max`, so a continuous z costs one
 * partial pass rather than a set with one entry per observation.
 */
export function sampledSections(
  obs: SpatialObservations,
  max = MAX_SAMPLED_SECTIONS,
): Float32Array | null {
  const z = obs.z;
  if (!z || obs.count === 0) return null;

  const seen = new Set<number>();
  for (let i = 0; i < obs.count; i++) {
    const v = z[i];
    // A non-finite z places an observation on no section; it must not become one.
    if (!Number.isFinite(v)) continue;
    seen.add(v);
    if (seen.size > max) return null;
  }
  if (seen.size === 0) return null;
  return Float32Array.from(seen).sort();
}

/**
 * Indices of the observations lying on one sampled section.
 *
 * Exact equality on purpose: `z` comes from {@link sampledSections}, which read the
 * values out of this same array, so the comparison cannot drift. Passing a z that
 * is not one of the sampled positions yields nothing, which is the honest answer.
 */
export function observationsInSection(obs: SpatialObservations, z: number): Uint32Array {
  const zs = obs.z;
  if (!zs) return new Uint32Array(0);
  const out = new Uint32Array(obs.count);
  let n = 0;
  for (let i = 0; i < obs.count; i++) {
    if (zs[i] === z) out[n++] = i;
  }
  return out.subarray(0, n);
}

/** Memoized per observations object; see {@link sectionsOf}. */
const memo = new WeakMap<SpatialObservations, Float32Array | null>();

/**
 * {@link sampledSections} for a dataset's observations, computed once.
 *
 * Both the renderer (which filters the cloud's geometry to one section) and the
 * control panel (which offers the sections to pick from) need this list, and the
 * scan reads the z of up to 3.7M observations — so it is memoized on the
 * observations object itself rather than each caller keeping its own copy keyed by
 * a dataset id it has to remember to invalidate. Still referentially transparent:
 * the same observations always give the same sections.
 *
 * Default `max` only; a caller wanting a different cap should call
 * {@link sampledSections} directly and cache it itself.
 */
export function sectionsOf(obs: SpatialObservations): Float32Array | null {
  const hit = memo.get(obs);
  if (hit !== undefined) return hit;
  const sections = sampledSections(obs);
  memo.set(obs, sections);
  return sections;
}
