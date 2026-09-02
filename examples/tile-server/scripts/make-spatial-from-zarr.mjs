// Convert a SpatialData Zarr store into this server's spatial bundle + a tissue
// pyramid — in plain Node, no Python.
//
//   node scripts/make-spatial-from-zarr.mjs --input <store.zarr> --list
//   npm run make-spatial -- --input <store.zarr> [--table T] [--sample S] [--genes N]
//
// Handles the two store shapes the sandbox datasets come in:
//
//   CIRCLES  (plain Visium)      one `table`, spot centres in `obsm/spatial`,
//                                a uniform spot radius, no boundaries.
//   POLYGONS (Visium HD, Xenium) one table PER segmentation, an EMPTY `obsm` —
//                                so centroids, per-cell radii and the outlines
//                                all come from the shapes GeoParquet.
//
// WHY NO PYTHON
// -------------
// These stores are Zarr v3 with `bytes` + `zstd` codecs and `vlen-utf8`
// strings; Node 24 ships zstd in `node:zlib` (see lib/zarr3.mjs). The shapes are
// GeoParquet, which hyparquet reads and decodes to GeoJSON (lib/geoparquet.mjs).
//
// THREE THINGS A NAIVE READER GETS WRONG
// --------------------------------------
//  1. A table can be MULTI-SAMPLE (one row block per section), so rows must be
//     filtered by the region column before anything is index-aligned.
//  2. The SHAPES carry the transform into the image's coordinate system — that
//     scale IS `imageRef.scale`. Plain Visium needs ~0.115, Visium HD ~0.281;
//     skipping it puts every observation 3.5-8.7x too far out.
//  3. The image's pyramid level is named by its multiscales metadata (`0` for
//     Visium, `s0` for HD), and its coordinate system is stated there too.
//
// The expression matrix is CSR over observations, so reading one gene means
// touching every row. It is transposed once here into the gene-major layout the
// server range-reads — the reason ingest is a build step, not a browser feature.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { readArray, readAttrs, readMeta, scaleFor } from '../lib/zarr3.mjs';
import { readShapes } from '../lib/geoparquet.mjs';
import { kmeansClusters } from '../lib/cluster.mjs';
import { writePyramid } from '../lib/pyramid.mjs';

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (flag) => args.includes(flag);

const INPUT = argOf('--input', null);
if (!INPUT) {
  console.error(
    'usage: --input <store.zarr> [--list] [--table T] [--sample S] [--id ID]\n'
    + '       [--genes N] [--max-matrix-mb 64] [--out DIR] [--cog-dir DIR] [--no-polygons]',
  );
  process.exit(2);
}
const OUT_ROOT = argOf('--out', new URL('../spatial', import.meta.url).pathname);
const COG_ROOT = argOf('--cog-dir', new URL('../cogs', import.meta.url).pathname);
const GENE_LIMIT = Number(argOf('--genes', 2000));
const MATRIX_BUDGET_MB = Number(argOf('--max-matrix-mb', 64));
/** Physical size of the technology's grid pitch, in µm. Visium HD bins are 2 µm.
 *  Given this, the converter MEASURES the grid in the outlines and derives the
 *  image's µm/px from it — nothing in the store states that. */
const GRID_UM = argOf('--grid-um', null);
/** Derive a `cluster` column by k-means on expression. These stores are RAW —
 *  no clusters, no cell types — so without this there is nothing to group a
 *  violin by, put in a legend, or select a category of. 0 disables. */
const CLUSTERS = Number(argOf('--cluster', 8));

/** Visium v1: 55 µm spots on a 100 µm centre-to-centre grid. */
const VISIUM_RADIUS_OVER_PITCH = 27.5 / 100;
/** Inline feature names in the manifest below this count (a few dozen KB). */
const INLINE_NAMES_LIMIT = 2000;
const MAX_CATEGORY_CARDINALITY = 64;

const listDirs = async (p) => (await readdir(p, { withFileTypes: true }).catch(() => []))
  .filter((e) => e.isDirectory()).map((e) => e.name);

// ── discovery ───────────────────────────────────────────────────────────────

const tables = await listDirs(path.join(INPUT, 'tables'));
const shapeElements = await listDirs(path.join(INPUT, 'shapes'));
const imageElements = await listDirs(path.join(INPUT, 'images'));

