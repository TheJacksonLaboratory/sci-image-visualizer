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
