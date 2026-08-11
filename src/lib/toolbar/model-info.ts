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
};
