import {
  colorExpressionField, encodeExpressionVolume, expressionField,
  expressionVolume,
} from './spatial-expression';
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

/**
 * The 3D estimator. The load-bearing distinction is between the two modes: sheets
 * are the sections that were imaged, and the volume is an estimate BETWEEN them —
 * so the sheets must leave the gaps empty, and the volume must not reach past the
 * outermost section.
 */
describe('expressionVolume', () => {
  // 4x4x5, one unit per voxel, so voxel indices are the coordinates.
  const grid = { width: 4, height: 4, depth: 5, voxelSize: [1, 1, 1] as [number, number, number] };
  const obs = (pts: [number, number, number][]): SpatialObservations =>
    ({
      count: pts.length,
      x: Float32Array.from(pts, (p) => p[0]),
      y: Float32Array.from(pts, (p) => p[1]),
      z: Float32Array.from(pts, (p) => p[2]),
    }) as SpatialObservations;
  const at = (f: Float32Array, x: number, y: number, z: number) => f[(z * 4 + y) * 4 + x];
  const tight: [number, number, number] = [0.01, 0.01, 0.01];

  it('reports the mean per cell, so a crowded voxel does not outshine a loud one', () => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 10; i++) pts.push([1, 1, 1]);
    pts.push([3, 1, 1]);
    const values = Float32Array.from(pts, (_p, i) => (i < 10 ? 1 : 5));

    const f = expressionVolume(obs(pts), grid, { sigma: tight, values })!;
    expect(at(f.mean, 1, 1, 1)).toBeCloseTo(1, 5);
    expect(at(f.mean, 3, 1, 1)).toBeCloseTo(5, 5);
    expect(at(f.support, 1, 1, 1)).toBeCloseTo(10, 5);
  });

  it('leaves the gaps between sections empty in sheets mode', () => {
    // Sections at z = 1 and z = 3; nobody imaged z = 2.
    const f = expressionVolume(obs([[1, 1, 1], [1, 1, 3]]), grid, {
      sigma: tight,
      values: new Float32Array([4, 8]),
    })!;
    expect(at(f.support, 1, 1, 1)).toBeGreaterThan(0);
    expect(at(f.support, 1, 1, 3)).toBeGreaterThan(0);
    // The measured sheets, and nothing between them.
    expect(at(f.support, 1, 1, 2)).toBe(0);
    expect(at(f.mean, 1, 1, 1)).toBeCloseTo(4, 5);
    expect(at(f.mean, 1, 1, 3)).toBeCloseTo(8, 5);
  });

  it('bridges the gap in volume mode, with the neighbours’ mean not their sum', () => {
    const f = expressionVolume(obs([[1, 1, 1], [1, 1, 3]]), grid, {
      sigma: [0.01, 0.01, 1.2],
      values: new Float32Array([4, 8]),
      interpolate: true,
    })!;
    // The unimaged plane now carries an estimate…
    expect(at(f.support, 1, 1, 2)).toBeGreaterThan(0);
    // …and it is BETWEEN its neighbours, not their total (12) thinned out.
    const mid = at(f.mean, 1, 1, 2);
    expect(mid).toBeGreaterThan(4);
    expect(mid).toBeLessThan(8);
    expect(mid).toBeCloseTo(6, 1);
  });

  it('does not reach past the outermost imaged section', () => {
    // Sections at z = 1 and 2 only. A z blur leaves a tail at 0, 3 and 4; keeping
    // it would draw expression where the specimen was never sectioned.
    const f = expressionVolume(obs([[1, 1, 1], [1, 1, 2]]), grid, {
      sigma: [0.01, 0.01, 1.5],
      values: new Float32Array([5, 5]),
      interpolate: true,
    })!;
    expect(at(f.support, 1, 1, 0)).toBe(0);
    expect(at(f.support, 1, 1, 3)).toBe(0);
    expect(at(f.support, 1, 1, 4)).toBe(0);
    expect(at(f.support, 1, 1, 1)).toBeGreaterThan(0);
  });

  it('restricts to the given indices — one section, or a selection', () => {
    const f = expressionVolume(obs([[1, 1, 1], [2, 2, 3]]), grid, {
      sigma: tight,
      values: new Float32Array([9, 9]),
      indices: new Uint32Array([1]),
    })!;
    expect(at(f.support, 1, 1, 1)).toBe(0);
    expect(at(f.support, 2, 2, 3)).toBeGreaterThan(0);
  });

  it('skips a cell with no measurement rather than reading it as zero', () => {
    const f = expressionVolume(obs([[1, 1, 1], [1, 1, 1]]), grid, {
      sigma: tight,
      values: new Float32Array([4, NaN]),
    })!;
    expect(at(f.mean, 1, 1, 1)).toBeCloseTo(4, 5);
    expect(at(f.support, 1, 1, 1)).toBeCloseTo(1, 5);
  });

  it('returns null when nothing lands on the lattice', () => {
    expect(
      expressionVolume(obs([[99, 99, 99]]), grid, { sigma: tight, values: new Float32Array([1]) }),
    ).toBeNull();
    expect(expressionVolume(obs([]), grid, { sigma: tight, values: new Float32Array(0) })).toBeNull();
  });
});

describe('encodeExpressionVolume', () => {
  const grid = { width: 4, height: 4, depth: 5, voxelSize: [1, 1, 1] as [number, number, number] };
  const obs = (pts: [number, number, number][]): SpatialObservations =>
    ({
      count: pts.length,
      x: Float32Array.from(pts, (p) => p[0]),
      y: Float32Array.from(pts, (p) => p[1]),
      z: Float32Array.from(pts, (p) => p[2]),
    }) as SpatialObservations;
  const at = (f: Uint8Array, x: number, y: number, z: number) => f[(z * 4 + y) * 4 + x];
  const field = (values: number[], pts: [number, number, number][]) =>
    expressionVolume(obs(pts), grid, {
      sigma: [0.01, 0.01, 0.01],
      values: Float32Array.from(values),
    })!;

  it('leaves an unmeasured voxel at zero, so the raymarch skips it', () => {
    const f = field([7], [[1, 1, 1]]);
    const data = encodeExpressionVolume(f, [0, 10]);
    expect(at(data, 1, 1, 1)).toBeGreaterThan(0);
    expect(at(data, 3, 3, 4)).toBe(0);
  });

  it('does not floor a measured voxel by default', () => {
    // A floor would compound: a ray crosses tens of measured planes and the DVR
    // composites every one, so a per-plane floor big enough to see becomes an
    // opaque shell over the whole specimen.
    const f = field([0], [[1, 1, 1]]);
    expect(at(encodeExpressionVolume(f, [0, 10]), 1, 1, 1)).toBe(0);
  });

  it('scales the windowed value to full scale', () => {
    const f = field([10], [[1, 1, 1]]);
    expect(at(encodeExpressionVolume(f, [0, 10]), 1, 1, 1)).toBe(255);
    expect(at(encodeExpressionVolume(f, [0, 20]), 1, 1, 1) / 255).toBeCloseTo(0.5, 2);
  });

  it('honours the log scale and a caller-supplied floor', () => {
    const f = field([10], [[1, 1, 1]]);
    expect(at(encodeExpressionVolume(f, [0, 1000]), 1, 1, 1)).toBeLessThan(
      at(encodeExpressionVolume(f, [0, 1000], { log: true }), 1, 1, 1),
    );
    // Opt in and a measured-but-empty voxel becomes faintly visible again.
    const flat = field([0], [[1, 1, 1]]);
    expect(at(encodeExpressionVolume(flat, [0, 10], { floor: 0.2 }), 1, 1, 1)).toBe(51);
  });
});
