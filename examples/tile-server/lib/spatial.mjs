// Spatial-omics dataset store for the example server.
//
// Serves the wire format in the library's `spatial-wire.ts`:
//   GET /spatial/datasets            -> { datasets: [{ id, name, count }] }
//   GET /spatial/:id/manifest        -> manifest.json verbatim
//   GET /spatial/:id/coords          -> f32[N] x, f32[N] y, f32[N] z?
//   GET /spatial/:id/radius          -> f32[N]
//   GET /spatial/:id/ids             -> { ids: [...] }
//   GET /spatial/:id/column/:name    -> u16[N] codes | f32[N] values
//   GET /spatial/:id/feature/:name   -> f32[N]
//   GET /spatial/:id/features?q&limit-> { names: [...] }
//   GET /spatial/:id/polygons        -> u32 count, u32[count+1] offsets, f32 coords
//
// ON-DISK LAYOUT  ($SPATIAL_DIR/<datasetId>/)
//   manifest.json          the served manifest, verbatim
//   coords.bin             already in wire layout — streamed with no transform
//   radius.bin             (optional) f32[N]
//   ids.json               (optional) { "ids": [...] }
//   columns/<i>.bin        column i of manifest.columns, u16 codes or f32 values
//   features/names.json    ["Ttr", "Fth1", ...]  (index == gene index)
//   features/matrix.f32    GENE-MAJOR: [gene0: f32*N][gene1: f32*N]…
//   polygons.bin           (optional) already in wire layout
//
// WHY GENE-MAJOR
// AnnData stores X observation-major (CSR), so reading one gene means touching
// every row — which is exactly why a browser can't do this well and a server
// can. The converter transposes once, offline; serving a gene is then a
// contiguous `read(fd, position = geneIndex * N * 4, length = N * 4)`. The
// matrix is never loaded into the server's memory.

import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Dataset ids come from the URL — keep them to a flat, boring alphabet so no
 *  request can escape $SPATIAL_DIR. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parsed manifests + feature-name lists, keyed by dataset id. Small and stable;
 *  re-reading them per request would dominate the cost of serving a vector. */
const manifestCache = new Map();
const featureNameCache = new Map();

function datasetDir(spatialDir, id) {
  if (!SAFE_ID.test(id) || id.includes('..')) {
    throw new RangeError(`invalid dataset id: ${id}`);
  }
  const dir = path.join(spatialDir, id);
  // Belt and braces: even with the pattern above, confirm we stayed inside.
  if (path.relative(spatialDir, dir).startsWith('..')) {
    throw new RangeError(`invalid dataset id: ${id}`);
  }
  return dir;
}

/** Every dataset directory that has a readable manifest. */
export async function listSpatialDatasets(spatialDir) {
  let entries;
  try {
    entries = await readdir(spatialDir, { withFileTypes: true });
  } catch {
    return []; // no spatial dir yet — the tile endpoints still work
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SAFE_ID.test(e.name)) continue;
    try {
      const m = await loadManifest(spatialDir, e.name);
      out.push({ id: m.id, name: m.name, count: m.count });
    } catch {
      // A half-written or foreign directory shouldn't break discovery.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Parsed manifest for `id`, cached but invalidated by the file's mtime.
 *
 * Re-running the converter while the server is up used to serve the OLD
 * manifest until a restart, which is exactly the kind of stale-state trap that
 * wastes debugging time. One `stat` per manifest request is nothing: they happen
 * once per dataset selection, not per vector.
 */
export async function loadManifest(spatialDir, id) {
  const file = path.join(datasetDir(spatialDir, id), 'manifest.json');
  const { mtimeMs } = await stat(file);
  const cached = manifestCache.get(id);
  if (cached && cached.mtimeMs === mtimeMs) return cached.manifest;

  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.id !== id) {
    throw new Error(`manifest id "${manifest.id}" does not match directory "${id}"`);
  }
  manifestCache.set(id, { manifest, mtimeMs });
  // The feature-name list is keyed to the same bundle, so drop it together.
  featureNameCache.delete(id);
  return manifest;
}

/** Stream a file that is already in wire layout (coords, radius, polygons). */
export async function openWireFile(spatialDir, id, name) {
  const file = path.join(datasetDir(spatialDir, id), name);
  const info = await stat(file); // throws ENOENT -> 404 at the route
  return { stream: createReadStream(file), size: info.size };
}

export async function readIds(spatialDir, id) {
  const file = path.join(datasetDir(spatialDir, id), 'ids.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * One annotation column as raw bytes. Columns are stored by their INDEX in
 * `manifest.columns` rather than by name, so a gene or cluster name containing
 * a path separator can never become a file path.
 */
export async function readColumn(spatialDir, id, name) {
  const manifest = await loadManifest(spatialDir, id);
  const index = manifest.columns.findIndex((c) => c.name === name);
  if (index < 0) throw new RangeError(`unknown column: ${name}`);
  return readFile(path.join(datasetDir(spatialDir, id), 'columns', `${index}.bin`));
}

async function featureNames(spatialDir, id) {
  const cached = featureNameCache.get(id);
  if (cached) return cached;
  const file = path.join(datasetDir(spatialDir, id), 'features', 'names.json');
  const names = JSON.parse(await readFile(file, 'utf8'));
  featureNameCache.set(id, names);
  return names;
}

/**
 * One gene's expression vector, as a ranged read into the gene-major matrix.
 * O(N) bytes moved, independent of how many genes the dataset has.
 */
export async function readFeatureVector(spatialDir, id, name) {
  const manifest = await loadManifest(spatialDir, id);
  const names = await featureNames(spatialDir, id);
  const index = names.indexOf(name);
  if (index < 0) throw new RangeError(`unknown feature: ${name}`);

  const bytes = manifest.count * 4;
  const file = path.join(datasetDir(spatialDir, id), 'features', 'matrix.f32');
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, index * bytes);
    if (bytesRead !== bytes) {
      throw new Error(`feature "${name}": short read (${bytesRead}/${bytes})`);
    }
    return buf;
  } finally {
    await fh.close();
  }
}

/** Case-insensitive substring search over feature names, prefix matches first. */
export async function searchFeatures(spatialDir, id, query, limit = 50) {
  const names = await featureNames(spatialDir, id);
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

/** Drop cached manifests/names — used by the dev watch path and tests. */
export function clearSpatialCaches() {
  manifestCache.clear();
  featureNameCache.clear();
}
