import { IHistogram } from './channel-histogram-api.contract';

/**
 * Shared intensity helpers (refactoring plan, Step 5). The two backends use
 * two DIFFERENT scalar projections by design — do not unify them:
 *  - Plotly projects `[r,g,b]` frame cells with ITU-R BT.601 luminance (matches
 *    what its heatmap has always rendered);
 *  - the OSD tile path takes the max of the decoded RGBA channels (single-band
 *    tiles encode gray as r=g=b, so max is exact; it also tolerates tinted
 *    pixels).
 */

/** ITU-R BT.601 luminance for an RGB pixel (Plotly's scalar projection). */
export function bt601Luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Max of the three channels (the OSD tile path's scalar projection).
 *  NOTE: the per-pixel recolor loop in `osd/display-pipeline.ts` keeps this
 *  inlined on purpose — it runs ~262k times per tile. */
export function maxRgb(r: number, g: number, b: number): number {
  return r >= g ? (r >= b ? r : b) : g >= b ? g : b;
}

/** Wrap 256 raw bin counts as an IHistogram (0..255 left edges + max). */
export function histogram256(counts: number[]): IHistogram {
  return {
    bins: Array.from({ length: 256 }, (_, i) => i),
    counts,
    max: counts.reduce((m, c) => (c > m ? c : m), 0),
  };
}

/**
 * Saturation-based auto-window: pick `[min, max]` so about `saturation` (0..0.5) of the
 * pixels clip at each end of the histogram. A dominant first or last bin (unscanned
 * padding, clipped background) is dropped first so it does not skew the range.
 *
 * Returns values from `h.bins` (native units for a native histogram), or `fallback` when
 * the histogram is empty or holds no counts — each caller keeps its own: the 8-bit store
 * falls back to the full byte range, the channel histogram to its slider bounds.
 */
export function autoWindowFromHistogram(
  h: IHistogram,
  saturation: number,
  fallback: readonly [number, number],
): [number, number] {
  const counts = h.counts.slice();
  const n = counts.length;
  if (n === 0) return [fallback[0], fallback[1]];
  if (n > 2 && counts[0] > counts[1]) counts[0] = 0;
  if (n > 2 && counts[n - 1] > counts[n - 2]) counts[n - 1] = 0;
  let total = 0;
  for (const c of counts) total += c;
  if (total <= 0) return [fallback[0], fallback[1]];
  const target = total * Math.max(0, Math.min(0.5, saturation));
  let acc = 0;
  let min = h.bins[0];
  for (let i = 0; i < n; i++) {
    acc += counts[i];
    if (acc > target) {
      min = h.bins[i];
      break;
    }
  }
  acc = 0;
  let max = h.bins[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    acc += counts[i];
    if (acc > target) {
      max = h.bins[i];
      break;
    }
  }
  return [min, max];
}
