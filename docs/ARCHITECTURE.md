# Architecture

A map of `src/lib` for contributors: how a host plugs in, which layer owns what,
and where each backend, store, tool and worker lives. It describes the code as
it is; the plans that shaped it are in [`history/`](./history/), and design
records for individual features are in [`design/`](./design/).

The only public entry point is [`src/index.ts`](../src/index.ts). Everything
else under `src/lib/` is internal, even when it is exported from its own file.

Two Mermaid diagrams draw the same picture:
[`diagrams/siv-architecture.mmd`](./diagrams/siv-architecture.mmd) (host, contracts,
router, backends, data) and [`diagrams/siv-regions.mmd`](./diagrams/siv-regions.mmd)
(region interfaces, overlays and tools).

## Layers

```
host app
  │  imports the standalone components + provideVisualization() (deprecated: VisualizationModule)
  │  provides the ports: IMAGE_STATE_PORT, TILE_ACCESS_PORT, REGION_IO_PORT, VIZ_CONFIG, …
  ▼
components         <visualizer> · <region-editor> · <channel-histogram> · <spatial-controls> · …
  │  inject only the contract tokens: VISUALIZER, REGION_EDITOR_API, CHANNEL_HISTOGRAM_API
  ▼
RoutingVisualizerService      implements all three tokens; picks a backend (IViewerBackend) per plot
                              type; serves region/display state from the stores
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
implementations, `spatial/`, stores, toolbar or components, and fails `npm run lint`
when it does. The one exemption is `cell-segmenter.contract.ts`, whose token factory
defaults to `CellposeSegmenterService`. Pure data types live in the contracts for
that reason: `SpatialSelectionMask` is in `spatial-dataset.contract.ts`, not
`spatial/`.

## `src/lib` layout

| Path                                             | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/`                                     | Interfaces and DI tokens: `visualizer.contract.ts` (`IVisualizer` for hosts, `IViewerBackend` for backends with capability getters, `VISUALIZER`), `capabilities.contract.ts`, `plot-type.ts` (`PlotType`, descriptors), `region-overlay.contract.ts`, `region-store.contract.ts`, `coordinate-transform.contract.ts`, `toolbar-tool.contract.ts`, `plot-type-contribution.contract.ts`, `viz-config.ts`, the segmenter contracts, `spatial-dataset.contract.ts`, `display-types.ts`, `colormap-lut.ts`, `intensity.ts` |
| `contracts/ports/`                               | What the host implements: `image-state`, `tile-access`, `region-io`, `preferences`, `spatial-data`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `routing-visualizer.service.ts`                  | The composition-root service behind `VISUALIZER` / `REGION_EDITOR_API` / `CHANNEL_HISTOGRAM_API`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `implementations/osd/`                           | OpenSeadragon backend: a coordinator service over `OsdSimpleSource`, `OsdTileRecolorer`, `OsdViewportAdapter`, `OsdNavigatorChrome`, `buildViewerOptions`, tile source / export / readback modules; SVG region overlay, slice cache, display pipeline, histogram sampler, scale bar                                                                                                                                                                                                                                     |
| `implementations/plotly/`                        | Plotly backend: a coordinator service over `plotly-layouts`, trace builders, `PlotlyShapeProjection` (follows `RegionStore`), `PlotlyZoomController`, `PlotlyIsosurfaceControls`, `PlotlyImageLoader`, readback; omics chart builders (public)                                                                                                                                                                                                                                                                          |
| `implementations/napari-js/`                     | WebGPU backend: a coordinator service that mounts one `NapariScene` per plot (`napari-*-scene.ts`: image 2D, volume, surface, scatter, spatial 2D/3D) over `NapariTileClient`, `NapariDisplayState`, `NapariToolBridge`, `SpatialHover`, `Axes3dGizmo`; `region-overlay/` (gesture controller + SVG renderer), `spatial-tiles/` (the LOD loop's collaborators behind `NapariSpatialTileLayers`), navigator, scale bar, axes, volume z-handle. See its `IMPLEMENTATION-STATUS.md`                                        |
| `implementations/tile-server/`                   | The jit-service client shared by OSD and napari: descriptor poll, tile URLs, native histogram, TIFF export, auth transport                                                                                                                                                                                                                                                                                                                                                                                              |
| `region-overlay/`                                | Backend-neutral region geometry, hit tests and the world-space `SvgRegionRenderer` both SVG overlays use                                                                                                                                                                                                                                                                                                                                                                                                                |
| `overlays/`                                      | `scale-bar-core.ts` behind the OSD and napari scale bars                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `intensity/`                                     | `IntensityProfileService`: intensity-profile lines and their own sampling frames, for every backend                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `implementations/spatial-data-http/`             | Optional reference `SpatialDataPort` adapter and wire decoders for the example server's format                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `implementations/base-store-visualizer.ts`       | Abstract base that forwards the region/display API to the stores; OSD, napari and Plotly extend it                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `implementations/simple-slice-access.service.ts` | Per-slice URL loading for non-tiled stacks (OSD and napari)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `store/`                                         | `VisualizerStore`, `SpatialSelectionStore`, and `RegionStore` (copy-on-write façade over `RegionHistory`, `RegionSelection`, `RegionScopeCache`), class-colour helpers                                                                                                                                                                                                                                                                                                                                                  |
| `models/`                                        | Neutral data: `region.ts`, `geometry.ts`, `bezier.ts`, `shape.ts`, `class-preset.ts`, `polygon-factory.ts` (the one place `Polygon`/`Region` are built), `polygon-edit.ts` (copy-on-write edits), `region-clone.ts`, `region-geojson.ts`, `svg-path.ts`                                                                                                                                                                                                                                                                 |
| `geometry/`                                      | Pure, worker-safe geometry: `ring.ts` (bounds, containment with holes, vertex dropping, simplification), `raster.ts` (polygon rasterization, `BBoxMask` set operations), `contour.ts` (mask or label map → polygons with holes)                                                                                                                                                                                                                                                                                         |
| `util/`                                          | Framework-free helpers shared across areas: `supersede.ts` (`Supersede`, latest-wins with an `AbortSignal` per task)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `visualizer.component.ts` + `visualizer/`        | `<visualizer>`: inputs/outputs, toasts, slice navigation and dialogs; its collaborators live in `visualizer/` (`RegionActions`, `ViewerShortcuts`, `ToolModes`, `SpatialDatasetBinder`, context menu, ROI import) plus `render-session.ts` (`ImageRenderSession`), `intensity-inset/`, `plot-mode/contribution-host.ts`                                                                                                                                                                                                 |
| `render-orchestrator.ts`                         | Two-pass render (small tier first, then the large tier, one retry) and the slice scrubber                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `toolbar/`                                       | `<plotting-toolbar>` (internal; split into plot-type, stack, view, region-tool, segmentation and help children) and the canvas tools (plain `ICanvasTool` classes per backend): `brush/`, `wand/`, `vertex-eraser/`, `zoom-to-box/`, `crop/`, `segmentation/` (SAM box/point over one `SamSessionService`, cellpose, ONNX session + worker, model registry with per-model cache revisions, ORT config)                                                                                                                  |
| `toolbar/tool-kit/`                              | What the on-canvas tools share: `ToolOverlayCanvas` (pointer overlay lifecycle), `MaskStrokeEditor` (the wand/brush stroke accumulator), `MatrixFrame` (data ↔ readback-matrix coordinates), `UndoGesture` (one drag = one undo step), `AsyncToolStatus`                                                                                                                                                                                                                                                                |
| `plot-mode/`                                     | `PlotModeController`: lifecycle of contributed plot modes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `region-editor/`                                 | `<region-editor>` and its OnPush children (table, classes panel, dialogs, help), `MaskExportService`, `RegionPersistenceService`, mask export (`mask-raster.ts`, `mask.worker.ts`)                                                                                                                                                                                                                                                                                                                                      |
| `region-ops.service.ts`                          | Merge / inverse / ungroup through the pure `geometry/` raster and contour modules                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `channel-histogram/`                             | `<channel-histogram>`, the Channels & Histogram dialog                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `spatial/`                                       | Pure spatial-omics logic: encoding, selection, tiles/LOD planning, density, expression, heatmap, hover, sections, `stats.ts` (quantiles, percentile windows), t-SNE                                                                                                                                                                                                                                                                                                                                                     |
| `workers/`                                       | `spatial-math.worker.ts` and its client `spatial-math.ts`: async, off-main-thread versions of the spatial field and density math                                                                                                                                                                                                                                                                                                                                                                                        |
| `spatial-controls/`                              | `<spatial-controls>` (a dialog shell over key, cells, groups, transcripts, gene-tree, marker-genes and observations panels) and `<spatial-charts>` (over `ChartDataModel`, `PlotlyChartHost`, `EmbeddingComputeCoordinator`, chart help); UI only                                                                                                                                                                                                                                                                       |
| `hex-color-picker/`                              | `<hex-color-picker>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `processing/`                                    | `ProcessingImage`, `cropImage`, `ImageConverterService` (public utilities)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `plot.utilities.ts`                              | `COLORMAP_OPTIONS`, Plotly config, GeoJSON helpers                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `toast-outlets.ts`                               | The library's toast keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `provide-visualization.ts`                       | `provideVisualization()`: the viewer chain, app-wide or per component                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `testing/`                                       | Jest-only: the napari-js stub and port stubs                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `assets/`                                        | Toolbar SVGs, colormap PNGs (`icons/`), `colormap-luts.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `styles/`                                        | `viz-icons.scss`: the global toolbar/context-menu icon rules, shipped for hosts (the component emits the same rules from `_viz-icons-rules.scss`)                                                                                                                                                                                                                                                                                                                                                                       |

## How a host connects

Every component is standalone and `OnPush`. A host imports the components it uses and adds
`provideVisualization()`: in `bootstrapApplication` providers it binds the one app-wide chain;
in a component's providers it re-provides the chain at that scope for a second, isolated
viewer (a modal over the main view, for example). The deprecated `VisualizationModule` is a
re-export shim for NgModule hosts that binds the three contract tokens to
`RoutingVisualizerService` at root, as before. The backends and stores are
`providedIn: 'root'`, so without `provideVisualization()` one app shares one viewer. It lists every
stateful service of the chain (router, backends, stores, the tool services) and
binds the three tokens at that scope; `provide-visualization.spec.ts` fails when a
new stateful `@Injectable` is neither listed nor allow-listed as deliberately shared.

The mounted `<visualizer>` hands the host a small typed `VisualizerHandle`
through `ImageStatePort.setDiagram()` (the chain's `IVisualizer`, `hasRegions()`,
`getRegionPolygons()`), and clears it with `setDiagram(null)` on destroy. Hosts
that can inject the tokens need not use it.

| Token                                      | Required                   | Notes                                                                   |
| ------------------------------------------ | -------------------------- | ----------------------------------------------------------------------- |
| `IMAGE_STATE_PORT`                         | yes                        | Current image and image list                                            |
| `TILE_ACCESS_PORT`                         | yes                        | Tile descriptors, tiles, preview/slice data; used by all three backends |
| `REGION_IO_PORT`                           | yes, for `<region-editor>` | GeoJSON import/export                                                   |
| `VIZ_CONFIG`                               | yes                        | `slideCropServer`, `useNapariRenderer`, …                               |
| `PREFERENCES_PORT`                         | no                         | Persists class presets                                                  |
| `SPATIAL_DATA_PORT`                        | no                         | Without it the spatial plot types are hidden                            |
| `CELL_SEGMENTER`                           | no                         | Defaults to `CellposeSegmenterService` (lazy `cellpose-js`)             |
| `TOOLBAR_TOOLS`, `PLOT_TYPE_CONTRIBUTIONS` | no                         | Multi-providers for contributed tools and plot modes                    |

The host also supplies `HttpClient`, animations, PrimeNG's `MessageService` and
`ConfirmationService`, the PrimeNG/primeicons/primeflex CSS, and serves
`src/lib/assets` at `assets/plotting/`. It may also include the shipped
`src/lib/styles/viz-icons.scss` to define the icon classes globally up front. See
[guides/host-integration.md](./guides/host-integration.md).

## Routing

`RoutingVisualizerService` chooses a backend per plot type and falls back when
one fails to load:

| Plot type                                                                    | Backend chain                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `IMAGE`                                                                      | OSD → Plotly (napari → OSD → Plotly when `VizConfig.useNapariRenderer`) |
| `NAPARI_IMAGE`, `NAPARI_SCATTER`, `SPATIAL_OMICS`                            | napari → OSD → Plotly                                                   |
| napari 3D types, `SPATIAL_OMICS_3D`                                          | napari → Plotly                                                         |
| everything else (heatmap, contour, scatter, surface, scatter 3D, isosurface) | Plotly                                                                  |

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
these stores for all three backends. Plotly overrides the few members that also
redraw its own shapes or colour scale (`setRegions`, selection, delete,
`setColormap`, `setReverseScale`, `exportRegions`).

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
through the wand's mask pipeline. All rasterizing and contour tracing goes
through `geometry/` (`raster.ts`, `contour.ts`, `ring.ts`), which the mask-export
worker imports too.

## Toolbar tools and contributions

Built-in tools live under `toolbar/`. The on-canvas tools (wand, brush, vertex
eraser, zoom-to-box, SAM point prompt) are plain classes implementing
`ICanvasTool`: each backend builds its own set in a `CanvasToolManager`
(`toolbar/canvas-tools.ts`) over one `CanvasToolHost` of its own, and
`IToolController.setActiveTool(id, options)` arms one of them (the per-tool
`setXMode` setters are deprecated wrappers). `BaseStoreVisualizer` implements
those controls once; a backend only gates pan/zoom and its pixel readback in
`beforeToolChange`. The SAM box prompt and the cellpose tool are chain-scoped
services that take the backend's host per run, and the SAM point tools report
through the chain's `SamPointToolService`. The tools reach the canvas through
`ICoordinateTransform` / `IViewportHost`, and share the `toolbar/tool-kit/`
pieces: one pointer overlay for the canvas tools, one stroke accumulator for wand
and brush, one data ↔ matrix frame, one pixel accessor for nested or packed RGBA
frames (`frame-pixels.ts`), and `UndoGesture`, which wraps a drag in
`RegionStore.beginGesture()`/`endGesture()` so it is one undo step.
The SAM tools share one model session (`SamSessionService`), root-provided so
every viewer chain, including a component-scoped one, reuses one model download
and Worker; provided at a viewer component instead, it is disposed with it. The intensity line
profile is part of `PlotlyService` (`kind: 'profile'` regions).

Other packages add tools on `TOOLBAR_TOOLS`. A tool is either a parameter
dialog that runs once, or a dialog tool (`kind: 'dialog'`) with its own session
and a plain-DOM body. Plot modes are added on `PLOT_TYPE_CONTRIBUTIONS`, run by
`PlotModeController`, and ride on a built-in `baseType`. See
[guides/plot-type-contributions.md](./guides/plot-type-contributions.md) and
[guides/dialog-tools.md](./guides/dialog-tools.md).

## Workers

| Entry                                     | Created by                                                          |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `region-editor/mask.worker.ts`            | `region-editor/mask-worker.ts`                                      |
| `toolbar/segmentation/onnx-sam.worker.ts` | `toolbar/segmentation/onnx-sam-session.ts`                          |
| `spatial/tsne.worker.ts`                  | `spatial/tsne-worker.ts`                                            |
| `workers/spatial-math.worker.ts`          | `workers/spatial-math-worker.ts`, through `workers/spatial-math.ts` |

Each is created with `new Worker(new URL('./x.worker', import.meta.url), { type: 'module' })`
from a small factory module, which jest mocks so ts-jest never compiles
`import.meta.url`. ng-packagr keeps the URL references but does not emit the
worker bodies, so `scripts/bundle-workers.mjs` runs after it. It esbuilds each
worker to `dist/fesm2022/<name>.worker.js`, next to the FESM that references it.
npm dependencies stay as bare imports for the consumer's bundler, except
`@jax-js/jax`, which is inlined into the t-SNE worker: its dynamic imports would
force code-splitting, which Vite's IIFE worker builds reject. The script fails
the build if a dynamic `import()` survives.

`workers/spatial-math.ts` is the async API over the spatial worker
(`computeExpressionFieldAsync`, `computeExpressionVolumeAsync`,
`rasterizeDensityAsync`, `computeHeatmapMatrixAsync`). A call runs in the worker
above `SPATIAL_MATH_WORKER_MIN_OBSERVATIONS` and on the main thread below it, where
`Worker` does not exist (jsdom) or when the worker fails; the answer is the same
either way. It takes an `AbortSignal`. The napari scenes (gene maps, density volumes) and
the charts' heatmap call it.

## Spatial omics

- **Data:** `SPATIAL_DATA_PORT` (`contracts/ports/spatial-data.port.ts`) is lazy:
  metadata is loaded once and each column or gene vector arrives on demand.
  `SpatialDataHttpService` is an optional adapter for the example server; a
  host with its own backend implements the port directly.
- **Logic:** `spatial/` is framework-free: encodings, selection, LOD planning,
  density, expression, heatmap, t-SNE. The heavy field and density math also has
  an async, worker-backed form in `workers/spatial-math.ts`.
- **UI:** `spatial-controls/` holds the controls dialog and the linked charts.
- **Rendering:** napari draws the observations in 2D and 3D.
  `napari-spatial-tiles.ts` coordinates the camera-driven tile loop for cell outlines,
  transcripts and the density map; its collaborators are in `napari-js/spatial-tiles/`.

See [guides/spatial-omics.md](./guides/spatial-omics.md).

## The napari-js boundary

Only `implementations/napari-js/` imports `napari-js` (a regular dependency,
`^0.14.0`). SIV uses its `Viewer` and layer types (image, volume, surface,
points, 3D points, axes, shapes, tiled sources), the multichannel views, the
colormap helpers and the projection/picking helpers. Rendering concerns that
are generic, such as tile pyramids, picking and per-point colour, belong in
napari-js. SIV keeps a workaround only until napari-js provides the feature.

## Shared modules in progress

The 0.8.3 review (§4.4) lists cross-backend duplicates to fold into shared
modules. Done so far: `geometry/`, `models/polygon-factory.ts`, `toolbar/tool-kit/`,
`SamSessionService`, `spatial/stats.ts`, `util/supersede.ts`, the auto-window in
`contracts/intensity.ts` (`autoWindowFromHistogram`, used by the router and the
channel histogram) and the spatial-math worker. Being added alongside this
revision, and described here once they land:

- `implementations/tile-server/`: one client for the tile protocol (descriptor
  poll, tile URL, native histogram, TIFF export, authenticated fetch) for the OSD
  and napari backends.
- `overlays/scale-bar-core.ts`: the scale-bar math and DOM shared by the OSD and
  napari scale bars.
- `contracts/color.ts`: one CSS/hex colour parser for spatial, contracts, OSD,
  the picker, the controls and the class colours.

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
  is latest-wins: work that is no longer current must not touch state. New code
  uses `util/supersede.ts`: one `Supersede` per async concern, `next()` before the
  first await, `task.isCurrent()` after each one, and `task.signal` passed to
  whatever is awaited (`fetch`, a worker call, `IDataRenderer.load(info, z, signal)`)
  so superseded work stops at the source; `cancel()` on teardown or a dataset switch.
  The spatial controls, charts, the spatial HTTP adapter, the napari scenes and the
  visualizer's render session use it.
- **Assets:** code references `assets/plotting/…`, and the host serves
  `src/lib/assets` there. Component styles inline their own `url()`s at build
  time; `styles/viz-icons.scss` resolves its icons relative to itself. onnxruntime-web sidecars default to `/assets/ort/`
  (`setOrtWasmBase()` overrides that).
- **Toasts:** the library owns its toast keys and `<visualizer>` renders their
  outlets, so a host must not render outlets with the same keys.
- **Lazy loading:** cellpose-js, the SAM session and the workers load on first
  use.
- **DOM ids:** use per-instance ids, never a static id, so that two viewers can
  coexist.
