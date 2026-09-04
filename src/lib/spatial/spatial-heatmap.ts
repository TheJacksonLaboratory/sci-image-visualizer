import { NO_CATEGORY } from '../contracts/spatial-dataset.contract';

/**
 * Mean expression per group, for the gene × class heatmap.
 *
 * A scatter coloured by one gene answers "where is this gene". It cannot answer
 * "which classes express which genes", which is the question a marker panel is
 * actually read for — and the standard object for that is the mean-expression
 * matrix per cluster (scanpy's `matrixplot`/`dotplot`), genes against classes.
 *
 * Deliberately NOT cells × genes at the full dataset: 374k columns is not a
 * heatmap. Cells become columns only inside a selection, where a few thousand
 * of them render and the question changes to "what is in this region".
 *
 * Two things this has to get right to be readable:
 *
 *  - A cell with no measurement for a gene (`NaN`) is SKIPPED, not counted as
 *    zero. Counting it would drag a group's mean towards absence for a reason
 *    that has nothing to do with the biology.
 *  - Z-scoring is per GENE, across groups. Without it a gene expressed an order
 *    of magnitude above the others saturates the colour scale and the rest of
 *    the panel reads as uniformly blank — the matrix would show which gene is
 *    loudest rather than which class expresses what.
 *
 * Pure — no Angular, no Plotly, no renderer — like `spatial-density.ts`, and
 * tested the same way.
 */

/** One gene's values, with the name to label its row. */
export interface HeatmapGene {
  name: string;
  /** One value per observation; `NaN` where the gene was not measured. */
  values: Float32Array;
}

/** The columns to aggregate into: a categorical column's categories. */
export interface HeatmapGroups {
  /** Per-observation category index, or {@link NO_CATEGORY}. */
  codes: Uint16Array;
  categories: readonly string[];
}

export interface HeatmapMatrixOptions {
  /** Observations to include; every one when absent (an ROI selection). */
  indices?: Uint32Array;
  /**
   * Z-score each gene across the groups, so one loud gene cannot flatten the
   * panel. On by default — the raw means are only readable when every gene is
   * on a comparable scale.
   */
  zScore?: boolean;
  /** Drop groups with fewer than this many measured cells. A mean over one or
   *  two cells is noise presented with the same weight as a real one. */
  minCells?: number;
  /**
   * Keep at most this many columns, chosen by the STRONGEST signal any picked
   * gene shows in them.
   *
   * `subclass` has 338 categories. Drawn in full that is a texture rather than a
   * panel — every column a couple of pixels wide, every label unreadable — and
   * the question being asked ("which groups express my genes") is answered by
   * the handful of groups where a gene actually stands out. Ranking by
   * max |value| across the rows surfaces exactly those; ranking by cell count
   * would instead surface the biggest groups, which is a different question.
   *
   * Unset keeps every column that cleared `minCells`.
   */
  maxCols?: number;
}

export interface HeatmapMatrix {
  /** Gene names, one per row, in the order given. */
  rows: string[];
  /** Columns dropped by `maxCols`, so the caller can say how many are hidden
   *  rather than silently showing a subset as if it were everything. */
  hiddenCols: number;
  /** Group labels, one per column — only the groups that survived `minCells`. */
  cols: string[];
  /**
   * `rows.length × cols.length`, row-major: `values[r * cols.length + c]`.
   * `NaN` where a group had nothing measured for that gene, which the caller
   * draws as a gap rather than as a zero.
   */
  values: Float32Array;
  /** Measured cells behind each column, index-aligned with {@link cols}. */
  counts: Uint32Array;
  /** Finite range of `values`, for a symmetric or absolute colour scale. */
  range: [number, number];
}

/** Default floor for a group to earn a column. */
export const HEATMAP_MIN_CELLS = 3;

/**
 * Mean expression of each gene in each group.
 *
 * Null when nothing survives — no genes, no groups, or every group filtered
 * out — so the caller draws no chart rather than an empty grid.
 */
