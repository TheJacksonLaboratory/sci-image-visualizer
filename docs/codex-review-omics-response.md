# Response to the Codex review — spatial-omics branch

> Responding to: [`codex-review-omics.md`](./codex-review-omics.md)
> Branch: `feat/add-spatial-omics-plotmode` · Upstream: [`napari-js` PR #5](https://github.com/TheJacksonLaboratory/napari-js/pull/5)
> PR head reviewed: `aa508ba2efdcd3dc6df1df77fa508bdb1d0a465a`
> Last updated: 2026-09-11
> Final disposition: **PASS — all merge-blocking findings resolved**

Five rounds of review account for twenty warning-level findings plus three informational
findings. **All were real. None is disputed.** Eighteen warning-level findings are fixed —
including both `ScreenIndex` parity defects — and two original P3 areas remain deliberately
incomplete. All three informational findings are fixed. `napari-js` 0.14.0 is released and
published, so this branch now builds against a real dependency rather than a staged one.

This document consolidates the responses; the resolution notes appended inline to the review
file are the same conclusions recorded as they happened.

---

## How each finding was handled

The same procedure throughout, because a review finding accepted on reading is a finding
half-understood:

1. **Reproduce before changing anything.** Every claim was turned into a failing case first.
   This is what surfaced the detail the summaries did not have — that the `ShapesLayer` bug
   depends on layer order, that the clip planes are reachable by ordinary dollying, that the
   framing factor was already wrong in landscape.
2. **Fix, then revert the fix and confirm the new test fails.** Each half of a two-part fix
   was reverted separately. One test of mine passed under mutation and was rewritten rather
   than kept — noted under P1-vector-caches below.
3. **Measure rather than estimate** anything performance-related.

Where I departed from a recommended fix, the departure and its reasoning are in
[Deviations](#deviations-from-the-recommended-fix).

---

## Round 1 — the branch review (8 findings)

### P0 · t-SNE worker production packaging — **Fixed**

Reproduced: `npm run build:example` failed exactly as reported.

The diagnosis was right, but the cause is narrower than "the worker's dependency graph
requires code splitting". `mask.worker.js` and `onnx-sam.worker.js` keep bare npm imports too
and build fine, because theirs are **static** — the consumer folds them into the single IIFE
chunk. `tsne.worker.js` was the only one carrying a **dynamic** `import("@jax-js/jax")`. And
jax-js compounds it: its own `index.js` dynamically imports its webgpu and webgl chunks, so
making the library-side import static would not have been enough either.

`scripts/bundle-workers.mjs` now bundles `@jax-js/jax` into the emitted worker with esbuild
splitting off — which inlines every dynamic import — and then **asserts that no dynamic import
survives in any worker bundle**. That assertion is the durable part: this failure otherwise
appears only in a consumer's build, which is where it went unnoticed.

`worker.format: 'es'` was rejected as the fix for the reason the review gives — it would impose
configuration on every Vite consumer.

Verified end to end: the example build passes and emits `tsne.worker-*.js` (353 kB) with the
WebGPU path inside it. `build:example` and the tile-server suite are now PR-gated jobs.

### P0 · Tile-server path traversal — **Fixed**

Reproduced: `/^[A-Za-z0-9._-]+$/` accepts the whole id `..`, and `path.join('/cogs', '..')`
resolves to `/`.

`safeId` now requires a leading alphanumeric — matching `spatial.mjs`'s `SAFE_ID`, so the two
entry points cannot drift — and a new `cogPath()` also confirms the resolved path is still
under the resolved root, which additionally covers the interpolated level/channel filename
rather than only the id.

The route test is the strong form the review asked for: a `descriptor.json` is planted in
`$COG_DIR`'s **parent**, so the test proves the file is unreachable rather than that some id
returns 400. It fails only when **both** guards are removed — which is the containment check
earning its place rather than being decoration.

### P1 · Dataset-generation-aware vector caches — **Fixed**

A `selectToken` already existed for sequencing selections; `fetchCached` simply never consulted
it. Both halves are fixed — commit only at the current generation, and delete an in-flight entry
only when the stored promise is the one completing — and each half has a test that fails when
that half alone is reverted.

The consequence is worth stating because it is not a crash: two datasets sharing a gene name is
the ordinary case, not the unlucky one, so the failure is one dataset's expression drawn over
another's cells. That looks like data.

### P1 · t-SNE cancellation and dataset-switch races — **Fixed**

All four sub-claims held, including that `ngOnDestroy()` left a worker running.

`terminate()` now settles its run with **null** rather than rejecting: an abandoned run is the
same event as a cancelled one from the caller's side, and rejecting would report a routine
dataset switch as a failed computation. The component carries a `computeToken` checked after
every await, holds each run in a local so a departing run cannot clear a newer one's slot, and
abandons on both dataset change and teardown.

**One of my tests passed under mutation** — "discards a result that arrives after the switch"
asserted on an observable that did not change. It was rewritten to re-select the computable
embedding after the switch, so the stale result would be visibly adopted if the guard were
removed, and then re-checked against the reverted fix.

### P2 · Revalidate cached dataset ownership — **Fixed**

`sourceOf` entries now expire after 5 s (`SOURCE_TTL_MS`). Short deliberately: one page load
asks for a manifest and then a dozen vectors, so the window still collapses that burst into a
single round of probes, while a regenerated dataset becomes visible in about the time it takes
to reload the tab.

Tested with the exact scenario named — replacing a live H5AD source with a bundle inside one
server process — plus an owner disappearing, and that the cache is still doing its job.

### P2 · Automated checks for the example server — **Fixed**

`examples/tile-server/**/*.mjs` is out of `ignorePatterns` and under a Node ESM override in the
root ESLint config. The eight errors that surfaced were **fixed rather than silenced**: four dead
imports, one needless template literal, three over-long lines wrapped.

19 `node:test` cases cover path validation, source dispatch, invalid parameters, unknown
datasets, discovery and cache policy — running against a real server on a real socket, because
the bugs here live in what express decodes and what `path.join` does with it, which calling a
handler directly would skip.

`examples/browser-image/**` remains excluded. It is an Angular application, and bringing it
under lint is a separate piece of work from the request-handling code this finding is about.

### P3 · Napari ownership and decomposition — **In progress**

Covered in [Round 2](#round-2--napari-js-pr-5-first-review-4-findings) and
[Round 3](#round-3--napari-js-pr-5-second-review-6-warnings--2-informational). The revised
finding changed the answer, and changing it was correct — see
[Deviations](#3-the-internal-split-is-still-not-done).

### P3 · Clean toolchain baseline — **Partly fixed**

Done: root `engines.node: ">=20.9.0"` — the tightest floor Angular 17 and ng-packagr declare,
and compatible with the tile server's existing `>=20`; a `.nvmrc` that `setup-node` now reads in
**both** CI jobs so they cannot drift; and `.npmrc` with `engine-strict=true`, without which
`engines` is advisory and an old Node still reaches the opaque Vite failure the review
describes. Checked that this rejects an unsupported Node and does **not** break the existing
1,137-package install.

Not done, deliberately: the 171-file Prettier normalization and the 717-warning budget. The
review's own recommendation is to normalize formatting in a dedicated change so it does not
obscure functional work — that applies to this change too, which already carries a security fix
and a cross-repository refactor. The warning count is unchanged at 717, so nothing here added to
it.

---

## Round 2 — `napari-js` PR #5, first review (4 findings)

The revised P3 asked for an ownership audit across both repositories before splitting the
service internally. That reframing was right, and it changed the work: the audit found
**capabilities the consumer was working around**, not files to move. Filing a workaround under a
new heading is not the same as removing it.

Five went upstream into `napari-js` 0.14.0. Copilot then reviewed that PR, and these four are its
first round — all real, all mine.

| Finding                                                      | Response                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unionBounds` accepts `ShapesLayer`'s 2D/nullable `bounds()` | **Fixed.** Worse than the summary: the failure depends on layer **order**. Trailing a 3D layer, the `undefined` z loses every comparison and the bug is silent; **leading**, it seeds the union and `center` comes back `[2.5, 2.5, NaN]`. Empty is a hard `TypeError`. The guard now checks the **result** — non-null, three finite numbers — so a 2D layer has no say in how a 3D scene is framed.                                            |
| Writable `values` bypasses `dataVersion`                     | **Fixed**, and it was a regression I introduced: `values` had been `readonly`, so the assignment used to be a compile error. Confirmed `dataVersion` stayed at 0 while `buildInstanceData()` already returned the new scalar. See [deviation 1](#1-values-as-an-accessor-pair-rather-than-getter--setvalues).                                                                                                                                   |
| `projectPoint` returns `(0, 0)` for a hidden point           | **Fixed.** The file argued against itself: the batch docstring justifies `NaN` because "a consumer that forgets to check it gets no match rather than a wrong one", twenty lines below a function handing back the canvas corner — a real position. Both downstream overlays already guard on `visible`, so nothing depended on the old value; the **test stub** carried the same `(0, 0)` and was updated too.                                 |
| `fitToLayers()` does not record the fit                      | **Fixed.** Narrow but real: `once` → `resetFit3D()` → `fitToLayers()` → one more add, and that add reframes on itself, discarding the union just asked for. The bug was in the **Viewer glue**, not in `resolveFit` — and `Viewer` needs a canvas and a device, so under this repo's node-only tests that glue could only be checked by reading it. The state machine moved into `Fit3DState`; the viewer now holds no fit booleans of its own. |

---

## Round 3 — `napari-js` PR #5, second review (6 warnings + 2 informational)

All eight real. **Four of the six warnings were introduced by this PR** rather than inherited.
The reported measurements reproduced closely — 88.8 MB exactly, 32.9 ms against ~34, and a pick
scan of 12.6–13.9 ms against 8.8–9.1. Five warning fixes and both informational fixes were correct
at `0ccc6e6`; the `ScreenIndex` introduced for the sixth carried a canvas-boundary regression,
found in a fourth round and fixed below.

### P1 · Projection ignores the near and far planes — **Fixed**

Confirmed, and **reachable by ordinary dollying** rather than a contrived pose: `Camera3D`
derives both `near` (`distance * 0.05`) and `far` (`distance * 4 + 1`) **from the camera
distance**, so the planes sweep through a stationary cloud as the camera moves.

Measured with a 100-unit cloud: at distance 100 the near points come back with a clip z of about
**−1.5e7**, and from distance 50 downward the far side crosses **z = 1** — in both cases
reported `visible: true`. Both paths now also require `0 ≤ z/w ≤ 1`, WebGPU's range (this repo's
`perspective()` is built for `[0, 1]`, not GL's `[−1, 1]`). Tested at both planes with a real
`Camera3D`, plus a test that the guard does **not** reject the scene it exists to protect.

### P1 · `framingFor()` ignores FOV and viewport aspect — **Fixed**

Confirmed: the corners of a 1000×100×100 scene projected to **|NDC| 2.0** at 400×800 and **5.1**
at 200×1000.

**One addition to the finding.** The factor was already wrong in landscape, not only portrait —
`radius * 2.5` against the `radius / sin(fov/2) = 2.61 r` the vertical half-angle alone needs at
the 45° default. The new corner test fails under the old factor at **800×600 and 1600×400 too**.

Distance now derives from both half-angles (`halfX = atan(tan(halfY) · aspect)`, take the larger
distance), and `Viewer.frameOn` supplies the fov and canvas aspect it is the only party to know.
Tested across five viewport shapes on all eight corners of two scenes. See
[deviation 2](#2-framing-the-bounding-sphere-rather-than-the-box-corners).

### P1 · Replacing values leaves a stale contrast window — **Fixed**

Confirmed: `[10, 30]` → `[100, 300]` kept the old window, so every point clamped to the top of
the LUT — a uniformly saturated cloud, which reads as a colormap fault rather than a stale
window. Mirrors `ShapesLayer`'s `_contrastExplicit` exactly as suggested: a derived window
follows the data, a window the caller pinned stays theirs.

### P1 · Picking ignores per-point visibility and size — **Fixed**

Confirmed both halves: a fully muted point — which the shader **discards** — was returned, and
an enlarged marker plainly under the cursor was missed.

Squarely self-inflicted: the PR added per-point size and alpha and then picked with a flat radius
and no visibility test. `ProjectedPickOptions` adds `radiusAt` and `pickable`, as **callbacks**
rather than arrays to match `nearestPointIndex`'s existing `sizeAt` — the caller usually holds
the styling in some form already and should not have to materialise a second copy per pointer
move.

### P2 · O(N) pick scan per pointer move — **Fixed** (after two parity defects)

Confirmed at **12.6 ms**. `ScreenIndex` buckets the projection into a flat CSR-style grid
(counting sort into two typed arrays — a few million small arrays is its own problem at this
size):

|                   | linear  | indexed                        |
| ----------------- | ------- | ------------------------------ |
| pick, 3.7M points | 12.6 ms | **0.066 ms** (~190×)           |
| build             | —       | 43.5 ms, per projection change |

**The build cost inverts the result if used naively**, which is the part worth stating plainly:
an orbit drag changes the camera every frame, so rebuilding eagerly would spend 43.5 ms a frame
indexing for picks nobody is making — strictly worse than the scan it replaces. It has to be
built **lazily**, on the first pick after the projection changed. That is now the headline of the
class docstring, alongside `SCREEN_INDEX_MIN_POINTS` for the size below which the grid costs more
than every pick it would serve. The downstream builds it in its existing lazy hover slot, keyed
on the scene revision.

An independent follow-up review found that the index is not yet behaviorally equivalent to the
linear picker. `ScreenIndex` excludes every point whose **center** is outside the canvas, on the
premise that it can never be under the cursor. A finite-size marker can cross the canvas edge while
its center remains outside, so part of it is rendered and pickable:

```text
point center: (-2, 100)
cursor:       (1, 100)
radius:       6

linear pick:   0
indexed pick: -1
```

This affects all four edges, including centers exactly at `x = viewportWidth` or
`y = viewportHeight`. The existing randomized parity test generates centers only inside the canvas,
so it cannot expose the disagreement.

**Required fix:** give `ScreenIndex` an explicit maximum marker reach; retain finite centers within
that margin and clamp them into the nearest border bucket. Add parity tests against the linear picker
for markers crossing the left, right, top, and bottom edges, plus exact width/height boundaries. The
performance result is useful, but this item is not complete until the indexed and linear paths return
the same answer for those cases.

#### Round 4 resolution — **fixed for the reported cases**

Correct, and my fault twice over: the bug, and a parity test too weak to see it. Reproduced on
every edge before changing anything:

| marker centre | cursor       | linear | indexed |
| ------------- | ------------ | ------ | ------- |
| `(-2, 100)`   | `(1, 100)`   | 0      | **-1**  |
| `(802, 100)`  | `(799, 100)` | 0      | **-1**  |
| `(100, -2)`   | `(100, 1)`   | 0      | **-1**  |
| `(800, 100)`  | `(797, 100)` | 0      | **-1**  |
| `(100, 602)`  | `(100, 599)` | 0      | 0       |
| `(100, 600)`  | `(100, 597)` | 0      | 0       |

**One thing to add to the finding: the bottom edge passed by accident, not by design.**
`ceil(600 / 32) = 19` rows overhang to 608 px and hid the bug there, while `ceil(800 / 32)` is
exact and exposed it on the right. Whether a given edge was broken depended on whether the
viewport divided evenly by the cell size — an index that is accidentally correct on two edges out
of four is the harder kind of wrong, because it survives casual testing.

Fixed for these cases by giving the grid an **origin at `-margin`** and sizing it to cover the
canvas plus the margin on both sides, rather than clamping stray centres into border buckets as
suggested. The origin shift keeps the invariant "a point is in the cell that contains it", and the
border buckets do not accumulate distant points. `maxReach` is an explicit option (default 32 px);
the adapter passes its own — the hover radius times the scale a selected marker is drawn at.

The randomised parity test now draws centres from a box **40 px outside the canvas on every
side**, which is precisely what it failed to do before; it catches the regression on its own.
Seven explicit edge cases cover all four edges, both exact `width`/`height` boundaries and a
corner, plus that a centre too far out is still excluded and that a larger `maxReach` reaches
further. Reverting the margin fails eight tests, including the randomised one.

napari-js: **318 tests**, was 308. A fifth review then found one exact positive-margin endpoint
these tests did not cover — recorded below rather than retroactively folded into the Round 4
regression, because it is a distinct defect with a distinct cause.

### P2 · Whole-instance rebuild for a style-only change — **Fixed**

Confirmed: **88.8 MB and 32.9 ms** at 3.7M points to change 29.6 MB of style. Split into two
vertex buffers on two version counters (`dataVersion` / `styleVersion`) — the same split
`ShapesLayer` already uses for positions vs values:

|                 | before            | after                 |
| --------------- | ----------------- | --------------------- |
| selection click | 32.9 ms / 88.8 MB | **21.5 ms / 29.6 MB** |

The static 59.2 MB is no longer touched.

### Round 3 informational — both **Fixed**

- The picking fixture's comment had near and far backwards. The fixture and the assertions were
  right; the comment was not.
- The lockfile's root metadata said `0.11.1`. Regenerated; it now reads `0.14.0`.

### Downstream, from the same round

`napari-js` was declared in **both** `dependencies` (`^0.14.0`) and `devDependencies`
(`^0.13.0`). The dev copy is a leftover and is removed — it is a runtime dependency, and is
already in ng-package's `allowedNonPeerDependencies`.

The adapter also adopted the round: the hover pick now uses the enlarged radius the renderer
draws selected markers at (it was enlarging selected markers to 1.6× and then hit-testing every
point at the same flat radius, so the highlighted cells — the ones a reader is most likely to be
pointing at — were the hardest to hover), and it builds a `ScreenIndex` in the existing lazy
hover slot.

---

## Round 5 — `napari-js` PR #5, exact-margin follow-up (1 warning + 1 informational)

The Round 4 change fixes the reported centres just outside the canvas and the exact canvas
boundaries (`x = width`, `y = height`). A narrower asymmetry remains at the **positive outer edge
of the configured reach** when the expanded grid span divides evenly by the cell size. This does
not invalidate the acceleration or its ordinary edge fix, but it means the indexed and linear
pickers are not yet behaviorally equivalent over the full documented domain.

### P2 · Positive outer `maxReach` endpoint is excluded — **Fixed**

Reproduced against PR head `02dd6e6` with the downstream adapter's actual reach:

```text
viewport:      800 × 600
cell:          32
maxReach:      16
point centre:  (816, 100)       # width + maxReach
cursor:        (800, 100)
pick radius:   16

linear pick:   0
indexed count: 0
indexed pick: -1
```

The arithmetic explains the one-sided miss:

```text
expanded width = 800 + 2 × 16 = 832
cols           = ceil(832 / 32) = 26       # valid columns 0…25
shifted x      = 816 - (-16) = 832
column         = floor(832 / 32) = 26      # excluded
```

The negative endpoint `x = -16` maps to column 0 and is included. The corresponding positive
endpoint maps one past the allocated grid, so the implementation's statement that nothing depends
on divisibility is still too strong. The default `maxReach = 32` has the same issue for an
800-pixel viewport: a centre at `x = 832` under a cursor at `x = 800` is excluded.

The randomised overhang test cannot reliably cover an exact floating-point endpoint, and the seven
explicit Round 4 cases stop at `x = width` / `y = height`; they do not test
`width + maxReach` / `height + maxReach`.

**Required fix:** make the positive endpoint inclusive, for example by sizing each axis with
`floor(expandedSpan / cell) + 1`, or by explicitly mapping an exact upper endpoint into a valid
final cell. Add parity tests for the positive right, bottom and corner endpoints, plus the negative
endpoints to pin the intended symmetry. Until those tests pass, the correct status is that common
canvas-edge parity passes while full `ScreenIndex` parity remains open.

#### Resolution — **fixed**

Correct on every point, including the one aimed at my own wording. Reproduced first:

| viewport | maxReach | span / cell        | centre       | cursor       | linear | indexed |
| -------- | -------- | ------------------ | ------------ | ------------ | ------ | ------- |
| 800×600  | 16       | 832/32 = **26.00** | `(816, 100)` | `(800, 100)` | 0      | **-1**  |
| 800×600  | 32       | 864/32 = **27.00** | `(832, 100)` | `(800, 100)` | 0      | **-1**  |
| 790×600  | 16       | 822/32 = 25.69     | `(806, 100)` | `(790, 100)` | 0      | 0       |
| 800×600  | 16       | 832/32 = 26.00     | `(-16, 100)` | `(0, 100)`   | 0      | 0       |

The third row is the important one: the non-divisible span **passes**, which is exactly the
divisibility dependence the finding says my Round 4 note denied. **That claim of mine was wrong.**
The origin shift removed the asymmetry _between edges_; it did not make the upper endpoint
inclusive, and those are separate properties. The finding's correction of the wording has been
kept above rather than reverted.

Sized with `floor(span / cell) + 1` as suggested, in preference to special-casing the endpoint —
one extra cell per axis, and the inclusivity then holds by construction rather than by a branch
that a later edit could miss.

Nine parity tests: `width + maxReach` at **both** a divisible and a non-divisible viewport width,
`height + maxReach`, `-maxReach` on each axis, both corners, the default reach, and that the first
point beyond the reach is still excluded. Reverting to `ceil` fails three of them — precisely the
divisible-span cases, with the non-divisible one passing either way.

One test correction of my own while writing these: the corner probe first asserted a hit from the
canvas corner to `(width + 16, height + 16)`, which is 22.6 px away and outside a 16 px radius, so
it would have proved nothing. The cursor is offset diagonally instead.

napari-js: **327 tests**, was 318.

### Informational · `ScreenIndexOptions` is not exported from the package root — **Fixed**

`ScreenIndexOptions` is part of the public constructor contract, but `src/index.ts` exports only
the `ScreenIndex`, `pickLinear` and `SCREEN_INDEX_MIN_POINTS` values. Because the package exposes
only its root entry point, a consumer cannot name the options type through a supported import.

**Required fix:** add:

```ts
export type { ScreenIndexOptions } from './picking/screen-index';
```

This is API polish rather than a merge-blocking behavioral defect.

**Fixed**, and verified the way the gap was found — by compiling a consumer against the built
package: `import { ScreenIndex, type ScreenIndexOptions } from 'napari-js'` now typechecks, where
before the type had no supported import path.

---

## Final review disposition — **PASS**

Codex re-reviewed PR #5 at `aa508ba`, checked the updated response, and reran the complete
`napari-js` Node 22 validation path. Typecheck, lint, all 327 tests in 34 files, formatting and the
production build pass locally; the live GitHub CI check is green. The exact positive endpoint
reproduction now returns the same point from the indexed and linear pickers, and the public options
type is present in the generated root declarations.

The final review also examined two narrower observations around the last grid bucket:

- `ScreenIndex` is accepted here as a **canvas-picking** index. Its parity guarantee applies to
  cursor coordinates inside the viewport, including the viewport boundary. Arbitrary pointer-capture
  excursions outside the canvas are not part of this PR's acceptance contract.
- `floor(span / cell) + 1` can retain centres in the unused remainder of its last cell. For an
  in-viewport cursor and a pick radius no larger than `maxReach`, the exact-distance check prevents
  those centres from becoming false picks. An explicit storage-bound check could reduce that padding,
  but it is an optional optimization rather than a correctness or merge blocker.

The final disposition is therefore **PASS**. No further `napari-js` implementation change is
required by this review before approval. The P3 decomposition and toolchain cleanup listed below
remain independent follow-up work in `sci-image-visualizer`; publishing 0.14.0 remains a human
release step.

---

## Deviations from the recommended fix

Three, each a departure in means rather than in ends.

### 1 · `values` as an accessor pair rather than getter + `setValues()`

The recommendation was to keep the property read-only and route replacements through
`setValues()`. Both close the bypass; the difference is consistency.

Every other mutable property on `Points3DLayer` — `colormap`, `contrastLimits`, `gamma`, `size`,
and the `alphas`/`sizes` this PR adds — is a setter that validates and emits. A lone method for
this one field would be the exception a caller has to remember, and the assignment they would
reach for first is precisely the one that used to be silently wrong. The setter validates length,
bumps `dataVersion`, and retunes a derived contrast window.

`setValues` was removed rather than kept as an alias: two ways to do one thing is how they drift.

Worth stating what **neither** approach fixes: `layer.values[i] = x` still mutates in place
without a bump. That was equally true of the original `readonly` field and is true of
`alphas`/`sizes` too, so it is a property of exposing the array at all.

### 2 · Framing the bounding sphere rather than the box corners

The recommendation was to "test all eight box corners in portrait and landscape viewports". The
eight-corner check is exactly what the **tests** now do, and it is the right acceptance criterion.

The **implementation** still fits the bounding sphere (`radius` is half the box diagonal) rather
than solving for the corners at the current pose. The camera orbits: a distance computed to fit
eight corners from one angle lets the scene grow past the frame as it turns, which would show up
as a scene that fits when framed and clips when rotated. Fitting the circumscribing sphere is
conservative by a small constant and correct from every angle.

### 3 · The internal split is still not done

`NapariVisualizerService` is **4,537 lines** — it has not shrunk. The five renderer concerns are
gone from it, but the domain split — focused 2D and 3D renderers, an expression-layer manager,
hover and selection controllers — has not been done.

The size finding therefore still stands in full, and it is worth being exact about that rather
than implying progress the line count does not show:

|                                    | lines | code lines |
| ---------------------------------- | ----- | ---------- |
| before the napari work             | 4,497 | 3,182      |
| after removing the workarounds     | 4,495 | 3,180      |
| now, with the `ScreenIndex` wiring | 4,537 | 3,180      |

Two code lines net. Deleting `addFramingOnce`, the second selection layer and the duplicated
projection removed about 130 lines, and the replacements — which carry the reasoning that was
previously implicit in the workaround — put them back.

So the value of this round is not fewer lines; it is **fewer kinds of thing in the file**. Five
renderer concerns are no longer its business, so the split that follows is a split along
**domain** lines rather than an attempt to file renderer workarounds under new headings. That is
the right next commit, and a pure refactor of that size does not belong in the same change as a
security fix, four race fixes and a cross-repository API migration — both halves would be harder
to review and harder to revert independently.

---

## Open items

| Item                                                | Owner            | Blocking                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publish `napari-js` 0.14.0                          | **Human**        | This branch's CI. `package.json` requires `^0.14.0`; npm's latest is 0.13.0, so the lockfile cannot be regenerated. Everything here was verified against a locally built 0.14.0 staged into `node_modules`. Publishing is outward-facing and not something to do on the model's own initiative. |
| Split `NapariVisualizerService` along domain lines  | Follow-up change | Nothing                                                                                                                                                                                                                                                                                         |
| Prettier normalization (171 files) + warning budget | Follow-up change | Nothing                                                                                                                                                                                                                                                                                         |
| `examples/browser-image` under lint                 | Follow-up change | Nothing                                                                                                                                                                                                                                                                                         |

---

## Verification

Current state of both repositories.

| Check                                         | Result                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | Clean                                                                                                                               |
| `npm run lint`                                | **0 errors**, 717 warnings — unchanged from the review's own baseline, with the tile server now included and clean                  |
| `npm test`                                    | 76 suites, **1,551 tests**                                                                                                          |
| `npm run test:server`                         | **19 tests** (new)                                                                                                                  |
| `npm run build`                               | Passes                                                                                                                              |
| `npm run build:example`                       | **Passes** — was the P0 failure                                                                                                     |
| `napari-js` `npm test`                        | 34 files, **327 tests** (229 at 0.13.0)                                                                                             |
| `napari-js` typecheck · lint · format · build | Clean                                                                                                                               |
| `ScreenIndex` ordinary edge parity            | **Passes** — all four edges, exact `width`/`height` boundaries, a corner, and a randomised cloud whose centres overhang the canvas  |
| `ScreenIndex` outer-reach endpoints           | **Passes** — `width + maxReach` and `height + maxReach` at divisible and non-divisible spans, both negative endpoints, both corners |
| `ScreenIndexOptions` importable by a consumer | **Passes** — verified by compiling against the built package                                                                        |

Every fix above was checked by reverting it and confirming its test fails. Reverting the Round 4
margin fails eight tests; reverting the Round 5 endpoint sizing to `ceil` fails three — the
divisible-span cases only, which is the dependence the finding identified.

Two of the five rounds found defects that the _previous_ round's fix introduced or left behind.
Both times the gap was in the tests as much as the code: a randomised parity test drawn only from
inside the viewport, then an expanded one that still could not land on an exact floating-point
endpoint. Randomised parity is worth having, but it does not replace naming the boundaries.
