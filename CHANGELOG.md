# Changelog

All notable changes to `@jax-data-science/sci-image-visualizer`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries before 0.2.7 were reconstructed from the git history at the time this
file was added.

## [Unreleased]

## [0.2.14] — 2026-08-08

### Fixed

- **The scale re-crop produced a 0x0 image.** `ImageBitmap.close()` zeroes the
  bitmap's width and height, and those were read _after_ closing it — so the
  crop came back as a 0x0 image carrying a full pixel buffer. Inference then ran
  on nothing and reported no detections, with no error raised anywhere.
- **`downsamplingFactor` is now seeded in the toolbar tool's defaults.** The
  dialog exposed the control but nothing initialised it, so it read as 0 and the
  re-crop never ran — which is the only reason the bug above stayed hidden here.

## [0.2.13] — 2026-08-08

### Added

- **YOLO detection toolbar tool.** A split button next to the cellpose tool:
  run, pick the checkpoint, open parameters. Unlike the SAM and cellpose tools
  it takes no prompt — a detector finds objects across a field rather than being
  pointed at one — so it runs on the current view with nothing to draw first.

  The parameter dialog carries the same vocabulary as the pipeline step and the
  server tool (confidence, per-tile IoU, cross-tile merge, tile overlap,
  downsampling factor, segmentation mode, min area, outline simplification), so
  a result obtained here is reproducible in either. Switching checkpoint
  re-seeds the parameters from that model's own registry defaults, which encode
  the scale and crowding it was trained for.

- **`InstanceSegmentOptions.downsamplingFactor`** — the scale to run at, as a
  divisor of full resolution, matching the server's meaning. It matters more
  than any threshold: run a detector at the wrong object scale and it finds
  nothing. The toolbar tool honours it by re-cropping the region through
  `TileAccessPort`, since a tile-backed image still holds detail the displayed
  pixels have discarded.

## [0.2.12] — 2026-08-08

### Fixed

- **Detections without an outline are no longer discarded.** A detection with no
  mask was dropped, which silently emptied the entire result in detection mode:
  no masks means no polygons, so every object vanished and the caller saw
  nothing at all despite the model having found them. The server does not behave
  that way either — it always writes a box feature and only _adds_ segmentation
  outlines when asked. Callers now receive the box and decide what to do with it.

## [0.2.11] — 2026-08-08

### Changed

- **YOLO runs now relay the worker's own phase narration** instead of deriving a
  status from tile counts. Tile counts say nothing until the first tile
  completes, which is exactly the stretch where a first run is compiling WebGPU
  shaders — so the UI sat on one unchanging message through the longest pause of
  the run. Requires `yolo-segdetect-js@^0.1.2`, which reports the phases.

## [0.2.10] — 2026-08-08

### Added

- **`InstanceSegmentOptions.signal`** — cancellation for a YOLO run. Previously
  the contract had no way to express it, so a host holding an `AbortController`
  could not stop a run at all; the only escape was reloading the page.
  Cancellation is cooperative and lands at a tile boundary.
- **`InstanceSegmentOptions.withMasks`** — run detection without mask assembly.
  Mask assembly dominates a run's cost, so a host in detection mode should not
  pay for it. Outline tracing follows the same flag; there is nothing to trace
  without masks.
- **`InstanceSegmentProgress.onBytes`** — raw download byte counts alongside the
  0..1 fraction. A fraction cannot be converted back into bytes, so a host that
  renders a size had to invent the numbers, which showed up as "0 MB / 0 MB".

### Changed

- Requires `yolo-segdetect-js@^0.1.1`, which bounds mask assembly. Under 0.1.0 a
  detection with an out-of-range box could make a run appear to hang.

## [0.2.9] — 2026-08-08

### Added

