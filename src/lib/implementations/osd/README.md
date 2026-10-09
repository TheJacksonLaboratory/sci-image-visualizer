# OpenSeadragon backend

`OpenSeadragonVisualizerService` renders the **image** plot type as a natively
tiled, zoomable raster. It is the primary image backend: Plotly keeps the
scientific/data plot types and napari-js the WebGPU ones. It advertises only
`ViewerFeature.ImageDisplay`, but within that it does client-side display
(window/gamma/colormap/invert, per-channel tints), region overlays and tools,
a z-stack slice cache, and a serverless "simple" mode.

## Module map

| File | Role |
|------|------|
| `openseadragon-visualizer.service.ts` | The coordinator: `load()` / `plot()` / `setZIndex()` / teardown, the store subscription that drives recoloring, tool activation, exports, and the `IVisualizer` stubs. |
| `slice-cache.ts` | Stack slices as separate TiledImages (opacity toggle on z-scrub), per-channel image groups, LRU sizing and the background preloader. |
| `display-pipeline.ts` | Pure pixel math: window/gamma/invert/colormap for grayscale and RGB, per-channel tint LUTs and the additive channel merge. Shared by tile recoloring, the serverless compositor and the composite export. |
| `histogram-sampler.ts` | Per-slice 8-bit histograms and the grayscale auto-window from sampled tiles, plus native-bit-depth histograms from `/histogram`. Generation-guarded against image switches. |
| `tile-client.ts` | The `/tile` URL shape and the tile fetch → decode → RGBA helpers. |
| `osd-region-overlay.ts` | The SVG region overlay: draws the shared `RegionStore`'s regions, and drawing, selection and edit gestures. |
| `osd-coords.ts` | Image ↔ viewport ↔ element conversions routed through world item 0 (accurate with several TiledImages). |
| `osd-coordinate-transform.ts` | `ICoordinateTransform` for the canvas tools (wand, brush, eraser, SAM). |
| `osd-scale-bar.ts` | The physical scale bar. |
| `osd-lib.ts`, `osd-zoom.ts` | The OpenSeadragon import shim and the shared wheel-zoom step. |

## Two source paths

- **Tiled** (default): `load()` polls `GET /tiles/info` until the server has
  cached the file, and `plot()` opens a custom tile source on `GET /tile` built
  from the descriptor's real per-level sizes. A multichannel fluorescence image
  (`descriptor.multichannel`) is drawn as one TiledImage per channel, composited
  additively by the drawer, using only the real Bio-Formats levels.
- **Simple** (`IImageInfo.tiled === false`, e.g. a folder stack or the
  processing-pipeline preview): each slice is one self-contained image URL,
  fetched through `SimpleSliceAccessService` (auth applies), resampled to the
  full-resolution size so regions align, and opened as OSD's single-image
  source. A serverless multichannel image is composited client-side from its
  per-channel planes.

`load()` only computes the `OsdLoaded` payload; the image on screen keeps its
own state until `plot()` commits that payload.

## Recolor invariant

Display changes are applied through OSD's `tile-invalidated` pipeline:
`requestInvalidate(true)` restores each tile's original data and re-runs the
recolor. Invalidations are coalesced to one per animation frame, and every round
captures `displayToken`: a round that a newer one has superseded must not write
its pixels back — OSD then fails to convert the replaced canvas, destroys the
cache record and unloads the tile (the viewer goes white mid-drag).

## History: the original investigation

The rest of this file is the pre-implementation investigation that led to the
`/tiles/info` + `/tile` protocol. It is kept for the reasoning; the "stub" and
"server-side LUT" statements in it are superseded by the sections above.

### Why OpenSeadragon

OpenSeadragon (OSD) is a pure-JS, natively-tiled zoomable image viewer. It is the
right backend for the **image** plot type — large RGB / whole-slide / pyramidal
images — where Plotly's "fetch a flat PNG and re-fetch a cropped PNG on every
zoom" approach (`/preview` + `/zoom/region`) doesn't scale.

The visualization library splits work **per plot type**:

- **OpenSeadragon** → the image plot type (browse a large raster with native
  progressive tiling).
- **Plotly** → the scientific/data plot types (scalar heatmap, surface, contour,
  scatter, line/intensity profile, scatter3d, isosurface) — anything needing a
  live LUT over scalar data, a z-matrix, or a 3D scene.

