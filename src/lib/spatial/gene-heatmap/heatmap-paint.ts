import type { Rgb } from '../../contracts/color';

/**
 * Turning the gene heatmap's values into pixels: colour lookup over a value range, the
 * grouped view's values per scale, and its rows averaged into blocks when more genes are on
 * screen than pixels. Pure — no canvas — so each is tested on its own.
 */

/** A 256-entry RGB table as RGBA bytes, alpha opaque. */
export function lutRgba(lut: readonly Rgb[]): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = lut[Math.min(lut.length - 1, Math.round((i * (lut.length - 1)) / 255))];
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * RGBA pixels for `values` (row-major), each coloured by where it falls in `[lo, hi]`. A value
 * that is not a number is left transparent: nothing was measured there.
 */
export function paintValues(
  values: ArrayLike<number>,
  lo: number,
  hi: number,
  rgba: Uint8Array,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  const span = hi > lo ? hi - lo : 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const k = Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255))) * 4;
    out[i * 4] = rgba[k];
    out[i * 4 + 1] = rgba[k + 1];
    out[i * 4 + 2] = rgba[k + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** How the grouped view scales a gene's means. */
export type GroupScale = 'z' | 'expression' | 'gene';

/**
 * The grouped view's values: the means as they are, each gene's means over its largest
 * (`gene`), or z-scored across the groups (`z`), so a gene expressed everywhere at a high level
 * does not outshine one that marks a single group. A gene with no spread is 0 when z-scored.
 */
export function scaleMeans(means: Float32Array, genes: number, groups: number, scale: GroupScale): Float32Array {
  if (scale === 'expression') return means;
  const out = new Float32Array(means.length);
  for (let g = 0; g < genes; g++) {
    const o = g * groups;
    if (scale === 'gene') {
      let max = 0;
      for (let k = 0; k < groups; k++) max = Math.max(max, means[o + k]);
      for (let k = 0; k < groups; k++) out[o + k] = max > 0 ? means[o + k] / max : 0;
      continue;
    }
    let sum = 0;
    for (let k = 0; k < groups; k++) sum += means[o + k];
    const mean = sum / groups;
    let ss = 0;
    for (let k = 0; k < groups; k++) ss += (means[o + k] - mean) ** 2;
    const sd = Math.sqrt(ss / groups);
    for (let k = 0; k < groups; k++) out[o + k] = sd > 0 ? (means[o + k] - mean) / sd : 0;
  }
  return out;
}

/** The value range a scale is drawn over: symmetric about 0 for z-scores. */
export function rangeOf(
  values: Float32Array,
  scale: GroupScale | 'cells-expression' | 'cells-gene',
  max?: number,
): [number, number] {
  if (scale === 'gene' || scale === 'cells-gene') return [0, 1];
  if (scale === 'cells-expression') return [0, max && max > 0 ? max : 1];
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) peak = Math.max(peak, scale === 'z' ? Math.abs(v) : v);
  }
  if (peak <= 0) peak = 1;
  return scale === 'z' ? [-peak, peak] : [0, peak];
}

/**
 * Rows `[r0, r1)` of a row-major `rows × cols` matrix, averaged in blocks of `2^level`
 * consecutive rows (the last block may be short): the grouped view at the screen's resolution.
 * Block `b` covers rows `b·2^level ..`; `r0` is rounded down to a block.
 */
export function blockRows(
  values: Float32Array,
  rows: number,
  cols: number,
  level: number,
  r0: number,
  r1: number,
): { values: Float32Array; firstRow: number; blocks: number } {
  const size = 2 ** level;
  const b0 = Math.max(0, Math.floor(r0 / size));
  const b1 = Math.min(Math.ceil(rows / size), Math.ceil(r1 / size));
  const blocks = Math.max(0, b1 - b0);
  const out = new Float32Array(blocks * cols);
  for (let b = 0; b < blocks; b++) {
    const from = (b0 + b) * size;
    const to = Math.min(rows, from + size);
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let r = from; r < to; r++) sum += values[r * cols + c];
      out[b * cols + c] = sum / (to - from);
    }
  }
  return { values: out, firstRow: b0 * size, blocks };
}
