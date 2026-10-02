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

import { mkdir, open as openFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openByteSource } from './xenium/byte-source.mjs';
import { readZipDirectory, openStoredMember, readMember } from './xenium/zip.mjs';
import { ZarrZipStore, typedArrayFor } from './xenium/zarr2-zip.mjs';
import { LruCache } from './xenium/lru.mjs';
import { parseDelimited } from './delimited.mjs';
import { KEEP as MARKERS_KEPT, computeMarkers, topMarkers } from './xenium/markers.mjs';

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
        out.set(id, {
          id, name: cfg.name ?? id, source: rel(cfg.source), cellTypes: rel(cfg.cellTypes),
          transcriptIndex: rel(cfg.transcriptIndex) ?? path.join(xeniumDir, `${id}.transcripts`),
          derivedDir: path.join(xeniumDir, `${id}.derived`),
        });
      } else if (e.isFile() && e.name.endsWith('_xe_outs.zip')) {
        const id = e.name.slice(0, -'_xe_outs.zip'.length).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
        if (!out.has(id)) {
          out.set(id, {
            id, name: e.name.slice(0, -'_xe_outs.zip'.length).replace(/_/g, ' '), source: full,
            transcriptIndex: path.join(xeniumDir, `${id}.transcripts`),
            derivedDir: path.join(xeniumDir, `${id}.derived`),
          });
        }
      } else if (e.isDirectory() && SAFE_ID.test(e.name)) {
        await stat(path.join(full, 'experiment.xenium'));
        if (!out.has(e.name)) {
          out.set(e.name, {
            id: e.name, name: e.name, source: full,
            transcriptIndex: path.join(xeniumDir, `${e.name}.transcripts`),
            derivedDir: path.join(xeniumDir, `${e.name}.derived`),
          });
        }
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

/** Open a bundle by location alone — for offline tools (the transcript index builder). */
export function openXeniumSource(source) {
  return openDataset({ id: 'offline', name: 'offline', source });
}

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
  // Real genes only: a third of the codeword "genes" are negative-control probes.
  ds.geneIsReal = new Uint8Array(ds.geneNames.length).fill(1);
  const categories = await transcripts.read('gene_category').catch(() => null);
  if (categories) {
    const cols = categories.shape[1];
    for (let g = 0; g < categories.shape[0]; g++) ds.geneIsReal[g] = categories.data[g * cols];
  }
  ds.transcriptIndex = await loadTranscriptIndex(cfg.transcriptIndex);
  if (!ds.transcriptIndex) scheduleTranscriptIndex(ds);
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
  gene_expression_graphclust: 'Graph-Based Clustering (GEX)',
};
/** Where 10x's own groupings are listed — Xenium Explorer's heading for them. */
const ONBOARD_SECTION = 'Xenium Onboard Analysis groups';

function groupingLabel(name) {
  if (GROUPING_LABELS[name]) return GROUPING_LABELS[name];
  const k = /kmeans_(\d+)_clusters/.exec(name);
  return k ? `K-Means Clustering (GEX), k=${k[1]}` : name;
}

/** The k-means runs are one choice with a k picker, as in Xenium Explorer. */
function groupingFamily(name) {
  const k = /kmeans_(\d+)_clusters/.exec(name);
  return k ? { id: 'kmeans', label: 'K-Means Clustering (GEX)', variant: `k = ${k[1]}` } : undefined;
}

