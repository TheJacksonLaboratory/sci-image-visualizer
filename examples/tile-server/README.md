# Example tile server (Mode A — large-image tiled loading)

A tiny standalone server that lets the browser example load **gigapixel** images
through `sci-image-visualizer`'s *tiled* render path — the same
`tiles/info` + `tile` + `zoom/region` contract the production `jit-service`
backend implements — instead of the default serverless (whole-image blob) path.

It exists to **showcase large-scale image loading**: pan/zoom a 1.5 Gpx (CMU-1)
or 22 Gpx (BC18) whole-slide image while the browser fetches only the ~512 px
tiles it needs at each zoom level.

```
browser example ──HTTP──▶ tile-server ──reads──▶ pyramided COGs (local dir / bucket)
   (OpenSeadragon)          (this)                 cogs/<imageId>/L{0..N}.tif
```

## How it works

Whole-slide formats (SVS, NDPI, …) are converted **offline** into a small
pyramid of *tiled* TIFFs by `scripts/make-cog.mjs` (via `vips` + OpenSlide).
At request time the server reads only the tiles overlapping each request out of
the right pyramid level with `sharp` (bundled libvips — no OpenSlide needed),
so it stays lightweight and stateless.

### Endpoints

| Method + path | Returns |
|---|---|
| `GET /tiles/info?info=<b64>` | `TileDescriptor` JSON (pyramid levels, tileSize, mpp, channels) |
| `GET /tile?info=<b64>&res=&col=&row=&z=&tileSize=` | one `image/png` tile |
| `POST /zoom/region` `{ info, roi, screen, zIndex }` | region re-render `image/png` (heatmap box-zoom) |
| `GET /images` | list available image ids |

`info` is an **opaque, URL-safe base64** token minted by the browser example's
`ServerTileAccessAdapter`; here it decodes to `{ "image": "<imageId>" }`.

> Histogram / export endpoints are only needed for >8-bit images. These demo
> slides are 8-bit RGB brightfield, so they are intentionally omitted.

### Spatial-omics endpoints

The same server also implements the **spatial-omics data plane** — the wire
format `SpatialDataHttpService` speaks (see
[`src/lib/implementations/spatial/spatial-wire.ts`](../../src/lib/implementations/spatial/spatial-wire.ts)).

| Method + path | Returns |
|---|---|
| `GET /spatial/datasets` | `{ datasets: [{ id, name, count }] }` |
| `GET /spatial/:id/manifest` | manifest: count, column + feature metadata, radius, imageRef |
| `GET /spatial/:id/coords` | `f32[N]` x, `f32[N]` y, `f32[N]` z? — one response |
| `GET /spatial/:id/radius` | `f32[N]` (per-observation radius only) |
| `GET /spatial/:id/ids` | `{ ids: [...] }` |
| `GET /spatial/:id/column/:name` | `u16[N]` codes (categorical) or `f32[N]` values (continuous) |
| `GET /spatial/:id/feature/:name` | `f32[N]` — one gene's expression vector |
| `GET /spatial/:id/features?q=&limit=` | `{ names: [...] }` typeahead |
| `GET /spatial/:id/polygons` | `u32` count, `u32[count+1]` offsets, `f32` coords |

Vectors are **raw little-endian bytes**, decoded by a typed-array view with no
copy — JSON would cost ~8–12× the bytes and allocate a JS number per value.

Two things the layout is built around:

- **Nothing loads the whole matrix.** The manifest carries only metadata; a
  column or gene vector is fetched when it is displayed. Visium ships ~31k
  genes — the dense matrix is ~800 MB, so "load the dataset" can never mean
  "load the matrix".
- **The matrix is stored gene-major.** AnnData stores `X` observation-major
  (CSR), so reading one gene means touching every row. The converter transposes
  once, offline; serving a gene is then a contiguous ranged read at
  `geneIndex * N * 4`, and the matrix is never held in server memory.

#### Serving a SpatialData store LIVE

Drop (or symlink) a `*.zarr` store into `./stores` and it appears on
`/spatial/datasets` — no build step, no intermediate bundle:

```bash
curl -O https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_spatialdata_0.7.1.zip
unzip visium_spatialdata_0.7.1.zip
ln -s "$PWD/data.zarr" stores/visium        # or just move it in
npm start
```

Every `(store, table, region)` triple becomes a dataset. Ids stay short when
they can — `hd.cell_segmentations` for a single-region table,
`visium.table.ST8059048` when a table covers several sections — so the Visium
store above yields **both** of its sections without being asked.

The tissue image is materialised into `./cogs` the first time it is requested
(0.1–0.8 s for these stores), so OSD's tile path is unchanged and only the first
open pays.

**Optional sidecar** at `stores/<name>.json`, carrying only what cannot be
inferred from the store:

```json
{ "gridUm": 2 }
```

