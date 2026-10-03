// Make a 10x Xenium bundle ready to serve — the ONE step that cannot be done in place.
//
//   node scripts/prepare-xenium.mjs --source <bundle> --id <datasetId> [options]
//   npm run prepare-xenium -- --source https://…/WTA_Preview_FFPE_Cervical_Cancer_xe_outs.zip \
//                             --id xenium-cervical --register
//
// Everything else in a Xenium bundle — cells, polygons, transcripts, clusterings, the
// expression matrix, the density raster — is STORED inside the zip and read in place by
// lib/spatial-xenium.mjs, with no build step. The morphology OME-TIFFs are the exception:
// they are DEFLATED inside the zip, so no byte range of them can be read without
// inflating everything before it. This script does that once:
//
//   1. stream-inflate `morphology_focus/ch*.ome.tif` out of the bundle into --work
//      (resumable: a file already extracted at the right size is kept);
//   2. per channel, decode the OME-TIFF's own pyramid levels — main image and SubIFDs,
//      so nothing is re-downsampled — windowing the 16-bit signal to 8 bits at the
//      channel's 99.8th percentile, and write the server's per-channel pyramid
//      (`L{res}_c{c}.tif`);
//   3. write descriptor.json, so the tissue appears as `<id>-tissue` in $COG_DIR, which
//      is the image id the dataset's manifest points at.
//
// With --transcripts it also builds the ALL-GENE transcript grouping pyramid (see
// lib/xenium/transcript-index.mjs): 10x groups transcripts per gene only, and across all
// genes even its coarsest level is far too many markers to draw. That is a derived index,
// not a copy of the data — one pass over every transcript, a few hundred MB out.
//
// The tiles are JPEG-2000 (TIFF compression 34712), which libtiff — and so vips and
// sharp — cannot decode: they open the file and return zeros. They are decoded here with
// openjpeg (WebAssembly) on a pool of worker threads, and written with sharp.
//
// OPTIONS
//   --source      local _xe_outs.zip, unzipped outs/ dir, https:// URL or gs:// URL
//   --id          dataset id (the manifest's `<id>-tissue` image id follows from it)
//   --out         COG dir (default ./cogs)
//   --work        where extracted OME-TIFFs go (default ./.cache/xenium/<id>)
//   --channels    comma list of channel indices to build (default: all focus channels)
//   --percentile  window top, in percent of non-zero pixels (default 99.8)
//   --register    also write $XENIUM_DIR/<id>.json pointing at --source
//   --keep        keep the extracted OME-TIFFs (default: delete after building)
//   --transcripts build the all-gene transcript pyramid into --index-out
//   --index-out   default <bundle name>.transcripts next to a local bundle (X_xe_outs.zip →
//                 X_xe_outs.transcripts), or under $XENIUM_DIR for a remote one — copy it next
//                 to the bundle; that is where jit-service and the server look for it
//   --no-images   skip the image pyramid (e.g. to build only the transcript pyramid)
//   --force       rebuild outputs that are already complete (default: skip them)
//   --levels      transcript pyramid levels (default: as many as the image pyramid in --out,
//                 else 7)
//   --no-gene-levels  skip the per-gene levels (genes/): by default every level also gets each
//                 gene's bins, so a gene selection is drawn at any zoom from small reads
//
// Each output is built under `<dir>.partial` and moved into place only when complete, so an
// interrupted or concurrent run never leaves a half-written pyramid where the server reads.

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';

import { openByteSource } from '../lib/xenium/byte-source.mjs';
import { readZipDirectory, streamMember } from '../lib/xenium/zip.mjs';
import { readTiffPyramid } from '../lib/xenium/ome-tiff.mjs';
import {
  DEFAULT_LEVELS, buildTranscriptIndex, imagePyramidLevels, isLocalSource, transcriptPyramidName,
} from '../lib/xenium/transcript-index.mjs';

const TILE = 512;
const CHANNEL_COLORS = ['#3b6cff', '#34d058', '#ff4d4d', '#ff66ff', '#ffd33d', '#00d1d1'];

