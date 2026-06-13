import { Injectable } from '@angular/core';
import { Polygon } from '../models/region';

import { IWandOptions, WandType } from '../contracts/display-types';

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
    return this.maskToPolygon(patch.mask, patch.size, patch.size, image.width, image.height,
      Math.round(cx) - (patch.size - 1) / 2,
      Math.round(cy) - (patch.size - 1) / 2);
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

  /**
   * Standard ray-cast point-in-polygon test. (px, py) and the polygon
   * vertices must be in the same coordinate system.
   */
  public pointInPolygon(px: number, py: number, xpoints: number[], ypoints: number[]): boolean {
    const n = xpoints.length;
    if (n < 3) return false;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ypoints[i], yj = ypoints[j];
      const xi = xpoints[i], xj = xpoints[j];
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Drop every vertex whose Euclidean distance to (cx, cy) is less than
   * `radius`. Returns trimmed parallel arrays plus how many vertices were
   * removed (so the caller can detect a no-op tick and skip the relayout).
   */
  public dropVerticesWithinRadius(xpoints: number[], ypoints: number[],
                                  cx: number, cy: number, radius: number)
    : { xpoints: number[]; ypoints: number[]; removed: number } {
    const r2 = radius * radius;
    const xs: number[] = [];
    const ys: number[] = [];
    let removed = 0;
    for (let i = 0; i < xpoints.length; i++) {
      const dx = xpoints[i] - cx;
      const dy = ypoints[i] - cy;
      if (dx * dx + dy * dy < r2) {
        removed++;
        continue;
      }
      xs.push(xpoints[i]);
      ys.push(ypoints[i]);
    }
    return { xpoints: xs, ypoints: ys, removed };
  }

  /**
   * Rasterize a closed polygon into a bbox-relative mask suitable as a
   * starting point for a wand stroke accumulator.
   *
   * Returns the bbox origin (clamped to the image) plus the filled mask, or
   * null if the polygon is degenerate or fully outside the image.
   */
  public rasterizePolygon(xpoints: number[], ypoints: number[],
                          imageWidth: number, imageHeight: number)
    : { bx: number; by: number; bw: number; bh: number; mask: Uint8Array } | null {

    const n = xpoints.length;
    if (n < 3) return null;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xpoints[i] < minX) minX = xpoints[i];
      if (xpoints[i] > maxX) maxX = xpoints[i];
      if (ypoints[i] < minY) minY = ypoints[i];
      if (ypoints[i] > maxY) maxY = ypoints[i];
    }
    const bx = Math.max(0, Math.floor(minX));
    const by = Math.max(0, Math.floor(minY));
    const bx1 = Math.min(imageWidth, Math.ceil(maxX) + 1);
    const by1 = Math.min(imageHeight, Math.ceil(maxY) + 1);
    const bw = bx1 - bx;
    const bh = by1 - by;
    if (bw <= 0 || bh <= 0) return null;

    const mask = new Uint8Array(bw * bh);
    // Scanline polygon fill — sample each row at its pixel centre.
    for (let py = 0; py < bh; py++) {
      const y = by + py + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = ypoints[i], yj = ypoints[j];
        if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
          const t = (y - yi) / (yj - yi);
          xs.push(xpoints[i] + t * (xpoints[j] - xpoints[i]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xStart = Math.max(0, Math.ceil(xs[k] - bx));
        const xEnd = Math.min(bw - 1, Math.floor(xs[k + 1] - bx));
        for (let x = xStart; x <= xEnd; x++) mask[py * bw + x] = 1;
      }
    }
    return { bx, by, bw, bh, mask };
  }

  /**
   * Trace the largest 4-connected blob in `mask` (sized w*h) and return a
   * Polygon translated into image-pixel coordinates via (originX, originY) and
   * clamped to (imageWidth, imageHeight).
   */
  public maskToPolygon(mask: Uint8Array, w: number, h: number,
                       imageWidth: number, imageHeight: number,
                       originX: number, originY: number): Polygon | null {
    const verticesLocal = this.traceContour(mask, w, h);
    if (!verticesLocal || verticesLocal.length < 3) return null;
    const xpoints: number[] = [];
    const ypoints: number[] = [];
    const coordinates: number[][] = [];
    for (const v of verticesLocal) {
      const ix = Math.round(originX + v.x);
      const iy = Math.round(originY + v.y);
      const cx2 = Math.max(0, Math.min(imageWidth - 1, ix));
      const cy2 = Math.max(0, Math.min(imageHeight - 1, iy));
      xpoints.push(cx2);
      ypoints.push(cy2);
      coordinates.push([cx2, cy2]);
    }
    const poly = new Polygon();
    poly.npoints = xpoints.length;
    poly.xpoints = xpoints;
    poly.ypoints = ypoints;
    poly.coordinates = coordinates;
    return poly;
  }

  /**
   * Trace EVERY 4-connected blob in `mask` (sized w*h) whose area is at least
   * `minSize` pixels, returning one Polygon per blob in image-pixel coordinates
   * (translated via originX/originY, clamped to imageWidth/imageHeight), ordered
   * largest-first. Unlike {@link maskToPolygon} (largest blob only), this lets
   * the brush eraser split a region in two when a stroke cuts through it rather
   * than discarding the smaller piece.
   */
  public maskToPolygons(mask: Uint8Array, w: number, h: number,
                        imageWidth: number, imageHeight: number,
                        originX: number, originY: number, minSize = 4): Polygon[] {
    // Label all 4-connected components, recording each one's pixel count.
    const labels = new Int32Array(w * h);
    const sizes: number[] = [0]; // sizes[label]; label 0 unused
    let nextLabel = 0;
    const queue: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || labels[idx]) continue;
        nextLabel++;
        labels[idx] = nextLabel;
        let size = 0;
        queue.push(idx);
        while (queue.length) {
          const i = queue.pop() as number;
          size++;
          const px = i % w;
          const py = (i - px) / w;
          if (px > 0)     { const j = i - 1;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
          if (px < w - 1) { const j = i + 1;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
          if (py > 0)     { const j = i - w;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
          if (py < h - 1) { const j = i + w;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
        }
        sizes[nextLabel] = size;
      }
    }

    const wanted: number[] = [];
    for (let lbl = 1; lbl <= nextLabel; lbl++) {
      if (sizes[lbl] >= minSize) wanted.push(lbl);
    }
    wanted.sort((a, b) => sizes[b] - sizes[a]); // largest-first

    const polys: Polygon[] = [];
    const comp = new Uint8Array(w * h);
    for (const lbl of wanted) {
      comp.fill(0);
      for (let i = 0; i < comp.length; i++) comp[i] = labels[i] === lbl ? 1 : 0;
      const verts = this.mooreBoundary(comp, w, h);
      if (!verts || verts.length < 3) continue;
      const xpoints: number[] = [];
      const ypoints: number[] = [];
      const coordinates: number[][] = [];
      for (const v of verts) {
        const ix = Math.round(originX + v.x);
        const iy = Math.round(originY + v.y);
        const cx2 = Math.max(0, Math.min(imageWidth - 1, ix));
        const cy2 = Math.max(0, Math.min(imageHeight - 1, iy));
        xpoints.push(cx2);
        ypoints.push(cy2);
        coordinates.push([cx2, cy2]);
      }
      const poly = new Polygon();
      poly.npoints = xpoints.length;
      poly.xpoints = xpoints;
      poly.ypoints = ypoints;
      poly.coordinates = coordinates;
      polys.push(poly);
    }
    return polys;
  }

  /**
   * Trace each instance in an integer label map (0 = background) into a Polygon
   * — used to turn a cellpose-style segmentation into region outlines. Labels
   * with area below `minSize` are skipped. Coords are translated via
   * originX/originY and clamped to imageWidth/imageHeight.
   */
  public labelsToPolygons(labels: Uint32Array, w: number, h: number,
                          imageWidth: number, imageHeight: number,
                          originX: number, originY: number, minSize = 10): Polygon[] {
    let maxLabel = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
    const out: Polygon[] = [];
    const bin = new Uint8Array(w * h);
    for (let lbl = 1; lbl <= maxLabel; lbl++) {
      let any = false;
      for (let i = 0; i < labels.length; i++) {
        const on = labels[i] === lbl; bin[i] = on ? 1 : 0; if (on) any = true;
      }
      if (!any) continue;
      // Reuse the contour tracer; one label is usually a single blob.
      for (const p of this.maskToPolygons(bin, w, h, imageWidth, imageHeight, originX, originY, minSize)) {
        out.push(p);
      }
    }
    return out;
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

  // ── Contour tracing (Moore-neighbour boundary follow) ───────────────

  /**
   * Returns the outer boundary of the largest 4-connected blob in the mask
   * sized w*h.
   */
  private traceContour(mask: Uint8Array, w: number, h: number): { x: number; y: number }[] | null {
    // Find the largest connected component (4-connectivity).
    const labels = new Int32Array(w * h);
    let bestLabel = 0;
    let bestSize = 0;
    let nextLabel = 0;
    const queue: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || labels[idx]) continue;
        nextLabel++;
        labels[idx] = nextLabel;
        let size = 0;
        queue.push(idx);
        while (queue.length) {
          const i = queue.pop() as number;
          size++;
          const px = i % w;
          const py = (i - px) / w;
          if (px > 0)     { const j = i - 1;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
          if (px < w - 1) { const j = i + 1;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
          if (py > 0)     { const j = i - w;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
          if (py < h - 1) { const j = i + w;
            if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
        }
        if (size > bestSize) { bestSize = size; bestLabel = nextLabel; }
      }
    }
    if (bestSize === 0) return null;

    // Build a single-component mask, then trace its outer boundary using
    // Moore-neighbour following.
    const comp = new Uint8Array(w * h);
    for (let i = 0; i < comp.length; i++) comp[i] = labels[i] === bestLabel ? 1 : 0;

    return this.mooreBoundary(comp, w, h);
  }

  private mooreBoundary(mask: Uint8Array, w: number, h: number): { x: number; y: number }[] {
    // Find the first foreground pixel in raster order — guaranteed to lie
    // on the boundary.
    let startIdx = -1;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) { startIdx = i; break; }
    }
    if (startIdx < 0) return [];

    const sx = startIdx % w;
    const sy = (startIdx - sx) / w;
    const points: { x: number; y: number }[] = [{ x: sx, y: sy }];

    // Single isolated pixel — emit the pixel's four corner points so callers
    // (which require ≥ 3 vertices to build a polygon) get a valid 1×1 square
    // instead of a degenerate single-vertex contour.
    const singleton = (idx: number): boolean => {
      const x = idx % w;
      const y = (idx - x) / w;
      const at = (xx: number, yy: number) => xx >= 0 && xx < w && yy >= 0 && yy < h && mask[yy * w + xx];
      return !(at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1));
    };
    if (singleton(startIdx)) {
      return [
        { x: sx,     y: sy     },
        { x: sx + 1, y: sy     },
        { x: sx + 1, y: sy + 1 },
        { x: sx,     y: sy + 1 },
      ];
    }

    // 8-connected neighbour offsets in clockwise order starting from West.
    const dx = [-1, -1,  0,  1, 1, 1, 0, -1];
    const dy = [ 0, -1, -1, -1, 0, 1, 1,  1];

    let cx = sx, cy = sy;
    // Backtrack direction — start from West (the side we'd be coming from in raster order).
    let prevDir = 0;
    const maxSteps = w * h * 8;

    for (let step = 0; step < maxSteps; step++) {
      // Standard Moore-neighbour tracing: search clockwise starting one step
      // after the backtrack direction.
      let found = false;
      for (let k = 1; k <= 8; k++) {
        const dir = (prevDir + k) & 7;
        const nx = cx + dx[dir];
        const ny = cy + dy[dir];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (mask[ny * w + nx]) {
          // Backtrack direction is from new pixel back toward previous pixel.
          prevDir = (dir + 4) & 7;
          cx = nx;
          cy = ny;
          points.push({ x: cx, y: cy });
          found = true;
          break;
        }
      }
      if (!found) break;
      if (cx === sx && cy === sy && points.length > 1) {
        points.pop();
        break;
      }
    }

    return points;
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
