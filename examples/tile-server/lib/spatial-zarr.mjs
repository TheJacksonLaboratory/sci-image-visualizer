// Serve the spatial-omics endpoints DIRECTLY from a SpatialData Zarr store —
// no build step, no intermediate bundle. Point $ZARR_DIR at a directory of
// `*.zarr` stores and they appear on /spatial/datasets.
//
// WHAT THIS COSTS, HONESTLY
// -------------------------
// The expression matrix is CSR over OBSERVATIONS, so one gene's column is
// scattered across every row: serving it means holding the matrix and scanning
// it. This module therefore trades memory and a first-request stall for the
// convenience of no build step:
//
//   * metadata + obs columns + coordinates  — cheap, read on demand.
//   * X (data/indices/indptr)               — read once per dataset, then cached
//                                             (227 MB for the Visium store,
//                                             331 MB for Visium HD).
//   * one gene                              — a full scan of the cached
//                                             nonzeros, ~28-41M steps.
//
// It is deliberately NOT transposed to gene-major in memory: that would double
// the residency for a dev server, and a scan is tens of milliseconds. The
// offline route (a pre-transposed gene-major file) is what a production server
// should do — which is exactly the argument for keeping ingest out of the
// browser.
//
// DERIVED COLUMNS are advertised in the manifest and computed on first request,
// so opening a dataset does not pay for clustering it.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { readArray, readAttrs, readMeta, scaleFor } from './zarr3.mjs';
import { readShapes } from './geoparquet.mjs';
import { kmeansClusters } from './cluster.mjs';

/** Visium v1: 55 µm spots on a 100 µm centre-to-centre grid. */
const VISIUM_RADIUS_OVER_PITCH = 27.5 / 100;
const MAX_CATEGORY_CARDINALITY = 64;
/** k for the derived `cluster` column. */
const CLUSTER_K = 8;
/** Genes used for clustering / the feature list cap on huge panels. */
const CLUSTER_GENES = 50;
/** Feature names are inlined in the manifest below this count. */
const INLINE_NAMES_LIMIT = 2000;

/** storeName -> { dir, datasets: Map<id, spec> }, built once per process. */
let registry = null;
/** datasetId -> lazily-populated per-dataset caches. */
const cache = new Map();

/**
 * Optional per-store sidecar at `$ZARR_DIR/<store>.json`.
 *
 * It carries only what CANNOT be inferred from the store. Today that is
 * `gridUm`: a segmentation traced on a binned assay steps one bin at a time, so
 * the outlines measure the grid — but nothing in the store states the bin's
 * PHYSICAL size (2 µm for Visium HD), and without it there is no µm/px and no
 * scale bar. Visium needs no sidecar: its 100 µm spot pitch is fixed.
 *
 *   stores/hd.json  ->  { "gridUm": 2 }
 */
async function sidecar(zarrDir, storeKey) {
  try {
    return JSON.parse(await readFile(path.join(zarrDir, `${storeKey}.json`), 'utf8'));
  } catch {
    return {};
  }
}

/** Sub-directory names. Symlinks count: pointing $ZARR_DIR entries at stores
 *  living elsewhere on disk is the obvious way to serve a 174 MB download
 *  without copying it into the repo. */
const listDirs = async (p) => (await readdir(p, { withFileTypes: true }).catch(() => []))
  .filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);

/** Derived columns this module can synthesise, and what each needs. */
const DERIVED = {
  total_counts: { needs: 'X', kind: 'continuous', unit: 'counts', logScaleHint: true,
    description: 'UMI counts per observation (derived from X)' },
  n_genes_by_counts: { needs: 'X', kind: 'continuous', unit: 'genes', logScaleHint: false,
    description: 'Genes detected per observation (derived from X)' },
  area: { needs: 'geometry', kind: 'continuous', unit: 'px²', logScaleHint: true,
    description: 'Segmented area (derived from the outline)' },
  cluster: { needs: 'X', kind: 'categorical',
    description: `k-means (k=${CLUSTER_K}) on log1p-normalised expression — `
      + 'derived on demand, not an analysis result' },
};

// ── discovery ───────────────────────────────────────────────────────────────

/**
 * Enumerate every (store, table, region) triple as a dataset.
 *
 * The id stays short when it can: `hd.cell_segmentations` for a single-region
 * table, `visium.table.ST8059048` when a table covers several sections.
 */
