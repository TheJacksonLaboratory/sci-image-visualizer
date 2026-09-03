# Changelog

All notable changes to `@jax-data-science/sci-image-visualizer`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries before 0.2.7 were reconstructed from the git history at the time this
file was added.

## [Unreleased]

### Added

- **The 3D scene's three layers can be shown and hidden independently.** The
  reference volume, the observation cloud and the cluster density volumes occupy
  the same space, so any two of them hide each other — and 374k points drawn as a
  stack of discs hide the density volumes almost completely, which is the one thing
  the volumes exist to show. A **Show** group in the `Spatial omics 3D` panel now
  carries `Reference volume` and `Observations` alongside the existing
  `Cluster density volumes`, so every combination is reachable: the estimated
  fields alone, the fields with the anatomy behind them, the anatomy on its own.

  Visibility, not construction — the layers stay built, so a toggle is immediate
  and never re-fetches a 100 MB template or re-runs a rasterisation. (The density
  checkbox remains the exception: building six volumes is not free, so it still
  gates the work.) Neither toggle re-frames the orbit camera.

- **`One section at a time`** restricts the cloud to a single imaged section, with
  a slider over the sections the dataset actually has (53 for the ABC 1-in-10
  atlas). This is the view that answers whether the estimated field follows the
  cells that were measured: one measured plane, drawn over the estimate, with the
  volumes still readable between the sections. A selection highlight is restricted
  to the same section, so it cannot float where its own cells are not drawn.

  Sections come from the distinct z of the observations — every cell on a slide
  shares that slide's registered z exactly, so no section-label column and no
  binning is needed. A dataset whose z is continuous rather than sectioned is
  reported as having no sections and is offered no section control, rather than
  having one invented for it. `ISpatialControls.sampledSections()` exposes the
  list; the scan is memoized, so the renderer and the panel share one pass.

- **Gene map — a gene's expression drawn as a field under the cells.** A scatter
  coloured by a gene answers "which cells express it"; the eye cannot integrate
  thousands of small dots into a territory, so it does not answer "where is it
  expressed". Ticking **Gene map** in the `Spatial omics` panel estimates that
  gene's expression between the cells and draws it as an image layer beneath
  them, so the region reads at a glance while the individual cells stay visible
  on top.

  The quantity is the kernel-weighted **mean per cell, not a sum**:
  `mean(p) = Σᵢ w(p, xᵢ)·eᵢ / Σᵢ w(p, xᵢ)`. A sum conflates "many cells here"
  with "high expression here" — a dense region would glow whatever its cells were
  doing, which is the easiest way to misread a heat layer. Smoothing the numerator
  and the denominator together (Nadaraya–Watson) spreads *where*, not *how much*.

  The denominator is also what makes emptiness expressible. Where no cell was
  measured the mean is undefined rather than zero, so the layer is **fully
  transparent** there instead of painting the colormap's low end over unmeasured
  tissue; alpha then ramps with local support up to the field's own median, so a
  pixel backed by one distant cell reads as tentative and a properly sampled one
  reads as solid. A cell with no measurement for the gene (`NaN`) is skipped, not
  counted as absent.

  **Smoothing** sets the kernel σ and **Map opacity** the layer's own opacity,
  separate from the cells' — turn the cells down to read the field under them. The
  contrast window and the log scale are shared with the point colouring, so the
  field and the cells over it always agree. On a volume-backed dataset the field
  is re-estimated per plane from that plane's cells. When the display colormap is
  a grey ramp the field falls back to Viridis, because the tissue underneath it is
  already grey.

### Changed

- **The gene picker is a searchable dropdown, not a free-text typeahead.** The old
  control was an empty box: you had to already know a gene name to type one, and
  nothing told you what the dataset carried. It is now a filterable `p-dropdown` —
  the names are listed before anything is typed, and each keystroke narrows the
  visible list (case-insensitive substring, so `17a7` finds `Slc17a7`).

  Both dataset shapes keep the same control. A targeted panel inlines its names, so
  the dropdown filters them locally with no round-trip; a whole-transcriptome
  dataset does not ship its ~31k names, so there the query goes to
  `searchFeatures` per keystroke and the answer becomes the option list. The empty
  message says which case you are in ("Type to search genes" vs "No genes"), and a
  remote lookup that fails says so without latching — the next keystroke clears it.

