/**
 * What is under the cursor, and what to say about it.
 *
 * A coloured cloud answers "how is this annotation distributed"; it cannot answer
 * "which class is THAT" — the legend has 34 entries, several of them similar
 * colours, and matching a dot to a swatch by eye is exactly the task a tooltip
 * exists to remove.
 *
 * Pure — no DOM, no camera, no data access. The renderer supplies screen
 * positions (it owns the projection) and the active colour source; everything
 * here is arithmetic and string formatting, so it is tested directly.
 */

/** The colour source a tooltip describes, as the renderer already has it. */
export type HoverSource =
  | {
    kind: 'categorical';
    /** Column name, for the tooltip's first line. */
    name: string;
    categories: readonly string[];
    /** Per-observation category index, or `NO_CATEGORY`. */
    codes: Uint16Array;
  }
  | {
    kind: 'continuous';
    /** Column or gene name. */
    name: string;
    values: Float32Array;
    /** Unit for the value, when the dataset declares one. */
    unit?: string;
  };

/**
 * Index of the drawn observation nearest `(x, y)` within `maxDist` screen pixels,
 * or -1.
 *
 * `screen` is `[x0, y0, x1, y1, …]` indexed BY OBSERVATION, with NaN for anything
 * not currently drawn — off screen, behind the eye, or on a hidden section. NaN
 * fails every comparison, so those are skipped without a special case.
 *
 * Ties go to the LATER observation, which is the one drawn on top and therefore
 * the one the user believes they are pointing at.
 */
export function nearestObservation(
  screen: Float32Array,
  x: number,
  y: number,
  maxDist: number,
): number {
  const limit = maxDist * maxDist;
  let best = -1;
  let bestDist = Infinity;
  const n = screen.length >> 1;
  for (let i = 0; i < n; i++) {
    const dx = screen[i * 2] - x;
    const dy = screen[i * 2 + 1] - y;
    const d = dx * dx + dy * dy;
    // `<=` so a later point at the same distance wins: it is drawn on top.
    if (d <= bestDist && d <= limit) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** A number for a tooltip: enough digits to distinguish, few enough to read. */
function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const magnitude = Math.abs(v);
  if (magnitude >= 1000 || magnitude < 0.01) return v.toExponential(2);
  return String(Math.round(v * 100) / 100);
}

/**
 * The tooltip's lines for one observation: what it is, then which column said so.
 *
 * Null when the source cannot describe this observation — a code outside the
 * category list, or a value that was never measured. Saying nothing is better
 * than a tooltip that reads "undefined", and better than inventing a label for a
 * cell whose annotation is genuinely missing.
 */
export function hoverText(source: HoverSource | null, index: number): string[] | null {
  if (!source || index < 0) return null;
  if (source.kind === 'categorical') {
    const code = source.codes?.[index];
    const label = code === undefined ? undefined : source.categories?.[code];
    if (label === undefined) return null;
    return [label, source.name];
  }
  // Guarded rather than indexed straight: this runs from a pointermove handler,
  // so a malformed source would throw on every mouse movement — far worse than a
  // tooltip that stays quiet.
  const value = source.values?.[index];
  if (value === undefined || !Number.isFinite(value)) return null;
  const unit = source.unit ? ` ${source.unit}` : '';
  return [`${formatValue(value)}${unit}`, source.name];
}
