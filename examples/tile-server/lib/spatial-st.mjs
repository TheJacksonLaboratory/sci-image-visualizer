// Serve the spatial-omics endpoints from a LEGACY Spatial Transcriptomics
// dataset — the pre-Visium format: gzipped TSV count matrices, separate
// brightfield HE JPEGs, and "spot selection" tables mapping array coordinates to
// image pixels.
//
// Built for the Andersson et al. HER2+ breast cancer deposition
// (https://zenodo.org/records/4751624), which is the shape this format takes in
// the wild: four AES-encrypted zips whose passwords the authors publish in their
// own README. Nothing here is Zenodo-specific beyond the file names.
//
// WHY A SEPARATE SOURCE FROM spatial-zarr.mjs
// -------------------------------------------
// There is no SpatialData store to read: no Zarr, no AnnData, no coordinate
// transformations, no `obsm`. The join between expression and position is by
// ARRAY COORDINATE (`{x}x{y}`) across two files, and positions are already in
// the HE image's pixel space. Forcing that through the Zarr reader would help
// neither.
//
// WHAT IT COSTS
// -------------
// A section is small — ~350 spots x ~15k genes — so its matrix is parsed once
// and kept TRANSPOSED to gene-major (~21 MB), which makes a gene a contiguous
// slice rather than a scan. That is the layout spatial-zarr.mjs cannot afford
// for 84k cells, and can here.

import { readdir, readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import { openZip, openZipRanged } from './zip-aes.mjs';
import { kmeansClusters } from './cluster.mjs';

/** Legacy ST arrays: 100 µm spots on a 200 µm centre-to-centre grid. */
const ST_RADIUS_OVER_PITCH = 50 / 200;
const ST_PITCH_UM = 200;
const CLUSTER_K = 8;
/** Feature names are inlined in the manifest below this count. */
const INLINE_NAMES_LIMIT = 2000;

const ARCHIVES = {
  counts: 'count-matrices.zip',
  selections: 'spot-selections.zip',
  meta: 'meta.zip',
  images: 'images.zip',
};

/** bundleName -> { dir, config, sections }, built once. */
let registry = null;
/** datasetId -> lazily-populated caches. */
const cache = new Map();

const listDirs = async (p) => (await readdir(p, { withFileTypes: true }).catch(() => []))
  .filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);

/**
 * Per-bundle `config.json`, holding the archive passwords.
 *
 * Kept in a sidecar rather than in source: they are the depositor's published
 * passwords, not ours to embed. The example's README carries the values from the
 * authors' own README so setup stays copy-paste.
 *
 *   st/her2/config.json  ->  { "dataPassword": "…", "metaPassword": "…" }
 */
