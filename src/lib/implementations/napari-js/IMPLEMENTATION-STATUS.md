# napari-js WebGPU backend — implementation status (jit-ui#102)

Session handoff / progress tracker. Branch: `feat/102-napari-js-backend` (local, **not pushed**;
commits held pending review). The napari-js library lives at `~/git/napari-js` (published to npm as
`napari-js`; repo `github.com/belkassaby/napari-js`).

## Goal
Add a WebGPU `napari-js` backend as a new `IVisualizer` implementation in `jax-image-visualization`,
offered alongside OSD (image) and Plotly (3D), behind opt-in napari plot types
(`NAPARI_IMAGE` / `NAPARI_VOLUME` / `NAPARI_ISOSURFACE`). Reach feature parity with OSD for the
image view; reuse the shared backend-agnostic services (RegionStore, tool services) and the same
host wiring (`RoutingVisualizerService`, toolbar `toggleDragMode`).

## Key files
- `implementations/napari-js/napari-visualizer.service.ts` — the IVisualizer backend.
- `implementations/napari-js/napari-region-overlay.ts` — SVG region overlay (draw/select/edit).
- `implementations/napari-js/napari-scale-bar.ts` — physical scale bar overlay.
- `testing/napari-js-stub.ts` — Jest stub for the napari-js ESM package.
- `routing-visualizer.service.ts` — routes plot types to backends; `getRegionOverlay()` returns
  the napari overlay when napari is active.
- napari-js library: `src/viewer.ts`, `src/camera/controls.ts`, `src/engine/readback.ts`,
  `src/io/texture-source.ts` (TiledSource), `src/io/pyramid.ts`, `src/layers/*`.

## napari-js library versions
- **0.4.0** (published): `Viewer.setControlsEnabled()` runtime control toggle (region drawing).
- **0.4.1** (published): readback renders into the canvas format + swizzles BGRA→RGBA (fixed the
  per-scrub WebGPU validation error on Metal).
- **0.4.2** (published): gentler, device-normalized + clamped wheel zoom.
- **0.5.0** (published): `TiledSource.levelScales` — arbitrary (non-power-of-two) pyramid level
  scales, so the dynamic tiling renders the server's Bio-Formats levels correctly.
- jit-ui dep is at **^0.5.0** (reconciled + committed).

## DONE (committed on the branch — see git log)
- Opt-in backend + napari plot types in the dropdown (kept Plotly iso/surface alongside).
- Full-image render via real `/tiles/info` pyramid grid (stitch tiles of the finest level that
  fits a tile budget + the 8192px GPU texture limit; single-tile fallback; safety downscale).
- Live slice scrubbing (re-render per slice, out-of-order guard, branch on volume presence).
- Native channels: per-channel additive composite (tint LUT), grayscale colormap, RGB composite;
  per-channel native histograms via `layerHistogram`; invert; reactive to `VisualizerStore`.
- Physical scale bar (`mppX` from `/tiles/info`).
- Region overlay: draw rect/polygon/freehand; select; move/resize; vertex move/add/delete; bezier
  display + handles + drag; pan/zoom gating via `setControlsEnabled`; donut (hole) RENDERING
  (even-odd) + hole-vertex editing; classification labels.
- Pixel tools (reuse shared services + a napari host w/ readback from `lastPixels`): wand, brush,
  vertex-eraser, zoom-to-box. SAM box/point + cellpose wired through the same host.
- Parity gap-fills: image smoothing→interpolation, `getViewportChange$` clamp, TIFF `exportData`,
  native >8-bit `getHistogram$`.
- ndpi/large-image FIX: layers scaled into FULL-RESOLUTION world coords so pre-saved regions align.
- Volume/isosurface: color LUT (store colormap, reactive) + intensity histogram.
- OSD-parity gap-fills: interpolation/smoothing, getViewportChange$ clamp, native >8-bit
  getHistogram$, TIFF exportData, region labels, donut hole-vertex editing.
