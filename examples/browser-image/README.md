# Browser example — image visualization (serverless Mode B + tiled Mode A)

**Live demo:** <https://thejacksonlaboratory.github.io/sci-image-visualizer/>

A minimal, in-browser host for `<visualizer>`. A gallery of bundled sample
images (large thumbnails on the left) — click one to load it into the
OpenSeadragon view with the zoom + region tools. Or drop in your own file.

It shows **both** consumption paths:

- **Serverless (Mode B)** — the default. Each image is handed to OSD as a
  self-contained single image (`IImageInfo.tiled === false`); PNG/JPEG open
  directly, TIFF/DICOM are decoded in the browser. No backend.
- **Tiled (Mode A)** — for **gigapixel** whole-slide images that can't be a single
  blob. The `WSI` gallery entries load through a small **tile server** (see
  [Tiled mode](#tiled-mode-mode-a--building-a-gigapixel-tile-server) below and the
  reference implementation in [`../tile-server/`](../tile-server/)). These entries
  appear only when the example is built with `VITE_TILE_SERVER` set.

## Files

| File | Role |
|---|---|
| `sample-images/` | Bundled example images (**Git LFS**). PNGs open directly; TIFFs are decoded client-side. |
| `serverless-ports.ts` | The three host DI ports. `ExampleImageStateAdapter` emits `IImageInfo`: serverless images use `tiled:false` (+ a blob URL); tiled images use `setTiledImage()` (`tiled:true`, no blob). `ServerTileAccessAdapter` bridges the tile server; `StubRegionIoAdapter` is a no-op. |
| `app.component.ts` | Standalone host: the thumbnail gallery + `<visualizer>`; binds `provideVisualization()` + the ports. `TILED_IMAGES` is gated behind `VITE_TILE_SERVER`. |
| `main.ts` | `bootstrapApplication` + the app-level providers the library needs (`HttpClient`, animations, PrimeNG `MessageService`). |
| `index.html`, `vite.config.mts`, `tsconfig.json` | Vite runner (Angular via `@analogjs/vite-plugin-angular`); stages the built library into `node_modules`. |

## Sample images are stored in Git LFS

`sample-images/*` is tracked via **Git LFS**. After cloning, pull the bytes:

```bash
git lfs install
git lfs pull
```

Without that, the files are tiny LFS pointer stubs and the thumbnails won't render.

## Run on localhost

```bash
# from the repo root — build the library first (the example consumes dist/):
npm run build
# serve (staging the library happens automatically):
npm run start:example      # → http://localhost:5173
```

For the gigapixel `WSI` entries, also run a tile server and point the build at it:

```bash
VITE_TILE_SERVER=http://localhost:8090/ npm run start:example
```

## Why Vite

Vite is the runner so the **same** tooling can host non-Angular examples later
(a React or vanilla web-component demo) as the library grows framework-agnostic
consumers — just add another plugin.

---

# Tiled mode (Mode A) — building a gigapixel tile server

The serverless path hands OpenSeadragon one self-contained image
(`IImageInfo.tiled === false`). That's fine up to a few hundred megapixels; a
**gigapixel** whole-slide or micro-CT image can't be a single blob. For those,
`<visualizer>` speaks a small HTTP **tile contract** — it asks a server for a
pyramid descriptor, then fetches only the ~512 px tiles visible at the current
zoom. This section is a how-to for building such a server. A complete, ~200-line
reference lives in [`../tile-server/`](../tile-server/).

```
browser <visualizer> ──HTTP──▶ your tile server ──▶ pyramided image (COG / tiled TIFF)
     (OpenSeadragon /            /tiles/info, /tile,
      Plotly)                    /preview, /zoom/region
```

## 1. The HTTP contract

`VIZ_CONFIG.slideCropServer` is the base URL (call it `api`) — **it must end in a
trailing `/`**, because the library builds URLs by concatenation (`` `${api}tile` ``).
The `info` query param is an **opaque, URL-safe base64 token**: the library takes
it from your host adapter and passes it back verbatim on every request; your
server decodes it to identify the image (a path, bucket, or id — your choice).
The example encodes `base64url(JSON.stringify({ image }))`.

| Method + path | Returns | Called by |
|---|---|---|
| `GET {api}tiles/info?info=<b64>[&tileSize=512]` | `TileDescriptor` JSON. **200** = ready, **202** = still caching (the client polls ~1.5 s until 200) | OSD / napari on load |
| `GET {api}tile?info=&res=&col=&row=&z=&tileSize=[&channel=]` | one `image/png` tile | OSD as you pan/zoom |
| `GET {api}preview?info=[&tier=small]` | a flat, downsampled whole-plane `image/png` | the **Plotly (heatmap)** backend |
| `POST {api}zoom/region` — body `{ info, roi, screen, zIndex }` | a re-rendered region `image/png` (returned as an `ArrayBuffer`) | the heatmap **box-zoom** |
| `GET {api}histogram?info=&channel=&z=&bins=` | histogram JSON — **only for >8-bit** images | contrast / auto-scale |

`TileDescriptor` (what `tiles/info` returns):

```ts
interface TileDescriptor {
  width: number; height: number;   // full-resolution plane size, in pixels
  tileSize: number;                // e.g. 512
  z: number;                       // slice count (1 for a flat image)
  channels: number;                // 3 for RGB brightfield
  multichannel?: boolean;          // true only for per-channel composites the client splits into layers
  realLevels?: number;             // count of real (per-channel-fetchable) levels at the front of levels[]
  channelInfo?: Array<{ name?: string; color?: string; bitDepth?: number;
                        minAllowed?: number; maxAllowed?: number }> | null;
  levels: Array<{ res: number; width: number; height: number }>;  // res 0 = full res, finest first
  mppX?: number; mppY?: number;    // µm/pixel → scale bar (0 if unknown)
}
```

Conventions that matter:

- **`res`** indexes the pyramid, **0 = full resolution**; larger `res` = coarser.
- **Tile grid** for a level = `ceil(level.width / tileSize) × ceil(level.height / tileSize)`,
  computed from **each level's own** width/height (the pyramid is *not* assumed
  power-of-two). An out-of-range `col`/`row` should `404`.