async function buildColumns(ds) {
  const cols = [];
  if (ds.analysis) {
    const ga = await ds.analysis.attrs('cell_groups');
    for (let g = 0; g < (ga?.number_groupings ?? 0); g++) {
      const name = ga.grouping_names[g];
      const categories = ga.group_names[g];
      const family = groupingFamily(name);
      cols.push({
        meta: {
          kind: 'categorical', name, description: groupingLabel(name), categories,
          section: ONBOARD_SECTION, ...(family ? { family } : {}),
        },
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

  // How each cell was segmented (boundary stain, interior stain, nucleus expansion, …).
  const methods = ds.cellsAttrs.segmentation_methods;
  const cellSet = ds.polygonGrids.find((g) => g.name === 'cell')?.index;
  if (methods?.length && cellSet !== undefined && ds.cells.has(`polygon_sets/${cellSet}/method/.zarray`)) {
    cols.push({
      meta: {
        kind: 'categorical', name: 'segmentation_method', description: 'Segmentation method',
        categories: methods, section: 'Segmentation',
      },
      load: async () => {
        const [method, owner] = await Promise.all([
          ds.cells.read(`polygon_sets/${cellSet}/method`),
          ds.cells.read(`polygon_sets/${cellSet}/cell_index`),
        ]);
        const codes = new Uint16Array(ds.count).fill(NO_CATEGORY);
        for (let i = 0; i < owner.data.length; i++) codes[owner.data[i]] = method.data[i];
        return codes;
      },
    });
  }

  // Transcripts per cell and per µm², summed from the cell-major matrix on first use and
  // cached next to the dataset — one pass over ~600 M counts.
  if (ds.features) {
    const counts = () => derived(ds, 'transcript_count', () => cellTranscriptCounts(ds));
    cols.push({
      meta: { kind: 'continuous', name: 'transcript_count', description: 'Transcripts per cell', unit: 'transcripts', logScaleHint: true },
      load: counts,
    });
    cols.push({
      meta: { kind: 'continuous', name: 'transcript_density', description: 'Transcript density', unit: 'transcripts / µm²' },
      load: async () => {
        const c = await counts();
        const d = new Float32Array(ds.count);
        for (let i = 0; i < ds.count; i++) d[i] = ds.area[i] > 0 ? c[i] / ds.area[i] : 0;
        return d;
      },
    });
  }

  // Groups imported through the viewer ('+'), persisted next to the dataset.
  for (const imported of await loadImportedGroups(ds)) cols.push(imported);
  return cols;
}

/**
 * A derived f32 vector, computed once and cached as `<derivedDir>/<name>.f32` — so a
 * server restart does not redo a full pass over the matrix. `length` is how many floats a
 * valid cached file holds: one per cell by default, `rows × cols` for a density raster.
 */
export async function derived(ds, name, compute, length = ds.count) {
  return chunkCache.get(`${ds.cfg.source}|derived|${name}`, async () => {
    const file = ds.cfg.derivedDir ? path.join(ds.cfg.derivedDir, `${name}.f32`) : null;
    if (file) {
      try {
        const buf = await readFile(file);
        if (buf.length === length * 4) return new Float32Array(buf.buffer, buf.byteOffset, length);
      } catch { /* not cached yet */ }
    }
    const t0 = Date.now();
    const v = await compute();
    console.log(`[xenium] ${ds.cfg.id}: computed ${name} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (file) {
      await mkdir(ds.cfg.derivedDir, { recursive: true });
      // A temp name of its own: two servers may share the derived directory.
      const partial = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
      await writeFile(partial, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      await rename(partial, file);
    }
    return v;
  });
}

/** Sum of every feature's count per cell, from the cell-major (CSC) matrix. */
async function cellTranscriptCounts(ds) {
  const indptr = (await ds.features.read('cell_features/csc/indptr')).data;
  const meta = await ds.features.meta('cell_features/csc/data');
  const cs = meta.chunks[0];
  const out = new Float32Array(ds.count);
  let cell = 0;
  for (let c = 0; c * cs < meta.shape[0]; c++) {
    const chunk = await ds.features.chunk('cell_features/csc/data', meta, [c]);
    const base = c * cs;
    const end = Math.min(meta.shape[0], base + cs);
    for (let k = base; k < end; k++) {
      while (cell < ds.count && k >= indptr[cell + 1]) cell++;
      out[cell] += chunk[k - base];
    }
  }
  return out;
}

/** Parse a `cell_id,group` table and join it onto the observations. */
async function joinCellGroups(ds, text, name, description, section) {
  const rows = parseDelimited(text);
  if (rows.length < 2) throw new RangeError('the table needs a header row and at least one cell');
  const header = rows[0];
  const idCol = header.findIndex((h) => /^(cell_id|cell|barcode)$/i.test(h));
  let labelCol = header.findIndex((h) => /^(cell_?type|group|label|annotation|cluster)$/i.test(h));
  if (labelCol < 0) labelCol = header.findIndex((_, i) => i !== idCol);
  if (idCol < 0 || labelCol < 0) throw new RangeError('the table needs a cell_id column and a group column');
  const byId = new Map();
  for (let i = 1; i < rows.length; i++) {
    const f = rows[i];
    if (f[idCol]) byId.set(f[idCol], f[labelCol] ?? '');
  }
  const ids = await chunkCache.get(`${ds.cfg.source}|cell_id`, async () => (await ds.cells.read('cell_id')).data);
  // Categories ordered by size, largest first — how Xenium Explorer lists groups.
  const sizes = new Map();
  for (const v of byId.values()) sizes.set(v, (sizes.get(v) ?? 0) + 1);
  // Codes are u16 with 0xffff meaning "no group", so at most 65,535 groups fit.
  if (sizes.size >= NO_CATEGORY) throw new RangeError(`too many groups (${sizes.size}); at most ${NO_CATEGORY - 1}`);
  const categories = [...sizes.keys()].sort((a, b) => sizes.get(b) - sizes.get(a) || a.localeCompare(b));
  const code = new Map(categories.map((c, i) => [c, i]));
  const codes = new Uint16Array(ds.count).fill(NO_CATEGORY);
  let matched = 0;
  for (let i = 0; i < ds.count; i++) {
    const label = byId.get(xeniumCellId(ids[2 * i], ids[2 * i + 1]));
    if (label !== undefined) {
      codes[i] = code.get(label);
      matched++;
    }
  }
  if (!matched) throw new RangeError('no cell ids in the table match this dataset');
  return {
    meta: { kind: 'categorical', name, description, categories, section },
    load: async () => codes,
    matched,
  };
}

async function loadImportedGroups(ds) {
  if (!ds.cfg.derivedDir) return [];
  const dir = path.join(ds.cfg.derivedDir, 'groups');
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.csv')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const label = f.slice(0, -4);
      out.push(await joinCellGroups(ds, await readFile(path.join(dir, f), 'utf8'),
        `imported:${label}`, label, 'Imported groups'));
    } catch (err) {
      console.warn(`[xenium] ${ds.cfg.id}: skipping imported group ${f}: ${err.message}`);
    }
  }
  return out;
}

/**
 * Import a cell grouping (CSV/TSV of `cell_id,group`) under `label`: joined now, added to
 * the dataset's columns, and saved so it is there after a restart.
 */
export async function xeniumImportGroups(xeniumDir, id, label, text) {
  const ds = await dataset(xeniumDir, id);
  const clean = String(label ?? '').trim().replace(/[^\w .()-]/g, '').slice(0, 60);
  if (!clean) throw new RangeError('a group name is required');
  const name = `imported:${clean}`;
  const col = await joinCellGroups(ds, text, name, clean, 'Imported groups');
  ds.columns = ds.columns.filter((c) => c.meta.name !== name).concat(col);
  if (ds.cfg.derivedDir) {
    const dir = path.join(ds.cfg.derivedDir, 'groups');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${clean}.csv`), text);
  }
  return { column: col.meta, matched: col.matched, count: ds.count };
}

/** Total transcripts per gene (all qualities), and the dataset total — for estimates. */
export async function xeniumTranscriptCounts(xeniumDir, id, genes) {
  const ds = await dataset(xeniumDir, id);
  if (!ds.geneTotals) {
    const perCodeword = ds.gridAttrs.codeword_to_transcript_counts ?? [];
    const mapping = ds.txAttrs.codeword_gene_mapping ?? [];
    ds.geneTotals = new Float64Array(ds.geneNames.length);
    for (let c = 0; c < perCodeword.length; c++) {
      const g = mapping[c];
      if (g >= 0 && g < ds.geneTotals.length) ds.geneTotals[g] += perCodeword[c];
    }
  }
  const counts = {};
  for (const g of genes) {
    const i = ds.geneIndex.get(g);
    if (i !== undefined) counts[g] = ds.geneTotals[i];
  }
  let real = 0;
  for (let g = 0; g < ds.geneTotals.length; g++) if (ds.geneIsReal[g]) real += ds.geneTotals[g];
  return { counts, total: real, bounds: ds.bounds };
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
  try {
    const text = await readFile(ds.cfg.cellTypes, 'utf8');
    const col = await joinCellGroups(ds, text, 'curated_cell_type',
      `Curated cell types (${path.basename(ds.cfg.cellTypes)})`, 'Imported groups');
    console.log(`[xenium] ${ds.cfg.id}: curated cell types matched ${col.matched}/${ds.count} cells`);
    return col;
  } catch (err) {
    console.warn(`[xenium] ${ds.cfg.id}: cannot use cellTypes ${ds.cfg.cellTypes}: ${err.message}`);
    return null;
  }
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
      // Real genes — Xenium Explorer's denominator; the rest are control codewords.
      geneCount: ds.geneIsReal.reduce((n, v) => n + v, 0),
      hasZ: true,
      levels: ds.transcriptLevels.map((_, l) => ({ tileSize: levels0 * 2 ** l, aggregated: l > 0 })),
      // Levels at or below this one carry an exact per-transcript cell assignment; above
      // it the cell is the one nearest the aggregate's centroid.
      exactCellLevel: EXACT_CELL_MAX_LEVEL,
    },
    ...(!ds.transcriptIndex && ds.transcriptIndexStatus ? {
      transcriptBinsStatus: { ...ds.transcriptIndexStatus },
    } : {}),
    ...(ds.transcriptIndex ? {
      transcriptBins: {
        bounds: ds.bounds,
        origin: ds.transcriptIndex.origin,
        count: ds.transcriptIndex.total,
        levels: ds.transcriptIndex.levels.map((l) => ({ binSize: l.bin, tileSize: l.tileSize })),
      },
    } : {}),
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

// ---------------------------------------------------------------------------
// Marker genes of cell groups
// ---------------------------------------------------------------------------

/**
 * The top `perGroup` marker genes of each group of categorical `column` (see
 * xenium/markers.mjs). The first request reads the whole expression matrix once and scores
 * every built-in clustering in that pass; results are cached in the derived directory.
 * An imported grouping is scored on its own, and again whenever its categories change.
 */
export async function xeniumMarkerGenes(xeniumDir, id, column, perGroup = 5) {
  const ds = await dataset(xeniumDir, id);
  if (!ds.features) throw new RangeError('no cell_feature_matrix in this bundle');
  const col = ds.columns.find((c) => c.meta.name === column);
  if (!col) throw new RangeError(`unknown column: ${column}`);
  if (col.meta.kind !== 'categorical') throw new RangeError(`column "${column}" is not categorical`);
  const n = Math.max(1, Math.min(MARKERS_KEPT, Math.floor(Number(perGroup)) || 5));
  return topMarkers(await markersFor(ds, col), n);
}

const markerKey = (col) => col.meta.categories.join('\u0001');
const markerFile = (ds, name) => (ds.cfg.derivedDir
  ? path.join(ds.cfg.derivedDir, 'markers', `${encodeURIComponent(name)}.json`) : null);

async function markersFor(ds, col) {
  ds.markers ??= new Map();
  const name = col.meta.name;
  const key = markerKey(col);
  const hit = ds.markers.get(name);
  if (hit?.key === key) return hit.result;
  const file = markerFile(ds, name);
  if (file) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.key === key) {
        ds.markers.set(name, saved);
        return saved.result;
      }
    } catch { /* not computed yet */ }
  }
  // One pass at a time: a second request waits for the pass already reading the matrix.
  const imported = name.startsWith('imported:');
  ds.markerPass = (ds.markerPass ?? Promise.resolve()).then(async () => {
    const again = ds.markers.get(name);
    if (again?.key === key) return;
    const cols = imported ? [col] : ds.columns.filter((c) => c.meta.kind === 'categorical'
      && c.meta.name !== 'segmentation_method' && !c.meta.name.startsWith('imported:')
      && ds.markers.get(c.meta.name)?.key !== markerKey(c));
    const groupings = [];
    for (const c of cols) {
      const codes = await chunkCache.get(`${ds.cfg.source}|col|${c.meta.name}`, c.load);
      groupings.push({ name: c.meta.name, codes, categories: c.meta.categories });
    }
    const t0 = Date.now();
    const results = await computeMarkers({
      groupings,
      geneCount: ds.featureNames.length,
      geneName: (g) => ds.featureNames[g],
      isReal: realFeature(ds),
      forEachNonzero: (visit) => forEachFeatureNonzero(ds, visit),
    });
    console.log(`[xenium] ${ds.cfg.id}: marker genes for ${groupings.length} groupings in ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const c of cols) {
      const entry = { key: markerKey(c), result: results.get(c.meta.name) };
      ds.markers.set(c.meta.name, entry);
      const f = markerFile(ds, c.meta.name);
      if (f && !imported) {
        await mkdir(path.dirname(f), { recursive: true });
        const partial = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
        await writeFile(partial, JSON.stringify(entry));
        await rename(partial, f);
      }
    }
  });
  await ds.markerPass;
  return ds.markers.get(name).result;
}

/** Whether each feature of the matrix is a real gene (not a control probe or codeword). */
function realFeature(ds) {
  if (!ds.featureIsReal) {
    ds.featureIsReal = Uint8Array.from(ds.featureNames, (n) => {
      const g = ds.geneIndex.get(n);
      return g !== undefined && ds.geneIsReal[g] === 1 ? 1 : 0;
    });
  }
  return (g) => ds.featureIsReal[g] === 1;
}

/** Every non-zero of the gene-major CSR, chunk by chunk, reading a few chunks ahead. */
async function forEachFeatureNonzero(ds, visit) {
  const indptr = await chunkCache.get(`${ds.cfg.source}|cfm-indptr`,
    async () => (await ds.features.read('cell_features/indptr')).data);
  const im = await ds.features.meta('cell_features/indices');
  const dm = await ds.features.meta('cell_features/data');
  const total = im.shape[0];
  const cs = im.chunks[0];
  const coords = (meta, c) => meta.chunks.map((_, d) => (d === 0 ? c : 0));
  const load = (c) => {
    const base = c * cs;
    const end = Math.min(total, base + cs);
    return Promise.all([
      ds.features.chunk('cell_features/indices', im, coords(im, c)),
      dm.chunks[0] === cs
        ? ds.features.chunk('cell_features/data', dm, coords(dm, c))
        : readRange(ds.features, 'cell_features/data', base, end, `${ds.cfg.source}|cfm`),
    ]);
  };
  const chunks = Math.ceil(total / cs);
  const AHEAD = 4;
  const pending = [];
  for (let c = 0; c < Math.min(AHEAD, chunks); c++) pending.push(load(c));
  let g = 0;
  for (let c = 0; c < chunks; c++) {
    const [idx, dat] = await pending.shift();
    if (c + AHEAD < chunks) pending.push(load(c + AHEAD));
    const base = c * cs;
    const end = Math.min(total, base + cs);
    for (let k = base; k < end; k++) {
      while (k >= indptr[g + 1]) g++;
      visit(g, idx[k - base], dat[k - base]);
    }
  }
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
export async function xeniumTranscriptTile(xeniumDir, id, level, gx, gy, { genes, quality = 'high', box }) {
  const ds = await dataset(xeniumDir, id);
  if (!(level >= 0 && level < ds.transcriptLevels.length)) throw new RangeError(`bad level ${level}`);
  if (genes.length === 1 && genes[0] === '*') {
    // Every real gene, unaggregated — only affordable for a small window, so it is
    // clipped to `box` and served at level 0 only. `gene` carries the global gene index.
    if (level !== 0) throw new RangeError('all-gene transcripts are served at level 0 only');
    const t = await readAllTranscripts(ds, gx, gy, box);
    return encodeTranscripts({ ...t, count: new Uint32Array(t.n).fill(1) }, false);
  }
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

/**
 * Every high-quality transcript of a real gene in one level-0 tile, optionally clipped to
 * `box = [x0, y0, x1, y1]`, with its gene index and the cell it lies in.
 *
 * Rows are grouped by gene with each gene's high-quality run given by `gene_offset`, so
 * the filter is a run-length mask rather than a per-row test of the quality score.
 */
export async function readAllTranscripts(ds, gx, gy, box) {
  const key = `${gx},${gy}`;
  const empty = { n: 0, x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0),
    cell: new Uint32Array(0), gene: new Uint16Array(0) };
  if (!ds.transcriptLevels[0].has(key)) return empty;
  const base = `grids/0/${key}`;
  const cacheKey = `${ds.cfg.source}|tx`;
  const meta = await ds.transcripts.meta(`${base}/location`);
  const rows = meta.shape[0];
  const offsets = await chunkCache.get(`${cacheKey}|${base}/gene_offset`,
    async () => (await ds.transcripts.read(`${base}/gene_offset`)).data);
  const keep = new Uint8Array(rows);
  const geneOf = new Uint16Array(rows);
  for (let g = 0; g < offsets.length / 4; g++) {
    const hs = offsets[4 * g + 2];
    const he = offsets[4 * g + 3];
    if (he > hs) {
      geneOf.fill(g, hs, he);
      if (ds.geneIsReal[g]) keep.fill(1, hs, he);
    }
  }
  const [lx, ly, lz] = await readRows(ds.transcripts, `${base}/location`, 0, rows, 3, cacheKey);
  let n = 0;
  for (let i = 0; i < rows; i++) {
    if (!keep[i]) continue;
    if (box && (lx[i] < box[0] || ly[i] < box[1] || lx[i] >= box[2] || ly[i] >= box[3])) continue;
    n++;
  }
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const gene = new Uint16Array(n);
  let o = 0;
  for (let i = 0; i < rows; i++) {
    if (!keep[i]) continue;
    if (box && (lx[i] < box[0] || ly[i] < box[1] || lx[i] >= box[2] || ly[i] >= box[3])) continue;
    x[o] = lx[i];
    y[o] = ly[i];
    z[o] = lz[i];
    gene[o] = geneOf[i];
    o++;
  }
  const cell = await cellsAtExact(ds, x, y);
  return { n, x, y, z, cell, gene };
}

// ---------------------------------------------------------------------------
// Transcript bins — the all-gene grouping pyramid (built by prepare-xenium)
// ---------------------------------------------------------------------------

/**
 * FALLBACK: build the pyramid in the background when a dataset is opened without one.
 *
 * The intended path is `prepare-xenium --transcripts`, run once next to the data. This
 * makes a dataset added without that step become complete on its own: every other
 * feature works immediately, and "All genes" appears once the build finishes (the
 * manifest reports progress meanwhile as `transcriptBinsStatus`).
 *
 * Builds into `<dir>.partial` and renames on success, so an interrupted build never
 * leaves a half-written pyramid that looks finished. One build at a time — each is a
 * full pass over the transcripts. `XENIUM_AUTO_INDEX=0` turns it off.
 */
let indexQueue = Promise.resolve();
function scheduleTranscriptIndex(ds) {
  const dir = ds.cfg.transcriptIndex;
  if (!dir || process.env.XENIUM_AUTO_INDEX === '0' || ds.transcriptIndexStatus) return;
  ds.transcriptIndexStatus = { state: 'queued', done: 0, total: ds.transcriptLevels[0].size };
  indexQueue = indexQueue.then(async () => {
    const partial = `${dir}.partial`;
    ds.transcriptIndexStatus.state = 'building';
    console.log(`[xenium] ${ds.cfg.id}: no transcript pyramid — building it in the background ` +
      '(run prepare-xenium --transcripts to do this ahead of time)');
    try {
      await rm(partial, { recursive: true, force: true });
      const { buildTranscriptIndex, imagePyramidLevels, DEFAULT_LEVELS } = await import('./xenium/transcript-index.mjs');
      // As many levels as the dataset's tissue image, when it has been prepared.
      const cogDir = process.env.COG_DIR || new URL('../cogs', import.meta.url).pathname;
      const levels = await imagePyramidLevels(path.join(cogDir, `${ds.cfg.id}-tissue`)) ?? DEFAULT_LEVELS;
      await buildTranscriptIndex(ds.cfg.source, partial, {
        dataset: ds,
        levels,
        concurrency: 2,
        log: () => {},
        onProgress: (done, total) => Object.assign(ds.transcriptIndexStatus, { done, total }),
      });
      await rm(dir, { recursive: true, force: true });
      await rename(partial, dir);
      ds.transcriptIndex = await loadTranscriptIndex(dir);
      ds.transcriptIndexStatus = null;
      console.log(`[xenium] ${ds.cfg.id}: transcript pyramid ready (${dir})`);
    } catch (err) {
      ds.transcriptIndexStatus = { state: 'failed', message: String(err?.message ?? err) };
      console.warn(`[xenium] ${ds.cfg.id}: transcript pyramid build failed: ${err?.message ?? err}`);
    }
  });
}

/** The pyramid's `index.json`, or null when it has not been built. */
async function loadTranscriptIndex(dir) {
  if (!dir) return null;
  try {
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    index.dir = dir;
    return index;
  } catch {
    return null;
  }
}

/**
 * One tile of the pyramid in the transcript-tile wire layout: each bin is an entry at its
 * centroid, `count` transcripts, owned by the cell that contributed most of them.
 */
export async function xeniumTranscriptBins(xeniumDir, id, level, tx, ty) {
  const ds = await dataset(xeniumDir, id);
  const index = ds.transcriptIndex;
  if (!index) throw new RangeError('no transcript index for this dataset (run prepare-xenium --transcripts)');
  const lv = index.levels[level];
  if (!lv) throw new RangeError(`bad level ${level}`);
  const entry = lv.tiles[`${tx},${ty}`];
  if (!entry) return encodeTranscripts([], true);
  const [offset, count] = entry;
  const buf = await chunkCache.get(`${index.dir}|${level}|${tx},${ty}`, async () => {
    const fh = await openFile(path.join(index.dir, lv.file), 'r');
    try {
      const b = Buffer.alloc(count * BIN_RECORD);
      await fh.read(b, 0, b.length, offset * BIN_RECORD);
      return b;
    } finally {
      await fh.close();
    }
  });
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const w = new Uint32Array(count);
  const cell = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * BIN_RECORD;
    x[i] = buf.readFloatLE(o);
    y[i] = buf.readFloatLE(o + 4);
    w[i] = buf.readUInt32LE(o + 8);
    cell[i] = buf.readUInt32LE(o + 12);
  }
  return encodeTranscripts({
    n: count, x, y, z: new Float32Array(count), count: w, cell, gene: new Uint16Array(count),
  }, true);
}

/** Largest box `transcript-summary` will scan, per side (observation units = µm). */
const SUMMARY_MAX_SIDE = 300;

/**
 * What is in a box: the transcripts (optionally only `genes`), how many distinct genes and
 * cells they belong to, the most frequent of each, and the 10x id strings of the cells in
 * `cells`. Backs the hover details of a transcript marker or a grouped bin.
 *
 * `box` may be omitted when only `cells` are asked for (a cell-id lookup).
 */
export async function xeniumTranscriptSummary(xeniumDir, id, { box, genes, cells = [], top = 6 }) {
  const ds = await dataset(xeniumDir, id);
  const cellIdStr = await cellIdStrings(ds, cells);
  if (!box) return { cellIds: cellIdStr };
  if (box[2] - box[0] > SUMMARY_MAX_SIDE || box[3] - box[1] > SUMMARY_MAX_SIDE) {
    throw new RangeError(`summary box larger than ${SUMMARY_MAX_SIDE} per side`);
  }
  const wanted = genes?.length ? new Set(genes.map((g) => ds.geneIndex.get(g))) : null;
  const size = SOURCE_TILE_SIZE;
  const geneCount = new Map();
  const cellCount = new Map();
  let n = 0;
  let unassigned = 0;
  for (let gy = Math.floor(box[1] / size); gy * size < box[3]; gy++) {
    for (let gx = Math.floor(box[0] / size); gx * size < box[2]; gx++) {
      const t = await readAllTranscripts(ds, gx, gy, box);
      for (let i = 0; i < t.n; i++) {
        if (wanted && !wanted.has(t.gene[i])) continue;
        n++;
        geneCount.set(t.gene[i], (geneCount.get(t.gene[i]) ?? 0) + 1);
        if (t.cell[i] === NO_CELL) unassigned++;
        else cellCount.set(t.cell[i], (cellCount.get(t.cell[i]) ?? 0) + 1);
      }
    }
  }
  const topOf = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  const topCells = topOf(cellCount);
  const ids = await cellIdStrings(ds, topCells.map(([c]) => c));
  return {
    transcripts: n,
    genes: geneCount.size,
    topGenes: topOf(geneCount).map(([g, count]) => ({ name: ds.geneNames[g], count })),
    cells: cellCount.size,
    unassigned,
    topCells: topCells.map(([index, count]) => ({ index, id: ids[index], count })),
    cellIds: cellIdStr,
  };
}

const SOURCE_TILE_SIZE = 250;

/** 10x cell id strings (`aaabbbcc-1`) for observation indices. */
async function cellIdStrings(ds, indices) {
  if (!indices.length) return {};
  const ids = await chunkCache.get(`${ds.cfg.source}|cell_id`, async () => (await ds.cells.read('cell_id')).data);
  const out = {};
  for (const i of indices) {
    if (i >= 0 && i < ds.count) out[i] = xeniumCellId(ids[2 * i], ids[2 * i + 1]);
  }
  return out;
}

/** Bytes per bin record in a pyramid level file: f32 cx, f32 cy, u32 count, u32 cell. */
export const BIN_RECORD = 16;

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
export async function cellsAtExact(ds, x, y) {
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

/**
 * Summed transcript counts on the bundle's 10 µm density grid, re-binned to `bin` µm
 * (10, 20, 40 or 80 — whole multiples of the grid), for `genes` or `['*']` for every real
 * gene. Layout: `[u32 rows][u32 cols][f32 cellW][f32 cellH][f32 originX][f32 originY]`
 * then `f32[rows × cols]`.
 */
export async function xeniumDensity(xeniumDir, id, genes, bin = 10) {
  const ds = await dataset(xeniumDir, id);
  if (!ds.densityAttrs) throw new RangeError('no density grid in this bundle');
  const { rows, cols } = ds.densityAttrs;
  const base = ds.densityAttrs.grid_size[0];
  // Exactly 1, 2, 4 or 8 grid cells per bin — never rounded to a size the caller did not ask for.
  const f = [1, 2, 4, 8].find((k) => Math.abs(bin - base * k) < 1e-6);
  if (!f) throw new RangeError(`bin must be ${base}, ${2 * base}, ${4 * base} or ${8 * base} µm`);
  const fine = genes.length === 1 && genes[0] === '*'
    ? await derived(ds, 'density_all_genes', () => allGenesDensity(ds), rows * cols)
    : await genesDensity(ds, genes);
  const R = Math.ceil(rows / f);
  const C = Math.ceil(cols / f);
  const out = Buffer.alloc(24 + R * C * 4);
  out.writeUInt32LE(R, 0);
  out.writeUInt32LE(C, 4);
  out.writeFloatLE(base * f, 8);
  out.writeFloatLE(ds.densityAttrs.grid_size[1] * f, 12);
  out.writeFloatLE(ds.densityAttrs.origin.x, 16);
  out.writeFloatLE(ds.densityAttrs.origin.y, 20);
  const v = new Float32Array(out.buffer, out.byteOffset + 24, R * C);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) v[Math.floor(r / f) * C + Math.floor(c / f)] += fine[r * cols + c];
  }
  return out;
}

async function genesDensity(ds, genes) {
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
  return out;
}

/** Every real gene's density summed, streaming the CSR once, chunk by chunk. */
async function allGenesDensity(ds) {
  const { rows, cols } = ds.densityAttrs;
  const names = ds.densityAttrs.gene_names;
  const real = names.map((n) => ds.geneIsReal[ds.geneIndex.get(n)] ?? 0);
  const indptr = (await ds.transcripts.read('density/gene/indptr')).data;
  const im = await ds.transcripts.meta('density/gene/indices');
  const dm = await ds.transcripts.meta('density/gene/data');
  const cs = im.chunks[0];
  const out = new Float32Array(rows * cols);
  let row = 0; // CSR row = gene * rows + r
  for (let c = 0; c * cs < im.shape[0]; c++) {
    const [idx, dat] = await Promise.all([
      ds.transcripts.chunk('density/gene/indices', im, [c]),
      ds.transcripts.chunk('density/gene/data', dm, [c]),
    ]);
    const base = c * cs;
    const end = Math.min(im.shape[0], base + cs);
    for (let k = base; k < end; k++) {
      while (k >= indptr[row + 1]) row++;
      if (!real[Math.floor(row / rows)]) continue;
      out[(row % rows) * cols + idx[k - base]] += dat[k - base];
    }
  }
  return out;
}