`gridUm` is the assay's grid pitch in µm. A segmentation traced on a binned
assay steps one bin at a time, so the outlines measure the grid — but nothing in
the store states the bin's physical size, and without it there is no µm/px and
no scale bar. Visium needs no sidecar: its 100 µm spot pitch is fixed.

#### What live serving costs

The expression matrix is CSR over **observations**, so one gene's column is
scattered across every row. Serving it means holding the matrix and scanning it:

| request | cost, measured on these stores |
|---|---|
| manifest, coords, ids, columns | 2–30 ms |
| first gene (reads X into memory) | 0.4–0.5 s, then 227 MB (Visium) / 331 MB (HD) resident |
| subsequent genes | 13–40 ms |
| derived `cluster` (k-means, on first request) | 0.3 s / 1.4 s |
| tissue pyramid (first open) | 0.1 s / 0.8 s |

It is deliberately **not** transposed to gene-major in memory — that would
double the residency, and a scan is tens of milliseconds. A production server
should serve a pre-transposed gene-major file instead, which is exactly the
argument for keeping this ingest out of the browser.

Derived columns (`total_counts`, `n_genes_by_counts`, `area`, `cluster`) are
advertised in the manifest and computed on first request, so opening a dataset
does not pay to cluster it. Columns that encode nothing are dropped:
identifiers (a distinct integer per observation) and columns constant after
filtering.

#### Pre-built bundles

`$SPATIAL_DIR` still serves bundles in the same wire format, and a bundle **wins**
when both sources offer the same id — so a deliberately-converted dataset can
override a live one. `npm run make-spatial-demo` writes a synthetic
Visium-geometry bundle plus its image, which needs no download and is what the
smoke check runs against.

## Deploy (Cloud Run)

Deployed to Cloud Run in **jax-cloud-image-tools**, reading the COGs from a
**private** bucket via a gcsfuse volume mount — so BC18's imagery stays
non-public; only the tile server (behind IAM) serves derived tiles.

**Current status: authenticated-only (Option C).** The public
`allUsers → run.invoker` binding was NOT set — the deploying account lacks
`run.services.setIamPolicy` (and JAX org policy may block anonymous access
anyway). So the live GitHub Pages demo stays serverless; the tiled path runs
locally (above) or for authenticated callers. The service is left deployed so IT
can flip it public later without a redeploy (see below).

### What's deployed

- **Service:** `jit-tile-server` (us-central1) — `https://jit-tile-server-ayoik37pnq-uc.a.run.app`
- **COG bucket (private):** `gs://jax-cimg-tile-cogs` — `cmu-1/`, `bc18/`, `sirius-red/`; read by
  the Cloud Run runtime SA (`<projectNumber>-compute@…`, granted
  `roles/storage.objectViewer`).
- gen2, 2 vCPU / 2 GiB, **scale-to-zero** (`--min-instances 0`), gcsfuse volume at
  `/mnt/cogs` (`COG_DIR=/mnt/cogs`). Idle cost ≈ $0; bucket storage ≈ $0.05/mo.

Rebuild / redeploy (from this dir):
```bash
# (re)generate + upload COGs
npm run make-cog -- .cache/CMU-1.svs cmu-1
gcloud storage cp -r cogs/cmu-1 cogs/bc18 gs://jax-cimg-tile-cogs/

# deploy (Cloud Build + gcsfuse volume)
gcloud run deploy jit-tile-server --source . \
  --project jax-cloud-image-tools --region us-central1 \
  --execution-environment gen2 --memory 2Gi --cpu 2 \
  --min-instances 0 --max-instances 3 --concurrency 20 --timeout 120 \
  --add-volume name=cogs,type=cloud-storage,bucket=jax-cimg-tile-cogs,readonly=true \
  --add-volume-mount volume=cogs,mount-path=/mnt/cogs \
  --set-env-vars COG_DIR=/mnt/cogs
```

### Going public later (IT / an admin with `run.admin`)

1. Grant anonymous invoke (only works if org policy permits `allUsers`):
   ```bash
   gcloud run services add-iam-policy-binding jit-tile-server \
     --region us-central1 --project jax-cloud-image-tools \
     --member=allUsers --role=roles/run.invoker
   ```
   If Domain-Restricted-Sharing rejects `allUsers`, front the service with an
   external HTTPS Load Balancer instead (public frontend, invokes Run via a
   Google-managed identity).
2. Wire the live demo: set `VITE_TILE_SERVER=https://<run-url>/` (trailing slash)
   in `.github/workflows/pages.yaml`'s `build:example` step. The next Pages
   deploy then shows the gigapixel tiled entries.

> `tiles/info`/`tile` return **200** because pyramids are pre-generated; a server
> that lazily fetched the source from a bucket would return **202** while caching
> and let the library poll until ready.
