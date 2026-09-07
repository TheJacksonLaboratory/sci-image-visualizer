# Research: Spatial-omics plot mode for sci-image-visualizer

> Question: What must a new "spatial omics" plot mode do, and what does the current
> library / napari-js / Plotly already give us for free?
> Date: 2026-09-01
> Confidence: high on codebase + library-capability findings (read directly from source
> and shipped `.d.ts`); medium on the reference-tool details (docs summaries).

## Findings

### 1. Plotly's full bundle is already loaded — violin and box need no bundling work
**What:** `package.json` depends on `plotly.js-dist-min@^3.0.1`. Scanning the shipped
`plotly.min.js` (4.6 MB) for trace-type strings: `violin` ✅, `box` ✅, `histogram2dcontour` ✅,
`scattergl` ✅, `scatter3d` ✅, `image` ✅ (`heatmapgl` ✗, `pointcloud` ✗ — both removed upstream).
**Source:** `node_modules/plotly.js-dist-min/plotly.min.js`, `package.json:52`
**Confidence:** high (verified locally, not inferred)
**Action:** The gap is **not** the violin trace — it's that the library has no tabular-data
charting surface at all. Every Plotly path today is driven by `TraceBuildInput`
(`src/lib/implementations/plotly/plotly-trace-builders.ts:29-49`), which is image-matrix-shaped
(`frames`, `width`, `height`, `ratios`, `trueImageSize`). Violin/box/histogram of a per-cell
column needs a second, table-shaped builder input — not a bundle change.

### 2. The library has no data channel for tabular / point data
**What:** Data enters exclusively as `IImageInfo` — URLs, `imageMeta`, `tiled`, `isStack`
(`src/lib/contracts/image.contract.ts:44-81`). `PlotDataSource` is `'image' | 'regions'`
(`src/lib/contracts/plot-type.ts:46`) and is **declarative only** — grep shows zero consumers
outside its own declaration, so extending it is free. Ports exist for tiles, image state,
region I/O and preferences (`src/lib/contracts/ports/`), but none for observations/features.
**Source:** `src/lib/contracts/image.contract.ts`, `src/lib/contracts/plot-type.ts`,
`src/lib/contracts/ports/`
**Confidence:** high
**Action:** A new `SpatialDataset` contract + `SPATIAL_DATA_PORT` is the load-bearing piece of
this feature. Everything else hangs off it.

### 3. napari-js 0.11.1 has 2D points but three real gaps for spatial omics
**What:** Shipped layer types are `ImageLayer`, `PointsLayer`, `Points3DLayer`, `LabelsLayer`,
`VolumeLayer`, `SurfaceLayer`, `AxesLayer` (`node_modules/napari-js/dist/index.d.ts`).
- `PointsLayer` supports **per-point** `size`, `faceColor`, `borderColor` (RGBA arrays), plus
  `disc|ring|square` symbols — everything a 2D cell/spot scatter needs. Size is in **data units**.
- `Points3DLayer` supports per-point *scalar values* + a colormap, but **no per-point color** and
  only a **uniform** `size` (in screen pixels). Categorical cell-type coloring in 3D is not
  expressible today.
- There is **no shapes/polygon layer** — cell segmentation boundaries have no GPU path.
- Picking is `nearestPointIndex(positions, sizeAt, x, y)` — a CPU single-point hit test, 2D only
  (`node_modules/napari-js/dist/picking/pick.d.ts`). No rectangle/lasso → index-set selection.
**Source:** `node_modules/napari-js/dist/{index.d.ts,layers/*.d.ts,picking/pick.d.ts,viewer.d.ts}`
**Confidence:** high (read from the shipped type declarations)
**Action:** Three concrete napari-js asks: per-point color + size on `Points3DLayer`, a shapes
layer, and a lasso/rect selection returning indices.

### 4. Interactive ROI drawing on napari-js already exists — bulk polygon rendering does not
**What:** `napari-region-overlay.ts` (886 lines) implements draw rect/polygon/freehand, select,
move/resize, vertex + Bézier editing, donut holes, classification labels and rubber-band
multi-select — as an **SVG overlay** on top of the WebGPU canvas
(`src/lib/implementations/napari-js/IMPLEMENTATION-STATUS.md`).
**Source:** `src/lib/implementations/napari-js/napari-region-overlay.ts`, `IMPLEMENTATION-STATUS.md`
**Confidence:** high
**Action:** For Visium (≈3k spots) and hand-drawn ROIs, the existing overlay is enough — spatial
ROI selection is mostly *already built*. It is a DOM overlay, so it will not scale to 10⁴–10⁵
cell-boundary polygons; that is the case for a GPU shapes layer.

### 5. CosMx guidance: the encodings that matter are alpha, subsampling and faceting
**What:** The NanoString scratch-space post prescribes: grey low-alpha points for the tissue
overview; categorical cell type via a consistent palette, collapsing to 5–10 major types when
there are many; continuous expression via viridis/magma on a **log** scale with percentile-capped
outliers; highlight-vs-mute (bold border + full opacity for the cells of interest, muted
neighbours); **subsample background cells to ~5% while showing 100% of the highlighted type**;
rasterize dense point clouds; faceted gallery with one cell type per panel over a shared
background; zoom/crop to a single FOV with a 2× buffer so polygons are not clipped; scale bar
auto-sized to ~1/4 of the x-axis.
**Source:** https://nanostring-biostats.github.io/CosMx-Analysis-Scratch-Space/posts/spatial-plotting/
**Confidence:** medium (page summary)
**Action:** Treat alpha/mute, background subsampling, log+percentile-capped continuous scaling and
per-category faceting as first-class controls, not polish. The library already has colormap LUTs,
a contrast/gamma window and a physical scale bar to build on.

