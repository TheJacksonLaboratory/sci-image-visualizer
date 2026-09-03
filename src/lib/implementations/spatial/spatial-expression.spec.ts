import { colorExpressionField, expressionField } from './spatial-expression';
import { SpatialObservations } from '../../contracts/spatial-dataset.contract';

/**
 * The gene-map estimator. What matters is that it reports a MEAN per cell (so a
 * dense region does not glow for being dense) and that it can say "nothing was
 * measured here" — the two ways a heat layer misleads.
 */
describe('expressionField', () => {
  const obs = (pts: [number, number][]): SpatialObservations =>
    ({
      count: pts.length,
      x: Float32Array.from(pts, (p) => p[0]),
      y: Float32Array.from(pts, (p) => p[1]),
    }) as SpatialObservations;

  const grid = { width: 8, height: 8, step: 1, sigma: 0.01 };
  const at = (f: Float32Array, x: number, y: number, w = 8) => f[y * w + x];

  it('reports the mean per cell, so ten quiet cells do not outshine one loud one', () => {
    // Left pixel: ten cells at 1. Right pixel: one cell at 5.
    const pts: [number, number][] = [];
    for (let i = 0; i < 10; i++) pts.push([2, 2]);
    pts.push([5, 2]);
    const values = Float32Array.from(pts, (_p, i) => (i < 10 ? 1 : 5));

    const f = expressionField(obs(pts), { ...grid, values })!;

    expect(at(f.mean, 2, 2)).toBeCloseTo(1, 5);
    expect(at(f.mean, 5, 2)).toBeCloseTo(5, 5);
    // A sum would have made the crowded pixel (10) beat the expressive one (5).
    expect(at(f.mean, 5, 2)).toBeGreaterThan(at(f.mean, 2, 2));
    // …while support still records that one pixel holds ten cells.
    expect(at(f.support, 2, 2)).toBeCloseTo(10, 5);
    expect(at(f.support, 5, 2)).toBeCloseTo(1, 5);
  });

  it('leaves unmeasured pixels with no support, so they can be drawn as nothing', () => {
    const f = expressionField(obs([[2, 2]]), { ...grid, values: new Float32Array([3]) })!;
    expect(at(f.support, 2, 2)).toBeGreaterThan(0);
    expect(at(f.support, 7, 7)).toBe(0);
    expect(at(f.mean, 7, 7)).toBe(0); // and its mean is meaningless, hence the mask
  });

  it('skips a cell with no measurement rather than reading it as zero', () => {
    // NaN is "not measured for this cell"; counting it as 0 would drag the local
    // mean down as if the gene were absent.
    const f = expressionField(obs([[2, 2], [2, 2]]), {
      ...grid,
      values: new Float32Array([4, NaN]),
    })!;
    expect(at(f.mean, 2, 2)).toBeCloseTo(4, 5);
    expect(at(f.support, 2, 2)).toBeCloseTo(1, 5);
  });

  it('spreads expression between cells so a field can be read as a region', () => {
    const f = expressionField(obs([[2, 2]]), {
      ...grid,
      sigma: 1.2,
      values: new Float32Array([6]),
    })!;
    // The neighbour is supported and carries the same mean: smoothing the
    // numerator and denominator together spreads WHERE, not HOW MUCH.
    expect(at(f.support, 3, 2)).toBeGreaterThan(0);
    expect(at(f.mean, 3, 2)).toBeCloseTo(6, 3);
  });

  it('applies the image affine, so the field lands where the cells are drawn', () => {
    // Coordinates in microns, 2 µm per image pixel, 1 image pixel per field pixel.
    const f = expressionField(obs([[8, 4]]), {
      ...grid,
      ref: { scale: [0.5, 0.5] },
      values: new Float32Array([1]),
    })!;
    expect(at(f.support, 4, 2)).toBeGreaterThan(0);
  });

  it('coarsens by `step`, mapping several image pixels into one field pixel', () => {
    const f = expressionField(obs([[6, 6]]), { ...grid, step: 2, values: new Float32Array([1]) })!;
    expect(at(f.support, 3, 3)).toBeGreaterThan(0);
  });

  it('restricts to the given indices — a plane, or a selection', () => {
    const f = expressionField(obs([[1, 1], [6, 6]]), {
      ...grid,
      values: new Float32Array([9, 9]),
      indices: new Uint32Array([1]),
    })!;
    expect(at(f.support, 1, 1)).toBe(0);
    expect(at(f.support, 6, 6)).toBeGreaterThan(0);
  });

  it('reports the value range over supported pixels, widening a flat one', () => {
    const flat = expressionField(obs([[2, 2]]), { ...grid, values: new Float32Array([7]) })!;
    expect(flat.range).toEqual([7, 8]);
  });

  it('returns null when nothing lands on the raster', () => {
    expect(
      expressionField(obs([[500, 500]]), { ...grid, values: new Float32Array([1]) }),
    ).toBeNull();
    expect(expressionField(obs([]), { ...grid, values: new Float32Array(0) })).toBeNull();
  });
});

