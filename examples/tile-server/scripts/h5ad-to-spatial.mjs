// Convert an AnnData `.h5ad` into a bundle dataset directory this server can serve.
//
//   npm install            # h5wasm comes with it
//   node scripts/h5ad-to-spatial.mjs --h5ad seqfish.h5ad --out spatial/seqfish \
//       --id seqfish --name "Mouse embryo seqFISH (Lohoff et al)" \
//       --spatial-key spatial --embedding X_umap:UMAP \
//       --column celltype_mapped_refined:categorical --column Area:continuous
//
// `X` may be CSC or CSR — scanpy writes CSR by default, so a CSC-only reader would
// reject most `.h5ad` files in existence.
//
// Layout written (see lib/spatial.mjs for the reader):
//
//   manifest.json            served verbatim
//   coords.bin               f32[N] x, f32[N] y, f32[N] z?   — struct of arrays
//   columns/<index>.bin      u16[N] codes (categorical) | f32[N] values (continuous)
//   features/matrix.f32      f32[N] per gene, gene-major; ranged-read one gene at a time
//   features/names.json      gene names, index-aligned with the matrix
//   embeddings/<index>.bin   f32[N] dim0, f32[N] dim1, f32[N] dim2?  — same as coords
//
// Files are addressed by their INDEX in the manifest, never by name: `readColumn` and
// friends look the name up in the manifest and open `<index>.bin`, so no request string
// ever reaches the filesystem. Anything added here has to keep that property.

import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  asCsc, categoriesFor, codesFor, continuousFor, denseColumn, geneNames,
  obsCount, obsmArray, openH5ad, shapeOf, unsValue,
} from '../lib/h5ad.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const many = (name) => args.reduce(
  (out, a, i) => (a === `--${name}` && args[i + 1] ? [...out, args[i + 1]] : out), [],
);
const die = (msg) => { console.error(msg); process.exit(2); };

/** `--flag a,b` as two numbers. Comma-separated so a negative value is not read as a flag. */
function pair(text, name) {
  const parts = String(text).split(',');
  if (parts.length !== 2 || parts.some((v) => Number.isNaN(Number(v)))) {
    die(`--${name}: expected two comma-separated numbers, got "${text}"`);
  }
  return parts.map(Number);
}

const h5ad = flag('h5ad') ?? die('--h5ad is required');
const out = flag('out') ?? die('--out is required');
const id = flag('id') ?? die('--id is required');
const name = flag('name') ?? die('--name is required');
const spatialKey = flag('spatial-key', 'spatial');
const radiusArg = flag('radius');
const featuresUnit = flag('features-unit');
const imageId = flag('image-id');
const imageScale = flag('image-scale');
const imageTranslate = flag('image-translate');
const imageMpp = flag('image-mpp');
const micronsPerUnit = flag('microns-per-unit');
const derived = new Set(many('derived'));

/** Write an (N, D) row-major array as D contiguous f32 planes — the coords layout. */
async function writeSoa(file, flat, rows, dims) {
  const buf = Buffer.allocUnsafe(rows * dims * 4);
  for (let d = 0; d < dims; d++) {
    for (let i = 0; i < rows; i++) {
      buf.writeFloatLE(Number(flat[i * dims + d]), (d * rows + i) * 4);
    }
  }
  await writeFile(file, buf);
}

