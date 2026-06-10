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

- [ ] Delete dead `notImplemented()` + `warned` set (`osd:285`)
- [ ] Router display options read `VisualizerStore` directly (kill the double-hop via Plotly);
      fix the misleading "display options → Plotly" comment; update the Step-0 pinning test
- [ ] Rename OSD's injected `session` → `store` (match Plotly)
- [ ] The 6 fire-and-forget empty catches log `console.warn` with tags
      (`[viz:histogram]`, `[viz:window]`, `[viz:export]`); still swallow — never throw
- [ ] Gate: _STD_; manual smoke: colormap change recolors both backends (the double-hop fix
      touches the colormap path)

## Step 2 — Extract `osd/tile-client.ts`

- [ ] `buildTileUrl(api, infoB64, {res, col, row, z, tileSize, channel?})` — single source for the
      4 inline URL constructions (`:359, :460, :877, :2106`)
- [ ] `fetchTileRgba(http, url, timeoutMs)` — single fetch-blob→bitmap→canvas→`getImageData`
      pipeline replacing the 3 copies (`:359-383, :460-491, :2106-2118`)
- [ ] Unit tests for `buildTileUrl` (param ordering, optional channel) and `fetchTileRgba`
      (mocked blob; null on failure)
- [ ] Mechanical substitution only — no behavior/timeout changes
- [ ] Gate: _STD_ + _BROWSER_ (tile path touched)

## Step 3 — Extract `osd/slice-cache.ts` (highest value, highest care)

- [ ] Move the 16 cache fields + `addSlice`/`addChannelSlice`/reveal/`loadNextBackgroundSlice`/
      LRU/eviction/token logic into a `SliceCache` class owning its own state
- [ ] Narrow interface consumed by the service: `reveal(z)`, `prefetch()`, `invalidate(z)`,
      `reset()`, viewer/tile-source callbacks injected
- [ ] **Pure move**: identical logic, identical order of operations; no tuning
- [ ] New unit tests: LRU eviction order, load-token cancellation drops stale adds,
      background-loader gating (in-flight + timeout), dedupe of rapid scrubs — with a fake viewer
- [ ] Gate: _STD_ + _BROWSER_ with **explicit z-scrub emphasis** (revisit cached slices = instant,
      no white flicker; background preload still fills the stack; image switch cancels cleanly)

## Step 4 — Extract `osd/display-pipeline.ts` + `osd/histogram-sampler.ts`

- [ ] `DisplayPipeline`: `applyDisplayToRgba`, `channelRgbLut`, `channelIntensity`, `tint01`,
      `rgbNeedsRecolor`, grayscale LUT build — fed by `(channelStates, colorLut, invertBg,
      isGrayscale, imageWindow)`; unit tests on small `Uint8ClampedArray` fixtures
      (window endpoints, gamma, invert, additive tint clamp)
- [ ] `HistogramSampler`: `computeImageWindow`, `computeMultiChannelHistograms`,
      native-histogram fetch + cache — built on Step 2's tile client
- [ ] Gate: _STD_ + _BROWSER_ (recolor + histogram touched); pixel-identical spot check:
      same window/gamma settings produce the same composite PNG byte size ±0 on a test image

## Step 5 — Cross-backend de-duplication

- [ ] One `luminance()`/max-of-RGB helper (in `models/` or `contracts/colormap-lut.ts`)
      replacing the 3 copies (Plotly `:2054`, trace-builders `:64-69`, OSD recolor path)
- [ ] One shared `bin8BitHistogram(...)` used by both backends' `getHistogram`
- [ ] `ToolHostBinder` helper for wand/eraser/zoom-box host wiring (Plotly `:194-218`,
      OSD `buildToolHosts` `:1606-1625`)
- [ ] (Optional) `RegionStoreDelegate` base for the ×2 IRegionStore boilerplate
- [ ] Gate: _STD_; both backends' existing specs green; wand works on both backends in browser

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
