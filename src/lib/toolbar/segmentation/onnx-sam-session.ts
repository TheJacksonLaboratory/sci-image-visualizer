import * as ort from 'onnxruntime-web';

import {
  ISamSession, SamEmbedding, SamMaskResult, SamModelDef, SamPrompt,
} from '../../contracts/sam.contract';
import { fetchModel, runEncoder, runDecoder, type CoreEmbedding } from './sam-onnx-core';
import { getOrtWasmBase } from './ort-runtime-config';

/**
 * onnxruntime-web implementation of {@link ISamSession} (jit-ui#90), with two
 * execution modes chosen per model:
 *
 *  - **in-process** (main thread) — for small WASM models flagged `inProcess`
 *    (e.g. micro-sam ViT-T). Fast load + inference with no Web Worker spawn /
 *    second ORT runtime / message round-trips; the brief encode runs on the main
 *    thread (fine for a tiny model).
 *  - **worker** — for WebGPU models (e.g. ViT-B, patho-sam fp16) whose heavy
 *    encode would otherwise freeze the tab. Runs in {@link ./onnx-sam.worker} so
 *    the UI stays responsive (the spinner animates).
 *
 * Both modes share their inference math via {@link ./sam-onnx-core}. Lazy-imported
 * by the SAM tools so onnxruntime-web / the worker never load in unit tests or
 * the initial bundle.
 */
type Pending = {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  onProgress?: (fraction: number) => void;
};

export class OnnxSamSession implements ISamSession {
  private mode: 'inproc' | 'worker' | null = null;
  private loaded = false;
  private model: SamModelDef | null = null;
  private inputSize = 1024;

  // ── worker mode ──
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  // ── in-process mode ──
  private encoder: ort.InferenceSession | null = null;
  private decoder: ort.InferenceSession | null = null;
  private nextToken = 1;
  private readonly embeddings = new Map<number, CoreEmbedding>();

  async loadModel(model: SamModelDef, onProgress?: (fraction: number) => void): Promise<void> {
    if (!model.encoderUrl || !model.decoderUrl) {
      throw new Error(`SAM model "${model.id}" has no ONNX URLs configured.`);
    }
    this.model = model;
    this.inputSize = model.inputSize;
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const eps: string[] = model.encoderProviders ?? (hasGpu ? ['webgpu', 'wasm'] : ['wasm']);
    const usesWebGpu = eps.includes('webgpu');
    // WebGPU must run in the worker (else it freezes the main thread); small
    // WASM models opt into the faster in-process path via `inProcess`.
    this.mode = !usesWebGpu && model.inProcess ? 'inproc' : 'worker';

    if (this.mode === 'inproc') {
      ort.env.wasm.wasmPaths = getOrtWasmBase();
      const encBuf = await fetchModel(model.encoderUrl, onProgress);
      const decBuf = await fetchModel(model.decoderUrl);
      this.encoder = await ort.InferenceSession.create(encBuf, { executionProviders: eps });
      this.decoder = await ort.InferenceSession.create(decBuf, { executionProviders: ['wasm'] });
    } else {
      await this.call({
        type: 'load',
        encoderUrl: model.encoderUrl,
        decoderUrl: model.decoderUrl,
        wasmPaths: getOrtWasmBase(),
        inputSize: model.inputSize,
        encoderProviders: model.encoderProviders,
      }, [], onProgress);
    }
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async embed(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<SamEmbedding> {
    if (this.mode === 'inproc') {
      const e = await runEncoder(this.encoder!, image.data, image.width, image.height, this.inputSize);
      const token = this.nextToken++;
      this.embeddings.set(token, e);
      if (this.embeddings.size > 3) this.embeddings.delete(this.embeddings.keys().next().value as number);
      return {
        data: new Float32Array(0), dims: e.dims, scale: e.scale,
        imageWidth: e.imageWidth, imageHeight: e.imageHeight, token,
      };
    }
    // worker: transfer the RGBA buffer (callers pass a fresh frame buffer).
    const buffer = image.data.buffer;
    const res = await this.call({ type: 'embed', width: image.width, height: image.height, buffer }, [buffer]);
    return {
      data: new Float32Array(0), dims: res.dims, scale: res.scale,
      imageWidth: res.imageWidth, imageHeight: res.imageHeight, token: res.token,
    };
  }

  async decode(embedding: SamEmbedding, prompt: SamPrompt): Promise<SamMaskResult> {
    if (this.mode === 'inproc') {
      const e = this.embeddings.get(embedding.token as number);
      if (!e) throw new Error('SAM embedding expired; re-encode the image.');
      return runDecoder(this.decoder!, e, prompt);
    }
    const res = await this.call({ type: 'decode', token: embedding.token, prompt });
    return { mask: new Uint8Array(res.buffer), width: res.width, height: res.height, iou: res.iou };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.encoder?.release?.();
    this.decoder?.release?.();
    this.encoder = this.decoder = null;
    this.embeddings.clear();
    this.loaded = false;
    this.mode = null;
  }

  // ── worker plumbing ──────────────────────────────────────────────────────
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./onnx-sam.worker', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { p.onProgress?.(m.fraction); return; }
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.error));
      else p.resolve(m);
    };
    worker.onerror = (ev: ErrorEvent) => {
      const err = new Error(ev.message || 'SAM worker crashed.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private call(msg: any, transfer: Transferable[] = [], onProgress?: (f: number) => void): Promise<any> {
    const id = ++this.seq;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }
}
