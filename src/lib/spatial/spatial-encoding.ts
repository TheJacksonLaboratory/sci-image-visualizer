import { Rgb, buildColormapLut } from '../contracts/colormap-lut';
import { fallbackColorFor } from '../store/class-color.util';
import {
  CategoricalColumnMeta, NO_CATEGORY, SpatialObservations,
} from '../contracts/spatial-dataset.contract';
import { ColormapValue } from '../contracts/display-types';

/**
 * Turning spatial-omics columns into per-point visual attributes.
 *
 * Pure — no Angular, no RxJS, no renderer — like `plotly-trace-builders.ts`, so
 * the encodings are testable on their own and shared by any backend that grows
 * a spatial mode.
 *
 * The rules here are the ones the CosMx analysis guidance prescribes, made
 * explicit rather than left to each call site:
 *  - count-like columns read on a **log** scale (linear collapses them against a
 *    few bright outliers);
 *  - contrast windows come from **percentiles**, not min/max, so a single
 *    saturated spot doesn't flatten everything else;
 *  - context is kept by **muting** rather than hiding — background points stay
 *    visible at low alpha so the tissue shape survives.
 *
 * COLOUR REPRESENTATION
 * ---------------------
 * Internally everything is a flat `Float32Array` of `[r,g,b,a, …]` in 0..1 —
 * one allocation for N points, GPU-upload shaped. napari-js 0.12.0's
 * `PointsLayer.faceColor` takes `RGBA[]` (an array of 4-tuples) instead, so
 * {@link toRgbaTuples} adapts at the boundary; when the layer accepts a typed
 * array the adapter goes away and the flat buffer is passed straight through.
 */

/** napari-js per-point colour tuple: r, g, b, a in 0..1. */
export type RGBA = [number, number, number, number];

/** Neutral grey for observations with no value (NaN, or {@link NO_CATEGORY}). */
export const MISSING_COLOR: Rgb = [150, 150, 150];

/** Default alpha for muted (background / unselected) points — CosMx-style context. */
export const DEFAULT_MUTED_OPACITY = 0.15;

/**
 * Largest number of CATEGORIES whose colours survive the 3D points layer's LUT
 * intact.
 *
 * That layer has no per-point RGBA — it maps a per-point SCALAR through a
 * 256-entry colormap LUT — so a categorical palette is encoded as one contiguous
 * block of LUT entries per value. Measured against napari-js, every K in 2..96
 * blocks round-trips exactly and K=97 is the first that does not: 256 texels
 * cannot keep more values apart than that.
 *
 * One of those 96 blocks is spent on {@link NO_CATEGORY}, which every column can
 * contain, so what fits is **95 categories** — the number published here. It was
 * 96 while the encoder rejected at 96, which meant a 96-category column drew flat
 * with the panel showing no warning: the one failure this ceiling exists to
 * prevent, arrived at from the other direction.
 *
 * Above it the cloud draws FLAT rather than draw a lie, because subtly wrong
 * category colours under a confident legend is the failure nobody catches.
 *
 * A limit of that one layer, and of nothing else: the 2D markers carry per-point
 * RGBA, and a density volume is a scalar field per cluster. Shared here so the
 * renderer that enforces it and the panel that explains it cannot drift apart.
 */
export const SPATIAL_3D_MAX_CATEGORIES = 95;

/** LUT blocks the 3D layer can keep apart — {@link SPATIAL_3D_MAX_CATEGORIES}
 *  plus the one reserved for a missing value. */
export const SPATIAL_3D_LUT_BLOCKS = SPATIAL_3D_MAX_CATEGORIES + 1;

/**
 * Fallback categorical palette. Colour-blind-safe and stable, so a category
 * without an authored colour still lands somewhere sensible and lands there
 * every run (`fallbackColorFor` hashes the name — same name, same colour).
 * Okabe–Ito, plus two greys for long tails.
 */
export const DEFAULT_CATEGORICAL_PALETTE: string[] = [
  '#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9',
  '#D55E00', '#F0E442', '#000000', '#7F7F7F', '#BFBFBF',
];

interface MuteOptions {
  /** Alpha for points that are not muted. Default 1. */
  opacity?: number;
  /** Alpha for muted points. Default {@link DEFAULT_MUTED_OPACITY}. */
  mutedOpacity?: number;
  /** `1` at index i mutes observation i. Absent ⇒ nothing is muted. */
  muted?: Uint8Array | null;
}