/** `ch0001_atp1a1_cd45_e-cadherin.ome.tif` → `ATP1A1 / CD45 / E-CADHERIN`. */
export function channelName(file) {
  const stem = path.basename(file).replace(/\.ome\.tif+$/i, '').replace(/^ch\d+_/, '');
  return stem.split('_').map((s) => s.toUpperCase()).join(' / ');
}

function parseArgs(argv) {
  const o = { out: 'cogs', percentile: 99.8, images: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--source') o.source = next();
    else if (a === '--id') o.id = next();
    else if (a === '--out') o.out = next();
    else if (a === '--work') o.work = next();
    else if (a === '--channels') o.channels = next().split(',').map(Number);
    else if (a === '--percentile') o.percentile = Number(next());
    else if (a === '--register') o.register = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--transcripts') o.transcripts = true;
    else if (a === '--index-out') o.indexOut = next();
    else if (a === '--no-images') o.images = false;
    else if (a === '--limit-tiles') o.limitTiles = Number(next());
    else if (a === '--force') o.force = true;
    else if (a === '--levels') o.levels = Number(next());
    else if (a === '--no-gene-levels') o.geneLevels = false;
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.source || !o.id) {
    throw new Error('usage: prepare-xenium --source <bundle> --id <datasetId> [--out cogs] [--register]');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.id)) throw new Error(`bad --id ${o.id}`);
  o.work ??= path.join('.cache', 'xenium', o.id);
  return o;
}

/** Whether a finished output is already in place (its last-written file exists). */
async function complete(dir, marker) {
  return (await sizeOf(path.join(dir, marker))) > 0;
}

/**
 * Build an output into `<dir>.partial`, then swap it in for `dir`. Readers see either the
 * old complete output or the new one, never a mix.
 */
async function buildInto(dir, build) {
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  await build(partial);
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);
}

async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

/** Extract (or locate) the focus OME-TIFFs. Returns local paths sorted by channel, and
 *  whether they were extracted (and so are ours to delete). */
async function focusImages(o) {
  const isDir = !/^(https?|gs):/.test(o.source) && (await stat(o.source)).isDirectory();
  if (isDir) {
    const dir = path.join(o.source, 'morphology_focus');
    const files = (await readdir(dir)).filter((f) => /\.ome\.tif+$/i.test(f)).sort();
    return { files: files.map((f) => path.join(dir, f)), extracted: false };
  }
  const src = await openByteSource(o.source);
  const entries = await readZipDirectory(src);
  const members = [...entries.values()]
    .filter((e) => /(^|\/)morphology_focus\/[^/]+\.ome\.tif+$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!members.length) throw new Error(`${o.source}: no morphology_focus/*.ome.tif in the bundle`);
  await mkdir(o.work, { recursive: true });
  const files = [];
  for (const e of members) {
    const file = path.join(o.work, path.basename(e.name));
    files.push(file);
    if ((await sizeOf(file)) === e.size) {
      console.log(`[prepare-xenium] have ${path.basename(file)} (${(e.size / 1e9).toFixed(2)} GB)`);
      continue;
    }
    console.log(`[prepare-xenium] extracting ${e.name} (${(e.size / 1e9).toFixed(2)} GB) …`);
    const t0 = Date.now();
    let last = 0;
    await streamMember(src, e, createWriteStream(`${file}.part`), {
      onProgress: (done, total) => {
        if (Date.now() - last < 10_000) return;
        last = Date.now();
        const mbps = done / 1e6 / ((Date.now() - t0) / 1000);
        console.log(`[prepare-xenium]   ${(100 * done / total).toFixed(1)}%  ${mbps.toFixed(0)} MB/s`);
      },
    });
    await rename(`${file}.part`, file);
  }
  await src.close();
  return { files, extracted: true };
}

/** A pool of tile-decoding workers with a promise per request. */
function workerPool(size) {
  const url = new URL('../lib/xenium/tile-decode-worker.mjs', import.meta.url);
  const workers = Array.from({ length: size }, () => new Worker(url));
  const pending = new Map();
  let nextId = 0;
  let turn = 0;
  for (const w of workers) {
    w.on('message', (m) => {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m);
    });
    w.on('error', (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });
  }
  return {
    decode(job) {
      const id = nextId++;
      const w = workers[turn++ % workers.length];
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, ...job });
      });
    },
    close: () => Promise.all(workers.map((w) => w.terminate())),
  };
}

