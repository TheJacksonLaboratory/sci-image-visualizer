import { SamModelDef } from '../contracts/sam.contract';

/**
 * Registry of promptable SAM models for the browser segment tool.
 *
 * micro-sam (microscopy-finetuned, promptable) and patho-sam (histopathology-
 * finetuned) are entries; SAM3 slots in here once its quantized ONNX export and
 * a `variant: 'sam3'` decoder path are published. The
 * automatic cellpose-SAM model is intentionally NOT here — it's not promptable
 * and lives in the processing-pipeline's cellpose engine as the automatic tool.
 *
 * `encoderUrl` / `decoderUrl` are empty until the ONNX pair is exported,
 * quantized and hosted (see docs/sam-segmentation-design.md). The session
 * throws a clear "model not configured yet" error when a URL is empty, so the
 * tool is fully wired and testable ahead of model availability. Override the
 * URLs at runtime via {@link setSamModelUrls} once hosting is decided.
 */
export const SAM_MODELS: SamModelDef[] = [
  {
    id: 'microsam-vit-t-lm',
    label: 'micro-sam ViT-T',
    encoderUrl: '',
    decoderUrl: '',
    variant: 'sam1',
    inputSize: 1024,
    microscopy: true,
    // TinyViT's fp16 attention overflows on the onnxruntime-web WebGPU EP and
    // returns an empty mask ("No masks found"); it's numerically correct on
    // WASM, and the encoder is tiny (~14 MB) so WASM is plenty fast.
    encoderProviders: ['wasm'],
  },
  {
    id: 'microsam-vit-b-lm',
    label: 'micro-sam ViT-B',
    encoderUrl: '',
    decoderUrl: '',
    variant: 'sam1',
    inputSize: 1024,
    microscopy: true,
  },
  {
    id: 'patho-sam-vit-b',
    label: 'patho-sam ViT-B',
    encoderUrl: '',
    decoderUrl: '',
    variant: 'sam1',
    inputSize: 1024,
    microscopy: true,
  },
  {
    id: 'patho-sam-vit-b-int8',
    label: 'patho-sam ViT-B (int8)',
    encoderUrl: '',
    decoderUrl: '',
    variant: 'sam1',
    inputSize: 1024,
    microscopy: true,
    // int8 dynamic-quantized encoder (~100 MB vs ~180 MB fp16, IoU ~0.99 on the
    // sanity test). onnxruntime-web's WebGPU EP doesn't support int8 matmul, so
    // it runs on WASM — smaller download, slower encode than the fp16 entry.
    encoderProviders: ['wasm'],
  },
];

/** Initial default model id (overridden at runtime once the host configures a
 *  hosted model via {@link setSamModelUrls}). */
export const DEFAULT_SAM_MODEL_ID = SAM_MODELS[0].id;

/** The active default — updated when the host configures a model's ONNX URLs,
 *  so the tool uses the model that's actually hosted (not just the first entry). */
let activeDefaultId = DEFAULT_SAM_MODEL_ID;

/** Look up a model by id; falls back to the active default when id is
 *  unknown/absent. */
export function getSamModel(id?: string): SamModelDef {
  const wanted = id ?? activeDefaultId;
  return SAM_MODELS.find((m) => m.id === wanted) ?? SAM_MODELS[0];
}

/** The active default model id (what the tools/picker use when unset). */
export function getDefaultSamModelId(): string {
  return activeDefaultId;
}

/** Set the active default model id (must be a registered model). */
export function setDefaultSamModel(id: string): void {
  if (SAM_MODELS.some((m) => m.id === id)) activeDefaultId = id;
}

/** True when a model has both ONNX URLs configured (i.e. it can actually run). */
export function isSamModelReady(model: SamModelDef): boolean {
  return !!model.encoderUrl && !!model.decoderUrl;
}

/**
 * Point a registered model at its hosted ONNX pair (HF / GCS). Called by the
 * host's composition root once hosting is decided, keeping deployment URLs out
 * of the library.
 */
export function setSamModelUrls(id: string, encoderUrl: string, decoderUrl: string): void {
  const m = SAM_MODELS.find((x) => x.id === id);
  if (m) {
    m.encoderUrl = encoderUrl;
    m.decoderUrl = decoderUrl;
    // The configured (hosted) model becomes the active default, so the tools
    // use it rather than the first registry entry (which may be unhosted).
    if (encoderUrl && decoderUrl) activeDefaultId = id;
  }
}