export interface CategoricalEncodingOptions extends MuteOptions {
  /** Per-category `#rrggbb`, index-aligned with the column's categories. */
  colors: string[];
  /** Colour for {@link NO_CATEGORY}. Default {@link MISSING_COLOR}. */
  missingColor?: Rgb;
}

export interface ContinuousEncodingOptions extends MuteOptions {
  /** 256-entry RGB table from {@link buildColormapLut}. */
  lut: Rgb[];
  /** Contrast window in VALUE units (pre-log). */
  min: number;
  max: number;
  /** Apply `log1p` to the value and the window before normalising. */
  log?: boolean;
  /** Colour for `NaN`. Default {@link MISSING_COLOR}. */
  missingColor?: Rgb;
}

/** Parse `#rgb` / `#rrggbb` to 0–255 RGB; unparseable input falls back to grey.
 *  Exported so the 3D LUT path parses palettes exactly as the 2D path does. */
export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return MISSING_COLOR;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function alphaAt(i: number, opts: MuteOptions): number {
  const on = opts.opacity ?? 1;
  const off = opts.mutedOpacity ?? DEFAULT_MUTED_OPACITY;
  return opts.muted && opts.muted[i] ? off : on;
}

/**
 * Per-category colours: the column's authored `colors` where present (so the
 * viewer matches the figures the same analysis produced elsewhere), otherwise
 * the palette by position, wrapping through a name-hash past its end so a
 * 40-cluster column still gets stable, distinct-ish colours.
 */
export function resolveCategoryColors(
  meta: CategoricalColumnMeta, palette: string[] = DEFAULT_CATEGORICAL_PALETTE,
): string[] {
  const authored = meta.colors;
  return meta.categories.map((name, i) => {
    const given = authored?.[i];
    if (given) return given;
    if (i < palette.length) return palette[i];
    return fallbackColorFor(name, palette);
  });
}

/** Categorical column → flat per-point RGBA (length `4 * codes.length`). */
export function encodeCategorical(
  codes: Uint16Array, opts: CategoricalEncodingOptions,
): Float32Array {
  const n = codes.length;
  const out = new Float32Array(n * 4);
  // Resolve each category once — parsing a hex string per point would dominate.
  const rgb = opts.colors.map(parseHex);
  const missing = opts.missingColor ?? MISSING_COLOR;
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    const c = code === NO_CATEGORY || code >= rgb.length ? missing : rgb[code];
    const o = i * 4;
    out[o] = c[0] / 255;
    out[o + 1] = c[1] / 255;
    out[o + 2] = c[2] / 255;
    // A point with no category is background by definition — never emphasised.
    out[o + 3] = code === NO_CATEGORY
      ? Math.min(alphaAt(i, opts), opts.mutedOpacity ?? DEFAULT_MUTED_OPACITY)
      : alphaAt(i, opts);
  }
  return out;
}

/** Continuous column / gene vector → flat per-point RGBA. */
export function encodeContinuous(
  values: Float32Array, opts: ContinuousEncodingOptions,
): Float32Array {
  const n = values.length;
  const out = new Float32Array(n * 4);
  const missing = opts.missingColor ?? MISSING_COLOR;
  const lut = opts.lut;
  const lo = opts.log ? Math.log1p(Math.max(0, opts.min)) : opts.min;
  const hi = opts.log ? Math.log1p(Math.max(0, opts.max)) : opts.max;
  // A degenerate window (all values equal) maps everything to the LUT midpoint
  // rather than dividing by zero.
  const span = hi - lo;
  for (let i = 0; i < n; i++) {
    const raw = values[i];
    const o = i * 4;
    if (!Number.isFinite(raw)) {
      out[o] = missing[0] / 255;
      out[o + 1] = missing[1] / 255;
      out[o + 2] = missing[2] / 255;
      out[o + 3] = opts.mutedOpacity ?? DEFAULT_MUTED_OPACITY;
      continue;
    }
    const v = opts.log ? Math.log1p(Math.max(0, raw)) : raw;
    const t = span > 0 ? (v - lo) / span : 0.5;
    const idx = Math.max(0, Math.min(255, Math.round(t * 255)));
    const c = lut[idx] ?? missing;
    out[o] = c[0] / 255;
    out[o + 1] = c[1] / 255;
    out[o + 2] = c[2] / 255;
    out[o + 3] = alphaAt(i, opts);
  }
  return out;
}

