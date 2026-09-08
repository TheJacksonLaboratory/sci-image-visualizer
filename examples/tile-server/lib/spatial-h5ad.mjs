// Serve the spatial-omics endpoints from a plain `.h5ad` dropped into `$H5AD_DIR`.
//
// The fifth source, and the most convenient one: no conversion command, no store to
// prepare. Point `$H5AD_DIR` at a directory of `*.h5ad` files and each appears on
// `/spatial/datasets` with its columns, genes and embeddings inferred from the file.
//
// WHICH WAY ROUND `X` IS STORED DECIDES WHAT THIS COSTS
// ----------------------------------------------------
// A gene is a COLUMN, and colouring by one gene is the interaction this has to be fast at.
//
//   * CSC — served DIRECTLY. Gene `j` occupies `indptr[j] .. indptr[j+1]`, so one gene is
//     two hyperslab reads of a few kB. Only the 72 kB `indptr` is cached. Measured on an
//     uncompressed file: sub-millisecond, the same as a bundle.
//
//   * CSR — CONVERTED to a bundle in `.cache/h5ad/<id>` on first open, then served from
//     there. Gene `j` is scattered across every row, so reading one means walking the
//     whole `indices` array: measured at 122 ms and 118 MB for a single gene on the
//     Visium file. Caching the matrix instead would cost that 118 MB per dataset resident
//     and still scan 15 M entries per gene. Converting once costs 1.2 s and 186 MB of
//     disk, and every read afterwards is a 10.7 kB ranged read.
//
// scanpy writes CSR by default, so the conversion branch is the common one — which is why
// it is automatic rather than an error telling you to go and run a script.
//
// Everything here is READ-ONLY with respect to the `.h5ad`. The conversion writes a
// derived bundle beside it under `.cache/`; the source file is never modified.

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  attr, categoriesFor, encodingOf, geneNames, indexKey, obsCount, obsmArray, openH5ad,
  shapeOf, unsValue,
} from './h5ad.mjs';
import { defaultRadius, writeBundle } from './h5ad-bundle.mjs';
import {
  loadManifest, readColumn, readEmbedding, readFeatureVector, readIds,
  searchFeatures as bundleSearchFeatures,
} from './spatial.mjs';

/** Where a converted CSR file lands. Derived data, so it sits under `.cache/`. */
const CACHE_ROOT = new URL('../.cache/h5ad', import.meta.url).pathname;

/** Per-dataset lazy state, and the in-flight conversion promises. */
const cache = new Map();
const conversions = new Map();

const slot = (id) => {
  if (!cache.has(id)) cache.set(id, {});
  return cache.get(id);
};