Both implement the same `IVisualizer` contract (`../contracts/visualizer.contract.ts`).

### How OSD consumes images

OSD pulls **tiles** for the current viewport/zoom level from a *tile source*. It
needs (a) a **descriptor** (full pixel W×H, tile size, number of resolution
levels) and (b) a **tile endpoint** returning small fixed-size rasters
(typically 256 or 512 px). Accepted tile-source shapes:

| Tile source        | Server provides                                                        | Notes                                  |
|--------------------|-----------------------------------------------------------------------|----------------------------------------|
| **DZI (DeepZoom)** | `.dzi` descriptor + pyramid files `{level}/{col}_{row}.jpg`            | Usually pre-generated static files     |
| **IIIF Image API** | `info.json` + `…/{region}/{size}/{rotation}/{quality}.jpg`            | OSD has built-in support; on-demand    |
| **Custom**         | a JS `getTileUrl(level,x,y)` → any endpoint returning a fixed tile     | Most flexible, least standard          |
| **Simple image**   | one image URL                                                         | No pyramid → no real progressive zoom  |

### What jit-service already has (from the jit-ui ↔ jit-service contract)

Observed in `apps/jit-ui/src/app/services/files.service.ts` and
`plotly.service.ts` (the client only ever decodes rendered PNG/JPEG via
`image-js`; Bio-Formats is server-side only):

- `GET /preview?info=<base64>[&zIndex=N][&tier=small]` → a **single flat PNG** of
  the whole plane (`small`=128 px, `large`=default). The small/large tiering is a
  2-step UX optimization, **not a pyramid**.
- `POST /zoom/region` (body `ZoomRequest { info, key, roi, screen, zIndex, resolution }`)
  → a **cropped region re-rendered at higher resolution**, returned as PNG.
- `POST /zoom/open-session` → a session `key` (almost certainly an open
  Bio-Formats reader kept server-side).
- `GET /metadata?info=<base64>` → per-plane dims, channel count, z count.
- A `CONVERT` tool that already outputs **OME-TIFF Pyramid** (Bio-Formats).

**Key insight:** `/zoom/region` is already an on-demand "render an arbitrary ROI
at a target resolution" engine. That is ~90% of a tile server — it is just not
exposed as a tile protocol and is a POST (not cacheable).

### The gap

1. A **descriptor endpoint** (full pixel W×H, tile size, resolution-level count).
2. A **tile endpoint**: `GET` (cacheable) returning a fixed-size tile for
   `(level, col, row, z, channel)`.
3. **Pyramid awareness** so zoomed-out tiles don't decode the full-res plane.
4. **Tile caching** (disk / GCS / CDN) keyed by `(file, level, col, row, z, c[, lut])`.

### Recommended backend work (reuse the Bio-Formats engine)

Expose the existing render engine as a tile protocol; don't build a new one.

1. **Tile descriptor** — extend `/metadata` or add `/tiles/info` (or an IIIF
   `info.json`):
   ```jsonc
   // GET /tiles/info?info=<base64(RawFileInfo)>
   {
     "width": 98304, "height": 76800,   // full pixel dims of the plane
     "tileSize": 512,
     "levels": 9,                        // resolution levels (0 = full res)
     "z": 1, "channels": 3
   }
   ```
2. **Tile endpoint** — `GET` so the browser, nginx, and a CDN can cache it:
   ```
   GET /tile?info=<base64>&level=L&col=X&row=Y&z=Z&channel=C[&lut=..&min=..&max=..]
   → image/jpeg | image/png  (tileSize × tileSize)
   ```
   Internally map `(level,col,row)` → a source ROI + downsample factor → call the
   **same Bio-Formats crop+resize path that `/zoom/region` already uses**.
