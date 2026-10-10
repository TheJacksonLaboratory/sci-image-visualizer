/**
 * Colouring through a colormap for napari-js layers: the transcript-density raster's window
 * and default scale, and the piecewise-constant colormap a shapes layer uses to show
 * categories (napari-js shapes take values + a colormap, not per-shape RGBA).
 */

import { quantiles } from './stats';

/**
 * A shapes layer colours through a colormap LUT, not per-shape RGBA. A categorical
 * palette becomes a piecewise-constant colormap: category `c` of `n` owns the band
 * `[c/n, (c+1)/n)`, and a shape takes the value at its band's centre, so the LUT's
 * linear filtering never blends two categories.
 *
 * Returns the stops (linear 0..1 RGB) and a function mapping a category code to the
 * value to hand the layer. `missing` is the colour of the extra band used for "no
 * category".
 */
export function discreteColormapStops(
  rgb: readonly (readonly [number, number, number])[], missing: readonly [number, number, number],
): { stops: { t: number; color: [number, number, number] }[]; valueOf: (code: number) => number } {
  const bands = [...rgb, missing];
  const n = bands.length;
  const stops: { t: number; color: [number, number, number] }[] = [];
  const eps = 1e-6;
  bands.forEach((c, i) => {
    const color: [number, number, number] = [c[0] / 255, c[1] / 255, c[2] / 255];
    stops.push({ t: i / n + (i === 0 ? 0 : eps), color });
    stops.push({ t: (i + 1) / n - (i === n - 1 ? 0 : eps), color });
  });
  const missingCode = n - 1;
  return {
    stops,
    valueOf: (code: number) => ((code < 0 || code >= missingCode ? missingCode : code) + 0.5) / n,
  };
}

// ── Density raster ────────────────────────────────────────────────────────────────────

/** A density window from the non-empty bins: 1st to 99th percentile. */
export function densityAutoRange(values: ArrayLike<number>): [number, number] {
  const q = quantiles(values, [0.01, 0.99], { filter: 'positive' });
  if (!q) return [0, 1];
  const [lo, hi] = q;
  return hi > lo ? [lo, hi] : [0, hi || 1];
}

/**
 * Colour density bins through `lut` over the window `[lo, hi]` — Xenium Explorer's
 * "scale threshold". Bins at or below `lo` are transparent, so empty tissue shows the
 * image under it; bins at or above `hi` saturate.
 */
export function colorDensityWindow(
  values: ArrayLike<number>, lut: readonly (readonly [number, number, number])[],
  opacity: number, lo: number, hi: number,
): Uint8Array {
  const n = values.length;
  const rgba = new Uint8Array(n * 4);
  const span = hi > lo ? hi - lo : 1;
  const a = Math.round(255 * opacity);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!(v > lo)) continue;
    const f = Math.min(1, (v - lo) / span);
    const c = lut[Math.min(lut.length - 1, Math.round(f * (lut.length - 1)))];
    rgba[4 * i] = c[0];
    rgba[4 * i + 1] = c[1];
    rgba[4 * i + 2] = c[2];
    rgba[4 * i + 3] = a;
  }
  return rgba;
}

/**
 * Inferno (matplotlib), as an inline `[stop, colour]` scale: the density map's default,
 * as in Xenium Explorer. Inline because the colormap tree's `INFERNO_LUT` key is resolved
 * at runtime by the store, which the renderer does not see.
 */
export const INFERNO_SCALE: [number, string][] = [
  [0, '#000004'], [0.125, '#1b0c41'], [0.25, '#4a0c6b'], [0.375, '#781c6d'], [0.5, '#a52c60'],
  [0.625, '#cf4446'], [0.75, '#ed6925'], [0.875, '#fb9b06'], [1, '#fcffa4'],
];
