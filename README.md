# @jax-data-science/sci-image-visualizer

[![npm](https://img.shields.io/npm/v/%40jax-data-science%2Fsci-image-visualizer.svg)](https://www.npmjs.com/package/@jax-data-science/sci-image-visualizer)
[![CI / CD](https://github.com/TheJacksonLaboratory/sci-image-visualizer/actions/workflows/ci-cd.yaml/badge.svg)](https://github.com/TheJacksonLaboratory/sci-image-visualizer/actions/workflows/ci-cd.yaml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A framework-style **Angular 17** library for **interactive scientific image
visualization and annotation**. It renders large / multi-channel images through
pluggable backends — a tiled [OpenSeadragon](https://openseadragon.github.io/)
viewer, [Plotly](https://plotly.com/javascript/) 2D/3D plots, and a
[napari-js](https://www.npmjs.com/package/napari-js) **WebGPU** backend — behind a
single `IVisualizer` contract, and provides a rich set of on-canvas region /
annotation tools including **AI-assisted segmentation that runs entirely in the
browser** (WebGPU / WASM via [`onnxruntime-web`](https://github.com/microsoft/onnxruntime)).

Extracted from [jit-ui](https://github.com/TheJacksonLaboratory/jit-ui) (JAX Image
Tools) — see [jit-ui#80](https://github.com/TheJacksonLaboratory/jit-ui/issues/80) —
so the same viewer can be reused across the `@jax-data-science` portfolio. Open
source; contributions welcome.

## Installation

```bash
npm install @jax-data-science/sci-image-visualizer
```

Install the Angular / rendering **peer dependencies** your app doesn't already
have:

```bash
npm install @angular/animations @angular/router primeng \
  openseadragon plotly.js-dist-min image-js file-saver buffer onnxruntime-web
```

### Peer dependencies

| Package | Range | Notes |
|---|---|---|
| `@angular/common` · `core` · `forms` · `animations` · `router` | `^17.3.0` | Angular 17 (animations + router are needed by the PrimeNG components) |
| `rxjs` | `^7.8.0` | |
| `primeng` | `^17.18.0` | toolbar / dialogs / table / dropdown UI |
| `openseadragon` | `^6.0.2` | tiled (deep-zoom) image backend |
| `plotly.js-dist-min` | `^3.0.1` | 2D/3D plot backend |
| `image-js` | `^0.35.6` | client-side image processing |
| `file-saver` | `^2.0.5` | GeoJSON / mask export |
| `buffer` | `^5.7.1` | |
| `onnxruntime-web` | `~1.26.0` | browser SAM / cellpose inference (WebGPU/WASM) |
| `cellpose-js` | `^0.3.0` | **optional** — automatic cellpose-SAM segmentation |
| `napari-js` | `^0.11.0` | **optional** — WebGPU rendering backend |

`fast-png` and `tslib` are bundled as regular dependencies (you don't install
them). See [Quick start](#usage-host-integration-brief) below for wiring.

## Live demo & running the example

A serverless, **in-browser** example lives in
[`examples/browser-image/`](examples/browser-image/): a gallery of sample images
that render in the viewer with the region + zoom tools, with no backend at all
(the "Mode B" path — each image is a self-contained `tiled: false` source).

**Live demo:** <https://thejacksonlaboratory.github.io/sci-image-visualizer/>
— published by CI (`.github/workflows/pages.yaml`) to GitHub Pages. Goes live once
the repo is public (or GitHub Pages is enabled for the org's internal repos).

### Run on localhost

```bash
npm install            # repo + example toolchain (Vite + Analog)
git lfs pull           # fetch the sample-image bytes (they're stored in Git LFS)
npm run build          # build the library into dist/ (the example consumes it)
npm run start:example  # dev server → http://localhost:5173
```

`npm run build:example` produces a static build in `examples/browser-image/dist/`.
See [`examples/browser-image/README.md`](examples/browser-image/README.md) for the
full walkthrough (adapters, TIFF handling, the Angular-17 toolchain note).

## Highlights

- **Three rendering backends** — a tiled [OpenSeadragon](https://openseadragon.github.io/)
  viewer, [Plotly](https://plotly.com/javascript/) plots, and a
  [napari-js](https://www.npmjs.com/package/napari-js) **WebGPU** backend — behind
  one `IVisualizer` contract; the host picks per plot type via `RoutingVisualizerService`.
- **Plot types** — Image (OSD), Plotly (Heatmap, Contour, Scatter 2D, Surface 3D,
  Scatter 3D, Isosurface), and napari · WebGPU (Image, Scatter 2D, Surface,
  Scatter 3D, Volume, Isosurface).
- **Region / annotation tools** — selection, rectangle, polyline, freeform,
  polygon + vertex editing, move, Bézier↔polygon, magic wand, brush, vertex eraser.
- **Channels & histogram** — brightness/contrast/gamma, per-channel display,
  colormaps / LUTs.
- **Region editor** — a Regions panel to list, select, rename, classify, recolor,
  import/export (GeoJSON), and delete regions.
- **Image stacks** — a z-stack can be a single server-tiled file (internal z) or
  a set of self-contained per-slice image URLs (`IImageInfo.tiled === false`, one
  URL per slice), e.g. a folder of numbered files assembled by the host. Slices
  load on demand as you scrub.
- **Per-slice ROIs + QuPath planes** — GeoJSON import/export carries the QuPath
  image-plane convention (`geometry.plane.z`), and the host can supply one ROI
  set per slice (`IImageInfo.roiJsonStrs`) that the viewer swaps on scrub.
- **Browser-side segmentation** — promptable SAM (box + interactive points) and
  automatic cellpose-SAM, all client-side (see below).

## Visualization

Open an image and it renders through whichever backend best fits it; the
`RoutingVisualizerService` switches backends per plot type and keeps the shared
state (regions, channels, zoom) consistent across them.

### OpenSeadragon — tiled image view
The default **Image** view is a natively tiled, deeply zoomable raster powered by
[OpenSeadragon](https://openseadragon.github.io/). It streams pyramid tiles (the
host supplies them through the `TILE_ACCESS_PORT`, e.g. a `/tiles/info` + `/tile`
service), so gigapixel slides pan and zoom smoothly without loading the whole
image. It includes:

- a **navigator minimap** and a physical-units **scale bar**;
- **click-to-zoom** toward the clicked point, scroll-zoom, and drag-pan;
- a **raw-pixel vs. smoothing** toggle — images open at nearest-neighbour so
  zoomed-in pixels stay crisp for inspection; toggle **Smoothen** for bilinear;
- **WYSIWYG PNG download** of the current view and a **fit-to-view / autoscale**
  reset.

### Plotly — plots & 3D
Non-image plot types render with [Plotly](https://plotly.com/javascript/) and
support "real zooming" — a downscaled overview that re-fetches higher-resolution
data as you zoom in:

- **Contour** and **Scatter (regions)** 2D plots;
- **Surface 3D**, **Scatter 3D**, and **Isosurface** for z-stacks, with an
  **isosurface band** slider and full **3D camera** controls (zoom, pan, orbit,
  turntable, reset);
- scalar/3D types expect a grayscale image (the volume types also need a z-stack).

### napari-js — WebGPU
GPU-accelerated renderings via [napari-js](https://www.npmjs.com/package/napari-js)
(WebGPU), selectable from the plot-type menu as the "napari · WebGPU" variants of
Image, Scatter 2D, Surface, Scatter 3D, **Volume**, and **Isosurface**. It
assembles the volume from the slice endpoints with a runtime **decimate factor**
(resolution slider, default ½), a surface **wireframe** toggle, a 3D **axes / scale
gizmo**, an in-view **Z-height drag handle** for the volume, **cancellable** loading,
and **multichannel volume** compositing (one additive tinted layer per channel).
Regions and display options stay in sync with the other backends via the shared
stores.

When a stack is open, a slice slider (Image view) or single-image/stack toggle
(other views) navigates the z-dimension. A stack may be one server-tiled file
(internal z) or a set of self-contained per-slice URLs (`IImageInfo.tiled ===
false`) — the latter (e.g. a host-assembled folder of numbered files) fetches
`urls[z]` per slice on demand. For a per-slice stack the host can also supply a
matching ROI GeoJSON per slice (`IImageInfo.roiJsonStrs`), which the viewer
shows for the displayed slice and swaps as you scrub.

### Intensity profiles *(work in progress)*
A line-ROI tool draws coloured lines and plots intensity along each one in a live
floating inset chart that re-samples at the current zoom. It works today but the
API/UX are still stabilizing (see [In progress / roadmap](#in-progress--roadmap)).

## Regions & annotation

Regions are stored in a shared **region store** and use a GeoJSON-friendly model
(rectangles, polygons, polylines, Bézier curves) with an optional zero-based
`z` slice — GeoJSON import/export uses QuPath's `geometry.plane.z` (written only
for non-default slices, so single-plane images round-trip byte-identically).
Every tool writes to the same store, so regions persist across backend/plot-type
switches and are editable from the Regions panel. The on-canvas tools:

- **Selection** — neutral mode; deactivates any drawing tool.
- **Rectangle**, **Polyline** (open `LineString`), **Freeform** (drag-to-draw
  closed polygon), and **Polygon** (click vertices, click first to close).
- **Vertex editing** — add vertex, delete vertex, and **move region**.
- **Bézier ↔ polygon** — convert a region to a smooth Bézier curve or back.
- **Magic wand** — grow a region from similar-valued pixels around the click;
  `Ctrl`/`Cmd` for exact-match flood fill; drag to extend; `Shift` to erase;
  a sensitivity slider tunes strictness. Growing into another region merges them.
- **Brush** — paint/erase a region with a circular brush (QuPath-style); a size
  slider sets the diameter, `Shift` erases, and erasing across a region can split it.
- **Vertex eraser** — remove vertices within a radius from any region.
- **Delete** the selected region.

Wand- and brush-drawn regions default to the `legend` class; SAM/cellpose masks
inherit the color of the rectangle they came from.

## Channels, histogram & colormaps

A floating **Channels & Histogram** dialog controls how intensities are mapped to
display: **brightness / contrast / gamma**, **per-channel** display for
multi-channel images, and — for grayscale — **colormap / LUT** selection with a
**reverse** toggle (default: inverted greys). Changes apply live in both backends.

## Region editor (Regions panel)

The `<region-editor>` component is the Regions tab: a table of all regions
where you can **select**, **rename**, assign a **classification / class name**,
set **per-class colors**, toggle labels, **import / export ROIs** as GeoJSON
(`REGION_IO_PORT`), and **delete**. Selecting a row highlights the region on the
canvas (and vice-versa), so it pairs with the on-canvas tools above.

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
`browser-onnx-tools` project.

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

## In progress / roadmap

Work that is landed-but-unstable or planned (not yet available):

- **Intensity profile tool** *(work in progress — not yet stable)* — coloured line
  ROIs with a floating inset chart that plots intensity along each line and updates
  live as the line is dragged. Usable today but the API/UX and multi-line/stack
  behaviour are still settling.
- **Example / test server + demos** *(planned)* — a small example server, bundled
  with the library, that powers a set of runnable **demos** showcasing the
  image-visualization use cases (tiled OSD viewing, Plotly plots, region tools,
  and browser-side SAM/cellpose segmentation) against sample images — so the
  library can be evaluated and developed standalone, outside jit-ui. Tracked in
  the library-extraction SOW ([docs/JIT_UI_visualization_library_SOW.docx](docs/JIT_UI_visualization_library_SOW.docx)).
- **SAM 3 model** *(planned)* — a `variant: 'sam3'` decoder path + export tooling
  (SAM 2/3 use a different mask I/O than the current SAM-v1 path). See
  [docs/sam-segmentation-design.md](docs/sam-segmentation-design.md).
- **int8 patho-sam validation** — the `patho-sam-vit-b-int8` option is sanity-checked
  (IoU ~0.99 vs fp16 on a synthetic prompt) but not yet validated on real H&E
  slides, where int8 ViT attention can degrade on subtle boundaries.

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
- **[REFACTORING-PLAN.md](docs/REFACTORING-PLAN.md)** — the plan that shaped the
  current module/contract/implementation boundaries.

Related (host side, in jit-ui):

- **[USE-VISUALIZATION-LIB-IN-PIPELINE-DIALOG.md](https://github.com/TheJacksonLaboratory/jit-ui/blob/master/apps/jit-ui/src/app/main/components/processing-pipeline/USE-VISUALIZATION-LIB-IN-PIPELINE-DIALOG.md)** —
  how the processing-pipeline dialog embeds `<visualizer>` and drives it
  via `RoutingVisualizerService`.
- **[processing-pipeline/ARCHITECTURE.md](https://github.com/TheJacksonLaboratory/jit-ui/blob/master/apps/jit-ui/src/app/main/models/processing-pipeline/ARCHITECTURE.md)** —
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

**Rendering & runtime libraries**

- **OpenSeadragon** — deep-zoom tiled image viewer.
  [openseadragon.github.io](https://openseadragon.github.io/) ·
  [GitHub](https://github.com/openseadragon/openseadragon).
- **Plotly.js** — interactive 2D/3D plotting.
  [plotly.com/javascript](https://plotly.com/javascript/) ·
  [GitHub](https://github.com/plotly/plotly.js).
- **napari** — multi-dimensional (n-D) scientific image viewer; the WebGPU
  rendering backend here (`napari-js`) is modeled on it.
  [napari.org](https://napari.org) · [GitHub](https://github.com/napari/napari) ·
  doi:[10.5281/zenodo.3555620](https://doi.org/10.5281/zenodo.3555620).
- **onnxruntime-web** — WebGPU/WASM ONNX inference (the SAM & cellpose runtime).
  [GitHub](https://github.com/microsoft/onnxruntime).

Please cite the relevant model papers when publishing results produced with these
tools.

## Usage (host integration, brief)

Import `VisualizationModule`, render `<visualizer>` (and `<region-editor>` for
the Regions panel), and provide the DI ports (`TILE_ACCESS_PORT`,
`IMAGE_STATE_PORT`, `REGION_IO_PORT`, `VIZ_CONFIG`, and `CELL_SEGMENTER` for the
cellpose adapter). Configure hosted SAM model URLs once at startup:

```ts
import { setSamModelUrls } from '@jax-data-science/sci-image-visualizer';

setSamModelUrls('microsam-vit-t-lm',
  'https://huggingface.co/Ballon999/microsam-vit-t-lm-onnx/resolve/main/encoder.fp16.onnx',
  'https://huggingface.co/Ballon999/microsam-vit-t-lm-onnx/resolve/main/decoder.onnx');
```

`onnxruntime-web` WASM/JSEP sidecars must be served from `/assets/ort/`. See
jit-ui's `app.module.ts` for a full wiring example.

Each embeddable component has a plain, unprefixed selector (used here and
throughout jit-ui): `visualization`, `region-editor`, `plotting-toolbar`. The
region-editor and toolbar additionally expose a `jaxviz-`-prefixed alias
(`jaxviz-region-editor`, `jaxviz-toolbar`) for collision-safe use in the
published library.

## Development

```bash
npm install
npm run build       # ng-packagr → ./dist  (the publishable package)
npm test            # jest (jest-preset-angular)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format      # prettier --write
```

`npm run build` emits a complete, publishable Angular package into `dist/`
(FESM2022 + ESM2022 bundles, type declarations, assets, README, LICENSE).

## Releasing

Publishing is automated by CI (`.github/workflows/ci-cd.yaml`): pushing a
`v*.*.*` tag whose version matches `package.json` and is reachable from `main`
(or a `release/x.y.z` branch) builds, tests, and runs
`npm publish --access public --provenance` from `dist/`. It requires an
`NPM_TOKEN` repository secret with publish rights to the `@jax-data-science`
npm scope.

```bash
# bump package.json to x.y.z first, commit, then:
git tag vx.y.z && git push origin vx.y.z
```

## Contributing

Issues and pull requests are welcome. Please run `npm run lint`, `npm test`, and
`npm run build` before opening a PR. Design and architecture notes live in
[`docs/`](docs/).

## License

[MIT](./LICENSE) © The Jackson Laboratory.
