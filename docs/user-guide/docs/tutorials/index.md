# Tutorials

The tutorials are short guided lessons. Each one starts from an empty viewer and ends with something you
made: a set of classified regions, an AI segmentation, a selection of cells in a spatial-omics dataset. Do
them in order the first time; each takes 10 to 20 minutes.

All tutorials use the [live demo](https://thejacksonlaboratory.github.io/sci-image-visualizer/), which
runs SIV with a gallery of sample images on the left. Nothing needs to be installed. If you use SIV inside
another application (such as JAX Image Tools), the viewer and its toolbar are the same; only the way you
open an image differs.

| Tutorial | You will learn to | Time |
| --- | --- | --- |
| [Tour of the viewer](viewer-tour.md) | Open images, zoom and pan, read the scale bar, adjust contrast and colours, switch plot types | 10 min |
| [Annotate your first image](first-annotation.md) | Draw regions with several tools, edit them, classify them in the Region Editor and export GeoJSON | 20 min |
| [Segment cells with AI](ai-segmentation.md) | Segment objects with SAM box and point prompts, and every cell in an area with Cellpose | 15 min |
| [Explore a spatial-omics dataset](spatial-omics.md) | Colour spots by cluster and gene, select spots from a region, read the distribution charts | 20 min |

!!! tip "Before you start"
    - Use a recent Chrome, Edge or Firefox on a desktop computer. Spatial omics and the 3D plot types draw
      with WebGPU; see [Limits and requirements](../reference/limits.md).
    - A mouse with a scroll wheel makes zooming easier than a trackpad.
    - The AI tutorial downloads models of 14 MB to about 600 MB the first time. A fast connection helps.

When you have finished the tutorials, the [how-to guides](../how-to/index.md) show how to do specific
tasks, and the [reference](../reference/index.md) describes every control.
