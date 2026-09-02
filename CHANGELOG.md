# Changelog

All notable changes to `@jax-data-science/sci-image-visualizer`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries before 0.2.7 were reconstructed from the git history at the time this
file was added.

## [Unreleased]

### Added

- **Spatial-omics data plane** — contracts for spatial-omics datasets (Visium
  spots, segmented cells) so the library can hold N observations positioned in a
  tissue image's pixel space, each with categorical and continuous annotations
  and a lazily-fetched feature (gene) matrix. This is the data layer only; the
  plot mode that renders it is designed but not built
  ([docs/spatial-omics-plot-mode-design.md](docs/spatial-omics-plot-mode-design.md)).

  - `SpatialDataset` and friends (`contracts/spatial-dataset.contract.ts`):
    struct-of-arrays observations, `CategoricalColumnMeta` /
    `ContinuousColumnMeta` descriptors, `SpatialFeatureMeta`, flat-ring
    `SpatialPolygons`, and a `SpatialImageRef` affine. Typed arrays rather than
    object-per-cell because datasets run 10³ (Visium) to 10⁶ (Xenium/CosMx)
    observations.
  - `SPATIAL_DATA_PORT` / `SpatialDataPort` (`contracts/ports/spatial-data.port.ts`):
    the host-supplied accessor, mirroring `TILE_ACCESS_PORT`. Metadata is eager,
    vectors are lazy — a Visium table is ~31k genes wide (~800 MB dense), so
    loading a dataset can never mean loading its matrix.
  - `SpatialDataHttpService` — an **optional** reference adapter (`@Injectable()`
    with no `providedIn`, like `CellposeSegmenterService`) for the wire format
    the bundled example server speaks. Requests go through `HttpClient` so host
    interceptors apply; loaded vectors are cached with a bounded LRU and
    concurrent requests for the same vector are coalesced.
  - `spatial-wire.ts` — the wire format and its pure decoders, exported so a
    host can reuse them over its own transport.
  - `PlotDataSource` gains `'spatial'` alongside `'image'` and `'regions'`.
  - `PlotTypeDescriptor.requiresSpatialData` — a declarative selector gate, in the
    same shape as `requiresStack` and `requiresGrayscale`: a plot type that
    renders a `SpatialDataset` is offered **only while one is published** on
    `SPATIAL_DATA_PORT`, and is withdrawn (falling back to Image) when the
    dataset is cleared. `VisualizerComponent` injects the port `@Optional()`, so
    a host that never provides it simply never sees the spatial modes. No
    shipped plot type sets the flag yet — the rendering mode is the next phase.

