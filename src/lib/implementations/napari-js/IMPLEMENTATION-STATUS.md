# napari-js backend: architecture and known gaps

The WebGPU backend of `sci-image-visualizer`, built on
[`napari-js`](https://github.com/TheJacksonLaboratory/napari-js) (`^0.15.0`, a runtime
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
| `napari-image-2d-scene.ts` | The 2D image, alone or under the region-centroid scatter (`NAPARI_IMAGE`, `NAPARI_SCATTER`). Multichannel: one tinted layer per channel (a serverless stack's from its `channelUrls` planes), merged onto black. RGB: the image layer as it is at the default channel states, else its R, G and B bands as three such layers (a tiled image's bands share one `/tile` request per tile). |
| `napari-volume-scene.ts` | Volume / isosurface (MIP or iso) and the 3D scatter. |
| `napari-surface-scene.ts` | The slice as a height field (`NAPARI_SURFACE`). |
| `napari-spatial-scene.ts` | `SpatialSession`: the dataset / view-state / selection subscription shared by both spatial scenes. |
| `napari-spatial-2d-scene.ts`, `napari-spatial-3d-scene.ts` | Spatial omics: markers over the tissue image; the 3D point cloud. |
| `napari-spatial-encoding.ts` | Pure colour and grouping math of the spatial scenes. |
| `napari-spatial-hover.ts`, `napari-spatial-tooltip.ts` | Spatial hover / click and the cursor tooltip. The pick is napari-js's, on the layer each scene drew: `PointsLayer.pick` in 2D (nearest centre within the marker or a 10 px slack), `PointPicker` in 3D (front-most). |
| `napari-spatial-tiles.ts` | Coordinator of the 2D spatial view's camera-driven level-of-detail layers (see `spatial-tiles/`). |
| `napari-tile-client.ts` | Talks to the tile server: descriptors, the `TiledSource`s (2D tiles), whole-slice reads and volume assembly through napari-js's `readLevel` / `assembleVolume` (decimated by the Resolution control), native >8-bit histograms, TIFF export. |
| `napari-tool-bridge.ts` | The canvas tools' host and the region overlay's viewer adapter, in 2D world space and the 3D view's screen space. |
| `napari-display-state.ts` | Channel display settings → napari layer colours (window → invert → gamma per channel, then an additive merge; gamma converted by `toNapariGamma`). |
| `napari-helpers.ts` | Pure helpers and constants (no viewer, store or network). |
| `napari-loading-state.ts`, `napari-loading-badge.ts` | Loading bookkeeping and the badge. |
| `napari-region-overlay.ts` | SVG region overlay over the canvas: draw, select, marquee, move / resize, vertex and bezier-handle editing, holes, multi-part regions. Writes to the shared `RegionStore` and redraws from its update event. |
| `region-overlay/` | The overlay's pieces: `overlay-projection.ts` (client / svg-local / world coordinates), `region-edit.ts` (a live drag), `region-svg-renderer.ts` (handles and paths). |
| `spatial-tiles/` | The tile layers: `cell-layers.ts` (outlines / fills, with a cached contrast window), `transcript-layers.ts` + `transcript-jobs.ts` (points and their fetch planning), `density-layer.ts`, `transcript-hover.ts`, `categorical-lookup.ts`, `layer-groups.ts`, `plan-context.ts`. |
| `napari-axes-gizmo.ts` | The 3D axes gizmo: napari-js's `AxesLayer` and `AxesLabelsOverlay`. The minimap and the scale bars are napari-js's `NavigatorOverlay` and `ScaleBarOverlay` (`napari-js/overlays`), installed by the 2D image and 3D spatial scenes. |
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

Specs run the real napari-js: `jest.config.ts` maps `napari-js` to its GPU-free
`napari-js/testing` entry, where `Viewer` is a `HeadlessViewer` (the real model, layers, framing
and canvas maths, no device; readback is a blank frame). `osd/display-pipeline.cross-backend.spec.ts`
checks OSD's display pipeline against napari-js's own colour functions, and
`napari-image-2d-scene.spec.ts` the 2D image's multichannel and RGB layers against it.

## Known gaps

Tracked in the code review (`sci-image-visualizer-review.md`, #45):

- **Recoloured tiled RGB** (any channel state off its default) draws three additive band layers,
  which have no coarse underlay but the bottom band's: while a pan or zoom loads finer tiles, the
  new area shows that band's coarse level (red), not the blurry colour level the RGB layer shows.
  At the default channel states the RGB layer draws, as before.
- **Empty window** (min = max): OSD maps every value to 0 before the invert, napari-js steps at
  min.
- **napari-js 0.15 APIs not adopted:** the flat-ring `pointInRing`/`ringArea` (SIV's regions
  hold parallel `xs`/`ys`; converting per hit test is not a clean swap), `autoContrastLimits` (its
  window ends at the last kept bin's upper edge, SIV's at its left edge, as ImageJ) and
  `visibleTiles` ordering (the spatial tile grid has its own origin, bounds and per-level tile
  size). Already adopted: whole-slice reads (`readLevel`, `assembleVolume`, `bitmapToScalar`),
  `napari-js/overlays` (scale bars, navigator, axis labels), `napari-js/colormaps` (the colormap
  tree's tables), `floodFill` (wand), `traceContours` and `rasterizePolygon` (every tool's
  mask → outline → mask path: pixel-edge outlines, an exact round trip), `worldViewport`,
  `LayerList.move` (no re-upload on a restack), packed
  point colours, `Points3DLayer.colors` (no 3D category ceiling), `invert` on the 3D layers,
  `Camera3D.worldPerPixel`, `LruCache`, `luminance8`, `Colormap` + `buildLut`, per-point symbols
  (transcript icons, NAPARI-BOUNDARY-25), per-shape `faceColor` (cells, NAPARI-BOUNDARY-27),
  `transparentBelow` (GPU density windowing, NAPARI-BOUNDARY-28), `PointsLayer.pick` and
  `PointPicker` (NAPARI-BOUNDARY-24, NAPARI-SVC-17), `canvasTransform` (region overlay,
  NAPARI-BOUNDARY-10).
- **SAM** embeds the displayed viewport at screen resolution, as on OSD: zoom in to segment
  small features.
