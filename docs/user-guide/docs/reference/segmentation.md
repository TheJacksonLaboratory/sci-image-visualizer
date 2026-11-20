# AI segmentation

SIV can draw regions for you with AI models that run **entirely in your browser**: no image leaves your
computer. The first run of a model downloads it, with a progress bar. It is then cached by the browser, so
later runs start quickly, even offline.

![Segmentation tools and the SAM model picker](../assets/screenshots/seg-tools-group.png)

There are two kinds of tool:

- **Prompted** tools act on what you show them: **Segment** uses the rectangles you draw; **SAM point
  prompts** uses your clicks.
- **No-prompt** tools sweep the whole current view, so there is nothing to draw first: **Cellpose-SAM**
  (which segments inside your rectangles instead if you draw some), and the tools your application may add
  (for example a detection model in JAX Image Tools).

!!! info "What the models see"
    In the Image view, the models read the pixels **as displayed**: the visible part of the image, with
    your brightness, contrast and colours. Only the on-screen part of a rectangle is segmented. Zoom so
    the objects are clearly visible and fill a good part of the view, and set the contrast first.
    Cellpose-SAM with no rectangles is the exception: it reads the view at the resolution its cell
    diameter sets (see [Cellpose-SAM](#cellpose-sam)).

## Segment (SAM box prompt)

![SAM box prompt: rectangles replaced by masks](../assets/screenshots/seg-sam-box.png)

![](../assets/icons/sam-box-prompt.svg){ .siv-icon } **Segment with SAM (box prompt)**:

1. Draw one or more **rectangles** (++r++) around objects.
2. Click **Segment**.
3. Each rectangle that produced a mask is replaced by the outline of the object inside it. Rectangles that
   found nothing stay, so you can adjust them and retry.

New regions get the class **sam**. The image is encoded once; each box is then quick.

## SAM point prompts

![SAM point prompt with an exclude point](../assets/screenshots/seg-sam-points.png)

![](../assets/icons/sam-point-prompt.svg){ .siv-icon } **SAM point prompts** is a tool you switch on:

| Action | Effect |
| --- | --- |
| Click an object | Segments it as a **new** region. Each plain click starts a new object. |
| ++shift++ or ++alt++ + click | Adds an **exclude** point that refines the current object. |
| ++enter++ | Commits the current object. |
| ++esc++ | Removes the current object. |

The model loads when you switch the tool on. Clicks made while it is busy are ignored.

## Choosing the SAM model

Click <i class="pi pi-chevron-down"></i> **Pick the SAM model** next to Segment. The choice applies to both
SAM tools, which share one loaded model. Hover <i class="pi pi-info-circle"></i> beside a model for its size,
speed and domain.

| Model | Best for | Download | Runs on |
| --- | --- | --- | --- |
| **micro-sam ViT-T** (default) | Light microscopy; small and fast | ~14 MB | CPU (WebAssembly) |
| **micro-sam ViT-B** | Light microscopy; highest accuracy | ~172 MB | GPU (WebGPU) |
| **patho-sam ViT-B** | Histopathology (H&E, stained tissue) | ~180 MB | GPU (WebGPU) |
| **patho-sam ViT-B (int8)** | Histopathology on slow connections | ~100 MB | CPU (WebAssembly) |

All are Segment Anything models fine-tuned for biomedical images. They differ in the image encoder (the
heavy step, done once per image) and the training domain; prompting works the same. The first run after
switching model or image downloads and encodes once. The choice is not remembered after a reload.

## Cellpose-SAM

![Cellpose-SAM result: one region per cell](../assets/screenshots/seg-cellpose.png)

![](../assets/icons/cells.svg){ .siv-icon } **Cellpose-SAM** finds every cell in the view:

1. Pan and zoom so the view shows the area to segment.
2. Click **Cellpose-SAM**.
3. Each cell becomes a region with the class **cell**. Cells from an earlier run whose centre lies in the
   segmented area are replaced; cells elsewhere stay.

With rectangles drawn, it segments inside each rectangle instead. Rectangles that produced cells are
removed; the others stay.

The model works best when cells are about 30 pixels across. Cellpose-SAM reads the view at full
resolution (fetching more detail from the server when you are zoomed out, averaging the screen pixels down
when you are zoomed in), brings the cells to that size for the model, and traces the masks back at full
resolution with smoothed outlines. Your zoom does not change. A large view is processed in overlapping
tiles; a cell on a seam between tiles is kept once. Views up to about 6000 × 6000 full-resolution pixels
keep full detail; beyond that, or when very small cells over a large view would need more than the model's
budget, the view is segmented below the cells' best scale and the result says so.

<i class="pi pi-chevron-down"></i> → <i class="pi pi-sliders-h"></i> **Set cell diameter…** next to it sets
the cell size:

| Parameter | Default | Used |
| --- | --- | --- |
| **Cell diameter (µm)** | 10 | When the image reports its pixel size. |
| **Cell diameter (px)** | 30 | Otherwise; in full-resolution pixels. |

A diameter of 0 segments the pixels as displayed. The <i class="pi pi-chevron-down"></i> next to it lists
the one model, **Cellpose-SAM**; hover <i class="pi pi-info-circle"></i> for its details. The model is
large (about 588 MB) and downloads on first use.

## Progress and results

![Segmentation progress toast](../assets/screenshots/seg-progress-toast.png){ width="360" }

A toast at the bottom right (titled **SAM**, **Cellpose-SAM**, **SAM point segmentation** or the tool's name)
shows what is happening: the download progress, then steps such as "Encoding image…", "Segmenting 2/3…",
"Reading the view…", "Running inference (tile 1/4)…", "Tracing cells…". When it finishes, a result toast says how many regions
were added ("Added 3 region(s).", "Added 42 cell region(s).") or that nothing was found ("No masks found.",
"No cells found.").

| Message | What to do |
| --- | --- |
| Draw one or more rectangles, then press Segment. | Draw rectangles first. |
| No masks found. / No mask for these points. / No cells found. | Zoom in, adjust contrast, or redraw the boxes tighter. For Cellpose-SAM, check the cell diameter. |
| The view does not overlap the image. | Pan or zoom so the image is in view. |
| …Zoom in for finer detail: the view was segmented below the cells' best scale. | The view was too large to read at the cells' best scale: zoom in, or draw rectangles, and run again. |
| SAM model unavailable. | The model could not be loaded (network, or the application has not configured it). |
| Segmentation failed. / Cellpose segmentation failed. | Retry; see [Troubleshooting](../troubleshooting.md). |

Segmentation results are ordinary regions: undo them with ++ctrl+z++, edit them, classify them, export them.

## Tools added by your application

Applications can add their own segmentation or detection tools next to these, each with a model picker
<i class="pi pi-chevron-down"></i> and a **Parameters** button <i class="pi pi-sliders-h"></i>. The parameters
dialog has **Reset to model defaults**. Some tools open their own dialog instead (Image view only). Those
tools are documented by your application.
