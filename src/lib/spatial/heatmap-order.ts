/**
 * Sort orders for the gene × group heatmap: which gene is which row, which group which column.
 *
 * The orders a mean-expression heatmap (scanpy's `matrixplot`) is usually read in:
 *
 *  - genes AS PICKED, or A–Z;
 *  - genes by the group where they PEAK, in column order, so each group's markers sit
 *    together and the strongest values run down a diagonal — the usual layout of a marker
 *    panel, and the readable one once many genes are picked;
 *  - genes or groups CLUSTERED: similar profiles next to each other, the order of an
 *    average-linkage dendrogram's leaves (scanpy's `dendrogram=True`);
 *  - groups in the dataset's order, or by size, most cells first.
 *
 * Pure — no Angular, no Plotly — like `spatial-heatmap.ts`, and tested the same way.
 */
import type { HeatmapMatrix } from './spatial-heatmap';

export type HeatmapGeneOrder = 'picked' | 'peak' | 'clustered' | 'name';
export type HeatmapGroupOrder = 'dataset' | 'clustered' | 'cells';

export interface HeatmapOrder {
  genes: HeatmapGeneOrder;
  groups: HeatmapGroupOrder;
}

export const DEFAULT_HEATMAP_ORDER: HeatmapOrder = { genes: 'picked', groups: 'dataset' };

/**
 * Most genes (or groups) clustered. Clustering keeps an n × n distance matrix and takes
 * O(n²·d) to fill it. Measured in Node on an M-series Mac, 338 groups: 500 genes 70 ms,
 * 1,000 genes 230 ms, 1,500 genes 540 ms. A quarter second is about as much as the main
 * thread should take on one click; past it the axis keeps its order and the note says so.
 */
export const HEATMAP_CLUSTER_MAX = 1000;

/** The matrix reordered, and whether an axis asked to be clustered had too many to cluster. */
export interface OrderedHeatmap {
  matrix: HeatmapMatrix;
  /** Set when the genes (or groups) were too many to cluster and kept their order. */
  clusterSkipped: { genes: boolean; groups: boolean };
}

/**
 * `matrix` with its rows and columns in `order`.
 *
 * The groups are ordered first, because "by peak group" orders the genes by the COLUMN
 * each peaks in: the diagonal follows whatever order the columns are drawn in.
 */
export function orderHeatmap(matrix: HeatmapMatrix, order: HeatmapOrder): OrderedHeatmap {
  const nRows = matrix.rows.length;
  const nCols = matrix.cols.length;
  const at = (r: number, c: number) => matrix.values[r * nCols + c];
  const skipped = { genes: false, groups: false };

  let colOrder = identity(nCols);
  if (order.groups === 'cells') {
    colOrder.sort((a, b) => matrix.counts[b] - matrix.counts[a] || a - b);
  } else if (order.groups === 'clustered') {
    if (nCols > HEATMAP_CLUSTER_MAX) skipped.groups = true;
    else colOrder = clusterOrder(nCols, nRows, (c, r) => at(r, c));
  }

  let rowOrder = identity(nRows);
  if (order.genes === 'name') {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    rowOrder.sort((a, b) => collator.compare(matrix.rows[a], matrix.rows[b]) || a - b);
  } else if (order.genes === 'peak') {
    rowOrder = peakOrder(nRows, colOrder, at);
  } else if (order.genes === 'clustered') {
    if (nRows > HEATMAP_CLUSTER_MAX) skipped.genes = true;
    else rowOrder = clusterOrder(nRows, nCols, (r, c) => at(r, c));
  }

  if (isIdentity(rowOrder) && isIdentity(colOrder)) return { matrix, clusterSkipped: skipped };
  const values = new Float32Array(nRows * nCols);
  for (let r = 0; r < nRows; r++) {
    const src = rowOrder[r] * nCols;
    for (let c = 0; c < nCols; c++) values[r * nCols + c] = matrix.values[src + colOrder[c]];
  }
  return {
    matrix: {
      ...matrix,
      rows: rowOrder.map((r) => matrix.rows[r]),
      cols: colOrder.map((c) => matrix.cols[c]),
      counts: Uint32Array.from(colOrder, (c) => matrix.counts[c]),
      values,
    },
    clusterSkipped: skipped,
  };
}

/**
 * Genes by the column where they peak, in `colOrder`, strongest first within a column.
 * A gene with nothing measured anywhere goes last.
 */
