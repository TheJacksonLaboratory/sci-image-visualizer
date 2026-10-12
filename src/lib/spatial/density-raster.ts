/**
 * The transcript-density raster's window and default colour scale.
 */

import { quantiles } from './stats';

/** A density window from the non-empty bins: 1st to 99th percentile. */
export function densityAutoRange(values: ArrayLike<number>): [number, number] {
  const q = quantiles(values, [0.01, 0.99], { filter: 'positive' });
  if (!q) return [0, 1];
  const [lo, hi] = q;
  return hi > lo ? [lo, hi] : [0, hi || 1];
}

/**
 * Inferno (matplotlib), as an inline `[stop, colour]` scale: the density map's default,
 * as in Xenium Explorer. Inline because the colormap tree's `INFERNO_LUT` key is resolved
 * at runtime by the store, which the renderer does not see.
 */
export const INFERNO_SCALE: [number, string][] = [
  [0, '#000004'],
  [0.125, '#1b0c41'],
  [0.25, '#4a0c6b'],
  [0.375, '#781c6d'],
  [0.5, '#a52c60'],
  [0.625, '#cf4446'],
  [0.75, '#ed6925'],
  [0.875, '#fb9b06'],
  [1, '#fcffa4'],
];