/** Decode a whole level into an 8-bit buffer. With `histogram`, also sum the 16-bit histogram. */
async function decodeLevel(pool, file, level, gain, { histogram = false, onProgress } = {}) {
  const { width, height, tileWidth: tw, tileHeight: th } = level;
  const across = Math.ceil(width / tw);
  const down = Math.ceil(height / th);
  const out = Buffer.alloc(width * height);
  const hist = histogram ? new Float64Array(65536) : null;
  let done = 0;
  const jobs = [];
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const k = ty * across + tx;
      if (!level.byteCounts[k]) continue;
      jobs.push(pool.decode({
        file, offset: level.offsets[k], byteCount: level.byteCounts[k],
        compression: level.compression, width: tw, height: th, gain, histogram,
      }).then(({ pixels, hist: h }) => {
        const rows = Math.min(th, height - ty * th);
        const cols = Math.min(tw, width - tx * tw);
        for (let y = 0; y < rows; y++) {
          const src = pixels.subarray(y * tw, y * tw + cols);
          out.set(src, (ty * th + y) * width + tx * tw);
        }
        if (hist && h) for (let i = 0; i < 65536; i++) hist[i] += h[i];
        onProgress?.(++done, across * down);
      }));
    }
  }
  await Promise.all(jobs);
  return { pixels: out, hist };
}

/** The value below which `pct`% of the NON-ZERO pixels lie (zero is slide background). */
function percentileOf(hist, pct) {
  let total = 0;
  for (let v = 1; v < hist.length; v++) total += hist[v];
  if (!total) return 1;
  const want = (total * pct) / 100;
  let acc = 0;
  for (let v = 1; v < hist.length; v++) {
    acc += hist[v];
    if (acc >= want) return v;
  }
  return hist.length - 1;
}

async function writeLevel(file, pixels, width, height) {
  await sharp(pixels, { raw: { width, height, channels: 1 }, limitInputPixels: false })
    .tiff({ tile: true, tileWidth: TILE, tileHeight: TILE, compression: 'deflate', bigtiff: true })
    .toFile(file);
}

