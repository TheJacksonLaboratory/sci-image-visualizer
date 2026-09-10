# Codex review — spatial-omics branch

> Review date: 2026-09-09  
> Branch: `feat/add-spatial-omics-plotmode`  
> Comparison base: `origin/main`  
> Verdict: **FAIL — 2 critical, 4 warning, and 2 informational findings**

## Scope

This review covers the current spatial-omics branch against `origin/main`: 124 changed files with
approximately 29,290 insertions and 201 deletions. The review used five passes: correctness,
security, performance, readability, and consistency.

The untracked `.planning/research/mcp-sci-image-visualizer-plan.md` file was excluded because it is
not part of the branch. No project source files were changed during the review.

## Prioritized TODOs

### P0 — Fix t-SNE worker production packaging

- **Severity:** CRITICAL
- **Files:** [`src/lib/spatial/tsne-worker.ts:8`](../src/lib/spatial/tsne-worker.ts),
  [`examples/browser-image/vite.config.mts:61`](../examples/browser-image/vite.config.mts), and
  [`scripts/bundle-workers.mjs:25`](../scripts/bundle-workers.mjs)
- **Review pass:** Correctness, consistency

The staged package cannot complete a Vite production build. The new worker's dependency graph
requires code splitting while Vite defaults workers to IIFE output.

```ts
return new Worker(new URL('./tsne.worker', import.meta.url), { type: 'module' });
```

The Node 22 production-build check failed with:

```text
[vite:worker-import-meta-url] Invalid value "iife" for option "output.format" -
UMD and IIFE output formats are not supported for code-splitting builds.
```

**TODO:** Ship a consumer-safe ESM worker. Prefer bundling the direct `@jax-js/jax` dependency into
the emitted `tsne.worker.js`, or otherwise emit a worker that does not require IIFE code splitting.
Setting `worker.format: 'es'` fixes this example but would impose configuration on every Vite
consumer. Add a staged-package `npm run build:example` job to pull-request CI so worker packaging is
tested before merge rather than only when Pages builds from `main`.

### P0 — Close the tile-server path traversal

- **Severity:** CRITICAL
- **File:** [`examples/tile-server/lib/cog.mjs:163`](../examples/tile-server/lib/cog.mjs)
- **Review pass:** Security
- **Origin:** Inherited from `main`, but present in the reviewed codebase

The `safeId()` regular expression accepts the exact ID `..`. Passing it to `path.join()` escapes
`COG_DIR` into its parent, where the server can attempt to read a fixed `descriptor.json` or pyramid
level filename.

```js
function safeId(imageId) {
  const id = String(imageId || '');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`bad image id: ${id}`);
  return id;
}
```

**TODO:** Reject `.` and `..` path segments and verify that `path.resolve(cogDir, id)` remains below
the resolved COG root. Add route-level regression tests using an encoded `{"image":".."}` info
token.

### P1 — Make vector caches dataset-generation-aware

- **Severity:** WARNING
- **File:**
  [`src/lib/implementations/spatial-data-http/spatial-data-http.service.ts:298`](../src/lib/implementations/spatial-data-http/spatial-data-http.service.ts)
- **Review pass:** Correctness

Clearing or selecting another dataset while a feature, column, or embedding request is in flight
does not prevent the old request from completing and populating the new dataset's cache under the
same logical key. Its `finally` handler can also delete a newer request's in-flight entry.

```ts
const promise = load()
  .then((value) => {
    this.cache.set(key, value);
    this.evict();
    return value;
  })
  .finally(() => this.inFlight.delete(key));
```

**TODO:** Include dataset identity or a selection-generation token in cache entries. Commit a result
only when its generation is still current, and delete an in-flight entry only when the stored promise
is the same promise completing. Cover an A-to-B dataset switch before A's vector resolves.

### P1 — Correct t-SNE cancellation and dataset-switch races

- **Severity:** WARNING
- **Files:**
  [`src/lib/spatial-controls/spatial-charts/spatial-charts.component.ts:886`](../src/lib/spatial-controls/spatial-charts/spatial-charts.component.ts)
  and [`src/lib/spatial/embedding-compute.ts:161`](../src/lib/spatial/embedding-compute.ts)
