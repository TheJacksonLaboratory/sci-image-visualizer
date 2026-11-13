# QA test plan

This plan lists the behaviours of SIV's visualization features as numbered test cases, one behaviour per case,
each with its preconditions, steps and expected result. It is written for the SQA team to verify a release,
but anyone can use it to check that a feature works as documented.

The expected results describe what the **current code** does. Where the code and earlier documentation
disagree, or where a behaviour looks like a defect, the case is tagged **⚠ see Known issues** and is listed on
[Known issues to confirm](known-issues.md). Record what you observe; do not fail a case for a behaviour that
page already describes, unless it changed.

## Test areas

| Page                                          | IDs                 | Covers                                                                                           |
| --------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| [Viewing](viewing.md)                         | `VIEW-001` …        | Toolbar, plot types, navigation, Channels & Histogram, stacks, 3D, slice editor, profiles, export |
| [Regions](regions.md)                         | `REG-001` …         | Drawing and editing tools, selection, undo/redo, context-menu region actions, shortcuts           |
| [Region Editor and classes](region-editor.md) | `RED-001` …         | Region Editor table and toolbar, classes and presets, GeoJSON/mask import and export, 3D classes  |
| [AI segmentation](segmentation.md)            | `SEG-001` …         | SAM box and point prompts, model picker, Cellpose, progress toasts, model caching                 |
| [Spatial omics](spatial-omics.md)             | `SPA-001` …         | Spatial omics 2D/3D, panel, colouring, selection, distribution charts, transcripts, fallbacks     |
| [Known issues to confirm](known-issues.md)    | `KI-01` …           | Suspected defects and documentation drift, with source references                                |

## How to use the plan

### Test IDs

- Every case has a stable ID: an area prefix and a three-digit number (`REG-014`).
- **IDs are never renumbered.** When a behaviour is removed, the case is marked *Retired in x.y.z* and keeps
  its number; new cases take the next free number at the end of the page, even if they belong to an earlier
  section. Results from different releases can therefore be compared ID by ID.
- Known issues use `KI-nn` and follow the same rule.

### Priorities

| Priority | Meaning                                                                                   | When to run                         |
| -------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| **P1**   | Core path: if it fails, the feature is unusable. Together the P1 cases form the smoke test. | Every release candidate, every browser |
| **P2**   | Important behaviour, defaults, limits and error messages users rely on.                     | Every minor release, main browser    |
| **P3**   | Edge cases, cosmetic details, rarely used options.                                          | Major releases, or when the area changed |

### Recording results

Use one of these outcomes per case and per browser:

| Outcome     | Use when                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------- |
| **Pass**    | The observed behaviour matches the expected result.                                           |
| **Fail**    | It does not. Note what you saw, attach a screenshot, and open an issue.                       |
| **Blocked** | The case cannot be run (missing data, a preceding failure, browser lacks WebGPU). Say why.     |
| **N/A**     | The case does not apply to this environment (for example a WebGPU-only case in the fallback run). |

Copy this template for a test run:

```markdown
## SIV x.y.z — test run <date> — <tester>

Environment: <browser + version> · <OS> · WebGPU: yes/no · <screen size> · <demo or JIT build>

| ID       | Outcome | Notes / issue link |
| -------- | ------- | ------------------ |
| VIEW-001 | Pass    |                    |
| VIEW-002 | Fail    | #123 — …           |
```

## Test environment

### Browsers

| Browser                     | WebGPU                                | Role                                                                 |
| --------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| Chrome (latest) — desktop   | Yes                                   | **Primary.** Run every case.                                         |
| Edge (latest) — desktop     | Yes                                   | Run P1 and P2.                                                       |
| Firefox (latest)            | From version 141 on supported systems | Run P1; repeat the WebGPU-dependent cases if WebGPU is available.    |
| Safari (latest)             | From version 26                       | Run P1.                                                              |
| Any browser, WebGPU **off** | No                                    | Run the fallback cases (`SPA-` fallback section, `VIEW-` 3D section). |

### Running without WebGPU

Several features (Surface, Volume, Isosurface, Spatial omics 3D, napari rendering) need WebGPU, and Spatial
omics 2D falls back to a WebGL drawing without it. To test the fallback paths:

- use a browser or system without WebGPU (the viewer asks for a WebGPU adapter once per page, with a 3 s
  timeout); or
- in Chrome/Edge, open `chrome://flags` (`edge://flags`), set **Unsafe WebGPU Support** / WebGPU-related flags to
  *Disabled*, or start the browser with `--disable-features=WebGPU`, and restart; or
- serve the page over plain `http://` from a non-localhost host (WebGPU needs a secure context).

Check `navigator.gpu` in the developer console: `undefined` means no WebGPU. Backend fallbacks are reported in
the console only (for example `[visualizer] spatial view drawn with WebGL (no WebGPU): …`), so keep the console
open during fallback runs.

### Screen sizes

| Size                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| 1920 × 1080         | Reference layout.                                                         |
| 1440 × 900          | Typical laptop; toolbar wraps to two rows.                                |
| 1280 × 720 or less  | Dialog widths switch to 90vw below 960 px; toolbar wraps further.         |
| High-DPI (Retina)   | Brush, eraser and wand sizes (readback in device pixels), screenshot crispness. |

