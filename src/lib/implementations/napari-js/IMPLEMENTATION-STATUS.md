# napari-js backend: architecture and known gaps

The WebGPU backend of `sci-image-visualizer`, built on
[`napari-js`](https://github.com/TheJacksonLaboratory/napari-js) (`^0.14.0`, a runtime
dependency). It is one `IViewerBackend` next to OSD and Plotly, chosen by the router
(`RoutingVisualizerService`) for the `napari-*` plot types (`NAPARI_IMAGE`, `NAPARI_SCATTER`,
`NAPARI_SURFACE`, `NAPARI_SCATTER3D`, `NAPARI_VOLUME`, `NAPARI_ISOSURFACE`), for the spatial-omics
2D/3D views, and for `IMAGE` when `VizConfig.useNapariRenderer` opts in. A failed load falls back
to OSD (2D) or Plotly (3D) for that image.

## Shape

`NapariVisualizerService` is a coordinator: it owns the viewer's lifetime and the routing contract,
and hands everything else to collaborators. Region and display *state* is not here: it lives in
the shared `RegionStore` / `VisualizerStore`, which the router serves to hosts directly; this
backend draws from their events like the others.

```
NapariVisualizerService (viewer lifecycle, load/plot, capability getters)
 ├─ NapariTileClient       server descriptors, tiles, volume assembly, native histograms, TIFF export
 ├─ NapariDisplayState     channel window / gamma / invert / colormap → layer colours
 ├─ NapariToolBridge       canvas tools + region overlay over the viewer (2D and 3D screen space)
 ├─ LoadingBadgeState      what is loading, for the "… reloading" badge
 └─ NapariScene            one per plot(), owns every layer/subscription it creates
     ├─ Image2dScene / ScatterRegionsScene
     ├─ VolumeScene / Scatter3dScene
     ├─ SurfaceScene
     └─ Spatial2dScene / Spatial3dScene  (via SpatialSession)
          └─ NapariSpatialTileLayers (2D tile LOD layers: spatial-tiles/)
```

## Files

| File | Role |
|---|---|
| `napari-visualizer.service.ts` | The backend: viewer lifecycle, `load`/`plot`, the scene per plot type, readback, export, and the capability-gated getters (`getOsdViewOptions`, `getVolumeResolution`, `getIntensitySampling`). |
| `napari-scene.ts` | The `NapariScene` interface, `SceneContext` (what a scene may use) and `NapariSettings`. |
| `napari-image-2d-scene.ts` | The 2D image, alone or under the region-centroid scatter (`NAPARI_IMAGE`, `NAPARI_SCATTER`). |
| `napari-volume-scene.ts` | Volume / isosurface (MIP or iso) and the 3D scatter. |
| `napari-surface-scene.ts` | The slice as a height field (`NAPARI_SURFACE`). |
| `napari-spatial-scene.ts` | `SpatialSession`: the dataset / view-state / selection subscription shared by both spatial scenes. |
| `napari-spatial-2d-scene.ts`, `napari-spatial-3d-scene.ts` | Spatial omics: markers over the tissue image; the 3D point cloud. |
| `napari-spatial-encoding.ts` | Pure colour and grouping math of the spatial scenes. |
| `napari-spatial-hover.ts`, `napari-spatial-tooltip.ts` | Spatial hover / click picking and the cursor tooltip. |
| `napari-spatial-tiles.ts` | Coordinator of the 2D spatial view's camera-driven level-of-detail layers (see `spatial-tiles/`). |
| `napari-tile-client.ts` | Talks to the tile server: descriptors, 2D tiles, volume assembly (decimated by the Resolution control), native >8-bit histograms, TIFF export. |
| `napari-tool-bridge.ts` | The canvas tools' host and the region overlay's viewer adapter, in 2D world space and the 3D view's screen space. |
| `napari-display-state.ts` | Channel display settings → napari layer colours (window → invert → gamma per channel, then an additive merge; gamma converted by `toNapariGamma`). |
| `napari-helpers.ts` | Pure helpers and constants (no viewer, store or network). |
| `napari-loading-state.ts`, `napari-loading-badge.ts` | Loading bookkeeping and the badge. |
| `napari-region-overlay.ts` | SVG region overlay over the canvas: draw, select, marquee, move / resize, vertex and bezier-handle editing, holes, multi-part regions. Writes to the shared `RegionStore` and redraws from its update event. |
| `region-overlay/` | The overlay's pieces: `overlay-projection.ts` (client / svg-local / world coordinates), `region-edit.ts` (a live drag), `region-svg-renderer.ts` (handles and paths). |
| `spatial-tiles/` | The tile layers: `cell-layers.ts` (outlines / fills, with a cached contrast window), `transcript-layers.ts` + `transcript-jobs.ts` (points and their fetch planning), `density-layer.ts`, `transcript-hover.ts`, `categorical-lookup.ts`, `layer-groups.ts`, `plan-context.ts`. |
| `napari-navigator.ts`, `napari-scale-bar.ts`, `napari-axes-gizmo.ts`, `napari-axes-labels.ts` | Overlay chrome: minimap, physical scale bar, 3D axes gizmo and labels. |
| `napari-volume-z-handle.ts` | Drag handle that restretches a volume's Z. |
| `napari-zoom.ts` | Wheel-zoom speed derived from OSD's step, so both backends zoom alike. |

## Contract

- Regions: the router writes the `RegionStore`; the overlay redraws on `getRegionUpdateEvent()`,
  and the canvas tools reset on `getRegionSetReplaced$()` (undo, redo, a slice switch) through
  `BaseStoreVisualizer`.
- Navigator and image smoothing: `getOsdViewOptions()` (the router applies a setting to every
  backend that has these options).
- Resolution control: `getVolumeResolution()` (`{ get, set }`, the 3D decimate factor; takes
  effect on the next load).
- Intensity inset: `getIntensitySampling()` reports where the camera settled; the sampling itself
  is the router's `IntensityProfileService`.

## Testing

Jest cannot load napari-js (ESM-only, needs WebGPU), so `jest.config.ts` maps `napari-js` to
`src/lib/testing/napari-js-stub.ts`. Specs type-check against the real `.d.ts` and run against
the stub; `napari-js-stub.conformance.spec.ts` checks the stub's shapes against the real types
and lists the remaining deviations. Replace the stub when napari-js ships a headless
`./testing` entry. `osd/display-pipeline.cross-backend.spec.ts` checks OSD's display pipeline
against napari-js's own colour functions.

## Known gaps

Tracked in the code review (`sci-image-visualizer-review.md`, #45):

- **RGB mode** ignores the channel window, gamma and invert (OSD's RGB path applies them).
- **Empty window** (min = max): OSD maps every value to 0 before the invert, napari-js steps at
  min.
- **Needs napari-js APIs:** `LayerList.move` (layer reorders re-upload GPU buffers,
  NAPARI-BOUNDARY-11), flat `Float32Array` point colours (NAPARI-BOUNDARY-12), per-point
  symbols (NAPARI-BOUNDARY-25), per-shape colours (NAPARI-BOUNDARY-27), GPU density windowing
  (NAPARI-BOUNDARY-28).
- **SAM** embeds the displayed viewport at screen resolution, as on OSD: zoom in to segment
  small features.
