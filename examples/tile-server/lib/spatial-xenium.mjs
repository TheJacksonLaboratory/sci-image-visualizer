// Serve the spatial-omics endpoints DIRECTLY from a 10x Xenium output bundle — the
// `*_xe_outs.zip` 10x publishes, or an unzipped `outs/` directory — with no build step.
//
// The bundle can live on local disk, behind an HTTP(S) URL that honours Range requests
// (the 10x S3 bucket does), or in a GCS bucket (`gs://…`). Nothing is downloaded whole:
//
//   * the outer zip and every `*.zarr.zip` inside it are STORED, so a zarr chunk three
//     zips deep is one ranged read of the outer file;
//   * `cells.zarr.zip` already carries cell/nucleus polygons pre-tiled into 250 µm grid
//     cells at 4 levels of detail (24 → 12 → 6 → 3 vertices per cell);
//   * `transcripts.zarr.zip` carries every transcript tiled at level 0 and pre-aggregated
//     clusters (`cluster_count`) at levels 1-6, rows sorted by gene with a per-gene
//     offset table — so "gene G in tile T" is one contiguous row range;
//   * `density/gene` is a per-gene 10 µm count raster (CSR over gene×row);
//   * `analysis.zarr.zip` carries 10x's graph-based and k-means clusterings;
//   * `cell_feature_matrix.zarr.zip` is gene-major CSR, so one gene's per-cell counts is
//     one contiguous range too.
//
// Only the morphology OME-TIFFs are DEFLATED inside the zip, so they cannot be read in
// place; `scripts/prepare-xenium.mjs` extracts them into a tile pyramid once.
//
// DISCOVERY ($XENIUM_DIR)
//   <id>.json         { "name", "source": path|https|gs url, "cellTypes"?: csv path }
//   <name>_xe_outs.zip  a bundle dropped in directly; id = <name> lower-cased
//   <dir>/experiment.xenium   an unzipped bundle; id = <dir>
//
// UNITS
//   Every coordinate served is in MICRONS, the bundle's native unit. `imageRef.scale`
//   (1 / pixel_size) maps microns onto the morphology image's pixel grid.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { openByteSource } from './xenium/byte-source.mjs';
import { readZipDirectory, openStoredMember, readMember } from './xenium/zip.mjs';
import { ZarrZipStore, typedArrayFor } from './xenium/zarr2-zip.mjs';
import { LruCache } from './xenium/lru.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NO_CATEGORY = 0xffff;
const NO_CELL = 0xffffffff;