const f = await openH5ad(h5ad);
try {
  const n = obsCount(f);
  const [, nVar] = shapeOf(f);
  const coords = obsmArray(f, spatialKey);
  if (coords.rows !== n) die(`${spatialKey}: ${coords.rows} rows for ${n} observations`);
  if (coords.dims !== 2 && coords.dims !== 3) {
    die(`${spatialKey}: expected 2 or 3 columns, got ${coords.dims}`);
  }

  await mkdir(path.join(out, 'columns'), { recursive: true });
  await mkdir(path.join(out, 'features'), { recursive: true });
  await writeSoa(path.join(out, 'coords.bin'), coords.flat, n, coords.dims);

  // ── obs columns ───────────────────────────────────────────────────────────
  const columns = [];
  for (const spec of many('column')) {
    const [colName, kind = 'continuous'] = spec.split(':');
    const index = columns.length;
    const target = path.join(out, 'columns', `${index}.bin`);
    if (kind === 'categorical') {
      const categories = categoriesFor(f, colName);
      if (!categories) die(`column ${colName}: no categories found; is it categorical?`);
      const codes = codesFor(f, colName);
      await writeFile(target, Buffer.from(codes.buffer, codes.byteOffset, codes.byteLength));
      const meta = { kind: 'categorical', name: colName, categories };
      const colors = unsValue(f, `${colName}_colors`);
      // Published colours, so the app matches the paper's figures.
      if (colors) meta.colors = Array.from(colors, String).slice(0, categories.length);
      columns.push(meta);
    } else {
      const values = continuousFor(f, colName);
      await writeFile(target, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
      columns.push({ kind: 'continuous', name: colName });
    }
  }

  // ── expression ────────────────────────────────────────────────────────────
  const genes = geneNames(f);
  const csc = asCsc(f, n, nVar);
  const fh = await open(path.join(out, 'features', 'matrix.f32'), 'w');
  try {
    // Streamed a gene at a time: the whole matrix is 186 MB for Visium and there is no
    // reason to hold a second copy of it in a Buffer.
    for (let j = 0; j < genes.length; j++) {
      const col = denseColumn(csc, n, j);
      await fh.write(Buffer.from(col.buffer, col.byteOffset, col.byteLength));
    }
  } finally {
    await fh.close();
  }
  await writeFile(path.join(out, 'features', 'names.json'), JSON.stringify(genes));

  // ── embeddings ────────────────────────────────────────────────────────────
  const embeddings = [];
  const embeddingSpecs = many('embedding');
  if (embeddingSpecs.length) await mkdir(path.join(out, 'embeddings'), { recursive: true });
  for (const spec of embeddingSpecs) {
    const [key, label] = spec.split(':');
    const emb = obsmArray(f, key);
    if (emb.rows !== n) die(`${key}: ${emb.rows} rows for ${n} observations`);
    if (emb.dims !== 2 && emb.dims !== 3) {
      die(`${key}: expected 2 or 3 columns, got ${emb.dims}`);
    }
    const index = embeddings.length;
    await writeSoa(path.join(out, 'embeddings', `${index}.bin`), emb.flat, n, emb.dims);
    const meta = { name: key, dims: emb.dims };
    if (label) meta.label = label;
    if (derived.has(key)) meta.derived = true;
    // Variance per axis, for a LINEAR embedding. Absent for a UMAP, which has no variance
    // to report because its axes are an arbitrary output of an optimisation.
    const ratios = unsValue(f, `${key}_variance_ratio`);
    if (ratios) meta.varianceRatio = Array.from(ratios, Number).slice(0, emb.dims);
    // How it was computed. A stochastic embedding's picture changes with its parameters,
    // so "computed here" without them leaves a reader unable to reproduce or compare it.
    const params = unsValue(f, `${key}_params`);
    if (params !== undefined) meta.params = String(params);
    embeddings.push(meta);
  }

  // ── manifest ──────────────────────────────────────────────────────────────
  let radius;
  if (radiusArg !== null) {
    radius = Number(radiusArg);
  } else {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = Number(coords.flat[i * coords.dims]);
      const y = Number(coords.flat[i * coords.dims + 1]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    radius = Math.sqrt(((maxX - minX) * (maxY - minY)) / n) / 2;
  }

  const manifest = {
    version: 1,
    id,
    name,
    count: n,
    radius: { mode: 'uniform', value: radius },
    columns,
    features: { count: genes.length, names: genes },
  };
  if (featuresUnit) manifest.features.unit = featuresUnit;
  if (coords.dims === 3) manifest.hasZ = true;
  if (embeddings.length) manifest.embeddings = embeddings;
  if (imageId || imageScale) {
    const ref = {};
    if (imageId) ref.imageId = imageId;
    if (imageScale) ref.scale = pair(imageScale, 'image-scale');
    if (imageTranslate) ref.translate = pair(imageTranslate, 'image-translate');
    if (imageMpp) [ref.mppX, ref.mppY] = pair(imageMpp, 'image-mpp');
    manifest.imageRef = ref;
  }
  // Absent unless given: coordinates that are NOT physical would get a scale bar that
  // means nothing, which is worse than no bar — it looks like a measurement.
  if (micronsPerUnit !== null) manifest.micronsPerUnit = Number(micronsPerUnit);

  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${out}: ${n} observations, ${genes.length} genes, `
    + `${columns.length} columns, ${embeddings.length} embeddings, radius ${radius.toFixed(4)}`);
} finally {
  f.close();
}