- **The example ABC source inlines its gene names.** It served `features.count`
  without `names`, alone among the sources (the ST source inlines below 2,000, the
  Zarr source always does), which made the new dropdown open empty for a dataset
  carrying all of 8 genes. Same 2,000-name limit as the ST source, so
  whole-transcriptome data still stays out of the manifest.



## [0.4.0] — 2026-09-02

The spatial-omics release. Two new plot modes:

- **`Spatial omics`** — one marker per observation over the tissue image, coloured
  by an annotation column or a gene, with ROI-linked distribution charts. For a
  dataset whose 3D data is a registered volume, it draws the displayed plane's
  anatomy with that plane's observations over it, and the toolbar's slice slider
  scrubs depth.
- **`Spatial omics 3D`** — the same observations as a point cloud under an orbit
  camera, inside the dataset's reference volume, with screen-space region
  selection and optional per-cluster **density volumes**.

Both sit on a new spatial data plane (`SPATIAL_DATA_PORT`, `SpatialDataset`) that
holds observations resident while column, feature and polygon values arrive one at
a time. Volume and Isosurface now read the image stack and nothing else, and
`IImageMetadata` gains **`mppZ`** so any stack that knows its slice spacing
renders with true physical anisotropy.

### Added

- **A categorical colour source now charts, as counts per category.** The
  distribution section charts whatever the map is coloured by, and a categorical
  column used to get a notice instead of a chart — which for the ABC atlas is
  every column anyone reaches for first (`class`, `subclass`, `neurotransmitter`,
  `parcellation_division`, `brain_section_label`; the dataset serves exactly one
  continuous column). A histogram of a category *code* would be meaningless, since
  the codes are labels and not magnitudes — but "how many cells per class" is a
  real question, and the one the legend implies without answering.

  Horizontal bars, because taxonomy labels are long; sorted by count, because rank
  is what the chart is read for; in the map's own category colours, so the chart
  and the render cannot disagree. Ties keep category order, so bars do not
  reshuffle between two datasets that happen to tie. Past 25 categories the tail
  folds into one `other (N categories)` bar rather than being dropped — 338
  subclasses do not fit a readable axis, but showing 25 of them silently would
  misstate the whole. With a selection the bars show it against the total,
  overlaid. The kind selector follows the subject: Counts for a categorical one,
  Histogram / Violin / Box for a continuous one.

### Fixed

- **Expanding `Distribution` scrolls the chart into view.** The panel is taller
  than the viewport once that section is open and the chart is its last row, so
  expanding it drew a chart a few hundred pixels below the fold — the section read
  as empty, on a panel that does scroll but says nothing about it.

- **`subclass` (338 categories) is served by the example ABC source**, for the
  density volumes. Cardinality decides which VIEWS a column can drive, not whether
  it is worth serving, and the two had been conflated: the ceiling is a property of
  the 3D points layer alone (a 256-entry LUT, measured to hold 96 categories
  exactly), while the 2D markers carry per-point RGBA and a density volume is a
  scalar field per cluster. Neither cares how many categories exist.

  Subclass is the level most analysis is read at, so serving it makes the density
  volumes answer a question worth asking. `supertype` (1,201) and `cluster` (5,274)
  stay out on a different ground: no legend a human reads keeps that many apart.

  The panel now says out loud when the active colouring is past what the cloud can
  colour — how many categories, what the limit is, that the points are drawing
  flat, and which views do render it. A console warning is not something anyone
  sees. `SPATIAL_3D_MAX_CATEGORIES` moved to `spatial-encoding.ts` so the renderer
  that enforces the limit and the panel that explains it cannot drift apart.

  With many clusters the additive opacity budget is split (`0.9 / n`, so n fully
  overlapping peaks stay inside the display range) rather than fixed per layer.
  That only mitigates: a translucent raymarch integrates along the ray, and the six
  LARGEST subclasses are non-neuronal types present throughout the brain, so they
  overlap almost everywhere. At subclass level the readable view is one cluster at a
  time — click a legend row, or select a region — which resolves individual nuclei
  and layers cleanly. The multi-cluster view separates best at `class`.

