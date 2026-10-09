# Architecture

A map of `src/lib` for contributors: how a host plugs in, which layer owns what,
and where each backend, store, tool and worker lives. It describes the code as
it is; the plans that shaped it are in [`history/`](./history/), and design
records for individual features are in [`design/`](./design/).

The only public entry point is [`src/index.ts`](../src/index.ts). Everything
else under `src/lib/` is internal, even when it is exported from its own file.

## Layers

```
host app
  │  imports VisualizationModule (or provideVisualization() for an isolated viewer)
  │  provides the ports: IMAGE_STATE_PORT, TILE_ACCESS_PORT, REGION_IO_PORT, VIZ_CONFIG, …
  ▼
components         <visualizer> · <region-editor> · <channel-histogram> · <spatial-controls> · …
  │  inject only the contract tokens: VISUALIZER, REGION_EDITOR_API, CHANNEL_HISTOGRAM_API
  ▼
RoutingVisualizerService      implements all three tokens; picks a backend per plot type
  │
  ├── OpenSeadragonVisualizerService   implementations/osd/        tiled image view
  ├── PlotlyService                    implementations/plotly/     2D/3D plots, intensity profiles
  └── NapariVisualizerService          implementations/napari-js/  WebGPU image/volume/spatial
  │
  ▼
stores (providedIn: 'root')   VisualizerStore · RegionStore · SpatialSelectionStore
```

The rule the layers follow: **components and hosts depend on contracts, never
on a backend.** `contracts/` is the backend-neutral layer; an eslint rule
(`no-restricted-imports`, see `.eslintrc.json`) keeps it from importing
implementations, stores, toolbar or components.

## `src/lib` layout

| Path | Owns |
|---|---|
| `contracts/` | Interfaces and DI tokens: `visualizer.contract.ts` (`IVisualizer`, `VISUALIZER`), `capabilities.contract.ts`, `plot-type.ts` (`PlotType`, descriptors), `region-overlay.contract.ts`, `region-store.contract.ts`, `coordinate-transform.contract.ts`, `toolbar-tool.contract.ts`, `plot-type-contribution.contract.ts`, `viz-config.ts`, the segmenter contracts, `spatial-dataset.contract.ts`, `display-types.ts`, `colormap-lut.ts`, `intensity.ts` |
| `contracts/ports/` | What the host implements: `image-state`, `tile-access`, `region-io`, `preferences`, `spatial-data` |
| `routing-visualizer.service.ts` | The composition-root service behind `VISUALIZER` / `REGION_EDITOR_API` / `CHANNEL_HISTOGRAM_API` |
| `implementations/osd/` | OpenSeadragon backend: service, SVG region overlay, tile client, slice cache, display pipeline, histogram sampler, scale bar |
| `implementations/plotly/` | Plotly backend: service, region overlay (Plotly shapes), trace builders, omics chart builders (public) |
| `implementations/napari-js/` | WebGPU backend: service, SVG region overlay, spatial tiles (LOD loop for outlines, transcripts, density), navigator, scale bar, axes, volume z-handle |
| `implementations/spatial-data-http/` | Optional reference `SpatialDataPort` adapter and wire decoders for the example server's format |
| `implementations/base-store-visualizer.ts` | Abstract base that forwards the region/display API to the stores; OSD and napari extend it |
| `implementations/simple-slice-access.service.ts` | Per-slice URL loading for non-tiled stacks (OSD and napari) |
| `store/` | `VisualizerStore`, `RegionStore`, `SpatialSelectionStore`, class-colour helpers |
| `models/` | Neutral data: `region.ts`, `geometry.ts`, `bezier.ts`, `shape.ts`, `class-preset.ts` |
| `visualizer.component.ts` | `<visualizer>`: render pipeline, plot-type selector, dialogs, toast outlets |
| `render-orchestrator.ts` | Two-pass render (small tier first, then the large tier, one retry) and the slice scrubber |
| `toolbar/` | `<plotting-toolbar>` (internal) and the tool services: `brush/`, `wand/`, `vertex-eraser/`, `zoom-to-box/`, `crop/`, `segmentation/` (SAM box/point, cellpose, ONNX session + worker, model registry, ORT config) |
| `plot-mode/` | `PlotModeController`: lifecycle of contributed plot modes |
| `region-editor/` | `<region-editor>` and mask export (`mask-raster.ts`, `mask.worker.ts`) |
| `region-ops.service.ts` | Merge / inverse / ungroup through the wand mask pipeline |
| `channel-histogram/` | `<channel-histogram>`, the Channels & Histogram dialog |
| `spatial/` | Pure spatial-omics logic: encoding, selection, tiles/LOD planning, density, expression, hover, sections, t-SNE |
| `spatial-controls/` | `<spatial-controls>` and `<spatial-charts>` (UI only) |
| `hex-color-picker/` | `<hex-color-picker>` |
| `processing/` | `ProcessingImage`, `cropImage`, `ImageConverterService` (public utilities) |
| `plot.utilities.ts` | `COLORMAP_OPTIONS`, Plotly config, GeoJSON helpers |
| `toast-outlets.ts` | The library's toast keys |
| `provide-visualization.ts` | `provideVisualization()` for an isolated viewer |
| `testing/` | Jest-only: the napari-js stub and port stubs |
| `assets/` | Toolbar SVGs, colormap PNGs (`icons/`), `colormap-luts.json` |

