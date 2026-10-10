import * as ort from 'onnxruntime-web';

import { ISamSession, SamEmbedding, SamMaskResult, SamModelDef, SamPrompt } from '../../contracts/sam.contract';
import { fetchModel, runEncoder, runDecoder, type CoreEmbedding } from './sam-onnx-core';
import { getOrtWasmBase } from './ort-runtime-config';
import { PendingCalls, WorkerReply } from './pending-calls';

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
export class OnnxSamSession implements ISamSession {
  private mode: 'inproc' | 'worker' | null = null;
  private loaded = false;
  private inputSize = 1024;

  // ── worker mode ──
  private worker: Worker | null = null;
  private readonly calls = new PendingCalls();

  // ── in-process mode ──
  private encoder: ort.InferenceSession | null = null;
  private decoder: ort.InferenceSession | null = null;
  private nextToken = 1;
  private readonly embeddings = new Map<number, CoreEmbedding>();

  async loadModel(model: SamModelDef, onProgress?: (fraction: number) => void): Promise<void> {
    if (!model.encoderUrl || !model.decoderUrl) {
      throw new Error(`SAM model "${model.id}" has no ONNX URLs configured.`);
    }
    this.inputSize = model.inputSize;
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const eps: string[] = model.encoderProviders ?? (hasGpu ? ['webgpu', 'wasm'] : ['wasm']);
    const usesWebGpu = eps.includes('webgpu');
    // WebGPU must run in the worker (else it freezes the main thread); small
    // WASM models opt into the faster in-process path via `inProcess`.
    this.mode = !usesWebGpu && model.inProcess ? 'inproc' : 'worker';

    if (this.mode === 'inproc') {
      ort.env.wasm.wasmPaths = getOrtWasmBase();
      const encBuf = await fetchModel(model.encoderUrl, onProgress, model.revision);
      const decBuf = await fetchModel(model.decoderUrl, undefined, model.revision);
      this.encoder = await ort.InferenceSession.create(encBuf, { executionProviders: eps });
      this.decoder = await ort.InferenceSession.create(decBuf, { executionProviders: ['wasm'] });
    } else {
      await this.call(
        {
          type: 'load',
          encoderUrl: model.encoderUrl,
          decoderUrl: model.decoderUrl,
          revision: model.revision,
          wasmPaths: getOrtWasmBase(),
          inputSize: model.inputSize,
          encoderProviders: model.encoderProviders,
        },
        [],
        onProgress,
      );
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
        data: new Float32Array(0),
        dims: e.dims,
        scale: e.scale,
        imageWidth: e.imageWidth,
        imageHeight: e.imageHeight,
        token,
      };
    }
    // worker: transfer the RGBA buffer (callers pass a fresh frame buffer).
    const buffer = image.data.buffer;
    const res = await this.call({ type: 'embed', width: image.width, height: image.height, buffer }, [buffer]);
    return {
      data: new Float32Array(0),
      dims: res['dims'] as number[],
      scale: res['scale'] as number,
      imageWidth: res['imageWidth'] as number,
      imageHeight: res['imageHeight'] as number,
      token: res['token'] as number,
    };
  }

  async decode(embedding: SamEmbedding, prompt: SamPrompt): Promise<SamMaskResult> {
    if (this.mode === 'inproc') {
      const e = this.embeddings.get(embedding.token as number);
      if (!e) throw new Error('SAM embedding expired; re-encode the image.');
      return runDecoder(this.decoder!, e, prompt);
    }
    const res = await this.call({ type: 'decode', token: embedding.token, prompt });
    return {
      mask: new Uint8Array(res['buffer'] as ArrayBuffer),
      width: res['width'] as number,
      height: res['height'] as number,
      iou: res['iou'] as number,
    };
  }

  /** Release the worker / ORT sessions. Calls still in flight reject (RT-8), so
   *  their callers' `finally` blocks run (e.g. a tool's busy flag clears). */
  dispose(): void {
    this.dropWorker(new Error('SAM session disposed'));
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
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => this.calls.handle(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      // A crashed worker can't serve the loaded model any more: drop it, so the
      // next run reloads instead of posting to a dead worker.
      this.dropWorker(new Error(ev.message || 'SAM worker crashed.'));
      this.loaded = false;
      this.mode = null;
    };
    this.worker = worker;
    return worker;
  }

  /** Terminate the worker (if any) and reject every call still waiting on it. */
  private dropWorker(err: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.calls.rejectAll(err);
  }

  private call(
    msg: Record<string, unknown>,
    transfer: Transferable[] = [],
    onProgress?: (f: number) => void,
  ): Promise<WorkerReply> {
    const worker = this.ensureWorker();
    const { id, promise } = this.calls.open(onProgress);
    worker.postMessage({ ...msg, id }, transfer);
    return promise;
  }
}