/**
 * Contrast window from percentiles of the finite values — the CosMx
 * "cap outliers at percentiles to improve contrast" rule. `lo`/`hi` are
 * fractions (0.01 / 0.99 clips the extreme 1% at each end).
 *
 * Returns `[0, 1]` for an empty or all-missing vector so callers always get a
 * usable window.
 */
export function contrastWindow(
  values: Float32Array, lo = 0.01, hi = 0.99,
): [number, number] {
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) finite.push(values[i]);
  }
  if (finite.length === 0) return [0, 1];
  finite.sort((a, b) => a - b);
  const at = (f: number) => {
    const k = Math.max(0, Math.min(finite.length - 1, Math.round(f * (finite.length - 1))));
    return finite[k];
  };
  const min = at(Math.max(0, Math.min(1, lo)));
  const max = at(Math.max(0, Math.min(1, hi)));
  // A flat or inverted window would divide by zero downstream; widen it.
  return max > min ? [min, max] : [min, min + 1];
}

/**
 * Marker sizes for the points layer. napari-js `PointsLayer.size` is a
 * **diameter** in data units while `SpatialObservations.radius` is a radius —
 * the doubling lives here so no call site has to remember it.
 *
 * `fallbackRadius` covers a dataset that declares no radius (segmented cells
 * often don't); it is in image pixels, like everything else in this space.
 */
export function markerDiameters(
  observations: SpatialObservations, fallbackRadius = 4,
): number | Float32Array {
  const r = observations.radius;
  if (typeof r === 'number') return r * 2;
  if (r instanceof Float32Array) {
    const out = new Float32Array(r.length);
    for (let i = 0; i < r.length; i++) out[i] = r[i] * 2;
    return out;
  }
  return fallbackRadius * 2;
}

/**
 * Adapt a flat RGBA buffer to the `RGBA[]` shape napari-js 0.12.0's
 * `PointsLayer.faceColor` accepts. One 4-element array per point — the reason
 * this is a named boundary rather than inlined: it is the one place the model
 * stops being typed-array shaped, and it is what a future napari-js taking a
 * `Float32Array` would delete.
 */
export function toRgbaTuples(flat: Float32Array): RGBA[] {
  const n = flat.length / 4;
  const out: RGBA[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = [flat[o], flat[o + 1], flat[o + 2], flat[o + 3]];
  }
  return out;
}

/** Convenience: a 256-entry LUT for a colormap value, falling back to Viridis. */
export function lutFor(colormapValue: unknown, reverse = false): Rgb[] {
  return buildColormapLut(colormapValue, reverse)
    ?? buildColormapLut('Viridis', reverse)!;
}

/** True when every entry of a LUT is a neutral grey. Tested on the VALUES rather
 *  than the colormap's name, so a reversed or renamed grey ramp still counts. */
export function isGrayscaleLut(lut: readonly Rgb[]): boolean {
  return lut.every(([r, g, b]) => r === g && g === b);
}

/**
 * LUT for a spatial CONTINUOUS encoding — a gene, a numeric column.
 *
 * `override` is the caller's explicit choice and wins outright, grey included: a
 * grey ramp picked FOR the data is a decision, not the image's colormap leaking
 * in.
 *
 * Without one, the display colormap — unless that colormap is grayscale. The
 * tissue underneath is grayscale, so a grey overlay of a measurement is
 * indistinguishable from the anatomy it is drawn over, and the reader cannot tell
 * which channel a bright pixel belongs to. Viridis is then the fallback, which is
 * what the CosMx guidance prescribes for continuous values anyway.
 *
 * Shared by the markers, both gene maps and the panel's colour bar, so none of
 * them can disagree about what a colour means, whichever way the choice falls.
 */
export function spatialContinuousLut(
  colormapValue: unknown, reverse = false, override?: ColormapValue | null,
): Rgb[] {
  // An inline scale is an array, so emptiness has to be checked as well as
  // presence: `[]` is truthy and would resolve to the fallback LUT silently.
  const chosen = Array.isArray(override) ? (override.length ? override : null) : override;
  if (chosen) return lutFor(chosen, reverse);
  const lut = lutFor(colormapValue, reverse);
  return isGrayscaleLut(lut) ? buildColormapLut('Viridis', reverse)! : lut;
}
