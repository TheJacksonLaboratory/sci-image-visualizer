/**
 * Per-model descriptions for the info icon beside each item of the SAM / YOLO /
 * retinal model dropdowns, keyed by registry model id.
 *
 * Lives in the toolbar layer rather than in the model registries for two
 * reasons: the toolbar receives only `{ id, label }` from its host, so registry
 * copy would have to be threaded through every host; and this text was already
 * owned here — the SAM entries are the prose from the "About the SAM models"
 * overlay panel this replaced, moved next to the model it describes.
 *
 * The quoted numbers come from the registries (`sizeMb`, `miou`, `patchSize`,
 * per-model tiling `defaults`) — keep them in step when those change.
 *
 * Rendered with `[escape]="false"`, so `<b>` / `<br>` / entities are honoured.
 * A model with no entry here simply gets no info icon.
 */
export const MODEL_INFO: Record<string, string> = {
  // ── SAM (promptable; box + point tools) ────────────────────────────────────
  'microsam-vit-t-lm':
    '<b>micro-sam ViT-T</b> (default)<br>Light-microscopy finetuned. TinyViT encoder, ' +
    '~14&nbsp;MB, very fast, runs on WASM. Good mask quality — best for quick interactive ' +
    'work and many/large objects.',
  'microsam-vit-b-lm':
    '<b>micro-sam ViT-B</b><br>Light-microscopy finetuned. ViT-Base encoder, ~172&nbsp;MB, ' +
    'slower, GPU-accelerated (WebGPU). Highest accuracy — when ViT-T misses subtle or ' +
    'overlapping boundaries.',
  'patho-sam-vit-b':
    '<b>patho-sam ViT-B</b><br>Histopathology finetuned (H&amp;E / stained tissue). ViT-Base ' +
    'encoder, GPU-accelerated. Use it for pathology slides — it segments tissue/nuclei better ' +
    'than the microscopy models.',
  'patho-sam-vit-b-int8':
    '<b>patho-sam ViT-B (int8)</b><br>Same model, int8-quantized — ~100&nbsp;MB vs ' +
    '~180&nbsp;MB (smaller download). Runs on WASM (slower encode than the fp16 version); ' +
    'masks are near-identical. Pick it on slow connections.',

  // ── YOLO (detection; no prompt) ────────────────────────────────────────────
  'yolov8x-seg-opticnerve':
    '<b>Optic nerve</b><br>YOLOv8x-seg finetuned for optic nerve. fp16 weights — half the ' +
    'download at identical accuracy. Defaults: confidence 0.6, IoU 0.5, merge 0.3, no tile ' +
    'overlap.',
  'yolov8x-seg-retina':
    '<b>Retina</b><br>YOLOv8x-seg finetuned for the retina, an elongated band spanning the ' +
    'whole field — so it crosses tile seams wherever they fall. Runs with 60% tile overlap and ' +
    'a loose 0.8 merge threshold; with less, seam-straddling slices miss the confidence ' +
    'threshold and leave holes through the band.',
  'yolov8x-seg-embryo-m2':
    '<b>Embryo (M2)</b><br>YOLOv8x-seg finetuned for embryos (M2). Embryos are large, touch ' +
    'each other, and are imaged at native scale — 60% tile overlap with loose IoU and merge ' +
    'thresholds (0.8).',
  'yolov8x-seg-embryo-m3':
    '<b>Embryo (M3)</b><br>YOLOv8x-seg finetuned for embryos (M3). Same tiling as M2: 60% ' +
    'overlap with loose IoU and merge thresholds (0.8), for large touching objects at native ' +
    'scale.',

  // ── Retinal layers (semantic segmentation; no prompt) ──────────────────────
  'vnet-2d-retinal':
    '<b>VNet 2D (40x)</b><br>Retinal layer semantic segmentation, 512&nbsp;px patches at 40x. ' +
    'Measured mIoU 0.91. ~590&nbsp;MB download — nearly 6&times; the YOLO checkpoints — ' +
    'fetched once on first run, then cached.',
  'resunet-a-2d-retinal-40x':
    '<b>ResUNet-a 2D (40x)</b><br>512&nbsp;px patches, ~102&nbsp;MB — a sixth of VNet. ' +
    'Reproduces the server\'s Keras checkpoint exactly (100% argmax agreement), but scores ' +
    'mIoU ~0.40 against the shipped masks where VNet scores 0.91. Prefer VNet unless you ' +
    'specifically want to match this server model.',
  'resunet-a-2d-retinal-20x':
    '<b>ResUNet-a 2D (20x)</b><br>256&nbsp;px patches, ~102&nbsp;MB. Reproduces the server\'s ' +
    'Keras checkpoint exactly (100% argmax agreement), but scores mIoU ~0.30 against the ' +
    'shipped masks where VNet scores 0.91. Prefer VNet unless you specifically want to match ' +
    'this server model.',
  // Ships disabled (empty `modelUrl`), so it is filtered out of the picker
  // until a host repoints it.
  'resunet-a-2d-retinal':
    '<b>ResUNet-a 2D (base)</b><br>512&nbsp;px patches, ~102&nbsp;MB. Not available in the ' +
    'browser: superseded by the 20x and 40x checkpoints. Run this step on the server if you ' +
    'specifically need it.',
};
