/**
 * What to say about the observation under the cursor.
 *
 * A coloured cloud answers "how is this annotation distributed"; it cannot answer
 * "which class is THAT" — the legend has 34 entries, several of them similar
 * colours, and matching a dot to a swatch by eye is exactly the task a tooltip
 * exists to remove.
 *
 * Pure — no DOM, no camera, no data access. Finding the observation is the
 * renderer's (napari-js picks on the layers it drew); this is string formatting
 * over the active colour source, so it is tested directly.
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