- **Browser YOLOv8-seg instance segmentation**, backed by the new
  [`yolo-segdetect-js`](https://www.npmjs.com/package/yolo-segdetect-js) package
  (lazy-imported, so apps that never run it pay nothing in their initial bundle).

  A new port rather than an extension of `ICellSegmenter`: that contract returns
  a per-pixel label map, which suits densely packed cells but cannot represent
  what a detector produces — overlapping instances, each with its own class and
  confidence. `IInstanceSegmenter` / `INSTANCE_SEGMENTER` returns polygon rings
  in image pixels instead, ready to become `Region`s without a second conversion.

- **`YOLO_MODELS` registry**, mirroring `SAM_MODELS`: the four published
  checkpoints on public HF URLs by default, repointable at private hosting via
  `setYoloModelUrls`. Each entry carries the defaults its checkpoint was trained
  for — the embryo models want heavy tile overlap and loose merge thresholds
  because their objects are large and touch — so a host that just picks a model
  gets sane behaviour without knowing any of that.

- **`YoloSegmenterService`**, the default `IInstanceSegmenter`. Unlike
  `CellposeSegmenterService` it caches **per model id**, since there are four
  checkpoints rather than one; a failed load is evicted so the next caller
  retries instead of inheriting a rejected promise.

### Fixed

- **`YoloSegmenterService.dispose()` no longer leaks a model that is still
  loading.** It enumerated only loaded instances, so an in-flight load was
  skipped, then finished, re-populated the cache and left a live worker and ORT
  session behind — after disposal had reported success. Disposal now awaits an
  in-flight load and releases what it built, while leaving alone any newer load
  that started in the meantime.

## [0.2.8] — 2026-08-07

### Fixed

- **`minPixelRatio` is back to OpenSeadragon's default `0.5`.** The value of `1`
  introduced in 0.2.7 was based on a misreading of the option and made zoom
  **worse than stock**. From `TiledImage._getLevelsInterval` in OpenSeadragon
  6.0.2:

  ```
  highestLevel = floor( log2( currentZeroRatio / minPixelRatio ) )
  ```

  `minPixelRatio` is a floor on how small a tile pixel may shrink, and it
  _divides_ into the ratio — so **raising it selects a coarser level**, not a
  finer one. OSD's own comment on the default says as much: _"closer to 0 draws
  tiles meant for a higher zoom at this zoom"_.

  Measured live on a flat 22304×24528 image whose pyramid levels are
  697/1394/2788/5576/11152/22304, with OSD's formula predicting the selected
  level correctly in all nine trials:

  | `minPixelRatio`          | zoom 2               | zoom 8               | ≈1:1                    |
  | ------------------------ | -------------------- | -------------------- | ----------------------- |
  | `1.0` (0.2.7)            | 1.34× upscaled       | 1.34× upscaled       | 1.86× upscaled          |
  | **`0.5` (this release)** | 0.67× — no upscaling | 0.67× — no upscaling | 0.93× → full resolution |
  | `0.25`                   | 0.33×                | 0.33×                | 0.93×                   |

  `0.5` is therefore what actually delivers "never upscaled below native, full
  resolution at 1:1". `0.25` is not an improvement: it jumps two rungs finer and
  fetches roughly 4× the tiles for no visible gain, and the ingress does not
  cache tiles (verified: 815 of 815 requests reached the service), so every
  viewer pays that cost.

  The value is set explicitly rather than deleted so the intent stays greppable
  and the test can pin it. `openseadragon-viewer-options.spec.ts` now asserts
  `0.5` and was mutation-checked — raising it back to `1` fails the suite.

  What actually fixed soft zoom on flat images was **server-side**: gap-filling
  pyramid levels, which removed a 24× hole between the preview size and full
  resolution. This library setting was never the lever.

## [0.2.7] — 2026-08-07

> **Superseded by 0.2.8.** The `minPixelRatio: 1` change below is based on a
> misreading of the option — it selects _coarser_ levels, not finer — and was
> reverted. See 0.2.8.

### Changed

- **OpenSeadragon switches to a finer pyramid level as soon as the current one
  would be upscaled at all** (`minPixelRatio: 1`). OSD's default of `0.5`
  tolerates displaying a level at up to 2× magnification before fetching the
  next one, which reads as a soft image that abruptly sharpens once the
  threshold is crossed. At `1` the displayed level always has at least one tile
  pixel per screen pixel, so the only visible pixellation is past 1:1 — where
  the blocks are genuine source pixels (`imageSmoothingEnabled: false` already
  renders those crisply).

  This trades tile volume for sharpness: finer levels are requested at lower
  zooms than before. On **flat (non-pyramidal) images it is not a fix on its
  own** — their descriptors have no rungs between the preview size and full
  resolution (measured on dev, `NZ.tif` steps 931×1024 → 22304×24528, a 24×
  jump), so there is no finer level to switch to and the setting only moves the
  jump to full-resolution tiles to a lower zoom. Pair it with gap-filling
  pyramid levels server-side.

### Added

- `openseadragon-viewer-options.spec.ts` — captures the options object actually
  handed to the OSD factory and asserts the values the viewer depends on
  (`minPixelRatio: 1`, `maxZoomPixelRatio: 20`, `minZoomImageRatio: 0.01`).
  These are OpenSeadragon config keys rather than library code: OSD silently
  falls back to its own defaults if one is misspelled or renamed upstream, so
  they were previously invisible to both the test suite and grep.
- This `CHANGELOG.md`.

### Fixed

- Example (dev server only): the library's web workers load again, so SAM
  segmentation and the region editor's mask export no longer fail with "SAM
  worker crashed". The library starts its workers with
  `new Worker(new URL('./x.worker', import.meta.url))`; Vite's dependency
  pre-bundling copies that URL into the optimized chunk **without** emitting the
  worker body, so the request resolved to `node_modules/.vite/deps/x.worker`
  where nothing exists, the dev server answered with `index.html`, and the
  browser rejected the script for its `text/html` MIME type. A small
  `apply: 'serve'` plugin now rewrites those requests to the real worker bundles
  `npm run bundle-workers` emits beside the FESM. The library itself is
  unchanged and production builds never needed this — rollup resolves
  `./x.worker` and emits proper worker chunks.

## [0.2.6] — 2026-08-05

### Fixed

- A newly selected image is no longer silently discarded while another is still
  rendering — a newer image now **preempts** the in-flight render instead of
  being dropped ([#5](https://github.com/TheJacksonLaboratory/sci-image-visualizer/issues/5)).
- Added `renderToken`, a monotonic render generation. All `RenderOrchestrator`
  callbacks bail when their token is stale, so a superseded render can no longer
  paint, clear `running`, release the newer render's overlay (the indefinite
  loading-overlay hang), or apply its ROIs.
- `renderPhase` bails before loading starts, and the render being replaced calls
  `plotService.cancelLoading?.()` so the napari backend stops streaming frames.

## [0.2.5] — 2026-07-30

### Fixed

- Display changes (channels, colormaps, window/level) no longer destroy
  OpenSeadragon tile caches mid-drag.
- The library renders its own toast outlets instead of depending on the host
  providing them.

### Added

- Example: multichannel and z-stack images served from the tile server.

### Changed

- CI moved to Node 24 and current GitHub Action majors.

## [0.2.4] — 2026-07-27

### Changed

- `cellpose-js` is a regular dependency rather than a peer dependency.

## [0.2.3] — 2026-07-27

### Changed

- Widened the `cellpose-js` peer range to `^0.4.1`.

### Added

- Example: server-side tile + region-zoom path for gigapixel images, the Sirius
  Red gigapixel slide in the tiled gallery, and a dev GKE deployment wired to
  the live demo.

### Fixed

- Example: heatmap preview for tiled images; cellpose worker loading under Vite
  dev.

## [0.2.2] — 2026-07-25

### Added

- 3D: multichannel **Surface** follows the pane-selected channel.

## [0.2.1] — 2026-07-24

### Added

- 3D: serverless multichannel **Volume** / **Isosurface**, and **Surface** for
  any image.

### Fixed

- Example: multichannel images stay scalar-gradable so 3D modes remain
  available.

## [0.2.0] — 2026-07-23

### Added

- Serverless multichannel compositing in the OpenSeadragon view, with
  per-channel intensity histograms.
- Client-side intensity histogram for the simple (`tiled: false`) path.
- npm publish provenance.

## [0.1.0] — 2026-07-23

### Added

- Initial public release: OpenSeadragon tiled image view, Plotly plots and 3D,
  napari-js WebGPU renderings, regions & annotation, channels/colormaps, and
  browser-side SAM and cellpose segmentation.

[Unreleased]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.14...HEAD
[0.2.14]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/releases/tag/v0.1.0