- **`channel`** omitted → return the **composited RGB** tile; present (including
  `0`) → return that single band as grayscale (`R=G=B`; the compositor recovers
  intensity as `max(R,G,B)`). Plain RGB brightfield is always fetched without a
  `channel`.
- Tiles are **raw, un-normalized** pixels; `/preview` may be server-normalized.
- Edge tiles may be smaller than `tileSize` (or transparently padded — a fully
  transparent pixel is treated as padding).
- `histogram` / `export` are only needed for **>8-bit** images; an 8-bit RGB
  slide (like the demo's) can skip them entirely.

## 2. Wire it into the host (the DI ports)

The library never imports your server — three DI ports bridge it. See
[`serverless-ports.ts`](./serverless-ports.ts) for the working adapters.

**`IMAGE_STATE_PORT`** emits the `IImageInfo`. For a tiled image set
`tiled: true` and — importantly — put the **`/preview` URL in `urls[0]`**: OSD
ignores `urls` and drives the tile grid, but the Plotly (heatmap) backend loads
`urls[0]` as its flat pixel source. Miss this and switching to Heatmap throws.

```ts
setTiledImage(image, fileName, width, height, mppX, mppY) {
  this.currentInfoB64 = toBase64Url(JSON.stringify({ image }));            // your token shape
  this.imageInfo$.next({
    tiled: true,                                                           // ← the Mode A switch
    fileName,
    trueImageSize: [width, height],
    urls: [`${slideCropServer}preview?info=${this.currentInfoB64}`],       // Plotly heatmap source
    imageMeta: [{ channelCount: 3, rgbChannels: 3, x: width, y: height, z: 1, mppX, mppY }],
    isStack: false,
  });
}
```

**`TILE_ACCESS_PORT`** hands OSD the current image's token and serves the
box-zoom:

```ts
class ServerTileAccessAdapter implements TileAccessPort {
  // null → serverless (OSD uses urls[zIndex]); a token → tiled (OSD polls tiles/info).
  getSelectedInfoB64(): string | null { return this.imageState.getSelectedInfoB64(); }

  // heatmap box-zoom → POST {api}zoom/region → the region PNG bytes
  zoomOnRegion(roi, screen, zIndex): Observable<ArrayBuffer> {
    const info = this.imageState.getSelectedInfoB64();
    return from(fetch(`${api}zoom/region`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ info, roi, screen, zIndex }),
    }).then(r => r.arrayBuffer()));
  }

  getAuthHeaders(): Promise<Record<string, string>> { return Promise.resolve({}); } // bearer for OSD's ajax
  selectDiagramDisplay() {}
}
```

**`VIZ_CONFIG`**: `{ slideCropServer: 'https://…/tiles-api/' }` — trailing slash.

> The whole Mode-A-vs-B switch is `getSelectedInfoB64()`: return `null` and the
> exact same viewer renders the serverless `urls[]`; return a token and it renders
> tiles from your server.

## 3. Build the server

A tile server is two jobs — **pyramid the image once**, then **serve tiles on
demand**. The reference implementation in [`../tile-server/`](../tile-server/):

- **`scripts/make-cog.mjs`** — offline converter: a whole-slide image (SVS, NDPI,
  OME-TIFF…) → a pyramid of *tiled* TIFFs (`L0.tif` full res, each level halving
  down to ~1 tile) + a `descriptor.json`, via `vips` + OpenSlide. Any pyramided /
  Cloud-Optimized-GeoTIFF format works; the one requirement is that each level is
  **tiled**, so reading one 512 px tile touches a few KB, not the whole level.
- **`lib/cog.mjs`** — the readers: `loadDescriptor`; `readTile` (extract the
  `(col,row)` tile from level `res` with `sharp` — libvips reads only the
  overlapping tiles); `readPreview` (downsample a coarse level to a flat PNG);
  `readRegion` (crop the ROI at ~screen resolution for `/zoom/region`).
- **`server.mjs`** — a ~90-line Express app mapping the five routes above onto
  those readers, with CORS.

No database, no state. At gigapixel scale the only thing that matters is a
**tiled pyramid**, so every read stays O(tile) instead of O(image). Swap `sharp`
for `geotiff.js` (range-reading a COG straight from a bucket), or the local
pyramid for a DeepZoom/IIIF source, as long as you keep the contract above.

## Showing every plot mode

`?test=1` on the example URL turns on the viewer's `testMode` input, which shows
every backend's plot mode under its backend-suffixed label — `Image (OSD)` next
to `Image (napari · WebGPU)`, both Surfaces, all the Scatters:

```
http://localhost:5173/?test=1
```

It lifts the `productionLabel` curation only. The capability gates still apply:
a stack-only mode still needs a stack, a scalar mode still needs a grayscale
image, and **Spatial omics** still needs a dataset loaded.

## Spatial-omics demo

The gallery's spatial entries are **discovered from the server**, not hardcoded:
the example asks `/spatial/datasets` at startup, so dropping a SpatialData store
(or a legacy ST bundle) into the server's data directories makes it appear here
with no code change. They live in a **`spatial-omics` folder**, like the bundled
micro-CT series — with 41 datasets the root gallery is unreadable flat. Each
entry loads a tissue image *and* the spatial-omics dataset registered onto it.

Image dimensions are fetched on **click**, not at startup — asking for a
descriptor is what makes the server build that image's pyramid, so only the
dataset you open pays for it. Selecting it makes the
**Spatial omics** plot type appear in the plot-type selector (it is hidden
whenever no dataset is loaded, like Volume is hidden without a z-stack); picking
that mode draws ~2,000 spots over the tissue, coloured by anatomical region.

```bash
cd examples/tile-server
npm install
# either: a synthetic dataset, no download
npm run make-spatial-demo
# or: drop a real SpatialData store in and it is served live
#   ln -s /path/to/data.zarr stores/visium
npm start

# then, from the repo root:
VITE_TILE_SERVER=http://localhost:8090/ npm run start:example
```

Wiring it into a host takes two things — a provider and a call:

```ts
providers: [
  SpatialDataHttpService,
  { provide: SPATIAL_DATA_PORT, useExisting: SpatialDataHttpService },
]

// then, when the user picks a dataset:
this.spatialData.configure({ baseUrl: TILE_SERVER });
await this.spatialData.selectDataset('demo-brain');
this.viz.getSpatialControls()?.colorByColumn('region');
```

`getSpatialControls()` returns null unless a port is bound, and its view state
lives in the shared store — so it works before any backend has mounted and
survives a plot-type switch. The example calls `spatialData.clear()` whenever a
non-spatial image is selected, which is what withdraws the plot type again.

Once the mode is active, the **Spatial omics** toolbar button opens the controls
panel: colour by any column or search the gene panel, with a legend for
categorical colourings, a colour bar for continuous ones, and point-size,
opacity, log-scale and outlier-clip controls. The example sets an initial
colour column in code only so the mode opens on something meaningful.

## Try it end-to-end

```bash
cd ../tile-server && npm install
npm run make-cog -- .cache/CMU-1.svs cmu-1     # needs: brew install vips
npm start                                       # → http://localhost:8090
# then, from the repo root:
VITE_TILE_SERVER=http://localhost:8090/ npm run start:example   # WSI entries appear
```

See [`../tile-server/README.md`](../tile-server/README.md) for running and
deploying the server (the demo runs it as a pod behind the dev-cluster ingress).