3. **Reuse the open-reader session** (`/zoom/open-session`'s `key`) so a
   viewport's ~dozen tile requests don't each reopen the reader.
4. **Add a tile cache** keyed by all params — the single biggest perf win.
5. **Level source**: use Bio-Formats native sub-resolutions (`setResolution`) for
   pyramidal formats (SVS, NDPI, pyramidal OME-TIFF); for flat formats, downsample
   from the full plane (slow for overviews — see note below).

#### Alternative: pre-generated pyramids (best perf, more infra)

Run `bioformats2raw → raw2ometiff` (or `libvips dzsave`) to produce pyramidal
OME-TIFF / DZI in GCS, served statically — optionally via **iipsrv** (IIPImage)
for IIIF/DeepZoom over pyramidal TIFF (very fast, but it only reads pyramidal
TIFF, so Bio-Formats converts first). The existing `CONVERT → OME-TIFF Pyramid`
tool already proves the generation path exists. Downside: a conversion + storage
step, not purely on-demand.

### Can the existing Bio-Formats IO work with OSD?

**Yes — the engine can, but Bio-Formats doesn't "speak" DZI/IIIF; wrap it in a
tiling layer.**

- Bio-Formats is a *reader*: `openBytes(x,y,w,h)` yields arbitrary tiles, and
  `setResolution()` exposes **native pyramid levels** for formats that have them
  (SVS, NDPI, pyramidal OME-TIFF, pyramidal CZI). That is exactly what a tile
  endpoint consumes.
- **The catch is the pyramid:** for *flat / non-pyramidal* sources, there are no
  low-res levels, so OSD's zoomed-out tiles force decoding/downsampling the full
  plane repeatedly — fine for modest images, painful for gigapixel slides. For
  those, pre-convert to a pyramidal format (the Convert tool) or generate DZI once.
- Precedent: OMERO, QuPath, PathViewer all do Bio-Formats → tiles for OSD-style
  viewers; iipsrv serves IIIF/DeepZoom from pyramidal TIFF.

### The LUT / colormap caveat

OSD shows **pre-composited RGB tiles**. So grayscale **LUT/colormap, contrast,
and channel compositing must be applied server-side when rendering each tile**
(bake `&lut=&min=&max=` into the tile URL + cache key) or via an OSD WebGL/filter
plugin client-side. This is why the stub advertises only `ImageDisplay` and not
`ScalarColormap`: live LUT over scalar data stays Plotly's job; OSD is for
browsing large pre-rendered / RGB images.

### Client-side wiring (jit-ui) — small once the protocol exists

`OpenSeadragonVisualizerService` would mount a viewer in the plot div and open a
tile source. Sketch:

```ts
// load(): fetch the tile descriptor instead of decoding a flat PNG
async load(imageInfo: ImageInfo, zIndex: number) {
  const info = await firstValueFrom(this.http.get<TileInfo>(
    `${this.api}tiles/info?info=${encodeURIComponent(base64(imageInfo.rawData))}`));
  return { descriptor: info, z: zIndex };
}

// plot(): open OSD with a custom tile source backed by /tile
plot(plotDiv, loaded, imageInfo, _h, _type) {
  const d = loaded.descriptor;
  this.viewer = OpenSeadragon({ id: plotDiv, showNavigator: true });
  this.viewer.open({
    width: d.width, height: d.height, tileSize: d.tileSize,
    maxLevel: d.levels - 1, minLevel: 0,
    getTileUrl: (level, x, y) =>
      `${this.api}tile?info=${this.infoB64}&level=${level}&col=${x}&row=${y}&z=${loaded.z}`,
  });
  return Promise.resolve(true);
}
```

Then map the rest of `IVisualizer`:

- `ICoordinateTransform` (when tools are decoupled) → OSD viewport API
  (`viewer.viewport.viewerElementToImageCoordinates` /
  `imageToViewportCoordinates` / `deltaPixelsFromPoints`).
- region overlays → a positioned canvas/SVG overlay (reuses the existing
  wand/eraser tool canvases) and/or `@annotorious/openseadragon` for rect/polygon.
- `zoomIn/zoomOut/relayout/autoscale` → `viewer.viewport.zoomBy / fitBounds / goHome`.
- `getDisplayedPixelData` → partial only: read back the rendered canvas
  (screen-res RGB, not original scalar) — gate the pipeline dialog accordingly.
- 3D / scalar-colormap methods → no-ops (capabilities advertise neither).

### Summary

You don't need a new image engine — jit-service already renders arbitrary ROIs
from Bio-Formats. To feed OpenSeadragon: (1) expose a **GET tile endpoint +
descriptor** backed by that same engine, (2) add **caching** and **pyramid-aware
level selection** (convert non-pyramidal sources to OME-TIFF pyramids via the
existing Convert tool), and (3) decide where **LUT/contrast** is applied. The
client-side OSD wiring is small once the tile protocol exists.
