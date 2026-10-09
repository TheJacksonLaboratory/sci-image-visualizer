import { Injectable } from '@angular/core';
import { Polygon } from '../../models/region';
import { BBoxMask, rasterizePolygon } from '../../geometry/raster';
import { dropVerticesWithinRadius, pointInPolygonWithHoles, pointInRing } from '../../geometry/ring';
import { labelsToPolygons, maskToPolygons } from '../../geometry/contour';

import { IWandOptions, WandType } from '../../contracts/display-types';

// Canonical wand option/type shapes moved to contracts/display-types (public
// API surface); re-exported here so existing internal imports keep working.
export type { WandType };
export type WandOptions = IWandOptions;

export interface WandImage {
  /**
   * Grayscale: number[][] where data[y][x] is intensity.
   * RGB: [r,g,b][][] where data[y][x] is a 3-tuple.
   */
  data: number[][] | number[][][];
  width: number;
  height: number;
  isGrayscale: boolean;
}

const DEFAULT_PATCH_SIZE = 149;
const DEFAULT_SIGMA = 4.0;
const DEFAULT_SENSITIVITY = 2.0;

/**
 * Wand region-growing tool, modelled after QuPath's WandToolEventHandler.
 *
 * Given an image and a click position, extracts a square patch around the
 * click, optionally blurs it, computes a local threshold, runs a fixed-range
 * flood fill from the centre, closes the resulting mask, and returns the
 * traced contour as a polygon in image coordinates.
 *
 * The rasterizer, ring tests and contour tracer are pure functions in
 * `src/lib/geometry/`; the methods here delegate to them so the DI consumers
 * keep compiling. New code (and workers) should import the pure modules.
 */
@Injectable({ providedIn: 'root' })
export class WandService {

  /**
   * @param image full-image pixel matrix (already in memory).
   * @param cx click x in image-pixel coordinates.
   * @param cy click y in image-pixel coordinates.
   * @param options wand parameters; missing fields fall back to defaults.
   * @returns a Polygon in image-pixel coordinates, or null if no region grew.
   */
  computeRegion(image: WandImage, cx: number, cy: number, options: WandOptions = {}): Polygon | null {
    const patch = this.computePatchMask(image, cx, cy, options);
    if (!patch) return null;
    // The largest traced piece (with holes of 4+ px, as the tools trace); single pixels still count.
    return maskToPolygons(patch.mask, patch.size, patch.size,
      Math.round(cx) - (patch.size - 1) / 2,
      Math.round(cy) - (patch.size - 1) / 2, 1, 4)[0] ?? null;
  }

