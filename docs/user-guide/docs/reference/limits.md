# Limits and requirements

## Browser and graphics

SIV runs in current desktop browsers. The 3D and spatial-omics views use **WebGPU** when the browser offers
it.

| Browser | WebGPU |
| --- | --- |
| Chrome, Edge (desktop) | Yes |
| Firefox | From version 141 |
| Safari | From version 26 |

WebGPU also needs a secure (`https://`) page and a supported graphics driver. SIV checks for it once per
page (waiting at most 3 seconds). Without WebGPU:

| View | Behaviour |
| --- | --- |
| Image, Heatmap, Contour | Unaffected |
| Surface, Volume, Isosurface | Drawn with the Plotly fallback, which is slower and simpler |
| Spatial omics (2D) | Drawn as WebGL markers over the image: no cell outlines, transcripts, density map or marker icons; datasets without a tissue image cannot be shown |
| Spatial omics 3D | Needs WebGPU |

AI segmentation runs on the GPU (WebGPU) or the CPU (WebAssembly), depending on the model. See
[AI segmentation](segmentation.md#choosing-the-sam-model).

## Images

| Item | Limit |
| --- | --- |
| Image size | Gigapixel images are fine in the Image view (tiles are loaded on demand). |
| Zoom | Out to about 1% of the view; in to 20 screen pixels per image pixel. |
| Channels shown at first | The first 4 of a multichannel image |
| Composite PNG export | Up to 32 megapixels (larger images are saved at the largest level that fits) |
| 3D build resolution | Full 1024, ½ 512, ¼ 256 (default), ⅛ 128 pixels in-plane |
| Contour detail | Up to 400 × 400 cells |
| Intensity profiles | 8-bit display values |

## Regions

| Item | Limit |
| --- | --- |
| Undo / redo | 10 actions each way; cleared when you switch images |
| Merge / inverse precision | Exact up to 16 megapixels across; larger selections at reduced resolution |
| Region set threshold | Files of 1,000,000 characters or more load as a region set (drawn at a level of detail per zoom; set by the host) |
| Region-set tiles in view | 256 |
| Features taken by a rubber band | 2,000 |
| Features taken by Select all or a class pick | 5,000 |
| Per-slice region sets open at once | 6 |
| Mask export | Images over 100 megapixels are saved downscaled; 8-bit up to 255 regions, 16-bit above |
| Opening annotations without an image | Up to 8,192 pixels per side |

Region sets are drawn in the Image view; the Heatmap view and 3D views show only the regions taken from
them. The wand, brush, vertex eraser and merge work on regions, not on region-set features: select a feature
first to take it.

## Spatial omics

| Item | Limit |
| --- | --- |
| Markers | Never smaller than 2 screen pixels |
| Counts chart | 25 largest categories, then "other" |
| Violin / Box | 20,000 points per trace |
| Histogram | 10–100 bins |
| Heatmap | 40 group columns; one column per cell up to 200 selected cells; 3 cells minimum per group |
| Embedding legend | Up to 10 categories |
| t-SNE in the browser | Up to 5,000 observations |
| Cluster density volumes | The 6 largest clusters |
| Transcripts | 100,000 points drawn by default (25k–400k) |
| Gene search | 50 results per keystroke from the server; 500 matches for local lists |

## What is saved

| Setting | Kept |
| --- | --- |
| Regions | In memory, per image, until you reload. Export or save them. |
| Annotation class list | Per user on the server when the host stores preferences; otherwise for the session |
| Display settings, plot type, tool sizes, SAM model, toolbar position | For the session only |
| AI models | In the browser cache, until site data is cleared |
