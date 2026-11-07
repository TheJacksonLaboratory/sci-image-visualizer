# sci-image-visualizer and Vitessce: comparison and gaps

**Status:** reference, 2026-11-07. Compares sci-image-visualizer (SIV) 0.18.1 plus the WebGL spatial
fallback (`feat/spatial-webgl-fallback`) with [Vitessce](https://vitessce.io) 4.1.3 (npm, 2026-11-02;
repo `vitessce/vitessce` at `d54ec17`). Vitessce facts were read from its docs, its repository and npm;
anything not confirmed is marked _unverified_. Re-check both columns before acting on this: both
projects move monthly.

## Why this document

JAX Image Tools draws spatial omics through SIV's own renderers (napari-js on WebGPU, OpenSeadragon,
Plotly). Vitessce is the best-known web viewer for the same data, and the question keeps coming up of
whether to use it, borrow from it, or match it. This records what each does, where each falls short,
and what that means for SIV.

## The short answer

They are different kinds of thing, and neither replaces the other.

- **Vitessce is an application framework.** You give it a JSON view config naming data files by URL;
  it loads them itself, lays out linked views in a grid and keeps their state in its own coordination
  space. It is React-only, renders with WebGL2 (deck.gl, Viv, three.js), and reads community formats
  (SpatialData, AnnData, OME-Zarr, OME-TIFF) straight from static hosting.
- **SIV is an embeddable viewer library.** The host owns the data (through ports such as
  `SPATIAL_DATA_PORT`) and the layout. SIV owns rendering, regions and tools behind one `IVisualizer`
  contract. It is Angular, renders with OpenSeadragon, Plotly and napari-js (WebGPU), and is strong
  where Vitessce is thin: gigapixel whole-slide images, region editing, in-browser segmentation, and
  level-of-detail transcripts and outlines for Xenium-scale data.

Vitessce is therefore not a drop-in renderer for SIV's router. It wants to own data loading and view
state, and offers no imperative viewport, pixel readback or region-editing hooks. The realistic ways
to use it are side by side (an "Open in Vitessce" view on converted data) or as a source of ideas.
Running SIV without WebGPU, the gap that made Vitessce look attractive as an engine, is now closed for
the 2D markers by SIV's own WebGL2 layer (see [WebGPU](#webgpu-and-the-webgl-fallback)).

## Side by side

### Architecture and integration

|                      | SIV                                                                                                                                                | Vitessce                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Kind                 | Angular 17 library: components, services, DI tokens                                                                                                | React 18/19 component (`<Vitessce config height … />`) over ~55 `@vitessce/*` packages                                            |
| Who owns the data    | The host, through ports (`SPATIAL_DATA_PORT`, `TILE_ACCESS_PORT`, …)                                                                               | Vitessce: per-file loaders fetch URLs named in the config                                                                         |
| Who owns state       | Shared Angular stores (`VisualizerStore`, `RegionStore`, `SpatialSelectionStore`), read and written through `IVisualizer` / `getSpatialControls()` | The view config's coordination space; `onConfigChange` reports changes; a new `uid` (or, without one, any config change) remounts |
| Layout               | The host's; SIV supplies the viewer and dockable panels                                                                                            | Vitessce's grid, or `pageMode` to place views in host markup                                                                      |
| Non-native hosts     | Angular only                                                                                                                                       | React only; non-React pages mount it via `createRoot` (an importmap/CDN recipe is documented)                                     |
| Extension            | `PLOT_TYPE_CONTRIBUTIONS` (plot modes over a `PlotModeViewport`), `TOOLBAR_TOOLS`                                                                  | Plugin view, file, coordination and joint-file types; **may break on minor versions**                                             |
| Shareable view state | None as a document; state lives in stores                                                                                                          | JSON view config with a versioned schema (1.0.18), auto-upgraded                                                                  |
| Notebooks            | None                                                                                                                                               | vitessce-python 3.9.8 (Jupyter/anywidget, Colab, marimo); vitessceR (less active)                                                 |
| Licence              | MIT                                                                                                                                                | MIT                                                                                                                               |
| Bundle               | Large (Plotly, OpenSeadragon, napari-js, onnxruntime-web peer)                                                                                     | Large; docs recommend `React.lazy`; 3D/XR chunks lazy                                                                             |

