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

### P3 — Decompose the Napari backend

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

**TODO:** Extract focused 2D and 3D spatial renderers, an expression-layer manager, and hover and
selection controllers. Keep the service responsible for top-level viewer lifecycle and orchestration.

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

| Pass        | Result      | Main concerns                                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| Correctness | Fail        | Production worker build; cross-dataset cache pollution; stale t-SNE results; stale source ownership            |
| Security    | Fail        | `..` escapes the configured COG directory; example-server paths lack regression coverage                       |
| Performance | Conditional | Terminated worker promises can remain pending and retain component state                                       |
| Readability | Conditional | The Napari service has accumulated too many spatial responsibilities                                           |
| Consistency | Fail        | Packaged-consumer build is not a PR gate; examples bypass lint/test; tool versions are not aligned at the root |

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
6. Split the Napari spatial responsibilities.
7. Normalize the Node, lint, and formatting baseline.

---

## Resolution — 2026-09-09

Every finding was reproduced against the code before being acted on, and each fix was
checked by reverting it and confirming the new test fails. Where a first attempt at a test
passed under the reverted fix, the test was rewritten rather than kept.

| #   | Finding                                     | Status                       |
| --- | ------------------------------------------- | ---------------------------- |
| P0  | t-SNE worker production packaging           | **Fixed**                    |
| P0  | Tile-server path traversal                  | **Fixed**                    |
| P1  | Dataset-generation-aware vector caches      | **Fixed**                    |
| P1  | t-SNE cancellation and dataset-switch races | **Fixed**                    |
| P2  | Revalidate cached dataset ownership         | **Fixed**                    |
| P2  | Automated checks for the example server     | **Fixed**                    |
| P3  | Decompose the Napari backend                | **Deferred** — see below     |
| P3  | Clean toolchain baseline                    | **Partly fixed** — see below |

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

### P3 — Napari decomposition (deferred)

Accurate, and worth doing. Not done here on purpose: it is a pure refactor of ~4,500 lines
with real regression risk, and folding it into a change that also carries a security fix and
four race fixes would make both halves harder to review and harder to revert independently.

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
