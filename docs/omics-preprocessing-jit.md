# Omics preprocessing in JIT — work to be done

**Status:** planned, not started. Today the preprocessing runs from the example tile server
(`examples/tile-server/scripts/prepare-xenium.mjs`), by hand or in Cloud Build. The goal is to
run it from JIT on any dataset, through the conversion worker, so a user can prepare a dataset
from the JIT UI without a terminal.

Tracking: follow-up to [#30](https://github.com/TheJacksonLaboratory/sci-image-visualizer/issues/30).

## What needs preprocessing, and why

A 10x Xenium bundle is served **in place** — cells, cell/nucleus outlines at every level of
detail, per-gene transcripts, clusterings, the expression matrix and per-gene density are all
read straight from the zip by `lib/spatial-xenium.mjs`. Two things cannot be:

| Output | Why it cannot be read in place | Tool today | Size / time (cervical WTA preview) |
|---|---|---|---|
| **Morphology image pyramid** (`<id>-tissue/`) | The OME-TIFFs are *deflated* inside the zip (no byte range is readable without inflating everything before it), and their tiles are **JPEG-2000** (TIFF compression 34712), which libtiff — so vips and sharp — decodes as zeros. | `prepare-xenium` (openjpeg on a worker pool, sharp writer) | 4 channels × 8 levels, ~7.3 GB; ~2.5 min/channel on 8 cores |
| **Cell embeddings** (PCA, UMAP) — *planned* | Not in this bundle: `analysis.zarr.zip` carries only the 10 clusterings (older Xenium outputs shipped `analysis/umap`, `analysis/pca` CSVs; this preview does not). They have to be computed from the cell × gene counts. | not yet — see below | 717,576 cells × 18,028 genes, ~611 M non-zeros; PCA minutes, UMAP ~30–60 min on a large machine (estimate) |
| **All-gene transcript pyramid** (`<id>.transcripts/`) | 10x groups transcripts per *gene* only; across all genes even the coarsest level is ~32 M clusters. Showing every transcript at any zoom needs a gene-independent grouping, which is one pass over all ~1.2 B transcripts. | `prepare-xenium --transcripts` (`lib/xenium/transcript-index.mjs`) | 7 levels, ~370 MB; ~40 min on 32 cores next to the data |

The server already has a **fallback** for the transcript pyramid: it builds it itself, in the
background, the first time it opens a dataset without one (`XENIUM_AUTO_INDEX=0` disables
it). That keeps a dataset usable, but it spends an hour of server CPU on first open; moving
the step into JIT makes it an explicit, scheduled job instead.

## Cell embeddings (planned)

The viewer already shows embeddings (UMAP / PCA views over the same observations) for
datasets that publish them — the Visium mouse brain `.h5ad` carries `obsm/X_umap`. A Xenium
bundle does not, so they are a third preprocessing output.

**Why the existing tool does not carry over.** `scripts/compute-embeddings.mjs` reads a
bundle's *dense* gene-major matrix (`features/matrix.f32`) and runs an *exact* t-SNE. At
717,576 × 27,105 the dense matrix alone is ~78 GB, and an O(N²) t-SNE is out of reach.
Needed instead, reading the bundle's sparse `cell_feature_matrix.zarr.zip` directly:

1. Real genes only (drop the negative-control probes, as the transcript pyramid does);
   library-size normalise and `log1p`.
2. Highly variable genes (~2,000), from per-gene mean/variance over the gene-major CSR —
   one pass.
3. PCA to 50 components by randomized SVD on the sparse HVG matrix (centring applied
   implicitly, never densified).
4. UMAP on the 50-D PCA space with approximate nearest neighbours (`umap-js` is already a
   dependency; at this size a native implementation may be needed — measure first).
   t-SNE only on a subsample, if at all.

**Output and contract.** `<id>.embeddings/` next to the other outputs: per embedding a
struct-of-arrays `f32` file (x, then y, then z — the `/embedding/:name` wire layout) plus a
small JSON with `dims`, `derived: true`, `params` (e.g. "HVG 2000, PCA 50, UMAP n=15"), and
PCA's `varianceRatio`. The server advertises them in the manifest's `embeddings` like any
other source, marked derived so they are not mistaken for 10x's own.

Tracked as its own follow-up issue; it belongs in the same workflow as the two outputs
above.

## Where it goes in JIT

Format conversion currently runs as Temporal workflows on the **Convert** task queue of
`jit-slide-worker` (module of `jit-parent`; see its README — queues Segmentation, Find,
Convert, Store, ClassificationSave). The request is to run omics preprocessing through the
conversion worker ("jit-convert-worker"). No repository or module by that name exists yet, so
the first decision is:

1. **Extend the Convert queue in `jit-slide-worker`** with an omics workflow — least new
   infrastructure; shares the worker's GCS/NIO storage, cache and concurrency settings
   (`CONVERT_MAX`).
2. **A dedicated `jit-convert-worker`** (new module in `jit-parent`) that owns all conversion,
   image and omics — cleaner separation if conversion keeps growing, and lets the omics job
   get its own machine size (the transcript pass wants many cores and ~16 GB).

Either way the job is a Temporal workflow, so it gets retries, progress and cancellation the
same way image conversion does.

## Proposed workflow: `OmicsPrepareWorkflow`

Input: the bundle's location (GCS URI of the `_xe_outs.zip`, or an `outs/` prefix), a dataset
id, and which outputs to build (image, transcripts, embeddings — any subset).

| Step | Activity | Notes |
|---|---|---|
| 1 | **Detect** the bundle type and version | `experiment.xenium` → Xenium; the same workflow can later dispatch CosMx, MERSCOPE, Visium HD. |
| 2 | **Image pyramid** | Either port the logic to Java — Bio-Formats reads OME-TIFF and has a JPEG-2000 codec, so the existing conversion path may produce the pyramid directly — or run the Node script in the worker's container. Output must match the tile server's per-channel layout (`L{res}_c{c}.tif` + `descriptor.json`, 8-bit, windowed at the 99.8th percentile). |
| 3 | **Transcript pyramid** | Port `transcript-index.mjs` (about 250 lines: nested stored zips, Blosc/zstd zarr chunks, the cell-mask lookup) or run it as a Node step. Output format is documented in that file's header (`index.json` + `L{m}.bin`, 16-byte records). Parallel over the 1,242 source tiles — a natural fan-out of child activities. |
| 3b | **Embeddings** (planned) | Sparse normalise → HVG → randomized PCA → UMAP, as in *Cell embeddings* above. CPU- and memory-heavy for the UMAP step; a separate activity so it can get its own machine size and be skipped. |
| 4 | **Store** next to the bundle | e.g. `gs://…/omics/<dataset>/<id>-tissue/` and `…/<id>.transcripts/`, via the Store queue / jit-io. |
| 5 | **Register** | Write the dataset config the server discovers (`<id>.json` with `source`, optional `cellTypes`, `transcriptIndex`), or the JIT-side equivalent record. |

Progress for the UI: tiles done / total (the builder already reports it through `onProgress`).

## Contract with the server (must stay stable)

- Image: `$COG_DIR/<id>-tissue/` — the id the manifest advertises as `imageRef.imageId`.
- Transcript pyramid: `$XENIUM_DIR/<id>.transcripts/` (or the path in the dataset config's
  `transcriptIndex`) with `index.json` `version: 1`. The server advertises it as
  `transcriptBins` and serves `GET /spatial/:id/transcript-bins/:level/:tx/:ty`.
- A partially written output must never look finished: write to a temporary prefix and move
  it into place at the end (the server's fallback does `<dir>.partial` → `<dir>`).

## Open questions

- Java port vs. a Node step in the worker image (the Node code has no native dependencies
  beyond sharp for writing TIFFs, and `@cornerstonejs/codec-openjpeg` is WebAssembly).
- Idempotency key: bundle checksum or GCS generation, so re-running on an unchanged bundle is
  a no-op, and a changed bundle rebuilds.
- Trigger: an explicit "Prepare for viewing" action in JIT, automatic on upload to the
  omics bucket, or both.
- Access control for the outputs, which inherit the bundle's (sample data vs. private data).
