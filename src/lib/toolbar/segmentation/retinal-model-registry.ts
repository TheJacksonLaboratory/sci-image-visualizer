/**
 * Registry of retinal-layer semantic-segmentation models.
 *
 * Mirrors {@link YOLO_MODELS}: public HF-hosted ONNX by default, repointable at
 * private hosting via {@link setRetinalModelUrls}.
 *
 * THE mIoU COLUMN IS NOT THE GATE, AND IT IS NOT HELD-OUT
 * Every figure below is scored against `retinal_layer_train_images/` — the
 * models' own TRAINING data, because the bucket ships no validation split. So
 * VNet's 0.906 is an optimistic ceiling and the ResUNet-a numbers are worse
 * than they look, since a model should do well on what it saw.
 *
 * | checkpoint | mIoU (train-set) | ONNX vs Keras |
 * |---|---|---|
 * | **VNet 2D** | **0.9061** | 100.0000% argmax |
 * | ResUNet-a 2D 40x | 0.40 | 100.0000% argmax |
 * | ResUNet-a 2D 20x | 0.30 | 100.0000% argmax |
 * | ResUNet-a 2D (base) | 0.36 | 100.0000% argmax |
 *
 * What gates a model here is **port fidelity**: whether the ONNX graph
 * reproduces the Keras checkpoint the server runs. All of them do, argmax-
 * identical at fp32 and within 1 pixel in 19,000 at fp16w — so the browser
 * cannot be worse than the server, whatever the absolute accuracy is.
 *
 * The ResUNet-a/VNet gap on those masks is real and unexplained, but it is a
 * property of the checkpoints rather than the conversion: it is not the
 * preprocessing (five variants swept), not a label permutation (all 24 scored,
 * identity optimal), not the export (Keras alone reproduces it), and not tile
 * geometry (40x runs at its native 512). The likeliest explanation is that the
 * ResUNet-a checkpoints saw a different annotation round. That is a domain
 * question for whoever trained them, not a reason to withhold the port.
 *
 * `resunet-a-2d-retinal` (base) stays disabled: superseded by the 2025 20x/40x
 * pair, and its Hub repo is private. It is listed rather than deleted so a host
 * shows it as unavailable-in-browser instead of pretending the server's choice
 * does not exist — and so enabling it later is a URL, not a code change.
 *
 * PREPROCESSING IS NOT UNIFORM ACROSS THESE
 * VNet is grayscale `x/255`; the ResUNet-a models are 3-channel `caffe` (RGB
 * ImageNet means subtracted, no division). Each `model.json` carries its own,
 * and jax-ai-js reads it — but it must be >= 0.2.2, since earlier versions
 * ignored `subtractMeansRGB` and would feed ResUNet-a raw 0-255, which silently
 * drops class 1 (ONL) to IoU 0.000.
 *
 * Export tooling: the sibling `browser-onnx-tools` project.
 */

export interface RetinalModelDef {
  id: string;
  label: string;
  /** URL of the `.onnx` weights. **Empty disables the model.** */
  modelUrl: string;
  /**
   * URL of the `model.json` sidecar. Omit to use `model.json` alongside the
   * weights, which is how every published repo is laid out.
   */
  metaUrl?: string;
  /** Patch size the checkpoint was trained at, for callers that size reads to it. */
  patchSize: number;
  /** Download size of the `fp16w` weights, MB — these are large enough to warn about. */
  sizeMb: number;
  /** Measured mIoU against the bucket's ground-truth masks. */
  miou: number;
  /** Set when the model is knowingly disabled; shown to the user. */
  unavailableReason?: string;
}

const HF = 'https://huggingface.co/Ballon999';

const RESUNET_BASE_UNAVAILABLE =
  'Not available in the browser: superseded by the 20x and 40x checkpoints. ' +
  'Run this step on the server if you specifically need it.';

export const RETINAL_MODELS: RetinalModelDef[] = [
  {
    id: 'vnet-2d-retinal',
    label: 'VNet 2D (40x)',
    modelUrl: `${HF}/vnet-2d-retinal-layer-onnx/resolve/main/model.fp16w.onnx`,
    patchSize: 512,
    // Nearly 6x the YOLO checkpoints. Worth surfacing before a user on a
    // metered connection triggers it by clicking a toolbar button.
    sizeMb: 590,
    miou: 0.9061,
  },
  {
    id: 'resunet-a-2d-retinal-40x',
    label: 'ResUNet-a 2D (40x)',
    modelUrl: `${HF}/resunet-a-2d-retinal-layer-40x-onnx/resolve/main/model.fp16w.onnx`,
    patchSize: 512,
    // A sixth of VNet — the practical choice on a metered connection.
    sizeMb: 102,
    miou: 0.4,
  },
  {
    id: 'resunet-a-2d-retinal-20x',
    label: 'ResUNet-a 2D (20x)',
    modelUrl: `${HF}/resunet-a-2d-retinal-layer-20x-onnx/resolve/main/model.fp16w.onnx`,
    // 256, not 128. The checkpoint's input size is baked into the graph: a
    // 128 patch raises inside a dilated conv (SpaceToBatchND), and feeding it
    // 128-resolution content resampled up to 256 scores 0.19 against 0.31 for
    // plain half-scale. Run it at 256.
    patchSize: 256,
    sizeMb: 102,
    miou: 0.3,
  },
  {
    id: 'resunet-a-2d-retinal',
    label: 'ResUNet-a 2D (base)',
    modelUrl: '',
    patchSize: 512,
    sizeMb: 102,
    miou: 0.36,
    unavailableReason: RESUNET_BASE_UNAVAILABLE,
  },
];

export const DEFAULT_RETINAL_MODEL_ID = 'vnet-2d-retinal';

let defaultModelId = DEFAULT_RETINAL_MODEL_ID;

/** Look up a model definition by id. Returns undefined for an unknown id. */
export function getRetinalModel(id: string): RetinalModelDef | undefined {
  return RETINAL_MODELS.find((m) => m.id === id);
}

/** Whether a model has usable weights configured. */
export function isRetinalModelReady(id: string): boolean {
  const m = getRetinalModel(id);
  return !!m && m.modelUrl.trim().length > 0;
}

/** Only the models a browser can actually run. */
export function readyRetinalModels(): RetinalModelDef[] {
  return RETINAL_MODELS.filter((m) => m.modelUrl.trim().length > 0);
}

/**
 * Repoint a model at different hosting (a GCS bucket, a same-origin proxy), or
 * enable one of the disabled entries. Call once at app init, before first use.
 * An empty `modelUrl` disables the model.
 */
export function setRetinalModelUrls(id: string, urls: { modelUrl?: string; metaUrl?: string }): void {
  const m = getRetinalModel(id);
  if (!m) return;
  if (urls.modelUrl !== undefined) m.modelUrl = urls.modelUrl;
  if (urls.metaUrl !== undefined) m.metaUrl = urls.metaUrl;
  // A host that supplies weights has answered the question the reason
  // describes. Decided from the model's post-update state rather than from the
  // argument: a whitespace-only url, or a call that sets only `metaUrl`, leaves
  // the model just as disabled — and clearing the reason there would strip the
  // one explanation the user gets while `isRetinalModelReady` still says no.
  if (isRetinalModelReady(id)) delete m.unavailableReason;
}

/** Change which model runs when a caller does not name one. */
export function setDefaultRetinalModel(id: string): void {
  if (getRetinalModel(id)) defaultModelId = id;
}

export function getDefaultRetinalModelId(): string {
  return defaultModelId;
}