if (has('--list') || tables.length === 0) {
  console.log('tables:', tables.join(', ') || '(none)');
  console.log('shapes:', shapeElements.join(', ') || '(none)');
  console.log('images:', imageElements.join(', ') || '(none)');
  process.exit(tables.length ? 0 : 1);
}

const TABLE_NAME = argOf('--table', tables[0]);
if (!tables.includes(TABLE_NAME)) {
  console.error(`no table "${TABLE_NAME}" — available: ${tables.join(', ')}`);
  process.exit(1);
}
const TABLE = `tables/${TABLE_NAME}`;
console.log(`[zarr] ${INPUT}`);
console.log(`[zarr] table ${TABLE_NAME}`);

// ── obs ─────────────────────────────────────────────────────────────────────

async function readObsColumn(name) {
  const meta = await readMeta(INPUT, `${TABLE}/obs/${name}`);
  if (meta.node_type === 'group') {
    const [categories, codes] = await Promise.all([
      readArray(INPUT, `${TABLE}/obs/${name}/categories`),
      readArray(INPUT, `${TABLE}/obs/${name}/codes`),
    ]);
    return { kind: 'categorical', name, categories: categories.data, codes: codes.data };
  }
  const arr = await readArray(INPUT, `${TABLE}/obs/${name}`);
  return { kind: 'array', name, values: arr.data, dtype: meta.data_type };
}

const obsNames = (await listDirs(path.join(INPUT, TABLE, 'obs'))).filter((n) => !n.startsWith('.'));
const obsColumns = [];
for (const name of obsNames) {
  if (name === '_index') continue;
  obsColumns.push(await readObsColumn(name));
}

// The region column names the shapes element(s) this table annotates.
const regionCol = obsColumns.find(
  (c) => c.kind === 'categorical' && c.categories.some((v) => shapeElements.includes(String(v))),
);
if (!regionCol) {
  console.error(`no obs column names a shapes element; shapes are: ${shapeElements.join(', ')}`);
  process.exit(1);
}
const regions = regionCol.categories.map(String);
const SAMPLE = argOf('--sample', regions[0]);
if (!regions.includes(SAMPLE)) {
  console.error(`no region "${SAMPLE}" in this table — available: ${regions.join(', ')}`);
  process.exit(1);
}
const sampleCode = regions.indexOf(SAMPLE);

