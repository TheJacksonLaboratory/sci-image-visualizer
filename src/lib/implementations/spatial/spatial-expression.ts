import { SpatialImageRef, SpatialObservations } from '../../contracts/spatial-dataset.contract';

/**
 * Turning per-cell expression into a **gene map** — a continuous field over the
 * tissue, drawn under the cells rather than instead of them.
 *
 * A scatter coloured by a gene answers "which cells express it"; it does not answer
 * "where is it expressed", because the eye cannot integrate thousands of small dots
 * into a territory. A field can be estimated between the cells and read as a
 * region, which is what the CosMx guidance and Spatial-Live's heat layer both do.
 *
 * The quantity is the kernel-weighted **MEAN per cell**, not a sum:
 *
 * ```
 *   mean(p) = Σᵢ w(p, xᵢ)·eᵢ  /  Σᵢ w(p, xᵢ)
 * ```
 *
 * A sum would conflate "many cells here" with "high expression here" — a dense
 * region would glow whatever its cells were doing, which is the single easiest way
 * to read a gene map wrongly. The denominator is also what makes emptiness
 * expressible: where no cell was measured the mean is *undefined*, not zero, so the
 * caller gets a `support` channel and can draw nothing there instead of drawing the
 * colormap's low end over unmeasured tissue.
 *
 * Pure — no Angular, no GPU, no colour — like `spatial-density.ts`, and tested the
 * same way.
 */

export interface ExpressionFieldOptions {
  /** Data→image affine, so the field lands in the displayed image's pixels. */
  ref?: SpatialImageRef;
  /** Raster size in field pixels. */
  width: number;
  height: number;
  /** Image pixels per field pixel — the field is coarser than the slide it covers. */
  step: number;
  /** Kernel σ in FIELD pixels. */
  sigma: number;
  /** One expression value per observation. */
  values: Float32Array;
  /** Observations to include; every one when absent (a plane, a selection). */
  indices?: Uint32Array;
}

export interface ExpressionField {
  width: number;
  height: number;
  /** Kernel-weighted mean expression, valid only where `support > 0`. */
  mean: Float32Array;
  /** Kernel-weighted cell count per field pixel — 0 where nothing was measured. */
  support: Float32Array;
  /** Median positive support: the scale at which a pixel is "properly sampled",
   *  and a data-driven saturation point for an opacity ramp. */
  supportScale: number;
  /** Finite range of `mean` over the supported pixels, for a contrast window. */
  range: [number, number];
}

/** In-place separable Gaussian along one axis of a `w × h` field. */
function blurAxis(field: Float32Array, w: number, h: number, axis: 0 | 1, sigma: number): void {
  if (!(sigma > 0.01)) return;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const len = axis === 0 ? w : h;
  const stride = axis === 0 ? 1 : w;
  const lines = axis === 0 ? h : w;
  const line = new Float32Array(len);
  for (let l = 0; l < lines; l++) {
    const base = axis === 0 ? l * w : l;
    for (let i = 0; i < len; i++) line[i] = field[base + i * stride];
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        // Clamped edges: zero-padding would darken the specimen's own boundary,
        // and the support channel already says where there is no data at all.
        const j = Math.min(len - 1, Math.max(0, i + k));
        acc += line[j] * kernel[k + radius];
      }
      field[base + i * stride] = acc;
    }
  }
}

/**
 * Estimate a gene's expression field over the image the observations sit in.
 *
 * Null when nothing lands on the raster — the caller then draws no layer, rather
 * than an empty one the reader has to interpret.
 */
export function expressionField(
  obs: SpatialObservations,
  opts: ExpressionFieldOptions,
): ExpressionField | null {
  const { width: w, height: h, step, sigma, values, indices } = opts;
  if (w <= 0 || h <= 0) return null;
  const [sx, sy] = opts.ref?.scale ?? [1, 1];
  const [tx, ty] = opts.ref?.translate ?? [0, 0];

  const num = new Float32Array(w * h);
  const den = new Float32Array(w * h);
  const n = indices ? indices.length : obs.count;
  let placed = 0;
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k;
    const e = values[i];
    // A NaN is "not measured for this cell", which must not become a zero: it
    // would pull the local mean down as if the gene were absent there.
    if (!Number.isFinite(e)) continue;
    const px = Math.floor((obs.x[i] * sx + tx) / step);
    const py = Math.floor((obs.y[i] * sy + ty) / step);
    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    const at = py * w + px;
    num[at] += e;
    den[at] += 1;
    placed++;
  }
  if (!placed) return null;

  for (const axis of [0, 1] as const) {
    blurAxis(num, w, h, axis, sigma);
    blurAxis(den, w, h, axis, sigma);
  }

  const mean = new Float32Array(w * h);
  let lo = Infinity;
  let hi = -Infinity;
  const positives: number[] = [];
  for (let i = 0; i < mean.length; i++) {
    const d = den[i];
    if (d <= 0) continue;
    const m = num[i] / d;
    mean[i] = m;
    positives.push(d);
    if (m < lo) lo = m;
    if (m > hi) hi = m;
  }
  if (!Number.isFinite(lo)) return null;

  positives.sort((a, b) => a - b);
  const supportScale = positives[positives.length >> 1] || 0;
  return {
    width: w,
    height: h,
    mean,
    support: den,
    supportScale,
    range: hi > lo ? [lo, hi] : [lo, lo + 1],
  };
}

/**
 * Colour a field into RGBA8 for a `channels: 4` image source.
 *
 * Alpha comes from the SUPPORT, ramped to the field's own median support rather
 * than a constant: a pixel backed by one distant cell is faint, a properly sampled
 * one is solid, and unmeasured tissue is fully transparent — so the map never
 * asserts a measurement where there was none. `opacity` scales the whole layer on
 * top of that.
 */
export function colorExpressionField(
  field: ExpressionField,
  lut: readonly (readonly [number, number, number])[],
  window: [number, number],
  opts: { log?: boolean; opacity?: number } = {},
): Uint8Array {
  const { mean, support, supportScale } = field;
  const rgba = new Uint8Array(mean.length * 4);
  const log = !!opts.log;
  const opacity = opts.opacity ?? 1;
  const norm = (v: number): number => (log ? Math.log1p(Math.max(0, v)) : v);
  const lo = norm(window[0]);
  const hi = norm(window[1]);
  const span = hi > lo ? hi - lo : 1;
  const last = lut.length - 1;
  const sat = supportScale > 0 ? supportScale : 1;
  for (let i = 0; i < mean.length; i++) {
    const d = support[i];
    if (d <= 0) continue; // unmeasured — leave it transparent
    const t = Math.min(1, Math.max(0, (norm(mean[i]) - lo) / span));
    const c = lut[Math.round(t * last)] ?? lut[last];
    const a = Math.min(1, d / sat) * opacity;
    const o = i * 4;
    // Premultiplied, matching the canvas alpha mode the renderer configures.
    rgba[o] = Math.round(c[0] * a);
    rgba[o + 1] = Math.round(c[1] * a);
    rgba[o + 2] = Math.round(c[2] * a);
    rgba[o + 3] = Math.round(a * 255);
  }
  return rgba;
}
