import {
  HEATMAP_MIN_CELLS, HeatmapGroups, cellsAsGroups, heatmapMatrix,
} from './spatial-heatmap';
import { NO_CATEGORY } from '../contracts/spatial-dataset.contract';

/**
 * The mean-expression matrix. What matters is that it averages only the cells
 * that were ASSAYED, that one loud gene cannot flatten the panel, and that a
 * group with nothing measured reads as a gap rather than as a zero.
 */
describe('heatmapMatrix', () => {
  const gene = (name: string, values: number[]) => ({ name, values: Float32Array.from(values) });
  /** Six cells: three in group A, three in group B. */
  const groups: HeatmapGroups = {
    codes: Uint16Array.from([0, 0, 0, 1, 1, 1]),
    categories: ['A', 'B'],
  };
  const at = (m: { values: Float32Array; cols: string[] }, r: number, c: number) =>
    m.values[r * m.cols.length + c];

  it('averages each gene within each group', () => {
    const m = heatmapMatrix(
      [gene('g1', [1, 2, 3, 10, 20, 30])],
      groups,
      { zScore: false },
    )!;
    expect(m.rows).toEqual(['g1']);
    expect(m.cols).toEqual(['A', 'B']);
    expect(at(m, 0, 0)).toBeCloseTo(2, 5); // (1+2+3)/3
    expect(at(m, 0, 1)).toBeCloseTo(20, 5); // (10+20+30)/3
    expect(Array.from(m.counts)).toEqual([3, 3]);
  });

  it('skips a cell with no measurement rather than reading it as zero', () => {
    // Counting the NaN as 0 would give A a mean of 1, implying the gene is
    // nearly absent there for a reason that is not about the biology.
    const m = heatmapMatrix(
      [gene('g1', [3, NaN, 3, 5, 5, 5])],
      groups,
      { zScore: false },
    )!;
    expect(at(m, 0, 0)).toBeCloseTo(3, 5);
    // The COLUMN count still reports the cells in the group, not the measured
    // ones — the group really does hold three cells.
    expect(Array.from(m.counts)).toEqual([3, 3]);
  });

  it('leaves a group with nothing measured as a gap, not a zero', () => {
    const m = heatmapMatrix(
      [gene('g1', [1, 2, 3, NaN, NaN, NaN])],
      groups,
      { zScore: false },
    )!;
    expect(at(m, 0, 0)).toBeCloseTo(2, 5);
    expect(Number.isNaN(at(m, 0, 1))).toBe(true);
  });

  it('z-scores per GENE, so one loud gene cannot flatten the panel', () => {
    // Raw, g2 spans 1000s and g1 spans single digits; on one colour scale g1
    // would read as uniformly blank.
    const m = heatmapMatrix(
      [gene('quiet', [1, 1, 1, 3, 3, 3]), gene('loud', [1000, 1000, 1000, 3000, 3000, 3000])],
      groups,
    )!;
    // Both rows now say the same thing: higher in B than in A, equally so.
    expect(at(m, 0, 0)).toBeCloseTo(-1, 5);
    expect(at(m, 0, 1)).toBeCloseTo(1, 5);
    expect(at(m, 1, 0)).toBeCloseTo(-1, 5);
    expect(at(m, 1, 1)).toBeCloseTo(1, 5);
  });

  it('reads a gene with no spread as distinguishing nothing, not as NaN', () => {
    // Dividing by a zero SD would blank the row; zero is the honest answer.
    const m = heatmapMatrix([gene('flat', [5, 5, 5, 5, 5, 5])], groups)!;
    expect(at(m, 0, 0)).toBe(0);
    expect(at(m, 0, 1)).toBe(0);
  });

  it('ignores cells with no category', () => {
    const withUnassigned: HeatmapGroups = {
      codes: Uint16Array.from([0, 0, 0, 1, 1, NO_CATEGORY]),
      categories: ['A', 'B'],
    };
    const m = heatmapMatrix(
      [gene('g1', [1, 1, 1, 4, 4, 999])],
      withUnassigned,
      { zScore: false, minCells: 2 },
    )!;
    expect(at(m, 0, 1)).toBeCloseTo(4, 5); // the 999 is not in any group
    expect(Array.from(m.counts)).toEqual([3, 2]);
  });

  it('restricts to the given indices — an ROI selection', () => {
    const m = heatmapMatrix(
      [gene('g1', [1, 2, 3, 10, 20, 30])],
      groups,
      { zScore: false, minCells: 1, indices: Uint32Array.from([0, 3]) },
    )!;
    expect(at(m, 0, 0)).toBeCloseTo(1, 5);
    expect(at(m, 0, 1)).toBeCloseTo(10, 5);
    expect(Array.from(m.counts)).toEqual([1, 1]);
  });

  it('drops groups too small for their mean to mean anything', () => {
    const lopsided: HeatmapGroups = {
      codes: Uint16Array.from([0, 0, 0, 0, 0, 1]),
      categories: ['big', 'tiny'],
    };
    const m = heatmapMatrix([gene('g1', [1, 1, 1, 1, 1, 99])], lopsided, { zScore: false })!;
    // 'tiny' holds one cell, under the default floor of 3.
    expect(m.cols).toEqual(['big']);
    expect(HEATMAP_MIN_CELLS).toBe(3);
    // …and a caller who wants them can lower the floor.
    const all = heatmapMatrix([gene('g1', [1, 1, 1, 1, 1, 99])], lopsided, {
      zScore: false, minCells: 1,
    })!;
    expect(all.cols).toEqual(['big', 'tiny']);
  });

  it('reports the value range over the finite entries', () => {
    const m = heatmapMatrix([gene('g1', [1, 2, 3, 10, 20, 30])], groups, { zScore: false })!;
    expect(m.range).toEqual([2, 20]);
  });

  it('returns null when there is nothing to draw', () => {
    expect(heatmapMatrix([], groups)).toBeNull();
    expect(heatmapMatrix([gene('g1', [1])], { codes: new Uint16Array(1), categories: [] }))
      .toBeNull();
    // Every group under the floor.
    expect(heatmapMatrix([gene('g1', [1, 2])], {
      codes: Uint16Array.from([0, 1]), categories: ['A', 'B'],
    })).toBeNull();
    // Nothing measured anywhere.
    expect(heatmapMatrix([gene('g1', [NaN, NaN, NaN, NaN, NaN, NaN])], groups, { zScore: false }))
      .toBeNull();
  });
});

