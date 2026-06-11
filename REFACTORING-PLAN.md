# jax-image-visualization — Architecture Improvement Plan

_Source: architecture review of 2026-06-10 (3-scout audit of contracts/boundary, OSD backend,
Plotly backend + components + tests). Companion to the architecture section of
`jit-service/doc/JIT_UI_visualization_library_SOW.docx`._

## Ground rules (apply to every step)

- **Behavior-preserving refactors only.** No step may change what renders, how tiles load/cache,
  or how regions behave. Pure moves and mechanical substitutions.
- **A step is DONE only when its gate checklist is fully checked.** Do not start the next step
  with an unchecked gate.
- **Standard gate** (referenced below as _STD_):
  - [ ] `npx nx test jax-image-visualization` — all green, no skipped tests
  - [ ] `npx nx lint jax-image-visualization` — 0 errors
  - [ ] `npx nx build jax-image-visualization` — ng-packagr green
  - [ ] `npx nx build jit-ui` — AOT green
- **Browser gate** (referenced as _BROWSER_, required for steps touching the OSD path):
  - [ ] Load an RGB image → renders, regions draw/select/delete
  - [ ] Load a grayscale z-stack → z-scrub smooth, cached slices instant, colormap applies
  - [ ] Load a 16-bit stack → Channels & Histogram dialog: native histogram, window/gamma recolor,
        composite PNG + 16-bit TIFF exports download
  - [ ] Load a multichannel fluorescence stack → per-channel pseudo-color composites correctly

## Review findings (summary)

| # | Finding | Where |
|---|---------|-------|
| 1 | `IVisualizer` (60 methods) leaks ≥8 Plotly-only concepts; OSD stubs them | `contracts/visualizer.contract.ts`; stubs at `osd/openseadragon-visualizer.service.ts:1157-1488` |
| 2 | OSD service god-object: 2,183 lines, ~11 clusters, 37 mutable fields; coupling core = `viewer`/`descriptor`/`currentZ`/`channelStates` | `osd/openseadragon-visualizer.service.ts` |
| 3 | Zero tests on the 3 largest files (OSD service, router, visualization component ≈ 3,700 lines) | — |
| 4 | Cross-backend duplication: tool-host binding, 8-bit histogram loop + luminance ×3, IRegionStore boilerplate ×2, channel-state subscription ×2. In-file: fetch-decode pipeline ×3, tile URL built ×4 | Plotly `:194-218,:2041-2066`; OSD `:1606-1625,:1977-2007,:359,:460,:877,:2106` |
| 5 | 37 empty `catch {}` in OSD; 6 in fire-and-forget pixel loops — silent user-visible failures | `osd/openseadragon-visualizer.service.ts` |
| 6 | Smaller: display-options double-hop (router→plotly→store, `routing:269`); `visualization.component.ts` ~40% orchestration; dead `notImplemented()` (`osd:285`); naming drift (`session` vs `store`, selector prefixes); 11 contract `any`s |

Working well — do not disturb: clean lib↔host boundary (0 upward imports), store-owned state,
OSD sibling separation (overlay/scale-bar/coords), recolor LUT pattern, thin router (8/73 real-logic methods).

---

## Step 0 — Characterization tests (the enabler)

Pin current behavior of the untested core so later steps are verifiable, not hopeful.

Deliverables:
- [x] `routing-visualizer.service.spec.ts` — backend selection per plot type, kill switch,
      OSD-fallback lifecycle (`load()` failure → Plotly for that image; `reset()` re-arms OSD),
      backend-switch teardown (purge vs reset), profile-region filtering
      (`getAnnotationRegions`/`setAnnotationRegions`), auto-contrast windowing math
      (saturation + dominant-edge-bin drop), delegation pinning (histogram, exports,
      display options — pins the current double-hop deliberately; Step 1 updates it consciously)
- [x] `osd/osd-coords.spec.ts` — element↔image↔viewport routing through world item 0 +
      empty-world fallback (pure math, fake viewer)
- [x] `contracts/colormap-lut.spec.ts` — LUT endpoints/midpoint interpolation, reverse,
      named scales, hex/rgb parsing, invalid input → null
