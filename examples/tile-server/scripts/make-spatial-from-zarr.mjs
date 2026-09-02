// Convert a SpatialData Zarr store into this server's spatial bundle + a tissue
// pyramid — in plain Node, with no Python and no Zarr/Parquet libraries.
//
//   node scripts/make-spatial-from-zarr.mjs --input <store.zarr> --list
//   node scripts/make-spatial-from-zarr.mjs --input <store.zarr> --sample ST8059048
//
// Get the Visium mouse-brain store with:
//   curl -O https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_spatialdata_0.7.1.zip
//   unzip visium_spatialdata_0.7.1.zip        # -> data.zarr
//
// WHY THIS IS DOABLE WITHOUT THE PYTHON STACK
// -------------------------------------------
// These stores are Zarr v3 with `bytes` + `zstd` codecs and `vlen-utf8` for
// string arrays. Node 24 ships zstd in `node:zlib`, and vlen-utf8 is a few
// lines (lib/zarr3.mjs) — so the whole conversion runs on the same toolchain as
// the rest of the example.
//
// Two things it reads that a naive port would get wrong:
//  - the SPOT SHAPES carry the full-res -> hires `scale` transform, which is
//    exactly the `imageRef.scale` the viewer needs. Skip it and every spot lands
//    ~8.7x too far out.
//  - the table is MULTI-SAMPLE (one row block per section), so rows must be
//    filtered by the region column before anything is index-aligned.
//
// The expression matrix is CSR over observations, so reading one gene means
// touching every row — this transposes once, offline, into the gene-major
// layout the server range-reads. That is the whole reason ingest is a build
// step and not a browser feature.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { readArray, readAttrs, readMeta, scaleFor } from '../lib/zarr3.mjs';
import { writePyramid } from '../lib/pyramid.mjs';

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (flag) => args.includes(flag);

const INPUT = argOf('--input', null);
if (!INPUT) {
  console.error('usage: node scripts/make-spatial-from-zarr.mjs --input <store.zarr> [--list] [--sample ID] [--genes N] [--out DIR] [--cog-dir DIR]');
  process.exit(2);
}
const OUT_ROOT = argOf('--out', new URL('../spatial', import.meta.url).pathname);
const COG_ROOT = argOf('--cog-dir', new URL('../cogs', import.meta.url).pathname);
const GENE_LIMIT = Number(argOf('--genes', 2000));
const TABLE = 'tables/table';

/** Visium v1: 55 µm spots on a 100 µm centre-to-centre grid. */
const VISIUM_RADIUS_OVER_PITCH = 27.5 / 100;
/** Inline the feature names in the manifest below this many (a few dozen KB). */
const INLINE_NAMES_LIMIT = 2000;

// ── discovery ───────────────────────────────────────────────────────────────

