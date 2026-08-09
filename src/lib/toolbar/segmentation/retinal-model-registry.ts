/**
 * Registry of retinal-layer semantic-segmentation models.
 *
 * Mirrors {@link YOLO_MODELS}: public HF-hosted ONNX by default, repointable at
 * private hosting via {@link setRetinalModelUrls}.
 *
 * ONLY ONE CHECKPOINT IS ENABLED, AND THAT IS DELIBERATE
 * The server offers four. Measured against the ground-truth masks shipped
 * alongside them, only VNet reproduces them:
 *
 * | checkpoint | mIoU |
 * |---|---|
 * | **VNet 2D** | **0.9061** |
 * | ResUNet-a 2D (base) | 0.3065 |
 * | ResUNet-a 2D 20x | 0.2869 |
 * | ResUNet-a 2D 40x | 0.2718 |
 *
 * The ResUNet-a numbers are not quantization damage — their ONNX exports match
 * their own Keras originals exactly. They disagree with the *masks*, folding
 * ground-truth class 1 into their class 2 and class 3 into background, and no
 * relabelling rescues them (the best of all 24 class permutations reaches only
 * 0.36). Either those masks belong to a different model generation or the class
 * definitions moved — an open question for whoever trained them.
 *
 * So their weights stay unpublished (their Hub repos are private) and their
 * entries here carry an empty `modelUrl`, which {@link isRetinalModelReady}
 * reports as not-ready. They are listed rather than deleted so a host shows
 * them as unavailable-in-browser instead of pretending the server's choice does
 * not exist — and so enabling one later is a URL, not a code change.
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

const RESUNET_UNAVAILABLE =
  'Not available in the browser: this checkpoint scores mIoU ~0.3 against its own ' +
  'ground-truth masks, pending a review of its class definitions. Run this step on the server.';

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
    id: 'resunet-a-2d-retinal',
    label: 'ResUNet-a 2D (40x)',
    modelUrl: '',
    patchSize: 512,
    sizeMb: 102,
    miou: 0.3065,
    unavailableReason: RESUNET_UNAVAILABLE,
  },
  {
    id: 'resunet-a-2d-retinal-20x',
    label: 'ResUNet-a 2D (20x)',
    modelUrl: '',
    patchSize: 256,
    sizeMb: 102,
    miou: 0.2869,
    unavailableReason: RESUNET_UNAVAILABLE,
  },
  {
    id: 'resunet-a-2d-retinal-40x',
    label: 'ResUNet-a 2D (40x, alt)',
    modelUrl: '',
    patchSize: 512,
    sizeMb: 102,
    miou: 0.2718,
    unavailableReason: RESUNET_UNAVAILABLE,
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