  /**
   * Compute the wand's per-click flood-fill mask in patch-local coordinates.
   * Same algorithm as `computeRegion` but stops before contour tracing — useful
   * for accumulating per-tick masks across a brush-style stroke.
   *
   * @returns mask of size W*W (0/1) plus W, or null if patchSize is invalid.
   */
  public computePatchMask(image: WandImage, cx: number, cy: number,
                          options: WandOptions = {}): { mask: Uint8Array; size: number } | null {
    const W = options.patchSize ?? DEFAULT_PATCH_SIZE;
    if (W % 2 === 0) {
      throw new Error(`patchSize must be odd, got ${W}`);
    }
    const sigma = options.sigma ?? DEFAULT_SIGMA;
    const sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;
    const isGrayscale = image.isGrayscale;
    const type: WandType = options.type ?? (isGrayscale ? 'GRAY' : 'RGB');
    const simple = !!options.simpleMode;
    // extractPatch always interleaves 1 channel for GRAY, 3 for RGB/LAB_DISTANCE.
    const inputChannels = (type === 'GRAY') ? 1 : 3;

    let buf = this.extractPatch(image, cx, cy, W, type);

    // Flood fill operates on whatever buffer we end up with: the raw patch in
    // simple mode (so multi-channel exact-match), the blurred patch for
    // GRAY/RGB, or the single-channel CIELAB distance map for LAB_DISTANCE.
    let floodChannels: number;
    let threshold: number[];

    if (simple) {
      // Skip blur + threshold computation. Flood-fill the raw patch at
      // exact-match per channel — same as QuPath's doSimpleSelection.
      floodChannels = inputChannels;
      threshold = new Array(floodChannels).fill(0);
    } else {
      const blurSigma = Math.max(0.5, sigma);
      buf = this.gaussianBlur(buf, W, inputChannels, blurSigma);

      if (type === 'LAB_DISTANCE') {
        // Convert blurred 3-channel patch to a single-channel distance map,
        // then flood-fill on that single channel.
        const distance = this.labDistanceMap(buf, W);
        const max = distance.max > 0 ? distance.max : 1;
        const scaled = new Float32Array(W * W);
        for (let i = 0; i < scaled.length; i++) scaled[i] = distance.values[i] * 255.0 / max;
        buf = scaled;
        floodChannels = 1;
        threshold = [distance.mean * sensitivity * 255.0 / max];
      } else {
        floodChannels = inputChannels;
        threshold = this.perChannelThreshold(buf, W, inputChannels, sensitivity);
      }
    }

    const mask = this.floodFill(buf, W, floodChannels, threshold);
    const closed = simple ? mask : this.morphClose(mask, W, 5);
    return { mask: closed, size: W };
  }

  /** Ray-cast point-in-ring test; see {@link pointInRing}. */
  public pointInPolygon(px: number, py: number, xpoints: number[], ypoints: number[]): boolean {
    return pointInRing(px, py, xpoints, ypoints);
  }

  /** See {@link dropVerticesWithinRadius} in `geometry/ring`. */
  public dropVerticesWithinRadius(xpoints: number[], ypoints: number[],
                                  cx: number, cy: number, radius: number)
    : { xpoints: number[]; ypoints: number[]; removed: number } {
    return dropVerticesWithinRadius(xpoints, ypoints, cx, cy, radius);
  }

  /** See {@link rasterizePolygon} in `geometry/raster`. */
  public rasterizePolygon(xpoints: number[], ypoints: number[],
                          imageWidth: number, imageHeight: number,
                          holes?: number[][][]): BBoxMask | null {
    return rasterizePolygon(xpoints, ypoints, imageWidth, imageHeight, holes);
  }

  /** See {@link pointInPolygonWithHoles} in `geometry/ring`. */
  public pointInPolygonWithHoles(px: number, py: number, xpoints: number[], ypoints: number[],
                                 holes?: number[][][]): boolean {
    return pointInPolygonWithHoles(px, py, xpoints, ypoints, holes);
  }

  /** See {@link maskToPolygons} in `geometry/contour`. */
  public maskToPolygons(mask: Uint8Array, w: number, h: number,
                        originX: number, originY: number, minSize = 4,
                        minHoleSize = minSize): Polygon[] {
    return maskToPolygons(mask, w, h, originX, originY, minSize, minHoleSize);
  }

  /** See {@link labelsToPolygons} in `geometry/contour`. */
  public labelsToPolygons(labels: Uint32Array, w: number, h: number,
                          originX: number, originY: number, minSize = 10): Polygon[] {
    return labelsToPolygons(labels, w, h, originX, originY, minSize);
  }

  // ── Patch extraction ────────────────────────────────────────────────