// A single-region table needs no filtering; a multi-sample one does.
const keep = [];
for (let i = 0; i < regionCol.codes.length; i++) {
  if (Number(regionCol.codes[i]) === sampleCode) keep.push(i);
}
const N = keep.length;
const ID = argOf('--id', SAMPLE.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
const IMAGE_ID = `${ID}-tissue`;
console.log(`[table] region "${SAMPLE}": ${N} of ${regionCol.codes.length} rows`);
console.log(`[table] dataset "${ID}", image "${IMAGE_ID}"`);

// ── the image, and the coordinate system it defines ────────────────────────

/** Prefer this region's hires image; else any hires; else the first image. */
const imageName = imageElements.find((n) => n === `${SAMPLE}_hires_image`)
  ?? imageElements.find((n) => n.includes(SAMPLE) && n.includes('hires'))
  ?? imageElements.find((n) => n.includes('hires'))
  ?? imageElements[0];
if (!imageName) {
  console.error('no image element in this store');
  process.exit(1);
}
const imageAttrs = await readAttrs(INPUT, `images/${imageName}`);
const multiscales = imageAttrs?.ome?.multiscales?.[0] ?? imageAttrs?.multiscales?.[0];
// The level is named by the metadata: `0` for Visium, `s0` for Visium HD.
const levelPath = multiscales?.datasets?.[0]?.path ?? '0';
// The image maps in by identity, so its output names the coordinate system the
// observations must be transformed into.
const identity = (multiscales?.coordinateTransformations ?? [])
  .find((t) => t.type === 'identity') ?? (multiscales?.coordinateTransformations ?? [])[0];
const coordinateSystem = identity?.output?.name ?? SAMPLE;
console.log(`[image] ${imageName}/${levelPath} in coordinate system "${coordinateSystem}"`);

// ── geometry: obsm/spatial (circles) or the shapes GeoParquet (polygons) ───

const shapesDir = path.join(INPUT, 'shapes', SAMPLE);
const shapeFiles = await readdir(shapesDir).catch(() => []);
const hasParquet = shapeFiles.includes('shapes.parquet');
const obsmEntries = await listDirs(path.join(INPUT, TABLE, 'obsm'));

let xs;
let ys;
let radiusSpec;
let radiusVector = null;
let polygons = null;

if (obsmEntries.includes('spatial')) {
  // Circle store: centres are index-aligned with the table already.
  const spatial = await readArray(INPUT, `${TABLE}/obsm/spatial`);
  xs = new Float32Array(N);
  ys = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    xs[i] = Number(spatial.data[keep[i] * 2]);
    ys[i] = Number(spatial.data[keep[i] * 2 + 1]);
  }
  console.log('[coords] from obsm/spatial');
} else if (hasParquet) {
  // Segmentation store: geometry lives only in the parquet. Join by id, since
  // row order is not guaranteed to match the table.
  console.log('[coords] obsm is empty — reading shapes.parquet');
  const shapes = await readShapes(path.join(shapesDir, 'shapes.parquet'));
  const byId = new Map(shapes.ids.map((v, i) => [v, i]));
  const idCol = obsColumns.find((c) => c.kind === 'array' && /(^|_)id$/i.test(c.name));
  const tableIds = idCol
    ? keep.map((i) => String(idCol.values[i]))
    : (await readArray(INPUT, `${TABLE}/obs/_index`)).data;
  xs = new Float32Array(N);
  ys = new Float32Array(N);
  radiusVector = new Float32Array(N);
  let matched = 0;
  const rows = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const row = byId.get(String(idCol ? tableIds[i] : tableIds[keep[i]])) ?? -1;
    rows[i] = row;
    if (row < 0) continue;
    matched++;
    xs[i] = shapes.cx[row];
    ys[i] = shapes.cy[row];
    radiusVector[i] = shapes.radius[row];
  }
  console.log(`[coords] joined ${matched}/${N} rows to shapes by id`);
  if (matched === 0) {
    console.error('no rows joined — the table and shapes ids disagree');
    process.exit(1);
  }
  if (!has('--no-polygons')) {
    // Re-pack the outlines in table-row order so ring i is observation i.
    const counts = new Uint32Array(N + 1);
    for (let i = 0; i < N; i++) {
      const row = rows[i];
      counts[i] = row < 0 ? 0 : shapes.offsets[row + 1] - shapes.offsets[row];
    }
    const offsets = new Uint32Array(N + 1);
    let total = 0;
    for (let i = 0; i < N; i++) { offsets[i] = total; total += counts[i]; }
    offsets[N] = total;
    const coords = new Float32Array(total * 2);
    for (let i = 0; i < N; i++) {
      const row = rows[i];
      if (row < 0) continue;
      const from = shapes.offsets[row] * 2;
      coords.set(shapes.coords.subarray(from, from + counts[i] * 2), offsets[i] * 2);
    }
    polygons = { offsets, coords, total };
    console.log(`[coords] ${total} outline vertices (avg ${(total / N).toFixed(1)}/cell)`);
  }
} else {
  console.error(`no obsm/spatial and no shapes.parquet for "${SAMPLE}" — nothing to position`);
  process.exit(1);
}

const [scaleX, scaleY] = scaleFor(await readAttrs(INPUT, `shapes/${SAMPLE}`), coordinateSystem);
console.log(`[coords] imageRef.scale = [${scaleX}, ${scaleY}]`);

/**
 * The most common non-zero vertex-to-vertex step across the outlines. For a
 * segmentation traced on a bin grid this is exactly one bin (harmonics at 2x, 3x
 * appear but are rarer), which turns the outlines into a ruler.
 */
function modalVertexStep(poly) {
  const hist = new Map();
  const limit = Math.min(N, 3000);
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
  for (const [d, count] of hist) if (count > bestCount) { bestCount = count; best = d; }
  return best;
}