- **Review pass:** Correctness, performance

A dataset can change while PCA scores are loading, before `computeRun` exists. The old call can then
start a worker and render its result into the newly selected dataset. If a switch occurs after the
worker starts, `terminate()` stops the worker without settling the promise returned by `run()`,
retaining the awaiting component closure indefinitely. The shared `finally` block can also terminate
or clear a newer run, and `ngOnDestroy()` does not terminate an active computation.

```ts
this.computeRun = new EmbeddingComputeRun();
const result = await this.computeRun.run(/* ... */);
// ...
this.computeRun?.terminate();
this.computeRun = null;
```

**TODO:** Capture each run in a local constant, use a dataset/run generation token after every
`await`, and clear shared state only when `this.computeRun === run`. Make external termination settle
the run promise, and terminate during `ngOnDestroy()`. Test dataset changes during PCA loading and
worker execution, external termination, and component teardown.

### P2 — Revalidate cached dataset ownership

- **Severity:** WARNING
- **File:** [`examples/tile-server/server.mjs:283`](../examples/tile-server/server.mjs)
- **Review pass:** Correctness

`sourceOf` permanently remembers the first source that owns a dataset ID. If a higher-priority bundle
is generated later, or the cached source disappears, the server keeps dispatching to the old source
until restart. This conflicts with the branch's stated priority and regeneration behavior.

```js
const cached = sourceOf.get(id);
if (cached) return cached;
```

**TODO:** Revalidate cached ownership, use a bounded TTL or mtime-aware entry, or invalidate entries
when dataset discovery observes ownership changes. Test replacing a live Zarr/H5AD source with a
bundle during one server process.

### P2 — Add automated checks for the example server

- **Severity:** WARNING
- **Files:** [`.eslintrc.json:3`](../.eslintrc.json) and
  [`examples/tile-server/package.json:10`](../examples/tile-server/package.json)
- **Review pass:** Security, readability, consistency

Thousands of lines of request parsing, filesystem access, cache management, and binary conversion
are excluded from linting. The tile-server package has manual smoke and verification scripts but no
automated `test` or `lint` script.

```json
"ignorePatterns": [
  "examples/**"
]
```

**TODO:** Add an ESLint override for Node ESM files and a `node:test` or Vitest suite covering path
validation, source dispatch, invalid parameters, cache invalidation, and malformed binary metadata.
Run these checks in the main CI workflow.

### P3 — Revisit Napari ownership before decomposing the backend

- **Severity:** INFO
- **File:**
  [`src/lib/implementations/napari-js/napari-visualizer.service.ts:302`](../src/lib/implementations/napari-js/napari-visualizer.service.ts)
- **Review pass:** Readability, performance maintainability

`NapariVisualizerService` is now approximately 4,497 lines, with this branch adding roughly 2,000
lines for spatial rendering, density volumes, gene maps, hover behavior, selection, and lifecycle
management. The shared mutable caches and generation tokens make future race regressions difficult to
isolate.

```ts
export class NapariVisualizerService extends BaseStoreVisualizer implements IVisualizer {
```

The original review treated `napari-js` as a fixed dependency and recommended only internal
extraction inside sci-image-visualizer. That boundary is too narrow: `napari-js` is modifiable, and
several workarounds in this service exist because generic renderer capabilities are absent from its
current API. Moving those capabilities upstream removes the abstraction leaks instead of merely
moving them into different files.

#### Ownership split

| Move to `napari-js`                                         | Keep in sci-image-visualizer                     |
| ----------------------------------------------------------- | ------------------------------------------------ |
| 3D world-to-screen projection and point picking             | Spatial dataset contracts and the HTTP data port |
| Per-point 3D RGBA, opacity, or selection-mask styling       | Gene, cluster, and annotation semantics          |
| Explicit camera framing policy and `fitToLayers()` behavior | Linked map/chart selection state                 |
| Generic scale bars and 3D axis-label overlays               | Spatial controls and Angular integration         |
| Layer replacement/group lifecycle primitives                | Density and expression-field computation         |
| Generic canvas hover/pick events                            | Tooltip content and class-selection behavior     |
| Reusable 3D lasso/polygon selection primitives              | Cross-backend ROI semantics and persistence      |

