// Compute PCA / t-SNE / UMAP for a bundle that has none, and add them to it.
//
//   node scripts/compute-embeddings.mjs --bundle spatial/visium-hne
//   node scripts/compute-embeddings.mjs --bundle spatial/seqfish --only tsne
//
// Every embedding PUBLISHED with a spatial dataset is 2-D, because a UMAP is made to be
// looked at, so anything else has to be computed. This is where.
//
// It reads the BUNDLE, not the `.h5ad`. The Python it replaces wrote back into the HDF5
// and made the converter run again; a bundle's `features/matrix.f32` is a flat gene-major
// f32 file, so there is nothing to parse and no HDF5 writer to depend on. It also means
// this works on any bundle, including ones that never came from an `.h5ad`.
//
// Existing embeddings are PRESERVED. A published `X_umap` is the authors' own picture and
// nothing here may overwrite it — recomputed coordinates go under their own keys, and are
// marked `derived: true` so a reader comparing against a paper's figure knows which they
// are looking at. Re-running replaces only the keys this script writes.
//
// ONLY PCA REPORTS VARIANCE, and that asymmetry is deliberate. PCA's axes are ordered and
// each explains a measurable share, so "PCA 1 (7.3%)" says something. UMAP and t-SNE
// coordinates are arbitrary outputs of an optimisation — unordered, unitless, reproducible
// only up to a rotation — so they get no ratio and their axes stay bare. A percentage
// there would be invented.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pcaScores } from '../lib/pca.mjs';

/**
 * t-SNE is OPT-IN, not part of the default set, and this is why.
 *
 * `tsne-js` implements the exact formulation only — its own README puts Barnes-Hut under
 * "planned (contributions welcome!)" — so the gradient is O(dN^2) per iteration against
 * scikit-learn's O(dN log N) default. Measured here at 50 iterations, 50 input dimensions:
 *
 *     n =   500    3.9 s for 50 iterations
 *     n = 1,000   16.8 s
 *     n = 2,000   65.2 s      — four times the cost for twice the points, as quadratic predicts
 *
 * And the per-iteration cost is not the whole of it: the joint-probability matrix is built
 * once up front, also O(N^2), so at n=2,688 even `--iterations 1` costs two minutes before
 * the first gradient step. A full run on the Visium bundle is over half an hour, and
 * seqFISH's 19,416 observations are out of reach entirely. scikit-learn, using Barnes-Hut,
 * did seqFISH in 31 seconds.
 *
 * So `--only` excludes t-SNE by default: asking a bundle for embeddings should not start a
 * job indistinguishable from a hang. `--only tsne` opts in, and past
 * {@link TSNE_WARN_OBSERVATIONS} it says what it is about to cost. UMAP has no such
 * problem — `umap-js` builds an approximate neighbour graph and took 2.8 s on the same
 * data.
 */
const TSNE_WARN_OBSERVATIONS = 1500;

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const die = (msg) => { console.error(msg); process.exit(2); };

const bundle = flag('bundle') ?? die('--bundle is required');
const pcs = Number(flag('pcs', 50));
const perplexity = Number(flag('perplexity', 30));
const neighbors = Number(flag('neighbors', 15));
const minDist = Number(flag('min-dist', 0.3));
const seed = Number(flag('seed', 0));
const iterations = Number(flag('iterations', 1000));
// t-SNE is deliberately absent from the default: see TSNE_WARN_OBSERVATIONS.
const only = new Set((flag('only', 'pca,umap3d')).split(',').map((s) => s.trim()));

