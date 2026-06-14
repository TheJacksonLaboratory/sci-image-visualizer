import * as ort from 'onnxruntime-web';

import {
  ISamSession, SamEmbedding, SamMaskResult, SamModelDef, SamPrompt,
} from '../contracts/sam.contract';
import { buildDecoderPrompt, binarizeMask, bestMaskIndex } from './sam-prompt';

/** SAM's image normalization (ImageNet-ish, per the SAM preprocessing). */
const PIXEL_MEAN = [123.675, 116.28, 103.53];
const PIXEL_STD = [58.395, 57.12, 57.375];

const MODEL_CACHE = 'sam-onnx';

/**
 * Fetch an ONNX model as an ArrayBuffer, reporting download progress (0..1) and
 * caching it in the Cache API so it isn't re-downloaded on later loads. On a
 * cache hit, progress jumps to 1. Falls back to a plain fetch if streaming or
 * the Cache API isn't available.
 */
async function fetchModel(url: string, onProgress?: (f: number) => void): Promise<ArrayBuffer> {
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
  if (cache) await cache.put(url, new Response(out.slice(), { headers: { 'content-length': String(received) } })).catch(() => undefined);
  onProgress?.(1);
  return out.buffer;
}

/**
 * onnxruntime-web implementation of {@link ISamSession} — the production SAM
 * runtime. Two ORT sessions: a heavy encoder (WebGPU preferred, WASM fallback)
 * run once per image, and a light decoder run per prompt. ORT WASM/JSEP
 * sidecars are served from `/assets/ort/` (already configured for cellpose).
 *
 * NOTE (P0): this is runtime-only and unverified until a quantized SAM ONNX
 * pair is exported + hosted (see docs/sam-segmentation-design.md). It is
 * lazy-imported by SamToolService so it never loads in unit tests or the
 * initial bundle. Implements the SAM v1 decoder I/O; SAM2/SAM3 variants differ
 * and would branch on `model.variant`.
 */
export class OnnxSamSession implements ISamSession {
  private encoder: ort.InferenceSession | null = null;
  private decoder: ort.InferenceSession | null = null;
  private model: SamModelDef | null = null;

  async loadModel(model: SamModelDef, onProgress?: (fraction: number) => void): Promise<void> {
    if (!model.encoderUrl || !model.decoderUrl) {
      throw new Error(`SAM model "${model.id}" has no ONNX URLs configured.`);
    }
    this.model = model;
    ort.env.wasm.wasmPaths = '/assets/ort/';
    // Run inference in ORT's Web Worker (proxy) so a heavy ViT-B encode never
    // blocks — and freezes — the main thread; it also keeps the busy spinner
    // animating (a blocked main thread can't repaint). WebGPU can't run in the
    // proxy worker, so use the proxied WASM EP: reliable on every machine, and
    // multi-threaded when the page is cross-origin-isolated.
    ort.env.wasm.proxy = true;
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency);
    }
    const eps: string[] = model.encoderProviders ?? ['wasm'];
    // Fetch the (heavy) encoder ourselves so we can report download progress and
    // cache it in the Cache API; the decoder is small so fetch it plainly.
    const encBuf = await fetchModel(model.encoderUrl, onProgress);
    const decBuf = await fetchModel(model.decoderUrl);
    this.encoder = await ort.InferenceSession.create(encBuf, { executionProviders: eps });
    this.decoder = await ort.InferenceSession.create(decBuf, { executionProviders: ['wasm'] });
  }

  isLoaded(): boolean {
    return !!this.encoder && !!this.decoder;
  }

  async embed(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<SamEmbedding> {
    if (!this.encoder || !this.model) throw new Error('SAM encoder not loaded.');
    const size = this.model.inputSize;
    const scale = size / Math.max(image.width, image.height);
    const input = this.preprocess(image, size, scale);
    const feeds: Record<string, ort.Tensor> = {
      [this.encoder.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]),
    };
    const out = await this.encoder.run(feeds);
    const emb = out[this.encoder.outputNames[0]];
    return {
      data: emb.data as Float32Array,
      dims: emb.dims as number[],
      scale,
      imageWidth: image.width,
      imageHeight: image.height,
    };
  }

  async decode(embedding: SamEmbedding, prompt: SamPrompt): Promise<SamMaskResult> {
    if (!this.decoder) throw new Error('SAM decoder not loaded.');
    const { pointCoords, pointLabels, numPoints } = buildDecoderPrompt(prompt, embedding.scale);
    const feeds: Record<string, ort.Tensor> = {
      image_embeddings: new ort.Tensor('float32', embedding.data, embedding.dims),
      point_coords: new ort.Tensor('float32', pointCoords, [1, numPoints, 2]),
      point_labels: new ort.Tensor('float32', pointLabels, [1, numPoints]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
      orig_im_size: new ort.Tensor('float32', Float32Array.from([embedding.imageHeight, embedding.imageWidth]), [2]),
    };
    const out = await this.decoder.run(feeds);
    const masks = out['masks'] ?? out[this.decoder.outputNames[0]];
    const iou = (out['iou_predictions']?.data as Float32Array) ?? Float32Array.from([1]);
    const [, m, h, w] = masks.dims as number[];
    const idx = bestMaskIndex(iou.slice(0, m));
    const logits = (masks.data as Float32Array).subarray(idx * h * w, (idx + 1) * h * w);
    return { mask: binarizeMask(logits), width: w, height: h, iou: iou[idx] ?? 1 };
  }

  dispose(): void {
    this.encoder?.release?.();
    this.decoder?.release?.();
    this.encoder = this.decoder = null;
  }

  /** Resize (long side → size, bilinear), pad to size×size, normalize → CHW float32. */
  private preprocess(
    image: { data: Uint8ClampedArray; width: number; height: number }, size: number, scale: number,
  ): Float32Array {
    const newW = Math.round(image.width * scale);
    const newH = Math.round(image.height * scale);
    const chw = new Float32Array(3 * size * size); // zero-padded
    for (let y = 0; y < newH; y++) {
      const sy = Math.min(image.height - 1, y / scale);
      const y0 = Math.floor(sy);
      const fy = sy - y0;
      const y1 = Math.min(image.height - 1, y0 + 1);
      for (let x = 0; x < newW; x++) {
        const sx = Math.min(image.width - 1, x / scale);
        const x0 = Math.floor(sx);
        const fx = sx - x0;
        const x1 = Math.min(image.width - 1, x0 + 1);
        for (let c = 0; c < 3; c++) {
          const p00 = image.data[(y0 * image.width + x0) * 4 + c];
          const p01 = image.data[(y0 * image.width + x1) * 4 + c];
          const p10 = image.data[(y1 * image.width + x0) * 4 + c];
          const p11 = image.data[(y1 * image.width + x1) * 4 + c];
          const top = p00 + (p01 - p00) * fx;
          const bot = p10 + (p11 - p10) * fx;
          const v = top + (bot - top) * fy;
          chw[c * size * size + y * size + x] = (v - PIXEL_MEAN[c]) / PIXEL_STD[c];
        }
      }
    }
    return chw;
  }
}