- **Spatial-omics plot mode — renderer** (`PlotType.SPATIAL_OMICS`). Draws one
  marker per observation over the tissue image through napari-js, coloured by an
  annotation column or a gene. Gated by `requiresSpatialData`, so it appears in
  the selector only while a dataset is loaded.

  - `spatial-encoding.ts` — backend-neutral, pure encodings, exported for reuse:
    `encodeCategorical` / `encodeContinuous` (flat `Float32Array` RGBA),
    `resolveCategoryColors` (the column's authored palette first, then a
    colour-blind-safe default, then a deterministic name hash),
    `contrastWindow` (percentile clipping so outliers don't flatten the ramp),
    `markerDiameters` (radius → the diameter napari sizes markers by), and
    `lutFor`. Log scaling is applied for count-like columns, per the CosMx
    guidance; `NaN` and unassigned categories render as muted grey rather than
    as the ramp floor or a real category.
  - `SpatialViewState` on `VisualizerStore` (`colorBy`, `pointScale`, `opacity`,
    `logScale`, `percentileClip`) — editing it rebuilds the markers without
    remounting the scene, the same way colormap edits recolor an image.
  - The dataset's `imageRef` affine is applied as the layer's `scale`/`translate`,
    so spot coordinates recorded in one frame land correctly on an image served
    in another.
  - An out-of-order guard: a gene fetch is a round-trip, so a superseded colour
    change cannot attach its result to a newer scene, and a failed fetch falls
    back to a flat colour rather than blanking the view.

  Not yet built: legend and gene-picker UI, hover tooltips, selection, the linked
  1D charts, and background subsampling. When napari-js is unavailable the
  fallback renders the tissue image **without** the observation layer.

- **Spatial-omics selection.** `SpatialSelectionStore` holds the selected
  observations; `spatial-selection.ts` computes them. Selecting is driven from
  the **existing ROI tools** — rectangle, polygon, freehand, magic wand, brush —
  so no new canvas interaction was added: the controls panel's *Select from ROIs*
  button tests every observation against the union of the drawn regions. Legend
  rows are also clickable (click again to clear).

  Unselected observations render muted while a selection is active, and nothing
  is muted when it is empty — the CosMx highlight-vs-mute rule, applied to a flat
  colouring as well, so selecting is visible before a colour source is chosen.

  The geometry is a ray cast with a bounding-box pre-reject, honours polygon
  holes (a point inside the exterior and inside a hole is outside), ignores
  shapes that enclose no area (open polylines, profile-line ROIs, degenerate
  rectangles), and applies the dataset's `imageRef` affine so the test happens in
  the same world space the regions were drawn in. Changing dataset drops the
  selection, since the masks are index-based.

- **`<spatial-controls>` panel** (`SpatialControlsComponent`) — a non-modal,
  resizable, draggable dialog for the spatial mode, opened from a toolbar button
  that appears only while that mode is active. Offers a colour-by-column
  dropdown, a gene typeahead over the feature panel, a clickable legend for
  categorical colourings, a colour bar for continuous ones, selection from the
  drawn ROIs, and point-size / opacity / log-scale / outlier-clip controls. Column and gene selection are mutually
  exclusive, so what drives the colours is never ambiguous.

  Depends only on `ISpatialControls`, reached through the `VISUALIZER` contract
  token — never a concrete backend — mirroring `ChannelHistogramComponent`. With
  no `SPATIAL_DATA_PORT` bound it renders an explanatory empty state rather than
  dead controls. Legend swatches and the colour bar are built with the same
  functions the renderer uses (`resolveCategoryColors`, `lutFor`), so the key
  cannot drift from what is on screen.

- **`ISpatialControls` via `IVisualizer.getSpatialControls()`** — the host-facing
  surface for the spatial mode: colour by a column or a gene, read/patch the view
  state, search features, and resolve legend swatches. Returns null unless a
  `SPATIAL_DATA_PORT` is bound. Implemented on `RoutingVisualizerService` rather
  than a backend, because the state is backend-neutral (it lives in the shared
  store, like the colormap) — so it works before any backend has mounted and
  survives a plot-type switch. Legend colours resolve through the same function
  the renderer uses, so a swatch cannot disagree with the screen.

- **Example server: spatial-omics endpoints** (`examples/tile-server`) —
  `/spatial/datasets`, `/spatial/:id/{manifest,coords,radius,ids,polygons}`,
  `/spatial/:id/column/:name`, `/spatial/:id/feature/:name` and
  `/spatial/:id/features`. Vectors are served as raw little-endian bytes. The
  feature matrix is stored **gene-major**, so serving one gene is a contiguous
  ranged read rather than a scan of an observation-major (CSR) matrix.
  - `npm run make-spatial-demo` generates a synthetic Visium-geometry dataset
    (~2k spots on the real 100 µm hex grid, 12 mouse-brain marker genes) **and a
    matching tissue-image pyramid**, so the endpoints and the viewer work with no
    download and no Python. The image and the `region` column come from the same
    region function, so they agree by construction; spot coordinates stay in the
    full-resolution frame while the image is a ~0.31 downscale, giving the demo a
    real `imageRef` affine rather than a trivial 1:1.
  - `npm run smoke-spatial` boots the server and decodes every route end to end,
    including a numeric check that every spot lands inside the image under that
    affine.
  - The browser example gains a **Spatial omics demo** gallery entry that loads
    the image and the dataset together; selecting any other image clears the
    dataset, which withdraws the plot type.
  - `npm run make-spatial` converts a real **SpatialData Zarr store** into the
    same bundle plus a tissue pyramid — in plain Node, with no Python and no
    Zarr/Parquet libraries. These stores use Zarr v3 with `bytes` + `zstd`
    codecs and `vlen-utf8` strings, and Node 24 ships zstd in `node:zlib`, so
    `lib/zarr3.mjs` (a small read-only reader that throws by name on an
    unsupported codec) is enough.

    Verified against the scverse `visium_spatialdata_0.7.1` mouse brain: 2,987
    spots for section ST8059048, the 2,000 most-expressed of 31,053 genes
    written gene-major, and the H&E hires image at 3.96 µm/px. It filters the
    **multi-sample** table by region before index-aligning anything, takes the
    full-res → hires affine from the **spot shapes** transform (skipping it puts
    every spot ~8.7× too far out), derives µm/px by using Visium's 100 µm pitch
    as a ruler, and derives `total_counts` / `n_genes_by_counts` — a raw table
    has only `array_row`/`array_col`/`in_tissue`/`spot_id`, nothing worth
    colouring by.
  - **Segmentation stores** (Visium HD, and by extension Xenium) are supported
    alongside spot stores. These keep one table per segmentation and have an
    **empty `obsm`**, so centroids, per-cell radii and the outlines all come from
    the shapes **GeoParquet** — read via `hyparquet` (example-server dependency
    only; the library gains nothing) and decoded from GeoJSON in
    `lib/geoparquet.mjs`. Rows are joined to the table by id, not by position.

    Verified against the Visium HD 4.0.1 mouse brain: 84,031 cells, all joined,
    1.8M outline vertices served on `/polygons`, per-cell equivalent-circle radii
    from the outline areas, and a derived `area` column. `--grid-um 2` turns the
    outlines into a ruler — a segmentation traced on a binned assay steps one bin
    at a time, so the modal vertex step (7.3 px here) is one 2 µm bin, giving
    0.973 µm/px for the image and a correct scale bar.

    Two spec details this shook out: Zarr v3 **omits a chunk that is entirely
    `fill_value`** (a single-region table has no `region/codes` chunk, which the
    reader previously treated as an error), and the pyramid level is **named by
    the multiscales metadata** — `0` for Visium, `s0` for HD.
  - `--max-matrix-mb` (default 64) caps the gene-major matrix, which is
    `genes x observations x 4` bytes — 84k cells at 2,000 genes would be 672 MB,
    so it is reduced to 190 genes and says so.
  - The server's manifest cache is now **mtime-aware**: re-running the converter
    while the server is up used to serve the previous manifest until a restart.
  - `scripts/make-pyramid.mjs` + `lib/pyramid.mjs` turn any sharp-readable image
    into the tiled pyramid the server serves — the no-`vips` counterpart to
    `make-cog.mjs`.


## [0.3.3] — 2026-08-31

Backfilled: 0.3.3 was published without an entry.

### Changed

- **`cellpose-js` bumped to `^0.6.0`** (from `^0.5.0`) and **`napari-js` to
  `^0.11.1`** (from `^0.11.0`), in both `dependencies` and `devDependencies`.
  No source change was needed. The bump is covered by the ng-packagr build
  type-checking against both packages' published `.d.ts`: the unit tests map
  `napari-js` to the WebGPU-free stub in `src/lib/testing`, and reach
  `cellpose-js` only through a type-only import plus the lazy
  `await import('cellpose-js')` in `CellposeSegmenterService`.

- **Hosted model weights now live under the `jax-image-tools` Hugging Face
  organization** rather than a personal account: the default cellpose-SAM
  checkpoint (`cpsam_fp16.onnx`) and all four `SAM_MODELS` entries — micro-sam
  ViT-T and ViT-B, patho-sam ViT-B and its int8 variant. Hosts that override
  those URLs through `setModelUrl` or their own `SamModelDef` are unaffected.

## [0.3.2] — 2026-08-13

### Fixed

- **Regions handed to the store as JSON now render on every backend**
  (jit-ui#124). A `bounds` that came through `JSON.parse` — a host's server
  response, a `structuredClone` — has the right fields but not the right
  prototype, and the renderers disagreed about whether that is acceptable:
  `Region.getShape()` (Plotly) and the napari overlay duck-type the bounds,
  while the OpenSeadragon overlay discriminates with `bounds instanceof
  Rectangle`. So a JSON region drew in Heatmap mode and silently vanished in
  Image mode.

  `instanceof` also gates the store's geometry de-duplication, `moveRegion`,
  and the GeoJSON export, so the same regions were undraggable, re-appended on
  every repeat, and missing from a save — in *every* mode, unreported because
  they were at least visible.

  `RegionStore` now normalizes on the way in (`setRegions`, `addRegion`,
  `enterStackMode`) via the exported `hydrateBounds`, so the ~20 `instanceof`
  call sites downstream stay valid rather than each having to duck-type.
  Instances are passed through by reference — overlays and tools mutate the
  bounds they created during a drag. `hydrateBounds` also fills in what a lean
  serializer omits (JIT's Java `PolygonSerializer` writes only `npoints` /
  `xpoints` / `ypoints`, while the GeoJSON export reads `coordinates` and the
  overlays read `closed`).

## [0.3.1] — 2026-08-12

Backfilled: 0.3.1 was published without an entry.

### Changed

- **`cellpose-js` bumped to `^0.5.0`** (from `^0.4.1`), in both `dependencies`
  and `peerDependencies`.

### Fixed

- **The `examples/tile-server` deployment pulls its image without a
  service-account key**, and its docs/manifests carry placeholders rather than
  real identities — this repo is public. No effect on the published package;
  `examples/` is not part of it.

## [0.3.0] — 2026-08-11

### Removed

- **The YOLO and retinal-layer tools, their model registries, and the
  `yolo-segdetect-js` / `jax-ai-js` dependencies.** Their checkpoints are not
  open, so a library that named them could not be published. The built package
  now has no import edge to either — the remaining mentions are the doc comments
  explaining this.

  This includes the ResUNet-a 20x/40x checkpoints, which were briefly enabled
  here during this cycle and never released: they still run in a browser, just
  not from this package.

  What made the coupling small was that the contracts were already clean. The
  only thing pulling either package in was the *default factory* on
  `INSTANCE_SEGMENTER` / `SEMANTIC_SEGMENTER`, which fell back to an in-library
  service. Both tokens now have **no default**: unprovided means the capability
  is absent.

  The tools themselves are unchanged and move to
  `@jax-data-science/sci-image-visualizer-jax-tools`, which a JAX host registers.

### Added

- **A toolbar tool-contribution mechanism** (`TOOLBAR_TOOLS`,
  `ToolbarToolContribution`), so tools can be added from outside this library
  rather than hardcoded into the toolbar template.

  A contribution describes itself — icon, tooltips, checkpoints, parameters,
  help text — and supplies a `run`. The toolbar renders the split button and
  model menu from that, and the help dialog builds its tool list from the same
  descriptors, so an open build's help no longer promises buttons that are not
  there.

  Parameters are **declared** (`ToolParamSpec`) rather than drawn: one generic
  dialog renders every tool's fields. A plugin shipping its own dialog component
  would have to match this library's exact PrimeNG version and styling to look
  right, and the two dialogs this replaces were entirely numbers plus one
  checkbox. It is the same vocabulary jit-ui already uses for pipeline step
  parameters.

  Returning an empty model list hides a tool, which is the switch for "the
  weights are not configured in this deployment" — it keeps the tool's help and
  parameters registered without showing a button that cannot run.

### Added

- **Per-model info in all three model pickers.** Every item in the SAM, YOLO and
  retinal-layer dropdowns now carries an info icon whose hover tooltip describes
  that checkpoint: download size, speed, training domain, measured accuracy, and
  — for the tiled detectors — why its overlap and merge defaults are what they
  are.

  This replaces the single "About the SAM models" panel (removed below). That
  panel sat behind an extra click, had to restate every model's name in order to
  say anything about it, and covered only SAM — YOLO and retinal shipped with no
  explanation at all. Attaching each description to the row it describes settles
  all three at once, and puts the text where the choice is actually made.

  Copy lives in `toolbar/model-info.ts`, keyed by registry model id, and rides on
  the menu item's `tooltip` field (which `p-menu`'s own rendering ignores — it
  reads `title`). A model with no entry renders no icon, so a host that registers
  its own checkpoint degrades quietly instead of showing an empty tooltip. The
  numbers quoted there come from the registries (`sizeMb`, `miou`, `patchSize`,
  per-model tiling `defaults`) and need updating alongside them.

- **A dedicated toolbar icon for the retinal-layer tool**, replacing the
  `pi pi-align-left` placeholder: corner brackets — the framing the YOLO detector
  already uses, marking the no-prompt tools that sweep the whole view — around an
  eyeball whose posterior wall carries the segmented layers.

- **Purpose-built icons for the two SAM prompt tools**, `sam-box-prompt.svg` and
  `sam-point-prompt.svg`. The box tool wore a generic "crop a photo" glyph (a
  house behind a dashed marquee) and the point tool a stock cursor-with-sparkles;
  neither said *segmentation*, and nothing tied the two tools together.

  Both show the same subject — an outlined blob holding three cells, which is
  `cells.svg`'s vocabulary — so the only difference between the icons is the
  difference between the tools: a rectangle drawn around the object, versus a
  cursor clicking on it (with tail and click rays, as in `click.svg`). Corner
  brackets are deliberately not reused here; they mark the no-prompt tools.

  The point icon's interior is laid out around the cursor rather than the reverse:
  the cursor sits wholly inside the blob, because where it straddled the outline
  the outline's black band filled its concave notch and flattened it into a plain
  triangle; and the three cells are placed off the diagonal the cursor and its
  rays occupy, because a ray crossing a cell fuses into a lollipop. Both
  constraints are geometric rather than enforced anywhere, so moving a cell or
  resizing the cursor needs a look at the result, not just at the numbers.

  Each icon ships as one object per component (blob, each cell, cursor, each
  click ray), labelled for Inkscape's Objects panel, so a piece can be moved or
  turned without unpicking a merged path. Every object carries an identity
  `rotate(0, cx, cy)` about its own centre, so setting an angle spins it in place
  rather than swinging it around the canvas origin. Stacking is document order —
  the cursor paints over the blob — rather than the winding interactions a single
  path would need. One thing stays merged: a ring (frame, blob) keeps its outer
  and inner contour in one path, because the inner contour *is* its hole and
  separating them turns the ring into a slab.

  A thin gap separates the cursor and rays from what they overlap. It is a hole
  cut into those shapes, not white paint — the toolbar recolours icons with
  `filter: brightness(0) invert(...)`, which blackens every painted pixel before
  tinting, so white would tint to the icon colour and disappear. That makes the
  gap a property of the shapes underneath rather than of the cursor: **move or
  rotate the cursor and the notch stays where it was**, and the cut has to be
  redone against the new positions. Which objects need cutting depends on the
  layout — currently the blob and two of the three cells.

  The paths use **nonzero** winding with inner contours reversed, rather than the
  `evenodd` the other icons use. That is load-bearing:
  the arrow overlaps the blob outline, and under evenodd an overlap *cancels* —
  an earlier attempt rendered a checkerboard where the two crossed. Under nonzero
  the overlap fuses while the holes still read (hole = +1−1 = 0; a cell inside it
  = +1; arrow over the ring = +2). Rings are explicit outer+inner contours, so
  there is no stroke-to-path step to redo when the geometry changes.

  Caveat: at `width: 1rem` on a 1× display these resolve less crisply than the
  solid-blob draft they replaced — an outline plus three small circles is more
  detail than 16 device pixels can hold. They are clear from roughly 24px up.

  `picture-segmentation.svg` and `click.svg` are left in the published asset set —
  a host may reference them directly — but nothing in this library uses them now.

### Changed

- **`cells.svg` (the cellpose tool) is now framed by a rounded square** rather
  than a circle, reusing `sam-box-prompt.svg`'s frame proportions exactly — same
  inset, corner radius and weight, scaled into this file's canvas. Cellpose is a
  prompted tool that runs inside the rectangles you draw, so it belongs with the
  box-prompt framing rather than looking like a petri dish.

  It reads better small as well: at 16px a straight axis-aligned edge rasterises
  crisply where the circle went soft and wobbly. The six cells are untouched, so
  their own small-size mushiness is unchanged.

- **The help dialog documents the no-prompt tools.** Its segmentation section
  described only SAM and cellpose, so YOLO detection and retinal-layer
  segmentation were absent from the one place a user goes to find out what a
  button does. It now splits the tools by shape — prompted ones act on rectangles
  you draw, no-prompt ones sweep the current view — which is the distinction that
  explains why two of the buttons want nothing selected first.

  It also no longer points at the removed info button, and the general SAM
  material from that panel (encoders differ, prompting does not; each tool loads
  its own encoder, so the first click after switching re-encodes once) moved here
  rather than being dropped.

### Removed

- **The "About the SAM models" info button** and its overlay panel, superseded by
  the per-model tooltips above.

## [0.2.19] — 2026-08-09

### Changed

- **`jax-ai-js` ^0.1.1 → ^0.2.0.** Its stain-normalization moved out to
  `stain-normalization-js`; this library only ever used the inference API, so
  nothing here changes behaviourally.

  The reason to bump rather than leave it: a consumer on `jax-ai-js` 0.2.x
  ended up carrying **two copies** — 0.2.x hoisted, plus a nested 0.1.x for this
  library — which a bundler then emitted as two lazy chunks of the same code.

## [0.2.18] — 2026-08-09

### Fixed

- **YOLO detections keep their interior voids.** `YoloDetectToolService` built
  each `Region` from `poly.exterior` alone, so a mask with a hole through it was
  committed solid. This does not look like _lost_ geometry, it looks like a
  detection that **over-covers** — which is the harder failure to notice.

  Holes now travel through the same view→image transform as the exterior; a ring
  left in view-local pixels lands elsewhere on the slide, frequently outside its
  own exterior. Each polygon already owned its own rings (the tracer emits them
  that way, and the segmenter service mapped them through), so a mask that splits
  into several polygons under thresholding needs no disambiguation — the rings
  were simply being dropped at the last step.

  Rings that simplification reduces below three points are dropped rather than
  emitted as geometry that bounds nothing, and `holes` is left unset rather than
  set to `[]`, so a solid region does not round-trip through export as a donut
  with no rings.

### Added

- **`RetinalSegmenterService.getModel` accepts an `AbortSignal`.** The retinal
  checkpoint is ~590 MB; previously a cancel reached the inference but not the
  download, so the transfer kept running and the UI sat in "Cancelling" until it
  finished. `segmentSemantic` passes the run's own signal through.

  Cancellation lands within one graph compile rather than instantly: ORT session
  creation cannot be interrupted once started, so the signal is rechecked after
  the download and before the session is built.

  A cancel deliberately does **not** abort a load already in flight. That promise
  is shared — the toolbar tool and a host's pipeline both use this service — so
  one caller's cancel must not tear the model out from under another. A second
  caller joining an in-flight load simply waits.

### Changed

- **`jax-ai-js` ^0.1.0 → ^0.1.1**, which is where the signal plumbing lives:
  `fetchModel` already honoured a signal, but `fromPretrained` never passed one.
  No API breaks; the option is additive.

## [0.2.17] — 2026-08-09

### Added

- **Retinal-layer segmentation** — a toolbar tool, a parameter dialog, and
  `ISemanticSegmenter` / `SEMANTIC_SEGMENTER`, backed by `jax-ai-js`.

  A third segmentation port rather than a reuse of the other two, because the
  output is a genuinely different shape: cellpose separates touching instances
  of one class, YOLO returns overlapping classified objects with a confidence
  each, and this returns layers that tile the image, never overlap, and where
  two disconnected patches of a class are one finding rather than two objects.
  There is no per-object confidence and no NMS because there are no objects.

  **Only the VNet checkpoint is enabled.** Against the ground-truth masks
  shipped with them, VNet scores mIoU 0.9061 and the three ResUNet-a variants
  0.27–0.31. That is not quantization damage — each ONNX export reproduces its
  own Keras original exactly. They disagree with the _masks_, folding
  ground-truth class 1 into their class 2 and class 3 into background, and no
  relabelling rescues them (the best of all 24 permutations reaches 0.36). Their
  weights are unpublished pending that question, so their registry entries carry
  an empty `modelUrl` and a specific reason. They are listed rather than deleted
  so a host can show them as unavailable instead of pretending the server's
  choice does not exist.

  **WebGPU only, with no fallback**: ORT-Web's WASM EP dies with
  `std::bad_alloc` on these graphs at 512², at every precision.
  `WebGpuRequiredError` is re-thrown unchanged so a host can show a real
  unsupported-browser message.

  An empty result distinguishes "found nothing" from "was unsure everywhere" —
  the second is the signature of the wrong magnification or wrong preprocessing,
  and reported as a plain empty result a misconfiguration is indistinguishable
  from an empty field.

## [0.2.16] — 2026-08-08

### Added

- **`Region.source`** — which automated tool produced a region, absent on
  anything the user drew. A tool can then replace its _own_ previous output on
  a re-run without touching hand-drawn work or another tool's results.

  The YOLO tool now does exactly that. Appending unconditionally meant every
  tuning run stacked onto the last, so the viewer accumulated overlapping
  results from parameters no longer in effect — after four runs it read as
  full coverage when a single run had a quarter of the band missing.

  A marker on the data rather than object identity, because regions may be
  re-minted as they pass through the store.

## [0.2.15] — 2026-08-08

### Changed

- **Retina defaults: 60% tile overlap and a 0.8 cross-tile merge threshold.**
  Cross-tile merging uses intersection-over-_smaller_, so at 0.3 a fragment is
  discarded once 30% of its own area is covered by a larger box — even when most
  of it lies outside. On a structure detected as a chain of overlapping
  fragments that deletes the middle ones.

  Measured on one slide: at 0.3, two boxes covering 75% of the band with a
  3150px hole straight through it; at 0.8, four boxes covering 100% with no
  hole, costing two overlapping pairs. The merge value now matches what jit-ui
  already sends the server for this checkpoint.

  This diverges from the server's own table, which uses 0 overlap and 0.3 here
  and has the same blind spot.

## [0.2.14] — 2026-08-08

### Fixed

- **The scale re-crop produced a 0x0 image.** `ImageBitmap.close()` zeroes the
  bitmap's width and height, and those were read _after_ closing it — so the
  crop came back as a 0x0 image carrying a full pixel buffer. Inference then ran
  on nothing and reported no detections, with no error raised anywhere.
- **`downsamplingFactor` is now seeded in the toolbar tool's defaults.** The
  dialog exposed the control but nothing initialised it, so it read as 0 and the
  re-crop never ran — which is the only reason the bug above stayed hidden here.

## [0.2.13] — 2026-08-08

### Added

- **YOLO detection toolbar tool.** A split button next to the cellpose tool:
  run, pick the checkpoint, open parameters. Unlike the SAM and cellpose tools
  it takes no prompt — a detector finds objects across a field rather than being
  pointed at one — so it runs on the current view with nothing to draw first.

  The parameter dialog carries the same vocabulary as the pipeline step and the
  server tool (confidence, per-tile IoU, cross-tile merge, tile overlap,
  downsampling factor, segmentation mode, min area, outline simplification), so
  a result obtained here is reproducible in either. Switching checkpoint
  re-seeds the parameters from that model's own registry defaults, which encode
  the scale and crowding it was trained for.

- **`InstanceSegmentOptions.downsamplingFactor`** — the scale to run at, as a
  divisor of full resolution, matching the server's meaning. It matters more
  than any threshold: run a detector at the wrong object scale and it finds
  nothing. The toolbar tool honours it by re-cropping the region through
  `TileAccessPort`, since a tile-backed image still holds detail the displayed
  pixels have discarded.

## [0.2.12] — 2026-08-08

### Fixed

- **Detections without an outline are no longer discarded.** A detection with no
  mask was dropped, which silently emptied the entire result in detection mode:
  no masks means no polygons, so every object vanished and the caller saw
  nothing at all despite the model having found them. The server does not behave
  that way either — it always writes a box feature and only _adds_ segmentation
  outlines when asked. Callers now receive the box and decide what to do with it.

## [0.2.11] — 2026-08-08

### Changed

- **YOLO runs now relay the worker's own phase narration** instead of deriving a
  status from tile counts. Tile counts say nothing until the first tile
  completes, which is exactly the stretch where a first run is compiling WebGPU
  shaders — so the UI sat on one unchanging message through the longest pause of
  the run. Requires `yolo-segdetect-js@^0.1.2`, which reports the phases.

## [0.2.10] — 2026-08-08

### Added

- **`InstanceSegmentOptions.signal`** — cancellation for a YOLO run. Previously
  the contract had no way to express it, so a host holding an `AbortController`
  could not stop a run at all; the only escape was reloading the page.
  Cancellation is cooperative and lands at a tile boundary.
- **`InstanceSegmentOptions.withMasks`** — run detection without mask assembly.
  Mask assembly dominates a run's cost, so a host in detection mode should not
  pay for it. Outline tracing follows the same flag; there is nothing to trace
  without masks.
- **`InstanceSegmentProgress.onBytes`** — raw download byte counts alongside the
  0..1 fraction. A fraction cannot be converted back into bytes, so a host that
  renders a size had to invent the numbers, which showed up as "0 MB / 0 MB".

### Changed

- Requires `yolo-segdetect-js@^0.1.1`, which bounds mask assembly. Under 0.1.0 a
  detection with an out-of-range box could make a run appear to hang.

## [0.2.9] — 2026-08-08

### Added

- **Browser YOLOv8-seg instance segmentation**, backed by the new
  [`yolo-segdetect-js`](https://www.npmjs.com/package/yolo-segdetect-js) package
  (lazy-imported, so apps that never run it pay nothing in their initial bundle).

  A new port rather than an extension of `ICellSegmenter`: that contract returns
  a per-pixel label map, which suits densely packed cells but cannot represent
  what a detector produces — overlapping instances, each with its own class and
  confidence. `IInstanceSegmenter` / `INSTANCE_SEGMENTER` returns polygon rings
  in image pixels instead, ready to become `Region`s without a second conversion.

- **`YOLO_MODELS` registry**, mirroring `SAM_MODELS`: the four published
  checkpoints on public HF URLs by default, repointable at private hosting via
  `setYoloModelUrls`. Each entry carries the defaults its checkpoint was trained
  for — the embryo models want heavy tile overlap and loose merge thresholds
  because their objects are large and touch — so a host that just picks a model
  gets sane behaviour without knowing any of that.

- **`YoloSegmenterService`**, the default `IInstanceSegmenter`. Unlike
  `CellposeSegmenterService` it caches **per model id**, since there are four
  checkpoints rather than one; a failed load is evicted so the next caller
  retries instead of inheriting a rejected promise.

### Fixed

- **`YoloSegmenterService.dispose()` no longer leaks a model that is still
  loading.** It enumerated only loaded instances, so an in-flight load was
  skipped, then finished, re-populated the cache and left a live worker and ORT
  session behind — after disposal had reported success. Disposal now awaits an
  in-flight load and releases what it built, while leaving alone any newer load
  that started in the meantime.

## [0.2.8] — 2026-08-07

### Fixed

- **`minPixelRatio` is back to OpenSeadragon's default `0.5`.** The value of `1`
  introduced in 0.2.7 was based on a misreading of the option and made zoom
  **worse than stock**. From `TiledImage._getLevelsInterval` in OpenSeadragon
  6.0.2:

  ```
  highestLevel = floor( log2( currentZeroRatio / minPixelRatio ) )
  ```

  `minPixelRatio` is a floor on how small a tile pixel may shrink, and it
  _divides_ into the ratio — so **raising it selects a coarser level**, not a
  finer one. OSD's own comment on the default says as much: _"closer to 0 draws
  tiles meant for a higher zoom at this zoom"_.

  Measured live on a flat 22304×24528 image whose pyramid levels are
  697/1394/2788/5576/11152/22304, with OSD's formula predicting the selected
  level correctly in all nine trials:

  | `minPixelRatio`          | zoom 2               | zoom 8               | ≈1:1                    |
  | ------------------------ | -------------------- | -------------------- | ----------------------- |
  | `1.0` (0.2.7)            | 1.34× upscaled       | 1.34× upscaled       | 1.86× upscaled          |
  | **`0.5` (this release)** | 0.67× — no upscaling | 0.67× — no upscaling | 0.93× → full resolution |
  | `0.25`                   | 0.33×                | 0.33×                | 0.93×                   |

  `0.5` is therefore what actually delivers "never upscaled below native, full
  resolution at 1:1". `0.25` is not an improvement: it jumps two rungs finer and
  fetches roughly 4× the tiles for no visible gain, and the ingress does not
  cache tiles (verified: 815 of 815 requests reached the service), so every
  viewer pays that cost.

  The value is set explicitly rather than deleted so the intent stays greppable
  and the test can pin it. `openseadragon-viewer-options.spec.ts` now asserts
  `0.5` and was mutation-checked — raising it back to `1` fails the suite.

  What actually fixed soft zoom on flat images was **server-side**: gap-filling
  pyramid levels, which removed a 24× hole between the preview size and full
  resolution. This library setting was never the lever.

## [0.2.7] — 2026-08-07

> **Superseded by 0.2.8.** The `minPixelRatio: 1` change below is based on a
> misreading of the option — it selects _coarser_ levels, not finer — and was
> reverted. See 0.2.8.

### Changed

- **OpenSeadragon switches to a finer pyramid level as soon as the current one
  would be upscaled at all** (`minPixelRatio: 1`). OSD's default of `0.5`
  tolerates displaying a level at up to 2× magnification before fetching the
  next one, which reads as a soft image that abruptly sharpens once the
  threshold is crossed. At `1` the displayed level always has at least one tile
  pixel per screen pixel, so the only visible pixellation is past 1:1 — where
  the blocks are genuine source pixels (`imageSmoothingEnabled: false` already
  renders those crisply).

  This trades tile volume for sharpness: finer levels are requested at lower
  zooms than before. On **flat (non-pyramidal) images it is not a fix on its
  own** — their descriptors have no rungs between the preview size and full
  resolution (measured on dev, `NZ.tif` steps 931×1024 → 22304×24528, a 24×
  jump), so there is no finer level to switch to and the setting only moves the
  jump to full-resolution tiles to a lower zoom. Pair it with gap-filling
  pyramid levels server-side.

### Added

- `openseadragon-viewer-options.spec.ts` — captures the options object actually
  handed to the OSD factory and asserts the values the viewer depends on
  (`minPixelRatio: 1`, `maxZoomPixelRatio: 20`, `minZoomImageRatio: 0.01`).
  These are OpenSeadragon config keys rather than library code: OSD silently
  falls back to its own defaults if one is misspelled or renamed upstream, so
  they were previously invisible to both the test suite and grep.
- This `CHANGELOG.md`.

### Fixed

- Example (dev server only): the library's web workers load again, so SAM
  segmentation and the region editor's mask export no longer fail with "SAM
  worker crashed". The library starts its workers with
  `new Worker(new URL('./x.worker', import.meta.url))`; Vite's dependency
  pre-bundling copies that URL into the optimized chunk **without** emitting the
  worker body, so the request resolved to `node_modules/.vite/deps/x.worker`
  where nothing exists, the dev server answered with `index.html`, and the
  browser rejected the script for its `text/html` MIME type. A small
  `apply: 'serve'` plugin now rewrites those requests to the real worker bundles
  `npm run bundle-workers` emits beside the FESM. The library itself is
  unchanged and production builds never needed this — rollup resolves
  `./x.worker` and emits proper worker chunks.

## [0.2.6] — 2026-08-05

### Fixed

- A newly selected image is no longer silently discarded while another is still
  rendering — a newer image now **preempts** the in-flight render instead of
  being dropped ([#5](https://github.com/TheJacksonLaboratory/sci-image-visualizer/issues/5)).
- Added `renderToken`, a monotonic render generation. All `RenderOrchestrator`
  callbacks bail when their token is stale, so a superseded render can no longer
  paint, clear `running`, release the newer render's overlay (the indefinite
  loading-overlay hang), or apply its ROIs.
- `renderPhase` bails before loading starts, and the render being replaced calls
  `plotService.cancelLoading?.()` so the napari backend stops streaming frames.

## [0.2.5] — 2026-07-30

### Fixed

- Display changes (channels, colormaps, window/level) no longer destroy
  OpenSeadragon tile caches mid-drag.
- The library renders its own toast outlets instead of depending on the host
  providing them.

### Added

- Example: multichannel and z-stack images served from the tile server.

### Changed

- CI moved to Node 24 and current GitHub Action majors.

## [0.2.4] — 2026-07-27

### Changed

- `cellpose-js` is a regular dependency rather than a peer dependency.

## [0.2.3] — 2026-07-27

### Changed

- Widened the `cellpose-js` peer range to `^0.4.1`.

### Added

- Example: server-side tile + region-zoom path for gigapixel images, the Sirius
  Red gigapixel slide in the tiled gallery, and a dev GKE deployment wired to
  the live demo.

### Fixed

- Example: heatmap preview for tiled images; cellpose worker loading under Vite
  dev.

## [0.2.2] — 2026-07-25

### Added

- 3D: multichannel **Surface** follows the pane-selected channel.

## [0.2.1] — 2026-07-24

### Added

- 3D: serverless multichannel **Volume** / **Isosurface**, and **Surface** for
  any image.

### Fixed

- Example: multichannel images stay scalar-gradable so 3D modes remain
  available.

## [0.2.0] — 2026-07-23

### Added

- Serverless multichannel compositing in the OpenSeadragon view, with
  per-channel intensity histograms.
- Client-side intensity histogram for the simple (`tiled: false`) path.
- npm publish provenance.

## [0.1.0] — 2026-07-23

### Added

- Initial public release: OpenSeadragon tiled image view, Plotly plots and 3D,
  napari-js WebGPU renderings, regions & annotation, channels/colormaps, and
  browser-side SAM and cellpose segmentation.

[Unreleased]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.19...v0.3.0
[0.2.19]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.18...v0.2.19
[0.2.18]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/releases/tag/v0.1.0
