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
# Writes BOTH the spatial bundle and a matching tissue-image pyramid:
#   ./spatial/demo-brain          ~2k spots on a real 100 um hex grid, 12 marker genes
#   ./cogs/demo-brain-tissue      2000 px H&E-ish image, tiled pyramid + descriptor
npm run make-spatial-demo
npm start                        # SPATIAL_DIR=./spatial  COG_DIR=./cogs

# Verify the whole thing end to end (boots the server, decodes every route,
# and checks every spot lands inside the image under the manifest's affine):
npm run smoke-spatial
```

The image and the data are generated from the **same** region function, so the
H&E tint and the `region` column agree by construction. Spot coordinates stay in
the full-resolution frame while the image is a ~0.31 downscale of it — the same
arrangement Visium has with its 2000 px hires tier — so `imageRef.scale` is a
real affine rather than a trivial 1:1, and the renderer's registration is
actually exercised.

Real data goes through the **Node** converter — no Python, no Zarr or Parquet
libraries. These stores are Zarr v3 with `bytes` + `zstd` codecs and `vlen-utf8`
strings, and Node 24 ships zstd in `node:zlib`, so `lib/zarr3.mjs` reads them
directly:

```bash
curl -O https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_spatialdata_0.7.1.zip
unzip visium_spatialdata_0.7.1.zip                 # -> data.zarr  (Visium mouse brain, ~68 MB)

npm run make-spatial -- --input data.zarr --list   # which sections are in there
npm run make-spatial -- --input data.zarr --sample ST8059048
```

That writes `./spatial/st8059048` **and** `./cogs/st8059048-tissue` (the H&E
image as a tiled pyramid), then prints a ready-made gallery entry for the
browser example.

Three things it handles that a naive reader would get wrong:

- The store is **multi-sample** — one row block per section — so rows are
  filtered by the region column before anything is index-aligned.
- The **spot shapes carry the full-res → hires `scale`**, which is exactly the
  `imageRef.scale` the viewer needs. Skip it and every spot lands ~8.7× too far out.
- Nothing in the store states the image's µm/px, so it is derived by using
  Visium's known 100 µm spot pitch as a ruler.

A raw table carries only `array_row` / `array_col` / `in_tissue` / `spot_id`, so
the converter also derives `total_counts` and `n_genes_by_counts` from the
expression matrix — otherwise there is nothing meaningful to colour by.

`--genes N` keeps the N most-expressed genes (default 2,000; the full 31k
matrix would be ~370 MB). `scripts/make-pyramid.mjs` turns any other image into
the same pyramid format, if you need one without `vips`.

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