export function heatmapMatrix(
  genes: readonly HeatmapGene[],
  groups: HeatmapGroups,
  opts: HeatmapMatrixOptions = {},
): HeatmapMatrix | null {
  const nGroups = groups.categories.length;
  if (genes.length === 0 || nGroups === 0) return null;
  const minCells = opts.minCells ?? HEATMAP_MIN_CELLS;
  const indices = opts.indices;
  const n = indices ? indices.length : groups.codes.length;

  // Cells per group, counted once from the codes rather than per gene: the
  // membership does not depend on which gene is being averaged.
  const groupCount = new Uint32Array(nGroups);
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k;
    const code = groups.codes[i];
    if (code === NO_CATEGORY || code >= nGroups) continue;
    groupCount[code]++;
  }
  const keep: number[] = [];
  for (let g = 0; g < nGroups; g++) if (groupCount[g] >= minCells) keep.push(g);
  if (keep.length === 0) return null;

  const rows = genes.map((g) => g.name);
  const cols = keep.map((g) => groups.categories[g]);
  const counts = Uint32Array.from(keep, (g) => groupCount[g]);
  const values = new Float32Array(rows.length * cols.length).fill(NaN);

  for (let r = 0; r < genes.length; r++) {
    const gene = genes[r];
    const sum = new Float64Array(nGroups);
    const measured = new Uint32Array(nGroups);
    for (let k = 0; k < n; k++) {
      const i = indices ? indices[k] : k;
      const code = groups.codes[i];
      if (code === NO_CATEGORY || code >= nGroups) continue;
      const v = gene.values[i];
      // Not measured for this cell — skipping keeps the mean about the cells
      // that were actually assayed.
      if (!Number.isFinite(v)) continue;
      sum[code] += v;
      measured[code]++;
    }
    for (let c = 0; c < keep.length; c++) {
      const g = keep[c];
      if (measured[g] === 0) continue; // stays NaN: a gap, not a zero
      values[r * cols.length + c] = sum[g] / measured[g];
    }
  }

  if (opts.zScore !== false) zScoreRows(values, rows.length, cols.length);

  // Ranked AFTER scaling, so "strongest signal" means strongest relative to each
  // gene's own spread rather than to whichever gene has the largest units.
  let hiddenCols = 0;
  let outCols = cols;
  let outValues = values;
  let outCounts = counts;
  if (opts.maxCols !== undefined && cols.length > opts.maxCols) {
    const strength = cols.map((_, c) => {
      let peak = 0;
      for (let r = 0; r < rows.length; r++) {
        const v = Math.abs(values[r * cols.length + c]);
        if (Number.isFinite(v) && v > peak) peak = v;
      }
      return { c, peak };
    });
    // Strongest first, then original order for ties, so the choice is stable.
    strength.sort((a, b) => (b.peak - a.peak) || (a.c - b.c));
    const picked = strength.slice(0, opts.maxCols).map((s) => s.c).sort((a, b) => a - b);
    hiddenCols = cols.length - picked.length;
    outCols = picked.map((c) => cols[c]);
    outCounts = Uint32Array.from(picked, (c) => counts[c]);
    outValues = new Float32Array(rows.length * picked.length);
    for (let r = 0; r < rows.length; r++) {
      for (let k = 0; k < picked.length; k++) {
        outValues[r * picked.length + k] = values[r * cols.length + picked[k]];
      }
    }
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < outValues.length; i++) {
    const v = outValues[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return null;

  return {
    rows,
    hiddenCols,
    cols: outCols,
    values: outValues,
    counts: outCounts,
    range: hi > lo ? [lo, hi] : [lo, lo + 1],
  };
}

/**
 * Z-score each row in place, over its finite entries only.
 *
 * A row with no spread across groups — a gene expressed evenly everywhere, or
 * measured in only one group — becomes all zeros rather than dividing by zero:
 * "this gene distinguishes nothing here" is the correct reading, and it is the
 * one a NaN row would hide.
 */
function zScoreRows(values: Float32Array, nRows: number, nCols: number): void {
  for (let r = 0; r < nRows; r++) {
    const base = r * nCols;
    let sum = 0;
    let count = 0;
    for (let c = 0; c < nCols; c++) {
      const v = values[base + c];
      if (!Number.isFinite(v)) continue;
      sum += v;
      count++;
    }
    if (count === 0) continue;
    const mean = sum / count;
    let variance = 0;
    for (let c = 0; c < nCols; c++) {
      const v = values[base + c];
      if (!Number.isFinite(v)) continue;
      variance += (v - mean) * (v - mean);
    }
    // Population SD: these are all the groups there are, not a sample of them.
    const sd = Math.sqrt(variance / count);
    for (let c = 0; c < nCols; c++) {
      const v = values[base + c];
      if (!Number.isFinite(v)) continue;
      values[base + c] = sd > 0 ? (v - mean) / sd : 0;
    }
  }
}

/**
 * Groups standing in for individual cells, for the in-selection view.
 *
 * Inside an ROI, "which classes express what" is often the wrong question and
 * "what is in front of me" is the right one — so each cell becomes its own
 * column. Capped: past a few hundred columns a heatmap is a texture, not a
 * readable panel, and the cap is applied by even thinning so the selection is
 * still represented across its whole extent rather than truncated to its first
 * cells.
 *
 * NOTE: every column here holds exactly ONE cell, so the caller must pass
 * `minCells: 1` to {@link heatmapMatrix}. The default floor of
 * {@link HEATMAP_MIN_CELLS} exists to suppress noisy group means and would
 * filter out every column of this view, returning null.
 */
export function cellsAsGroups(
  indices: Uint32Array,
  observationCount: number,
  max = 200,
): { groups: HeatmapGroups; indices: Uint32Array } {
  const step = indices.length > max ? indices.length / max : 1;
  const take = indices.length > max ? max : indices.length;
  const picked = new Uint32Array(take);
  for (let k = 0; k < take; k++) picked[k] = indices[Math.floor(k * step)];

  // One category per picked cell: codes are dense over the picked order, so the
  // matrix columns line up with `picked` without a lookup table.
  const codes = new Uint16Array(observationCount).fill(NO_CATEGORY);
  const categories: string[] = [];
  for (let k = 0; k < take; k++) {
    codes[picked[k]] = k;
    categories.push(`#${picked[k]}`);
  }
  return { groups: { codes, categories }, indices: picked };
}