- **Cluster density volumes in the 3D spatial view** — a checkbox that raymarches
  each cluster as a smooth density field alongside the point cloud, tinted with
  its legend colour and blended additively, so overlapping territories both read
  instead of the nearer one hiding the other.

  This is what makes a serially sectioned dataset legible as an anatomical
  distribution. The cloud shows measured cells and nothing else, but at 200 µm
  section spacing the eye cannot integrate a stack of discs into a shape and every
  gap reads as absence. A density field is a different object from a cell: an
  estimate, defined between the imaged planes, drawn as a translucent cloud so it
  cannot be taken for measurement — and the panel says so in as many words, with
  the tip that lowering Opacity is what lets you see the fields under the cloud.

  Individual cells are **never** interpolated, and that is deliberate. Consecutive
  sections sample entirely different cells, so there is no correspondence to
  interpolate along; synthesising positions would fabricate observations
  indistinguishable from measured ones, which single-cell resolution asserts have a
  measured transcriptome.

  Two properties are what separate an honest estimate from a smear, and both are in
  `spatial-density.ts`:

  - the kernel is **anisotropic** — the default σ is 1.5 grid voxels per axis, and
    the grid's z voxel *is* the section spacing, so σ along z clears one section gap
    while staying tight in plane. An isotropic kernel leaves one disc per section:
    a sampling artefact that looks like biology;
  - the field is **coverage-normalised** along z (Nadaraya–Watson over the sampled
    planes), or the 23 unimaged planes of the ABC atlas would read as genuinely
    empty tissue rather than tissue nobody looked at. Amplification is capped at
    2x, so the correction bridges interior gaps without inflating a trace of
    smoothing leakage past the edge of the sampled range into a signal. Coverage
    comes from the whole dataset, never the subset being drawn — a rare cluster is
    sparse because it is rare.

  Estimated on the reference volume's own grid, coarsened 2x (density is smooth by
  construction, and an eighth of the voxels is an eighth of the work) with the
  physical extent preserved exactly, so the fields sit inside the anatomy rather
  than overhanging it. Without a reference volume the grid comes from the
  observations, anchored at the coordinate origin so the same half-box offset
  centres it. Measured cost on the ABC 1-in-10 subsample (373,997 cells,
  138 x 138 x 38 grid): ~56 ms per field, ~290 ms for six — main-thread work, and no
  worker needed at this size.

  Follows the **selection** when there is one, so "draw a region, tick the box"
  answers which clusters live there. Capped at the 6 largest clusters by cell
  count: past a handful, additive translucent clouds stop being separable by eye.
  With no categorical colouring it draws one total-density field, which is a real
  question on its own. Because a field is scalar, this also sidesteps the
  96-category LUT ceiling that keeps `subclass` (338), `supertype` (1201) and
  `cluster` (5274) off the 3D points.

- **The 2D `Spatial omics` view slices a 3D dataset.** Over a dataset whose image
  is its registered volume, the view draws the displayed plane's anatomy with
  *that plane's* observations over it, and the toolbar carries the Image view's
  live slice **slider** — scrub, and the cells move with the section. Previously
  the whole depth of the specimen piled onto whatever section was showing.

  A plane is one voxel-slab thick (`voxelSize[2]`), which is the sampling the
  volume itself has — for serial sections registered into a common frame, one
  slab is one section. Coordinates reach the slice's pixel grid through the
  affine the volume implies (`volumeImageRef`: divide out the voxel size, near
  corner at the origin), shaped as a `SpatialImageRef` so the markers and the ROI
  selection take the same transform they take for a dataset with a real
  `imageRef`. Marker diameters have a **floor of 1.5 slice pixels**: the ABC
  atlas serves 5 µm cell radii on a 40 µm/px template, so drawn strictly to scale
  every cell would be a fifth of a pixel and the section would come up empty. The
  point-size control scales up from there.

  A region drawn in this view selects **that plane's** observations, not the
  column of specimen behind them (`selectInRegions` takes the candidate indices).
  The 3D cloud's screen-space lasso still cuts through the full depth, which is
  the honest reading of a shape drawn against an orbit camera.