/** Drop every cached read — used by tests and after a directory changes. */
export function clearH5adCaches() {
  for (const s of cache.values()) s.file?.close?.();
  cache.clear();
  conversions.clear();
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Symlinks count: a 329 MB `.h5ad` is far more likely to be linked in than copied,
    // and `isFile()` is false for a symlink dirent — the same way `./stores` is used.
    return entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && /\.h5ad$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** `file.h5ad` -> `file`. The id a request names. */
const idFor = (fileName) => fileName.replace(/\.h5ad$/i, '');

async function fileFor(dir, id) {
  for (const name of await listFiles(dir)) {
    if (idFor(name) === id) return path.join(dir, name);
  }
  return null;
}

/**
 * What this file offers, inferred once.
 *
 * Inferred rather than configured, because the whole point is dropping a file in. The
 * rules mirror what `spatial-zarr.mjs` does for a store, so the two drop-in paths agree:
 * a categorical obs column is one with categories, a continuous one is anything numeric,
 * and an embedding is any `obsm` array of 2 or 3 columns other than the coordinates.
 */
async function describe(dir, id) {
  const s = slot(id);
  if (s.described) return s.described;

  const file = await fileFor(dir, id);
  if (!file) throw new RangeError(`unknown dataset: ${id}`);
  const f = await openH5ad(file);
  try {
    const n = obsCount(f);
    const [, nVar] = shapeOf(f);
    const encoding = encodingOf(f.get('X'));

    const obs = f.get('obs');
    const obsIndex = indexKey(obs);
    const columns = [];
    for (const name of obs.keys()) {
      if (name === obsIndex || name === '__categories' || name.startsWith('_')) continue;
      const categories = categoriesFor(f, name);
      if (categories) {
        // A u16 code has to hold it, and a categorical past the renderer's ceiling is
        // still worth serving — the 2D markers and the charts have no such limit.
        if (categories.length <= 0xffff) columns.push({ name, kind: 'categorical' });
        continue;
      }
      const node = f.get(`obs/${name}`);
      // Strings carry no encoding; ids and free text are not colourings.
      if (node?.type === 'Group' || String(node?.dtype ?? '').includes('S')) continue;
      columns.push({ name, kind: 'continuous' });
    }

    const obsmGroup = f.get('obsm');
    const spatialKey = obsmGroup?.keys?.().includes('spatial') ? 'spatial' : null;
    if (!spatialKey) throw new Error(`${id}: no obsm/spatial to place the observations`);
    const embeddings = [];
    for (const key of obsmGroup.keys()) {
      if (key === spatialKey) continue;
      const node = f.get(`obsm/${key}`);
      const dims = node?.shape?.length === 2 ? Number(node.shape[1]) : 0;
      // Anything wider is skipped rather than truncated: `X_pca` is routinely 50
      // components, and its first two are not "the PCA" a label would promise.
      if (dims !== 2 && dims !== 3) continue;
      embeddings.push({ key, label: embeddingLabel(key), dims });
    }

    const coords = obsmArray(f, spatialKey);
    const described = {
      file,
      id,
      encoding,
      count: n,
      nVar,
      spatialKey,
      columns,
      embeddings,
      dims: coords.dims,
      radius: defaultRadius(coords.flat, n, coords.dims),
      name: `${id} · ${n.toLocaleString()} observations`,
      genes: geneNames(f),
      visium: visiumLibrary(f),
    };
    s.described = described;
    return described;
  } finally {
    f.close();
  }
}

/** Pretty label for an `obsm` key, matching what the bundle converter writes. */
function embeddingLabel(key) {
  const stem = key.replace(/^X_/, '');
  const dims3 = /3d$/i.test(stem);
  const base = stem.replace(/3d$/i, '');
  const known = { umap: 'UMAP', pca: 'PCA', tsne: 't-SNE', diffmap: 'Diffusion map' };
  const label = known[base.toLowerCase()] ?? base;
  return dims3 ? `${label} 3D` : label;
}

/** The Visium library name, when this file carries a tissue image. */
function visiumLibrary(f) {
  const uns = f.get('uns');
  if (!uns?.keys?.().includes('spatial')) return null;
  const libs = f.get('uns/spatial').keys();
  return libs.length ? libs[0] : null;
}

// ── the CSR route: convert once, then read the bundle ────────────────────────

/**
 * The bundle directory for a CSR file, converting it if this is the first request.
 *
 * One conversion per dataset even under concurrent requests: the promise is cached, not
 * the result, so a second request awaits the first rather than starting its own and
 * writing the same files underneath it.
 */
async function bundleDir(dir, id) {
  const described = await describe(dir, id);
  // The dataset directory. Callers get CACHE_ROOT back, because every `spatial.mjs`
  // reader takes a spatialDir and joins the id on itself.
  const out = path.join(CACHE_ROOT, id);
  if (!conversions.has(id)) {
    conversions.set(id, (async () => {
      // Reuse a conversion from an earlier run, but only if it is NEWER than the file it
      // came from — an edited `.h5ad` must not be served from a stale bundle.
      try {
        const [bundle, source] = await Promise.all([
          stat(path.join(out, 'manifest.json')),
          stat(described.file),
        ]);
        if (bundle.mtimeMs >= source.mtimeMs) return CACHE_ROOT;
      } catch { /* not built yet */ }
      console.log(`[tile-server] converting ${id} (CSR) -> ${out}`);
      const started = Date.now();
      await rm(out, { recursive: true, force: true });
      await mkdir(out, { recursive: true });
      await writeBundle({
        h5ad: described.file,
        out,
        id,
        name: described.name,
        spatialKey: described.spatialKey,
        columns: described.columns,
        embeddings: described.embeddings,
        radius: described.radius,
        imageRef: await imageRefFor(dir, id),
      });
      console.log(`[tile-server] converted ${id} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return CACHE_ROOT;
    })().catch((err) => {
      // A failed conversion must not be cached, or the dataset is broken until restart.
      conversions.delete(id);
      throw err;
    }));
  }
  return conversions.get(id);
}

const isCsr = (described) => described.encoding === 'csr_matrix';

// ── the CSC route: hyperslab reads straight out of the file ──────────────────

/** The open file handle and cached `indptr`, for direct reads. */
async function direct(dir, id) {
  const s = slot(id);
  if (s.direct) return s.direct;
  const described = await describe(dir, id);
  const f = await openH5ad(described.file);
  s.file = f;
  s.direct = { described, f, indptr: f.get('X/indptr').value };
  return s.direct;
}

// ── registration, when the file carries a Visium image ───────────────────────

/**
 * `imageRef` for a Visium file, or null.
 *
 * The physical scale is MEASURED from the spot lattice, not read from
 * `scalefactors/spot_diameter_fullres` — that field works out at 65 µm against a measured
 * lattice rather than the 55 µm capture spot, an 18% error in every distance with nothing
 * to give it away. The pitch is 100 µm by the slide's construction, and `array_row` /
 * `array_col` say where each spot sits on it. See `scripts/visium-image.mjs`, which prints
 * the same numbers and the comparison.
 */
async function imageRefFor(dir, id) {
  const described = await describe(dir, id);
  if (!described.visium) return null;
  const f = await openH5ad(described.file);
  try {
    const base = `uns/spatial/${described.visium}`;
    const sf = f.get(`${base}/scalefactors`);
    if (!sf?.keys?.().includes('tissue_hires_scalef')) return null;
    const scalef = Number(f.get(`${base}/scalefactors/tissue_hires_scalef`).value);
    if (!(scalef > 0)) return null;

    const obs = f.get('obs');
    if (!obs.keys().includes('array_row') || !obs.keys().includes('array_col')) return null;
    const coords = obsmArray(f, described.spatialKey);
    const rows = Array.from(f.get('obs/array_row').value, Number);
    const cols = Array.from(f.get('obs/array_col').value, Number);
    const dx = Math.abs(slope(cols, coords, 0));
    const dy = Math.abs(slope(rows, coords, 1));
    if (!(dx > 0 && dy > 0)) return null;
    const sameRow = 2 * dx;
    const diagonal = Math.hypot(dx, dy);
    // A lattice that is not a regular hexagon means the coordinates are not
    // full-resolution pixels, and no arithmetic downstream would fix that.
    if (Math.abs(diagonal / sameRow - 1) > 0.02) return null;
    const umPerFullres = 100 / ((sameRow + diagonal) / 2);
    const umPerServed = umPerFullres / scalef;
    return {
      imageId: `${id}-tissue`,
      scale: [scalef, scalef],
      translate: [0, 0],
      mppX: umPerServed,
      mppY: umPerServed,
    };
  } finally {
    f.close();
  }
}

/** Least-squares slope of one coordinate against a lattice index. */
function slope(index, coords, axis) {
  const n = coords.rows;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = index[i];
    const y = Number(coords.flat[i * coords.dims + axis]);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

// ── the endpoints ────────────────────────────────────────────────────────────

/** Summaries for `/spatial/datasets`. */
export async function listH5adDatasets(dir) {
  const out = [];
  for (const name of await listFiles(dir)) {
    const id = idFor(name);
    try {
      const described = await describe(dir, id);
      out.push({ id, name: described.name, count: described.count, source: 'h5ad' });
    } catch {
      // A file this cannot read is skipped rather than breaking the listing.
    }
  }
  return out;
}

export async function h5adManifest(dir, id) {
  const described = await describe(dir, id);
  if (isCsr(described)) return loadManifest(await bundleDir(dir, id), id);

  const s = slot(id);
  if (s.manifest) return s.manifest;
  s.manifest = {
    version: 1,
    id,
    name: described.name,
    count: described.count,
    hasIds: true,
    radius: { mode: 'uniform', value: described.radius },
    columns: await describedColumns(dir, id),
    features: { count: described.genes.length, names: described.genes },
    ...(described.dims === 3 ? { hasZ: true } : {}),
    ...(described.embeddings.length
      ? {
        embeddings: described.embeddings.map((e) => ({
          name: e.key, label: e.label, dims: e.dims,
        })),
      }
      : {}),
    ...((await imageRefFor(dir, id)) ? { imageRef: await imageRefFor(dir, id) } : {}),
  };
  return s.manifest;
}

/** Column metadata, with categories and any published palette. */
async function describedColumns(dir, id) {
  const described = await describe(dir, id);
  const f = await openH5ad(described.file);
  try {
    return described.columns.map(({ name, kind }) => {
      if (kind !== 'categorical') {
        return { kind: 'continuous', name, logScaleHint: /counts|umi|total/i.test(name) };
      }
      const categories = categoriesFor(f, name) ?? [];
      const colors = unsValue(f, `${name}_colors`);
      return {
        kind: 'categorical',
        name,
        categories,
        ...(colors ? { colors: Array.from(colors, String).slice(0, categories.length) } : {}),
      };
    });
  } finally {
    f.close();
  }
}

export async function h5adCoords(dir, id) {
  const described = await describe(dir, id);
  // The converted bundle's coords.bin is already in wire layout, so it is handed back as
  // bytes rather than streamed — the route sends a Buffer for every non-bundle source.
  if (isCsr(described)) return readFile(path.join(await bundleDir(dir, id), id, 'coords.bin'));
  const f = await openH5ad(described.file);
  try {
    const coords = obsmArray(f, described.spatialKey);
    const out = new Float32Array(coords.rows * coords.dims);
    for (let d = 0; d < coords.dims; d++) {
      for (let i = 0; i < coords.rows; i++) {
        out[d * coords.rows + i] = Number(coords.flat[i * coords.dims + d]);
      }
    }
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  } finally {
    f.close();
  }
}

export async function h5adIds(dir, id) {
  const described = await describe(dir, id);
  if (isCsr(described)) return readIds(await bundleDir(dir, id), id);
  const f = await openH5ad(described.file);
  try {
    const obs = f.get('obs');
    return { ids: Array.from(f.get(`obs/${indexKey(obs)}`).value, String) };
  } finally {
    f.close();
  }
}

export async function h5adColumn(dir, id, name) {
  const described = await describe(dir, id);
  if (isCsr(described)) return readColumn(await bundleDir(dir, id), id, name);
  const spec = described.columns.find((c) => c.name === name);
  if (!spec) throw new RangeError(`unknown column: ${name}`);
  const { codesFor, continuousFor } = await import('./h5ad.mjs');
  const f = await openH5ad(described.file);
  try {
    const values = spec.kind === 'categorical' ? codesFor(f, name) : continuousFor(f, name);
    return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  } finally {
    f.close();
  }
}

/**
 * One gene, from a CSC file, as `f32[N]`.
 *
 * Two hyperslab reads of that gene's slice — this is the whole reason a CSC file needs no
 * conversion. The `indptr` is cached; nothing else is held.
 */
export async function h5adFeature(dir, id, name) {
  const described = await describe(dir, id);
  if (isCsr(described)) return readFeatureVector(await bundleDir(dir, id), id, name);
  const j = described.genes.indexOf(name);
  if (j < 0) throw new RangeError(`unknown feature: ${name}`);
  const { f, indptr } = await direct(dir, id);
  const from = Number(indptr[j]);
  const to = Number(indptr[j + 1]);
  const out = new Float32Array(described.count);
  if (to > from) {
    const indices = f.get('X/indices').slice([[from, to]]);
    const data = f.get('X/data').slice([[from, to]]);
    for (let k = 0; k < indices.length; k++) out[Number(indices[k])] = data[k];
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

export async function h5adFeatureSearch(dir, id, query, limit = 50) {
  const described = await describe(dir, id);
  if (isCsr(described)) return bundleSearchFeatures(await bundleDir(dir, id), id, query, limit);
  const q = String(query ?? '').toLowerCase();
  if (!q) return described.genes.slice(0, limit);
  const prefix = [];
  const contains = [];
  for (const gene of described.genes) {
    const lower = gene.toLowerCase();
    if (lower.startsWith(q)) prefix.push(gene);
    else if (lower.includes(q)) contains.push(gene);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}

export async function h5adEmbedding(dir, id, name) {
  const described = await describe(dir, id);
  if (isCsr(described)) return readEmbedding(await bundleDir(dir, id), id, name);
  const meta = described.embeddings.find((e) => e.key === name);
  if (!meta) throw new RangeError(`unknown embedding: ${name}`);
  const f = await openH5ad(described.file);
  try {
    const emb = obsmArray(f, name);
    const out = new Float32Array(emb.rows * emb.dims);
    for (let d = 0; d < emb.dims; d++) {
      for (let i = 0; i < emb.rows; i++) {
        out[d * emb.rows + i] = Number(emb.flat[i * emb.dims + d]);
      }
    }
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  } finally {
    f.close();
  }
}

/**
 * The tissue image's pixels, for the pyramid builder.
 *
 * The `hires` tier, which is what a Visium `.h5ad` ships — a downscale of the resolution
 * the coordinates are in, which is exactly what `imageRef.scale` accounts for.
 */
export async function h5adImageSource(dir, id) {
  const described = await describe(dir, id);
  if (!described.visium) throw new RangeError(`no image for dataset ${id}`);
  const f = await openH5ad(described.file);
  try {
    const images = f.get(`uns/spatial/${described.visium}/images`);
    const tier = images?.keys?.().includes('hires') ? 'hires' : images?.keys?.()?.[0];
    if (!tier) throw new RangeError(`no image for dataset ${id}`);
    const node = f.get(`uns/spatial/${described.visium}/images/${tier}`);
    const [height, width, channels] = node.shape.map(Number);
    const flat = node.value;
    // squidpy stores these as float32 in 0..1, but not always — the range decides rather
    // than the dtype, because a misread range is a black or blown-out slide.
    let peak = 0;
    for (let i = 0; i < flat.length; i++) if (flat[i] > peak) peak = flat[i];
    const scale = peak <= 1 ? 255 : 1;
    const rgb = Buffer.allocUnsafe(width * height * 3);
    for (let i = 0, o = 0; i < width * height; i++, o += 3) {
      for (let c = 0; c < 3; c++) {
        const v = flat[i * channels + c] * scale;
        rgb[o + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
    const ref = await imageRefFor(dir, id);
    return { rgb, width, height, mpp: ref?.mppX ?? null };
  } finally {
    f.close();
  }
}

/** Whether this directory owns `id` — used by the server to pick a source. */
export async function h5adHas(dir, id) {
  return (await fileFor(dir, id)) !== null;
}
