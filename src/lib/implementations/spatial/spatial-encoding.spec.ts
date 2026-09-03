import {
  isGrayscaleLut, spatialContinuousLut,
  DEFAULT_CATEGORICAL_PALETTE, DEFAULT_MUTED_OPACITY, MISSING_COLOR, contrastWindow,
  encodeCategorical, encodeContinuous, lutFor, markerDiameters, resolveCategoryColors,
  toRgbaTuples,
} from './spatial-encoding';
import {
  CategoricalColumnMeta, NO_CATEGORY, SpatialObservations,
} from '../../contracts/spatial-dataset.contract';

/** RGBA of point i, as 0–255 ints plus alpha, for readable assertions.
 *  Alpha is rounded because the buffer is `Float32Array`: 0.15 stores as
 *  0.15000000596…, which is correct but not `toBe`-comparable. */
function colorAt(flat: Float32Array, i: number) {
  const o = i * 4;
  return {
    rgb: [
      Math.round(flat[o] * 255), Math.round(flat[o + 1] * 255), Math.round(flat[o + 2] * 255),
    ],
    a: Math.round(flat[o + 3] * 10000) / 10000,
  };
}

const meta = (over: Partial<CategoricalColumnMeta> = {}): CategoricalColumnMeta => ({
  kind: 'categorical', name: 'region', categories: ['Cortex', 'Thalamus'], ...over,
});