- **A 3D omics dataset opens as its own image, sliceable.** A dataset with a
  registered volume and no `imageRef` now publishes that volume AS the image —
  one PNG per z plane — and opens the 2D Image view on it, with the toolbar's
  slice bar scrubbing depth. The volume is a 3D image delivered in one file, so
  this is what such a dataset actually has to show, and everything image-shaped
  (contrast window, colormaps, region tools, the physical scale bar) works
  because the volume genuinely *is* the image. The 3D cloud stays one menu pick
  away.

  Fixes a real symptom: with nothing published for such a dataset, the Image view
  kept whatever slide was loaded before — open the synthetic Visium demo, then
  the ABC atlas, and the Image mode showed the synthetic tissue under a
  whole-brain cloud's controls.

  It opens **mid-volume** (`depth >> 1`), not on slice 0: the end planes of an
  anatomical volume are outside the specimen, and an empty first frame reads as a
  failed load. `mppX`/`mppY` come from `voxelSize` x `micronsPerUnit`, and stay
  null when `micronsPerUnit` is absent — the unit is then unknown, and a scale
  bar drawn from a guess would read as a measurement. Keyed by dataset +
  geometry, so a re-emitted dataset (a colour-column change does that) neither
  refetches megabytes of voxels nor resets the user's scrub position. A volume
  whose byte count contradicts its declared geometry is refused rather than
  sliced into plausible-looking anatomy from the wrong depth.

- **`Spatial omics 3D` plot mode** — spatial-omics observations as a 3D point
  cloud under the orbit camera, alongside the existing 2D `Spatial omics` mode.
  For assays whose observations carry a z: serial sections registered into a
  common frame, or a genuinely volumetric assay. Gated by `requiresSpatial3d`, a
  strictly narrower gate than `requiresSpatialData` — most spatial assays are a
  single plane and have no z to render, so the mode stays hidden for them.

  A dataset with no `imageRef` and no volume selects this mode automatically:
  it has nothing to draw observations *over* — a cloud registered into an
  anatomical frame has coordinates but no one section — so leaving the host on
  an Image view would show an empty canvas. One that *does* carry a volume opens
  on the Image view over that volume's slices instead (below).

  Two constraints come from the 3D points layer having no per-point colour
  channel, only a per-point scalar mapped through a 256-entry LUT:

  - **Categorical colouring is exact up to 96 categories.** A palette is encoded
    as one contiguous block of LUT entries per category. Measured against
    napari-js, every K from 2..96 round-trips its colours exactly and K=97 is
    the first that does not. Above the ceiling the renderer draws flat and warns,
    rather than drawing colours that are subtly wrong next to a confident legend.
  - **A selection cannot be an alpha ramp.** The layer has one opacity for all
    points, so the selected subset becomes its own layer at full opacity while
    the parent cloud drops to the muted level — reading the way the 2D
    highlight-vs-mute does. Point size is in *screen* pixels here, not data
    units, which is the layer's unit.

- **A reference volume under the 3D cloud.** `SpatialDataset.volume` +
  `SpatialDataPort.getVolume()` describe a 3D scalar field registered to the
  observation coordinates — an atlas template, or an image z-stack — which the
  3D mode draws as a translucent `VolumeLayer` beneath the points. Without it a
  cloud floats in empty space and "where in the brain is this cluster" has no
  answer.

  napari-js centres a volume's box on the world origin and `VolumeLayer` has no
  translate, so the contract puts the volume's near corner at the coordinate
  origin and the renderer offsets the *points* by half the box. Both the cloud
  and the selected-subset layer take that offset; a volume that fails to load
  costs the backdrop, not the data.

- **Observations survived the image they were drawn over.** napari's image view
  CLEARS the whole layer list on every render, so each slice re-render took the
  marker layer with it — a scrubbed plane came up with no observations on it at
  all. The markers are now rebuilt *after* the render rather than before it (drawn
  first, they were wiped by the very image meant to sit under them), and a cached
  layer handle that is no longer in the scene is treated as absent instead of
  mutated in place, which also covers a re-render from a contrast or colormap
  change. The unit stub now tracks its layer list for real, since whether a layer
  is still mounted is exactly what these tests have to see.

