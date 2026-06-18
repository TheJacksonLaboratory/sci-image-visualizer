# Bug: DICOM / mask images render as a flat colored rectangle in OSD "image" mode

_Filed: 2026-06-04 · Updated: 2026-06-04 (front-end + jit-service fixes, verified) · Repo:
**jit-ui** (front-end) + **jit-service** (tile normalization) · Status: ✅ Fixed (both halves verified)_

## Resolution (2026-06-04) — fixed end-to-end

Two complementary fixes, both verified live (Firefox DevTools + screenshots):

**1. jit-ui front-end per-image auto-range** (`openseadragon-visualizer.service.ts`,
commit `30c8cb4`): `computeImageWindow` samples the full-res tiles (`res=0`, bounded to 64)
for a per-image min/max in tile-value space, and `recolorTile` maps
`lutIdx = 255·(v−min)/(max−min)` (clamped, per-image so seamless). It deliberately does
**not** use the `/preview` (server-normalized → wrong value space) nor a downsampled
overview (averages sparse mask labels to 0). A genuinely full-range tile (`min=0,max=255`)
is left as identity — no-op.

**2. jit-service tile normalization** (deployed): the `/tile` endpoint now emits a
**normalized 8-bit** PNG instead of a collapsed 16-bit one.

Live evidence of the decoded `/tile` range (8-bit, the path OSD renders through):

| Image | `/tile` range before | after | Result |
|---|---|---|---|
| `case1_012.dcm` (DICOM) | 0–6 (raw, low) | 0–6 | ✅ front-end windowing stretches it → full CT detail |
| `000_masks.png` (mask) | **0–0** (16-bit collapsed in 8-bit canvas) | **0–255** (server-normalized) | ✅ renders full cell-segmentation structure |

So: the **DICOM** is handled entirely by the front-end window; the **mask** needed the
server to deliver a normalized 8-bit tile (the browser's 8-bit canvas collapsed the old
16-bit tile to 0 before `recolorTile` ever saw it — unrecoverable client-side). With the
normalized tile the front-end guard correctly skips windowing (already 0–255) and the LUT
renders it directly.

> ⚠️ **Caching caveat:** `/tile` responses are `cache-control: max-age=86400, public`. After
> the jit-service deploy, browsers (and any proxy/PVC tile cache) keep serving the old
> collapsed tiles for up to 24h — verifying the fix required DevTools "Disable Cache". If a
> tile-rendering change needs to land promptly, bust the relevant tile cache(s).

> The rest of this document is the original diagnosis, kept for history. Its front-end/server
> split was refined by the live findings above (the front-end handles 8-bit low-range like
> the DICOM; the mask needed the jit-service tile normalization).

## Symptom

In the OSD **"image"** plot type, certain images render as a **single flat rectangle**
in the colormap's color (default `greyinv` → a dark rectangle) instead of the image.
The same images render **correctly in the "heatmap" (Plotly)** plot type.

Reproduced with: `case1_008.dcm` (16-bit DICOM), `002_masks.png` (label mask, values 0,1,2…).

## Root cause: heatmap auto-ranges; OSD applies a fixed LUT with no windowing

The two render paths treat the *same pixels* completely differently.

**Plotly heatmap — auto-ranges (window/level):**
- Builds `z` = a 2-D scalar matrix of intensities (`plotly-trace-builders.ts`,
  `toScalarFrame`; RGB → luminance `0.299R+0.587G+0.114B`), and computes a per-image
  min/max over all voxels (`plotly.service.ts:549`).
- The heatmap trace sets `colorscale`/`reversescale` but **no `zmin`/`zmax`** → Plotly
  `zauto` stretches the data's **actual min→max across the full colormap**.
- So a mask (`0,1,2`) or a DICOM with a narrow intensity band still fills the colorscale
  → structure is visible.

**OSD "image" — fixed 0–255 LUT, no windowing:**
- `openseadragon-visualizer.service.ts` → `recolorTile` indexes a **fixed 256-entry LUT**
  by the **raw 8-bit grayscale value** of each tile. There is **no auto-range /
  window-level**.
- For these images the values cluster near 0 (mask labels; the un-normalized 16-bit
  DICOM tile collapses low), so every pixel maps to ~the same dark LUT entry → a flat
  rectangle.

So it's the **same data**: heatmap normalizes the dynamic range, OSD does not. That is
the "normalization gap."

## Fix

### Primary (front-end, fixes masks + most cases): per-image auto-range in `recolorTile`
Before the LUT lookup, **window the grayscale value by a per-image min/max** (mirror what
the heatmap already does), instead of indexing the LUT by the raw 0–255 value:

```
lutIndex = round( 255 * (value - imageMin) / (imageMax - imageMin) )   // clamp to [0,255]
```

- Use a **per-image** min/max (the heatmap already computes one — `plotly.service.ts:549`),
  not per-tile → it's **consistent across tiles, so no seams**.
- No `slide-cropper-engine`/server change needed for 8-bit images (masks).
- Compute the min/max once per image (e.g. from the overview/preview) and reuse it for
  every tile's `recolorTile`.

### Secondary (jit-service, needed for 16-bit DICOM)
> jit-service-side plan: `jit-service/doc/tile-normalization-16bit-windowing.md`.

OSD tiles are PNGs the browser canvas decodes as **8-bit**. If `BioFormats.read` emits a
16-bit tile that's already collapsed when read 8-bit, the front-end can't recover the
range. For 16-bit sources the **server must deliver a properly windowed 8-bit tile**:
- `slide-cropper-engine`'s `org.jax.slidecrop.io.BioFormats` already has
  `convert(raw, bit)` → `normalize(vals, max, min, 255f)` (min–max → 8-bit), but it's only
  wired into the `readRaw`/`readPng` path — **not** `read()` (the method `ZoomService.cut`
  → tiles use). Either route the tile path through a normalizing read, or normalize the
  `BufferedImage` in `ZoomService.cut`.
- Per-tile min/max here would cause **seams** on large multi-tile images → use a
  **per-image** window (global min/max), consistent with the front-end approach.
- This is the design-level part; for the small single-tile DICOM/mask cases the front-end
  fix may be sufficient on its own.

## Not the cause (ruled out)
- **`.gz` images** used to render flat too, but that was a *different* bug — a serving
  problem (gzipped TIFFs weren't gunzipped before Bio-Formats read them). Fixed in
  jit-service commit `944352e` (`getTile` now uses `touch(so, true)`). DICOM/masks are the
  normalization gap, not a serving problem.

## Related
- **`getExistingThumbnail(null)` NPE** for these same images on `/preview` — fixed in
  jit-service `c85903e` (clean "File not found" instead of NPE flood). Note this means the
  *preview* request for these files currently 404s server-side (the requested path doesn't
  resolve) — worth confirming the OSD/preview path sends the right `FileInfo` for masks/DICOM.
- **Colormap stuck after image switch** — sibling OSD bug, see
  `docs/bug-colormap-stuck-on-image-switch.md`. Different defect (the colormap *change*
  is dropped), same file (`openseadragon-visualizer.service.ts`).

## Affected files
- `apps/jit-ui/src/app/services/visualization/implementations/osd/openseadragon-visualizer.service.ts`
  — `recolorTile` (add per-image auto-range), and the per-image min/max source.
- `apps/jit-ui/src/app/services/visualization/implementations/plotly/plotly.service.ts:549`
  — reference for the per-image min/max the heatmap already computes.
- (16-bit) `slide-cropper-engine` `org.jax.slidecrop.io.BioFormats` (`read` vs
  `convert`/`normalize`) and jit-service `ZoomService.cut`.
