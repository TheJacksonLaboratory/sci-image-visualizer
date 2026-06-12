import { SamModelDef } from '../contracts/sam.contract';

/**
 * Registry of promptable SAM models for the browser segment tool.
 *
 * micro-sam (microscopy-finetuned, promptable) is the first entry; SAM3 and
 * pathoSAM slot in here as their quantized ONNX exports are published. The
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
    label: 'micro-sam ViT-T (light microscopy)',
    encoderUrl: '',
    decoderUrl: '',
    variant: 'sam1',
    inputSize: 1024,
    microscopy: true,
  },
  {
    id: 'microsam-vit-b-lm',
    label: 'micro-sam ViT-B (light microscopy)',
    encoderUrl: '',
    decoderUrl: '',
    variant: 'sam1',
    inputSize: 1024,
    microscopy: true,
  },
];

/** Default model the tool uses until the host picks another. */
export const DEFAULT_SAM_MODEL_ID = SAM_MODELS[0].id;

/** Look up a model by id; falls back to the default when id is unknown/absent. */
export function getSamModel(id?: string): SamModelDef {
  return SAM_MODELS.find((m) => m.id === id) ?? SAM_MODELS[0];
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
  }
}