### 6. Spatial-Live's model: four variable types → four layer types, driven by column prefixes
**What:** Spatial-Live maps a variable type to a deck.gl layer:
`char:` categorical → **ScatterplotLayer** (colored dots); `num:` numerical → **ColumnLayer**
(extruded cylinder, height ∝ value); `gene:` → **HeatBitmapLayer** (Gaussian estimation fills
spatial gaps); GeoJSON → **GeoJsonLayer**. Input is a PNG image defining the pixel coordinate
space, plus a CSV with mandatory `id:spot`, `pos:pixel_x`, `pos:pixel_y` and any number of
prefixed variable columns; an optional GeoJSON needs `id` and `group` properties per feature.
UI: per-layer parameter panel, 2D orthographic ↔ 3D orbiting toggle, tooltips (not on heatmap
layers), image export. Its thesis is that **layer stacking in one 3D space** beats separate 2D panels.
**Source:** https://yezhenqing.github.io/spatial-live/guide.html ,
https://github.com/yezhenqing/spatial-live , https://www.biorxiv.org/content/10.1101/2023.09.24.559173v1
**Confidence:** medium-high (explicit column names and layer names from the user guide)
**Action:** Adopt the *semantics* (variable type ⇒ visual encoding; stack layers rather than
switch views) and the prefix convention as a CSV-adapter compatibility shim. The ColumnLayer
elevation idea is the clearest thing to steal for our napari-js 3D mode.

### 7. The Visium mouse-brain dataset is small enough to be a trivial first target
**What:** Verified against the EMBL S3 bucket listing (`s3.embl.de/spatialdata`, prefix
`spatialdata-sandbox/`): `visium_spatialdata_0.7.1.zip` exists and is **68,220,724 bytes (~68 MB)**
(HTTP 200 on HEAD). Also present: `visium_hd_4.0.1_io_spatialdata_0.7.1.zip` (~182 MB),
`merfish_spatialdata_0.7.1.zip`, `mibitof_spatialdata_0.7.1.zip`,
`visium_associated_xenium_io_…zip` (~1.0 GB), `visium_hd_3.0.0_io_…zip` (~2.4 GB).
Note the docs page's short names (`visium`) do **not** resolve as URLs — the real keys carry a
`_spatialdata_<version>` suffix. A SpatialData Visium object holds `hires`/`lowres` images as
`DataArray[cyx]`, spot **shapes** (circles with a radius) in a GeoDataFrame, and an AnnData
**table** with `obs` (`in_tissue`, `array_row`, `array_col`, `spot_id`, `region`) and `var` (genes),
tied together by named coordinate systems with transformations. Visium v1 geometry: 55 µm spot
diameter, 100 µm centre-to-centre, 4,992 spots on a 6.5 × 6.5 mm capture area.
**Source:** `https://s3.embl.de/spatialdata?list-type=2&prefix=spatialdata-sandbox/` (live listing),
https://spatialdata.scverse.org/en/latest/tutorials/notebooks/datasets/README.html ,
https://kb.10xgenomics.com/s/article/360035487812
**Confidence:** high on the URLs/sizes (verified over the wire); medium on the per-dataset element
inventory (the tutorial fetched covers a multi-sample Visium object, not the sandbox one).
**Action:** Use `visium_spatialdata_0.7.1.zip` as the demo dataset. At ~3k spots it exercises every
encoding while making performance a non-issue — so performance work can be driven by a second,
larger target (Xenium/CosMx) rather than guessed at.

## Summary
The feature's centre of gravity is a **new data plane**, not a new renderer: the library can
already draw 2D points on a registered image (napari-js `PointsLayer` with per-point size/colour),
already has ROI drawing, colormap LUTs, contrast windows and a scale bar, and already ships a
Plotly build containing violin/box/histogram. What is missing is (a) any contract for
observations + categorical/continuous columns + a lazily-fetched feature matrix, (b) a shared
selection store to link the spatial view to 1D charts, and (c) three specific napari-js additions
(per-point colour/size in 3D, a shapes layer, lasso→indices selection). Recommend one
`SPATIAL_OMICS` 2D plot type over a layer stack for v1, with a separate 3D entry later.

## Open Questions
Unresolved without the user — they change the design rather than the estimate:
1. Production data source and wire format (server endpoint vs. host-supplied vs. browser-parsed
   Zarr/AnnData) — determines the port's shape and whether a Zarr reader enters the dependency set.
2. Target scale beyond Visium (Xenium/CosMx at 10⁵–10⁶ cells and 10⁷+ transcripts) — determines
   whether point tiling and a GPU shapes layer are v1 or later.
3. Whether napari-js changes are in scope this cycle, and precisely which "overlay/ROI support"
   is meant (bulk polygon rendering vs. lasso→index selection — interactive drawing already exists).
4. One layered `SPATIAL_OMICS` mode vs. several discrete plot types in the existing selector.
