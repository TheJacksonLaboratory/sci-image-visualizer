// Write a bundle dataset directory from an AnnData `.h5ad`.
//
// Shared by `scripts/h5ad-to-spatial.mjs` (the CLI) and `lib/spatial-h5ad.mjs` (which
// converts a CSR file on first open). One implementation, so a dataset served through the
// drop-in path and the same dataset converted by hand cannot disagree.
//
// Layout written (see lib/spatial.mjs for the reader):
//
//   manifest.json            served verbatim
//   ids.json                 observation labels, in row order
//   coords.bin               f32[N] x, f32[N] y, f32[N] z?   — struct of arrays
//   columns/<index>.bin      u16[N] codes (categorical) | f32[N] values (continuous)
//   features/matrix.f32      f32[N] per gene, gene-major; ranged-read one gene at a time
//   features/names.json      gene names, index-aligned with the matrix
//   embeddings/<index>.bin   f32[N] dim0, f32[N] dim1, f32[N] dim2?  — same as coords
//
// Files are addressed by their INDEX in the manifest, never by name, so no request string
// ever reaches the filesystem. Anything added here has to keep that property.

import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  asCsc, categoriesFor, codesFor, continuousFor, denseColumn, geneNames, indexKey,
  obsCount, obsmArray, openH5ad, shapeOf, unsValue,
} from './h5ad.mjs';

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

/** Half the mean point spacing — the default marker radius when none is given. */
export function defaultRadius(flat, rows, dims) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let i = 0; i < rows; i++) {
    const x = Number(flat[i * dims]);
    const y = Number(flat[i * dims + 1]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.sqrt(((maxX - minX) * (maxY - minY)) / rows) / 2;
}

/**
 * Convert `h5ad` into a bundle at `out`.
 *
 * `columns` and `embeddings` are given rather than discovered, because the CLI takes them
 * from flags and the drop-in adapter infers them — and both want the same writer.
 */
export async function writeBundle({
  h5ad, out, id, name,
  spatialKey = 'spatial',
  columns: columnSpecs = [],
  embeddings: embeddingSpecs = [],
  derived = new Set(),
  radius = null,
  featuresUnit = null,
  imageRef = null,
  micronsPerUnit = null,
  file = null,
}) {
  const f = file ?? await openH5ad(h5ad);
  try {
    const n = obsCount(f);
    const [, nVar] = shapeOf(f);
    const coords = obsmArray(f, spatialKey);
    if (coords.rows !== n) {
      throw new Error(`${spatialKey}: ${coords.rows} rows for ${n} observations`);
    }
    if (coords.dims !== 2 && coords.dims !== 3) {
      throw new Error(`${spatialKey}: expected 2 or 3 columns, got ${coords.dims}`);
    }

    await mkdir(path.join(out, 'columns'), { recursive: true });
    await mkdir(path.join(out, 'features'), { recursive: true });
    await writeSoa(path.join(out, 'coords.bin'), coords.flat, n, coords.dims);

    // `obs/_index` is the observation labels, and every `.h5ad` has them — so a bundle
    // written from one can always answer `/ids`. Omitting them made a converted dataset
    // 404 there while the direct-read path served them, for no reason a caller could see.
    const obs = f.get('obs');
    const ids = Array.from(f.get(`obs/${indexKey(obs)}`).value, String);
    await writeFile(path.join(out, 'ids.json'), JSON.stringify({ ids }));

    // ── obs columns ─────────────────────────────────────────────────────────
    const columns = [];
    for (const { name: colName, kind } of columnSpecs) {
      const index = columns.length;
      const target = path.join(out, 'columns', `${index}.bin`);
      if (kind === 'categorical') {
        const categories = categoriesFor(f, colName);
        if (!categories) throw new Error(`column ${colName}: no categories found`);
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

    // ── expression ──────────────────────────────────────────────────────────
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

    // ── embeddings ──────────────────────────────────────────────────────────
    const embeddings = [];
    if (embeddingSpecs.length) await mkdir(path.join(out, 'embeddings'), { recursive: true });
    for (const { key, label } of embeddingSpecs) {
      const emb = obsmArray(f, key);
      if (emb.rows !== n) throw new Error(`${key}: ${emb.rows} rows for ${n} observations`);
      if (emb.dims !== 2 && emb.dims !== 3) {
        throw new Error(`${key}: expected 2 or 3 columns, got ${emb.dims}`);
      }
      const index = embeddings.length;
      await writeSoa(path.join(out, 'embeddings', `${index}.bin`), emb.flat, n, emb.dims);
      const meta = { name: key, dims: emb.dims };
      if (label) meta.label = label;
      if (derived.has(key)) meta.derived = true;
      // Variance per axis, for a LINEAR embedding. Absent for a UMAP, whose axes are an
      // arbitrary output of an optimisation with no variance to report.
      const ratios = unsValue(f, `${key}_variance_ratio`);
      if (ratios) meta.varianceRatio = Array.from(ratios, Number).slice(0, emb.dims);
      // How it was computed. A stochastic embedding's picture changes with its
      // parameters, so "computed here" without them cannot be reproduced or compared.
      const params = unsValue(f, `${key}_params`);
      if (params !== undefined) meta.params = String(params);
      embeddings.push(meta);
    }

    // ── manifest ────────────────────────────────────────────────────────────
    const manifest = {
      version: 1,
      id,
      name,
      count: n,
      hasIds: true,
      radius: {
        mode: 'uniform',
        value: radius ?? defaultRadius(coords.flat, n, coords.dims),
      },
      columns,
      features: { count: genes.length, names: genes },
    };
    if (featuresUnit) manifest.features.unit = featuresUnit;
    if (coords.dims === 3) manifest.hasZ = true;
    if (embeddings.length) manifest.embeddings = embeddings;
    if (imageRef) manifest.imageRef = imageRef;
    // Absent unless given: coordinates that are NOT physical would get a scale bar that
    // means nothing, which is worse than no bar — it looks like a measurement.
    if (micronsPerUnit !== null) manifest.micronsPerUnit = micronsPerUnit;

    await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    if (!file) f.close();
  }
}