describe('spatial-encoding', () => {
  describe('resolveCategoryColors', () => {
    it('prefers the column\'s authored colours so the viewer matches upstream figures', () => {
      const colors = resolveCategoryColors(meta({ colors: ['#ff0000', '#00ff00'] }));
      expect(colors).toEqual(['#ff0000', '#00ff00']);
    });

    it('falls back to the palette by position when no colours are authored', () => {
      expect(resolveCategoryColors(meta())).toEqual(DEFAULT_CATEGORICAL_PALETTE.slice(0, 2));
    });

    it('fills only the gaps when colours are partially authored', () => {
      const colors = resolveCategoryColors(meta({ colors: ['#ff0000', ''] as string[] }));
      expect(colors[0]).toBe('#ff0000');
      expect(colors[1]).toBe(DEFAULT_CATEGORICAL_PALETTE[1]);
    });

    it('is deterministic past the end of the palette (same name, same colour)', () => {
      const many = meta({
        categories: Array.from({ length: 20 }, (_, i) => `cluster-${i}`),
      });
      const a = resolveCategoryColors(many);
      const b = resolveCategoryColors(many);
      expect(a).toEqual(b);
      expect(a).toHaveLength(20);
      expect(a.every((c) => /^#[0-9A-Fa-f]{6}$/.test(c))).toBe(true);
    });
  });

  describe('encodeCategorical', () => {
    const colors = ['#ff0000', '#0000ff'];

    it('maps codes to their category colour at full alpha', () => {
      const out = encodeCategorical(new Uint16Array([0, 1, 0]), { colors });
      expect(colorAt(out, 0)).toEqual({ rgb: [255, 0, 0], a: 1 });
      expect(colorAt(out, 1)).toEqual({ rgb: [0, 0, 255], a: 1 });
      expect(out).toHaveLength(12);
    });

    it('renders NO_CATEGORY as muted grey, never as a real category', () => {
      const out = encodeCategorical(new Uint16Array([NO_CATEGORY, 0]), { colors });
      expect(colorAt(out, 0).rgb).toEqual(MISSING_COLOR);
      expect(colorAt(out, 0).a).toBe(DEFAULT_MUTED_OPACITY);
      expect(colorAt(out, 1).rgb).toEqual([255, 0, 0]);
    });

    it('keeps an uncategorised point muted even when nothing else is', () => {
      const out = encodeCategorical(new Uint16Array([NO_CATEGORY]), { colors, opacity: 1 });
      expect(colorAt(out, 0).a).toBe(DEFAULT_MUTED_OPACITY);
    });

    it('mutes the points the mask marks, keeping their hue for context', () => {
      const out = encodeCategorical(new Uint16Array([0, 0]), {
        colors, muted: new Uint8Array([0, 1]), mutedOpacity: 0.2,
      });
      expect(colorAt(out, 0)).toEqual({ rgb: [255, 0, 0], a: 1 });
      expect(colorAt(out, 1)).toEqual({ rgb: [255, 0, 0], a: 0.2 });
    });

    it('treats an out-of-range code as missing rather than reading past the palette', () => {
      const out = encodeCategorical(new Uint16Array([7]), { colors });
      expect(colorAt(out, 0).rgb).toEqual(MISSING_COLOR);
    });
  });

  describe('encodeContinuous', () => {
    // A blunt two-stop LUT makes position in the ramp readable in assertions.
    const lut = lutFor([[0, '#000000'], [1, '#ffffff']]);

    it('maps the window onto the full ramp', () => {
      const out = encodeContinuous(new Float32Array([0, 5, 10]), { lut, min: 0, max: 10 });
      expect(colorAt(out, 0).rgb).toEqual([0, 0, 0]);
      expect(colorAt(out, 1).rgb[0]).toBeCloseTo(128, -1);
      expect(colorAt(out, 2).rgb).toEqual([255, 255, 255]);
    });

    it('clamps values outside the window instead of wrapping', () => {
      const out = encodeContinuous(new Float32Array([-100, 999]), { lut, min: 0, max: 10 });
      expect(colorAt(out, 0).rgb).toEqual([0, 0, 0]);
      expect(colorAt(out, 1).rgb).toEqual([255, 255, 255]);
    });

    it('log scaling pulls a long count tail apart', () => {
      const values = new Float32Array([0, 10, 1000]);
      const linear = encodeContinuous(values, { lut, min: 0, max: 1000 });
      const log = encodeContinuous(values, { lut, min: 0, max: 1000, log: true });
      // Linear: 10 out of 1000 is indistinguishable from 0. Log: clearly separated.
      expect(colorAt(linear, 1).rgb[0]).toBeLessThan(5);
      expect(colorAt(log, 1).rgb[0]).toBeGreaterThan(80);
    });

    it('renders NaN as muted grey rather than as the ramp floor', () => {
      const out = encodeContinuous(new Float32Array([NaN, 0]), { lut, min: 0, max: 10 });
      expect(colorAt(out, 0).rgb).toEqual(MISSING_COLOR);
      expect(colorAt(out, 0).a).toBe(DEFAULT_MUTED_OPACITY);
      expect(colorAt(out, 1).rgb).toEqual([0, 0, 0]); // a real zero still reads as the floor
    });

    it('maps a degenerate window to the ramp midpoint instead of dividing by zero', () => {
      const out = encodeContinuous(new Float32Array([5, 5]), { lut, min: 5, max: 5 });
      expect(colorAt(out, 0).rgb[0]).toBeCloseTo(128, -1);
      expect(Number.isFinite(out[0])).toBe(true);
    });

    it('applies the mute mask', () => {
      const out = encodeContinuous(new Float32Array([10, 10]), {
        lut, min: 0, max: 10, muted: new Uint8Array([0, 1]),
      });
      expect(colorAt(out, 0).a).toBe(1);
      expect(colorAt(out, 1).a).toBe(DEFAULT_MUTED_OPACITY);
    });
  });

  describe('contrastWindow', () => {
    it('clips outliers so the bulk of the data uses the ramp', () => {
      // 99 values in 0..98 plus one absurd outlier.
      const values = new Float32Array([...Array.from({ length: 99 }, (_, i) => i), 100000]);
      const [min, max] = contrastWindow(values, 0.01, 0.99);
      expect(min).toBeLessThanOrEqual(2);
      expect(max).toBeLessThan(1000); // the outlier does not set the ceiling
    });

    it('spans the data when asked for the full range', () => {
      const values = new Float32Array([3, 1, 2]);
      expect(contrastWindow(values, 0, 1)).toEqual([1, 3]);
    });

    it('ignores NaN', () => {
      const values = new Float32Array([NaN, 1, 2, 3, NaN]);
      expect(contrastWindow(values, 0, 1)).toEqual([1, 3]);
    });

    it('returns a usable window for an empty or all-missing vector', () => {
      expect(contrastWindow(new Float32Array([]))).toEqual([0, 1]);
      expect(contrastWindow(new Float32Array([NaN, NaN]))).toEqual([0, 1]);
    });

    it('widens a flat window so downstream normalisation stays finite', () => {
      const [min, max] = contrastWindow(new Float32Array([7, 7, 7]));
      expect(max).toBeGreaterThan(min);
    });
  });

  describe('markerDiameters', () => {
    const obs = (radius?: number | Float32Array): SpatialObservations => ({
      count: 2, x: new Float32Array(2), y: new Float32Array(2),
      ...(radius !== undefined ? { radius } : {}),
    });

    it('doubles a uniform radius — napari sizes markers by DIAMETER', () => {
      expect(markerDiameters(obs(27.5))).toBe(55);
    });

    it('doubles a per-observation radius vector', () => {
      const out = markerDiameters(obs(new Float32Array([1, 2])));
      expect(Array.from(out as Float32Array)).toEqual([2, 4]);
    });

    it('falls back for a dataset that declares no radius', () => {
      expect(markerDiameters(obs(), 5)).toBe(10);
    });
  });

  describe('toRgbaTuples', () => {
    it('adapts the flat buffer to napari-js RGBA[] without reordering', () => {
      const flat = new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5]);
      expect(toRgbaTuples(flat)).toEqual([[1, 0, 0, 1], [0, 1, 0, 0.5]]);
    });
  });

  describe('lutFor', () => {
    it('builds a 256-entry table from a colormap value', () => {
      expect(lutFor([[0, '#000000'], [1, '#ffffff']])).toHaveLength(256);
    });

    it('falls back to Viridis for an unresolvable colormap rather than returning null', () => {
      const lut = lutFor('not-a-colormap');
      expect(lut).toHaveLength(256);
      expect(lut[0]).not.toEqual(lut[255]);
    });
  });

  describe('spatialContinuousLut', () => {
    it('refuses a grayscale ramp, because the tissue underneath is grayscale', () => {
      // Guard first: the ramp really is grey, or the assertion below is vacuous.
      expect(isGrayscaleLut(lutFor('Greys'))).toBe(true);
      // A grey measurement drawn over grey anatomy cannot be told apart from it.
      const gray = spatialContinuousLut('Greys');
      expect(isGrayscaleLut(gray)).toBe(false);
      // …and what it falls back to is the same Viridis the rest of the library uses.
      expect(gray).toEqual(lutFor('Viridis'));
    });

    it('keeps a colour colormap the user chose', () => {
      const magma = spatialContinuousLut('Magma');
      expect(isGrayscaleLut(magma)).toBe(false);
      // Not silently replaced by the fallback: it is the user's choice.
      expect(magma).toEqual(lutFor('Magma'));
    });

    it('detects a grayscale LUT from its values, not its name', () => {
      expect(isGrayscaleLut([[0, 0, 0], [128, 128, 128]])).toBe(true);
      expect(isGrayscaleLut([[0, 0, 0], [128, 128, 129]])).toBe(false);
    });
  });
});
