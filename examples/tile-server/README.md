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

Real data goes through the **Node** converter — no Python. These stores are
Zarr v3 with `bytes` + `zstd` codecs and `vlen-utf8` strings, and Node 24 ships
zstd in `node:zlib` (`lib/zarr3.mjs`); the shapes are GeoParquet, which
`hyparquet` reads and decodes to GeoJSON (`lib/geoparquet.mjs`).

```bash
npm run make-spatial -- --input data.zarr --list      # tables / shapes / images

# Visium — spot centres in obsm/spatial, one uniform 55 um spot radius
npm run make-spatial -- --input data.zarr --sample ST8059048 \
  --id st8059048 --name "Visium mouse brain — ST8059048"

# Visium HD — CELL SEGMENTATIONS: 84k cells with real boundaries
npm run make-spatial -- --input data.zarr --table cell_segmentations \
  --id hd-cells --grid-um 2 --name "Visium HD mouse brain — cell segmentations"
```

Each run writes `./spatial/<id>` **and** `./cogs/<id>-tissue` (the tissue image
as a tiled pyramid), then prints a ready-made gallery entry for the browser
example.

### The two store shapes it handles

| | Visium | Visium HD / Xenium |
|---|---|---|
| Tables | one `table` | one per segmentation (`cell_segmentations`, …) |
| Positions | `obsm/spatial` | **`obsm` is empty** — centroids come from the shapes GeoParquet |
| Size | one uniform spot radius | per-cell equivalent-circle radius from the outline area |
| Boundaries | none | real outlines, served on `/polygons` |
| `imageRef.scale` | ~0.115 | ~0.281 |

### Things a naive reader gets wrong

- A table can be **multi-sample** (one row block per section), so rows must be
  filtered by the region column before anything is index-aligned.
- The **shapes** carry the transform into the image's coordinate system, and
  that scale *is* `imageRef.scale`. Skip it and observations land 3.5–8.7× too
  far out.
- The pyramid level is **named by the multiscales metadata** — `0` for Visium,
  `s0` for HD — and the coordinate system is stated there too.
- Zarr v3 **omits a chunk that is entirely `fill_value`**, so a single-region
  table has no `region/codes` chunk at all. Treating that as an error rejects a
  valid store.
- Segmentation rows are joined to table rows **by id**, not by position.

### Derived values

The sandbox stores are **raw**: their tables carry ids, array indices and
`in_tissue` and nothing else — no clusters, no cell types. A viewer demo built
on them would have nothing to put in a legend, split a violin by, or select a
category of. So the converter derives:

| column | how |
|---|---|
| `total_counts`, `n_genes_by_counts` | from the expression matrix, free in the pass that transposes it |
| `area` | segmentation outline area (polygon stores only) |
| `cluster` | **k-means** on log1p-normalised expression (`--cluster K`, default 8; `0` disables) |

Clustering normalises each observation to a common total before `log1p` —
without that it follows sequencing depth and the clusters come out as concentric
count bands rather than anatomy. It fits centroids on an even subsample (84k
cells is minutes in plain JS otherwise), picks the 50 most variable genes,
seeds with k-means++ from a fixed seed so a rebuild is identical, and relabels
largest-cluster-first so legends read consistently.

This is a **demo-data convenience, not an analysis tool** — the column's
`description` says so, and the viewer surfaces it. Real work belongs in
scanpy/squidpy.

Columns that carry no encoding are dropped: identifiers (a distinct integer per
observation, like `spot_id`) and columns that are constant after filtering (like
`in_tissue`, once out-of-tissue rows are gone).

`--grid-um U` turns the outlines into a ruler: a segmentation traced on a binned
assay steps one bin at a time, so the modal vertex step *is* one bin — asserting
its physical size (2 µm for Visium HD) yields the image's µm/px and a correct
scale bar. For Visium the same job is done by the known 100 µm spot pitch.

`--genes N` keeps the N most-expressed (default 2,000), and `--max-matrix-mb`
caps the output: the gene-major matrix is `genes x N x 4` bytes, so 84k cells
would be 672 MB at 2,000 genes — it is capped to 190 genes at the 64 MB default.

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