- [x] `osd/openseadragon-visualizer.service.spec.ts` — instantiation beachhead: capabilities,
      stub behaviors (`getCurrentImage` null, no-op setters don't throw), `getHistogram` null
      before sampling, `exportData` no-op without a loaded image (no HTTP issued)

Gate:
- [x] _STD_ all green (297 tests / 23 suites; lint 0 errors; ng-packagr + jit-ui AOT builds pass)
- [x] New specs cover: router (every routing/fallback branch), coords (all 4 functions),
      LUT (build/reverse/invalid), OSD beachhead instantiates the real service
- [x] No production code changed in this step (`git diff --stat` shows only `*.spec.ts` + this file)

## Step 1 — Zero-risk hygiene

- [x] Delete dead `notImplemented()` + `warned` set (`osd:285`)
- [x] Router display options read `VisualizerStore` directly — **refined during execution**:
      only the pure READS (`getColormap`, `getColormapOptions`, `getReverseScale`,
      `getImageMeta`, `setImageMeta`) re-point to the store. `setColormap`/`setReverseScale`
      stay routed through Plotly because its implementations carry render glue beyond the store
      write (a live `Plotly.restyle` of colorscale/reversescale on the mounted heatmap) — a
      blind re-point would have broken the heatmap's live recolor. Comment fixed; Step-0
      pinning test updated to the new behavior in the same commit
- [x] Rename OSD's injected `session` → `store` (match Plotly)
- [x] The 6 fire-and-forget empty catches log `console.warn` with tags
      (`[viz:histogram]`, `[viz:window]`, `[viz:export]`); still swallow — never throw
- Gate:
  - [x] _STD_ (297/297 tests, lint 0 errors, ng-packagr + jit-ui AOT green)
  - [x] Manual smoke: colormap change recolors both backends (Image/OSD view AND Heatmap view)
        — verified by user 2026-06-10

## Step 2 — Extract `osd/tile-client.ts`

- [x] `buildTileUrl(api, infoB64, {res, col, row, z, tileSize, channel?})` — single source for the
      4 inline URL constructions (`channel == null` omits the param; channel 0 is included,
      matching the old `chParam` semantics)
- [x] Fetch/decode pipeline extracted — **refined during execution**: split into
      `fetchTileBitmap` (export stitches bitmaps onto a shared canvas — it never did a per-tile
      `getImageData`) and `fetchTileRgba` (the two histogram/window samplers). Helpers
      **propagate** errors instead of returning null so every call site keeps its Step-1
      tagged catch and its own skip/fallback semantics unchanged
- [x] Unit tests (`tile-client.spec.ts`): URL param ordering, channel 0 vs null/undefined,
      blob→pixels decode + bitmap close, failure propagation
- [x] Mechanical substitution only — same URLs, same timeouts (20s samplers / 30s export),
      same catch behavior; dead `chParam` local removed
- Gate:
  - [x] _STD_ (303/303 tests / 24 suites, lint 0 errors, ng-packagr + jit-ui AOT green)
  - [x] _BROWSER_ (tile path touched) — verified by user 2026-06-10: RGB image renders +
        regions; grayscale stack z-scrub + colormap; 16-bit stack histogram/window/exports;
        multichannel composite

## Step 3 — Extract `osd/slice-cache.ts` (highest value, highest care)

- [x] Cache fields + `addSlice`/`addChannelSlice`/reveal/`loadNextBackgroundSlice`/LRU/eviction/
      token logic moved into `SliceCache` owning its own state (service 2,183 → 1,731 lines;
      cache 487 lines). **Refinement found during the move**: `sliceWindows`, `imageWindow` and
      `tileZ()` were provably dead (write-only / never called — grep-verified) and were deleted
      rather than dragged into the new class
- [x] Narrow surface: `configure(stackDepth, coarseFitTiles)`, `maxSlices()`,
      `clearChannelGroups()`, `seedComposite(z, item)`, `showSlice(z)`, `addChannelSlice(z)`,
      `revealChannelSlice(z)`, `invalidateChannelDisplay(z)`, `schedulePrefetch()`,
      `cancelBackgroundLoad()`, `reset()` — host callbacks (`SliceCacheHost`) are live closures
      over the service's viewer/descriptor/z, so the cache reads exactly what the moved code read
- [x] **Pure move**: identical logic and order of operations (configure() consolidates the two
      old assignment sites for `skipSlicePrefetch`/`maxCachedSlices` at the post-destroyViewer
      point; nothing reads either flag in between — verified)
- [x] +13 unit tests with a fake viewer: hidden+preload add → reveal-if-current,
      cache-don't-reveal after scrub-away, instant revisit, rapid-scrub dedupe, token
      cancellation drops orphans, LRU eviction (never the current slice), prefetch
      nearest-first / yields-while-streaming / gates-on-in-flight / budget skip, multichannel
      per-channel reveal + stale re-tint, reset
- Gate:
  - [x] _STD_ (316/316 tests / 25 suites, lint 0 errors, ng-packagr + jit-ui AOT green)
  - [x] _BROWSER_ with **explicit z-scrub emphasis** — verified by user 2026-06-10:
        revisit cached slices = instant, no white flicker; background preload fills the stack;
        image switch cancels cleanly; multichannel z-scrub + per-channel visibility

## Step 4 — Extract `osd/display-pipeline.ts` + `osd/histogram-sampler.ts`

- [x] `DisplayPipeline` (149 lines, stateless): `applyToRgba`, `channelRgbLut`,
      `channelIntensity`, `tint01`, `rgbNeedsRecolor` — reads display state through live host
      closures (`isGrayscale/colorLut/channelStates/invertBg`); the tile-event plumbing
      (`recolorTile`/`recolorChannelTile`) stays in the service and calls it. +15 fixture tests
      (window endpoints/midpoint/clamp, exact gamma value, invert, transparent skip, RGB
      identity-at-defaults, hidden channel, additive clamp, recolor gate table, LUT tables)
- [x] `HistogramSampler` (268 lines, owns `sliceHistograms`/`nativeHistograms`/cache-buster):
      `computeImageWindow`, `computeMultiChannelHistograms`, `native$` fetch+cache, `get`,
      `clear` — on Step 2's tile client; store/viewer side effects stay in the service via two
      host callbacks (`onChannelHistogramsSampled` nudge, `onGrayWindowSampled` seed/invalidate).
      +12 tests (binning, auto-window span reporting, RGB histograms, per-tile failure
      tolerance, per-channel binning + nudge, too-big bail, native mapping/caching/failure,
      clear). Service: 1,731 → 1,421 lines (2,183 at campaign start)
- Gate:
  - [x] _STD_ (343/343 tests / 27 suites, lint 0 errors, ng-packagr + jit-ui AOT green)
  - [x] Pixel math pinned **stronger than the planned PNG-byte-size check**: the fixture tests
        assert exact output values for window/gamma/invert/tint (e.g. γ=2 at 128 → 181), which
        a byte-size comparison could never verify
  - [x] _BROWSER_ (recolor + histogram touched) — verified by user 2026-06-10: grayscale
        window/gamma/invert recolor live; multichannel tint/visibility; histogram appears for
        grayscale/RGB/multichannel/16-bit; composite PNG looks unchanged at same settings.
        (The zmap.tif tiling-edge report during this gate was diagnosed as the PRE-EXISTING
        server per-tile normalization seam — fixed in jit-service c7db313, per-image window)

## Step 5 — Cross-backend de-duplication

- [x] Shared scalar helpers in `contracts/intensity.ts` — **refined during execution**: the
      review's "luminance ×3" conflated two DIFFERENT projections that must stay separate:
      `bt601Luminance` (Plotly frame cells — was duplicated in plotly.service + trace-builders)
      and `maxRgb` (OSD tile path — was the same ternary idiom ×3 in the sampler + pipeline).
      The display-pipeline's per-pixel hot loop keeps its inline copy on purpose (262k
      calls/tile; annotated, pointing at the helper)
