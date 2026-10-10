# OpenSeadragon backend

`OpenSeadragonVisualizerService` renders the **image** plot type as a natively
tiled, zoomable raster. It is the primary image backend: Plotly keeps the
scientific/data plot types and napari-js the WebGPU ones. It advertises only
`ViewerFeature.ImageDisplay`, but within that it does client-side display
(window/gamma/colormap/invert, per-channel tints), region overlays and tools,
a z-stack slice cache, and a serverless "simple" mode.

## Module map

| File | Role |
|------|------|
| `openseadragon-visualizer.service.ts` | The coordinator: `load()` / `plot()` / `setZIndex()` / teardown, the open wiring, tool gating and the `IVisualizer` stubs. Everything below is built by it and reads its live state through host closures. |
| `openseadragon-viewer-options.ts` | `buildViewerOptions`, the pure OpenSeadragon options object (and the tuning notes on its values), plus the multi-image advisory silencer. |
| `osd-viewer-mount.ts` | Viewer creation and the always-settling open handshake. |
| `osd-tile-source.ts` | Pure: the `GET /tile` TileSource from the descriptor's real per-level sizes, and `planTiledMount` (per-channel vs server-composited). |
| `tile-recolor.ts` | `OsdTileRecolorer`: the store subscription, the coalesced invalidation with its display token, and the tile/channel recolor (see "Recolor invariant"). Owns the `DisplayPipeline`. |
| `simple-source.ts` | `OsdSimpleSource`: the `tiled: false` path — load, full-res resample, serverless multichannel composite, simple z-scrub — and every simple-mode field. |
| `osd-viewport.ts` | `OsdViewportAdapter`: visible-rect streams, the `PlotModeViewport`, zoom/fit/resize. |
| `osd-navigator-chrome.ts` | `OsdNavigatorChrome`: navigator sizing/visibility, smoothing, fit-as-layout-settles, the toolbar repaint nudge. |
| `osd-pixel-readback.ts`, `osd-export.ts` | Pure: the drawer-canvas reads (the tools' packed frame, the PNG snapshot); the composite PNG and TIFF exports. |
| `slice-cache.ts` | Stack slices as separate TiledImages (opacity toggle on z-scrub), per-channel image groups, LRU sizing and the background preloader. |
| `display-pipeline.ts` | Pure pixel math: window/gamma/invert/colormap for grayscale and RGB, per-channel tint LUTs and the additive channel merge. Shared by tile recoloring, the serverless compositor and the composite export. |
| `histogram-sampler.ts` | Per-slice 8-bit histograms and the grayscale auto-window from sampled tiles, plus native-bit-depth histograms from `/histogram`. Generation-guarded against image switches. |
| `tile-client.ts` | The tile fetch → decode → RGBA helpers (the `/tile` URL shape is re-exported from the shared `../tile-server/` jit-service client, which also owns the `/tiles/info` poll, `/histogram` and `/export/tiff`). |
| `osd-region-overlay.ts` | The SVG region overlay: draws the shared `RegionStore`'s regions, and drawing, selection and edit gestures. |
| `osd-coords.ts` | Image ↔ viewport ↔ element conversions routed through world item 0 (accurate with several TiledImages). |
| `osd-coordinate-transform.ts` | `ICoordinateTransform` for the canvas tools (wand, brush, eraser, SAM). |
| `osd-scale-bar.ts` | The physical scale bar. |
| `osd-lib.ts`, `osd-zoom.ts` | The OpenSeadragon import shim and the shared wheel-zoom step. |

## Two source paths

- **Tiled** (default): `load()` polls `GET /tiles/info` (shared
  `tile-server/pollDescriptor`) until the server has cached the file — only a
  202 is re-polled; any other status, or the deadline, fails the load so the
  router falls back to Plotly — and `plot()` opens a custom tile source on `GET /tile` built
  from the descriptor's real per-level sizes. A multichannel fluorescence image
  (`descriptor.multichannel`) is drawn as one TiledImage per channel, composited
  additively by the drawer, using only the real Bio-Formats levels.
- **Simple** (`IImageInfo.tiled === false`, e.g. a folder stack or the
  processing-pipeline preview): each slice is one self-contained image URL,
  fetched through `SimpleSliceAccessService` (auth applies), resampled to the
  full-resolution size so regions align, and opened as OSD's single-image
  source. A serverless multichannel image is composited client-side from its
  per-channel planes.

`load()` only computes the `OsdLoaded` payload; the image on screen keeps its
own state until `plot()` commits that payload.

## Recolor invariant

Display changes are applied through OSD's `tile-invalidated` pipeline:
`requestInvalidate(true)` restores each tile's original data and re-runs the
recolor. Invalidations are coalesced to one per animation frame, and every round
captures `displayToken`: a round that a newer one has superseded must not write
its pixels back — OSD then fails to convert the replaced canvas, destroys the
cache record and unloads the tile (the viewer goes white mid-drag).

## History

The pre-implementation investigation that led to the `/tiles/info` + `/tile` protocol is in
[docs/history/osd-backend-investigation.md](../../../../docs/history/osd-backend-investigation.md).
