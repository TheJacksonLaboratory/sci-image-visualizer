# Troubleshooting

Find the symptom, then the likely cause and what to do. If none of these helps, report the problem with the
browser name and version, the image or dataset, and the steps that led to it.

## Images and viewing

### The image stays blank or shows "Could not draw the image"

- **Cause:** the image could not be read or the server returned an error.
- **Fix:** open the image again. If it keeps failing, check that the file opens elsewhere and that you are
  still signed in to the host application.

### The image stays blurry and a "Preview not sharpened" message appears

- **Cause:** a low-resolution preview is shown first; the full-resolution one failed to load.
- **Fix:** click the image again, or reopen it. The low-resolution preview stays usable meanwhile.

### The view went blank after I unticked a channel

- **Cause:** a grayscale image has a single channel, **Intensity**; hiding it hides everything.
- **Fix:** in Channels & Histogram, tick **Show** again.

### Some channels of a multichannel image are missing

- **Cause:** only the first 4 channels are shown when an image opens, unless the image says otherwise.
- **Fix:** tick the other channels in Channels & Histogram.

### The image looks blocky when zoomed in

That is deliberate: raw pixels are shown so you can inspect them. Click **Smoothen** for a smoothed image.

### There is no scale bar

The scale bar needs the image's physical pixel size. Images without it (many PNGs and JPEGs) have no scale
bar, and areas are shown in px².

### The toolbar disappeared after I moved it

- **Cause:** the floating toolbar can be dragged off-screen.
- **Fix:** reload the page; the toolbar always starts docked.

### Zooming the Heatmap with a trackpad is very fast

- **Cause:** in the Heatmap and Contour views, each scroll event zooms a full step, and trackpads send many
  events.
- **Fix:** use the zoom buttons, ++plus++ / ++minus++, the zoom box, or a mouse wheel.

### The "Z-plane:" slider and the Slice slider disagree by one

The Heatmap's **Z-plane:** slider numbers slices from 1; the toolbar's **Slice** slider counts from 0. They
show the same slice.

## Plot types

### A plot type I expected is not in the dropdown

The dropdown only offers what the current data can show:

| Missing | Why |
| --- | --- |
| Contour | The image is RGB; Contour needs grayscale or multichannel |
| Volume, Isosurface | The image is not a z-stack, or it is RGB |
| Spatial omics | No spatial-omics dataset is loaded |
| Spatial omics 3D | The dataset's observations have no z coordinate |
| Image, Heatmap, Surface | A spatial-omics dataset with no tissue image is open (for example seqFISH) |

### The view switched back to Image when I opened another file

A 3D plot type does not carry over to a new image: the view resets to **Image**. 2D types such as Heatmap
carry over if the new image supports them.

### 3D views or spatial omics do not draw, or draw without cell outlines

- **Cause:** your browser does not support WebGPU, or it is disabled. SIV then falls back: 2D spatial omics
  is drawn with WebGL (markers only, no cell outlines, transcripts or density map), and the 3D views use a
  simpler renderer or are unavailable. **Spatial omics 3D** needs WebGPU.
- **Fix:** use a recent Chrome or Edge on desktop, make sure hardware acceleration is on in the browser's
  settings, and open the application over HTTPS. See [Limits and requirements](reference/limits.md).

### The 3D view is slow

Lower the **Res** setting (¼ or ⅛), use a subset of a large spatial dataset (such as the 1-in-10 atlas),
and close other GPU-heavy tabs.

## Regions

### My regions disappeared when I opened another image

Regions are kept per image. Switch back to the first image and they reappear. They are lost on a page
reload unless you exported them or saved them to the server; see [Import and export](how-to/import-export.md).

### Importing a GeoJSON removed my existing regions

Importing a single GeoJSON file replaces the image's regions. Export the current ones first, then import.

### Imported regions are all in the class "Cell"

Features without a `classification` property are given the class **Cell**. Add classifications in the
source tool, or relabel them after import.

### Imported regions have different colours than in the file

Class presets win: a region whose class has a preset is drawn in the preset colour. Change the preset, or
give the regions individual colours with **Edit colour of selected regions**.

### New regions do not use the class I clicked in the Classes panel

New regions always start in the class **Region**. Classify them after drawing, or select them and click the
class.

### The wand selects too much or too little, or behaves differently after zooming

- **Cause:** the wand reads the displayed pixels, so zoom, contrast and colours change what it sees.
- **Fix:** adjust **Sens.** (higher is stricter), improve the contrast first, and zoom so the object is a
  reasonable size on screen. ++ctrl++-click gives an exact-match fill.

### The brush or eraser seems larger when zoomed out

The size sliders are applied to the pixels being displayed. Zoom to the scale you want to work at before
painting.

### Undo does not go back far enough

Only the last 10 region actions can be undone, and switching images clears the history.

### "Nothing to invert"

**Inverse** needs at least one closed region selected (not a polyline). Select one and try again.

### "x512" made a rectangle disappear

Sides are rounded to the nearest multiple of 512, so a side under 256 pixels becomes 0. Undo, enlarge the
rectangle, and try again.

### Class presets are gone after a reload

Presets are saved on the server only when the host application provides that storage. In the demo they last
for the session. Use **Manage → Export** to keep them in a file.

### Unexpected classes such as "sam" or "cell" appear in the class list

Classes found on the image's regions are added to the list while the Region Editor is open. Remove the ones
you do not want with their trash icon.

## AI segmentation

### The first segmentation takes a long time

The first run downloads the model (14 MB to about 600 MB). The toast shows the download progress. Later
runs use the browser's cache.

### "SAM model unavailable" or a download error

- **Cause:** the model could not be downloaded (network, firewall, or no model URL configured).
- **Fix:** check your connection and try again. On a restricted network ask your administrator to allow
  `huggingface.co`, or to host the models internally.

### "No masks found" or "No cells found"

- Make sure the rectangles are on screen: only the visible part is segmented.
- Improve the contrast so objects stand out.
- For SAM, try another model (patho-sam for stained histology).
- For Cellpose, make sure the rectangle contains whole cells.

### Segmentation is slow on a large model

The ViT-B models run best with WebGPU. Without it, use **micro-sam ViT-T** or **patho-sam ViT-B (int8)**.

### SAM re-encodes the image every time

Panning or zooming changes what SAM sees, so it encodes again. Keep the view still while you place prompts.

## Spatial omics

### "No dataset is loaded"

The panel was opened before a dataset was selected. Open a dataset first.

### Clicking markers does not select anything

Selecting by click works with **Colour by → Group**, not with a gene colouring. Click-to-zoom is off in the
spatial views; use the wheel or zoom buttons to zoom.

### "No observations fell inside the drawn regions"

The regions do not overlap any observation. On a stack-backed dataset, only the current slice counts; in
3D, regions cut through the cloud as seen from the camera.

### The density map disappeared

The transcript density map is hidden while **Show observations expressing** is on, because it cannot be
filtered by cell. Use Points or Icons, or clear the gene filter.

### "Max points reached"

More transcripts are in view than **Max markers** allows, so they are grouped into circles. Zoom in, pick
fewer genes or raise **Max markers**.

### t-SNE is not offered

In-browser t-SNE needs a dataset with a PCA, without a t-SNE, and with at most 5,000 observations. Larger
datasets need an embedding computed offline.
