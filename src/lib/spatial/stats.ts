/**
 * Percentiles for the spatial code: one "collect, sort, index" routine instead of one per
 * caller.
 *
 * The callers used to differ in rounding (`round(p·(n-1))` against `floor(p·n)`), in
 * sampling and in filtering, so windows computed for the same data in different views
 * could disagree. Here there is one rule for each:
 *
 *  - **Rank**: `round(p·(n-1))` — the nearest rank. `floor(p·n)` is biased upward and
 *    hands back the maximum for `p = 0.99` on a hundred values, outlier included.
 *  - **Sort**: a typed-array sort, which is native and numeric — several times faster
 *    than a comparator sort of a boxed `number[]`, and far lighter on the heap.
 *  - **Sample**: past `2·sampleSize` qualifying values, every `floor(count/sampleSize)`-th
 *    one, which is plenty for a display window and keeps a 3.7M-cell recolour from
 *    sorting 3.7M values.
 */

export interface QuantileOptions {
  /** Which values count: every finite one (the default), or only those above zero. */
  filter?: 'finite' | 'positive';
  /** Count index `i` only where `where[i] > 0` — e.g. a field's support. */
  where?: ArrayLike<number>;
  /** Sample down to about this many values (see the module doc); unsampled when absent. */
  sampleSize?: number;
}

/**
 * The `ps` quantiles (each 0..1, clamped) of the values that qualify, or null when none do.
 */
export function quantiles(
  values: ArrayLike<number>,
  ps: readonly number[],
  opts: QuantileOptions = {},
): number[] | null {
  const positive = opts.filter === 'positive';
  const where = opts.where;
  const n = values.length;
  const keep = (i: number): boolean => {
    const v = values[i];
    if (positive ? !(v > 0) : !Number.isFinite(v)) return false;
    return !where || where[i] > 0;
  };

  let count = 0;
  for (let i = 0; i < n; i++) if (keep(i)) count++;
  if (count === 0) return null;

  const step = opts.sampleSize && count >= 2 * opts.sampleSize ? Math.floor(count / opts.sampleSize) : 1;
  const sample = new Float64Array(Math.ceil(count / step));
  let seen = 0;
  let k = 0;
  for (let i = 0; i < n && k < sample.length; i++) {
    if (!keep(i)) continue;
    if (seen++ % step === 0) sample[k++] = values[i];
  }
  const sorted = sample.subarray(0, k).sort();
  const last = sorted.length - 1;
  return ps.map((p) => {
    const f = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0));
    return sorted[Math.round(f * last)];
  });
}

/** One quantile; see {@link quantiles}. */
export function quantile(values: ArrayLike<number>, p: number, opts: QuantileOptions = {}): number | null {
  return quantiles(values, [p], opts)?.[0] ?? null;
}

/** Sample size for a contrast window: a display window does not need every value. */
export const WINDOW_SAMPLE_SIZE = 65_536;

/**
 * A `[lo, hi]` percentile window over the qualifying values, never flat or inverted
 * (a flat window would divide by zero downstream, so it is widened by one), and `[0, 1]`
 * when nothing qualifies, so callers always get a usable window.
 */
export function percentileWindow(
  values: ArrayLike<number>,
  lo: number,
  hi: number,
  opts: QuantileOptions = {},
): [number, number] {
  const q = quantiles(values, [lo, hi], { sampleSize: WINDOW_SAMPLE_SIZE, ...opts });
  if (!q) return [0, 1];
  const [min, max] = q;
  return max > min ? [min, max] : [min, min + 1];
}
