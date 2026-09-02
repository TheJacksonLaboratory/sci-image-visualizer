# Spatial-omics plot mode — design & implementation plan

> Status: **P1 (data plane) implemented; P2+ awaiting answers to the Open Questions.**
> Companion research (sources, verified numbers): [`.planning/research/spatial-omics-plot-mode.md`](../.planning/research/spatial-omics-plot-mode.md)

## Decisions

| # | Decision | Date | Rationale |
|---|---|---|---|
| D1 | **Data reaches the library through a server endpoint + host port adapter** (option A of three; the alternatives were a host-supplied in-memory object, or reading SpatialData Zarr in the browser). | 2026-09-01 | The store is Zarr v3 + AnnData conventions + GeoParquet — three parsers — and its matrix is observation-major, so reading one gene means scanning every row. A server pre-transposes once; a browser cannot. Option A also keeps the package's runtime dependencies unchanged. The port is narrow enough that a browser Zarr reader can implement it later without a breaking change. |
| D2 | The feature matrix is stored and served **gene-major**. | 2026-09-01 | Turns a per-gene fetch into a contiguous ranged read at `geneIndex · N · 4`, independent of gene count, and keeps the matrix out of server memory. This is the concrete payoff of D1. |
| D3 | `SpatialDataHttpService` ships **in** the library but **unbound by default** (`@Injectable()` with no `providedIn`). | 2026-09-01 | Every host would otherwise write the same fetch/decode code, and shipping it documents the wire format executably. Leaving it out of the DI graph keeps the port inversion honest — mirrors `CellposeSegmenterService`. |
| D4 | The spatial plot types are **hidden from the selector until a dataset is published** on `SPATIAL_DATA_PORT`, via a declarative `requiresSpatialData` flag on `PlotTypeDescriptor`. | 2026-09-01 | Same shape of gate as `requiresStack` (no volume without a z-stack) and `requiresGrayscale` (no contour on RGB): the mode has nothing to draw without observations. Declarative, so the filter stays one line and a host that never provides the port never sees the mode. |

Add a plot mode to `@jax-data-science/sci-image-visualizer` that visualizes spatial-omics
datasets — per-cell / per-spot measurements laid over the tissue image they came from — with
linked 1D distribution charts.

3D rendering goes through **napari-js** (with additions on that side); histograms, 1D plots and
violins go through **Plotly**.

---

## 1. Where the library stands today

Read from source, not assumed:

| Piece | Today | File |
|---|---|---|
| Data intake | Images only: URLs + `imageMeta` + `tiled`/`isStack` | `contracts/image.contract.ts:44` |
| Plot registry | `PlotType` enum + `PLOT_TYPE_DESCRIPTORS` (label, icon, 2d/3d, source, gates) | `contracts/plot-type.ts` |
| Data-source tag | `PlotDataSource = 'image' \| 'regions'` — **declarative only, zero consumers** | `contracts/plot-type.ts:46` |
| Backend routing | Per plot type: OSD → Plotly → napari-js, with fallback chains | `routing-visualizer.service.ts:119` |
| Regions | Shared store, GeoJSON model, class colours, undo/redo, stack-aware | `store/region-store.service.ts` |
| ROI drawing on napari-js | SVG overlay: rect/polygon/freehand, vertex+Bézier edit, rubber-band select | `implementations/napari-js/napari-region-overlay.ts` |
| Display state | Colormap/LUT, per-channel window + gamma, invert, reverse — shared across backends | `store/visualizer-store.service.ts`, `contracts/channel-histogram-api.contract.ts` |
| Plotly builders | Pure `TraceBuildInput → traces[]` registry, image-matrix-shaped | `implementations/plotly/plotly-trace-builders.ts:29` |
| Plotly bundle | `plotly.js-dist-min` — **already contains `violin`, `box`, `histogram`, `scattergl`** | verified in `node_modules` |
| napari-js | `Image`, `Points`, `Points3D`, `Labels`, `Volume`, `Surface`, `Axes` layers | `napari-js@0.11.1` `dist/index.d.ts` |

**The one-line conclusion:** this feature is 70% a *data-plane* problem and 30% a rendering
problem. The renderers are largely in place; there is no contract in the library that can
express "N observations with categorical and continuous columns".

---

## 2. What we take from the references