## Test data

Most cases use the **live demo**, <https://thejacksonlaboratory.github.io/sci-image-visualizer/>, which shows a
gallery of samples on the left and the viewer on the right. The whole-slide (**WSI**) entries and the
**spatial-omics** folder are served by the JAX development tile server and need network access to it.

| Gallery entry                                    | Type                                         | Exercises                                                                                     |
| ------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `img01.png`                                      | Small 8-bit image (muscle section, grey)      | Region tools, wand, brush, region actions, Heatmap, intensity profiles                        |
| `img03.png`, `052_img.png`, `024_img.png`         | Small fluorescence / cell images              | Wand on bright objects, SAM point prompts                                                     |
| `img04.png`                                      | RGB fluorescence (blue nuclei, green cells)   | RGB channels, Channels & Histogram, SAM box prompt, Cellpose                                  |
| `002_img.png`                                    | RGB, many cells                               | Cellpose, many-region performance                                                             |
| `031_img.png`, `034_img.png`                     | RGB, green structures                         | Wand, Contour availability on RGB (must not be offered)                                       |
| `BF-FL_composite.png`                            | Large PNG composite (~12 MB)                  | Serverless large image, zoom, smoothing                                                       |
| TIFF `B16-69_O7_CFP-1_hyper.tif`                 | TIFF decoded in the browser                   | Client-side TIFF, multichannel or hyperstack handling                                          |
| TIFF `GFPA_IBA1_…_zstack_Series002.tif`          | Multichannel z-stack TIFF                     | Slice slider, ← / → keys, Volume/Isosurface, channel visibility                               |
| `micro-ct` folder (DCM slices)                   | Grayscale DICOM; right-click = z-stack        | Single DICOM slice, Contour, colormaps, z-stack, Volume, Isosurface, slice editor, Heatmap stack mode |
| WSI `CMU-1 · 1.5 Gpx (CC0)`                      | Gigapixel H&E, tiled, with pixel size          | Tiled loading, minimap, scale bar, µm² areas, patho-sam, export composite                      |
| WSI `BC18 · 22 Gpx (NDPI)`                       | Very large NDPI                               | Tile loading at scale, region sources                                                         |
| WSI `Sirius Red · 0.5 Gpx (NDPI)`                | Brightfield stain                             | Wand on stained tissue                                                                        |
| WSI `2-channel fluorescence · 0.35 Gpx`          | Multichannel, tiled, >8-bit                   | Channel table, LUT row, native histogram, 16-bit TIFF export                                  |
| WSI `2-channel · multichannel:false (repro)`     | Regression sample                             | Multichannel flag handling                                                                    |
| WSI `Project002 · 2-channel BF · 0.28 Gpx (z=13)` | Tiled z-stack                                | Slice slider on a tiled stack, `preserveViewport`                                             |
| WSI `Project002 · 2ch x 27z stack · 7.5 Gpx`     | Large tiled z-stack                           | Stack loading, Cancel, Volume                                                                 |
| `spatial-omics` → Adult mouse brain Visium H&E   | 2,688 spots, 18,078 genes, H&E image           | Spatial omics 2D, colour by group/gene/measurement, Select from ROIs, all distribution charts |
| `spatial-omics` → SYNTHETIC demo-brain           | ~2,000 spots, synthetic H&E, fabricated values | Spatial omics 2D (small, fast)                                                                |
| `spatial-omics` → Mouse embryo seqFISH           | 19,416 cells, no image, 6 embeddings           | Dataset without image (pixel modes withheld), Embedding chart, lasso                          |
| `spatial-omics` → Allen Brain Cell Atlas         | MERFISH 3D, 3.7 M cells (and 1-in-10 subset), CCF volume | Spatial omics 3D, volume, class tree, class-volume selection, large data             |

!!! note "What the demo cannot test"
    The demo server has no transcript (Xenium) dataset, no gene-heatmap **All genes** data, no cell
    segmentations, no server region import/save and no annotation-class persistence (`PREFERENCES_PORT`).
    Run those cases in **JAX Image Tools (JIT)**, which provides the server side. Cases that need JIT say so in
    their preconditions.

## Smoke test

The smoke test is every **P1** case. In order:

1. Viewing: all P1 `VIEW-` cases (open each sample type, plot types, navigation, channels, stack, 3D).
2. Regions: all P1 `REG-` cases (draw with each tool, select, move, delete, undo/redo).
3. Region Editor: all P1 `RED-` cases (table, classes, GeoJSON export and re-import).
4. Segmentation: all P1 `SEG-` cases (SAM box, SAM point, Cellpose once each).
5. Spatial omics: all P1 `SPA-` cases (open a dataset, colour it, select from a region, show a chart).

Run the smoke test in the primary browser and, for the WebGPU-dependent P1 cases, once with WebGPU off.

## Related

- [Reference](../reference/index.md): what each feature does, in full.
- [Known issues to confirm](known-issues.md): behaviours under investigation.
