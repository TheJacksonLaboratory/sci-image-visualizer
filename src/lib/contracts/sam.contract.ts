/**
 * Contracts for the client-side, promptable Segment Anything (SAM) tooling
 * (jit-ui#90). A SAM model is a promptable encoder/decoder ONNX pair: the heavy
 * encoder runs once per image (its embedding is cached), and the light decoder
 * runs per prompt (box/points) to produce a mask.
 *
 * The inference backend is abstracted behind {@link ISamSession} so the tool
 * (SamToolService) is testable with a fake and so different runtimes (an
 * onnxruntime-web session today, a worker-backed one later) can be swapped in.
 */

/** A promptable SAM model: a quantized encoder + decoder ONNX pair. */
export interface SamModelDef {
  /** Stable id used by the registry (e.g. 'microsam-vit-b-lm'). */
  id: string;
  /** Human label for a model picker. */
  label: string;
  /** Encoder ONNX URL (image → image embedding). Empty until hosted. */
  encoderUrl: string;
  /** Decoder ONNX URL (embedding + prompts → mask). Empty until hosted. */
  decoderUrl: string;
  /** Decoder I/O family — SAM v1 vs v2/v3 differ in mask output size + names. */
  variant: 'sam1' | 'sam2' | 'sam3';
  /** Encoder input side length (1024 for SAM v1). */
  inputSize: number;
  /** True for microscopy-finetuned checkpoints (micro-sam, pathoSAM). */
  microscopy?: boolean;
  /** Override the onnxruntime-web execution providers for the ENCODER session
   *  (decoder is always WASM). Defaults to WebGPU-with-WASM-fallback. Set to
   *  `['wasm']` for architectures whose fp16 attention overflows on the WebGPU
   *  EP and returns an empty mask (e.g. micro-sam ViT-T's TinyViT encoder),
   *  which run correctly — and fast, when small — on WASM. */
  encoderProviders?: string[];
}

/** Cached encoder output for one image (reused across every prompt on it). */
export interface SamEmbedding {
  /** Flattened embedding tensor, shape `dims`. */
  data: Float32Array;
  /** Embedding tensor dims, e.g. [1, 256, 64, 64]. */
  dims: number[];
  /** `inputSize / max(imageWidth, imageHeight)` — scales prompt coords. */
  scale: number;
  /** Image (matrix) size the embedding was computed for. */
  imageWidth: number;
  imageHeight: number;
  /** Opaque handle to the embedding cached inside the inference Web Worker, when
   *  the session runs off-thread. `decode` passes it back so the worker reuses
   *  the cached tensor instead of round-tripping the (multi-MB) embedding data;
   *  `data` is then an empty placeholder. Absent for in-process/fake sessions. */
  token?: number;
}

/** A prompt for one object, in image (matrix) pixel coordinates. */
export interface SamPrompt {
  /** Box prompt `[x0,y0,x1,y1]` (issue #90's primary affordance). */
  box?: { x0: number; y0: number; x1: number; y1: number };
  /** Point prompts; `label` 1 = positive (include), 0 = negative (exclude). */
  points?: { x: number; y: number; label: 0 | 1 }[];
}

/** A decoded mask, binary (0/1), at image (matrix) resolution. */
export interface SamMaskResult {
  mask: Uint8Array;
  width: number;
  height: number;
  /** Model-predicted IoU quality score for the chosen mask. */
  iou: number;
}

/**
 * Promptable-SAM inference backend. Lifecycle: `loadModel` once, `embed` once
 * per image, `decode` per prompt.
 */
export interface ISamSession {
  /** Load the model; `onProgress` reports encoder-download fraction (0..1). */
  loadModel(model: SamModelDef, onProgress?: (fraction: number) => void): Promise<void>;
  isLoaded(): boolean;
  /** Run the encoder on an RGBA image; returns a cacheable embedding. */
  embed(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<SamEmbedding>;
  /** Run the decoder for one prompt against a cached embedding. */
  decode(embedding: SamEmbedding, prompt: SamPrompt): Promise<SamMaskResult>;
  dispose(): void;
}
