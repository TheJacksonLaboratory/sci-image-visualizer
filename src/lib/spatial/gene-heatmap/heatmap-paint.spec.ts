import { blockRows, lutRgba, paintValues, rangeOf, scaleMeans } from './heatmap-paint';

describe('heatmap paint', () => {
  const grey = lutRgba(Array.from({ length: 256 }, (_, i) => [i, i, i] as [number, number, number]));

  it('colours each value by where it falls in the range, a missing one transparent', () => {
    const px = paintValues(new Float32Array([0, 5, 10, 20, NaN]), 0, 10, grey);
    expect(Array.from(px.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(px[4]).toBe(128);
    expect(Array.from(px.slice(8, 12))).toEqual([255, 255, 255, 255]);
    // Clamped above the range.
    expect(px[12]).toBe(255);
    expect(px[19]).toBe(0);
  });

  it('expands a shorter table to 256 entries', () => {
    const two = lutRgba([
      [0, 0, 0],
      [255, 0, 0],
    ]);
    expect(two[0]).toBe(0);
    expect(two[255 * 4]).toBe(255);
  });

  it('scales the means per gene: as they are, over the gene max, or z-scored', () => {
    // 2 genes x 3 groups.
    const means = new Float32Array([1, 2, 3, 0, 0, 0]);
    expect(scaleMeans(means, 2, 3, 'expression')).toBe(means);
    expect(Array.from(scaleMeans(means, 2, 3, 'gene'))).toEqual([1 / 3, 2 / 3, 1, 0, 0, 0].map(Math.fround));
    const z = scaleMeans(means, 2, 3, 'z');
    const sd = Math.sqrt(2 / 3);
    expect(z[0]).toBeCloseTo(-1 / sd);
    expect(z[1]).toBeCloseTo(0);
    expect(z[2]).toBeCloseTo(1 / sd);
    // No spread: 0, not NaN.
    expect(Array.from(z.slice(3))).toEqual([0, 0, 0]);
  });

  it('draws z-scores symmetric about 0, and the others from 0', () => {
    const v = new Float32Array([-0.5, 2, NaN]);
    expect(rangeOf(v, 'z')).toEqual([-2, 2]);
    expect(rangeOf(v, 'expression')).toEqual([0, 2]);
    expect(rangeOf(v, 'gene')).toEqual([0, 1]);
    expect(rangeOf(v, 'cells-expression', 6.6)).toEqual([0, 6.6]);
    expect(rangeOf(new Float32Array([0]), 'expression')).toEqual([0, 1]);
  });

  it('averages rows into blocks of 2^level, the last one short', () => {
    // 5 rows x 2 columns: row r is [r, 10r].
    const values = new Float32Array([0, 0, 1, 10, 2, 20, 3, 30, 4, 40]);
    const all = blockRows(values, 5, 2, 1, 0, 5);
    expect(all.firstRow).toBe(0);
    expect(all.blocks).toBe(3);
    expect(Array.from(all.values)).toEqual([0.5, 5, 2.5, 25, 4, 40]);
    // A window starting mid-block starts at its block.
    const part = blockRows(values, 5, 2, 1, 3, 4);
    expect(part.firstRow).toBe(2);
    expect(part.blocks).toBe(1);
    expect(Array.from(part.values)).toEqual([2.5, 25]);
    const one = blockRows(values, 5, 2, 0, 1, 3);
    expect(Array.from(one.values)).toEqual([1, 10, 2, 20]);
  });
});
