# Volume split view — draw on a slice, see it in 3D

> Status: **built** (#50). Builds on #49 (region LOD, the class tree, region surfaces in the volume
> view). Decided with the user: off by default; the slice on the left, 3D on the right.

## The problem

In the Volume and Isosurface plot types the regions can be shown in 3D (as surfaces), picked and
highlighted, but not drawn or edited: the 3D view has no plane to draw on, and its toolbar offers
only the selection tool. The user chose a **side-by-side 2D + 3D** layout: a slice pane with every
region tool next to the 3D volume, both live.

## Where the library stands (read from source)

| Piece              | Today                                                                                                                     | File                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Plot host          | One container, `.viz-plot`, shared by every backend                                                                       | `visualizer.component.html:140`                                                          |
| Backend switch     | `plot()` tears the previous backend down when the plot type changes backend                                               | `routing-visualizer.service.ts:247`                                                      |
| Forwarding         | One pointer, `renderer()` = the backend rendered last: view, tool and overlay calls go to it                              | `routing-visualizer.service.ts:180`                                                      |
| Backends           | OSD, napari and Plotly services are separate instances with their own state: OSD and napari can coexist                   | `implementations/*`                                                                      |
| Slices in a volume | Stack mode is on (the regions are per slice), but the display slice is frozen: no slider, `VolumeScene.setZ()` is a no-op | `visualizer/region-load.ts:54`, `toolbar.component.ts:268`, `napari-volume-scene.ts:314` |
| 2D region editing  | `OsdRegionOverlay`: every tool, on the live (display-slice) regions                                                       | `implementations/osd/osd-region-overlay.ts`                                              |
| 3D surfaces        | Built from every slice's regions (edits included) and the region source's outlines                                        | `RegionStore.classOutlines`                                                              |
| Shared state       | RegionStore (one live slice), VisualizerStore (colours, **active tool**)                                                  | `store/*`                                                                                |

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A "Slice editor" toggle** in the volume view's toolbar splits the plot area; off by default.                                                                                                                                                                                                                                                    | The volume view stays as it is for viewing; the split is for editing. One click, and its state is kept per session.                                                                                                                   |
| D2  | **Two panes, two backends at once**: OSD draws the current slice in a second container (`plotDivName + '-slice'`) beside the napari 3D container, 50/50 with a draggable divider (← / → move it too).                                                                                                                                             | OSD already has every region tool, the region overlay and the region source layer; reusing it means no tool is re-implemented. The services don't share state, so both can be mounted.                                                |
| D3  | **Routing splits by concern**: region, tool and overlay calls (`setActiveTool`, wand, brush, eraser, SAM, `getRegionOverlay`, …) go to the 2D pane; view calls (zoom, fit, reset, colour, export) stay with the 3D pane (`renderer()`). A new `regionBackend()` returns OSD while split, `renderer()` otherwise.                                  | The 2D pane is where regions are edited; the 3D pane is the view the plot type is about. Each pane keeps its own mouse pan/zoom.                                                                                                      |
| D4  | **One slice for both panes**: the slice slider shows while split and sets the OSD slice and the RegionStore's display slice (as in 2D). The 3D view marks the slice with an outlined plane at that depth in the volume box.                                                                                                                       | The 2D pane edits exactly the slice the store holds live, so new regions land on it (`z = displaySlice`). The plane ties what you draw to where it is in 3D.                                                                          |
| D5  | **Surfaces follow the edits**: when the live slice's regions of a class change (an edit or an undo, not a slice switch), that class's cached reconstructions are dropped, and the shown surfaces with it are rebuilt 600 ms after the edits pause (with the loading badge). Each class's regions are fingerprinted to tell which an edit touched. | `classOutlines` already reads every slice's edited regions; only the trigger is missing. Rebuilding on every drag frame would be wasted work. Since #49 caches what the region sources hold, a rebuild reads nothing from them again. |
| D6  | **The selection tool keeps working in both panes**: a click in 2D selects regions; a click on a surface in 3D picks its class (as in #49). Drawing tools act only in 2D.                                                                                                                                                                          | The active tool is shared (VisualizerStore); picking in 3D is select-only already, so no tool conflicts.                                                                                                                              |
| D7  | **Teardown**: leaving the volume plot types, switching image or turning the split off resets the OSD pane; switching image re-plots both.                                                                                                                                                                                                         | Mirrors `plot()`'s own teardown; no orphaned viewer.                                                                                                                                                                                  |

## Out of scope

- Drawing directly in 3D (on a plane in the volume).
- Orthogonal 2D panes (sagittal / horizontal) — the slice pane shows the stack's own sections.
- Syncing the 2D and 3D cameras (pan/zoom in one does not move the other).

## Plan

1. Second container + `p-splitter` in the visualizer; the router mounts OSD into it while split (D1, D2, D7).
2. `regionBackend()` routing; the toolbar's full region tools while split (D3, D6).
3. Slice slider while split; the slice plane in the volume scene (D4).
4. Debounced surface rebuild on edits (D5).
5. Tests (router forwarding while split, slice sync, rebuild trigger); a browser check on the CCFv3 atlas: draw a region on a slice, see its surface.

## As built

- The pane is a plain flex sibling of the plot div with a divider, not a `p-splitter`: the splitter
  wraps its panels in templates, which would re-create the plot div (and the 3D viewer in it) on
  toggling. The plot div keeps its place in the DOM.
- The router mounts OSD in the pane itself (`setSliceEditor(div)`), from the image info and slice
  of the last plot, and re-mounts it for a new image; another plot type takes it down and a volume
  view brings it back while the toggle is on.
- Closing the pane keeps the selection tool (it picks surfaces in 3D) and disarms a drawing tool.