async function loadConfig(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function buildRegistry(stDir) {
  const bundles = new Map();
  for (const name of await listDirs(stDir)) {
    const dir = path.join(stDir, name);
    const counts = path.join(dir, ARCHIVES.counts);
    if (!(await stat(counts).catch(() => null))) continue;
    const config = await loadConfig(dir);
    const zip = await openZip(counts, config.dataPassword);
    const sections = zip.entries
      .filter((e) => !e.directory && /\.tsv\.gz$/.test(e.name))
      .map((e) => path.basename(e.name).replace(/\.tsv\.gz$/, ''))
      .sort();
    if (sections.length) bundles.set(name, { name, dir, config, sections });
  }
  return bundles;
}

async function specFor(stDir, id) {
  registry ??= await buildRegistry(stDir);
  const dot = id.lastIndexOf('.');
  if (dot < 0) return null;
  const bundle = registry.get(id.slice(0, dot));
  const section = id.slice(dot + 1);
  if (!bundle || !bundle.sections.includes(section)) return null;
  return { ...bundle, section, id };
}

export async function listStDatasets(stDir) {
  registry ??= await buildRegistry(stDir);
  const out = [];
  for (const bundle of registry.values()) {
    for (const section of bundle.sections) {
      const id = `${bundle.name}.${section}`;
      const manifest = await stManifest(stDir, id).catch(() => null);
      if (manifest) out.push({ id, name: manifest.name, count: manifest.count });
    }
  }
  return out;
}

export function clearStCaches() {
  registry = null;
  cache.clear();
}

function slot(id) {
  if (!cache.has(id)) cache.set(id, {});
  return cache.get(id);
}

/** Read one entry out of a bundle archive, by suffix match on its name. */
async function readArchiveEntry(spec, archive, suffix, password) {
  const file = path.join(spec.dir, ARCHIVES[archive]);
  if (!(await stat(file).catch(() => null))) return null;
  const zip = await openZipRanged(file, password);
  try {
    const entry = zip.entries.find((e) => !e.directory && e.name.endsWith(suffix));
    if (!entry) return null;
    return await zip.read(entry);
  } finally {
    await zip.close();
  }
}

/** Split a TSV into rows of cells, dropping a trailing blank line. */
function tsv(text) {
  return text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
}

/**
 * The CHEAP part of a section: spot keys, pixel positions, gene names, and the
 * spot/pitch geometry — everything `/datasets` and `/manifest` need.
 *
 * Deliberately avoids splitting the count matrix's ~15k columns: extracting the
 * row key is one `indexOf('\t')` per line, against 5M cell splits for a full
 * parse. Listing all 36 sections took 38s before this split, and the matrix is
 * only ever needed once a gene or a derived column is actually requested.
 */
async function loadIndex(stDir, id) {
  const s = slot(id);
  if (s.index) return s.index;
  const spec = await specFor(stDir, id);
  if (!spec) throw new RangeError(`unknown dataset: ${id}`);
  const { config, section } = spec;

  const countsRaw = await readArchiveEntry(spec, 'counts', `${section}.tsv.gz`, config.dataPassword);
  if (!countsRaw) throw new RangeError(`no count matrix for ${id}`);
  const text = gunzipSync(countsRaw).toString('utf8').replace(/\r/g, '').replace(/\n$/, '');
  const newline = text.indexOf('\n');
  // The header's first cell is the (empty) row-name column.
  const genes = text.slice(0, newline).split('\t').slice(1);

  const spotKeys = [];
  const lineStarts = [];
  let at = newline + 1;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const stop = nl < 0 ? text.length : nl;
    const tab = text.indexOf('\t', at);
    spotKeys.push(text.slice(at, tab < 0 || tab > stop ? stop : tab));
    lineStarts.push([at, stop]);
    if (nl < 0) break;
    at = nl + 1;
  }

  const selRaw = await readArchiveEntry(
    spec, 'selections', `${section}_selection.tsv.gz`, config.metaPassword,
  );
  if (!selRaw) throw new RangeError(`no spot-selection file for ${id}`);
  const sel = tsv(gunzipSync(selRaw).toString('utf8'));
  const head = sel[0].map((h) => h.trim());
  const [xi, yi, pxi, pyi] = ['x', 'y', 'pixel_x', 'pixel_y'].map((n) => head.indexOf(n));
  const position = new Map();
  for (const r of sel.slice(1)) position.set(`${r[xi]}x${r[yi]}`, [Number(r[pxi]), Number(r[pyi])]);

  // Keep only spots with BOTH counts and a position: the selection file is the
  // depositor's "under tissue" filter, so this is the intended subset.
  const keep = [];
  for (let i = 0; i < spotKeys.length; i++) if (position.has(spotKeys[i])) keep.push(i);
  const count = keep.length;
  if (count === 0) throw new Error(`[st] ${id}: no spot keys matched between counts and selection`);

  const x = new Float32Array(count);
  const y = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const [px, py] = position.get(spotKeys[keep[i]]);
    x[i] = px;
    y[i] = py;
  }

  // Legacy ST arrays are a known 200 um grid, so the spots are their own ruler:
  // the pitch gives both the spot radius and the image's um/px.
  const pitch = medianPitch(x, y, count);
  s.index = {
    spec, genes, count, keep, spotKeys, x, y, text, lineStarts,
    radius: pitch * ST_RADIUS_OVER_PITCH,
    mpp: pitch > 0 ? ST_PITCH_UM / pitch : null,
    ids: keep.map((i) => spotKeys[i]),
  };
  return s.index;
}

