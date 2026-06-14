/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';

import { fetchModel, runEncoder, runDecoder, type CoreEmbedding } from './sam-onnx-core';

/**
 * Dedicated SAM inference Web Worker (jit-ui#90).
 *
 * Runs the promptable-SAM encoder/decoder ONNX pair OFF the main thread so a
 * heavy WebGPU ViT-B encode never freezes the tab and the busy spinner keeps
 * animating. Small WASM models (e.g. micro-sam ViT-T) run in-process instead —
 * the worker's startup/round-trip overhead isn't worth it for them; this worker
 * is reserved for the heavy WebGPU models. Shares its inference math with the
 * in-process path via sam-onnx-core.
 *
 * Protocol (request `{id, type, …}` → `{id, type, …}`): load → progress* →
 * loaded | error; embed → embedded (caches under a token) | error; decode →
 * decoded (uses the cached embedding) | error.
 */

let encoder: ort.InferenceSession | null = null;
let decoder: ort.InferenceSession | null = null;
let inputSize = 1024;
let nextToken = 1;
const embeddings = new Map<number, CoreEmbedding>();

function post(msg: any, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

async function onLoad(msg: any): Promise<void> {
  ort.env.wasm.wasmPaths = msg.wasmPaths;
  inputSize = msg.inputSize || 1024;
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const eps: string[] = (msg.encoderProviders && msg.encoderProviders.length)
    ? msg.encoderProviders
    : (hasGpu ? ['webgpu', 'wasm'] : ['wasm']);
  const encBuf = await fetchModel(msg.encoderUrl, (f) => post({ id: msg.id, type: 'progress', fraction: f }));
  const decBuf = await fetchModel(msg.decoderUrl);
  encoder = await ort.InferenceSession.create(encBuf, { executionProviders: eps });
  decoder = await ort.InferenceSession.create(decBuf, { executionProviders: ['wasm'] });
  post({ id: msg.id, type: 'loaded' });
}

async function onEmbed(msg: any): Promise<void> {
  if (!encoder) throw new Error('SAM encoder not loaded.');
  const data = new Uint8ClampedArray(msg.buffer as ArrayBuffer);
  const e = await runEncoder(encoder, data, msg.width, msg.height, inputSize);
  const token = nextToken++;
  embeddings.set(token, e);
  // Keep only the few most-recent embeddings (one per recently-viewed image).
  if (embeddings.size > 3) embeddings.delete(embeddings.keys().next().value as number);
  post({ id: msg.id, type: 'embedded', token, scale: e.scale, imageWidth: e.imageWidth, imageHeight: e.imageHeight, dims: e.dims });
}

async function onDecode(msg: any): Promise<void> {
  if (!decoder) throw new Error('SAM decoder not loaded.');
  const e = embeddings.get(msg.token);
  if (!e) throw new Error('SAM embedding expired; re-encode the image.');
  const r = await runDecoder(decoder, e, msg.prompt);
  post(
    { id: msg.id, type: 'decoded', width: r.width, height: r.height, iou: r.iou, buffer: r.mask.buffer },
    [r.mask.buffer],
  );
}

self.onmessage = async (ev: MessageEvent): Promise<void> => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') await onLoad(msg);
    else if (msg.type === 'embed') await onEmbed(msg);
    else if (msg.type === 'decode') await onDecode(msg);
  } catch (err) {
    post({ id: msg.id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