- **Volume and Isosurface read the image stack, and only the image stack.** They
  had grown a second voxel source — the spatial dataset's registered volume,
  fetched through `SPATIAL_DATA_PORT` and preferred over the loaded image. That is
  gone: a 3D omics dataset reaches these modes because its volume is *published as*
  a grayscale z-stack image, so there is one voxel path, and the plot-type gates go
  back to being about the loaded image and nothing else.

  What the removed path did carry was the volume's real voxel size, and losing that
  would render 40 x 40 x 200 µm anatomy as a cube-aspect brick. So `IImageMetadata`
  gains **`mppZ`** — the spacing between slices, the z counterpart of `mppX`/`mppY`
  — and a stack declaring all three gets its true physical extent as the world box.
  A stack without it (a WSI z-series, which has no slice spacing to report) keeps
  the resolution-invariant reference box, which is shape-only. Any z-stack that
  knows its spacing benefits, not just a spatial volume.

  The axis labels are measured from the image's own extent rather than from the
  world box, which is what they always meant: reading a pixel count off a box that
  is already in µm and multiplying by mpp scaled it twice, so 11 mm of mouse brain
  was labelled `44.0 cm`. Z is physical too when `mppZ` is known (`Z · 1.5 cm`
  instead of `Z · 76 px`), and still reads in slices when it is not — an unstated
  thickness must not become a measurement.

- **Region tools in the 3D cloud's toolbar.** They were hidden, because the
  toolbar gates them on `isHeatmap`, which means "2D view" and is false for any
  3D descriptor — so the screen-space overlay was installed with no way to arm
  it. Gated on a separate `is3dRegions` input instead, leaving `isHeatmap` to go
  on driving the zoom tools and the 3D camera controls. The brush and the open
  polyline stay hidden there: the brush paints in image pixels and there is no
  raster to sample, and an open polyline is a profile tool, not a closed region a
  selection can test against.

- **Scale bar in the 3D cloud**, measured at the orbit pivot — a perspective
  camera has no single scale, so a bar can only be true at one depth, and the
  pivot is what the camera is framing. Needs `SpatialDataset.micronsPerUnit`,
  new: the 2D path reads `imageRef.mppX` because its coordinates are image
  pixels, but a cloud has no image and must state its own unit. Absent means
  unknown, and then no bar is drawn — one labelled in microns over pixel-space
  coordinates would read as a measurement.

- **Region selection in 3D.** The existing ROI tools — rectangle, polygon,
  freehand — work on the cloud, by handing `NapariRegionOverlay` a screen-space
  viewer whose transforms are identity. The drawn shape is a lasso in canvas
  pixels, so every tool works with no 3D-specific drawing code. Selection then
  projects each observation through the camera's view-projection and tests it in
  that same screen space (`selectInRegionsProjected`).

  A screen-space lasso cuts through the cloud's **full depth**, not a slab at a
  chosen z — inherent to drawing on a flat screen, and what every orbit-camera
  point picker does. The panel says so. An orbit clears the drawn outline, since
  a screen-space shape stops meaning anything once the camera moves; the
  selection it produced is kept, and stays highlighted from every angle.

- **Allen Brain Cell Atlas source in the example server** (`lib/spatial-abc.mjs`,
  `lib/nifti.mjs`, `npm run fetch-abc`) — the whole-mouse-brain MERFISH map,
  3,739,961 cells from 53 coronal sections registered into a common frame, plus
  the CCF average template as the anatomical backdrop. Plain CSV and NIfTI from a
  public AWS Open Data bucket, transcoded once into a binary cache (~20 s).
  Served with Allen's own deposited category colours, so the render matches the
  atlas figures.

  Serves the **reconstructed** coordinate frame, not the CCF one, because that is
  the frame the reference volumes are on. Established by scoring candidate
  alignments against each cell's own `parcellation_index`: reconstructed with
  axes as-is agrees for 9000 of 9000 sampled cells, while the best of the CCF
  frame's 48 permutation/flip combinations manages 126. Bounding-box alignment
  would not have done — the cloud's extent and the template's differ by 5–14% per
  axis. See the example server's README for what it does not serve: categoricals
  above the LUT ceiling, and the 492 genes that ship only as h5ad.

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

- The browser example groups its discovered spatial-omics datasets into a
  **`spatial-omics` folder**, alongside the bundled micro-CT series: with 41
  datasets the root gallery was unreadable flat. Folders **nest** one level, so a
  source with several sections gets its own — the HER2 deposition's 36 sections
  would otherwise bury the two Visium and two Visium HD datasets beside them.
  Grouping is by dataset-id prefix (`her2.A1` → `her2`), and a source with only a
  couple stays a direct tile rather than costing a click for nothing.

  `Folder` holds an image series, a set of spatial datasets, or sub-folders, and
  navigation became a breadcrumb path since "up one level" and "back to the root"
  are now different actions.

  `folders` is assigned once when discovery completes rather than derived in a
  getter: a getter returned a new `Folder` object every change-detection pass,
  and because `*ngFor` tracks by identity that folder's button was destroyed and
  recreated between mousedown and click — so clicking it did nothing, while the
  micro-CT tile kept working precisely because its object was stable.