- [x] Shared `histogram256(counts)` replacing the two IHistogram constructions (Plotly
      `getHistogram` tail + the sampler's `mkHistogram`). A fully shared binning loop was NOT
      extracted — the two backends bin from genuinely different data shapes (number[][] frame
      cells vs RGBA byte buffers); only the construction was true duplication
- [x] `ToolHostBinder` — **dropped after inspection**: the two host blocks share only shape;
      every leaf closure is backend-specific (readbackViewport vs frame cache, currentZ vs
      activeFrameIndex…). A binder would hide eight closures behind a factory without deleting
      a single duplicated line. Same verdict for the optional `RegionStoreDelegate` (one-line
      delegations, and Plotly's setRegions carries shape-sync logic the base couldn't share)
- [x] +3 unit tests (`contracts/intensity.spec.ts`): BT.601 weights, maxRgb orderings,
      histogram256 shape
- Gate:
  - [x] _STD_ (346/346 tests / 28 suites, lint 0 errors, ng-packagr + jit-ui AOT green);
        both backends' existing specs green unchanged
  - [ ] _BROWSER_ (light) — **pending user verification**: heatmap histogram still renders
        (Plotly getHistogram touched); OSD histograms still render

## Step 6 — Contract tightening (before npm publication — SOW D7)

- [ ] New capability-gated `getSurface3dControls(): ISurface3dControls | null`
      (drag mode + camera) mirroring `getIsosurfaceControls()`; Plotly implements, OSD returns null
- [ ] `@deprecated` JSDoc on `reloadAndPlot`/`resetAxes`/`autoscale`/`setSurfaceDragMode`/
      `resetSurfaceCamera` on `IVisualizer` (kept for one release; consumers steered to
      capability gates)
- [ ] Type the publication-critical `any`s: `ColormapNode` tree, `WandOptions`,
      `plot()`'s `imageLoaded`
- [ ] Standardize component selector prefix (`jaxviz-*`) with old selectors kept as aliases
      for one release
- [ ] Gate: _STD_; host app compiles with **zero** changes (deprecations warn, nothing breaks);
      barrel surface reviewed against SOW D6/D7

## Step 7 — Slim `visualization.component.ts` (optional)

- [ ] Extract two-pass render orchestration + retry into a `RenderOrchestrator` service
- [ ] Move z-scrub debounce out of the component
- [ ] New `visualization.component.spec.ts` for the remaining UI shell
- [ ] Gate: _STD_ + _BROWSER_

---

## Explicitly out of scope (do NOT do)

- No merging of the two backends or shared base class for the services themselves
- No rewrite of the `IVisualizer` surface — capability-gating + deprecation only
- No tuning of recolor LUT, slice-reveal opacity mechanics, or tile-invalidated wiring —
  pure moves only on the plotting hot path
