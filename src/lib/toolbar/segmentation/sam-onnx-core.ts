import * as ort from 'onnxruntime-web';

import type { SamPrompt } from '../../contracts/sam.contract';

/**
 * Shared, DOM-free SAM inference primitives used by BOTH inference backends:
 * the in-process session (`OnnxSamSession`, main thread) and the dedicated
 * Web Worker (`onnx-sam.worker`). Keeping these here avoids duplicating the
 * preprocessing / decoder-prompt math and keeps the worker DOM-free (it can't
 * import sam-prompt.ts, which pulls in DOM types).
 */

export const PIXEL_MEAN = [123.675, 116.28, 103.53];
export const PIXEL_STD = [58.395, 57.12, 57.375];
const MODEL_CACHE = 'sam-onnx';

/** Encoder output for one image, reused across prompts. */
export interface CoreEmbedding {
  data: Float32Array;
  dims: number[];
  scale: number;
  imageWidth: number;
  imageHeight: number;
}

/** Decoder output: a binary mask at original-image resolution. */
export interface CoreMask {
  mask: Uint8Array;
  width: number;
  height: number;
  iou: number;
}

/** Fetch a model as an ArrayBuffer, streaming progress and caching in the Cache
 *  API (so it isn't re-downloaded). Cache hit → progress jumps to 1. Works on
 *  the main thread and in a worker (both have `fetch` + `caches`). */
export async function fetchModel(url: string, onProgress?: (f: number) => void): Promise<ArrayBuffer> {
  const cache = typeof caches !== 'undefined' ? await caches.open(MODEL_CACHE).catch(() => null) : null;
  const hit = cache ? await cache.match(url) : null;
  if (hit) { onProgress?.(1); return await hit.arrayBuffer(); }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} failed: HTTP ${resp.status}`);
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body || !total) {
    const buf = await resp.arrayBuffer();
    onProgress?.(1);
    if (cache) await cache.put(url, new Response(buf)).catch(() => undefined);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received / total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  if (cache) {
    await cache.put(url, new Response(out.slice(), { headers: { 'content-length': String(received) } }))
      .catch(() => undefined);
  }
  onProgress?.(1);
  return out.buffer;
}

/** Resize (long side → size, bilinear), pad to size×size, SAM-normalize → CHW float32. */
export function preprocess(
  data: Uint8ClampedArray, width: number, height: number, size: number, scale: number,
): Float32Array {
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  const chw = new Float32Array(3 * size * size); // zero-padded
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(height - 1, y / scale);
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const y1 = Math.min(height - 1, y0 + 1);
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(width - 1, x / scale);
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const x1 = Math.min(width - 1, x0 + 1);
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * width + x0) * 4 + c];
        const p01 = data[(y0 * width + x1) * 4 + c];
        const p10 = data[(y1 * width + x0) * 4 + c];
        const p11 = data[(y1 * width + x1) * 4 + c];
        const top = p00 + (p01 - p00) * fx;
        const bot = p10 + (p11 - p10) * fx;
        const v = top + (bot - top) * fy;
        chw[c * size * size + y * size + x] = (v - PIXEL_MEAN[c]) / PIXEL_STD[c];
      }
    }
  }
  return chw;
}

/** Assemble decoder `point_coords`/`point_labels` from a prompt, in encoder
 *  (resized) space. Box = two points labelled 2/3; points use 1/0; a points-only
 *  prompt pads the absent box slot with `[0,0]` labelled -1. */
export function buildDecoderPrompt(
  prompt: SamPrompt, scale: number,
): { pointCoords: Float32Array; pointLabels: Float32Array; numPoints: number } {
  const coords: number[] = [];
  const labels: number[] = [];
  for (const p of prompt.points ?? []) { coords.push(p.x * scale, p.y * scale); labels.push(p.label); }
  if (prompt.box) {
    const b = prompt.box;
    coords.push(b.x0 * scale, b.y0 * scale); labels.push(2);
    coords.push(b.x1 * scale, b.y1 * scale); labels.push(3);
  } else if (labels.length > 0) {
    coords.push(0, 0); labels.push(-1);
  }
  return {
    pointCoords: Float32Array.from(coords),
    pointLabels: Float32Array.from(labels),
    numPoints: labels.length,
  };
}

/** Binarize mask logits (`> threshold`) into a 0/1 mask. */
export function binarizeMask(logits: Float32Array, threshold = 0): Uint8Array {
  const out = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = logits[i] > threshold ? 1 : 0;
  return out;
}

/** Index of the highest-scoring mask in a multimask decoder output. */
export function bestMaskIndex(iou: Float32Array | number[]): number {
  let best = 0;
  for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
  return best;
}

/** Run the encoder on an RGBA image → a reusable embedding. */
export async function runEncoder(
  encoder: ort.InferenceSession, data: Uint8ClampedArray, width: number, height: number, inputSize: number,
): Promise<CoreEmbedding> {
  const scale = inputSize / Math.max(width, height);
  const input = preprocess(data, width, height, inputSize, scale);
  const out = await encoder.run({
    [encoder.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, inputSize, inputSize]),
  });
  const emb = out[encoder.outputNames[0]];
  return {
    data: emb.data as Float32Array, dims: emb.dims as number[],
    scale, imageWidth: width, imageHeight: height,
  };
}

/** Run the decoder for one prompt against a cached embedding → a binary mask. */
export async function runDecoder(
  decoder: ort.InferenceSession, e: CoreEmbedding, prompt: SamPrompt,
): Promise<CoreMask> {
  const { pointCoords, pointLabels, numPoints } = buildDecoderPrompt(prompt, e.scale);
  const out = await decoder.run({
    image_embeddings: new ort.Tensor('float32', e.data, e.dims),
    point_coords: new ort.Tensor('float32', pointCoords, [1, numPoints, 2]),
    point_labels: new ort.Tensor('float32', pointLabels, [1, numPoints]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([e.imageHeight, e.imageWidth]), [2]),
  });
  const masks = out['masks'] ?? out[decoder.outputNames[0]];
  const iou = (out['iou_predictions']?.data as Float32Array) ?? Float32Array.from([1]);
  const [, m, h, w] = masks.dims as number[];
  const idx = bestMaskIndex(iou.slice(0, m));
  const logits = (masks.data as Float32Array).subarray(idx * h * w, (idx + 1) * h * w);
  return { mask: binarizeMask(logits), width: w, height: h, iou: iou[idx] ?? 1 };
}
