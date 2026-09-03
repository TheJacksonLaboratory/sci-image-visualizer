# Research: is cell-boundary polygon generation feasible in WebGPU?

> Question: the example server already serves per-cell boundary rings and nothing
> draws them, because the SVG overlay cannot hold 10⁴–10⁵ outlines. Can the
> geometry be **generated** and **drawn** on the GPU instead?
> Date: 2026-09-03
> Confidence: high on everything measured in the browser (numbers below are from
> a run on this machine, not estimates); high on the napari-js capability audit
> (read from the shipped `.d.ts` and the bundle); medium on how the numbers
> generalise to other GPUs/browsers.

Measured on: Firefox + macOS (Darwin 25.6.0), WebGPU available, one discrete GPU.
Adapter reports `timestamp-query`, `shader-f16`, `indirect-first-instance`.

## Findings

### 1. Drawing 10⁵–10⁶ outlines is not the hard part
**What:** A minimal WebGPU pipeline (`line-list`, one vertex buffer, no
instancing) rendering synthetic irregular cell rings of 24 vertices each, into a
1400×900 texture, 60 frames behind one sync:

| cells | edges | vertex buffer | per frame | fps |
|---|---|---|---|---|
| 100,000 | 2.4 M | 36.6 MB | 3.48 ms | 287 |
| 400,000 | 9.6 M | 146.5 MB | 3.58 ms | 279 |
| 1,000,000 | 24 M | 366.2 MB | 6.95 ms | 144 |

**Filled** cells (centroid-fan triangles, per-vertex cluster id carried to the
fragment shader for a LUT lookup) are *cheaper* than outlines, since triangle
rasterisation beats line rasterisation here:

| cells | triangles | vertex buffer | per frame | fps |
|---|---|---|---|---|
| 100,000 | 2.4 M | 82.4 MB | 1.70 ms | 588 |
| 300,000 | 7.2 M | 247.2 MB | 3.32 ms | 302 |

**Source:** browser prototype, this machine.
**Confidence:** high (measured), medium on other hardware.
**Action:** Treat rendering as solved. At the scale the roadmap worries about
(10⁴–10⁵) the budget is single-digit milliseconds, so the design questions are
about *where the geometry lives*, not whether the GPU can draw it.

### 2. Generating the geometry in a compute shader works, and is exactly correct
**What:** One compute invocation **per ring** (not per edge) reads the wire
format as-is — `coords: array<f32>` + `offsets: array<u32>` — and writes the
expanded draw buffer. Per-ring dispatch handles variable-length rings with no
binary search and no per-edge index map: a thread reads `offsets[r]`,
`offsets[r+1]`, and walks its own ring.

Verified against the CPU expectation at rings 0, n/2 and n−1 for 20k, 100k, 400k
and 1M cells: **`maxAbsError === 0`** — bit-exact, not approximately equal.

Cost of the expansion, wall clock including a full `onSubmittedWorkDone()` sync
(so an upper bound): 54 ms at 100k cells, 131 ms at 400k, 263 ms at 1M.

**Source:** browser prototype, this machine.
**Confidence:** high.
**Action:** The expansion belongs in a compute pass. The same kernel shape does
outlines (2 vertices per edge) or fills (3 vertices per triangle, centroid fan).

### 3. The GPU expansion is ~16× faster than doing it in JS
**What:** The identical expansion written in JS took 66 ms / 567 ms / 2134 ms for
10k / 100k / 400k cells — against 131 ms on the GPU at 400k, sync included. The
JS cost is also main-thread time, which competes with the frame budget and with
Angular; the GPU cost does not.
**Source:** same prototype (JS path measured with `performance.now()`).
**Confidence:** high.
**Action:** If the geometry is ever built on the CPU, build it in a worker. The
compute path avoids the question.

### 4. The blocker is napari-js's closed renderer, not WebGPU
**What:** Read from the shipped bundle and `.d.ts`:
- `createVisual(layer)` is an `instanceof` chain over the seven built-in layer
  classes, ending in `: null`. `addLayer` stores nothing when it returns null, so
  a custom `Layer` subclass is **silently not drawn**.
- `renderer`, `target`, `ctx` and `renderFrame` are all **private** on `Viewer`.
  There is no draw hook, no custom-visual registry, no way to append a pass.
- No existing layer can carry the geometry:
  - `SurfaceLayer` (triangle mesh — the obvious candidate) *"Renders only when
    `dims.ndisplay === 3`"*, so it cannot overlay a 2D tissue image;
  - `LabelsLayer` is an *"8-bit integer label image (ids 0..255)"* with
    "uint16/uint32 label support … a follow-up" and no boundary/contour mode, so
    it cannot even express 10⁴ per-cell ids;
  - `PointsLayer` has three fixed symbols (`disc|ring|square`).
- napari-js contains **zero compute pipelines** (`createComputePipeline` and
  `beginComputePass` both appear 0 times), so a compute-based generator is new
  machinery for that package.
- `Viewer.device: GPUDevice | undefined` **is** public, and
  `canvasToWorld`/`worldToCanvas` are documented for positioning a host overlay.

**Source:** `node_modules/napari-js/dist/{napari-js.js,viewer.d.ts,layers/*.d.ts}`
(0.11.1).
**Confidence:** high (read, not inferred).
**Action:** Two viable paths, below. Neither is blocked by WebGPU.

### 5. Device limits must be requested — the default is 128 MiB, and the failure is silent
**What:** The adapter advertises `maxStorageBufferBindingSize` and
`maxBufferSize` of **2,147,483,644** (≈2 GB). A plain `requestDevice()` yields
the WebGPU *defaults*: **134,217,728** (128 MiB) storage binding and
**268,435,456** (256 MiB) buffer.

