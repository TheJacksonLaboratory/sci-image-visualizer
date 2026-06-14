import {
  ISamSession, SamEmbedding, SamMaskResult, SamModelDef, SamPrompt,
} from '../contracts/sam.contract';

/**
 * onnxruntime-web implementation of {@link ISamSession} — the production SAM
 * runtime (jit-ui#90). All inference runs in a dedicated Web Worker
 * ({@link ./onnx-sam.worker}) with WebGPU preferred and a WASM fallback, so a
 * heavy ViT-B encode never blocks (freezes) the main thread and the busy
 * spinner keeps animating. This class is a thin main-thread proxy: it owns the
 * worker, correlates request/response messages by id, and reports download
 * progress. The encoder embedding stays inside the worker (keyed by a token on
 * the returned {@link SamEmbedding}); `decode` ships only the small prompt and
 * receives back a binary mask, avoiding multi-MB round-trips per prompt.
 *
 * Lazy-imported by SamToolService / SamPointToolService so onnxruntime-web and
 * the worker are never pulled into unit tests or the initial bundle.
 */
type Pending = {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  onProgress?: (fraction: number) => void;
};

export class OnnxSamSession implements ISamSession {
  private worker: Worker | null = null;
  private loaded = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private model: SamModelDef | null = null;

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

  /** Post a request to the worker and resolve with its matching response. */
  private call(msg: any, transfer: Transferable[] = [], onProgress?: (f: number) => void): Promise<any> {
    const id = ++this.seq;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async loadModel(model: SamModelDef, onProgress?: (fraction: number) => void): Promise<void> {
    if (!model.encoderUrl || !model.decoderUrl) {
      throw new Error(`SAM model "${model.id}" has no ONNX URLs configured.`);
    }
    this.model = model;
    await this.call({
      type: 'load',
      encoderUrl: model.encoderUrl,
      decoderUrl: model.decoderUrl,
      wasmPaths: '/assets/ort/',
      inputSize: model.inputSize,
      encoderProviders: model.encoderProviders,
    }, [], onProgress);
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async embed(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<SamEmbedding> {
    // Transfer the RGBA buffer to the worker (callers pass a fresh frame buffer,
    // so handing off ownership is safe and avoids a copy).
    const buffer = image.data.buffer;
    const res = await this.call(
      { type: 'embed', width: image.width, height: image.height, buffer },
      [buffer],
    );
    // The real embedding lives in the worker (referenced by `token`); the main
    // thread only needs the scale/size + token to drive decode.
    return {
      data: new Float32Array(0),
      dims: res.dims,
      scale: res.scale,
      imageWidth: res.imageWidth,
      imageHeight: res.imageHeight,
      token: res.token,
    };
  }

  async decode(embedding: SamEmbedding, prompt: SamPrompt): Promise<SamMaskResult> {
    const res = await this.call({ type: 'decode', token: embedding.token, prompt });
    return { mask: new Uint8Array(res.buffer), width: res.width, height: res.height, iou: res.iou };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = false;
    this.pending.clear();
  }
}