The strongest upstream candidates are:

1. **3D projection and picking.**
   [`getSpatialScreenProjection()`](../src/lib/implementations/napari-js/napari-visualizer.service.ts)
   manually multiplies `Camera3D.viewProjection()` and scans projected points. Projection, clipping,
   depth awareness, and accelerated picking belong to the viewer that owns the camera and viewport.
   `napari-js` already exposes 2D `nearestPointIndex`; the 3D equivalent is missing.
2. **Per-point styling in `Points3DLayer`.** The 2D points layer supports per-point RGBA, while the
   3D layer accepts only one scalar mapped through a colormap. sci-image-visualizer consequently
   maintains a second 3D layer for selected points. Per-point color/alpha or a selection mask belongs
   in the layer API.
3. **Camera framing policy.** [`addFramingOnce()`](../src/lib/implementations/napari-js/napari-visualizer.service.ts)
   saves and restores camera internals because adding a 3D layer reframes the scene. `napari-js`
   should expose an explicit policy such as `fit: 'once' | 'always' | 'never'` and a deliberate
   `fitToLayers()` operation.
4. **Renderer-aware overlays.** [`NapariScaleBar`](../src/lib/implementations/napari-js/napari-scale-bar.ts)
   and [`NapariAxesLabels`](../src/lib/implementations/napari-js/napari-axes-labels.ts) are generic
   viewer capabilities. If the core package should stay headless, they could live in an optional
   `napari-js/ui` entry point.
5. **Generic picking events.** Tooltip DOM and observation text should remain here, but napari-js
   should emit generic hover/pick results rather than requiring its consumer to reconstruct renderer
   state.

**TODO:** Before splitting this service internally, inventory its renderer workarounds and upstream
the generic projection, picking, point-styling, framing, and overlay capabilities into `napari-js`
with renderer-level tests. Release and adopt that version, reduce this service to a thin Napari
adapter, and only then extract the remaining spatial-domain orchestration into focused internal
collaborators. `napari-js` should gain rendering capabilities, not knowledge of genes, clusters, or
spatial-omics datasets.

### P3 — Establish a clean toolchain baseline

- **Severity:** INFO
- **Files:** [`package.json:36`](../package.json), [`.eslintrc.json:45`](../.eslintrc.json), and
  [`.github/workflows/ci-cd.yaml:21`](../.github/workflows/ci-cd.yaml)
- **Review pass:** Consistency

The root package does not declare a Node version even though CI uses Node 24 and the tile server
declares Node 20 or newer. A local Node 16 invocation therefore reaches opaque Vite failures instead
of being rejected up front. ESLint exits successfully with 717 warnings, while `format:check` reports
171 files.

**TODO:** Add a root `engines.node` requirement and `.nvmrc` aligned with supported CI. Normalize
formatting in a dedicated change to avoid obscuring functional work, then enforce formatting and a
warning budget incrementally on changed files.

## Five-pass summary

| Pass        | Result      | Main concerns                                                                                                           |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Correctness | Fail        | Production worker build; cross-dataset cache pollution; stale t-SNE results; stale source ownership                     |
| Security    | Fail        | `..` escapes the configured COG directory; example-server paths lack regression coverage                                |
| Performance | Conditional | Terminated worker promises can remain pending and retain component state                                                |
| Readability | Conditional | The Napari service mixes domain orchestration with renderer workarounds that should be evaluated for upstream ownership |
| Consistency | Fail        | Packaged-consumer build is not a PR gate; examples bypass lint/test; tool versions are not aligned at the root          |

## Validation evidence