async function buildChannel(pool, file, c, outDir, percentile) {
  const levels = await readTiffPyramid(file);
  // The window, measured on a small level: the same distribution as full resolution at a
  // tiny fraction of the decode.
  const probeLevel = levels[Math.max(0, levels.length - 3)];
  const { hist } = await decodeLevel(pool, file, probeLevel, 0, { histogram: true });
  const top = percentileOf(hist, percentile);
  const gain = 255 / Math.max(top, 1);
  console.log(`[prepare-xenium] c${c} ${channelName(file)}: ${levels.length} levels, window 0..${top}`);

  const dims = [];
  let last = null;
  for (let res = 0; res < levels.length; res++) {
    const lv = levels[res];
    const t0 = Date.now();
    let shown = 0;
    const { pixels } = await decodeLevel(pool, file, lv, gain, {
      onProgress: (d, n) => {
        if (res === 0 && d / n >= shown + 0.25) {
          shown += 0.25;
          console.log(`[prepare-xenium]   L0 ${Math.round(100 * d / n)}%`);
        }
      },
    });
    await writeLevel(path.join(outDir, `L${res}_c${c}.tif`), pixels, lv.width, lv.height);
    dims.push({ res, width: lv.width, height: lv.height });
    console.log(`[prepare-xenium]   L${res} ${lv.width}x${lv.height} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    last = { pixels, width: lv.width, height: lv.height };
    if (Math.max(lv.width, lv.height) <= TILE) return dims;
  }
  // The file's own pyramid stops above one tile: halve until the coarsest level fits.
  for (let res = levels.length; Math.max(last.width, last.height) > TILE; res++) {
    const width = Math.max(1, Math.round(last.width / 2));
    const height = Math.max(1, Math.round(last.height / 2));
    const pixels = await sharp(last.pixels, { raw: { width: last.width, height: last.height, channels: 1 } })
      .resize(width, height, { fit: 'fill' }).raw().toBuffer();
    await writeLevel(path.join(outDir, `L${res}_c${c}.tif`), pixels, width, height);
    dims.push({ res, width, height });
    last = { pixels, width, height };
  }
  return dims;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  // The image first: the transcript pyramid takes its number of levels from it.
  if (o.images) await buildImages(o);
  if (o.transcripts) {
    // Named after the bundle (X_xe_outs.zip → X_xe_outs.transcripts) and kept next to it — where
    // jit-service and the example server look. A remote bundle's pyramid is built under
    // $XENIUM_DIR with that name, to be copied next to the bundle.
    const name = transcriptPyramidName(o.source);
    const out = o.indexOut ?? (isLocalSource(o.source)
      ? path.join(path.dirname(path.resolve(o.source)), name)
      : path.join(process.env.XENIUM_DIR || 'xenium', name));
    if (!o.force && await complete(out, 'index.json')) {
      console.log(`[prepare-xenium] transcript pyramid already built: ${out} (--force to rebuild)`);
    } else {
      // One transcript level per image level, so every zoom of the tissue has its own grouping.
      const levels = o.levels ?? await imagePyramidLevels(path.join(o.out, `${o.id}-tissue`)) ?? DEFAULT_LEVELS;
      console.log(`[prepare-xenium] transcript pyramid: ${levels} levels`);
      await buildInto(out, (dir) => buildTranscriptIndex(o.source, dir, {
        limitTiles: o.limitTiles ?? Infinity, levels, geneLevels: o.geneLevels !== false,
      }));
      if (!isLocalSource(o.source)) {
        const next = o.source.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/[^/]*$/, name);
        console.log(`[prepare-xenium] built ${out}; copy it next to the bundle as ${next}`);
      }
    }
  }
  if (o.register) {
    const dir = process.env.XENIUM_DIR || 'xenium';
    await mkdir(dir, { recursive: true });
    const cfg = path.join(dir, `${o.id}.json`);
    await writeFile(cfg, JSON.stringify({ name: o.id, source: o.source }, null, 2));
    console.log(`[prepare-xenium] registered ${cfg}`);
  }
}

async function buildImages(o) {
  const finalDir = path.join(o.out, `${o.id}-tissue`);
  if (!o.force && await complete(finalDir, 'descriptor.json')) {
    console.log(`[prepare-xenium] image pyramid already built: ${finalDir} (--force to rebuild)`);
    return;
  }
  await buildInto(finalDir, (outDir) => buildImagePyramid(o, outDir));
  console.log(`[prepare-xenium] pyramid ready: ${finalDir}`);
}

async function buildImagePyramid(o, outDir) {
  const { files, extracted } = await focusImages(o);
  const channels = o.channels ?? files.map((_f, i) => i);

  const pool = workerPool(Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));
  let levels = null;
  try {
    for (const [i, c] of channels.entries()) {
      const dims = await buildChannel(pool, files[c], i, outDir, o.percentile);
      levels ??= dims;
    }
  } finally {
    await pool.close();
  }

  const mpp = 0.2125; // Xenium's morphology pixel size; experiment.xenium says the same.
  const descriptor = {
    width: levels[0].width,
    height: levels[0].height,
    tileSize: TILE,
    z: 1,
    channels: channels.length,
    multichannel: channels.length > 1,
    realLevels: levels.length,
    channelInfo: channels.length > 1 ? channels.map((c, i) => ({
      name: channelName(files[c]),
      color: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
      bitDepth: 8,
      minAllowed: 0,
      maxAllowed: 255,
    })) : null,
    levels,
    mppX: mpp,
    mppY: mpp,
  };
  await writeFile(path.join(outDir, 'descriptor.json'), JSON.stringify(descriptor, null, 2));
  if (extracted && !o.keep) await rm(o.work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`[prepare-xenium] ${err.stack ?? err.message}`);
  process.exit(1);
});
