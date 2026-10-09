# Segmentation: SAM and cellpose

All segmentation runs **client-side** — models are fetched once (a progress
toast is shown), cached, then executed with `onnxruntime-web` (WebGPU where
supported, WASM otherwise). Generated regions inherit the color of the rectangle
they came from.

## Box-prompt SAM — "Segment"
Draw one or more **rectangles** around objects, then click **Segment**. Each
rectangle is sent to SAM as a box prompt and replaced by the segmented mask.

## Interactive point prompts
Click directly on an object to segment it as a **new** region (each click is an
independent object — clicking another object won't grow the previous one).
`Shift`/`Alt`-click adds an *exclude* point that refines the current object;
`Enter` commits, `Esc` undoes.

## Model picker
A dropdown on the Segment button chooses the SAM model; the choice applies to
**both** the box and point tools. An info button summarizes the trade-offs.

## Cellpose — automatic
Draw rectangles, then click **Cellpose** to auto-segment every cell inside each
rectangle (client-side cellpose-SAM via [`cellpose-js`](https://www.npmjs.com/package/cellpose-js)) —
one region per detected cell, no per-object clicking. (Cellpose-SAM is *not*
promptable, so it's the automatic tool rather than a model in the SAM picker.)

## Models

Promptable SAM models are SAM-v1 encoder/decoder ONNX pairs (the encoder runs
once per image; the decoder runs per prompt). The registry lives in
[`src/lib/toolbar/segmentation/sam-model-registry.ts`](../../src/lib/toolbar/segmentation/sam-model-registry.ts); the host supplies hosted URLs via
`setSamModelUrls(...)`. Export/quantization tooling lives in the sibling
`browser-onnx-tools` project.

| Picker id | Domain | Encoder | Runs on | HF model |
|---|---|---|---|---|
| `microsam-vit-t-lm` *(default)* | light microscopy | TinyViT, ~14 MB fp16 | WASM¹ | [jax-image-tools/microsam-vit-t-lm-onnx](https://huggingface.co/jax-image-tools/microsam-vit-t-lm-onnx) |
| `microsam-vit-b-lm` | light microscopy | ViT-B, ~172 MB fp16 | WebGPU | [jax-image-tools/microsam-vit-b-lm-onnx](https://huggingface.co/jax-image-tools/microsam-vit-b-lm-onnx) |
| `patho-sam-vit-b` | histopathology (H&E) | ViT-B, ~172 MB fp16 | WebGPU | [jax-image-tools/patho-sam-vit-b-onnx](https://huggingface.co/jax-image-tools/patho-sam-vit-b-onnx) |
| `patho-sam-vit-b-int8` | histopathology (H&E) | ViT-B, ~100 MB int8 | WASM | [jax-image-tools/patho-sam-vit-b-onnx](https://huggingface.co/jax-image-tools/patho-sam-vit-b-onnx) (`encoder.int8.onnx`) |
| cellpose-SAM *(automatic)* | cells (generalist) | SAM ViT + flow head | WebGPU/WASM | [jax-image-tools/cellpose-sam-onnx](https://huggingface.co/jax-image-tools/cellpose-sam-onnx) |

¹ TinyViT's fp16 attention overflows on the onnxruntime-web WebGPU EP (returns an
empty mask); it is numerically correct and fast on WASM, so its encoder is pinned
to WASM. int8 models also run on WASM (no WebGPU int8 matmul).

micro-sam and patho-sam are distributed through micro-sam's model registry
(`vit_*_lm`, `vit_*_histopathology`); SAM 3 is a planned addition (it needs a
`variant: 'sam3'` decoder path, since SAM 2/3 differ in mask I/O). See
[`../design/sam-segmentation-design.md`](../design/sam-segmentation-design.md) for the design.

## Host configuration

Configure the hosted SAM model URLs once at startup. A model without URLs is
not offered in the picker.

```ts
import { setSamModelUrls, setOrtWasmBase } from '@jax-data-science/sci-image-visualizer';

setSamModelUrls('microsam-vit-t-lm',
  'https://huggingface.co/jax-image-tools/microsam-vit-t-lm-onnx/resolve/main/encoder.fp16.onnx',
  'https://huggingface.co/jax-image-tools/microsam-vit-t-lm-onnx/resolve/main/decoder.onnx');

// Only if the onnxruntime-web sidecars are not served from /assets/ort/:
setOrtWasmBase('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/');
```

The automatic tool uses the `CELL_SEGMENTER` token, which defaults to
`CellposeSegmenterService`. Override it only to plug in a different segmenter.
