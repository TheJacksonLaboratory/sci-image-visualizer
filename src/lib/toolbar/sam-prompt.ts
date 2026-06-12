import { CachedImageData } from './wand-tool.service';
import { SamPrompt } from '../contracts/sam.contract';

/**
 * Pure helpers for SAM inference — no DOM, no ORT, no `this` — so they're unit
 * testable. The session uses these to assemble decoder inputs and to convert
 * the cached image frame into the RGBA buffer the encoder preprocesses.
 */

/**
 * Build an RGBA buffer (the encoder's input image) from a cached image frame.
 * Grayscale frames are replicated across R/G/B; RGB tuples are copied through.
 * Out-of-range/missing pixels become opaque black.
 */
export function frameToRgba(cached: CachedImageData, frameIndex: number): Uint8ClampedArray {
  const { width, height } = cached;
  const frame = cached.frames[frameIndex] ?? cached.frames[0];
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = frame?.[y];
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const px = row?.[x];
      if (px == null) {
        rgba[o + 3] = 255;
        continue;
      }
      if (cached.isGrayscale) {
        const v = px as number;
        rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v;
      } else {
        const t = px as number[];
        rgba[o] = t[0]; rgba[o + 1] = t[1]; rgba[o + 2] = t[2];
      }
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Assemble the SAM decoder's `point_coords` / `point_labels` from a prompt.
 *
 * Coordinates are scaled into the encoder's resized space (`scale =
 * inputSize / max(imageW, imageH)`). A box is encoded as two points labelled
 * `2` (top-left) and `3` (bottom-right); positive/negative points use `1`/`0`.
 * When there are points but no box, a padding point `[0,0]` labelled `-1` is
 * appended (the decoder expects the box slots padded when absent).
 */
export function buildDecoderPrompt(
  prompt: SamPrompt,
  scale: number,
): { pointCoords: Float32Array; pointLabels: Float32Array; numPoints: number } {
  const coords: number[] = [];
  const labels: number[] = [];

  for (const p of prompt.points ?? []) {
    coords.push(p.x * scale, p.y * scale);
    labels.push(p.label);
  }

  if (prompt.box) {
    const b = prompt.box;
    coords.push(b.x0 * scale, b.y0 * scale);
    labels.push(2);
    coords.push(b.x1 * scale, b.y1 * scale);
    labels.push(3);
  } else if (labels.length > 0) {
    // Points-only: pad the (absent) box slot.
    coords.push(0, 0);
    labels.push(-1);
  }

  return {
    pointCoords: Float32Array.from(coords),
    pointLabels: Float32Array.from(labels),
    numPoints: labels.length,
  };
}

/**
 * Binarize SAM mask logits (`> threshold`, default 0 per SAM's mask_threshold)
 * into a 0/1 mask the contour tracer (WandService.maskToPolygons) consumes.
 */
export function binarizeMask(logits: Float32Array | number[], threshold = 0): Uint8Array {
  const out = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = logits[i] > threshold ? 1 : 0;
  return out;
}

/** Index of the highest-scoring mask in a multimask decoder output. */
export function bestMaskIndex(iouPredictions: Float32Array | number[]): number {
  let best = 0;
  for (let i = 1; i < iouPredictions.length; i++) {
    if (iouPredictions[i] > iouPredictions[best]) best = i;
  }
  return best;
}
