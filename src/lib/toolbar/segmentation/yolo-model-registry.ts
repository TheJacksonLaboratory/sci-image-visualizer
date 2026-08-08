/**
 * Registry of YOLOv8-seg instance-segmentation models.
 *
 * Mirrors {@link SAM_MODELS}: public HF-hosted ONNX by default so the tool works
 * out of the box in any host, repointable at private hosting via
 * {@link setYoloModelUrls}.
 *
 * Each entry carries the per-model *defaults* the server-side worker uses for
 * that checkpoint. These are properties of how the model was trained (object
 * scale, expected crowding), not UI preferences — the embryo models want heavy
 * 60% tile overlap and loose merge thresholds because their objects are large
 * and touch, while the eye models were trained on sparse, downsampled fields.
 * Keeping them here means a host that just picks a model gets sane behaviour
 * without having to know any of that.
 *
 * Weights point at the `model.fp16w.onnx` variant deliberately. The `.fp16`
 * variant accumulates in half precision on WebGPU and, at the x-scale these
 * models use, produces materially wrong boxes; `fp16w` stores weights in fp16
 * and computes in fp32, so it is half the download at identical accuracy.
 *
 * Export tooling: the sibling `browser-onnx-tools` project.
 */

export interface YoloModelDef {
  id: string;
  label: string;
  /** URL of the `.onnx` weights. Empty disables the model. */
  modelUrl: string;
  /**
   * URL of the `model.json` sidecar. Omit to use `model.json` alongside the
   * weights, which is how every published repo is laid out.
   */
  metaUrl?: string;
  /** Per-model defaults, from the server worker's model table. */
  defaults: {
    confidence: number;
    iouThreshold: number;
    mergeThreshold: number;
    overlapX: number;
    overlapY: number;
  };
}

const HF = 'https://huggingface.co/Ballon999';

const EYE_DEFAULTS = {
  confidence: 0.6,
  iouThreshold: 0.5,
  mergeThreshold: 0.3,
  overlapX: 0,
  overlapY: 0,
};

/**
 * The retina is an elongated band spanning the whole field, so it crosses tile
 * seams wherever they fall.
 *
 * With no overlap the tiles butt together at fixed boundaries: a structure
 * sitting across a seam is cut in half, each tile sees only a slice, and the
 * slice often fails to clear the confidence threshold — so the object vanishes
 * exactly where the seam lands. Observed as multi-thousand-pixel holes in the
 * middle of an otherwise continuous retina, which closed once overlap was
 * raised.
 *
 * An object of size `s` is guaranteed to sit wholly inside some tile only when
 * the overlap is at least `s / tileSize`; at 60% that covers anything up to
 * ~307px of a 512px tile. The server's own table uses 0 here and has the same
 * blind spot — this deliberately diverges from it.
 */
const RETINA_DEFAULTS = {
  confidence: 0.6,
  iouThreshold: 0.5,
  // Cross-tile merging uses intersection-over-*smaller*, so at 0.3 a fragment is
  // discarded once 30% of its own area is covered by a larger box — even when
  // most of it lies outside. On a band detected as a chain of overlapping
  // fragments that deletes the middle ones. Measured on one slide: 0.3 gave two
  // boxes covering 75% of the band with a 3150px hole through it; 0.8 gave four
  // boxes covering 100% with no hole, at the cost of two overlapping pairs.
  // Matches the value jit-ui already sends the server for this checkpoint.
  mergeThreshold: 0.8,
  overlapX: 60,
  overlapY: 60,
};

// Embryos are large, touch each other, and are imaged at native scale — hence
// the heavy overlap and the far looser merge thresholds.
const EMBRYO_DEFAULTS = {
  confidence: 0.6,
  iouThreshold: 0.8,
  mergeThreshold: 0.8,
  overlapX: 60,
  overlapY: 60,
};

export const YOLO_MODELS: YoloModelDef[] = [
  {
    id: 'yolov8x-seg-opticnerve',
    label: 'Optic nerve',
    modelUrl: `${HF}/yolov8x-seg-opticnerve-onnx/resolve/main/model.fp16w.onnx`,
    defaults: { ...EYE_DEFAULTS },
  },
  {
    id: 'yolov8x-seg-retina',
    label: 'Retina',
    modelUrl: `${HF}/yolov8x-seg-retina-onnx/resolve/main/model.fp16w.onnx`,
    defaults: { ...RETINA_DEFAULTS },
  },
  {
    id: 'yolov8x-seg-embryo-m2',
    label: 'Embryo (M2)',
    modelUrl: `${HF}/yolov8x-seg-embryo-m2-onnx/resolve/main/model.fp16w.onnx`,
    defaults: { ...EMBRYO_DEFAULTS },
  },
  {
    id: 'yolov8x-seg-embryo-m3',
    label: 'Embryo (M3)',
    modelUrl: `${HF}/yolov8x-seg-embryo-m3-onnx/resolve/main/model.fp16w.onnx`,
    defaults: { ...EMBRYO_DEFAULTS },
  },
];

export const DEFAULT_YOLO_MODEL_ID = 'yolov8x-seg-opticnerve';

let defaultModelId = DEFAULT_YOLO_MODEL_ID;

/** Look up a model definition by id. Returns undefined for an unknown id. */
export function getYoloModel(id: string): YoloModelDef | undefined {
  return YOLO_MODELS.find((m) => m.id === id);
}

/** Whether a model has a usable weights URL configured. */
export function isYoloModelReady(id: string): boolean {
  const m = getYoloModel(id);
  return !!m && m.modelUrl.trim().length > 0;
}

/**
 * Repoint a model at different hosting (e.g. a GCS bucket or a same-origin
 * proxy). Call once at app init, before the first run. An empty `modelUrl`
 * disables the model.
 */
export function setYoloModelUrls(id: string, urls: { modelUrl?: string; metaUrl?: string }): void {
  const m = getYoloModel(id);
  if (!m) return;
  if (urls.modelUrl !== undefined) m.modelUrl = urls.modelUrl;
  if (urls.metaUrl !== undefined) m.metaUrl = urls.metaUrl;
}

/** Change which model runs when a caller does not name one. */
export function setDefaultYoloModel(id: string): void {
  if (getYoloModel(id)) defaultModelId = id;
}

export function getDefaultYoloModelId(): string {
  return defaultModelId;
}
