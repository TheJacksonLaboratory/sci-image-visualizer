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

#### Generating data

```bash
# A synthetic Visium-geometry dataset — no download, no Python, runs instantly.
npm run make-spatial-demo        # -> ./spatial/demo-brain (~2k spots, 12 marker genes)
npm start                        # SPATIAL_DIR=./spatial

# Verify the whole wire format end to end (boots the server, decodes every route):
npm run smoke-spatial
```

Real data goes through the Python converter, which reads a SpatialData Zarr
store (Zarr v3 + AnnData conventions + GeoParquet shapes):

```bash
pip install "spatialdata>=0.2" numpy pandas

curl -O https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_spatialdata_0.7.1.zip
unzip visium_spatialdata_0.7.1.zip     # -> data.zarr  (Visium mouse brain, ~68 MB)

python scripts/make_spatial.py --input data.zarr --list
python scripts/make_spatial.py --input data.zarr --sample ST8059048 --out ./spatial
```

> The store is **multi-sample** (`ST8059048`, `ST8059050`, …), so `--sample`
> picks the section. `--genes` defaults to the 2,000 most-expressed;
> `--genes all` writes the full matrix. If spots do not line up with the tissue
> image, the transform lookup fell back to intrinsic coordinates (it says so on
> stderr, and records it in `manifest.imageRef._note`) — correct it with
> `--coordinate-system` or `--scale`.
>
> `make_spatial.py` has not been executed against a live store yet; treat the
> first run as a verification step.

## Quick start (local)

```bash
cd examples/tile-server
npm install

# 1. Produce a pyramid from a whole-slide image (needs: brew install vips)
#    CMU-1 (CC0, ~1.5 Gpx):
npm run make-cog -- .cache/CMU-1.svs cmu-1
#    A JAX slide (~22 Gpx):
npm run make-cog -- .cache/BC18_1.ndpi bc18

# 2. Serve
npm start                       # -> http://localhost:8090   (COG_DIR=./cogs)

# 3. From the repo root, point the browser example at it (trailing slash matters —
#    the library concatenates `${api}tile`):
VITE_TILE_SERVER=http://localhost:8090/ npm run start:example
```

The gigapixel gallery entries only appear when `VITE_TILE_SERVER` is set, so the
public Pages demo stays fully serverless until a server is wired in.

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