### Data

|                               | SIV                                                                                                                                                      | Vitessce                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How data arrives              | A server behind `SpatialDataPort`: metadata eager, one column or gene vector per request, tiles for outlines, transcripts and density                    | Static files read directly (range requests), no server                                                                                                    |
| Formats in production         | jit-service reads 10x Xenium bundles in place (zip or `outs/`) and recognises `.h5ad`                                                                    | SpatialData zarr (images, labels, shapes, points, tables), AnnData zarr, MuData zarr, OME-Zarr (NGFF ≤ 0.4), OME-TIFF, CSV/JSON                           |
| Formats in the example server | SpatialData zarr served live, `.h5ad`, Xenium bundles, a synthetic Visium demo                                                                           | —                                                                                                                                                         |
| `.h5ad`                       | Yes (through the server)                                                                                                                                 | Only with a pre-generated kerchunk reference spec (`generate_h5ad_ref_spec`)                                                                              |
| Vendor formats                | Xenium read natively by the server                                                                                                                       | None native; convert with spatialdata-io (vitessce-python shows Xenium and Visium HD)                                                                     |
| Images                        | Gigapixel whole-slide images and z-stacks through the tile server; many channels (a 22-channel plate opens with four shown); native-bit-depth histograms | Pyramidal OME-Zarr/OME-TIFF through Viv; **at most 6 channels per image layer** in 2D (7 in the accelerated 3D renderer); non-pyramidal images load whole |
| Large point sets              | Transcript pyramid tiles served by level of detail (10⁸–10⁹ transcripts)                                                                                 | Tiled points only when SpatialData points are Morton-sorted with ~50k-row Parquet groups; open issue on slowness zoomed out (#2344)                       |
| Auth                          | The host's `HttpClient` interceptors (Bearer/cookie) apply to every request                                                                              | Per-file `requestInit` (headers) on most loaders; custom zarr stores via `stores`; the h5ad reference spec is fetched without it                          |

### Spatial-omics views

|                                      | SIV                                                                                          | Vitessce                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Markers over tissue                  | Yes, coloured by column or gene, percentile-clipped, log option, shared colormap             | Yes (`spatial` / `spatialBeta`)                                                                                            |
| Cell outlines and fills              | Level-of-detail polygon tiles (napari-js)                                                    | Polygons (JSON, AnnData `obsm`, SpatialData shapes) or bitmask labels                                                      |
| Transcripts                          | Level-of-detail tiles, per-gene colour and icon, density raster, selection fading            | `obsPoints` from SpatialData points (Parquet)                                                                              |
| Gene map (smoothed expression field) | Yes, 2D and per-section in 3D                                                                | Not found                                                                                                                  |
| 3D                                   | Point cloud in the reference volume, cluster density volumes, per-section gene maps (WebGPU) | Viv 3D, a three.js renderer with WebXR, and a brick-streamed volume renderer                                               |
| Linked charts                        | Histogram, violin, box, embedding scatter, gene × class mean-expression heatmap              | Scatterplot/embedding, heatmap, violin, histogram, bar, dot plot, treemap, set sizes                                       |
| Comparative / multi-sample           | No                                                                                           | Yes: sample sets, volcano plot, feature stats, composition and enrichment bars (from precomputed results in AnnData `uns`) |
| Other views                          | —                                                                                            | Neuroglancer (meshes), HiGlass genomic profiles, gating, biomarker selection, annotation stories                           |

### Interaction and analysis

|                               | SIV                                                                                                                           | Vitessce                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Selecting cells               | Any drawn region (rectangle, polygon, freehand, wand, brush, SAM), legend rows, click on a marker; in 3D, imported 3D regions | Lasso in spatial and scatterplot views (slow above ~100k, issue #2349); no rectangle tool                    |
| Cell sets                     | Selection; groups imported from CSV/TSV (server)                                                                              | Lasso creates sets; union, intersection, complement; JSON/CSV import and export of hierarchies               |
| Regions / annotations         | Full region editor: vertex and Bézier editing, classes, undo/redo, GeoJSON import/export with QuPath planes, per-slice ROIs   | Annotation stories (rectangle, ellipse, polygon, polyline, line plus text), editable since 4.1.0; no GeoJSON |
| In-browser computation        | SAM and cellpose-SAM segmentation (ONNX), t-SNE on the GPU, gene-map estimation in a worker                                   | None                                                                                                         |
| Server-side analysis surfaced | Marker genes per group                                                                                                        | Precomputed comparative results only                                                                         |
| Export                        | PNG of the view, composite PNG and TIFF, GeoJSON regions                                                                      | Links to the source files; no PNG/SVG export found                                                           |

### WebGPU and the WebGL fallback

|                | SIV                                                                                                                                                                                                                                                                                                                                 | Vitessce                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GPU API        | napari-js on WebGPU for the spatial, volume and 3D modes; WebGL2 fallback for the 2D spatial markers and gene map; OpenSeadragon and Plotly otherwise                                                                                                                                                                               | WebGL2 throughout (deck.gl 8.8, luma.gl 8.5, three.js); no WebGPU |
| Without WebGPU | 2D spatial: tissue on OpenSeadragon, markers and gene map in WebGL2, same colours, filter, selection, tooltip and click as napari-js. Not yet drawn: LOD outlines, transcripts, density, per-gene icons, image-less datasets. Spatial 3D and the napari 3D types are routed to Plotly, which does not draw the 3D observation cloud | Unaffected                                                        |

## Gaps

### Where SIV is behind

1. **Linked, multi-view analysis.** Vitessce's coordination model links any number of views over one
   or several datasets; SIV's linked charts are one panel next to one spatial view. Missing in SIV: a
   dot plot, set-size and composition plots, and the comparative views (sample sets, volcano,
   enrichment).
2. **Cell-set algebra and persistence.** Vitessce lets users build, combine and save named cell sets
   (union, intersection, complement; JSON/CSV). SIV has one current selection, plus server-side group
   import.
3. **Serverless reading of community formats.** Vitessce reads SpatialData, AnnData and OME-Zarr from a
   bucket with no server. SIV needs a `SpatialDataPort` server; reading zarr in the browser was kept out
   of the package on purpose (design doc, decision D1), and in-browser SpatialData/AnnData reading is
   still a might-have there.
4. **Shareable, versioned view state.** A Vitessce config reproduces a view anywhere: a portal, a
   notebook, a paper. SIV has no equivalent document.
5. **Notebook reach.** vitessce-python puts the same viewer in Jupyter; SIV has no Python surface.
6. **Without WebGPU**, the 2D fallback still lacks outlines, transcripts and density, and spatial 3D is
   WebGPU-only. Vitessce draws all of its views on WebGL2.
7. **Meshes and genome tracks** (Neuroglancer, HiGlass): none in SIV.

### Where Vitessce is behind

1. **Whole-slide imaging.** No gigapixel tiled pathology pipeline comparable to OpenSeadragon on a tile
   server; 6 channels per 2D image layer; non-pyramidal images load whole.
2. **Region editing.** Annotation stories are narrative overlays, not editable, classifiable ROIs with
   GeoJSON/QuPath interchange.
3. **In-browser AI.** No segmentation, no promptable SAM, no embedding computation.
4. **Xenium scale without conversion.** Vitessce needs a spatialdata-io conversion, then Morton-sorted
   points, to stream transcripts; SIV's server reads Xenium bundles in place and tiles transcripts by
   level of detail.
5. **Gene maps and density fields**, in 2D and 3D: not found in Vitessce.
6. **Selection tools.** Lasso only, slow above ~100k observations; SIV selects with every region tool
   and by click, over millions of observations.
7. **Embedding in a non-React app.** Possible only by mounting a React root; there is no
   framework-agnostic API, and the plugin API can break between minor versions.

## What this means for SIV

**Do not adopt Vitessce as a renderer behind `RoutingVisualizerService`.** It would need data loading
re-plumbed through unstable plugin file types, SIV's store state mirrored into Vitessce configs both
ways, and React mounted inside Angular. It would also lose pixel readback, the region overlay and the
canvas tools, which the `IViewerBackend` contract depends on. The original motive, rendering without
WebGPU, is now met in SIV itself.

**Reasonable uses, in order of cost:**

1. **Borrow ideas** (no dependency): named cell sets with set algebra and CSV/JSON export; a dot plot
   next to the gene × class heatmap; a JSON "view state" a host can save and restore through
   `IVisualizer`.
2. **Interoperate on data:** have the JIT preprocessing job also write SpatialData zarr (spatialdata-io)
   next to a Xenium bundle, so the same dataset can be opened in Vitessce, napari and notebooks. See
   [omics-preprocessing-jit.md](design/omics-preprocessing-jit.md).
3. **"Open in Vitessce"** as a separate jit-ui route, mounting `<Vitessce>` in a React root on that
   SpatialData output, for exploratory multi-view and comparative analysis SIV does not aim to cover.
   Medium effort: the conversion job, zarr served with range requests and auth headers
   (`requestInit`), and the React island. No tie-in to SIV's regions or tools.

**Close SIV's own gaps first** where they matter to JIT users: the remaining WebGL fallback layers
(outlines, transcripts, density) and cell-set management.

## Sources

Vitessce:

- npm `vitessce` 4.1.3: <https://www.npmjs.com/package/vitessce>
- Repository at `d54ec17`: <https://github.com/vitessce/vitessce> (`packages/`, `CHANGELOG.md`,
  `packages/vit-s/src/VitS.js`, `packages/main/all/src/base-plugins.ts`, `packages/gl/src/ToolMenu.js`)
- Docs: [React component](https://vitessce.io/docs/js-react-vitessce/) ·
  [JS overview](https://vitessce.io/docs/js-overview/) · [view types](https://vitessce.io/docs/components/) ·
  [data file types](https://vitessce.io/docs/data-file-types/) ·
  [data troubleshooting](https://vitessce.io/docs/data-troubleshooting/) ·
  [view config](https://vitessce.io/docs/view-config-json/) · [plugins](https://vitessce.io/docs/dev-plugins/) ·
  [annotations](https://vitessce.io/docs/js-annotations/) · [comparative data](https://vitessce.io/docs/data-comparative/) ·
  [data hosting](https://vitessce.io/docs/data-hosting/) · [showcase](https://vitessce.io/docs/showcase/)
- Issues: [#2344](https://github.com/vitessce/vitessce/issues/2344) (tiled data slow zoomed out),
  [#2349](https://github.com/vitessce/vitessce/issues/2349) (lasso slow)
- vitessce-python 3.9.8: <https://github.com/vitessce/vitessce-python>, <https://pypi.org/project/vitessce/>
- Viv channel limit: `@vivjs/constants` 0.16.1 `MAX_CHANNELS`

SIV: [README](../README.md), [spatial-omics guide](guides/spatial-omics.md),
[spatial-omics design record](design/spatial-omics-plot-mode-design.md),
[competitive landscape in the SOW](JIT_UI_visualization_library_SOW.docx), and the code under
`src/lib/` at the commit above.