  private extractPatch(image: WandImage, cx: number, cy: number, W: number, type: WandType): Float32Array {
    const channels = (type === 'GRAY') ? 1 : 3;
    const half = (W - 1) / 2;
    const x0 = Math.round(cx) - half;
    const y0 = Math.round(cy) - half;
    const buf = new Float32Array(W * W * channels);

    for (let py = 0; py < W; py++) {
      const iy = y0 + py;
      if (iy < 0 || iy >= image.height) continue;
      const row = image.data[iy];
      if (!row) continue;
      for (let px = 0; px < W; px++) {
        const ix = x0 + px;
        if (ix < 0 || ix >= image.width) continue;
        const dst = (py * W + px) * channels;
        if (image.isGrayscale) {
          const v = row[ix] as number;
          if (channels === 1) {
            buf[dst] = v;
          } else {
            buf[dst] = v;
            buf[dst + 1] = v;
            buf[dst + 2] = v;
          }
        } else {
          const tuple = row[ix] as number[];
          if (channels === 1) {
            // GRAY type forced on RGB image: convert with luminance.
            buf[dst] = 0.299 * tuple[0] + 0.587 * tuple[1] + 0.114 * tuple[2];
          } else {
            buf[dst] = tuple[0];
            buf[dst + 1] = tuple[1];
            buf[dst + 2] = tuple[2];
          }
        }
      }
    }
    return buf;
  }

  // ── Gaussian blur (separable) ───────────────────────────────────────

  private gaussianBlur(buf: Float32Array, W: number, channels: number, sigma: number): Float32Array {
    const radius = Math.max(1, Math.ceil(sigma * 2));
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size);
    let sum = 0;
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (let i = 0; i < size; i++) {
      const x = i - radius;
      kernel[i] = Math.exp(-x * x * inv2s2);
      sum += kernel[i];
    }
    for (let i = 0; i < size; i++) kernel[i] /= sum;