/** Decoded chunk cache shared by every dataset: transcripts and masks dominate. */
const chunkCache = new LruCache(Number(process.env.XENIUM_CACHE_MB ?? 768) * 2 ** 20);

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** `{ id → { id, name, source, cellTypes? } }` for everything under $XENIUM_DIR. */
async function discover(xeniumDir) {
  const out = new Map();
  let entries;
  try {
    entries = await readdir(xeniumDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(xeniumDir, e.name);
    try {
      if (e.isFile() && e.name.endsWith('.json')) {
        const cfg = JSON.parse(await readFile(full, 'utf8'));
        const id = e.name.slice(0, -'.json'.length);
        if (!cfg.source || !SAFE_ID.test(id)) continue;
        const rel = (p) => (p && !/^(https?|gs):/.test(p) && !path.isAbsolute(p) ? path.join(xeniumDir, p) : p);
        out.set(id, { id, name: cfg.name ?? id, source: rel(cfg.source), cellTypes: rel(cfg.cellTypes) });
      } else if (e.isFile() && e.name.endsWith('_xe_outs.zip')) {
        const id = e.name.slice(0, -'_xe_outs.zip'.length).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
        if (!out.has(id)) out.set(id, { id, name: e.name.slice(0, -'_xe_outs.zip'.length).replace(/_/g, ' '), source: full });
      } else if (e.isDirectory() && SAFE_ID.test(e.name)) {
        await stat(path.join(full, 'experiment.xenium'));
        if (!out.has(e.name)) out.set(e.name, { id: e.name, name: e.name, source: full });
      }
    } catch {
      // Not a Xenium entry — ignore it rather than break discovery.
    }
  }
  return out;
}

let discoveryCache = { at: 0, dir: null, map: new Map() };
async function configFor(xeniumDir, id) {
  if (discoveryCache.dir !== xeniumDir || Date.now() - discoveryCache.at > 5_000) {
    discoveryCache = { at: Date.now(), dir: xeniumDir, map: await discover(xeniumDir) };
  }
  const cfg = discoveryCache.map.get(id);
  if (!cfg) throw new RangeError(`unknown xenium dataset: ${id}`);
  return cfg;
}

export async function listXeniumDatasets(xeniumDir) {
  const map = await discover(xeniumDir);
  const out = [];
  for (const cfg of map.values()) {
    try {
      const ds = await openDataset(cfg);
      out.push({ id: cfg.id, name: cfg.name, count: ds.count });
    } catch (err) {
      console.warn(`[xenium] skipping ${cfg.id}: ${err.message}`);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Bundle access — one interface over "zip" and "directory"
// ---------------------------------------------------------------------------

async function openBundle(source) {
  const isDir = !/^(https?|gs):/.test(source) && (await stat(source)).isDirectory();
  if (isDir) {
    return {
      async store(name) {
        return ZarrZipStore.open(await openByteSource(path.join(source, name)));
      },
      async small(name) {
        return readFile(path.join(source, name));
      },
    };
  }
  const src = await openByteSource(source);
  const entries = await readZipDirectory(src);
  // 10x zips sometimes nest everything under one top-level folder.
  const find = (name) => entries.get(name)
    ?? [...entries.values()].find((e) => e.name.endsWith(`/${name}`));
  return {
    async store(name) {
      const e = find(name);
      if (!e) throw new RangeError(`${source}: no ${name} in bundle`);
      return ZarrZipStore.open(await openStoredMember(src, e));
    },
    async small(name) {
      const e = find(name);
      if (!e) throw new RangeError(`${source}: no ${name} in bundle`);
      return readMember(src, e);
    },
  };
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

const datasets = new Map();

/** Open (once) and cache everything cheap enough to keep resident. */
function openDataset(cfg) {
  const key = `${cfg.source}|${cfg.cellTypes ?? ''}`;
  if (!datasets.has(key)) {
    const p = loadDataset(cfg).catch((err) => {
      datasets.delete(key);
      throw err;
    });
    datasets.set(key, p);
  }
  return datasets.get(key);
}

async function loadDataset(cfg) {
  const bundle = await openBundle(cfg.source);
  const experiment = JSON.parse((await bundle.small('experiment.xenium')).toString('utf8'));
  const [cells, transcripts, analysis, features] = await Promise.all([
    bundle.store('cells.zarr.zip'),
    bundle.store('transcripts.zarr.zip'),
    bundle.store('analysis.zarr.zip').catch(() => null),
    bundle.store('cell_feature_matrix.zarr.zip').catch(() => null),
  ]);

  const summaryAttrs = await cells.attrs('cell_summary');
  const summary = await cells.read('cell_summary');
  const count = summary.shape[0];
  const ncol = summary.shape[1];
  const col = (name) => {
    const j = summaryAttrs.column_names.indexOf(name);
    if (j < 0) return null;
    const v = new Float32Array(count);
    for (let i = 0; i < count; i++) v[i] = summary.data[i * ncol + j];
    return v;
  };

  const ds = {
    cfg,
    bundle,
    experiment,
    cells,
    transcripts,
    analysis,
    features,
    count,
    pixelSize: experiment.pixel_size ?? 0.2125,
    x: col('cell_centroid_x'),
    y: col('cell_centroid_y'),
    area: col('cell_area'),
    nucleusArea: col('nucleus_area'),
    nucleusCount: col('nucleus_count'),
    cellsAttrs: await cells.attrs(''),
    txAttrs: await transcripts.attrs(''),
    gridAttrs: await transcripts.attrs('grids'),
    densityAttrs: await transcripts.attrs('density/gene').catch(() => null),
    polygonGrids: [],
  };

  // Polygon grids: per set, per level, the set of tile keys that exist.
  const names = ds.cellsAttrs.polygon_set_names ?? [];
  for (let s = 0; s < names.length; s++) {
    const g = await cells.attrs(`gridded_polygon_sets/${s}`);
    if (!g) continue;
    ds.polygonGrids.push({
      index: s,
      name: names[s],
      label: ds.cellsAttrs.polygon_set_display_names?.[s] ?? names[s],
      tileSize: g.grid_size[0],
      levels: g.grid_keys.map((keys) => new Set(keys.map((k) => k.join(',')))),
    });
  }
  ds.transcriptLevels = ds.gridAttrs.grid_keys.map((keys) => new Set(keys));
  ds.geneNames = ds.txAttrs.gene_names;
  ds.geneIndex = new Map(ds.geneNames.map((n, i) => [n, i]));
  ds.bounds = boundsOf(ds.x, ds.y);

  ds.columns = await buildColumns(ds);
  if (features) {
    const fa = await features.attrs('cell_features');
    ds.featureNames = fa.feature_keys;
    ds.featureIndex = new Map(ds.featureNames.map((n, i) => [n, i]));
  }
  console.log(`[xenium] opened ${cfg.id}: ${count} cells, ${ds.geneNames.length} genes, ` +
    `${ds.columns.length} columns`);
  return ds;
}

function boundsOf(x, y) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] < x0) x0 = x[i];
    if (x[i] > x1) x1 = x[i];
    if (y[i] < y0) y0 = y[i];
    if (y[i] > y1) y1 = y[i];
  }
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------------------
// Columns — 10x clusterings, an optional curated cell-type table, per-cell metrics
// ---------------------------------------------------------------------------

const GROUPING_LABELS = {
  gene_expression_graphclust: 'Graph-based clusters (10x)',
};
function groupingLabel(name) {
  if (GROUPING_LABELS[name]) return GROUPING_LABELS[name];
  const k = /kmeans_(\d+)_clusters/.exec(name);
  return k ? `K-means, k=${k[1]} (10x)` : name;
}

async function buildColumns(ds) {
  const cols = [];
  if (ds.analysis) {
    const ga = await ds.analysis.attrs('cell_groups');
    for (let g = 0; g < (ga?.number_groupings ?? 0); g++) {
      const name = ga.grouping_names[g];
      const categories = ga.group_names[g];
      cols.push({
        meta: { kind: 'categorical', name, description: groupingLabel(name), categories },
        load: async () => {
          const [indices, indptr] = await Promise.all([
            ds.analysis.read(`cell_groups/${g}/indices`),
            ds.analysis.read(`cell_groups/${g}/indptr`),
          ]);
          const codes = new Uint16Array(ds.count).fill(NO_CATEGORY);
          for (let c = 0; c < categories.length; c++) {
            for (let k = indptr.data[c]; k < indptr.data[c + 1]; k++) codes[indices.data[k]] = c;
          }
          return codes;
        },
      });
    }
  }
  // After the 10x clusterings: those are the default cell types, the curated table an
  // opt-in (the viewer's "Use curated cell types" switch looks for this column's name).
  if (ds.cfg.cellTypes) {
    const curated = await loadCuratedCellTypes(ds);
    if (curated) cols.push(curated);
  }
  const metric = (name, description, values, unit) => values && cols.push({
    meta: { kind: 'continuous', name, description, ...(unit ? { unit } : {}), ...minMax(values) },
    load: async () => values,
  });
  metric('cell_area', 'Cell area', ds.area, 'µm²');
  metric('nucleus_area', 'Nucleus area', ds.nucleusArea, 'µm²');
  metric('nucleus_count', 'Nuclei per cell', ds.nucleusCount);
  return cols;
}

function minMax(v) {
  let min = Infinity; let max = -Infinity;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return Number.isFinite(min) ? { min, max } : {};
}

/**
 * Xenium cell ids are stored as `[u32 prefix, u32 dataset suffix]`; the string form 10x
 * prints (`aaabbbcc-1`) is the prefix's 8 hex digits shifted into `a`-`p`, then the suffix.
 */
export function xeniumCellId(prefix, suffix) {
  const hex = prefix.toString(16).padStart(8, '0');
  let s = '';
  for (const ch of hex) s += String.fromCharCode(97 + Number.parseInt(ch, 16));
  return `${s}-${suffix}`;
}

/**
 * A curated cell-type table: CSV with a `cell_id` column and one label column (the first
 * other column, or one named `cell_type`/`celltype`/`group`/`label`). Joined on 10x's cell
 * id string, so it works with tables exported from Xenium Explorer or scanpy alike.
 */
async function loadCuratedCellTypes(ds) {
  let text;
  try {
    text = (await readFile(ds.cfg.cellTypes, 'utf8'));
  } catch (err) {
    console.warn(`[xenium] ${ds.cfg.id}: cannot read cellTypes ${ds.cfg.cellTypes}: ${err.message}`);
    return null;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const idCol = header.findIndex((h) => /^(cell_id|cell|barcode)$/i.test(h));
  let labelCol = header.findIndex((h) => /^(cell_?type|group|label|annotation)$/i.test(h));
  if (labelCol < 0) labelCol = header.findIndex((_, i) => i !== idCol);
  if (idCol < 0 || labelCol < 0) {
    console.warn(`[xenium] ${ds.cfg.id}: cellTypes needs a cell_id column and a label column`);
    return null;
  }
  const byId = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    byId.set(f[idCol], f[labelCol]);
  }
  const ids = await ds.cells.read('cell_id');
  const categories = [...new Set(byId.values())].sort();
  const code = new Map(categories.map((c, i) => [c, i]));
  const codes = new Uint16Array(ds.count).fill(NO_CATEGORY);
  let matched = 0;
  for (let i = 0; i < ds.count; i++) {
    const label = byId.get(xeniumCellId(ids.data[2 * i], ids.data[2 * i + 1]));
    if (label !== undefined) {
      codes[i] = code.get(label);
      matched++;
    }
  }
  console.log(`[xenium] ${ds.cfg.id}: curated cell types matched ${matched}/${ds.count} cells`);
  return {
    meta: {
      kind: 'categorical',
      name: 'curated_cell_type',
      description: `Curated cell types (${path.basename(ds.cfg.cellTypes)})`,
      categories,
    },
    load: async () => codes,
  };
}

// ---------------------------------------------------------------------------
// Wire handlers
// ---------------------------------------------------------------------------

async function dataset(xeniumDir, id) {
  return openDataset(await configFor(xeniumDir, id));
}

export async function xeniumManifest(xeniumDir, id, { imageExists } = {}) {
  const ds = await dataset(xeniumDir, id);
  const mpp = ds.pixelSize;
  const imageId = `${id}-tissue`;
  const hasImage = imageExists ? await imageExists(imageId) : false;
  const tx = ds.gridAttrs;
  const levels0 = tx.grid_size[0];
  return {
    version: 1,
    id,
    name: ds.cfg.name,
    count: ds.count,
    hasZ: false,
    radius: { mode: 'per-observation' },
    columns: ds.columns.map((c) => c.meta),
    ...(ds.featureNames ? {
      features: { count: ds.featureNames.length, unit: 'transcript counts', logScaleHint: true },
    } : {}),
    // Only with a built pyramid: the viewer reads an imageRef as "draw over this image".
    // Without one the observations are shown on their own, in microns.
    ...(hasImage ? {
      imageRef: { imageId, scale: [1 / mpp, 1 / mpp], translate: [0, 0], mppX: mpp, mppY: mpp },
    } : {}),
    micronsPerUnit: 1,
    polygonTiles: {
      bounds: ds.bounds,
      sets: ds.polygonGrids.map((g) => ({ name: g.name, label: g.label })),
      defaultSet: ds.polygonGrids.find((g) => g.name === 'cell')?.name ?? ds.polygonGrids[0]?.name,
      levels: ds.polygonGrids[0]?.levels.map((_, l) => ({ tileSize: ds.polygonGrids[0].tileSize * 2 ** l })) ?? [],
    },
    transcriptTiles: {
      bounds: ds.bounds,
      count: ds.experiment.num_transcripts_high_quality || undefined,
      geneCount: ds.geneNames.length,
      hasZ: true,
      levels: ds.transcriptLevels.map((_, l) => ({ tileSize: levels0 * 2 ** l, aggregated: l > 0 })),
      // Levels at or below this one carry an exact per-transcript cell assignment; above
      // it the cell is the one nearest the aggregate's centroid.
      exactCellLevel: EXACT_CELL_MAX_LEVEL,
    },
    ...(ds.densityAttrs ? {
      density: {
        gridSize: ds.densityAttrs.grid_size,
        origin: [ds.densityAttrs.origin.x, ds.densityAttrs.origin.y],
        rows: ds.densityAttrs.rows,
        cols: ds.densityAttrs.cols,
      },
    } : {}),
  };
}

export async function xeniumCoords(xeniumDir, id) {
  const ds = await dataset(xeniumDir, id);
  const buf = Buffer.allocUnsafe(ds.count * 8);
  Buffer.from(ds.x.buffer, ds.x.byteOffset, ds.count * 4).copy(buf, 0);
  Buffer.from(ds.y.buffer, ds.y.byteOffset, ds.count * 4).copy(buf, ds.count * 4);
  return buf;
}

/** Radius of the circle with the cell's area — a sensible marker when outlines are off. */
export async function xeniumRadius(xeniumDir, id) {
  const ds = await dataset(xeniumDir, id);
  const r = new Float32Array(ds.count);
  for (let i = 0; i < ds.count; i++) r[i] = Math.sqrt(Math.max(ds.area[i], 1) / Math.PI);
  return Buffer.from(r.buffer);
}

export async function xeniumColumn(xeniumDir, id, name) {
  const ds = await dataset(xeniumDir, id);
  const col = ds.columns.find((c) => c.meta.name === name);
  if (!col) throw new RangeError(`unknown column: ${name}`);
  const v = await chunkCache.get(`${ds.cfg.source}|col|${name}`, col.load);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export async function xeniumFeatureSearch(xeniumDir, id, q, limit) {
  const ds = await dataset(xeniumDir, id);
  const names = ds.featureNames ?? ds.geneNames;
  const needle = String(q ?? '').toLowerCase();
  const pre = [];
  const sub = [];
  for (const n of names) {
    const l = n.toLowerCase();
    if (!needle || l.startsWith(needle)) pre.push(n);
    else if (l.includes(needle)) sub.push(n);
    if (pre.length >= limit) break;
  }
  return [...pre, ...sub].slice(0, limit);
}

/** Read `[start, end)` of a 1-D (or F-order N×1) zarr array chunk by chunk. */
async function readRange(store, arrPath, start, end, cacheKey) {
  const meta = await store.meta(arrPath);
  const T = typedArrayFor(meta);
  const out = new T(Math.max(0, end - start));
  const cs = meta.chunks[0];
  for (let c = Math.floor(start / cs); c * cs < end; c++) {
    const coords = meta.chunks.map((_, d) => (d === 0 ? c : 0));
    const chunk = await chunkCache.get(`${cacheKey}|${arrPath}|${c}`, () => store.chunk(arrPath, meta, coords));
    const a = Math.max(start, c * cs);
    const b = Math.min(end, (c + 1) * cs);
    out.set(chunk.subarray(a - c * cs, b - c * cs), a - start);
  }
  return out;
}

/** One gene's per-cell counts, from the gene-major CSR. */
export async function xeniumFeature(xeniumDir, id, name) {
  const ds = await dataset(xeniumDir, id);
  if (!ds.features) throw new RangeError('no cell_feature_matrix in this bundle');
  const g = ds.featureIndex.get(name);
  if (g === undefined) throw new RangeError(`unknown feature: ${name}`);
  const indptr = await chunkCache.get(`${ds.cfg.source}|cfm-indptr`,
    async () => (await ds.features.read('cell_features/indptr')).data);
  const key = `${ds.cfg.source}|cfm`;
  const [indices, data] = await Promise.all([
    readRange(ds.features, 'cell_features/indices', indptr[g], indptr[g + 1], key),
    readRange(ds.features, 'cell_features/data', indptr[g], indptr[g + 1], key),
  ]);
  const v = new Float32Array(ds.count);
  for (let k = 0; k < indices.length; k++) v[indices[k]] = data[k];
  return Buffer.from(v.buffer);
}

// ---------------------------------------------------------------------------
// Polygon tiles
// ---------------------------------------------------------------------------

/**
 * `[u32 count][u32 cellIndex × count][u32 offsets × (count+1)][f32 x,y × vertices]`
 * for one grid tile. An absent tile is a valid, empty answer (count 0).
 *
 * Vertices are stored as bytes relative to the owning CELL's bounding box (nuclei too),
 * so decoding needs `bboxes` — 11 MB, loaded once.
 */
export async function xeniumPolygonTile(xeniumDir, id, setName, level, gx, gy) {
  const ds = await dataset(xeniumDir, id);
  const grid = ds.polygonGrids.find((g) => g.name === setName);
  if (!grid) throw new RangeError(`unknown polygon set: ${setName}`);
  if (!(level >= 0 && level < grid.levels.length)) throw new RangeError(`bad level ${level}`);
  const key = `${gx},${gy}`;
  if (!grid.levels[level].has(key)) return emptyPolygonTile();

  const bboxes = await chunkCache.get(`${ds.cfg.source}|bboxes`, async () => (await ds.cells.read('bboxes')).data);
  const base = `gridded_polygon_sets/${grid.index}/${level}/${key}`;
  const [rv, nv, ci] = await Promise.all([
    ds.cells.read(`${base}/relative_vertices`),
    ds.cells.read(`${base}/num_vertices`),
    ds.cells.read(`${base}/cell_index`),
  ]);
  const count = nv.data.length;
  const vertices = rv.data.length / 2;
  const buf = Buffer.alloc(4 + count * 4 + (count + 1) * 4 + vertices * 8);
  buf.writeUInt32LE(count, 0);
  const cellIdx = new Uint32Array(buf.buffer, buf.byteOffset + 4, count);
  const offsets = new Uint32Array(buf.buffer, buf.byteOffset + 4 + count * 4, count + 1);
  const coords = new Float32Array(buf.buffer, buf.byteOffset + 4 + count * 4 + (count + 1) * 4, vertices * 2);
  let v = 0;
  for (let i = 0; i < count; i++) {
    const c = ci.data[i];
    cellIdx[i] = c;
    offsets[i] = v;
    const x0 = bboxes[4 * c];
    const y0 = bboxes[4 * c + 1];
    const sx = (bboxes[4 * c + 2] - x0) / 255;
    const sy = (bboxes[4 * c + 3] - y0) / 255;
    for (let k = 0; k < nv.data[i]; k++, v++) {
      coords[2 * v] = x0 + rv.data[2 * v] * sx;
      coords[2 * v + 1] = y0 + rv.data[2 * v + 1] * sy;
    }
  }
  offsets[count] = v;
  return buf;
}

function emptyPolygonTile() {
  return Buffer.alloc(8); // count 0, offsets [0]
}

// ---------------------------------------------------------------------------
// Transcript tiles
// ---------------------------------------------------------------------------

/** Exact cell lookup through the label mask is affordable up to this level's tile size. */
const EXACT_CELL_MAX_LEVEL = 1;

/**
 * Transcripts (level 0) or pre-aggregated clusters (levels ≥ 1) of the requested genes in
 * one tile.
 *
 * Layout, every field 4-byte aligned:
 *   u32 n, u32 flags (bit0 = aggregated)
 *   f32 x[n], f32 y[n], f32 z[n]
 *   u32 count[n]      transcripts represented (1 at level 0)
 *   u32 cell[n]       observation index of the cell it falls in, or 0xffffffff
 *   u16 gene[n]       index into the REQUESTED `genes` list, padded to 4 bytes
 */
export async function xeniumTranscriptTile(xeniumDir, id, level, gx, gy, { genes, quality = 'high' }) {
  const ds = await dataset(xeniumDir, id);
  if (!(level >= 0 && level < ds.transcriptLevels.length)) throw new RangeError(`bad level ${level}`);
  const geneIdx = genes.map((g) => {
    const i = ds.geneIndex.get(g);
    if (i === undefined) throw new RangeError(`unknown gene: ${g}`);
    return i;
  });
  const key = `${gx},${gy}`;
  if (!ds.transcriptLevels[level].has(key) || geneIdx.length === 0) return encodeTranscripts([], level > 0);

  const base = `grids/${level}/${key}`;
  const cacheKey = `${ds.cfg.source}|tx`;
  const offsets = await chunkCache.get(`${cacheKey}|${base}/gene_offset`,
    async () => (await ds.transcripts.read(`${base}/gene_offset`)).data);

  // Row ranges per requested gene: [lowStart, lowEnd, highStart, highEnd].
  const ranges = [];
  geneIdx.forEach((g, slot) => {
    const [ls, le, hs, he] = offsets.subarray(4 * g, 4 * g + 4);
    if (he > hs) ranges.push({ slot, start: hs, end: he });
    if (quality === 'all' && le > ls) ranges.push({ slot, start: ls, end: le });
  });

  const parts = [];
  for (const r of ranges) {
    const [loc, cnt] = await Promise.all([
      readRows(ds.transcripts, `${base}/location`, r.start, r.end, 3, cacheKey),
      level > 0 ? readRows(ds.transcripts, `${base}/cluster_count`, r.start, r.end, 1, cacheKey) : null,
    ]);
    parts.push({ slot: r.slot, n: r.end - r.start, loc, cnt });
  }
  const n = parts.reduce((a, p) => a + p.n, 0);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const count = new Uint32Array(n).fill(1);
  const gene = new Uint16Array(n);
  let o = 0;
  for (const p of parts) {
    x.set(p.loc[0], o);
    y.set(p.loc[1], o);
    z.set(p.loc[2], o);
    if (p.cnt) count.set(p.cnt[0], o);
    gene.fill(p.slot, o, o + p.n);
    o += p.n;
  }
  const cell = level <= EXACT_CELL_MAX_LEVEL
    ? await cellsAtExact(ds, x, y)
    : await cellsNearest(ds, x, y);
  return encodeTranscripts({ n, x, y, z, count, cell, gene }, level > 0);
}

/** Rows `[start,end)` of an F-order N×cols array → one typed array per column. */
async function readRows(store, arrPath, start, end, cols, cacheKey) {
  const meta = await store.meta(arrPath);
  const cs = meta.chunks[0];
  const out = [];
  let T;
  for (let j = 0; j < cols; j++) out.push(null);
  for (let c = Math.floor(start / cs); c * cs < end; c++) {
    const chunk = await chunkCache.get(`${cacheKey}|${arrPath}|${c}`,
      () => store.chunk(arrPath, meta, [c, 0]));
    T ??= chunk.constructor;
    for (let j = 0; j < cols; j++) out[j] ??= new T(end - start);
    const a = Math.max(start, c * cs);
    const b = Math.min(end, (c + 1) * cs);
    for (let j = 0; j < cols; j++) {
      // F order: column j of this chunk is a contiguous run of `cs` values.
      const col = meta.order === 'F'
        ? chunk.subarray(j * cs + (a - c * cs), j * cs + (b - c * cs))
        : strided(chunk, cols, j, a - c * cs, b - c * cs);
      out[j].set(col, a - start);
    }
  }
  return out;
}

function strided(chunk, cols, j, a, b) {
  const out = new chunk.constructor(b - a);
  for (let i = a; i < b; i++) out[i - a] = chunk[i * cols + j];
  return out;
}

function encodeTranscripts(t, aggregated) {
  const n = t.n ?? 0;
  const genePad = Math.ceil((n * 2) / 4) * 4;
  const buf = Buffer.alloc(8 + n * 4 * 5 + genePad);
  buf.writeUInt32LE(n, 0);
  buf.writeUInt32LE(aggregated ? 1 : 0, 4);
  if (!n) return buf;
  let o = 8;
  for (const arr of [t.x, t.y, t.z, t.count, t.cell]) {
    Buffer.from(arr.buffer, arr.byteOffset, n * 4).copy(buf, o);
    o += n * 4;
  }
  Buffer.from(t.gene.buffer, t.gene.byteOffset, n * 2).copy(buf, o);
  return buf;
}

/**
 * Exact cell assignment: look the transcript's position up in the cell label mask
 * (`masks/1`, one u32 label per morphology pixel, 0 = background, else cell index + 1).
 */
async function cellsAtExact(ds, x, y) {
  const setIdx = ds.polygonGrids.find((g) => g.name === 'cell')?.index ?? 1;
  const arrPath = `masks/${setIdx}`;
  const meta = await ds.cells.meta(arrPath);
  const tf = await chunkCache.get(`${ds.cfg.source}|mask-tf`, async () => (await ds.cells.read('masks/homogeneous_transform')).data);
  const [ch, cw] = meta.chunks;
  const [H, W] = meta.shape;
  const out = new Uint32Array(x.length).fill(NO_CELL);
  // Group by chunk so each chunk is fetched once.
  const byChunk = new Map();
  for (let i = 0; i < x.length; i++) {
    const px = Math.floor(x[i] * tf[0] + tf[3]);
    const py = Math.floor(y[i] * tf[5] + tf[7]);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const k = `${Math.floor(py / ch)}.${Math.floor(px / cw)}`;
    let list = byChunk.get(k);
    if (!list) byChunk.set(k, (list = []));
    list.push(i, px, py);
  }
  await Promise.all([...byChunk].map(async ([k, list]) => {
    const [cy, cx] = k.split('.').map(Number);
    const chunk = await chunkCache.get(`${ds.cfg.source}|${arrPath}|${k}`, () => ds.cells.chunk(arrPath, meta, [cy, cx]));
    for (let j = 0; j < list.length; j += 3) {
      const label = chunk[(list[j + 2] - cy * ch) * cw + (list[j + 1] - cx * cw)];
      if (label) out[list[j]] = label - 1;
    }
  }));
  return out;
}

/**
 * Approximate cell assignment for aggregated levels: a coarse grid (5 µm) holding the
 * index of the cell whose centroid landed in each bin, filled outward so every bin inside
 * tissue has one. An aggregate spans many cells anyway; this names a representative.
 */
async function cellsNearest(ds, x, y) {
  const grid = await chunkCache.get(`${ds.cfg.source}|cell-grid`, async () => buildCellGrid(ds));
  const out = new Uint32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const gx = Math.floor((x[i] - grid.x0) / grid.step);
    const gy = Math.floor((y[i] - grid.y0) / grid.step);
    out[i] = gx >= 0 && gy >= 0 && gx < grid.w && gy < grid.h ? grid.cells[gy * grid.w + gx] : NO_CELL;
  }
  return out;
}

function buildCellGrid(ds) {
  const step = 5;
  const [x0, y0, x1, y1] = ds.bounds;
  const w = Math.ceil((x1 - x0) / step) + 1;
  const h = Math.ceil((y1 - y0) / step) + 1;
  const cells = new Uint32Array(w * h).fill(NO_CELL);
  for (let i = 0; i < ds.count; i++) {
    cells[Math.floor((ds.y[i] - y0) / step) * w + Math.floor((ds.x[i] - x0) / step)] = i;
  }
  // Two dilation passes close the gaps between centroids (cells are ~10-15 µm apart).
  for (let pass = 0; pass < 2; pass++) {
    const src = cells.slice();
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const k = gy * w + gx;
        if (src[k] !== NO_CELL) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && src[ny * w + nx] !== NO_CELL) {
            cells[k] = src[ny * w + nx];
            break;
          }
        }
      }
    }
  }
  return { x0, y0, step, w, h, cells, byteLength: cells.byteLength };
}