const samples = (await readdir(path.join(INPUT, 'shapes'), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

if (has('--list') || samples.length === 0) {
  const images = await readdir(path.join(INPUT, 'images')).catch(() => []);
  console.log('shapes (samples):', samples.join(', ') || '(none)');
  console.log('images:          ', images.filter((n) => !n.startsWith('.')).join(', '));
  process.exit(samples.length ? 0 : 1);
}

const SAMPLE = argOf('--sample', samples[0]);
if (!samples.includes(SAMPLE)) {
  console.error(`no shapes element "${SAMPLE}" — available: ${samples.join(', ')}`);
  process.exit(1);
}
const ID = argOf('--id', SAMPLE.toLowerCase());
const IMAGE_ID = `${ID}-tissue`;

console.log(`[zarr] ${INPUT}`);
console.log(`[zarr] sample ${SAMPLE} -> dataset "${ID}", image "${IMAGE_ID}"`);

// ── table ───────────────────────────────────────────────────────────────────

const obsDir = path.join(INPUT, TABLE, 'obs');
const obsNames = (await readdir(obsDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name);

/** Read one obs column: a group with categories+codes, or a plain array. */
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

const obsColumns = [];
for (const name of obsNames) {
  if (name === '_index') continue;
  obsColumns.push(await readObsColumn(name));
}

// The region column says which sample each row belongs to.
const regionCol = obsColumns.find(
  (c) => c.kind === 'categorical' && c.categories.includes(SAMPLE),
);
if (!regionCol) {
  console.error(`could not find an obs column naming "${SAMPLE}" — is this a multi-sample table?`);
  process.exit(1);
}
const sampleCode = regionCol.categories.indexOf(SAMPLE);
const keep = [];
for (let i = 0; i < regionCol.codes.length; i++) {
  if (Number(regionCol.codes[i]) === sampleCode) keep.push(i);
}
const N = keep.length;
console.log(`[table] ${N} of ${regionCol.codes.length} rows belong to ${SAMPLE}`);

// ── coordinates + affine ────────────────────────────────────────────────────

const spatial = await readArray(INPUT, `${TABLE}/obsm/spatial`);
const xs = new Float32Array(N);
const ys = new Float32Array(N);
for (let i = 0; i < N; i++) {
  xs[i] = Number(spatial.data[keep[i] * 2]);
  ys[i] = Number(spatial.data[keep[i] * 2 + 1]);
}

// The shapes element's transform into its own coordinate system IS the
// full-res -> served-image affine (the hires image maps in by identity).
const [scaleX, scaleY] = scaleFor(await readAttrs(INPUT, `shapes/${SAMPLE}`), SAMPLE);
console.log(`[coords] imageRef.scale = [${scaleX}, ${scaleY}]`);

/**
 * Spot radius, derived from the grid rather than read from the shapes parquet:
 * the median nearest-neighbour distance is the Visium 100 µm pitch, and a spot
 * is 55 µm across. That keeps this converter free of a Parquet reader for the
 * one number it would supply.
 */
function deriveRadius() {
  const sampleCount = Math.min(N, 400);
  const step = Math.max(1, Math.floor(N / sampleCount));
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
  const pitch = nn[Math.floor(nn.length / 2)] ?? 0;
  return pitch * VISIUM_RADIUS_OVER_PITCH;
}
const radius = deriveRadius();
const pitchFullRes = radius / VISIUM_RADIUS_OVER_PITCH;
// Visium's pitch is a known 100 um, so the grid doubles as a ruler: measuring it
// in the SERVED image's pixels gives that image's um/px, and the scale bar with
// it. Nothing else in the store states this.
const mpp = 100 / (pitchFullRes * scaleX);
console.log(`[coords] spot pitch -> radius ${radius.toFixed(1)} px (full-res frame), `
  + `image ${mpp.toFixed(3)} um/px`);

// ── columns ─────────────────────────────────────────────────────────────────

const MAX_CATEGORY_CARDINALITY = 64;
const columns = [];
const columnPayloads = [];

for (const col of obsColumns) {
  if (col === regionCol) continue; // constant after filtering — carries nothing
  if (col.kind === 'categorical') {
    const codes = new Uint16Array(N);
    for (let i = 0; i < N; i++) codes[i] = Number(col.codes[keep[i]]);
    columns.push({ kind: 'categorical', name: col.name, categories: col.categories.map(String) });
    columnPayloads.push(Buffer.from(codes.buffer));
    continue;
  }
  const values = new Float32Array(N);
  for (let i = 0; i < N; i++) values[i] = Number(col.values[keep[i]]);
  const finite = Array.from(values).filter(Number.isFinite);
  const distinct = new Set(finite);
  // Small-cardinality integer columns (in_tissue, array_row) read as categories,
  // not as a continuous ramp.
  if (distinct.size <= MAX_CATEGORY_CARDINALITY && finite.every((v) => Number.isInteger(v))) {
    const cats = [...distinct].sort((a, b) => a - b);
    const lookup = new Map(cats.map((v, i) => [v, i]));
    const codes = new Uint16Array(N);
    for (let i = 0; i < N; i++) codes[i] = lookup.get(values[i]) ?? 0xffff;
    columns.push({ kind: 'categorical', name: col.name, categories: cats.map(String) });
    columnPayloads.push(Buffer.from(codes.buffer));
  } else {
    columns.push({
      kind: 'continuous', name: col.name,
      logScaleHint: /counts|umi|total/i.test(col.name),
      min: Math.min(...finite), max: Math.max(...finite),
    });
    columnPayloads.push(Buffer.from(values.buffer));
  }
}
console.log(`[columns] ${columns.map((c) => c.name).join(', ')}`);

// ── expression: CSR (obs-major) -> gene-major for the selected genes ────────

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

// Rank genes by total expression over THIS sample's rows only.
const totals = new Float64Array(geneNames.length);
for (const row of keep) {
  const start = Number(indptr[row]);
  const end = Number(indptr[row + 1]);
  for (let k = start; k < end; k++) totals[indices[k]] += data[k];
}
const selected = Array.from(totals.keys())
  .sort((a, b) => totals[b] - totals[a])
  .slice(0, Math.min(GENE_LIMIT, geneNames.length))
  .sort((a, b) => a - b);
const geneSlot = new Map(selected.map((g, i) => [g, i]));
const selectedNames = selected.map((g) => String(geneNames[g]));

// One pass, writing straight into the gene-major buffer.
const matrix = new Float32Array(selected.length * N);
for (let i = 0; i < N; i++) {
  const row = keep[i];
  const start = Number(indptr[row]);
  const end = Number(indptr[row + 1]);
  for (let k = start; k < end; k++) {
    const slot = geneSlot.get(indices[k]);
    if (slot !== undefined) matrix[slot * N + i] = data[k];
  }
}
console.log(`[genes] ${selectedNames.length} of ${geneNames.length} genes, `
  + `${(matrix.byteLength / 1e6).toFixed(1)} MB gene-major`);

// Derived QC columns. A raw SpatialData table carries only array_row/array_col/
// in_tissue — nothing worth colouring by — so compute the two every downstream
// analysis starts from. They come free from the CSR pass and are labelled as
// derived in their descriptions.
{
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
    }
    totalCounts[i] = sum;
    nGenes[i] = detected;
  }
  const stats = (v) => {
    let min = Infinity, max = -Infinity;
    for (const x of v) { if (x < min) min = x; if (x > max) max = x; }
    return { min, max };
  };
  const tc = stats(totalCounts);
  const ng = stats(nGenes);
  columns.push({
    kind: 'continuous', name: 'total_counts', unit: 'counts', logScaleHint: true,
    description: 'UMI counts per spot (derived from X)', ...tc,
  });
  columnPayloads.push(Buffer.from(totalCounts.buffer));
  columns.push({
    kind: 'continuous', name: 'n_genes_by_counts', unit: 'genes', logScaleHint: false,
    description: 'Genes detected per spot (derived from X)', ...ng,
  });
  columnPayloads.push(Buffer.from(nGenes.buffer));
  console.log(`[qc] total_counts ${tc.min}-${tc.max}, n_genes ${ng.min}-${ng.max}`);
}

// ── tissue image -> pyramid ────────────────────────────────────────────────

const imageElement = `images/${SAMPLE}_hires_image`;
console.log(`[image] ${imageElement}`);
const img = await readArray(INPUT, `${imageElement}/0`);
const [bands, height, width] = img.shape;
// cyx planar -> RGB interleaved, which is what sharp's raw input expects.
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
  { width, height, mppX: mpp, mppY: mpp, onLevel: (res, w, h) => console.log(`  L${res}  ${w}x${h}`) },
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

for (let i = 0; i < columnPayloads.length; i++) {
  await writeFile(path.join(outDir, 'columns', `${i}.bin`), columnPayloads[i]);
}
await writeFile(path.join(outDir, 'features', 'names.json'), JSON.stringify(selectedNames));
await writeFile(path.join(outDir, 'features', 'matrix.f32'), Buffer.from(matrix.buffer));

const manifest = {
  version: 1,
  id: ID,
  name: `Visium ${SAMPLE} (${path.basename(INPUT)})`,
  count: N,
  hasIds: true,
  radius: { mode: 'uniform', value: radius },
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
    mppX: mpp,
    mppY: mpp,
  },
};
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\n[done] ${outDir}`);
console.log(`       image ${path.join(COG_ROOT, IMAGE_ID)} - ${width}x${height}, `
  + `${pyramid.realLevels} levels, ${mpp.toFixed(3)} um/px`);
console.log(`       gallery: { imageId: '${IMAGE_ID}', width: ${width}, height: ${height}, `
  + `mppX: ${mpp.toFixed(4)}, mppY: ${mpp.toFixed(4)}, spatialDatasetId: '${ID}' }`);
console.log(`       serve: npm start   (SPATIAL_DIR=${OUT_ROOT} COG_DIR=${COG_ROOT})`);