async function buildRegistry(zarrDir) {
  const stores = new Map();
  for (const name of await listDirs(zarrDir)) {
    const dir = path.join(zarrDir, name);
    // A store is a directory holding zarr.json; tolerate a wrapper dir that
    // contains `data.zarr` (how the sandbox zips unpack).
    const root = await stat(path.join(dir, 'zarr.json')).then(() => dir).catch(() => null)
      ?? await stat(path.join(dir, 'data.zarr', 'zarr.json'))
        .then(() => path.join(dir, 'data.zarr')).catch(() => null);
    if (!root) continue;

    const storeKey = name.replace(/\.zarr$/i, '');
    const tables = await listDirs(path.join(root, 'tables'));
    const shapes = await listDirs(path.join(root, 'shapes'));
    const images = await listDirs(path.join(root, 'images'));
    const datasets = new Map();

    for (const table of tables) {
      const regions = await regionsOf(root, table, shapes);
      for (const region of regions) {
        const id = regions.length === 1
          ? `${storeKey}.${table}`
          : `${storeKey}.${table}.${region}`;
        datasets.set(id, { id, root, storeKey, table, region, images, regions });
      }
    }
    if (datasets.size) stores.set(storeKey, { dir: root, datasets });
  }
  return stores;
}

/** Region names an obs column of `table` refers to, restricted to real shapes. */
async function regionsOf(root, table, shapes) {
  const obs = await listDirs(path.join(root, `tables/${table}/obs`));
  for (const name of obs) {
    if (name === '_index') continue;
    const meta = await readMeta(root, `tables/${table}/obs/${name}`).catch(() => null);
    if (meta?.node_type !== 'group') continue;
    const cats = await readArray(root, `tables/${table}/obs/${name}/categories`).catch(() => null);
    const named = (cats?.data ?? []).map(String).filter((v) => shapes.includes(v));
    if (named.length) return named;
  }
  return [];
}

async function specFor(zarrDir, id) {
  registry ??= await buildRegistry(zarrDir);
  for (const store of registry.values()) {
    const spec = store.datasets.get(id);
    if (spec) return spec;
  }
  return null;
}

