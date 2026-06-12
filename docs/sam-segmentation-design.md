# Browser SAM segmentation — ONNX export, quantization, and engine design

Design for the client-side, promptable **Segment Anything** tooling described in
[jit-ui#90](https://github.com/TheJacksonLaboratory/jit-ui/issues/90): the user draws
rectangles with the existing rectangle tool, presses **Segment**, and each box is turned
into a mask/region by a SAM-family model running in the browser on WebGPU. This is the
first of a planned set of 2D/3D SAM annotation tools backed by a small registry of
quantized models (micro-sam first, then SAM3, pathoSAM, …).

> **Why not cellpose-SAM?** Cellpose-SAM deletes SAM's prompt encoder + mask decoder and
> keeps only the ViT image encoder feeding a Cellpose flow head, so it is **not
> promptable** — it can only do automatic "segment all cells". It stays as the *automatic*
> tool; the *promptable* box/point tool needs a real SAM (encoder + prompt encoder + mask
> decoder). micro-sam is exactly that, fine-tuned for microscopy.

---

## 1. Model choice — micro-sam

micro-sam finetuned checkpoints are standard `segment-anything` SAM models (ViT image
encoder + prompt encoder + mask decoder) trained on microscopy, plus an optional extra
decoder for automatic instance segmentation (AIS). Because they are vanilla SAM
architectures, the standard SAM ONNX export applies.

| Variant | Encoder params | Browser fit | Use |
|---|---|---|---|
| `vit_t_lm` (MobileSAM-based) | ~5–10M | best | default for the browser MVP |
| `vit_b_lm` | ~90M | good (fp16/int8) | higher quality |
| `vit_l_lm` | ~300M | heavy | desktop/WebGPU-strong only |

`_lm` = light-microscopy fine-tune; `_em_organelles` etc. exist for EM. Start with
`vit_t_lm`/`vit_b_lm`. The same recipe later covers **SAM3** and **pathoSAM** (both
SAM-architecture) — only the registry entry changes.

---

## 2. ONNX export recipe

> The runnable export + quantization tooling lives in the **`sam-js`** project
> (sibling repo): `sam-js/export/export_sam_onnx.py` (+ its venv/requirements and
> README). It's validated end-to-end on base SAM ViT-B (encoder → embedding →
> box-prompt decode → mask). The recipe below documents what that script does.

SAM splits into two graphs so the heavy part runs once per image and prompts stay cheap:

- **`encoder.onnx`** — `image (1,3,1024,1024) → image_embeddings (1,256,64,64)`. Run once
  per image (or per z-slice); cache the embedding.
- **`decoder.onnx`** — prompt encoder + mask decoder + upscale. Run per prompt; returns a
  mask already resized to the original image size.

### 2.1 Load the micro-sam checkpoint as a segment-anything `Sam`

```python
# pip install micro_sam segment-anything onnx onnxruntime
from micro_sam.util import get_sam_model      # downloads/caches the finetuned ckpt
predictor = get_sam_model(model_type="vit_b_lm")   # or vit_t_lm / vit_l_lm
sam = predictor.model            # a segment_anything `Sam` (image_encoder + prompt_encoder + mask_decoder)
sam = sam.cpu().eval()
MODEL_TYPE = "vit_b"             # the base ViT size behind the _lm variant
```

### 2.2 Export the decoder (prompt encoder + mask decoder)

Use segment-anything's official exporter — it wraps the prompt encoder + mask decoder and
emits masks resized to `orig_im_size`:

```bash
python -m segment_anything.utils.onnx \
  --checkpoint <micro_sam_vit_b_lm.pt> --model-type vit_b \
  --output decoder.onnx --return-single-mask --opset 17
# (equivalently scripts/export_onnx_model.py in the segment-anything repo)
```

Decoder I/O (SAM v1):

| Name | Shape | Notes |
|---|---|---|
| `image_embeddings` | `(1,256,64,64)` | from the encoder |
| `point_coords` | `(1,N,2)` | prompt points in **1024-resized** coords |
| `point_labels` | `(1,N)` | `1`=pos, `0`=neg, `2`=box TL, `3`=box BR, `-1`=pad |
| `mask_input` | `(1,1,256,256)` | prior low-res logits (zeros if none) |
| `has_mask_input` | `(1,)` | `1.0` if `mask_input` used |
| `orig_im_size` | `(2,)` | original `[H, W]` |
| → `masks` | `(1,M,H,W)` | logits, already upscaled to orig size |
| → `iou_predictions` | `(1,M)` | quality score; pick argmax |
| → `low_res_masks` | `(1,M,256,256)` | feed back as `mask_input` to refine |

### 2.3 Export the encoder

The official script only exports the decoder, so wrap the image encoder yourself:

```python
import torch
class EncoderWrapper(torch.nn.Module):
    def __init__(self, sam): super().__init__(); self.sam = sam
    def forward(self, x):                # x: (1,3,1024,1024), already SAM-normalized + padded
        return self.sam.image_encoder(x) # (1,256,64,64)

torch.onnx.export(
    EncoderWrapper(sam), torch.randn(1, 3, 1024, 1024),
    "encoder.onnx", input_names=["image"], output_names=["image_embeddings"],
    opset_version=17,
)
```

