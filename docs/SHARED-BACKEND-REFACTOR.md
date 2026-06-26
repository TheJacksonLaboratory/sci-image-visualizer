# Shared-backend refactor — plan (held)

Status: **NOT started** (deferred). Goal: remove the large block of identical delegation code
duplicated between the OSD and napari-js `IVisualizer` backends by extracting it into a shared
abstract base class they both extend. Pure de-duplication — **no behavior change**.

## Why
`OpenseadragonVisualizerService` and `NapariVisualizerService` both implement the composite
`IVisualizer` (= `IDataRenderer + IRegionStore + IToolController + IDisplayOptions +
IIntensitySampling`). A gap analysis found the `IRegionStore` and `IDisplayOptions` members are
**byte-for-byte identical** in both — each just forwards to the shared `RegionStore` / `VisualizerStore`.
Plotly (`PlotlyService`) overlaps partially but has its own region model, so treat it separately.

## What to extract (identical delegations → base)
These forward verbatim to `this.regionStore` / `this.store` in BOTH backends:

- **IRegionStore (RegionStore):** `setRegions`, `getRegions`, `getRegionPolygons`,
  `getRegionUpdateEvent`, `setSelectedShapeIndices`, `getSelectedShapeIndices$`, `selectRegion`,
  `deleteActiveShape`, `getShowShapeLabel`, `getShapeColor`, `getFillColor`, `plotPreviousShapes`,
  `setPreviousShapes`, `getPreviousShapes`, `undo`, `redo`, `canUndo`, `canRedo`, `getCanUndo$`,
  `getCanRedo$`, `resetUndoHistory`, `importRegions`, `exportRegions`, `getGeoJsonString`.
- **Classification colors (VisualizerStore):** `getClassificationColors`, `setClassificationColor`.
- **IDisplayOptions (VisualizerStore):** `getColormap`, `setColormap`, `getColormapOptions`,
  `getReverseScale`, `setReverseScale`, `setImageMeta`, `getImageMeta`.

## What NOT to extract (backend-specific — stays in each subclass)
`load`/`plot`/`reset`/`relayout`/zoom/`setZIndex`/readback, the region OVERLAY, tool wiring
(`setWandMode`/`setBrushMode`/`setVertexEraserMode`/`setZoomToBoxMode`/SAM/cellpose), histograms,
`getRegionOverlay`/`getIsosurfaceControls`/`getSurface3dControls`/`getIntensityControls`,
`exportComposite`/`exportData`, `setColormap` LUT application, scale bar, tiling, etc.

## Approach
1. Add `abstract class BaseStoreVisualizer` (NOT `@Injectable`) in
   `implementations/base-store-visualizer.ts`, holding the delegations above. Constructor takes the
   two shared stores: `constructor(protected readonly regionStore: RegionStore, protected readonly
   store: VisualizerStore) {}`.
2. Both services `extends BaseStoreVisualizer` and call `super(regionStore, store)` from their
   constructor (they already inject both). Remove the now-inherited methods from each.
3. The class stays `@Injectable` on the subclasses (Angular DI is unaffected by an abstract,
   non-injectable base — the subclass constructor still declares its injected deps and calls super).
4. `implements IVisualizer` stays on the subclasses; the base satisfies the `IRegionStore` +
   `IDisplayOptions` slices structurally.

## Risk / verification
- Mechanical move; fully covered by the existing suite (**718 tests**, incl. the OSD + napari
  region/display delegation specs). Run `nx build/test/lint jax-image-visualization` + `nx build
  jit-ui` (AOT) — all must stay green.
- Touches the **production OSD backend**, so review the diff is a pure move (no signature/behavior
  drift). Do it as one isolated commit so it's easy to audit/revert.

## Est. impact
Removes ~30 duplicated method bodies from each of the two services (~60 fewer lines per file,
single source of truth for store delegation). Plotly left as-is (different region model).
