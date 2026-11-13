# AI segmentation

SIV's segmentation models run in your browser, on your graphics card when possible. Images never leave
your machine. See [AI segmentation](../reference/segmentation.md) for every option and message.

## Outline specific objects with box prompts (SAM)

1. Zoom so the objects are clearly visible and fully on screen.
2. Press ++r++ and draw a rectangle around each object, a little larger than the object.
3. Click ![](../assets/icons/sam-box-prompt.svg){ .siv-icon } **Segment with SAM (box prompt)**.

Each rectangle that produced a mask is replaced by the object's outline (the largest connected piece). The
others stay, so you can adjust them and run again. New regions are in the class **sam**.

## Outline an object with a click (SAM point prompts)

1. Click ![](../assets/icons/sam-point-prompt.svg){ .siv-icon } **SAM point prompts**. The model loads.
2. Click on the object. A preview region appears.
3. Refine it: ++shift++-click (or ++alt++-click) on parts that should be excluded.
4. Press ++enter++ to keep it, or ++esc++ to discard it.
5. Click the next object; every plain click starts a new object.

Click the button again, or press ++s++, to stop.

## Segment every cell in an area with Cellpose

1. Draw one or more rectangles (++r++) over the areas to segment.
2. Click ![](../assets/icons/cells.svg){ .siv-icon } **Segment cells (cellpose-SAM)**.

Each rectangle is replaced by one region per detected cell, in the class **cell**. Rectangles with no
cells found stay in place.

!!! tip
    Cellpose processes the rectangle in tiles. Several medium rectangles are easier to review than one huge
    one, and a run can be undone in one step with ++ctrl+z++.

## Pick the right SAM model

1. Click the <i class="pi pi-chevron-down"></i> next to **Segment**.
2. Hover each <i class="pi pi-info-circle"></i> to read the model's size, speed and training domain.
3. Click a model to make it active (a check marks it).

| Your images | Choose |
| --- | --- |
| Fluorescence or brightfield microscopy, speed matters | micro-sam ViT-T (default) |
| Microscopy, accuracy matters | micro-sam ViT-B |
| H&E or other stained histology | patho-sam ViT-B |
| Histology on a slow connection | patho-sam ViT-B (int8) |

The choice applies to both SAM tools. It is not remembered after a reload.

## Speed up repeated segmentation

- SAM encodes the image once and then answers each prompt quickly. Keep the view still between prompts:
  panning or zooming makes SAM encode again.
- The first use of a model downloads it, with a progress bar in the toast. It is then kept in the
  browser's cache, so later sessions start quickly.
- The larger models (ViT-B) use WebGPU when available; without it they are much slower.

## Prepare for working offline or on a slow network

Run each model you need once while you have a good connection: open any image, draw a rectangle and run
**Segment** with each model, and **Cellpose** once. The models stay in the browser cache. Clearing the
browser's site data removes them.

## Get better results

- **Adjust the display first.** The tools read the image as displayed, so improve contrast in Channels &
  Histogram before segmenting faint objects.
- **Zoom in** on small objects: SAM sees the on-screen pixels.
- **Keep rectangles on screen.** Only the visible part of a rectangle is segmented.
- **Clean up** with the vertex eraser or the brush, and remove false detections with ++delete++.
- **Simplify** dense outlines: right-click → **Simplify** → **Light (1 px)**.

## Give segmented regions a meaningful class

Results are in the classes **sam** and **cell**. Select them (++ctrl++-click or ++shift++-click their rows
in the Region Editor, or <i class="pi pi-check-square"></i> **Select all regions** if the image has no other
regions) and follow [Relabel many regions at once](classes.md#relabel-many-regions-at-once).

## Run a contributed tool

Applications can add their own tools (for example detection models in JAX Image Tools). They appear in the
segmentation group with a run button, a model picker <i class="pi pi-chevron-down"></i> and
<i class="pi pi-sliders-h"></i> **Parameters**. Unlike SAM and Cellpose, many of them process the whole
current view, so there is nothing to draw first. Their documentation is part of the host application's
guide.