| Check                                  | Result                                              |
| -------------------------------------- | --------------------------------------------------- |
| `npm run typecheck`                    | Passed                                              |
| `npm test -- --runInBand`              | Passed: 76 suites, 1,536 tests                      |
| `npm run lint`                         | Exited successfully with 717 warnings and no errors |
| `npm run build`                        | Passed; library and worker files were emitted       |
| `git diff --check origin/main...HEAD`  | Passed                                              |
| `npm run format:check`                 | Failed: Prettier reported 171 files                 |
| Example production build under Node 22 | Failed while bundling the t-SNE worker              |

The initial example-build attempt used the machine's Node 16 runtime and failed earlier in Vite with
`crypto.getRandomValues is not a function`. Re-running Vite directly under installed Node 22 passed
dependency transformation and exposed the actual worker-format failure documented above.

## Recommended delivery sequence

1. Repair and integration-test worker packaging.
2. Close the path traversal and add request-validation tests.
3. Fix dataset generation and t-SNE lifecycle races with targeted tests.
4. Make source ownership refreshable.
5. Bring the example server under lint and automated test coverage.
6. Upstream generic renderer capabilities into `napari-js`, then split the remaining spatial-domain
   responsibilities in sci-image-visualizer.
7. Normalize the Node, lint, and formatting baseline.

---

## Resolution — 2026-09-09

Every finding was reproduced against the code before being acted on, and each fix was
checked by reverting it and confirming the new test fails. Where a first attempt at a test
passed under the reverted fix, the test was rewritten rather than kept.

| #   | Finding                                     | Status                              |
| --- | ------------------------------------------- | ----------------------------------- |
| P0  | t-SNE worker production packaging           | **Fixed**                           |
| P0  | Tile-server path traversal                  | **Fixed**                           |
| P1  | Dataset-generation-aware vector caches      | **Fixed**                           |
| P1  | t-SNE cancellation and dataset-switch races | **Fixed**                           |
| P2  | Revalidate cached dataset ownership         | **Fixed**                           |
| P2  | Automated checks for the example server     | **Fixed**                           |
| P3  | Revisit Napari ownership and decomposition  | **In progress** — PR #5 conditional |
| P3  | Clean toolchain baseline                    | **Partly fixed** — see below        |

### P0 — worker packaging

Reproduced: `npm run build:example` failed exactly as reported. The cause is narrower than
"the worker needs code splitting". `mask.worker.js` and `onnx-sam.worker.js` keep bare
imports too and build fine, because theirs are STATIC — the consumer folds them into the
one IIFE chunk. `tsne.worker.js` was the only one carrying a DYNAMIC `import("@jax-js/jax")`,
which forces a second chunk. jax-js compounds it: its own `index.js` dynamically imports its
webgpu and webgl chunks, so making the library's own import static would not have been
enough either.

`scripts/bundle-workers.mjs` now bundles `@jax-js/jax` into the emitted worker with esbuild
splitting off, which inlines every dynamic import, and then ASSERTS that no dynamic import
survives in any worker bundle — that assertion is the durable part, since the failure
otherwise appears only in a consumer's build. `worker.format: 'es'` was rejected as the fix
for the reason the review gives: it would impose configuration on every Vite consumer.

Verified: the example build passes and emits `tsne.worker-*.js` (353 kB) with the WebGPU
path inside it. `npm run build:example` and the tile-server tests are now PR-gated jobs in
`ci-cd.yaml`.

### P0 — path traversal

Reproduced: `/^[A-Za-z0-9._-]+$/` accepts the whole id `..`, and `path.join('/cogs', '..')`
resolves to `/`. `safeId` now requires a leading alphanumeric (matching `spatial.mjs`'s
SAFE_ID, so the two entry points cannot drift), and a new `cogPath()` also checks the
resolved path is still under the resolved root — which additionally covers the interpolated
level/channel filename, not just the id.

Both layers are tested, and the route test is the strong form: a `descriptor.json` is
planted in $COG_DIR's PARENT, so the test proves the file is unreachable rather than that
some id returns 400. It fails only when BOTH guards are removed, which is the containment
check earning its place.

### P1 — vector caches

A `selectToken` already existed for sequencing selections; `fetchCached` simply never
consulted it. Both halves are now fixed — commit only at the current generation, and delete
an in-flight entry only when the stored promise is the one completing — and both halves have
a test that fails when that half alone is reverted.

