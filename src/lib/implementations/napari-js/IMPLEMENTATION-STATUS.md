# napari-js backend: architecture and known gaps

The WebGPU backend of `sci-image-visualizer`, built on
[`napari-js`](https://github.com/TheJacksonLaboratory/napari-js) (`^0.14.0`, a runtime
dependency). It is one `IVisualizer` implementation next to OSD and Plotly, selected by the
`napari-*` plot types (`NAPARI_IMAGE`, `NAPARI_SCATTER`, `NAPARI_SURFACE`, `NAPARI_SCATTER3D`,
`NAPARI_VOLUME`, `NAPARI_ISOSURFACE`) and by the spatial-omics 2D/3D views.

## Files

| File | Role |
|---|---|
| `napari-visualizer.service.ts` | The backend: viewer lifecycle, image / volume / surface / scatter scenes, spatial 2D and 3D scenes, display state, tool hosts, readback. |
| `napari-region-overlay.ts` | SVG region overlay over the canvas: draw, select, marquee, move / resize, vertex and bezier-handle editing, holes, multi-part regions. Writes to the shared `RegionStore`. |
| `napari-spatial-tiles.ts` | Camera-driven level-of-detail layers of the 2D spatial view: cell outlines, transcripts, transcript density. |
| `napari-navigator.ts`, `napari-scale-bar.ts`, `napari-axes-labels.ts` | Overlay chrome: minimap, physical scale bar, 3D axis labels. |
| `napari-volume-z-handle.ts` | Drag handle that restretches a volume's Z. |
| `napari-spatial-tooltip.ts`, `napari-loading-badge.ts` | Spatial hover tooltip; "… reloading" badge. |
| `napari-zoom.ts` | Wheel-zoom speed derived from OSD's step, so both backends zoom alike. |

## Testing

Jest cannot load napari-js (ESM-only, needs WebGPU), so `jest.config.ts` maps `napari-js` to
`src/lib/testing/napari-js-stub.ts`. Specs type-check against the real `.d.ts` and run against
the stub; `napari-js-stub.conformance.spec.ts` checks the stub's shapes against the real types
and lists the remaining deviations. Replace the stub when napari-js ships a headless
`./testing` entry.

## Known gaps

Tracked in the code review (`sci-image-visualizer-review.md`, #45):

- **Gamma convention.** OSD applies `t^(1/γ)`, napari-js `t^γ`, and they invert in a different
  order (NAPARI-BOUNDARY-2).
- **3D lasso offset.** The 3D screen-space adapter returns canvas-local px from
  `worldToCanvas`, while `OverlayViewer` expects client px (NAPARI-BOUNDARY-6).
- **Needs napari-js APIs:** `LayerList.move` (layer reorders re-upload GPU buffers,
  NAPARI-BOUNDARY-11), flat `Float32Array` point colours (NAPARI-BOUNDARY-12), per-point
  symbols (NAPARI-BOUNDARY-25), per-shape colours (NAPARI-BOUNDARY-27), GPU density windowing
  (NAPARI-BOUNDARY-28).
- **SAM** embeds the displayed viewport at screen resolution, as on OSD: zoom in to segment
  small features.