/**
 * The EXPENSIVE part: the count matrix, parsed once and kept TRANSPOSED to
 * gene-major so a gene is a contiguous slice rather than a scan. A section is
 * ~350 spots x ~15k genes, so that is ~21 MB — affordable here in a way it is
 * not for 84k cells (see spatial-zarr.mjs).
 */
async function loadMatrix(stDir, id) {
  const s = slot(id);
  if (s.matrix) return s.matrix;
  const idx = await loadIndex(stDir, id);
  const { genes, count, keep, text, lineStarts } = idx;

  const matrix = new Float32Array(genes.length * count);
  const totalCounts = new Float32Array(count);
  const nGenes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const [from, to] = lineStarts[keep[i]];
    const cells = text.slice(from, to).split('\t');
    let sum = 0;
    let detected = 0;
    for (let g = 0; g < genes.length; g++) {
      const v = Number(cells[g + 1]) || 0;
      if (v !== 0) {
        matrix[g * count + i] = v;
        sum += v;
        detected++;
      }
    }
    totalCounts[i] = sum;
    nGenes[i] = detected;
  }
  s.matrix = { matrix, totalCounts, nGenes };
  return s.matrix;
}

/** The pathologist's annotation, for the sections the depositor annotated. */
async function loadLabels(stDir, id) {
  const s = slot(id);
  if (s.labels !== undefined) return s.labels;
  const { spec, count, keep, spotKeys } = await loadIndex(stDir, id);
  const raw = await readArchiveEntry(
    spec, 'meta', `${spec.section}_labeled_coordinates.tsv`, spec.config.metaPassword,
  );
  if (!raw) return (s.labels = null);

  const meta = tsv(raw.toString('utf8'));
  const head = meta[0].map((h) => h.trim());
  const [mx, my, ml] = ['x', 'y', 'label'].map((n) => head.indexOf(n));
  if (mx < 0 || my < 0 || ml < 0) return (s.labels = null);

  // The meta file's x/y are the ADJUSTED (fractional) array coordinates, so they
  // join to the count matrix's integer keys only after rounding.
  const byKey = new Map();
  for (const r of meta.slice(1)) {
    byKey.set(`${Math.round(Number(r[mx]))}x${Math.round(Number(r[my]))}`, r[ml].trim());
  }
  const categories = [...new Set([...byKey.values()])].sort();
  const codes = new Uint16Array(count).fill(0xffff);
  let matched = 0;
  for (let i = 0; i < count; i++) {
    const label = byKey.get(spotKeys[keep[i]]);
    if (label === undefined) continue;
    codes[i] = categories.indexOf(label);
    matched++;
  }
  // A barely-matched annotation is worse than none: it would render as mostly
  // "no category" and read as though the tissue were unannotated.
  if (matched <= count * 0.5) {
    console.warn(`[st] ${id}: label join matched only ${matched}/${count} spots — skipping`);
    return (s.labels = null);
  }
  return (s.labels = { categories, codes, matched });
}

function medianPitch(x, y, n) {
  const nn = [];
  for (let a = 0; a < n; a++) {
    let best = Infinity;
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const dx = x[a] - x[b];
      const dy = y[a] - y[b];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    if (Number.isFinite(best)) nn.push(Math.sqrt(best));
  }
  nn.sort((p, q) => p - q);
  return nn[Math.floor(nn.length / 2)] ?? 0;
}