At 400k cells the 146.5 MB output buffer therefore failed validation:

```
Buffer binding 2 range 153600000 exceeds `max_*_buffer_binding_size` limit 134217728
```

The dispatch was dropped and the buffer stayed **zeroed** — the first
investigation run reported plausible-looking "wrong coordinates" (max error
3993) purely because it compared zeros against expectations. The validation error
is asynchronous; without `pushErrorScope` it is easy to miss entirely.

Passing `requiredLimits` (raised to 1 GiB here) made the same case exact and
fast. napari-js's own device request passes `requiredFeatures` only and **no
`requiredLimits`**, so a layer added upstream inherits the 128 MiB ceiling until
that changes.

Per-cell budget at 24 vertices: outlines 384 B/cell → ~349k cells per 128 MiB
binding; fills 864 B/cell → ~155k cells. So chunking into several bindings (or
raising the limits) is required at 10⁵–10⁶ either way.

**Source:** browser prototype with `pushErrorScope('validation')`.
**Confidence:** high.
**Action:** Whatever path is taken: raise the limits *and* chunk, and wrap the
first dispatch in an error scope — a silently zeroed buffer looks like a
coordinate bug, which is how an afternoon disappears.

### 6. The wire format already fits; the local test data does not exist
**What:** `SpatialPolygons` is flat `coords` + `offsets` with implicit closure —
"deliberately NOT GeoJSON objects, which cost one object + one array per cell" —
which is exactly what a compute kernel wants as a storage buffer, no repacking.
Measured from the running server, `demo-brain`: 1,983 rings × 16 vertices,
31,728 vertices, 261,764 bytes.

The real segmentation datasets (Visium HD ~84k cells, HER2+) are *symlinks into a
previous session's scratchpad* and are gone, so no real cell outline was measured
— vertex counts per real cell (~20–60) are from the format's own conventions, not
from data on this machine.
**Confidence:** high on the demo numbers and the format; medium on real
per-cell vertex counts.
**Action:** Re-run `npm run fetch-abc`-style ingestion for HD before sizing the
production buffers.

### 7. Measurement traps in this environment
**What:** Firefox returns **zeroed** `timestamp-query` results (`raw: ["0","0"]`)
even though the feature is advertised and enabled — five consecutive runs, all
zero. And a naive `submit()` + `onSubmittedWorkDone()` per frame costs a fixed
**~104 ms** here regardless of workload: the first prototype reported "10 fps" at
10k, 100k *and* 400k cells, which was measuring the sync, not the scene.
**Confidence:** high.
**Action:** Amortise many submits behind one sync (60 frames, one wait), and do
not trust GPU timestamps in Firefox.

## Summary

**Feasible, with room to spare.** Generating cell-boundary geometry in a WebGPU
compute pass is bit-exact and takes ~130 ms for 400k cells including a full sync,
against ~2.1 s for the same work in JS; drawing the result costs 3–7 ms per frame
at 10⁵–10⁶ cells, and filled cells are cheaper than outlines. The wire format
already delivers the rings in the shape a storage buffer wants.

The real constraint is **napari-js**: its renderer selects visuals with an
`instanceof` chain over seven built-in layers and exposes no draw hook, its only
mesh layer is 3D-only, its labels layer is 8-bit, and it uses no compute at all.
So the choice is:

- **Path A — a `ShapesLayer` upstream in napari-js.** The durable answer: their
  camera, their z-order, their blending, and it benefits every consumer. Needs a
  layer + visual (line-list and/or triangle-list), `requiredLimits` raised, and
  ideally the compute expansion. Costs an upstream release cycle.
- **Path B — a second, transparent WebGPU canvas above napari's.** No upstream
  change: our own device and pipeline, camera synced through the `Viewer.camera`
  /`canvasToWorld` API that already exists for exactly this purpose. Verified
  that a second device and context coexist with napari's while it holds its own
  canvas. Limits: strictly above everything napari draws (no interleaving with
  its layers), and one more context to keep in sync per frame.

**Recommendation:** Path B first, because it replaces precisely the piece that
does not scale — the SVG overlay already lives above the canvas and already syncs
to the camera, so the surrounding machinery exists and only the drawing changes —
and Path A as the durable follow-up, informed by whatever Path B teaches about
the interaction model (hover, per-cell picking, selection). Either way the
expansion goes in a compute pass, chunked to ≤128 MiB bindings unless the device
is created with raised limits.

## Open Questions

1. **Fills or outlines, or both?** Filled cells coloured by cluster is what the
   literature publishes and is cheaper to draw; outlines are what "boundary"
   suggests and compose better over a stained image. The choice changes the
   kernel's output shape (3 floats/vertex with a value vs 2 floats).
2. **Non-star-convex boundaries.** A centroid fan is exact for cell-shaped rings
   and needs no triangulator. Tissue-region annotations and lobed nuclei are not
   star-convex and would need a real triangulation (earcut on the CPU, or a
   sweep on the GPU). Is the layer only ever for cells?
3. **Picking.** Which cell is under the cursor? Sensible options are an id
   render target (an extra pass writing cell ids, read back on hover) or a CPU
   spatial index over the resident rings. This decides whether the layer needs a
   second render target.
4. **Where the rings live at 10⁶.** 187 MB of ring data for 1M cells at 24
   vertices exceeds the 256 MiB default buffer limit once expanded; whether to
   raise limits, chunk, or tile by viewport is a scale decision that depends on
   the largest dataset actually targeted.