/** Median nearest-neighbour distance over a sample of observations. */
function medianPitch() {
  const step = Math.max(1, Math.floor(N / 400));
  const nn = [];
  for (let a = 0; a < N; a += step) {
    let best = Infinity;
    for (let b = 0; b < N; b++) {
      if (a === b) continue;
      const dx = xs[a] - xs[b];
      const dy = ys[a] - ys[b];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    if (Number.isFinite(best)) nn.push(Math.sqrt(best));
  }
  nn.sort((p, q) => p - q);
  return nn[Math.floor(nn.length / 2)] ?? 0;
}

const pitch = medianPitch();
let mpp = null;
if (radiusVector) {
  // Segmented cells have no common size; each carries its own
  // equivalent-circle radius from its outline's area.
  radiusSpec = { mode: 'per-observation' };
  const sorted = Array.from(radiusVector).sort((a, b) => a - b);
  console.log(`[coords] per-cell radius: median ${sorted[sorted.length >> 1].toFixed(1)} px`);
  if (GRID_UM && polygons) {
    // Segmentations derived from a binned assay trace the bin grid, so the modal
    // vertex-to-vertex step IS one bin. With the bin's physical size asserted by
    // --grid-um, that gives the image's µm/px and a correct scale bar.
    const step = modalVertexStep(polygons);
    if (step > 0) {
      mpp = Number(GRID_UM) / (step * scaleX);
      console.log(`[coords] grid pitch ${step.toFixed(2)} px = ${GRID_UM} um `
        + `-> image ${mpp.toFixed(4)} um/px`);
    }
  }
} else {
  const radius = pitch * VISIUM_RADIUS_OVER_PITCH;
  radiusSpec = { mode: 'uniform', value: radius };
  // Visium's pitch is a known 100 µm, so the grid doubles as a ruler: measuring
  // it in the SERVED image's pixels gives that image's µm/px, and the scale bar
  // with it. Nothing else in the store states this.
  mpp = 100 / (pitch * scaleX);
  console.log(`[coords] spot pitch ${pitch.toFixed(1)} px -> radius ${radius.toFixed(1)} px, `
    + `image ${mpp.toFixed(3)} um/px`);
}

// ── columns ─────────────────────────────────────────────────────────────────

const columns = [];
const columnPayloads = [];

for (const col of obsColumns) {
  if (col === regionCol) continue; // constant after filtering
  if (col.kind === 'array' && col.dtype === 'string') continue; // ids carry no encoding
  if (col.kind === 'categorical') {
    const codes = new Uint16Array(N);
    const present = new Set();
    for (let i = 0; i < N; i++) {
      codes[i] = Number(col.codes[keep[i]]);
      present.add(codes[i]);
    }
    // A column with one value left after filtering (in_tissue, once
    // out-of-tissue spots are gone) groups nothing and just clutters the picker.
    if (present.size < 2) {
      console.log(`[columns] skipping "${col.name}" — constant after filtering`);
      continue;
    }
    columns.push({ kind: 'categorical', name: col.name, categories: col.categories.map(String) });
    columnPayloads.push(Buffer.from(codes.buffer));
    continue;
  }
  const values = new Float32Array(N);
  for (let i = 0; i < N; i++) values[i] = Number(col.values[keep[i]]);
  const distinct = new Set(values);
  // A distinct integer per observation is an IDENTIFIER (spot_id, cell index),
  // not a measurement — charting or colouring by it is meaningless.
  if (distinct.size === N && N > 1 && [...distinct].every((v) => Number.isInteger(v))) {
    continue;
  }
  if (distinct.size < 2) {
    // Constant after filtering (in_tissue, once out-of-tissue rows are gone):
    // it groups nothing and only clutters the pickers.
    console.log(`[columns] skipping "${col.name}" — constant after filtering`);
    continue;
  }
  if (distinct.size <= MAX_CATEGORY_CARDINALITY
      && [...distinct].every((v) => Number.isInteger(v))) {
    const cats = [...distinct].sort((a, b) => a - b);
    const lookup = new Map(cats.map((v, i) => [v, i]));
    const codes = new Uint16Array(N);
    for (let i = 0; i < N; i++) codes[i] = lookup.get(values[i]) ?? 0xffff;
    columns.push({ kind: 'categorical', name: col.name, categories: cats.map(String) });
    columnPayloads.push(Buffer.from(codes.buffer));
  } else {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    columns.push({
      kind: 'continuous', name: col.name,
      logScaleHint: /counts|umi|total/i.test(col.name), min, max,
    });
    columnPayloads.push(Buffer.from(values.buffer));
  }
}

// Cell area is a genuinely useful continuous column and comes free.
if (radiusVector) {
  const area = new Float32Array(N);
  for (let i = 0; i < N; i++) area[i] = Math.PI * radiusVector[i] * radiusVector[i];
  let min = Infinity;
  let max = -Infinity;
  for (const v of area) { if (v < min) min = v; if (v > max) max = v; }
  columns.push({
    kind: 'continuous', name: 'area', unit: 'px²', logScaleHint: true, min, max,
    description: 'Segmented area (derived from the outline)',
  });
  columnPayloads.push(Buffer.from(area.buffer));
}

// ── expression: CSR (obs-major) -> gene-major ──────────────────────────────

console.log('[genes] reading X (CSR)…');
const geneNames = (await readArray(INPUT, `${TABLE}/var/_index`)).data;
const [xData, xIndices, xIndptr] = await Promise.all([
  readArray(INPUT, `${TABLE}/X/data`),
  readArray(INPUT, `${TABLE}/X/indices`),
  readArray(INPUT, `${TABLE}/X/indptr`),
]);
const data = xData.data;
const indices = xIndices.data;
const indptr = xIndptr.data;

// A gene-major matrix is `genes x N x 4` bytes, which grows fast: 84k cells x
// 2000 genes would be 672 MB. Cap it and say what was dropped.
const perGeneMb = (N * 4) / 1e6;
const budgetGenes = Math.max(1, Math.floor(MATRIX_BUDGET_MB / perGeneMb));
const geneCount = Math.min(GENE_LIMIT, budgetGenes, geneNames.length);
if (geneCount < Math.min(GENE_LIMIT, geneNames.length)) {
  console.log(`[genes] capped at ${geneCount} genes by --max-matrix-mb ${MATRIX_BUDGET_MB} `
    + `(${perGeneMb.toFixed(3)} MB per gene at ${N} observations)`);
}

const totals = new Float64Array(geneNames.length);
for (const row of keep) {
  const start = Number(indptr[row]);
  const end = Number(indptr[row + 1]);
  for (let k = start; k < end; k++) totals[indices[k]] += data[k];
}
const selected = Array.from(totals.keys())
  .sort((a, b) => totals[b] - totals[a])
  .slice(0, geneCount)
  .sort((a, b) => a - b);
const geneSlot = new Map(selected.map((g, i) => [g, i]));
const selectedNames = selected.map((g) => String(geneNames[g]));

const matrix = new Float32Array(selected.length * N);
const totalCounts = new Float32Array(N);
const nGenes = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const row = keep[i];
  const start = Number(indptr[row]);
  const end = Number(indptr[row + 1]);
  let sum = 0;
  let detected = 0;
  for (let k = start; k < end; k++) {
    const v = data[k];
    sum += v;
    if (v > 0) detected++;
    const slot = geneSlot.get(indices[k]);
    if (slot !== undefined) matrix[slot * N + i] = v;
  }
  totalCounts[i] = sum;
  nGenes[i] = detected;
}
console.log(`[genes] ${selectedNames.length} of ${geneNames.length} genes, `
  + `${(matrix.byteLength / 1e6).toFixed(1)} MB gene-major`);

