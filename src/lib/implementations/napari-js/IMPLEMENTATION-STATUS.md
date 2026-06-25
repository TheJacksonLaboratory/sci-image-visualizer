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
- **0.4.2** (TAG PUSHED, **NOT yet on npm** — CI publish pending / may need token re-run): gentler,
  device-normalized + clamped wheel zoom. jit-ui dep bump to `^0.4.2` is **held** until published;
  the build is hand-synced into `node_modules` so dev works now.

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

## TODO / BACKLOG
- **Dynamic pyramidal tiling on zoom** (task 6): currently a single downscaled level is shown and
  zoom just magnifies it (blurry) — no higher-res refinement like OSD. napari-js has a `TiledSource`
  but its pyramid math assumes power-of-two levels; this server's bioformats levels are arbitrary,
  so a napari-js v0.5 enhancement (explicit per-level dims) + adapter wiring to feed a `TiledSource`
  with a `/tile` fetch callback is needed. DEFERRED by user.
- **Left-click zoom (OSD-style)** (task 7): add click-to-zoom-in (and modifier/right-click zoom-out)
  in napari image mode. Do AFTER dynamic tiling. (Wheel zoom already gentler in 0.4.2.)
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
