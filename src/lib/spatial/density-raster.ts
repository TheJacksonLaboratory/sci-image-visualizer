/**
 * The transcript-density raster's window. Its default colour scale is matplotlib's
 * inferno (`INFERNO_LUT` from napari-js/colormaps), as in Xenium Explorer.
 */

import { quantiles } from './stats';

/** A density window from the non-empty bins: 1st to 99th percentile. */
export function densityAutoRange(values: ArrayLike<number>): [number, number] {
  const q = quantiles(values, [0.01, 0.99], { filter: 'positive' });
  if (!q) return [0, 1];
  const [lo, hi] = q;
  return hi > lo ? [lo, hi] : [0, hi || 1];
}
