import { HEATMAP_CLUSTER_MAX, clusterOrder, orderHeatmap } from './heatmap-order';
import type { HeatmapMatrix } from './spatial-heatmap';

/** A matrix from rows of values (row-major), with a cell count per column. */
function matrix(rows: string[], cols: string[], values: number[][], counts?: number[]): HeatmapMatrix {
  return {
    rows,
    cols,
    hiddenCols: 0,
    values: Float32Array.from(values.flat()),
    counts: Uint32Array.from(counts ?? cols.map(() => 10)),
    range: [-1, 1],
  };
}

/** The matrix's values as rows, for readable expectations. */
const grid = (m: HeatmapMatrix) =>
  m.rows.map((_, r) => Array.from(m.values.subarray(r * m.cols.length, (r + 1) * m.cols.length)));

describe('orderHeatmap', () => {
  // Three groups; each gene peaks in one of them.
  const m = matrix(
    ['Snap25', 'Gfap', 'Mbp', 'Ttr'],
    ['Astro', 'Neuron', 'Oligo'],
    [
      [-1, 2, -1], // Snap25: Neuron
      [2, -1, -1], // Gfap: Astro
      [-1, -1, 2], // Mbp: Oligo
      [0, 1, 0.5], // Ttr: Neuron, weaker than Snap25
    ],
    [30, 50, 20],
  );

  it('leaves the matrix alone as picked, in dataset order', () => {
    expect(orderHeatmap(m, { genes: 'picked', groups: 'dataset' }).matrix).toBe(m);
  });

  it('sorts genes A–Z, ignoring case and reading numbers as numbers', () => {
    const named = matrix(['gene10', 'Gene2', 'actb'], ['A'], [[1], [2], [3]]);
    const out = orderHeatmap(named, { genes: 'name', groups: 'dataset' }).matrix;
    expect(out.rows).toEqual(['actb', 'Gene2', 'gene10']);
    expect(grid(out)).toEqual([[3], [2], [1]]);
  });

  it('orders genes by the group they peak in, strongest first: the marker diagonal', () => {
    const out = orderHeatmap(m, { genes: 'peak', groups: 'dataset' }).matrix;
    expect(out.rows).toEqual(['Gfap', 'Snap25', 'Ttr', 'Mbp']);
    expect(out.cols).toEqual(['Astro', 'Neuron', 'Oligo']);
  });

  it('puts the biggest groups first, moving their values and counts with them', () => {
    const out = orderHeatmap(m, { genes: 'picked', groups: 'cells' }).matrix;
    expect(out.cols).toEqual(['Neuron', 'Astro', 'Oligo']);
    expect(Array.from(out.counts)).toEqual([50, 30, 20]);
    expect(grid(out)[0]).toEqual([2, -1, -1]); // Snap25, now Neuron first
  });

  it('follows the groups’ order for the diagonal', () => {
    const out = orderHeatmap(m, { genes: 'peak', groups: 'cells' }).matrix;
    expect(out.cols).toEqual(['Neuron', 'Astro', 'Oligo']);
    expect(out.rows).toEqual(['Snap25', 'Ttr', 'Gfap', 'Mbp']);
  });

  it('puts a gene with nothing measured last in the diagonal', () => {
    const gaps = matrix(['Empty', 'Mbp'], ['A', 'B'], [
      [NaN, NaN],
      [0, 1],
    ]);
    expect(orderHeatmap(gaps, { genes: 'peak', groups: 'dataset' }).matrix.rows).toEqual(['Mbp', 'Empty']);
  });

  it('clusters genes with similar profiles next to each other', () => {
    const profiles = matrix(
      ['a1', 'b1', 'a2', 'b2'],
      ['X', 'Y', 'Z'],
      [
        [2, 0, 0],
        [0, 0, 2],
        [1.9, 0.1, 0],
        [0, 0.1, 1.8],
      ],
    );
    const rows = orderHeatmap(profiles, { genes: 'clustered', groups: 'dataset' }).matrix.rows;
    const pos = (g: string) => rows.indexOf(g);
    expect(Math.abs(pos('a1') - pos('a2'))).toBe(1);
    expect(Math.abs(pos('b1') - pos('b2'))).toBe(1);
  });

  it('clusters groups by their profiles over the genes', () => {
    const out = orderHeatmap(
      matrix(['g1', 'g2'], ['P', 'Q', 'R', 'S'], [
        [1, 0, 1, 0],
        [0, 1, 0, 1],
      ]),
      { genes: 'picked', groups: 'clustered' },
    ).matrix;
    const pos = (c: string) => out.cols.indexOf(c);
    expect(Math.abs(pos('P') - pos('R'))).toBe(1);
    expect(Math.abs(pos('Q') - pos('S'))).toBe(1);
  });

  it('keeps the order, and says so, past the clustering limit', () => {
    const n = HEATMAP_CLUSTER_MAX + 1;
    const wide = matrix(
      Array.from({ length: n }, (_, i) => `G${i}`),
      ['A'],
      Array.from({ length: n }, (_, i) => [n - i]),
    );
    const out = orderHeatmap(wide, { genes: 'clustered', groups: 'dataset' });
    expect(out.clusterSkipped).toEqual({ genes: true, groups: false });
    expect(out.matrix).toBe(wide);
  });
});

describe('clusterOrder', () => {
  const vectors = (rows: number[][]) => (i: number, k: number) => rows[i][k];

  it('returns every index once', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [Math.sin(i), Math.cos(i * 3), i % 5]);
    expect(clusterOrder(40, 3, vectors(rows)).slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
  });

  it('keeps the input order for identical vectors', () => {
    expect(clusterOrder(4, 2, vectors([[1, 1], [1, 1], [1, 1], [1, 1]]))).toEqual([0, 1, 2, 3]);
  });

  it('compares vectors only where both are measured', () => {
    // 0 and 2 agree wherever both have a value; 1 differs from both.
    const order = clusterOrder(3, 3, vectors([[1, NaN, 1], [5, 5, 5], [1, 1, NaN]]));
    expect(Math.abs(order.indexOf(0) - order.indexOf(2))).toBe(1);
  });

  it('copes with vectors that share no measurement', () => {
    const order = clusterOrder(3, 2, vectors([[1, NaN], [NaN, 1], [1, NaN]]));
    expect(order.slice().sort()).toEqual([0, 1, 2]);
    expect(Math.abs(order.indexOf(0) - order.indexOf(2))).toBe(1);
  });
});