describe('colorExpressionField', () => {
  const LUT: [number, number, number][] = [
    [0, 0, 0],
    [255, 255, 255],
  ];
  const obs = (pts: [number, number][]): SpatialObservations =>
    ({
      count: pts.length,
      x: Float32Array.from(pts, (p) => p[0]),
      y: Float32Array.from(pts, (p) => p[1]),
    }) as SpatialObservations;

  it('makes unmeasured pixels fully transparent', () => {
    const f = expressionField(obs([[2, 2]]), {
      width: 8,
      height: 8,
      step: 1,
      sigma: 0.01,
      values: new Float32Array([5]),
    })!;
    const rgba = colorExpressionField(f, LUT, [0, 10]);
    const alphaAt = (x: number, y: number) => rgba[(y * 8 + x) * 4 + 3];

    expect(alphaAt(2, 2)).toBeGreaterThan(0);
    // Nothing was measured out here, so the map must assert nothing.
    expect(alphaAt(7, 7)).toBe(0);
  });

  it('ramps alpha with support, so a thinly sampled pixel reads as tentative', () => {
    // Two pixels: one with four cells, one with a single cell.
    const pts: [number, number][] = [[2, 2], [2, 2], [2, 2], [2, 2], [6, 6]];
    const f = expressionField(obs(pts), {
      width: 8,
      height: 8,
      step: 1,
      sigma: 0.01,
      values: new Float32Array([5, 5, 5, 5, 5]),
    })!;
    const rgba = colorExpressionField(f, LUT, [0, 10]);
    const alphaAt = (x: number, y: number) => rgba[(y * 8 + x) * 4 + 3];

    expect(alphaAt(2, 2)).toBeGreaterThan(alphaAt(6, 6));
  });

  it('windows the value and honours the log scale', () => {
    const f = expressionField(obs([[2, 2]]), {
      width: 4,
      height: 4,
      step: 1,
      sigma: 0.01,
      values: new Float32Array([10]),
    })!;
    const px = (rgba: Uint8Array) => rgba[(2 * 4 + 2) * 4];

    // Value at the window's top → the LUT's last entry (white).
    expect(px(colorExpressionField(f, LUT, [0, 10]))).toBeGreaterThan(200);
    // Same value with the window opened up → nearer the bottom (black).
    expect(px(colorExpressionField(f, LUT, [0, 1000]))).toBeLessThan(60);
    // log1p(10) against a log-scaled window lands mid-ramp, not saturated.
    const logged = px(colorExpressionField(f, LUT, [0, 10], { log: true }));
    expect(logged).toBeGreaterThan(200);
  });

  it('scales the whole layer by opacity', () => {
    const f = expressionField(obs([[1, 1]]), {
      width: 4,
      height: 4,
      step: 1,
      sigma: 0.01,
      values: new Float32Array([5]),
    })!;
    const alpha = (o?: number) =>
      colorExpressionField(f, LUT, [0, 10], { opacity: o })[(1 * 4 + 1) * 4 + 3];
    expect(alpha(0.5)).toBeLessThan(alpha(1));
  });
});