export async function stManifest(stDir, id) {
  const s = slot(id);
  if (s.manifest) return s.manifest;
  const idx = await loadIndex(stDir, id);
  const labels = await loadLabels(stDir, id);

  // Ranges are omitted deliberately: they would need the matrix, and the
  // renderer derives its contrast window from the values anyway.
  const columns = [];
  if (labels) {
    columns.push({
      kind: 'categorical', name: 'pathology', categories: labels.categories,
      description: "The pathologist's annotation, as deposited",
    });
  }
  columns.push({
    kind: 'continuous', name: 'total_counts', unit: 'counts', logScaleHint: true,
    description: 'UMI counts per spot (derived from the count matrix)',
  });
  columns.push({
    kind: 'continuous', name: 'n_genes_by_counts', unit: 'genes', logScaleHint: false,
    description: 'Genes detected per spot (derived from the count matrix)',
  });
  columns.push({
    kind: 'categorical', name: 'cluster',
    categories: Array.from({ length: CLUSTER_K }, (_, i) => `cluster ${i}`),
    description: `k-means (k=${CLUSTER_K}) on log1p-normalised expression — `
      + 'derived on demand, not an analysis result',
  });

  s.manifest = {
    version: 1,
    id,
    name: `${idx.spec.name.toUpperCase()} · section ${idx.spec.section}`,
    count: idx.count,
    hasIds: true,
    radius: { mode: 'uniform', value: idx.radius },
    columns,
    features: {
      count: idx.genes.length,
      ...(idx.genes.length <= INLINE_NAMES_LIMIT ? { names: idx.genes } : {}),
      unit: 'raw counts',
      logScaleHint: true,
    },
    imageRef: {
      imageId: `${id}-tissue`,
      // Positions are already in the HE image's own pixel space.
      scale: [1, 1],
      translate: [0, 0],
      ...(idx.mpp ? { mppX: idx.mpp, mppY: idx.mpp } : {}),
    },
  };
  return s.manifest;
}

export async function stCoords(stDir, id) {
  const { x, y, count } = await loadIndex(stDir, id);
  const out = new Float32Array(count * 2);
  out.set(x, 0);
  out.set(y, count);
  return Buffer.from(out.buffer);
}

export async function stIds(stDir, id) {
  return { ids: (await loadIndex(stDir, id)).ids };
}

export async function stFeatureSearch(stDir, id, query, limit = 50) {
  const { genes } = await loadIndex(stDir, id);
  const q = String(query ?? '').toLowerCase();
  if (!q) return genes.slice(0, limit);
  const prefix = [];
  const contains = [];
  for (const n of genes) {
    const lower = n.toLowerCase();
    if (lower.startsWith(q)) prefix.push(n);
    else if (lower.includes(q)) contains.push(n);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** One gene — a contiguous slice, since the matrix is held gene-major. */
export async function stFeature(stDir, id, name) {
  const { genes, count } = await loadIndex(stDir, id);
  const g = genes.indexOf(name);
  if (g < 0) throw new RangeError(`unknown feature: ${name}`);
  const { matrix } = await loadMatrix(stDir, id);
  const out = new Float32Array(count);
  out.set(matrix.subarray(g * count, (g + 1) * count));
  return Buffer.from(out.buffer);
}

export async function stColumn(stDir, id, name) {
  if (name === 'pathology') {
    const labels = await loadLabels(stDir, id);
    if (!labels) throw new RangeError('this section has no pathologist annotation');
    return Buffer.from(labels.codes.buffer.slice(0));
  }
  if (name === 'total_counts' || name === 'n_genes_by_counts') {
    const m = await loadMatrix(stDir, id);
    const v = name === 'total_counts' ? m.totalCounts : m.nGenes;
    return Buffer.from(v.buffer.slice(0));
  }
  if (name === 'cluster') {
    const s = slot(id);
    const { genes, count } = await loadIndex(stDir, id);
    const { matrix } = await loadMatrix(stDir, id);
    s.clusters ??= kmeansClusters(matrix, genes.length, count, { k: CLUSTER_K });
    return Buffer.from(s.clusters.buffer.slice(0));
  }
  throw new RangeError(`unknown column: ${name}`);
}

/** The section's HE image bytes, for the server's lazy pyramid build. */
export async function stImage(stDir, id) {
  const { spec, mpp } = await loadIndex(stDir, id);
  for (const suffix of [`HE/${spec.section}.jpg`, `${spec.section}.jpg`]) {
    const bytes = await readArchiveEntry(spec, 'images', suffix, spec.config.dataPassword);
    if (bytes) return { bytes, mpp };
  }
  throw new RangeError(`no HE image for ${id}`);
}