## How a host connects

`VisualizationModule` declares the components and binds the three contract
tokens to `RoutingVisualizerService` with `useExisting`. The backends and
stores are `providedIn: 'root'`, so one app shares one viewer by default.
`provideVisualization()` re-provides the chain at component scope for a second,
isolated viewer (a modal over the main view, for example). It does not yet
cover every stateful service (CORE-6 in the 0.8.3 review).

| Token | Required | Notes |
|---|---|---|
| `IMAGE_STATE_PORT` | yes | Current image and image list |
| `TILE_ACCESS_PORT` | yes | Tile descriptors, tiles, preview/slice data; used by all three backends |
| `REGION_IO_PORT` | yes, for `<region-editor>` | GeoJSON import/export |
| `VIZ_CONFIG` | yes | `slideCropServer`, `useNapariRenderer`, … |
| `PREFERENCES_PORT` | no | Persists class presets |
| `SPATIAL_DATA_PORT` | no | Without it the spatial plot types are hidden |
| `CELL_SEGMENTER` | no | Defaults to `CellposeSegmenterService` (lazy `cellpose-js`) |
| `TOOLBAR_TOOLS`, `PLOT_TYPE_CONTRIBUTIONS` | no | Multi-providers for contributed tools and plot modes |

The host also supplies `HttpClient`, animations, PrimeNG's `MessageService` and
`ConfirmationService`, the PrimeNG/primeicons/primeflex CSS, and serves
`src/lib/assets` at `assets/plotting/`. See
[guides/host-integration.md](./guides/host-integration.md).

## Routing

`RoutingVisualizerService` chooses a backend per plot type and falls back when
one fails to load:

| Plot type | Backend chain |
|---|---|
| `IMAGE` | OSD → Plotly (napari → OSD → Plotly when `VizConfig.useNapariRenderer`) |
| `NAPARI_IMAGE`, `NAPARI_SCATTER`, `SPATIAL_OMICS` | napari → OSD → Plotly |
| napari 3D types, `SPATIAL_OMICS_3D` | napari → Plotly |
| everything else (heatmap, contour, scatter, surface, scatter 3D, isosurface) | Plotly |

Viewport, zoom, tool and region calls go to the backend that rendered last.
Some calls always go to Plotly (plot-type descriptors, the autoscale event, the
intensity-profile stream). The spatial controls and selection are implemented
in the router itself on top of `SpatialSelectionStore` and `spatial/`.

## The `IVisualizer` contract and capability gating

`IVisualizer` (`contracts/visualizer.contract.ts`) combines rendering, the
region store API, tool control, display options and intensity sampling, plus
nullable accessors for optional feature panels: `getIsosurfaceControls()`,
`getIntensityControls()`, `getSurface3dControls()`, `getSpatialControls()`,
`getPlotModeViewport()`. A `null` means "this backend does not offer it", and
the UI hides the panel.

Plot types gate themselves through their descriptor flags (`requiresStack`,
`requiresGrayscale`, `requiresSpatialData`, `requiresSpatial3d`).
`ViewerCapabilities` (`capabilities.contract.ts`) also exists, but the router
reports Plotly's set and the component reads it only to hide 3D descriptors,
so the descriptor flags and the nullable accessors are the gating that matters.

## Stores

- **`RegionStore`**: the single source of truth for regions. It holds the
  per-image region cache, id minting, selection, undo/redo, the per-slice
  (z-stack) mode and `regionUpdate$`. Every tool and backend writes through it,
  so regions survive a backend switch.
- **`VisualizerStore`**: the view session. It holds the colormap and reverse
  flag, image metadata, per-channel display state, class presets, the active
  tool and the spatial view state. It also loads `assets/plotting/colormap-luts.json`.
- **`SpatialSelectionStore`**: the selected-observation mask for spatial omics.

`BaseStoreVisualizer` forwards the region and display parts of `IVisualizer` to
these stores for OSD and napari. Plotly delegates to the same `RegionStore`
without extending the base.

## Regions and overlays

`models/region.ts` defines `Region` with `bounds` of `Rectangle | Polygon |
MultiPolygon`. A `Polygon` can be closed or open (a polyline), Bézier, and have
`holes`. A region carries an optional zero-based slice `z`, which GeoJSON maps
to QuPath's `geometry.plane.z`. `hydrateBounds()` turns parsed JSON back into
class instances, because overlays and the store use `instanceof`.

Each backend implements `IRegionOverlay` (`contracts/region-overlay.contract.ts`:
`setMode`, `redraw`, `setSelectedBezier`, `destroy`):

