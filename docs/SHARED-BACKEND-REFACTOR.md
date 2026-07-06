# Shared-backend refactor — plan

Status: **DONE** (jit-ui#106, 2026-07-06). The identical store-delegation code that was duplicated
between the OSD and napari-js `IVisualizer` backends now lives in one shared abstract base class,
`implementations/base-store-visualizer.ts`, which both extend. Pure de-duplication — **no behavior
change** (all 803 library tests + 164 app tests still pass; `nx build jit-ui` AOT green).

## Outcome vs. this plan

The plan's method list was written at 718 tests and had drifted from the code — verified each
method against both backends before moving it (`git`-diffed bodies), which changed two things:

- **Extracted the ENTIRE `IRegionStore` and `IDisplayOptions` interfaces** (every member of both is
  a pure forwarder in both backends), plus the two classification-colour members — not just a
  subset. The base `implements IRegionStore, IDisplayOptions` so it stays in lockstep with the
  contract. The apparent "DIFFERS" between backends were all cosmetic (`any` vs `unknown`,
  one-line vs multi-line, `reverscale: any` vs `reverse: boolean`); the base uses the interface's
  canonical signatures, which harmonised them.
- **`setColormap` IS extracted.** This plan's "what NOT to extract" list flagged "setColormap LUT
  application", but that's stale: in current code both backends' `setColormap` is a plain
  `this.store.setColormap(colormap)` delegation. OSD applies its LUT reactively via the
  constructor's colormap subscription, not in `setColormap`, so it moves cleanly.

Everything in the original "what NOT to extract" list below (load/plot/zoom/setZIndex/overlay/tools/
histograms/scale bar/tiling/colormap-LUT subscription) correctly stayed in each subclass.

## Original plan (for reference)

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
