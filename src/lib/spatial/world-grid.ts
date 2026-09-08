/**
 * How finely a drawn shape's vertices may be placed in world space.
 *
 * Region geometry has always been stored in whole world units, and for an image that is
 * exactly right: world units ARE pixels, a region should align to them, and integers keep
 * the stored geometry exact and tidy.
 *
 * It is wrong for a dataset whose coordinates are not pixels. seqFISH's observations span
 * about 5 x 7 units in total, so snapping vertices to integers leaves roughly SIX BY EIGHT
 * distinct positions in the whole sample — every ROI collapses to the same handful of
 * boxes and drawing a fine shape is not possible at any zoom. Nothing errors; the tool
 * simply cannot express what the user is drawing.
 *
 * So the step is chosen from the world's own extent rather than assumed to be one. An
 * image keeps integers, because its extent is thousands of units and a finer step would
 * buy nothing; a unitless dataset gets a step fine enough to draw with.
 *
 * Pure — no renderer, no store — so both region overlays can share one answer, and the
 * napari and OSD paths cannot drift into disagreeing about what a vertex may be.
 */

/** One world unit: the step for a world whose units are image pixels. */
export const PIXEL_WORLD_QUANTUM = 1;

/**
 * Distinct positions a drawn shape should be able to reach across the world's extent.
 *
 * Set by what a person can actually place with a pointer, not by float precision: a few
 * thousand steps across the sample is finer than any screen it will be drawn on, so the
 * limit stops being the grid and becomes the hand.
 */
export const WORLD_GRID_STEPS = 4096;

/**
 * The step size for a world of this extent, for a world whose units are NOT pixels.
 *
 * The caller decides which world it has, because the extent cannot say: a 2,000 unit world
 * is a small slide if the units are pixels and an enormous one if they are microns, and
 * only the caller knows which. An image keeps {@link PIXEL_WORLD_QUANTUM} by never asking.
 *
 * Never returns anything coarser than {@link PIXEL_WORLD_QUANTUM}. A non-pixel world can
 * still be large — the Allen atlas is ~11,000 microns across — and there a finer step than
 * one unit buys nothing.
 *
 * Rounded DOWN to a power of ten, so the step is a number a person reading the stored
 * geometry can recognise — 0.001 rather than 0.0017044 — and so it does not shift when the
 * extent changes slightly between datasets.
 *
 * A non-finite or empty extent falls back to the pixel grid: an unknown world is treated
 * as the conservative, established case rather than given an invented precision.
 */
export function worldQuantumForExtent(spanX: number, spanY: number): number {
  const span = Math.max(spanX, spanY);
  if (!Number.isFinite(span) || span <= 0) return PIXEL_WORLD_QUANTUM;
  const wanted = span / WORLD_GRID_STEPS;
  if (wanted >= PIXEL_WORLD_QUANTUM) return PIXEL_WORLD_QUANTUM;
  return 10 ** Math.floor(Math.log10(wanted));
}

/**
 * Snap one world coordinate to the grid.
 *
 * A step of zero or less means no snapping — the caller keeps full float precision.
 * Division and multiplication by the step leaves a float artefact (0.001 * 3 is not
 * exactly 0.003), so the result is rounded to the step's own number of decimals; without
 * that, "tidy" geometry acquires a trail of digits the grid was supposed to remove.
 */
export function snapToWorldGrid(value: number, quantum: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(quantum) || quantum <= 0) return value;
  if (quantum === PIXEL_WORLD_QUANTUM) return Math.round(value);
  const snapped = Math.round(value / quantum) * quantum;
  const decimals = Math.max(0, Math.min(20, -Math.floor(Math.log10(quantum))));
  return Number(snapped.toFixed(decimals));
}