### P1 — t-SNE lifecycle

All four sub-claims held, including `ngOnDestroy()`. `terminate()` now settles its run with
null (an abandoned run is the same event as a cancelled one from the caller's side, so
rejecting would report a routine dataset switch as a failure); the component carries a
`computeToken` checked after every await, holds each run in a local so a departing run
cannot clear a newer one's slot, and abandons on both dataset change and teardown.

### P2 — example-server checks

`examples/tile-server/**/*.mjs` is out of `ignorePatterns` and under a Node ESM override in
the root ESLint config; the eight errors that surfaced were fixed rather than silenced (four
dead imports, one needless template literal, three over-long lines wrapped). 19 `node:test`
cases cover path validation, source dispatch, invalid parameters and cache policy, running
against a real server on a real socket — the bugs here live in what express decodes and what
`path.join` does with it, which calling a handler directly would skip.

`examples/browser-image/**` remains excluded: it is an Angular app, and bringing it in is a
separate piece of work from the request-handling code this finding is about.

### P3 — Napari ownership and decomposition (in progress)

The ownership audit was done first, as the revised finding asks, and it found five capabilities
that sci-image-visualizer was working around rather than five files to move. All five are now in
`napari-js` (branch `feat/renderer-owned-3d-projection-picking-styling`, version 0.14.0), with
renderer-level tests: napari-js goes from 229 to 279 tests at the current PR head.