function peakOrder(nRows: number, colOrder: number[], at: (r: number, c: number) => number): number[] {
  const peak = Array.from({ length: nRows }, (_, r) => {
    let pos = Infinity;
    let value = -Infinity;
    for (let k = 0; k < colOrder.length; k++) {
      const v = at(r, colOrder[k]);
      if (Number.isFinite(v) && v > value) {
        value = v;
        pos = k;
      }
    }
    return { r, pos, value };
  });
  peak.sort((a, b) => a.pos - b.pos || b.value - a.value || a.r - b.r);
  return peak.map((p) => p.r);
}

/**
 * The leaf order of an average-linkage (UPGMA) clustering of `n` vectors of length `dim`.
 *
 * Distance is Euclidean over the entries both vectors have (a group with nothing measured
 * for a gene is a gap, not a zero), scaled up to the full length so a pair sharing few
 * entries is not read as close. Pairs sharing none are as far apart as anything gets.
 *
 * Nearest-neighbour chain: O(n²) after the distances, and exact for average linkage. Each
 * merge puts the first cluster's leaves before the second's; ties keep the input order, so
 * the result is stable.
 */
export function clusterOrder(n: number, dim: number, get: (i: number, k: number) => number): number[] {
  if (n <= 2) return identity(n);
  return averageLinkageLeaves(n, distances(n, dim, get));
}

/**
 * The n × n distances between `n` vectors, as {@link clusterOrder} defines them.
 *
 * The vectors are copied once into a dense array: the loop reads each value n times.
 */
function distances(n: number, dim: number, get: (i: number, k: number) => number): Float32Array {
  const data = new Float64Array(n * dim);
  let gaps = false;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < dim; k++) {
      const v = get(i, k);
      data[i * dim + k] = v;
      if (v !== v) gaps = true; // NaN
    }
  }
  const d = new Float32Array(n * n);
  let far = 0;
  const disjoint: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = gaps ? gappedDistance(data, i * dim, j * dim, dim) : fullDistance(data, i * dim, j * dim, dim);
      if (Number.isNaN(dist)) {
        disjoint.push(i * n + j);
        continue;
      }
      d[i * n + j] = d[j * n + i] = dist;
      if (dist > far) far = dist;
    }
  }
  for (const ij of disjoint) {
    const i = Math.floor(ij / n);
    const j = ij % n;
    d[i * n + j] = d[j * n + i] = far * 2 + 1;
  }
  return d;
}

/** Euclidean distance between the vectors at `bi` and `bj`, all entries measured. */
function fullDistance(data: Float64Array, bi: number, bj: number, dim: number): number {
  let sum = 0;
  for (let k = 0; k < dim; k++) {
    const diff = data[bi + k] - data[bj + k];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Euclidean distance over the entries both vectors have, scaled up to the full length;
 * NaN when they share none.
 */
function gappedDistance(data: Float64Array, bi: number, bj: number, dim: number): number {
  let sum = 0;
  let shared = 0;
  for (let k = 0; k < dim; k++) {
    const diff = data[bi + k] - data[bj + k];
    // NaN on either side: not compared.
    if (diff === diff) {
      sum += diff * diff;
      shared++;
    }
  }
  return shared ? Math.sqrt((sum * dim) / shared) : NaN;
}

/**
 * The leaf order of the average-linkage clustering of `n` items with distances `d`
 * (n × n, updated in place), by nearest-neighbour chain.
 */
function averageLinkageLeaves(n: number, d: Float32Array): number[] {
  const size = new Uint32Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const leaves: number[][] = Array.from({ length: n }, (_, i) => [i]);
  let remaining = n;
  const chain: number[] = [];

  while (remaining > 1) {
    if (chain.length === 0) chain.push(active.indexOf(1));
    const a = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    // Start from the previous link, so a tie closes the chain rather than looping.
    let best = prev;
    let bestD = prev >= 0 ? d[a * n + prev] : Infinity;
    for (let k = 0; k < n; k++) {
      if (k === a || !active[k]) continue;
      const dk = d[a * n + k];
      if (dk < bestD) {
        bestD = dk;
        best = k;
      }
    }
    if (best !== prev) {
      chain.push(best);
      continue;
    }
    // a and prev are each other's nearest: merge them, into the lower index.
    chain.length -= 2;
    const [keep, gone] = a < prev ? [a, prev] : [prev, a];
    const sk = size[keep];
    const sg = size[gone];
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === keep || k === gone) continue;
      const v = (sk * d[keep * n + k] + sg * d[gone * n + k]) / (sk + sg);
      d[keep * n + k] = d[k * n + keep] = v;
    }
    size[keep] = sk + sg;
    active[gone] = 0;
    leaves[keep] = leaves[keep].concat(leaves[gone]);
    leaves[gone] = [];
    remaining--;
  }
  return leaves[active.indexOf(1)];
}

function identity(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function isIdentity(order: number[]): boolean {
  return order.every((v, i) => v === i);
}