// ---------------------------------------------------------------------------
// Density
// ---------------------------------------------------------------------------

/** Summed per-gene transcript counts on the bundle's density grid, as `f32[rows × cols]`. */
export async function xeniumDensity(xeniumDir, id, genes) {
  const ds = await dataset(xeniumDir, id);
  if (!ds.densityAttrs) throw new RangeError('no density grid in this bundle');
  const { rows, cols } = ds.densityAttrs;
  const densityNames = ds.densityAttrs.gene_names;
  const indptr = await chunkCache.get(`${ds.cfg.source}|density-indptr`,
    async () => (await ds.transcripts.read('density/gene/indptr')).data);
  const out = new Float32Array(rows * cols);
  const key = `${ds.cfg.source}|density`;
  for (const name of genes) {
    const g = densityNames.indexOf(name);
    if (g < 0) throw new RangeError(`unknown gene: ${name}`);
    const start = indptr[g * rows];
    const end = indptr[(g + 1) * rows];
    const [indices, data] = await Promise.all([
      readRange(ds.transcripts, 'density/gene/indices', start, end, key),
      readRange(ds.transcripts, 'density/gene/data', start, end, key),
    ]);
    for (let r = 0; r < rows; r++) {
      for (let k = indptr[g * rows + r]; k < indptr[g * rows + r + 1]; k++) {
        out[r * cols + indices[k - start]] += data[k - start];
      }
    }
  }
  return Buffer.from(out.buffer);
}
