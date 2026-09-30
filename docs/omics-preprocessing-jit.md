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
| **All-gene transcript pyramid** (`<id>.transcripts/`) | 10x groups transcripts per *gene* only; across all genes even the coarsest level is ~32 M clusters. Showing every transcript at any zoom needs a gene-independent grouping, which is one pass over all ~1.2 B transcripts. | `prepare-xenium --transcripts` (`lib/xenium/transcript-index.mjs`) | 7 levels, ~370 MB; ~40 min on 32 cores next to the data |

The server already has a **fallback** for the transcript pyramid: it builds it itself, in the
background, the first time it opens a dataset without one (`XENIUM_AUTO_INDEX=0` disables
it). That keeps a dataset usable, but it spends an hour of server CPU on first open; moving
the step into JIT makes it an explicit, scheduled job instead.

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
id, and which outputs to build (image, transcripts, or both).

| Step | Activity | Notes |
|---|---|---|
| 1 | **Detect** the bundle type and version | `experiment.xenium` → Xenium; the same workflow can later dispatch CosMx, MERSCOPE, Visium HD. |
| 2 | **Image pyramid** | Either port the logic to Java — Bio-Formats reads OME-TIFF and has a JPEG-2000 codec, so the existing conversion path may produce the pyramid directly — or run the Node script in the worker's container. Output must match the tile server's per-channel layout (`L{res}_c{c}.tif` + `descriptor.json`, 8-bit, windowed at the 99.8th percentile). |
| 3 | **Transcript pyramid** | Port `transcript-index.mjs` (about 250 lines: nested stored zips, Blosc/zstd zarr chunks, the cell-mask lookup) or run it as a Node step. Output format is documented in that file's header (`index.json` + `L{m}.bin`, 16-byte records). Parallel over the 1,242 source tiles — a natural fan-out of child activities. |
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