- **Bézier holes (full model support)** — DONE. Polygon `holeHandlesIn/Out`; store seeds/edits
  (`moveHoleBezierHandle`) + clone; both overlays render holes as cubic bezier (shared ring path);
  napari draws+drag-edits hole control handles; GeoJSON round-trips hole anchors+handles and
  exports flattened hole curves. Fixes OSD's donut→bezier bug too. (Minor follow-up: OSD hole
  bezier-handle DRAG editing — OSD renders the curve; napari has full edit.)
- **Wand/brush off-screen FIX** — the stroke mask + rasterization no longer clamp to the viewport
  (with a 4096² memory guard), so extending a region that was panned/zoomed partly off-screen keeps
  its off-screen part. Shared services → OSD + napari + Plotly.

## DONE (cont.)
- **Dynamic pyramidal tiling on zoom** (task 6) — DONE. napari-js 0.5.0 `TiledSource.levelScales`
  (arbitrary levels) + adapter `buildTiledSource` feeding `/tile` per (level,col,row,z). The 2D
  image refines to higher resolution on zoom; tiled layers sit in full-res coords (regions align);
  slice scrub just moves `dims.z`; histogram uses a coarse per-channel luminance sample. Stitch
  remains as a no-descriptor fallback.

## DONE (cont.)
- **Pixel-tool readback currency (SAM/wand/brush)** — SAM runs client-side and embeds the
  *displayed* pixels (`getCachedImageData` → `lastPixels`). With tiling, tiles load async after the
  post-plot readback and the readback wasn't refreshed on pan/zoom, so `lastPixels` was blank/stale
  → SAM point prompts over-segmented, box prompts found "no cells" (wand/brush silently affected
  too). Fix: `runReadback()` + debounced `armReadback()` re-armed on `camera.changed`; tools arm a
  readback on activation; SAM-box awaits a fresh readback before encoding.

## KNOWN LIMITATIONS / NOTES
- **SAM segments the VISIBLE viewport at screen resolution** (same as OSD) — the client-side encoder
  embeds the displayed composite, so small features must be zoomed in to segment well; segmenting
  tiny features while zoomed all the way out won't resolve them.

## DONE (cont.)
- **Click-to-zoom + gentler wheel** (task 7) — napari-js 0.5.1: OSD-style click-to-zoom (left-click
  in, right/modifier-click out, drag still pans), and a gentler/clamped/device-normalized wheel zoom
  (`ViewerOptions.wheelZoomSpeed`/`clickZoomFactor`). Fixes the over-sensitive scroll.
- **Rubber-band region selection** — select mode draws a marquee in empty space and selects every
  region whose bbox it overlaps (rect/polygon/multipolygon); click on empty clears. Mirrors OSD.

## TODO / BACKLOG
- **Full-resolution SAM embedding (optional, task 8)** — instead of embedding the screen readback,
  fetch the prompt region's native-res tiles and embed those, so SAM segments at full detail
  regardless of zoom. Larger change (SAM-specific image fetch + coordinate mapping).
- **Shared-code refactor (held)** — extract the identical OSD+napari IRegionStore/IDisplayOptions
  delegations into an abstract base.
- **OSD hole-bézier handle dragging** — OSD renders bézier holes; napari has full edit. Minor.
- **Shared-code refactor** (HELD by user): extract the ~40 identical `IRegionStore`/`IDisplayOptions`
  delegations from OSD + napari into a shared abstract base class they extend.
- Known parity gaps (lower priority): `setNavigatorVisible` (napari-js has no minimap — library
  limitation), stack slice-cache/preload + grayscale auto-window seeding (UX polish).

## VERIFIED IN BROWSER (by user)
Large single image (whole image, not corner); large grayscale stack scrubbing (after BGRA fix);
channels/invert; scale bar; region rect/polygon/freehand draw + bezier display + select + handles;
wand; vertex-eraser; zoom-to-box. NOT yet confirmed live: brush, SAM/cellpose (need a model +
server), volume/iso LUT+histogram, the latest parity gap-fills, ndpi alignment, donut rendering.

## GATES
`npx nx build jax-image-visualization` · `npx nx test jax-image-visualization` (717 tests) ·
`npx nx lint jax-image-visualization` (0 errors) · `npx nx build jit-ui` (AOT). All green at last
commit (`f490e6c`). Commit convention: NO `Co-Authored-By` trailer.