- **Legacy Spatial Transcriptomics datasets are served live too**
  (`lib/spatial-st.mjs`), from `$ST_DIR` (default `./st`). Pre-Visium ST is a
  different shape from a SpatialData store — gzipped TSV count matrices, separate
  HE JPEGs, and spot-selection tables joining array coordinates to image pixels,
  with no Zarr, no AnnData and no coordinate transformations — so it is a third
  source alongside Zarr stores and pre-built bundles rather than a branch inside
  one.

  Verified against the Andersson et al. HER2+ breast cancer deposition
  ([Zenodo 4751624](https://zenodo.org/records/4751624)): **36 sections**, 8 of
  them carrying the **pathologist's annotation** (`invasive cancer`,
  `cancer in situ`, `connective tissue`, `adipose tissue`, `immune infiltrate`,
  `undetermined`) — the richest categorical any of the demo datasets has, and a
  real one rather than derived. Rendering section A1's spots over its HE image
  shows the annotation tracking the histology and `ERBB2` high across the tumour,
  low in the fat.

  Two supporting pieces:
  - `lib/zip-aes.mjs` — a dependency-free ZIP reader **including WinZip-AES**
    (method 99). These archives are AES-encrypted with the password published in
    the authors' README; macOS's `unzip` refuses them ("need PK compat. v5.1")
    and 7-Zip is not always installed, but Node already has PBKDF2-HMAC-SHA1,
    AES and HMAC. It reads by byte range, so pulling one JPEG out of the 592 MB
    `images.zip` does not load the archive.
  - Passwords live in a per-bundle `config.json` sidecar, not in source: they are
    the depositor's to publish, not ours to embed.

  A section's cheap index (spot keys, pixel positions, gene names) is read per
  request in ~25 ms; the count matrix is parsed on the first gene or derived
  column and kept **gene-major** (~21 MB per section), which is affordable here
  in a way it is not for 84k cells.

- **The example server now reads SpatialData Zarr stores LIVE** (`lib/spatial-zarr.mjs`).
  Drop or symlink a `*.zarr` store into `$ZARR_DIR` (default `./stores`) and every
  `(store, table, region)` triple appears on `/spatial/datasets` — no build step,
  no intermediate bundle. The offline converter script is removed; `$SPATIAL_DIR`
  bundles still work and win on an id clash, so a deliberately-converted dataset
  can override a live one.

  Zero-config discovery surfaces more than a converter run did: the Visium store
  yields **both** of its sections, and the Visium HD store both its cell and
  nucleus segmentations (84,031 and 83,153 observations).

  The tissue image is materialised into `$COG_DIR` on first request (0.1–0.8 s),
  so OSD's tile path is unchanged and only the dataset you open pays. Derived
  columns are advertised in the manifest and computed on first request, so
  opening a dataset does not pay to cluster it. An optional
  `stores/<name>.json` sidecar carries only what the store cannot state —
  `gridUm`, the assay's bin pitch in µm, without which a segmentation has no
  µm/px and no scale bar.

  **What it costs, measured:** the matrix is CSR over observations, so a gene's
  column is scattered across every row. The first gene request reads X (0.4–0.5 s)
  and keeps it resident (227 MB Visium / 331 MB HD); later genes are 13–40 ms.
  It is deliberately not transposed to gene-major in memory — that would double
  residency for tens of milliseconds saved. A production server should serve a
  pre-transposed file, which is the same argument for keeping ingest out of the
  browser.

  `SpatialDataHttpService` gains `readManifest(id)`, so a host can inspect what a
  server offers while building a picker instead of loading each dataset to find
  out. The browser example now discovers its spatial gallery entries this way
  rather than hardcoding them.

- **Fixed: the example gallery skipped datasets with no tissue image.** It
  required an `imageRef` to list a dataset at all, which excluded every dataset
  that has no single reference plane.

- **Fixed: the point-size and opacity sliders rendered as bare handles** — small
  circles that read as radio buttons. PrimeNG puts `styleClass` on its *inner*
  `.p-slider` div, so styling that left the `<p-slider>` HOST element at its
  default `display: inline`, where it ignores flex sizing and collapses; only the
  round handle was left to see. The hosts are now sized by element selector and
  the track stretched to fill them, which is what `channel-histogram.component.scss`
  already does — and says so in a comment I should have followed. Same fix for the
  distribution panel's group dropdown.

- **Fixed: the Opacity control did nothing in the spatial mode's default state.**
  With no colour source and no selection the flat marker colour was a constant
  RGBA tuple, so `view.opacity` was dropped — and that is the state the mode
  opens in, before a column or gene is picked. It now falls back to a broadcast
  tuple only when the colour genuinely is uniform (opacity 1, no selection) and
  goes per-point otherwise, so a flat 84k-observation view still does not
  allocate 84k tuples.

- **Display-only changes now update the marker layer in place.** Point size,
  colour, opacity and selection previously dropped and re-added the layer, which
  rebuilt every position to change one number — 84k of them on the Visium HD
  dataset. They now assign `size`/`faceColor` on the existing layer, whose
  setters bump napari-js's `dataVersion` and trigger the redraw; the layer is
  only rebuilt when the dataset itself changes.

- **Linked distribution charts** — `<spatial-charts>` (`SpatialChartsComponent`):
  **histogram**, **violin** and **box** over the values the map is coloured by,
  embedded in the `<spatial-controls>` panel below the colour controls rather
  than owning a dialog of its own, in a **collapsible** section (collapsed by
  default — the panel's primary job is the colour controls, and the chart roughly
  doubles its height; the collapsed header names what it would chart). The two are one workflow — change the colour
  source, watch the distribution move — and splitting them across two floating
  windows made that link harder to see, not easier. It remains a separate
  component, so the pure trace builders and its own tests keep their boundary,
  and takes an `active` input because the enclosing dialog creates and destroys
  its content.

  The chart's subject is the map's colour source rather than an independent
  picker, so the two cannot disagree about what is being shown. It follows the
  selection: the histogram overlays *Selected* on the full distribution (that
  comparison is the point of linking them), while violin and box narrow to it —
  a violin per category per selection state is unreadable. Violin and box split
  by any categorical column, in the same colours the map uses.

  `implementations/plotly/omics-trace-builders.ts` holds the trace building as
  pure functions, deliberately separate from `plotly-trace-builders.ts`: that
  module's `TraceBuildInput` is image-matrix shaped (`frames`, `ratios`,
  `trueImageSize`) and cannot express "one value per observation". It drops
  non-finite values, clamps negatives before `log1p`, skips `NO_CATEGORY` rather
  than misbucketing it, omits empty categories (an empty violin reads as data),
  and thins samples past 20k points — Plotly renders every point of a violin, and
  84k cells per category is seconds of layout.

  **Violin needed no bundling work**: `plotly.js-dist-min` is the full
  distribution and already carries `violin` and `box`. `ISpatialControls` gains
  `continuousValues`, `categoricalView` and `categoricalColumns`.

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
  - **Derived `cluster` column** (`--cluster K`, default 8) — k-means on
    log1p-normalised expression, because the sandbox stores are raw: their only
    categorical is `in_tissue`, which is constant once out-of-tissue rows are
    filtered, so there was nothing to put in a legend, split a violin by, or
    select a category of.

    Normalising each observation to a common total before `log1p` is what makes
    this anatomy rather than an artefact — without it the clusters follow
    sequencing depth and come out as concentric count bands. Verified on both
    datasets: the Visium HD run resolves cortex, a layer tracing the cortical
    surface and hippocampal pyramidal layer, a white-matter band and the
    thalamus. Fits centroids on an even subsample (84k cells x k x dims is
    minutes in plain JS otherwise), uses the 50 most variable genes, seeds with
    k-means++ from a fixed seed so rebuilds are identical, and relabels
    largest-first for stable legends. 84k cells cluster in 0.6 s.

    It is a **demo-data convenience, not an analysis tool**: the column carries a
    `description` saying so, and `<spatial-controls>` now surfaces column
    descriptions so a derived column cannot read as measured data.
  - Columns that carry no encoding are dropped: identifiers (a distinct integer
    per observation, e.g. `spot_id`) and columns constant after filtering
    (`in_tissue`).
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

[Unreleased]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/TheJacksonLaboratory/sci-image-visualizer/compare/v0.3.3...v0.4.0
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