const manifestPath = path.join(bundle, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const nObs = manifest.count;
const nGenes = manifest.features?.count ?? 0;
if (!nGenes) die(`${bundle}: manifest declares no features to reduce`);

const raw = await readFile(path.join(bundle, 'features', 'matrix.f32'));
const matrix = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
if (matrix.length !== nObs * nGenes) {
  die(`matrix is ${matrix.length} floats, expected ${nObs} x ${nGenes}`);
}

console.log(`${bundle}: ${nObs} observations x ${nGenes} genes`);

/** Reproducible uniform stream, handed to umap-js so a rerun draws the same picture. */
function rng(s) {
  let a = (s + 1) >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// PCA first, and once. It is both an embedding in its own right and the input every other
// method wants: UMAP or t-SNE straight off 18,078 genes follows noise, so the standard
// workflow reduces first. Computing it twice would be the same arithmetic done slower.
const wantPca = only.has('pca');
const needsReduction = only.has('tsne') || only.has('umap3d') || only.has('umap');
const k = Math.max(needsReduction ? pcs : 0, wantPca ? 3 : 0);
if (k === 0) die(`--only ${[...only].join(',')}: nothing to compute`);

const t0 = Date.now();
const { scores, varianceRatio, components } = await pcaScores(matrix, nObs, nGenes, k, { seed });
console.log(`  PCA(${components}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  + `  — PC1 ${(varianceRatio[0] * 100).toFixed(1)}%, PC2 ${(varianceRatio[1] * 100).toFixed(1)}%`);

/** The first `dims` principal components as an array of points, for the neighbour methods. */
const asPoints = (dims) => Array.from({ length: nObs }, (_, i) => {
  const row = new Array(dims);
  for (let d = 0; d < dims; d++) row[d] = scores[i * components + d];
  return row;
});

/** New embeddings, keyed by obsm-style name. */
const computed = new Map();
const addFromScores = (name, label, dims) => {
  const flat = new Float32Array(nObs * dims);
  for (let d = 0; d < dims; d++) {
    for (let i = 0; i < nObs; i++) flat[d * nObs + i] = scores[i * components + d];
  }
  computed.set(name, {
    meta: {
      name,
      label,
      dims,
      derived: true,
      varianceRatio: varianceRatio.slice(0, dims),
      params: 'centred expression, randomized SVD',
    },
    flat,
  });
};
const addFromPoints = (name, label, dims, points, params) => {
  const flat = new Float32Array(nObs * dims);
  for (let i = 0; i < nObs; i++) {
    for (let d = 0; d < dims; d++) flat[d * nObs + i] = points[i][d];
  }
  // No varianceRatio: see the header.
  computed.set(name, { meta: { name, label, dims, derived: true, params }, flat });
};

if (wantPca) {
  addFromScores('X_pca2d', 'PCA', 2);
  addFromScores('X_pca3d', 'PCA 3D', 3);
}

if (only.has('tsne') && nObs > TSNE_WARN_OBSERVATIONS) {
  // Say what it will cost BEFORE spending it. The run is single-threaded and prints
  // nothing until it finishes, so without this it is indistinguishable from a hang.
  console.log(`  t-SNE: ${nObs.toLocaleString()} observations. tsne-js is the exact`);
  console.log('    O(dN^2) formulation, not Barnes-Hut — both the setup and every iteration');
  console.log('    scale quadratically. Measured: 2,688 observations cost ~2 min before the');
  console.log(`    first step and ~40 min for a full 1,000. This is 2D + 3D at ${iterations}.`);
  console.log('    Ctrl-C and use --iterations, or compute it elsewhere as an obsm key.');
}
if (only.has('tsne')) {
  const { default: TSNE } = await import('tsne-js');
  const reduced = asPoints(Math.min(pcs, components));
  for (const dims of [2, 3]) {
    const t = Date.now();
    const model = new TSNE({
      dim: dims, perplexity, earlyExaggeration: 4, learningRate: 100,
      nIter: iterations, metric: 'euclidean',
    });
    model.init({ data: reduced, type: 'dense' });
    model.run();
    addFromPoints(`X_tsne${dims === 3 ? '3d' : ''}`, `t-SNE${dims === 3 ? ' 3D' : ''}`, dims,
      model.getOutputScaled(),
      `PCA(${Math.min(pcs, components)}) then t-SNE, perplexity ${perplexity}`);
    console.log(`  t-SNE ${dims}D in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
}

if (only.has('umap3d') || only.has('umap')) {
  const { UMAP } = await import('umap-js');
  const reduced = asPoints(Math.min(pcs, components));
  for (const dims of [only.has('umap') ? 2 : null, only.has('umap3d') ? 3 : null].filter(Boolean)) {
    const t = Date.now();
    const umap = new UMAP({
      nComponents: dims, nNeighbors: neighbors, minDist, random: rng(seed),
    });
    addFromPoints(`X_umap${dims === 3 ? '3d' : ''}`, `UMAP${dims === 3 ? ' 3D' : ''}`, dims,
      umap.fit(reduced),
      `PCA(${Math.min(pcs, components)}) then UMAP, n_neighbors ${neighbors}, min_dist ${minDist}, seed ${seed}`);
    console.log(`  UMAP ${dims}D in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
}

// ── merge into the bundle ────────────────────────────────────────────────────
// Files are addressed by INDEX in the manifest, so a changed list means rewriting every
// file in the new order. Existing buffers are read BEFORE anything is written, or a
// re-index would read files it had already overwritten.
const existing = manifest.embeddings ?? [];
const kept = [];
for (let i = 0; i < existing.length; i++) {
  if (computed.has(existing[i].name)) continue; // replaced below, at its original position
  kept.push({
    meta: existing[i],
    flat: await readFile(path.join(bundle, 'embeddings', `${i}.bin`)),
  });
}
// Replacements keep their original slot so a published embedding stays first in the menu.
const order = [];
for (const meta of existing) {
  if (computed.has(meta.name)) order.push(computed.get(meta.name));
  else order.push(kept.shift());
}
for (const [name, entry] of computed) {
  if (!existing.some((e) => e.name === name)) order.push(entry);
}

await mkdir(path.join(bundle, 'embeddings'), { recursive: true });
for (let i = 0; i < order.length; i++) {
  const { flat } = order[i];
  const buf = Buffer.isBuffer(flat)
    ? flat
    : Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  await writeFile(path.join(bundle, 'embeddings', `${i}.bin`), buf);
}
manifest.embeddings = order.map((e) => e.meta);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`  wrote ${order.length} embeddings:`);
for (const e of order) {
  const v = e.meta.varianceRatio;
  console.log(`    ${(e.meta.label ?? e.meta.name).padEnd(9)} ${e.meta.dims}D  `
    + `${e.meta.derived ? 'derived  ' : 'published'} `
    + `${v ? v.map((x) => `${(x * 100).toFixed(1)}%`).join(', ') : '—'}`);
}