// Derived QC. A raw table carries only ids and a region, so without these there
// is nothing meaningful to colour by.
{
  const stats = (v) => {
    let min = Infinity;
    let max = -Infinity;
    for (const x of v) { if (x < min) min = x; if (x > max) max = x; }
    return { min, max };
  };
  const tc = stats(totalCounts);
  const ng = stats(nGenes);
  columns.push({
    kind: 'continuous', name: 'total_counts', unit: 'counts', logScaleHint: true,
    description: 'UMI counts per observation (derived from X)', ...tc,
  });
  columnPayloads.push(Buffer.from(totalCounts.buffer));
  columns.push({
    kind: 'continuous', name: 'n_genes_by_counts', unit: 'genes', logScaleHint: false,
    description: 'Genes detected per observation (derived from X)', ...ng,
  });
  columnPayloads.push(Buffer.from(nGenes.buffer));
  console.log(`[qc] total_counts ${tc.min}-${tc.max}, n_genes ${ng.min}-${ng.max}`);
}
// Derived clusters. Uses the gene-major matrix that already exists, so it costs
// no extra I/O.
if (CLUSTERS >= 2 && selectedNames.length > 1) {
  const t0 = Date.now();
  const labels = kmeansClusters(matrix, selectedNames.length, N, { k: CLUSTERS });
  const sizes = new Array(CLUSTERS).fill(0);
  for (const c of labels) sizes[c]++;
  columns.push({
    kind: 'categorical',
    name: 'cluster',
    categories: sizes.map((_, i) => `cluster ${i}`),
    description: `k-means (k=${CLUSTERS}) on log1p-normalised expression — `
      + 'derived for the demo, not an analysis result',
  });
  columnPayloads.push(Buffer.from(labels.buffer));
  console.log(`[cluster] k=${CLUSTERS} in ${((Date.now() - t0) / 1000).toFixed(1)}s, `
    + `sizes ${sizes.join('/')}`);
}
console.log(`[columns] ${columns.map((c) => c.name).join(', ')}`);