| Capability                             | The workaround it removes                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectPoint`/`projectPoints`         | The column-major multiply, perspective divide and y-flip, written out TWICE here — in `getSpatialScreenProjection` and in `napari-axes-labels` — with two different behind-the-eye conventions. |
| `nearestProjectedIndex`                | Picking on projected coordinates by nearest centre, with no depth. The renderer depth-tests the billboards, so the tooltip could name a point drawn behind another.                             |
| Per-point `alphas` / `sizes`           | A whole second `Points3DLayer` for the selected subset, kept in step through every colormap, window and size change, and depth-sorted against the parent as a separate draw.                    |
| `fit3d` + `resetFit3D` + `fitToLayers` | `addFramingOnce`, which saved and restored five camera fields around every 3D add because napari-js reframed unconditionally.                                                                   |
| `dataVersion` / the `values` setter    | Rebuilding the whole point layer to change what it is coloured by — which, because adding a layer reframed, also caused the camera jump above.                                                  |

Adopted here: the duplicate projection is gone, the hover pick is depth-aware, the selection
highlight is a per-point alpha in one layer, and `addFramingOnce` and the second layer are deleted.
1,551 tests pass; the three specs that pinned the two-layer behaviour were rewritten to pin the new
one.

#### PR #5 follow-up review — 2026-09-10

[`napari-js` PR #5](https://github.com/TheJacksonLaboratory/napari-js/pull/5) was re-reviewed at
head `ffe6f36551c594b71c26ef17d0c33b21bf752240`. GitHub reports it mergeable with a green
`typecheck · lint · format · test · build` check; it is blocked only because review approval is
required.

The corrective commit is valid and closes four concrete defects from the first implementation:

- `unionBounds()` now validates the result of `bounds()` and skips nullable/2D bounds, preventing a
  `ShapesLayer` from producing a NaN camera target.
- replacing `Points3DLayer.values` now goes through an accessor that validates, increments
  `dataVersion`, and emits a change, so the GPU cannot silently retain the old scalar data;
- hidden single-point and batch projection now use the same NaN screen-coordinate sentinel; and
- an explicit `fitToLayers()` records the fit, so the next add under the `once` policy cannot undo
  the union framing.

The PR is nevertheless **CONDITIONAL**, not ready for approval as-is: 0 critical, 6 warnings, and
2 informational findings remain.

##### Resolution — all eight addressed at `0ccc6e6`

Every one reproduced first, and each fix checked by reverting it and confirming its test fails.
The reported measurements reproduced closely — 88.8 MB exactly, 32.9 ms against ~34, and a pick
scan of 12.6–13.9 ms against 8.8–9.1.

| Finding                         | Outcome                                                                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clip planes ignored             | **Fixed.** Reachable by ordinary dollying, since `Camera3D` derives near and far FROM the distance: at distance 100 a 100-unit cloud's near points return clip z ≈ -1.5e7, and below distance 50 the far side crosses z = 1. Both paths now require `0 ≤ z/w ≤ 1`.          |
| `framingFor` ignores FOV/aspect | **Fixed.** Confirmed at 2.0 and 5.1                                                                                                                                                                                                                                         | NDC | in portrait — and the old factor was already tight in landscape (2.5 against the 2.61 the vertical half-angle needs), so it fails the corner test at 800×600 too. Distance now derives from both half-angles; the viewer supplies them. |
| Stale `contrastLimits`          | **Fixed**, mirroring `ShapesLayer`'s existing `_contrastExplicit` — a derived window follows the values, a pinned one does not.                                                                                                                                             |
| Picking ignores per-point style | **Fixed.** This PR introduced the incoherence: it added per-point size and alpha, then picked with a flat radius and no visibility test. `radiusAt` / `pickable`, matching `nearestPointIndex`'s existing `sizeAt`.                                                         |
| O(N) pick scan                  | **Fixed.** `ScreenIndex` buckets the projection into a flat CSR grid: 0.066 ms against 12.6 ms, about 190×, for a 43.5 ms build — which only pays off built LAZILY, on the first pick after the projection changed. Documented, with a threshold below which it is skipped. |
| Whole-instance style re-upload  | **Fixed.** Two buffers on two version counters: a selection click now costs 21.5 ms / 29.6 MB instead of 32.9 ms / 88.8 MB, leaving the static 59.2 MB alone.                                                                                                               |
| Reversed near/far test comment  | **Fixed** — the comment was wrong, the test was right.                                                                                                                                                                                                                      |
| Stale lockfile root metadata    | **Fixed** — regenerated; root now reads 0.14.0.                                                                                                                                                                                                                             |

napari-js goes to 308 tests (from 279). Downstream adopted the same round: the hover pick now
uses the enlarged radius the renderer draws selected markers at, and builds a `ScreenIndex` in the
existing lazy hover slot.

**The duplicate dependency is fixed.** `napari-js` was declared in both `dependencies` (`^0.14.0`)
and `devDependencies` (`^0.13.0`); the dev copy is removed. The lockfile still resolves 0.13.0 and
cannot be regenerated against 0.14.0 until it is published — everything here was verified against a
locally built 0.14.0 staged into `node_modules`. Publishing remains an outward-facing human action.

Still to do, and unchanged in principle: reduce `NapariVisualizerService` to a thin renderer adapter
and split the remaining domain orchestration into focused collaborators. Removing the workarounds
took roughly 130 lines out of the service, which is not the point — the point is that five renderer
concerns are no longer its business, so the split that follows is now a split along domain lines
rather than an attempt to file renderer workarounds under new headings.

### P3 — toolchain baseline (partly fixed)

Done: root `engines.node: ">=20.9.0"` (the tightest floor Angular 17 and ng-packagr declare,
and compatible with the tile server's existing `>=20`), a `.nvmrc` that `setup-node` now
reads in both CI jobs so they cannot drift, and `.npmrc` with `engine-strict=true` — without
which `engines` is advisory and an old Node still reaches an opaque Vite failure. Checked
that this rejects an unsupported Node and does not break the existing 1,137-package install.

Not done: the 171-file Prettier normalization and the 717-warning budget. The review's own
recommendation is to normalize formatting in a dedicated change so it does not obscure
functional work, and that applies to this change too.

### Verification after the fixes

| Check                   | Result                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| `npm run typecheck`     | Passed                                                                 |
| `npm run lint`          | 0 errors, 717 warnings (unchanged; tile server now included and clean) |
| `npm test`              | Passed: 76 suites, 1,551 tests (+10)                                   |
| `npm run build`         | Passed                                                                 |
| `npm run build:example` | **Passed** (was failing)                                               |
| `npm run test:server`   | Passed: 19 tests                                                       |