- **OSD** (`osd/osd-region-overlay.ts`): an SVG layer aligned to the viewport.
- **napari** (`napari-js/napari-region-overlay.ts`): an SVG layer over the
  canvas, mapped with `canvasToWorld`/`worldToCanvas`. It is also used for the
  3D lasso.
- **Plotly** (`plotly/plotly-region-overlay.ts`): maps modes to Plotly drag
  modes and draws layout shapes. It has no Bézier editing, and holes draw as the
  filled exterior.

`region-ops.service.ts` implements merge, inverse and ungroup by rasterizing
through the wand's mask pipeline.

## Toolbar tools and contributions

Built-in tools are root services under `toolbar/`: wand, brush, vertex eraser,
zoom-to-box, SAM box prompt, SAM point prompt and the cellpose tool. They reach
the canvas through `ICoordinateTransform` / `IViewportHost`. The intensity line
profile is part of `PlotlyService` (`kind: 'profile'` regions).

Other packages add tools on `TOOLBAR_TOOLS`. A tool is either a parameter
dialog that runs once, or a dialog tool (`kind: 'dialog'`) with its own session
and a plain-DOM body. Plot modes are added on `PLOT_TYPE_CONTRIBUTIONS`, run by
`PlotModeController`, and ride on a built-in `baseType`. See
[guides/plot-type-contributions.md](./guides/plot-type-contributions.md) and
[guides/dialog-tools.md](./guides/dialog-tools.md).

## Workers

| Entry | Created by |
|---|---|
| `region-editor/mask.worker.ts` | `region-editor/mask-worker.ts` |
| `toolbar/segmentation/onnx-sam.worker.ts` | `toolbar/segmentation/onnx-sam-session.ts` |
| `spatial/tsne.worker.ts` | `spatial/tsne-worker.ts` |

Each is created with `new Worker(new URL('./x.worker', import.meta.url), { type: 'module' })`
from a small factory module, which jest mocks so ts-jest never compiles
`import.meta.url`. ng-packagr keeps the URL references but does not emit the
worker bodies, so `scripts/bundle-workers.mjs` runs after it. It esbuilds each
worker to `dist/fesm2022/<name>.worker.js`, next to the FESM that references it.
npm dependencies stay as bare imports for the consumer's bundler, except
`@jax-js/jax`, which is inlined into the t-SNE worker: its dynamic imports would
force code-splitting, which Vite's IIFE worker builds reject. The script fails
the build if a dynamic `import()` survives.

## Spatial omics

- **Data:** `SPATIAL_DATA_PORT` (`contracts/ports/spatial-data.port.ts`) is lazy:
  metadata is loaded once and each column or gene vector arrives on demand.
  `SpatialDataHttpService` is an optional adapter for the example server; a
  host with its own backend implements the port directly.
- **Logic:** `spatial/` is framework-free: encodings, selection, LOD planning,
  density, t-SNE.
- **UI:** `spatial-controls/` holds the controls dialog and the linked charts.
- **Rendering:** napari draws the observations in 2D and 3D.
  `napari-spatial-tiles.ts` runs the camera-driven tile loop for cell outlines,
  transcripts and the density map.

See [guides/spatial-omics.md](./guides/spatial-omics.md).

## The napari-js boundary

Only `implementations/napari-js/` imports `napari-js` (a regular dependency,
`^0.14.0`). SIV uses its `Viewer` and layer types (image, volume, surface,
points, 3D points, axes, shapes, tiled sources), the multichannel views, the
colormap helpers and the projection/picking helpers. Rendering concerns that
are generic, such as tile pyramids, picking and per-point colour, belong in
napari-js. SIV keeps a workaround only until napari-js provides the feature.

## Testing

- Jest with `jest-preset-angular`. The setup file is `src/test-setup.ts`
  (canvas mock, polyfills). `npm run test:coverage` enforces a coverage floor.
- `napari-js` needs WebGPU and ships ESM only, so `moduleNameMapper` swaps in
  `src/lib/testing/napari-js-stub.ts`. Specs type-check against the real
  `.d.ts` but run against the stub. When you use a new napari-js API, extend
  the stub too.
- `src/lib/testing/viz-port-stubs.ts` provides no-op ports for component specs.
- The example tile server has its own `node:test` suite (`npm run test:server`).

## Conventions

- **Supersession:** async work (loads, scrubs, tile fetches, spatial rebuilds)
  is guarded by monotonic tokens. Work whose token is no longer current must
  not touch state.
- **Assets:** code references `assets/plotting/…`, and the host serves
  `src/lib/assets` there. onnxruntime-web sidecars default to `/assets/ort/`
  (`setOrtWasmBase()` overrides that).
- **Toasts:** the library owns its toast keys and `<visualizer>` renders their
  outlets, so a host must not render outlets with the same keys.
- **Lazy loading:** cellpose-js, the SAM session and the workers load on first
  use.
- **DOM ids:** use per-instance ids, never a static id, so that two viewers can
  coexist.