**CosMx Analysis Scratch Space** — the *encoding* rules. Grey low-alpha background points;
categorical cell type on a stable palette (collapse to 5–10 major types when there are many);
continuous expression on viridis/magma, log-scaled, outliers percentile-capped; highlight-vs-mute
(bold border + full alpha on the cells of interest, everything else muted); **subsample background
to ~5% while keeping 100% of the highlighted category**; faceted gallery, one category per panel
over a shared background; scale bar sized to ~¼ of the axis. These are controls, not polish.

**Spatial-Live** — the *model*. A variable's type picks its visual layer:
categorical → coloured dots, numerical → extruded columns whose **height ∝ value**, gene →
Gaussian-smoothed heat bitmap, GeoJSON → shapes. Input is a PNG defining the pixel coordinate
space plus a CSV with `id:spot`, `pos:pixel_x`, `pos:pixel_y` and prefixed variable columns
(`char:`, `num:`, `gene:`). Its thesis — **stack layers in one space instead of switching between
2D views** — is the reason this proposal is one layered mode rather than six plot types.

**SpatialData / Visium** — the *shape of real input*: images (`hires`/`lowres`, `cyx`), spot
**shapes** (circles with a radius), an AnnData **table** (`obs` = per-spot annotations, `var` =
genes), and named **coordinate systems with transformations** tying them together. Our contract
mirrors that split rather than inventing a new one.

**Demo dataset:** `visium_spatialdata_0.7.1.zip` — Visium mouse brain, ~68 MB, verified live at
`https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_spatialdata_0.7.1.zip`.
Visium v1 geometry: 55 µm spots, 100 µm pitch, 4,992 spots per capture area — small enough that
every encoding can be exercised before performance becomes a variable.
*(The short names on the scverse docs page are not URLs; the real S3 keys carry a
`_spatialdata_<version>` suffix.)*

---

## 3. Proposed architecture

### 3.1 New data plane

A neutral contract plus a host-supplied port — same inversion as `TILE_ACCESS_PORT`, so the
library never learns about Zarr, AnnData, or anyone's REST API.

```ts
// contracts/spatial-dataset.contract.ts   (new)

/** Struct-of-arrays: sized for 10^5–10^6 observations, not object-per-cell. */
export interface SpatialObservations {
  readonly count: number;
  ids?: string[];
  /** Coordinates in the reference image's pixel space. */
  x: Float32Array;
  y: Float32Array;
  z?: Float32Array;                       // serial sections / true 3D
  /** Marker radius in image pixels — per-obs, or one value (Visium: 55 µm ÷ mpp). */
  radius?: Float32Array | number;
}

export interface CategoricalColumn {
  kind: 'categorical'; name: string;
  codes: Uint16Array;                     // index into `categories`
  categories: string[];
  colors?: string[];                      // optional authored palette
}
export interface ContinuousColumn {
  kind: 'continuous'; name: string;
  values: Float32Array;
  unit?: string;
  /** Hint that this column reads best log-scaled (counts). */
  logScaleHint?: boolean;
}
export type SpatialColumn = CategoricalColumn | ContinuousColumn;

/** Genes/features are lazy — the full matrix never crosses the wire. */
export interface FeatureIndex {
  names: string[];
  getVector(name: string): Promise<Float32Array>;   // length = count
}

/** Cell/spot boundaries as flat rings + offsets (NOT GeoJSON objects at 10^5 scale). */
export interface SpatialPolygons {
  coords: Float32Array;                   // x0,y0,x1,y1,…
  offsets: Uint32Array;                   // ring start indices, length N+1
}

export interface SpatialDataset {
  name: string;
  observations: SpatialObservations;
  columns: Map<string, SpatialColumn>;
  features?: FeatureIndex;
  polygons?: SpatialPolygons;
  /** How obs coordinates map onto the underlying image. */
  imageRef?: {
    scale: [number, number];
    translate: [number, number];
    mppX?: number; mppY?: number;
  };
}
```

```ts
// contracts/ports/spatial-data.port.ts   (new)
export interface SpatialDataPort {
  getDataset$(): Observable<SpatialDataset | null>;
  getFeatureVector(name: string): Promise<Float32Array>;
  /** Optional server-side ROI query for datasets too large to hold client-side. */
  queryRoi?(polygon: { x: number[]; y: number[] }): Promise<Uint32Array>;
}
export const SPATIAL_DATA_PORT = new InjectionToken<SpatialDataPort>('SPATIAL_DATA_PORT');
```