/** Summaries for `/spatial/datasets`. */
export async function listZarrDatasets(zarrDir) {
  registry ??= await buildRegistry(zarrDir);
  const out = [];
  for (const store of registry.values()) {
    for (const spec of store.datasets.values()) {
      const manifest = await zarrManifest(zarrDir, spec.id).catch(() => null);
      if (manifest) out.push({ id: manifest.id, name: manifest.name, count: manifest.count });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Drop every cached read — used by tests and after a store changes. */
export function clearZarrCaches() {
  registry = null;
  cache.clear();
}

// ── per-dataset lazy state ─────────────────────────────────────────────────

function slot(id) {
  if (!cache.has(id)) cache.set(id, {});
  return cache.get(id);
}

/** Row indices of this dataset's region, and the obs column descriptors. */
async function loadObs(zarrDir, id) {
  const s = slot(id);
  if (s.obs) return s.obs;
  const spec = await specFor(zarrDir, id);
  if (!spec) throw new RangeError(`unknown dataset: ${id}`);
  const { root, table, region } = spec;
  const base = `tables/${table}`;

  const names = (await listDirs(path.join(root, base, 'obs'))).filter((n) => !n.startsWith('.'));
  const columns = [];
  for (const name of names) {
    if (name === '_index') continue;
    const meta = await readMeta(root, `${base}/obs/${name}`);
    if (meta.node_type === 'group') {
      const [categories, codes] = await Promise.all([
        readArray(root, `${base}/obs/${name}/categories`),
        readArray(root, `${base}/obs/${name}/codes`),
      ]);
      columns.push({ kind: 'categorical', name, categories: categories.data.map(String), codes: codes.data });
    } else {
      const arr = await readArray(root, `${base}/obs/${name}`);
      columns.push({ kind: 'array', name, values: arr.data, dtype: meta.data_type });
    }
  }

  const regionCol = columns.find((c) => c.kind === 'categorical' && c.categories.includes(region));
  const code = regionCol ? regionCol.categories.indexOf(region) : -1;
  const keep = [];
  const total = regionCol ? regionCol.codes.length : 0;
  for (let i = 0; i < total; i++) {
    if (!regionCol || Number(regionCol.codes[i]) === code) keep.push(i);
  }
  s.obs = { spec, columns, regionCol, keep, count: keep.length };
  return s.obs;
}

/** Coordinates, per-observation radius and outlines for this dataset. */
async function loadGeometry(zarrDir, id) {
  const s = slot(id);
  if (s.geometry) return s.geometry;
  const { spec, columns, keep, count } = await loadObs(zarrDir, id);
  const { root, table, region } = spec;
  const base = `tables/${table}`;

  const obsm = await listDirs(path.join(root, base, 'obsm'));
  let x;
  let y;
  let radius = null;
  let polygons = null;

  if (obsm.includes('spatial')) {
    const spatial = await readArray(root, `${base}/obsm/spatial`);
    x = new Float32Array(count);
    y = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = Number(spatial.data[keep[i] * 2]);
      y[i] = Number(spatial.data[keep[i] * 2 + 1]);
    }
  } else {
    // Segmentation store: geometry lives only in the shapes GeoParquet, and its
    // row order is not guaranteed to match the table — join by id.
    const shapes = await readShapes(path.join(root, 'shapes', region, 'shapes.parquet'));
    const byId = new Map(shapes.ids.map((v, i) => [v, i]));
    const idCol = columns.find((c) => c.kind === 'array' && /(^|_)id$/i.test(c.name));
    const index = idCol ? null : (await readArray(root, `${base}/obs/_index`)).data;
    x = new Float32Array(count);
    y = new Float32Array(count);
    radius = new Float32Array(count);
    const rows = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const key = String(idCol ? idCol.values[keep[i]] : index[keep[i]]);
      const row = byId.get(key) ?? -1;
      rows[i] = row;
      if (row < 0) continue;
      x[i] = shapes.cx[row];
      y[i] = shapes.cy[row];
      radius[i] = shapes.radius[row];
    }
    // Re-pack outlines in table-row order so ring i is observation i.
    const offsets = new Uint32Array(count + 1);
    let vertices = 0;
    for (let i = 0; i < count; i++) {
      offsets[i] = vertices;
      const row = rows[i];
      if (row >= 0) vertices += shapes.offsets[row + 1] - shapes.offsets[row];
    }
    offsets[count] = vertices;
    const coords = new Float32Array(vertices * 2);
    for (let i = 0; i < count; i++) {
      const row = rows[i];
      if (row < 0) continue;
      const from = shapes.offsets[row] * 2;
      const len = (offsets[i + 1] - offsets[i]) * 2;
      coords.set(shapes.coords.subarray(from, from + len), offsets[i] * 2);
    }
    polygons = { offsets, coords, count };
  }

  // The image maps in by identity, so its output names the target coordinate
  // system; the shapes' transform into it is imageRef.scale.
  const imageName = pickImage(spec);
  const imageAttrs = imageName ? await readAttrs(root, `images/${imageName}`) : {};
  const multiscales = imageAttrs?.ome?.multiscales?.[0] ?? imageAttrs?.multiscales?.[0];
  const levelPath = multiscales?.datasets?.[0]?.path ?? '0';
  const identity = (multiscales?.coordinateTransformations ?? [])
    .find((t) => t.type === 'identity') ?? (multiscales?.coordinateTransformations ?? [])[0];
  const coordinateSystem = identity?.output?.name ?? region;
  const [scaleX, scaleY] = scaleFor(await readAttrs(root, `shapes/${region}`), coordinateSystem);

  // A uniform spot radius (and the image's µm/px) come from the grid pitch,
  // which Visium fixes at 100 µm. Segmentations carry their own radii instead.
  let uniformRadius = null;
  let mpp = null;
  if (!radius) {
    const pitch = medianPitch(x, y, count);
    uniformRadius = pitch * VISIUM_RADIUS_OVER_PITCH;
    if (pitch > 0 && scaleX > 0) mpp = 100 / (pitch * scaleX);
  } else if (polygons) {
    // Segmentations get µm/px from the outlines' bin grid plus the sidecar's
    // asserted bin size — the grid is measurable, its physical size is not.
    const { gridUm } = await sidecar(zarrDir, spec.storeKey);
    const step = gridUm ? modalVertexStep(polygons) : 0;
    if (step > 0 && scaleX > 0) mpp = Number(gridUm) / (step * scaleX);
  }

  s.geometry = {
    x, y, radius, uniformRadius, polygons, scaleX, scaleY, mpp,
    imageName, levelPath,
  };
  return s.geometry;
}

/**
 * A readable label from the element names. The region usually already contains
 * the table's role (`..._cell_segmentations` for table `cell_segmentations`), so
 * appending it would just repeat.
 */
function prettyName(spec) {
  const region = spec.region.replace(/_/g, ' ').trim();
  const table = spec.table.replace(/_/g, ' ').trim();
  return region.toLowerCase().includes(table.toLowerCase()) ? region : `${region} · ${table}`;
}

function pickImage(spec) {
  const { images, region } = spec;
  return images.find((n) => n === `${region}_hires_image`)
    ?? images.find((n) => n.includes(region) && n.includes('hires'))
    ?? images.find((n) => n.includes('hires'))
    ?? images.find((n) => !n.endsWith('.json'));
}

/**
 * The most common non-zero vertex-to-vertex step across the outlines. For a
 * segmentation traced on a bin grid this is exactly one bin (harmonics at 2x, 3x
 * are rarer), which turns the outlines into a ruler.
 */
function modalVertexStep(poly) {
  const hist = new Map();
  const limit = Math.min(poly.count, 3000);
  for (let i = 0; i < limit; i++) {
    for (let v = poly.offsets[i]; v < poly.offsets[i + 1] - 1; v++) {
      const dx = Math.abs(poly.coords[(v + 1) * 2] - poly.coords[v * 2]);
      const dy = Math.abs(poly.coords[(v + 1) * 2 + 1] - poly.coords[v * 2 + 1]);
      const d = Math.round(Math.max(dx, dy) * 10) / 10;
      if (d > 0) hist.set(d, (hist.get(d) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = 0;
  for (const [d, n2] of hist) if (n2 > bestCount) { bestCount = n2; best = d; }
  return best;
}

function medianPitch(x, y, n) {
  const step = Math.max(1, Math.floor(n / 400));
  const nn = [];
  for (let a = 0; a < n; a += step) {
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

/**
 * The CSR matrix, read once and kept. This is the residency this module trades
 * for having no build step (227-331 MB for the demo stores).
 */
async function loadMatrix(zarrDir, id) {
  const s = slot(id);
  if (s.matrix) return s.matrix;
  const { spec } = await loadObs(zarrDir, id);
  const base = `tables/${spec.table}`;
  const [names, data, indices, indptr] = await Promise.all([
    readArray(spec.root, `${base}/var/_index`),
    readArray(spec.root, `${base}/X/data`),
    readArray(spec.root, `${base}/X/indices`),
    readArray(spec.root, `${base}/X/indptr`),
  ]);
  s.matrix = {
    names: names.data.map(String),
    data: data.data,
    indices: indices.data,
    indptr: indptr.data,
  };
  return s.matrix;
}

// ── public reads ───────────────────────────────────────────────────────────

export async function zarrManifest(zarrDir, id) {
  const s = slot(id);
  if (s.manifest) return s.manifest;
  const { spec, columns, regionCol, keep, count } = await loadObs(zarrDir, id);
  const geometry = await loadGeometry(zarrDir, id);
  const names = (await loadMatrixNames(zarrDir, id));

  const declared = [];
  for (const col of columns) {
    if (col === regionCol) continue;
    if (col.kind === 'array' && col.dtype === 'string') continue; // ids carry no encoding
    if (col.kind === 'categorical') {
      const present = new Set();
      for (const i of keep) present.add(Number(col.codes[i]));
      if (present.size < 2) continue; // constant after filtering
      declared.push({ kind: 'categorical', name: col.name, categories: col.categories });
      continue;
    }
    const distinct = new Set();
    for (const i of keep) distinct.add(Number(col.values[i]));
    if (distinct.size < 2) continue;
    // A distinct integer per observation is an identifier, not a measurement.
    if (distinct.size === count && count > 1 && [...distinct].every(Number.isInteger)) continue;
    if (distinct.size <= MAX_CATEGORY_CARDINALITY && [...distinct].every(Number.isInteger)) {
      declared.push({
        kind: 'categorical', name: col.name,
        categories: [...distinct].sort((a, b) => a - b).map(String),
      });
    } else {
      declared.push({
        kind: 'continuous', name: col.name,
        logScaleHint: /counts|umi|total/i.test(col.name),
      });
    }
  }

  // Derived columns are ADVERTISED here and computed on first request, so
  // opening a dataset does not pay to cluster it.
  for (const [name, d] of Object.entries(DERIVED)) {
    if (d.needs === 'geometry' && !geometry.radius) continue;
    declared.push(d.kind === 'categorical'
      ? {
        kind: 'categorical', name,
        categories: Array.from({ length: CLUSTER_K }, (_, i) => `cluster ${i}`),
        description: d.description,
      }
      : {
        kind: 'continuous', name, unit: d.unit, logScaleHint: d.logScaleHint,
        description: d.description,
      });
  }

  s.manifest = {
    version: 1,
    id,
    name: prettyName(spec),
    count,
    hasIds: true,
    radius: geometry.radius
      ? { mode: 'per-observation' }
      : { mode: 'uniform', value: geometry.uniformRadius ?? 4 },
    columns: declared,
    features: {
      count: names.length,
      ...(names.length <= INLINE_NAMES_LIMIT ? { names } : {}),
      unit: 'raw counts',
      logScaleHint: true,
    },
    imageRef: {
      imageId: `${id}-tissue`,
      scale: [geometry.scaleX, geometry.scaleY],
      translate: [0, 0],
      ...(geometry.mpp ? { mppX: geometry.mpp, mppY: geometry.mpp } : {}),
    },
    ...(geometry.polygons ? { polygons: { count } } : {}),
  };
  return s.manifest;
}

/** Gene names only — reads `var/_index`, not the matrix. */
async function loadMatrixNames(zarrDir, id) {
  const s = slot(id);
  if (s.featureNames) return s.featureNames;
  if (s.matrix) return (s.featureNames = s.matrix.names);
  const { spec } = await loadObs(zarrDir, id);
  const names = await readArray(spec.root, `tables/${spec.table}/var/_index`);
  s.featureNames = names.data.map(String);
  return s.featureNames;
}

export async function zarrCoords(zarrDir, id) {
  const { count } = await loadObs(zarrDir, id);
  const { x, y } = await loadGeometry(zarrDir, id);
  const out = new Float32Array(count * 2);
  out.set(x, 0);
  out.set(y, count);
  return Buffer.from(out.buffer);
}

export async function zarrRadius(zarrDir, id) {
  const { radius } = await loadGeometry(zarrDir, id);
  if (!radius) throw new RangeError('this dataset has a uniform radius');
  return Buffer.from(radius.buffer, radius.byteOffset, radius.byteLength);
}

export async function zarrIds(zarrDir, id) {
  const { spec, keep } = await loadObs(zarrDir, id);
  const index = await readArray(spec.root, `tables/${spec.table}/obs/_index`);
  return { ids: keep.map((i) => String(index.data[i])) };
}

export async function zarrPolygons(zarrDir, id) {
  const { polygons } = await loadGeometry(zarrDir, id);
  if (!polygons) throw new RangeError('this dataset has no polygon geometry');
  const header = new Uint32Array(1 + polygons.count + 1);
  header[0] = polygons.count;
  header.set(polygons.offsets, 1);
  return Buffer.concat([Buffer.from(header.buffer), Buffer.from(polygons.coords.buffer)]);
}

export async function zarrFeatureSearch(zarrDir, id, query, limit = 50) {
  const names = await loadMatrixNames(zarrDir, id);
  const q = String(query ?? '').toLowerCase();
  if (!q) return names.slice(0, limit);
  const prefix = [];
  const contains = [];
  for (const n of names) {
    const lower = n.toLowerCase();
    if (lower.startsWith(q)) prefix.push(n);
    else if (lower.includes(q)) contains.push(n);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}

/**
 * One gene's vector. CSR is observation-major, so this scans every nonzero —
 * the cost the offline gene-major layout exists to avoid.
 */
export async function zarrFeature(zarrDir, id, name) {
  const { keep, count } = await loadObs(zarrDir, id);
  const matrix = await loadMatrix(zarrDir, id);
  const gene = matrix.names.indexOf(name);
  if (gene < 0) throw new RangeError(`unknown feature: ${name}`);

  const out = new Float32Array(count);
  const { data, indices, indptr } = matrix;
  for (let i = 0; i < count; i++) {
    const row = keep[i];
    const start = Number(indptr[row]);
    const end = Number(indptr[row + 1]);
    for (let k = start; k < end; k++) {
      if (indices[k] === gene) { out[i] = data[k]; break; }
    }
  }
  return Buffer.from(out.buffer);
}

export async function zarrColumn(zarrDir, id, name) {
  const { columns, keep, count } = await loadObs(zarrDir, id);
  const manifest = await zarrManifest(zarrDir, id);
  const declared = manifest.columns.find((c) => c.name === name);
  if (!declared) throw new RangeError(`unknown column: ${name}`);

  if (DERIVED[name]) return derivedColumn(zarrDir, id, name, declared);

  const col = columns.find((c) => c.name === name);
  if (declared.kind === 'categorical') {
    const codes = new Uint16Array(count);
    if (col.kind === 'categorical') {
      for (let i = 0; i < count; i++) codes[i] = Number(col.codes[keep[i]]);
    } else {
      // A small-cardinality numeric column was promoted to categorical; map its
      // values onto the declared category order.
      const lookup = new Map(declared.categories.map((v, i) => [Number(v), i]));
      for (let i = 0; i < count; i++) codes[i] = lookup.get(Number(col.values[keep[i]])) ?? 0xffff;
    }
    return Buffer.from(codes.buffer);
  }
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) values[i] = Number(col.values[keep[i]]);
  return Buffer.from(values.buffer);
}

/** Compute (and cache) a derived column on first request. */
async function derivedColumn(zarrDir, id, name, declared) {
  const s = slot(id);
  s.derived ??= new Map();
  if (s.derived.has(name)) return s.derived.get(name);
  const { keep, count } = await loadObs(zarrDir, id);

  let buffer;
  if (name === 'area') {
    const { radius } = await loadGeometry(zarrDir, id);
    const area = new Float32Array(count);
    for (let i = 0; i < count; i++) area[i] = Math.PI * radius[i] * radius[i];
    buffer = Buffer.from(area.buffer);
  } else if (name === 'total_counts' || name === 'n_genes_by_counts') {
    const { data, indptr } = await loadMatrix(zarrDir, id);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const start = Number(indptr[keep[i]]);
      const end = Number(indptr[keep[i] + 1]);
      let sum = 0;
      let detected = 0;
      for (let k = start; k < end; k++) {
        sum += data[k];
        if (data[k] > 0) detected++;
      }
      out[i] = name === 'total_counts' ? sum : detected;
    }
    buffer = Buffer.from(out.buffer);
  } else if (name === 'cluster') {
    buffer = Buffer.from((await clusterCodes(zarrDir, id)).buffer);
  } else {
    throw new RangeError(`unknown derived column: ${name}`);
  }
  void declared;
  s.derived.set(name, buffer);
  return buffer;
}

/**
 * k-means labels. Builds a small dense gene-major block over the most-expressed
 * genes rather than the whole matrix, so clustering does not need a 672 MB
 * transpose.
 */
async function clusterCodes(zarrDir, id) {
  const { keep, count } = await loadObs(zarrDir, id);
  const { data, indices, indptr, names } = await loadMatrix(zarrDir, id);

  const totals = new Float64Array(names.length);
  for (const row of keep) {
    for (let k = Number(indptr[row]); k < Number(indptr[row + 1]); k++) totals[indices[k]] += data[k];
  }
  const genes = Array.from(totals.keys())
    .sort((a, b) => totals[b] - totals[a])
    .slice(0, Math.min(200, names.length));
  const slotOf = new Map(genes.map((g, i) => [g, i]));

  const block = new Float32Array(genes.length * count);
  for (let i = 0; i < count; i++) {
    const row = keep[i];
    for (let k = Number(indptr[row]); k < Number(indptr[row + 1]); k++) {
      const g = slotOf.get(indices[k]);
      if (g !== undefined) block[g * count + i] = data[k];
    }
  }
  return kmeansClusters(block, genes.length, count, { k: CLUSTER_K, maxGenes: CLUSTER_GENES });
}

/** The store-side image element for a dataset, for lazy pyramid building. */
export async function zarrImageSource(zarrDir, id) {
  const { spec } = await loadObs(zarrDir, id);
  const { imageName, levelPath, mpp } = await loadGeometry(zarrDir, id);
  if (!imageName) throw new RangeError(`no image for dataset ${id}`);
  return { root: spec.root, imageName, levelPath, mpp };
}
