# Codex review — sci-image-visualizer PR #24

> PR: [TheJacksonLaboratory/sci-image-visualizer#24](https://github.com/TheJacksonLaboratory/sci-image-visualizer/pull/24)  
> Title: `spatial omics modes: linked 2D/3D views, charts, selection and GPU t-SNE`  
> Base: `main` at `54652754d3a88f6ac359f0aded33b070e06234d7`  
> Reviewed head: `4096441fc401eb6f8124a8560b17f828dc508ed0`  
> Reviewed: 2026-09-11

## Verdict

**PASS — approved technically.** No critical or warning-level findings remain at the reviewed
head. The PR is mergeable, its required GitHub CI check is green, and the remaining items in this
document are non-blocking maintainability work.

The change is unusually large: 136 files and 31,571 additions / 237 deletions. That increases
integration risk, but the branch now has appropriate coverage for its highest-risk boundaries:
consumer worker packaging, asynchronous dataset changes, tile-server path containment, spatial
wire formats, renderer picking, and the example application.

### Current finding count

| Severity | Count |
| -------- | ----: |
| Critical |     0 |
| Warning  |     0 |
| Info     |     5 |

## Validation

The following checks were run against the exact reviewed head, using the repository's Node 24
toolchain where applicable.

| Check                                   | Result                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `npm run typecheck`                     | Passed                                                                     |
| `npm test -- --runInBand`               | Passed: 76 suites, 1,551 tests                                             |
| `npm run test:server`                   | Passed: 19 tests                                                           |
| `npm run build`                         | Passed; all three workers were emitted, including the bundled t-SNE worker |
| `npm run build:example`                 | Passed against the staged package                                          |
| GitHub CI: typecheck, lint, test, build | Passed                                                                     |

The example build still emits Vite warnings about large chunks, a mixed static/dynamic TIFF import,
and `eval` in the third-party `file-type` package. These are recorded below as measurement and
dependency follow-up, not as evidence that PR #24 is incorrect.

## Findings

Findings are ordered by recommended follow-up priority. All are informational and do not block
merge.

### INFO-1 — Decompose the Napari adapter by domain

- **File:** `src/lib/implementations/napari-js/napari-visualizer.service.ts:304`
- **Pass:** Readability and architecture
- **Evidence:**

  ```ts
  export class NapariVisualizerService extends BaseStoreVisualizer implements IVisualizer {
  ```

  The service is 4,545 lines and owns image loading, 2D/3D rendering, spatial encodings, selection,
  hover, overlays, export, camera state, and several lifecycle concerns. PR #24 correctly moved
  renderer primitives such as spatial indexing into `napari-js`, but the downstream adapter remains
  the largest concentration of change risk.

- **Recommendation:** Keep `NapariVisualizerService` as the `IVisualizer` facade and extract focused
  collaborators for 2D layers, 3D volume/surface setup, spatial-expression encoding, and
  hover/selection coordination. Preserve the existing public contract and move tests with each
  extracted responsibility.

### INFO-2 — Split chart orchestration from chart presentation

- **File:** `src/lib/spatial-controls/spatial-charts/spatial-charts.component.ts:95`
- **Pass:** Readability and maintainability
- **Evidence:**

  ```ts
  export class SpatialChartsComponent implements OnInit, AfterViewInit, OnDestroy {
  ```

  This new component is 1,310 lines and combines Angular lifecycle handling, asynchronous embedding
  computation, cancellation, Plotly trace construction, selection synchronization, and window
  management. Its race guards are correct and tested, but future changes will have a broad review
  surface.

- **Recommendation:** Extract an embedding-run coordinator and chart/window state model. Leave the
  component responsible for binding inputs, rendering Plotly output, and forwarding user actions.
  Keep the `computeToken` and worker-termination tests at the coordinator boundary.

### INFO-3 — Bring the browser example under lint coverage

- **File:** `.eslintrc.json:8`
- **Pass:** Consistency and automated enforcement
- **Evidence:**

  ```json
  "examples/browser-image/**"
  ```

  PR #24 strengthens CI by building the staged library through the browser example, but that example
  remains excluded from ESLint. Build coverage catches packaging and compilation faults; it does not
  enforce the TypeScript and Angular conventions applied to `src/`.

- **Recommendation:** Add an ESLint override appropriate for the Vite example, remove this ignore,
  fix the surfaced errors, and keep the example in the root `lint` script.

### INFO-4 — Establish ratchets for existing lint and formatting debt

- **Files:** `package.json:45`, `package.json:48`
- **Pass:** Consistency
- **Evidence:**

  ```json
  "lint": "eslint \"src/**/*.ts\" \"src/**/*.html\" \"examples/tile-server/**/*.mjs\"",
  "format:check": "prettier --check \"src/**/*.{ts,html,scss}\" \"*.{json,md}\" \"docs/**/*.md\""
  ```

  ESLint completes with 0 errors but 717 warnings, and the repository-wide Prettier check reports 171
  files. This is inherited repository debt rather than a functional defect in the feature. Without a
  ratchet, however, CI cannot distinguish old warnings from new ones, and `format:check` cannot yet
  serve as a useful merge gate.

- **Recommendation:** Normalize formatting in a dedicated change, then add `format:check` to CI.
  Capture the warning count as a temporary upper bound and lower it incrementally until lint can run
  with `--max-warnings=0`.

### INFO-5 — Add a browser bundle-size budget

- **File:** `.github/workflows/ci-cd.yaml:51`
- **Pass:** Performance
- **Evidence:**

  ```yaml
  - name: Build the example against the staged package
    run: npm run build:example
  ```

  The new consumer build gate is valuable and passes, but Vite reports a main JavaScript chunk of
  approximately 8.24 MB (2.27 MB gzip) and warns about chunks over 500 kB. The build currently checks
  only whether bundling succeeds, so a future dependency or eager import could substantially grow the
  download without failing CI.

- **Recommendation:** Record the current asset sizes, decide which large dependencies are expected,
  and add a deliberately tolerant gzip budget. Tighten it after separating optional visualization
  modes with lazy imports. Treat third-party `eval` and mixed-import warnings separately rather than
  suppressing all Vite warnings.

## Five-pass review

### 1. Correctness

**No current correctness findings.** The most important prior failures have been corrected and
regression-tested:

- The t-SNE worker is emitted as a self-contained consumer-safe bundle, and the build script rejects
  surviving dynamic imports.
- Dataset-generation-aware vector caching prevents late results from one dataset being committed to
  another.
- t-SNE runs are terminated and invalidated on replacement, dataset switch, and component teardown.
- Source-owner cache entries expire and are revalidated.
- `napari-js` 0.14.0 contains the exact `ScreenIndex` positive-boundary fix and public type export;
  this branch resolves the published package rather than a staged local dependency.

The reviewed implementation also includes focused tests for spatial wire validation, plotting,
selection, hover, sections, framing, density, expression, embeddings, and renderer integration.

### 2. Security

**No current security findings.** The earlier COG path-traversal defect is closed at
`examples/tile-server/lib/cog.mjs:176-198`: identifiers require a leading alphanumeric and the
resolved path must remain inside the resolved COG root. Route-level tests place a sentinel outside
the root and prove that it cannot be read. Dataset identifiers in the other spatial routes use the
same restricted identifier model.

### 3. Performance

**No merge-blocking performance findings.** Heavy t-SNE work runs in a worker; `napari-js` performs
large-cloud picking through a lazy spatial index; and dataset vectors are cached with
generation-aware invalidation. INFO-5 recommends a bundle-size budget because the example build is
large, not because a measured runtime regression was found.

### 4. Readability

**Two informational findings:** INFO-1 and INFO-2. The lower-level spatial math and trace building are
already separated into pure, tested modules. The remaining opportunity is to reduce the two large
orchestrators so their lifecycle and renderer responsibilities can evolve independently.

### 5. Consistency

**Two informational findings:** INFO-3 and INFO-4. The tile server is now included in lint and has a
dedicated test suite. The browser example and the repository's existing warning/format baselines are
the remaining enforcement gaps.

## Resolved review history

The detailed investigation and author responses remain available in:

- [`codex-review-omics.md`](./codex-review-omics.md) — original findings and subsequent napari-js
  ownership/boundary follow-ups.
- [`codex-review-omics-response.md`](./codex-review-omics-response.md) — reproductions, fixes,
  mutation checks, deviations, and final verification evidence.

The following issues were merge blockers earlier in the branch but are **not open findings at the
reviewed head**:

| Former priority | Area                                                  | Final state                            |
| --------------- | ----------------------------------------------------- | -------------------------------------- |
| P0              | t-SNE worker production packaging                     | Fixed and consumer-build gated         |
| P0              | Tile-server path traversal                            | Fixed with containment and route tests |
| P1              | Vector-cache dataset races                            | Fixed with generation-aware commits    |
| P1              | t-SNE cancellation and dataset-switch races           | Fixed and lifecycle tested             |
| P2              | Stale source-owner caching                            | Fixed with TTL revalidation            |
| P2              | Tile-server lint and test coverage                    | Fixed; 19 tests and CI coverage        |
| P2              | napari-js ownership and `ScreenIndex` boundary parity | Fixed upstream in published 0.14.0     |

## Prioritized post-merge TODOs

1. Decompose `NapariVisualizerService` behind its existing facade.
2. Split embedding orchestration and window state out of `SpatialChartsComponent`.
3. Bring `examples/browser-image` under ESLint.
4. Normalize Prettier output and ratchet the ESLint warning count.
5. Establish a browser bundle-size baseline and CI budget.

None of these TODOs changes the **PASS** disposition for PR #24.