Plus `PlotDataSource` gains `'spatial'` — free, since nothing consumes it yet.

### 3.2 New shared store: `SelectionStore`

The thing that makes this more than a picture. One observable set of observation indices,
peered with `RegionStore`, written by any of:
- a rectangle/lasso drag on the spatial view,
- **point-in-polygon over the existing `RegionStore` regions** — which means every existing ROI
  tool (rect, polygon, freehand, wand, brush) becomes a spatial-omics selection tool for free,
- a click on a legend category,
- a click/drag on a violin or histogram.

Read by: the points layer (mute non-selected via per-point alpha, per the CosMx rule) and every
1D chart (restrict to selection).

### 3.3 Plot types

One layered mode, not six. Rationale: the plot-type selector is single-select and re-mounts the
viewer on change; spatial omics is inherently multi-layer; and `PlotTypeDescriptor.dimensions` is
static, so a mode that toggled 2D↔3D internally would fight the contract.

```ts
SPATIAL_OMICS     // '2d', source: 'spatial'  — v1
SPATIAL_OMICS_3D  // '3d', source: 'spatial'  — phase 5, elevation ∝ value
```

Inside the mode, a **layer stack** panel (mirroring the Channels & Histogram pane's shape):

| Layer | Renderer | Data |
|---|---|---|
| Tissue image | existing napari-js `ImageLayer` / tiled path | `IImageInfo` (unchanged) |
| Observations (spots/cells) | napari-js `PointsLayer` | `x`, `y`, `radius`, colour-by column |
| Boundaries | napari-js **shapes layer (new)** | `SpatialPolygons` |
| Density | napari-js `ImageLayer` fed a CPU/GPU KDE raster | one feature vector |
| Columns (3D) | napari-js `Points3D`/**column layer (new)** | numeric column → elevation |
| ROIs / annotations | existing SVG region overlay | `RegionStore` |

Colour-by resolves through the existing machinery: categorical → palette (reuse
`store/class-color.util.ts`), continuous → the existing colormap LUTs + contrast window
(`VisualizerStore`), with a log toggle and percentile capping added.

### 3.4 napari-js additions

Confirmed missing against the shipped `0.11.1` typings — these are the asks on the napari-js side:

1. **`Points3DLayer`: per-point `faceColor` (RGBA[]) and per-point `size`.** Today it takes only a
   per-point scalar + colormap and a single uniform size, so categorical cell types cannot be
   coloured in 3D at all.
2. **A shapes/polygon layer** (instanced or tessellated fills + outlines) for cell boundaries. The
   existing SVG region overlay is DOM-based; it is right for a handful of hand-drawn ROIs and wrong
   for 10⁴–10⁵ segmentation polygons.
3. **Lasso / rectangle selection returning indices.** Picking today is
   `nearestPointIndex(...)` — a CPU single-point hit test, 2D only. Needs a set-returning
   selection, and a spatial index (uniform grid or quadtree) so it is not O(N) per drag frame.
4. **Screen-space size floor for 2D points.** `PointsLayer.size` is in data units (correct for
   55 µm Visium spots) but individual cells vanish when zoomed out; want
   `sizeUnits: 'data' | 'screen'` or a min-screen-diameter clamp.
5. *(3D mode only)* **A column/extruded-marker layer** for the Spatial-Live elevation look, or an
   agreed decision to approximate it with elevated 3D points.

6. **`PointsLayer.faceColor` should accept a `Float32Array`.** It currently takes `RGBA[]` — an
   array of 4-element tuples — so per-point colour costs N small arrays that `buildInstanceData()`
   immediately flattens again. Negligible for Visium (~2k), real allocation churn at 10⁵–10⁶.
   `spatial-encoding.ts` already computes a flat `Float32Array` and adapts at the boundary
   (`toRgbaTuples`), so this ask is purely a deletion on our side. *(Found while building P2.)*

Items 1, 3, 4 and 6 are small. Item 2 is the substantial one.

### 3.5 Plotly additions

The violin **trace already exists in the bundle we ship** — verified by scanning
`plotly.js-dist-min`'s `plotly.min.js` for trace-type strings (`violin` ✅, `box` ✅). So no
bundling or dependency change.

What is genuinely missing is a **table-shaped charting surface**. Every Plotly path today runs
through `TraceBuildInput` (`frames`, `width`, `height`, `ratios`, `trueImageSize`) — image-matrix
shaped, and wrong for "one value per cell". Plan:

- `implementations/plotly/omics-trace-builders.ts` — a parallel pure registry over a new
  `OmicsTraceInput { values, groupCodes?, groupNames?, selection? }`, building `histogram`,
  `violin`, `box` and `scattergl` traces.
- Reuse the existing `'2d-chart'` `layoutKind` (already used by intensity profiles).
- `ISpatialChartsApi` + a dockable panel component, built like `ChannelHistogramComponent`
  (contract-only dependency, injected token, never reaching the concrete visualizer).
- Selection-aware: charts show *all* vs *selected* as overlaid traces.

---

## 4. Requirements — MoSCoW

### Must-have (v1 is not v1 without these)

1. `SpatialDataset` contract + `SPATIAL_DATA_PORT`; `PlotDataSource` extended with `'spatial'`.
2. `PlotType.SPATIAL_OMICS` (2D) descriptor + routing to napari-js in `RoutingVisualizerService`.
   The descriptor carries `requiresSpatialData: true`, so the mode is offered **only while a
   dataset is selected** and disappears (falling back to Image) when one is cleared — the gating
   mechanism is already in place, so this is a one-line descriptor addition. *(D4)*
3. Tissue image underlay, with observation coordinates registered to it (`imageRef` transform).
4. Observation points layer: per-point position, radius, colour.
5. ~~**Colour by categorical column** — stable palette, legend.~~ **Done.**
   (Click-a-category-to-select still open — it needs the selection store, P3.)
6. **Colour by continuous column** — existing colormap LUTs + contrast window, plus a log toggle
   and percentile capping (CosMx guidance).
7. ~~**Gene/feature picker** → lazy `getVector(name)` → continuous colouring.~~ **Done** —
   typeahead in the controls panel, over the port's search or the inlined names.
8. Hover tooltip: observation id + the active column's value.
9. ~~`SelectionStore` + selection by existing `RegionStore` ROIs (point-in-polygon);
   selected obs highlighted, non-selected muted via alpha.~~ **Done.** The drag-rectangle
   case is covered by the existing rectangle ROI tool, so no separate marquee was built.
10. ~~Linked **histogram** of the active continuous column, selection-aware.~~ **Done** —
    plus violin and box (Should 14). The histogram overlays *Selected* on the full distribution;
    violin/box narrow to the selection and split by a categorical column.
11. Display controls: ~~point size/scale, global alpha~~ **done**; log scale and outlier clip
    also landed. Background subsample fraction still open (gated on the scale question, Q4).
12. ~~Runnable demo in `examples/` end to end.~~ **Done, on real data**: the scverse
    `visium_spatialdata_0.7.1` mouse-brain store converts to 2,987 spots + its H&E image with the
    store's own affine, via a dependency-free Node reader (`lib/zarr3.mjs`). The synthetic
    generator remains for a no-download path.
13. Tests to the repo standard (jest specs beside source) + `npm run typecheck`, `lint`, `test`
    green; README + this doc updated.

### Should-have

14. **Violin** and **box** plots of a continuous column grouped by a categorical one.
15. Two-way brushing: ~~space → chart~~ **done** (the charts narrow to the selection);
    chart → space still open (a Plotly `selected` event writing back to the selection store).
16. Cell/spot **boundary polygon layer** (needs napari-js shapes layer). **Now unblocked on the
    data side and blocked only on the renderer**: the Visium HD demo serves 84,031 real cell
    outlines (1.8M vertices) on `/polygons`, and `SpatialDataPort.getPolygons()` reads them — but
    nothing draws them, because napari-js has no shapes layer (ask #2 in §3.4). This is the
    clearest case for building it.
17. Plotly `scattergl` fallback mode so the feature degrades gracefully without WebGPU.
18. `SPATIAL_OMICS_3D`: elevation ∝ numeric column (Spatial-Live ColumnLayer analog), on the
    existing 3D camera/axes controls (needs napari-js per-point colour in 3D).
19. Faceted small multiples — one panel per category over a shared muted background.
20. Density / KDE heat-bitmap layer for a selected gene.
21. Export: figure PNG (reuse `exportComposite`) and selected observations as CSV/GeoJSON.
22. CSV adapter in `examples/` honouring Spatial-Live's `id:` / `pos:` / `char:` / `num:` / `gene:`
    prefixes, so existing Spatial-Live inputs load unchanged.

### Might-have

23. Transcript/molecule point layer with per-gene filtering (CosMx/Xenium scale: 10⁷+ points →
    needs point tiling / LOD).
24. Multi-section 3D: several registered sections stacked at different z.
25. Arc / link layer (neighbour graph, ligand–receptor pairs).
26. In-browser neighbourhood statistics (k-NN composition, co-occurrence).
27. Differential expression between two selections.
28. Direct in-browser SpatialData Zarr / AnnData reading (`zarrita` / `h5wasm`).
29. Bidirectional sync with the segmentation tools: a cellpose/SAM mask set becomes an
    observation set with its own columns.

### Won't (this round)

- Clustering, dimensionality reduction, or any analysis pipeline — this is a viewer.
- Server-side rendering or compute services.
- Multi-sample joint/atlas views.

---

## 5. Phasing

Each phase ends green on `npm run typecheck && npm run lint && npm test`.

| Phase | Work | End condition |
|---|---|---|
| **P0 — Spike** (~1–2 d) | Hard-code the Visium spots into a `PointsLayer` over the tissue image in the example app. No contracts. | A screenshot of ~3k spots coloured by cluster over mouse brain. Kills or confirms the approach. |
| **P1 — Data plane** ✅ **done** | `SpatialDataset` contract, `SPATIAL_DATA_PORT`, `SpatialDataHttpService`, `PlotDataSource: 'spatial'`; example-server endpoints, synthetic demo generator, end-to-end smoke check, Python converter for real SpatialData Zarr stores. *(`SelectionStore` moved to P3, where it is actually consumed.)* | ✅ Contracts exported from `src/index.ts`; 45 new unit tests; `smoke-spatial` green; typecheck · lint · test (965) · build all pass. Also landed: the `requiresSpatialData` selector gate (D4). Converter is written but not yet run against a live store. |
| **P2 — 2D mode** ⏳ **renderer done, host controls not** | ✅ `SPATIAL_OMICS` plot type + descriptor + routing to napari-js; ✅ observation markers over the tissue image with the dataset's data→world affine; ✅ categorical colouring (column palette) and continuous colouring (active colormap, log scale, percentile-clipped window); ✅ gene colouring through the port's lazy vector fetch; ✅ point-size scale + opacity via `VisualizerStore`. ✅ `ISpatialControls` (`getSpatialControls()`) — the host-facing surface for colour-by, view state, feature search and legend colours, implemented on the router because the state is backend-neutral; ✅ end-to-end demo: `make-spatial-demo` now emits a matching tissue-image pyramid with a real (non-identity) `imageRef` affine, and the browser example loads image + dataset together. ✅ `<spatial-controls>` panel: column dropdown, gene typeahead, categorical legend, continuous colour bar, point-size / opacity / log-scale / outlier-clip. ❌ Still to build: hover tooltip, background subsampling. | Renderer + encodings + controls covered by 37 napari, 26 encoding and 9 router specs; `smoke-spatial` checks every spot lands inside the image under the affine. |
| **P3 — Selection** ✅ **done** | `SpatialSelectionStore` + pure `spatial-selection.ts` (ray-cast point-in-polygon with holes, bbox pre-reject, `imageRef` affine applied); selection from the drawn ROIs and from a legend click; unselected observations muted per the CosMx rule. **No separate marquee** — every existing ROI tool (rect, polygon, freehand, wand, brush) becomes a selection tool. | ✅ Must-have 9. 20 geometry specs, 5 store specs, 7 router specs, 7 panel specs. |
| **P4 — Linked charts** ✅ **done** | `omics-trace-builders.ts` (pure: histogram / violin / box, kept separate from the image-shaped `plotly-trace-builders`), `<spatial-charts>` panel, `ISpatialControls.continuousValues` / `categoricalView` / `categoricalColumns`. The chart follows whatever the MAP is coloured by, so the two cannot disagree. | ✅ Must-have 10, Should 14. 21 builder specs + 16 panel specs. Violin needed no bundling — `plotly.js-dist-min` already carries it. |
| **P5 — 3D** | napari-js per-point colour/size in 3D; `SPATIAL_OMICS_3D` with elevation. | Should 18. |
| **P6 — Scale** | napari-js shapes layer; boundary rendering; point LOD/tiling; validate on a Xenium/CosMx dataset. | Should 16, Might 23. |

napari-js work (§3.4 items 1, 3, 4) lands with P2/P3; item 2 with P6. Both repos version
independently, so each phase pins a napari-js version the way `0.5.0`/`0.11.1` were pinned before.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| The feature bloats the core bundle for hosts that only view images. | Consider a secondary entry point (`@jax-data-science/sci-image-visualizer/spatial`). See Q15. |
| Scale: Visium (~3k spots) proves nothing about Xenium (~10⁵ cells) or transcripts (10⁷). | Pick the *second* dataset early (Q4) and treat it as the perf gate, rather than tuning against a dataset that can't fail. |
| Two-repo coupling — a napari-js API change blocks the library. | Keep v1's napari-js asks small (per-point colour/size, lasso). The shapes layer, the big one, is deferred to P6. |
| WebGPU unavailability. | **Live gap:** `SPATIAL_OMICS` routes napari-js → OSD → Plotly, and the fallbacks render the tissue image *without* the observation layer — partial, not degraded. Should-have 17 (Plotly `scattergl` spatial mode) is the real fix. |
| Coordinate-space drift between spots, image and ROIs. | Single `imageRef` transform in the contract; assert against the existing full-resolution world-coordinate convention the napari backend already uses for ndpi alignment. |
| Categorical palettes diverging from the analysts' R/Python figures. | Accept authored `colors[]` on `CategoricalColumn` so a palette can be passed in rather than re-derived. |

---

## 7. Open questions

These change the design, not just the estimate. **Not guessed at — please answer.**

### A. Data & ingest
1. ~~**Where does the data come from in production?**~~ **Answered (D1):** a server endpoint,
   consumed through `SPATIAL_DATA_PORT`. The bundled example server implements it.
2. ~~**Do we get to define the wire format?**~~ **Answered (D1):** yes — defined in
   `spatial-wire.ts` and implemented on both sides. No Zarr/AnnData reader enters the package.
3. **Feature matrix strategy:** lazy per-gene vectors from a server, or the whole matrix
   client-side? What are the realistic upper bounds on observation count and gene count?
4. **Which technologies beyond Visium must v1 or v2 support** — Xenium, CosMx, MERFISH, Visium HD?
   This single answer decides whether point LOD and the GPU shapes layer are v1 or P6.

### B. Scope & UX
5. **One layered `SPATIAL_OMICS` mode, or several discrete plot types** in the existing selector?
   (Recommendation: one mode + layer stack, plus a separate `SPATIAL_OMICS_3D` entry.)
6. Does the mode live inside `<visualizer>` with the current toolbar, or is it a **separate
   component** the host places itself?
7. **Is 3D required for v1**, or does the 2D mode ship first and 3D follow?
8. Should the 1D charts be a **new dockable panel** inside the library (like Channels &
   Histogram), or an exported API the host renders wherever it likes?

### C. napari-js
9. **Do we own napari-js changes in this cycle?** i.e. can we ship a `0.12.x` with new layers, or
   must v1 fit inside `0.11.1`'s existing API?
10. **"Overlay/ROI support on the napari-js side" — which of these do you mean?**
    (a) bulk GPU rendering of 10⁴–10⁵ cell-boundary polygons, (b) lasso/rectangle selection
    returning observation indices, (c) something else? *Interactive ROI drawing already exists*
    via `napari-region-overlay.ts` (rect/polygon/freehand, vertex + Bézier edit, rubber-band
    select), so I read the gap as (a) and (b) — please confirm.
11. OK to add **per-point colour + per-point size to `Points3DLayer`**, and a screen-space size
    floor to `PointsLayer`? Both are additive and backwards-compatible.

### D. Plotly
12. **Violin is already in the bundle we ship** (verified). Do you still want a hand-rolled violin
    — e.g. for control over the KDE bandwidth, or half-violins / raincloud layouts Plotly won't do
    — or is the built-in trace acceptable?
13. Is **two-way brushing** (chart ⇄ space) in v1, or is one-way (space → charts) enough to start?

### E. Release & fit
14. Should the new plot types ship **default-visible, or test-mode-only** at first? (The
    `productionLabel` field on `PlotTypeDescriptor` is exactly this switch.)
15. Minor release of this package, or a **secondary entry point** (`/spatial`) so image-only hosts
    don't pay for it?
16. **Are there real JAX datasets or pilot users driving this?** If so their format should be the
    primary target and Visium just the public demo — that reorders P1 substantially.