// ── tissue image -> pyramid ────────────────────────────────────────────────

const img = await readArray(INPUT, `images/${imageName}/${levelPath}`);
const [bands, height, width] = img.shape;
const rgb = Buffer.allocUnsafe(width * height * 3);
const plane = width * height;
for (let p = 0; p < plane; p++) {
  rgb[p * 3] = img.data[p];
  rgb[p * 3 + 1] = bands > 1 ? img.data[plane + p] : img.data[p];
  rgb[p * 3 + 2] = bands > 2 ? img.data[2 * plane + p] : img.data[p];
}
const pyramid = await writePyramid(
  path.join(COG_ROOT, IMAGE_ID),
  sharp(rgb, { raw: { width, height, channels: 3 } }),
  { width, height, mppX: mpp, mppY: mpp, onLevel: (r, w, h) => console.log(`  L${r}  ${w}x${h}`) },
);

// ── write the bundle ───────────────────────────────────────────────────────

const outDir = path.join(OUT_ROOT, ID);
await mkdir(path.join(outDir, 'columns'), { recursive: true });
await mkdir(path.join(outDir, 'features'), { recursive: true });

const coords = new Float32Array(N * 2);
coords.set(xs, 0);
coords.set(ys, N);
await writeFile(path.join(outDir, 'coords.bin'), Buffer.from(coords.buffer));

const obsIndex = (await readArray(INPUT, `${TABLE}/obs/_index`)).data;
await writeFile(path.join(outDir, 'ids.json'),
  JSON.stringify({ ids: keep.map((i) => String(obsIndex[i])) }));

if (radiusVector) {
  await writeFile(path.join(outDir, 'radius.bin'), Buffer.from(radiusVector.buffer));
}
if (polygons) {
  const header = new Uint32Array(1 + N + 1);
  header[0] = N;
  header.set(polygons.offsets, 1);
  await writeFile(path.join(outDir, 'polygons.bin'),
    Buffer.concat([Buffer.from(header.buffer), Buffer.from(polygons.coords.buffer)]));
}
for (let i = 0; i < columnPayloads.length; i++) {
  await writeFile(path.join(outDir, 'columns', `${i}.bin`), columnPayloads[i]);
}
await writeFile(path.join(outDir, 'features', 'names.json'), JSON.stringify(selectedNames));
await writeFile(path.join(outDir, 'features', 'matrix.f32'), Buffer.from(matrix.buffer));

const manifest = {
  version: 1,
  id: ID,
  name: argOf('--name', `${SAMPLE} · ${TABLE_NAME}`),
  count: N,
  hasIds: true,
  radius: radiusSpec,
  columns,
  features: {
    count: selectedNames.length,
    ...(selectedNames.length <= INLINE_NAMES_LIMIT ? { names: selectedNames } : {}),
    unit: 'raw counts',
    logScaleHint: true,
  },
  imageRef: {
    imageId: IMAGE_ID,
    scale: [scaleX, scaleY],
    translate: [0, 0],
    ...(mpp ? { mppX: mpp, mppY: mpp } : {}),
  },
  ...(polygons ? { polygons: { count: N } } : {}),
};
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\n[done] ${outDir}`);
console.log(`       image ${path.join(COG_ROOT, IMAGE_ID)} - ${width}x${height}, `
  + `${pyramid.realLevels} levels${mpp ? `, ${mpp.toFixed(3)} um/px` : ''}`);
console.log(`       gallery: { imageId: '${IMAGE_ID}', width: ${width}, height: ${height}, `
  + `${mpp ? `mppX: ${mpp.toFixed(4)}, mppY: ${mpp.toFixed(4)}, ` : ''}spatialDatasetId: '${ID}' }`);
