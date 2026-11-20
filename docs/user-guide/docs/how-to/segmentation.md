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

## Segment every cell with Cellpose-SAM

1. Pan and zoom so the view shows the area to segment.
2. Click ![](../assets/icons/cells.svg){ .siv-icon } **Cellpose-SAM**.

Every cell in the view becomes a region in the class **cell**. Running it again over the same area
replaces the cells it found there before; cells elsewhere stay.

To segment only some areas, draw rectangles (++r++) over them first: Cellpose-SAM then segments inside
each rectangle and replaces it with its cells. Rectangles with no cells found stay in place.

### Set the cell size

Cellpose-SAM works best when cells are about 30 pixels across, so it does not segment the pixels at your
zoom level. It reads the view at full resolution, fetching more detail when you are zoomed out, brings the
cells to that size for the model, and traces their outlines back at full resolution, smoothed. Your view
does not change. Set the diameter close to the real size: a diameter twice too large halves the detail
the model sees.

1. Click <i class="pi pi-chevron-down"></i> next to Cellpose-SAM, then <i class="pi pi-sliders-h"></i>
   **Set cell diameter…**.
2. Set **Cell diameter (µm)** to the typical size of the cells or nuclei (10 µm by default). It is used
   when the image reports its pixel size.
3. For an image without a pixel size, set **Cell diameter (px)** in full-resolution pixels instead.

Set a diameter to 0 to segment the pixels as displayed.

!!! tip
    A large view is segmented in tiles ("Tile 3/8: …" in the progress message), so it takes longer, but
    keeps full detail up to about 6000 × 6000 full-resolution pixels. If the result says to zoom in, the
    view was too large to read at the cells' best scale: zoom in, or draw rectangles. A run can be undone
    in one step with ++ctrl+z++.

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
**Segment** with each model, and **Cellpose-SAM** once. The models stay in the browser cache. Clearing the
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
segmentation group after Cellpose-SAM, with a run button, a model picker
<i class="pi pi-chevron-down"></i> and, for most, <i class="pi pi-sliders-h"></i> **Parameters**. Like Cellpose-SAM,
many of them process the whole current view, so there is nothing to draw first. Their documentation is part of the host application's
guide.
