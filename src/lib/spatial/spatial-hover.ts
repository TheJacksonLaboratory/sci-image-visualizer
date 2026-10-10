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
export function nearestObservation(screen: Float32Array, x: number, y: number, maxDist: number): number {
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

/**
 * A uniform grid over static 2-D positions, for picking without a linear scan.
 *
 * The 2D map's world positions do not move between pointer events, so the grid is built
 * once per dataset or section and each pick then visits only the cells within reach —
 * instead of every one of up to 3.7M observations, which cost ~12 ms per pointermove.
 *
 * Same input and answer as {@link nearestObservation}: `positions` is `[x0, y0, …]` by
 * observation with NaN for anything not drawn, and ties go to the later observation.
 * Cells hold their observations in ascending order (a counting sort keeps it), which is
 * what lets the tie rule survive the bucketing.
 */
export class PointGridIndex {
  private constructor(
    private readonly positions: Float32Array,
    private readonly minX: number,
    private readonly minY: number,
    private readonly cell: number,
    private readonly cols: number,
    private readonly rows: number,
    /** CSR: the observations of cell `c` are `order[start[c] .. start[c + 1])`. */
    private readonly start: Uint32Array,
    private readonly order: Uint32Array,
  ) {}

  /**
   * Index `positions`, aiming for about `perCell` observations per occupied cell. Null
   * when nothing is drawn.
   */
  static build(positions: Float32Array, perCell = 4): PointGridIndex | null {
    const n = positions.length >> 1;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      drawn++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (drawn === 0) return null;
    const w = Math.max(maxX - minX, 1e-9);
    const h = Math.max(maxY - minY, 1e-9);
    // Square cells sized so the grid has about drawn/perCell of them.
    const cells = Math.max(1, Math.ceil(drawn / perCell));
    const cell = Math.sqrt((w * h) / cells) || Math.max(w, h);
    const cols = Math.max(1, Math.min(4096, Math.ceil(w / cell)));
    const rows = Math.max(1, Math.min(4096, Math.ceil(h / cell)));
    const size = Math.max(w / cols, h / rows);

    const cellOf = new Int32Array(n).fill(-1);
    const start = new Uint32Array(cols * rows + 1);
    for (let i = 0; i < n; i++) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const cx = Math.min(cols - 1, Math.floor((x - minX) / size));
      const cy = Math.min(rows - 1, Math.floor((y - minY) / size));
      const c = cy * cols + cx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
    const fill = start.slice(0, cols * rows);
    const order = new Uint32Array(drawn);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (c >= 0) order[fill[c]++] = i;
    }
    return new PointGridIndex(positions, minX, minY, size, cols, rows, start, order);
  }

  /** {@link nearestObservation} over the indexed positions. */
  nearest(x: number, y: number, maxDist: number): number {
    if (!(maxDist >= 0) || !Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const { positions, cell, cols, rows, start, order } = this;
    const cx0 = Math.max(0, Math.floor((x - maxDist - this.minX) / cell));
    const cx1 = Math.min(cols - 1, Math.floor((x + maxDist - this.minX) / cell));
    const cy0 = Math.max(0, Math.floor((y - maxDist - this.minY) / cell));
    const cy1 = Math.min(rows - 1, Math.floor((y + maxDist - this.minY) / cell));
    const limit = maxDist * maxDist;
    let best = -1;
    let bestDist = Infinity;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * cols + cx;
        for (let k = start[c]; k < start[c + 1]; k++) {
          const i = order[k];
          const dx = positions[i * 2] - x;
          const dy = positions[i * 2 + 1] - y;
          const d = dx * dx + dy * dy;
          // The later observation wins a tie, as in the linear scan: it is drawn on top.
          if (d <= limit && (d < bestDist || (d === bestDist && i > best))) {
            bestDist = d;
            best = i;
          }
        }
      }
    }
    return best;
  }
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