describe('cellsAsGroups', () => {
  it('gives every selected cell its own column, in selection order', () => {
    const { groups, indices } = cellsAsGroups(Uint32Array.from([2, 5, 9]), 10);
    expect(Array.from(indices)).toEqual([2, 5, 9]);
    expect(groups.categories).toEqual(['#2', '#5', '#9']);
    expect(groups.codes[2]).toBe(0);
    expect(groups.codes[5]).toBe(1);
    expect(groups.codes[9]).toBe(2);
    // Everything unselected is outside every column.
    expect(groups.codes[0]).toBe(NO_CATEGORY);
  });

  it('thins evenly past the cap, so the whole selection is still represented', () => {
    const many = Uint32Array.from({ length: 1000 }, (_, i) => i);
    const { groups, indices } = cellsAsGroups(many, 1000, 10);
    expect(indices).toHaveLength(10);
    expect(groups.categories).toHaveLength(10);
    // Spread across the range rather than the first ten.
    expect(Array.from(indices)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it('needs minCells: 1, since every column holds exactly one cell', () => {
    // The documented trap: at the default floor of 3 the whole view vanishes.
    const cells = cellsAsGroups(Uint32Array.from([0, 1, 2]), 3);
    const genes = [{ name: 'g1', values: Float32Array.from([1, 5, 9]) }];
    expect(heatmapMatrix(genes, cells.groups, { indices: cells.indices })).toBeNull();
    const m = heatmapMatrix(genes, cells.groups, {
      indices: cells.indices, minCells: 1, zScore: false,
    })!;
    expect(m.cols).toEqual(['#0', '#1', '#2']);
    expect(Array.from(m.values)).toEqual([1, 5, 9]);
  });
});
