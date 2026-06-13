# @jax-image/visualization

A framework-style Angular 17 library for **interactive scientific image
visualization and annotation**. It renders large/multi-channel images through
pluggable backends (OpenSeadragon tiled viewer and Plotly), and provides a rich
set of on-canvas region tools — including **AI-assisted segmentation that runs
entirely in the browser** (WebGPU / WASM via `onnxruntime-web`).

Used by [jit-ui](https://github.com/TheJacksonLaboratory/jit-ui) (JAX Image
Tools). The annotation/segmentation tooling was added under
[jit-ui#90](https://github.com/TheJacksonLaboratory/jit-ui/issues/90).

## Highlights

- **Rendering backends** — OpenSeadragon (tiled) and Plotly, behind one
  `IVisualizer` contract; the host picks per image via `RoutingVisualizerService`.
- **Region / annotation tools** — selection, rectangle, polyline, freeform,
  polygon + vertex editing, move, Bézier↔polygon, **magic wand** (similar-pixel
  flood with erase/merge), **brush** (paint/erase, QuPath-style), vertex eraser.
- **Browser-side segmentation** — promptable SAM (box + interactive points) and
  automatic cellpose-SAM. No server round-trip.
- A shared **region store** + GeoJSON-friendly model, channel/histogram controls,
  scale bar, intensity profiles, and a configurable toolbar.

## Segmentation tools (SAM & cellpose)

All segmentation runs **client-side** — models are fetched once (a progress
toast is shown), cached, then executed with `onnxruntime-web` (WebGPU where
supported, WASM otherwise). Generated regions inherit the color of the rectangle
they came from.

### Box-prompt SAM — "Segment"
Draw one or more **rectangles** around objects, then click **Segment**. Each
rectangle is sent to SAM as a box prompt and replaced by the segmented mask.

### Interactive point prompts
Click directly on an object to segment it as a **new** region (each click is an
independent object — clicking another object won't grow the previous one).
`Shift`/`Alt`-click adds an *exclude* point that refines the current object;
`Enter` commits, `Esc` undoes.

### Model picker
A dropdown on the Segment button chooses the SAM model; the choice applies to
**both** the box and point tools. An info button summarizes the trade-offs.

### Cellpose — automatic
Draw rectangles, then click **Cellpose** to auto-segment every cell inside each
rectangle (client-side cellpose-SAM via [`cellpose-js`](https://www.npmjs.com/package/cellpose-js)) —
one region per detected cell, no per-object clicking. (Cellpose-SAM is *not*
promptable, so it's the automatic tool rather than a model in the SAM picker.)

## Models

Promptable SAM models are SAM-v1 encoder/decoder ONNX pairs (the encoder runs
once per image; the decoder runs per prompt). The registry lives in
`src/lib/toolbar/sam-model-registry.ts`; the host supplies hosted URLs via
`setSamModelUrls(...)`. Export/quantization tooling lives in the sibling
`sam-js` project.

| Picker id | Domain | Encoder | Runs on | HF model |
|---|---|---|---|---|
| `microsam-vit-t-lm` *(default)* | light microscopy | TinyViT, ~14 MB fp16 | WASM¹ | [Ballon999/microsam-vit-t-lm-onnx](https://huggingface.co/Ballon999/microsam-vit-t-lm-onnx) |
| `microsam-vit-b-lm` | light microscopy | ViT-B, ~172 MB fp16 | WebGPU | [Ballon999/microsam-vit-b-lm-onnx](https://huggingface.co/Ballon999/microsam-vit-b-lm-onnx) |
| `patho-sam-vit-b` | histopathology (H&E) | ViT-B, ~172 MB fp16 | WebGPU | [Ballon999/patho-sam-vit-b-onnx](https://huggingface.co/Ballon999/patho-sam-vit-b-onnx) |
| `patho-sam-vit-b-int8` | histopathology (H&E) | ViT-B, ~100 MB int8 | WASM | [Ballon999/patho-sam-vit-b-onnx](https://huggingface.co/Ballon999/patho-sam-vit-b-onnx) (`encoder.int8.onnx`) |
| cellpose-SAM *(automatic)* | cells (generalist) | SAM ViT + flow head | WebGPU/WASM | [ballon999/cellpose-sam-onnx](https://huggingface.co/ballon999/cellpose-sam-onnx) |

¹ TinyViT's fp16 attention overflows on the onnxruntime-web WebGPU EP (returns an
empty mask); it is numerically correct and fast on WASM, so its encoder is pinned
to WASM. int8 models also run on WASM (no WebGPU int8 matmul).

micro-sam and patho-sam are distributed through micro-sam's model registry
(`vit_*_lm`, `vit_*_histopathology`); SAM 3 is a planned addition (it needs a
`variant: 'sam3'` decoder path, since SAM 2/3 differ in mask I/O). See
`docs/sam-segmentation-design.md` for the design.

## Documentation

Design, architecture, and planning docs for the library:

- **[docs/sam-segmentation-design.md](docs/sam-segmentation-design.md)** — design of
  the browser SAM segmentation: model choice, ONNX export/quantization recipe,
  encoder/decoder I/O, the engine/session architecture, and the rollout phases.
- **Architecture diagrams**
  - [docs/jit-ui-visualization-architecture.mmd](docs/jit-ui-visualization-architecture.mmd)
    ([PNG](docs/img/jit-ui-visualization-architecture.png) ·
    [SVG](docs/img/jit-ui-visualization-architecture.svg)) — host ⇄ library ⇄
    rendering backends, ports, and the jit-service request flow (tiles, preview,
    region/zoom, Plotly data).
  - [docs/jit-ui-region-architecture.mmd](docs/jit-ui-region-architecture.mmd)
    ([PNG](docs/img/jit-ui-region-architecture.png) ·
    [SVG](docs/img/jit-ui-region-architecture.svg)) — the region interfaces +
    region tools and how OSD and Plotly each implement the overlay.
  - Diagram/SOW generators: [docs/gen_architecture_diagram.py](docs/gen_architecture_diagram.py),
    [docs/gen_jit_ui_visualization_sow.py](docs/gen_jit_ui_visualization_sow.py).
- **[docs/JIT_UI_visualization_library_SOW.docx](docs/JIT_UI_visualization_library_SOW.docx)** —
  statement of work for extracting/publishing this library (incl. test-coverage
  results and the example-server task).
- **[JIT-PLOTTING-SOW.docx](JIT-PLOTTING-SOW.docx)** — the original plotting SOW.
- **[REFACTORING-PLAN.md](REFACTORING-PLAN.md)** — the plan that shaped the
  current module/contract/implementation boundaries.

Related (host side, in jit-ui):

- **[USE-VISUALIZATION-LIB-IN-PIPELINE-DIALOG.md](../../apps/jit-ui/src/app/main/components/processing-pipeline/USE-VISUALIZATION-LIB-IN-PIPELINE-DIALOG.md)** —
  how the processing-pipeline dialog embeds `<jaxviz-visualization>` and drives it
  via `RoutingVisualizerService`.
- **[processing-pipeline/ARCHITECTURE.md](../../apps/jit-ui/src/app/main/models/processing-pipeline/ARCHITECTURE.md)** —
  the client/server processing-pipeline engines (OpenCV.js, transformers.js,
  cellpose, client slide-crop, server) that consume this library's region tools.

## Scientific references

**Segment Anything (SAM)** — the promptable segmentation foundation model.
> Kirillov, A. et al. *Segment Anything.* ICCV 2023. arXiv:[2304.02643](https://arxiv.org/abs/2304.02643).
> Code: [facebookresearch/segment-anything](https://github.com/facebookresearch/segment-anything).

**micro-sam** — SAM finetuned for microscopy (the `*_lm` models; default tool).
> Archit, A. et al. *Segment Anything for Microscopy.* Nature Methods (2025); bioRxiv:[2023.08.21.554208](https://doi.org/10.1101/2023.08.21.554208).
> Code: [computational-cell-analytics/micro-sam](https://github.com/computational-cell-analytics/micro-sam).

**patho-sam** — SAM finetuned for histopathology (the `*_histopathology` models).
> *Segment Anything for Histopathology.* arXiv:[2502.00408](https://arxiv.org/abs/2502.00408) (computational-cell-analytics).
> Code: [computational-cell-analytics/patho-sam](https://github.com/computational-cell-analytics/patho-sam).

**Cellpose** — generalist cellular segmentation (flow-field algorithm).
> Stringer, C. et al. *Cellpose: a generalist algorithm for cellular segmentation.* Nature Methods 18, 100–106 (2021). doi:[10.1038/s41592-020-01018-x](https://doi.org/10.1038/s41592-020-01018-x).
> Code: [MouseLand/cellpose](https://github.com/MouseLand/cellpose).

**Cellpose-SAM** — Cellpose built on a SAM ViT backbone (the automatic tool).
> Stringer, C. & Pachitariu, M. *Cellpose-SAM: superhuman generalization for cellular segmentation.* bioRxiv:[2025.04.28.651001](https://doi.org/10.1101/2025.04.28.651001).
> Model: [mouseland/cellpose-sam](https://huggingface.co/mouseland/cellpose-sam).

**MobileSAM** — the TinyViT encoder behind micro-sam ViT-T.
> Zhang, C. et al. *Faster Segment Anything: Towards Lightweight SAM for Mobile Applications.* arXiv:[2306.14289](https://arxiv.org/abs/2306.14289) (2023).
> Code: [ChaoningZhang/MobileSAM](https://github.com/ChaoningZhang/MobileSAM).

Runtime: [onnxruntime-web](https://github.com/microsoft/onnxruntime) (WebGPU/WASM
ONNX inference). Please cite the relevant model papers when publishing results
produced with these tools.

## Usage (host integration, brief)

Import `VisualizationModule`, render `<jaxviz-visualization>`, and provide the
DI ports (`TILE_ACCESS_PORT`, `IMAGE_STATE_PORT`, `REGION_IO_PORT`, `VIZ_CONFIG`,
and `CELL_SEGMENTER` for the cellpose adapter). Configure hosted SAM model URLs
once at startup:

```ts
import { setSamModelUrls } from '@jax-image/visualization';

setSamModelUrls('microsam-vit-t-lm',
  'https://huggingface.co/Ballon999/microsam-vit-t-lm-onnx/resolve/main/encoder.fp16.onnx',
  'https://huggingface.co/Ballon999/microsam-vit-t-lm-onnx/resolve/main/decoder.onnx');
```

`onnxruntime-web` WASM/JSEP sidecars must be served from `/assets/ort/`. See
jit-ui's `app.module.ts` for a full wiring example.
