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

/**
 * What the 3D view says of a cell under the pointer (a 3D segmentation's, drawn by itself or as
 * its type's surface): its type (the cell-type column), its id, and a few of its measurements.
 */
export interface CellInfo {
  /** The cell-type column, its categories and each observation's code (null without one). */
  typeName: string | null;
  categories: readonly string[];
  codes: Uint16Array | null;
  /** Cells per category, by code. */
  counts: Uint32Array | null;
  ids?: readonly string[];
  /** Measurements shown (the dataset's continuous columns, a few). */
  measures: readonly { name: string; values: Float32Array; unit?: string }[];
}

/** The tooltip of cell `index`: its type, its id, the colouring's value (when not the type), measurements. */
export function cellText(info: CellInfo | null, index: number, color: HoverSource | null): string[] | null {
  if (!info || index < 0) return null;
  const code = info.codes?.[index];
  const type = code === undefined ? undefined : info.categories[code];
  const lines = [
    type ?? 'Cell',
    info.ids?.[index] !== undefined ? `Cell ${info.ids[index]}` : `Cell #${index + 1}`,
  ];
  if (color && color.name !== info.typeName) {
    const said = hoverText(color, index);
    if (said) lines.push(`${said[1]}: ${said[0]}`);
  }
  for (const m of info.measures) {
    if (m.name === color?.name) continue;
    const v = m.values[index];
    if (v !== undefined && Number.isFinite(v))
      lines.push(`${m.name}: ${formatValue(v)}${m.unit ? ` ${m.unit}` : ''}`);
  }
  return lines;
}

/** The tooltip of a cell type's surface: its name (and title), and how many cells it has. */
export function cellTypeText(info: CellInfo | null, key: string, label?: string): string[] {
  const lines = [label ?? key];
  const code = info ? info.categories.indexOf(key) : -1;
  const n = code >= 0 ? info?.counts?.[code] : undefined;
  if (n !== undefined) lines.push(`${n.toLocaleString()} cells${info?.typeName ? ` · ${info.typeName}` : ''}`);
  lines.push('Click to select its cells');
  return lines;
}
