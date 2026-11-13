# How-to guides

Each how-to guide answers one practical question in a few steps. They assume you know your way around the
viewer; if not, start with the [tutorials](../tutorials/index.md).

| Page | Covers |
| --- | --- |
| [Viewing and display](viewing.md) | Contrast, gamma, colormaps, channels, raw vs smooth pixels, exporting images, the floating toolbar |
| [Drawing and editing regions](regions.md) | Every drawing tool, holes, Bézier curves, merging, inverting, simplifying, undo |
| [Annotation classes](classes.md) | Class presets, sharing them, bulk relabelling, recolouring, class trees |
| [Import and export](import-export.md) | GeoJSON, QuPath, folders of slices, label volumes, OME-Zarr, zip, masks, saving to a server |
| [AI segmentation](segmentation.md) | SAM box and point prompts, choosing a model, Cellpose, model downloads |
| [Stacks and 3D](stacks-3d.md) | Slices, volumes, isosurfaces, the slice editor, Z height, 3D resolution |
| [Spatial omics](spatial-omics.md) | Colouring, gene filters, selecting observations, charts, embeddings, cell groups |

Common questions:

- **How do I make a dim fluorescence channel visible?** [Adjust brightness and contrast](viewing.md#adjust-brightness-and-contrast)
- **How do I outline every cell in an area?** [Segment every cell in an area with Cellpose](segmentation.md#segment-every-cell-in-an-area-with-cellpose)
- **How do I get my annotations into QuPath?** [Round-trip annotations with QuPath](import-export.md#round-trip-annotations-with-qupath)
- **How do I give 50 regions the same class?** [Relabel many regions at once](classes.md#relabel-many-regions-at-once)
- **How do I select the cells inside a region?** [Select observations inside a region](spatial-omics.md#select-observations-inside-a-region)
- **Why did my regions disappear?** See [Troubleshooting](../troubleshooting.md).