    const horiz = new Float32Array(buf.length);
    // Horizontal pass.
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < channels; c++) {
          let acc = 0;
          for (let k = 0; k < size; k++) {
            let xx = x + k - radius;
            if (xx < 0) xx = 0;
            else if (xx >= W) xx = W - 1;
            acc += kernel[k] * buf[(y * W + xx) * channels + c];
          }
          horiz[(y * W + x) * channels + c] = acc;
        }
      }
    }
    const out = new Float32Array(buf.length);
    // Vertical pass.
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < channels; c++) {
          let acc = 0;
          for (let k = 0; k < size; k++) {
            let yy = y + k - radius;
            if (yy < 0) yy = 0;
            else if (yy >= W) yy = W - 1;
            acc += kernel[k] * horiz[(yy * W + x) * channels + c];
          }
          out[(y * W + x) * channels + c] = acc;
        }
      }
    }
    return out;
  }

  // ── Threshold computation ───────────────────────────────────────────

  private perChannelThreshold(buf: Float32Array, W: number, channels: number, sensitivity: number): number[] {
    const n = W * W;
    const sums = new Array(channels).fill(0);
    const sqs = new Array(channels).fill(0);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        const v = buf[i * channels + c];
        sums[c] += v;
        sqs[c] += v * v;
      }
    }
    const scale = sensitivity > 0 ? 1 / sensitivity : 100;
    const threshold = new Array(channels);
    for (let c = 0; c < channels; c++) {
      const mean = sums[c] / n;
      const variance = Math.max(0, sqs[c] / n - mean * mean);
      const stddev = Math.sqrt(variance);
      threshold[c] = stddev * scale;
    }
    return threshold;
  }

  private labDistanceMap(buf: Float32Array, W: number): { values: Float32Array; mean: number; max: number } {
    const n = W * W;
    const lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = buf[i * 3] / 255;
      const g = buf[i * 3 + 1] / 255;
      const b = buf[i * 3 + 2] / 255;
      const [L, A, B] = srgbToLab(r, g, b);
      lab[i * 3] = L;
      lab[i * 3 + 1] = A;
      lab[i * 3 + 2] = B;
    }
    const mid = Math.floor(n / 2);
    const cL = lab[mid * 3];
    const cA = lab[mid * 3 + 1];
    const cB = lab[mid * 3 + 2];

    const values = new Float32Array(n);
    let max = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dL = lab[i * 3] - cL;
      const dA = lab[i * 3 + 1] - cA;
      const dB = lab[i * 3 + 2] - cB;
      const d = Math.sqrt(dL * dL + dA * dA + dB * dB);
      values[i] = d;
      if (d > max) max = d;
      sum += d;
    }
    return { values, mean: sum / n, max };
  }

  // ── Flood fill ──────────────────────────────────────────────────────

  /**
   * Fixed-range scanline flood fill from the patch centre. A neighbour is
   * accepted iff for every channel `|p[c] - seed[c]| <= threshold[c]`.
   */
  private floodFill(buf: Float32Array, W: number, channels: number, threshold: number[]): Uint8Array {
    const mask = new Uint8Array(W * W);
    const seedX = (W - 1) / 2;
    const seedY = (W - 1) / 2;
    const seedIdx = (seedY * W + seedX) * channels;
    const seed = new Array(channels);
    for (let c = 0; c < channels; c++) seed[c] = buf[seedIdx + c];

    const accept = (x: number, y: number): boolean => {
      const idx = (y * W + x) * channels;
      for (let c = 0; c < channels; c++) {
        const diff = Math.abs(buf[idx + c] - seed[c]);
        if (diff > threshold[c]) return false;
      }
      return true;
    };

    const stack: number[] = [seedX, seedY];
    while (stack.length) {
      const y = stack.pop() as number;
      const x = stack.pop() as number;
      if (x < 0 || x >= W || y < 0 || y >= W) continue;
      if (mask[y * W + x]) continue;
      if (!accept(x, y)) continue;

      // Find left edge of run.
      let xl = x;
      while (xl > 0 && !mask[y * W + (xl - 1)] && accept(xl - 1, y)) xl--;
      // Find right edge of run.
      let xr = x;
      while (xr < W - 1 && !mask[y * W + (xr + 1)] && accept(xr + 1, y)) xr++;

      for (let xi = xl; xi <= xr; xi++) {
        mask[y * W + xi] = 1;
      }
      // Seed runs above and below.
      if (y > 0) {
        for (let xi = xl; xi <= xr; xi++) {
          if (!mask[(y - 1) * W + xi]) {
            stack.push(xi, y - 1);
          }
        }
      }
      if (y < W - 1) {
        for (let xi = xl; xi <= xr; xi++) {
          if (!mask[(y + 1) * W + xi]) {
            stack.push(xi, y + 1);
          }
        }
      }
    }
    return mask;
  }

  // ── Morphological close (dilate then erode) ─────────────────────────

  private morphClose(mask: Uint8Array, W: number, kernelSize: number): Uint8Array {
    const r = (kernelSize - 1) / 2;
    const dil = this.dilate(mask, W, r);
    return this.erode(dil, W, r);
  }

  private dilate(mask: Uint8Array, W: number, r: number): Uint8Array {
    const out = new Uint8Array(W * W);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        let hit = 0;
        for (let dy = -r; dy <= r && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= W) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            if (mask[yy * W + xx]) { hit = 1; break; }
          }
        }
        out[y * W + x] = hit;
      }
    }
    return out;
  }

  private erode(mask: Uint8Array, W: number, r: number): Uint8Array {
    const out = new Uint8Array(W * W);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        let all = 1;
        for (let dy = -r; dy <= r && all; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= W) { all = 0; break; }
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) { all = 0; break; }
            if (!mask[yy * W + xx]) { all = 0; break; }
          }
        }
        out[y * W + x] = all;
      }
    }
    return out;
  }
}

// ── sRGB → CIELAB (D65) ───────────────────────────────────────────────

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  // sRGB → XYZ (D65)
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  // Reference white (D65)
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const fx = labF(X / Xn);
  const fy = labF(Y / Yn);
  const fz = labF(Z / Zn);
  const L = 116 * fy - 16;
  const A = 500 * (fx - fy);
  const Bv = 200 * (fy - fz);
  return [L, A, Bv];
}

function labF(t: number): number {
  const d = 6 / 29;
  return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
}