Preprocessing (resize long side → 1024, normalize with SAM mean/std, pad to 1024×1024) is
done in JS before the encoder (matches the standard web demo). Keep it in JS so the model
stays a pure tensor-in/tensor-out graph.

> Alternatives: [`samexporter`](https://github.com/vietanhdev/samexporter) exports SAM /
> MobileSAM / SAM-HQ encoder+decoder in one step and accepts arbitrary SAM checkpoints
> (incl. micro-sam weights). SAM2/SAM3 use different export tooling and a `256×256`
> decoder output — handle per-variant in the registry.

### 2.4 Quantization

The encoder dominates size; the decoder is a few MB (leave it fp32/fp16).

```python
# fp16 encoder — ~2x smaller, ideal for WebGPU
import onnx
from onnxconverter_common import float16
onnx.save(float16.convert_float_to_float16(onnx.load("encoder.onnx")), "encoder.fp16.onnx")

# int8 (dynamic) — ~4x smaller; validate quality, ViT attention can degrade
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("encoder.onnx", "encoder.int8.onnx", weight_type=QuantType.QInt8)
```

Rough `vit_b` encoder sizes: fp32 ≈ 360 MB, **fp16 ≈ 180 MB**, int8 ≈ 90 MB. `vit_t` is an
order of magnitude smaller (tens of MB) — preferred for first load. **Default to fp16 on
WebGPU**; use int8 only if you validate mask IoU stays within tolerance against the fp32
reference on a few representative images. Static int8 (with calibration) beats dynamic if
you go that route.

### 2.5 Hosting

Publish the quantized `encoder.*.onnx` + `decoder.onnx` to HF Hub (like the existing
`ballon999/cellpose-sam-onnx`) or a GCS model bucket. The engine fetches once and caches
in IndexedDB — same model-caching story cellpose-js already uses.

---

## 3. In-browser inference flow

1. **Per image (or z-slice):** preprocess → run **encoder** (WebGPU) → cache
   `image_embeddings (1,256,64,64)` + the `1024/max(H,W)` scale + `orig_im_size`.
2. **Per box prompt:** encode the box as two points `[[x0,y0],[x1,y1]]` with labels
   `[2,3]`, scaled by `1024/max(H,W)`; `mask_input` zeros, `has_mask_input=0`; run
   **decoder** → pick mask with best `iou_predictions` → threshold logits `> 0` → uint8
   mask (already at original size).
3. **(Refine, P1):** add positive/negative points; feed `low_res_masks` back as
   `mask_input` with `has_mask_input=1`.
4. **Mask → region:** trace the binary mask to a contour polygon and commit as a `Region`.

For issue #90 the encoder runs **once** and all rectangle boxes reuse the same embedding —
multi-box segmentation is N cheap decoder calls.

---

## 4. Engine design in jit-ui

Reuses every existing seam: the ORT WASM assets at `/assets/ort/`, the Web-Worker
inference pattern (`transformers.worker.ts`, cellpose-js worker), the region store +
coordinate transform the wand/brush already use, and the `WandService` contour tracer.

```
ToolbarComponent ──(@Output segment)──► VisualizationComponent.segment()
                                              │
                                              ▼
                                   SamToolService  (Angular, viz lib; bindHost like WandToolService)
                                     • reads Rectangle regions from RegionStore
                                     • gets pixels via host.getCachedImageData() + coordinate transform
                                     • box (data → matrix → 1024 coords)
                                     • mask → WandService.maskToPolygons → Region → RegionStore (append)
                                              │
                                              ▼
                                      SamSession  (framework-agnostic; Web Worker)
                                     • model registry (micro-sam, SAM3, pathoSAM…)
                                     • ORT encoder session (WebGPU EP, WASM fallback)
                                     • ORT decoder session
                                     • embed(image) ⟶ cached;  decode(prompts) ⟶ mask
                                              │
                                              ▼
                                  onnxruntime-web + /assets/ort/  (WebGPU / WASM)
```

### 4.1 Model registry — `sam-model-registry.ts`

```ts
interface SamModelDef {
  id: string;                 // 'microsam-vit-b-lm'
  label: string;              // 'micro-sam ViT-B (light microscopy)'
  encoderUrl: string;         // HF / GCS URL
  decoderUrl: string;
  variant: 'sam1' | 'sam2' | 'sam3';   // governs decoder I/O + mask output size
  inputSize: number;          // 1024
  promptable: true;
  microscopy?: boolean;
}
```
First entry: `microsam-vit-b-lm` (and `-vit-t-lm`). SAM3 / pathoSAM are added as entries
later. **cellpose-SAM is NOT here** — it lives in the cellpose engine as the *automatic*
tool.

### 4.2 `SamSession` (worker-backed, no Angular)

```ts
class SamSession {
  loadModel(def: SamModelDef): Promise<void>;     // create ORT sessions, cache weights (IndexedDB)
  embed(img: {data: Uint8ClampedArray; width: number; height: number}): Promise<Embedding>;
  decode(emb: Embedding, prompts: Prompt[]): Promise<{mask: Uint8Array; w: number; h: number; iou: number}>;
  dispose(): void;
}
```
- Encoder session: `executionProviders: ['webgpu', 'wasm']` (feature-detect WebGPU, fall
  back to WASM); decoder: `['wasm']` or `['webgpu']` (it's light either way).
- Runs in a dedicated module Worker so the heavy encoder pass never blocks the UI; ORT
  WASM/JSEP sidecars served from `/assets/ort/` (already configured for cellpose).
- `progress$` / `status$` Subjects drive the model-download spinner (mirror
  `CellposeEngine`).

### 4.3 `SamToolService` (viz library, Angular)

Mirrors `WandToolService`/`BrushToolService`:
- `bindHost(host)` — the host (OSD/Plotly backend) supplies `getCachedImageData()`, the
  coordinate transform, `getRegions()/setRegions()`, `getShapeColor()`, `getFileName()`,
  `getActiveFrameIndex()`.
- `segmentBoxes()`:
  1. `getCachedImageData()` → build the active frame as RGBA; record `originX/originY` +
     `ratios`.
  2. `embed()` once for this image (key by fileName + zIndex + view).
  3. read `RegionStore.getRegions()`, keep `bounds instanceof Rectangle`, convert each box
     **data → matrix** (`(d - origin)/ratio`, exactly like the wand) **→ 1024-space**.
  4. per box: `decode()` → threshold → `WandService.maskToPolygons(...)` → map matrix →
     data coords → `Region` (label `'sam'`, store-minted color).
  5. `setRegions(regions, …, /*append*/ true)` — the brush/wand commit pattern; both
     overlays re-render off the store event.
- Optional: remove or keep the prompt rectangles after segmenting (config).

### 4.4 Toolbar + host wiring

- `ToolbarComponent`: a **Segment** button (region-tool group) → `@Output() segment`. P1
  adds a model dropdown and a box/point/auto mode selector.
- `VisualizationComponent`: `segment()` handler → `samToolService.segmentBoxes()`, with
  loading/error UI (model download progress, "no rectangles drawn" guard).

### 4.5 Coordinate caveat (important)

Rectangles live in **image/data coords**. The OSD `getCachedImageData()` is a *viewport
readback* (zoom-dependent, with `originX/originY` + `ratios`), Plotly's is the full frame.
For the MVP, run SAM on the same readback the wand uses and map boxes via origin/ratio —
consistent within the current view. A later refinement runs the encoder on a fixed
full-resolution image and caches one embedding per image/slice regardless of zoom.

---

## 5. Phasing

| Phase | Scope |
|---|---|
| **P0 (issue #90)** | Box prompts on rectangles → masks. `SamSession` + registry (`microsam-vit-t/b-lm`) + `SamToolService` + Segment button. One embedding per image, multi-box. |
| **P1** | Interactive point refinement (pos/neg points, live decoder, `mask_input` feedback), commit/clear buffers (micro-sam UX), model dropdown. |
| **P2** | Automatic mode — AMG point-grid or micro-sam **AIS** decoder; unify with the cellpose-SAM automatic tool. |
| **P3** | 3D / stack propagation: per-slice embeddings, project box/centroid prompt to `k±1`, link instances across slices by IoU (micro-sam "Segment All Slices"); time series. |
| **P4** | Additional models via the registry: **SAM3**, **pathoSAM**; quantization variants and per-model decoder I/O. |

## 6. Reuse map (already in the repo)

- ORT WASM at `/assets/ort/` + WebGPU plumbing — `apps/jit-ui/project.json`, cellpose engine.
- Worker inference pattern — `engines/transformers-js/transformers.worker.ts`, cellpose-js worker.
- `WandService.maskToPolygons()` contour tracer + the wand/brush region-commit pattern — `libs/jax-image-visualization/src/lib/toolbar/`.
- Toolbar `@Output` → `VisualizationComponent` → host-bound tool service — the wand/brush precedent.
- `RegionStore` (rectangles in, contour regions out) + coordinate transform.

## References

- Issue: <https://github.com/TheJacksonLaboratory/jit-ui/issues/90>
- micro-sam: <https://github.com/computational-cell-analytics/micro-sam>
- Cellpose-SAM (encoder-only, not promptable): <https://www.biorxiv.org/content/10.1101/2025.04.28.651001v1.full>
- SAM ONNX example: <https://github.com/facebookresearch/segment-anything/blob/main/notebooks/onnx_model_example.ipynb>
- samexporter: <https://github.com/vietanhdev/samexporter>
- ONNX Runtime Web + WebGPU: <https://opensource.microsoft.com/blog/2024/02/29/onnx-runtime-web-unleashes-generative-ai-in-the-browser-using-webgpu/>
