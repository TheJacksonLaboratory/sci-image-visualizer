// Cross-check `lib/pca.mjs` against an EXACT reference.
//
//   npm run verify-pca
//
// `lib/pca.mjs` uses randomized subspace iteration, which is an approximation — the only
// tractable route for a matrix with 18,078 columns, where an exact SVD would compute 2,688
// singular triples to use three. An approximation needs something exact to answer to.
//
// The reference is jax-js's own `linalg.svd` of the whole centred matrix. That is exact, so
// on a small fixture it says precisely what the leading components are, and the
// approximation has to land on them. Checked against a third implementation while this was
// written: jax-js's exact SVD and `pca-js` (bitanath/pca, covariance + eigendecomposition)
// agree to four decimal places, 16.0963% / 15.0340% / 10.2403%, so nothing is lost by
// using the library already here rather than carrying a second PCA.
//
// The reference does its OWN centring, deliberately. Sharing `centreByGene` with the code
// under test would put it beyond the reach of this check, and a mean subtracted along the
// wrong axis is exactly the kind of error that still produces a plausible-looking result.
//
// Two independent anchors, because agreeing with itself is not evidence:
//
//   1. the fixture, against the exact SVD — always runs, catches the approximation's own
//      failure modes (component order, power iterations, orthonormalisation);
//   2. the real bundles, against the variance ratios NUMPY reported for them — runs when
//      the bundles are present, and is the only check that reaches outside this codebase.

import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import * as jax from '@jax-js/jax';

import { pcaScores } from '../lib/pca.mjs';

const np = jax.numpy;

/** What numpy's exact SVD reported for the shipped bundles, to four significant figures. */
const NUMPY_RATIOS = {
  seqfish: { nObs: 19416, nGenes: 351, ratios: [0.182, 0.071, 0.050] },
  'visium-hne': { nObs: 2688, nGenes: 18078, ratios: [0.073, 0.029, 0.021] },
};

/**
 * Deterministic matrix with a SLOWLY DECAYING spectrum.
 *
 * The regime that matters. A fixture with a few well-separated signals is recovered even by
 * a single random projection, so it cannot tell whether the power iterations do anything —
 * verified: removing them left the answer inside half a percentage point. Real
 * whole-transcriptome data is the opposite case, PC1 at 7% and PC2 at 3%, where the leading
 * components sit close enough together that one projection mixes them.
 */
function fixture(nObs, nGenes, nSignals) {
  let s = 42;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const flat = new Float32Array(nObs * nGenes);
  const loads = Array.from({ length: nSignals }, () => (
    Array.from({ length: nGenes }, () => rnd() - 0.5)
  ));
  for (let i = 0; i < nObs; i++) {
    // Amplitudes decay gently — 1, 1/1.15, 1/1.3, … — so no component stands clear of its
    // neighbour and the subspace has to be refined rather than guessed.
    const amps = Array.from({ length: nSignals }, (_, k) => (rnd() - 0.5) / (1 + 0.15 * k));
    for (let j = 0; j < nGenes; j++) {
      let v = (rnd() - 0.5) * 0.2;
      for (let k = 0; k < nSignals; k++) v += amps[k] * loads[k][j];
      flat[j * nObs + i] = v;
    }
  }
  return flat;
}

/**
 * Exact variance ratios of a gene-major matrix, by full SVD.
 *
 * Centres the matrix here rather than calling `centreByGene`, so that function is under
 * test too. Only for small inputs: this is the O(n²m) work the implementation exists to
 * avoid.
 */
async function exactRatios(flat, nObs, nGenes, take) {
  const xt = np.array(flat, 'float32').reshape([nGenes, nObs]);
  // Mean per gene — axis 1, because rows are genes in this layout.
  const means = np.mean(xt.ref, 1, { keepdims: true });
  const centred = np.subtract(xt, means);
  const total = np.sum(np.square(centred.ref));
  const totalVariance = Number(await total.item()) / (nObs - 1);
  const [, sv] = np.linalg.svd(centred.transpose(), { fullMatrices: false });
  const singular = Array.from(await sv.data());
  return singular.slice(0, take).map((s) => (s * s) / (nObs - 1) / totalVariance);
}

const fmt = (a) => a.map((v) => `${(v * 100).toFixed(4)}%`).join(', ');
let failed = 0;

function compare(label, expected, actual, tolerance) {
  console.log(`  ${label.padEnd(22)} ${fmt(actual)}`);
  for (let i = 0; i < expected.length; i++) {
    const delta = Math.abs(expected[i] - actual[i]);
    if (delta > tolerance) {
      console.error(`    FAIL PC${i + 1}: ${(delta * 100).toFixed(4)} points from the reference`);
      failed++;
    }
  }
  // The ORDER matters as much as the values: PCA's axes are ordered by construction, and
  // that ordering is what makes "PCA 1 (18.2%)" mean anything. `eigh` returns eigenvalues
  // ascending while `svd` returns them descending, so this is a live trap, not a hypothesis.
  for (let i = 1; i < actual.length; i++) {
    if (actual[i] > actual[i - 1] + 1e-9) {
      console.error(`    FAIL: PC${i + 1} explains more than PC${i}`);
      failed++;
    }
  }
}

await jax.init('wasm');

// ── 1. the fixture, against an exact SVD ─────────────────────────────────────
const nObs = 400;
const nGenes = 60;
const SIGNALS = 40;
const flat = fixture(nObs, nGenes, SIGNALS);

console.log(`fixture ${nObs} x ${nGenes}, ${SIGNALS} weak signals, gently decaying`);
const exact = await exactRatios(flat, nObs, nGenes, 3);
console.log(`  ${'exact SVD'.padEnd(22)} ${fmt(exact)}`);
const mine = await pcaScores(flat, nObs, nGenes, 3, { seed: 0 });
// Tight, because the two agree to several decimals when the method is intact. A loose
// tolerance is not "safe": at 0.5 points it let a mutation removing the power iterations
// pass, which is precisely the regression this exists to catch.
compare('randomized', exact, mine.varianceRatio, 0.0005);

// ── 2. the real bundles, against numpy ───────────────────────────────────────
// The only anchor outside this codebase. Skipped rather than failed when a bundle is
// absent: they are generated data and gitignored, so a fresh clone has none.
for (const [id, { nObs: n, nGenes: g, ratios }] of Object.entries(NUMPY_RATIOS)) {
  const file = path.join('spatial', id, 'features', 'matrix.f32');
  if (!(await stat(file).catch(() => null))) {
    console.log(`\n${id}: skipped — no bundle (npm run h5ad-to-spatial first)`);
    continue;
  }
  const buf = await readFile(file);
  const matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (matrix.length !== n * g) {
    console.log(`\n${id}: skipped — ${matrix.length} floats, expected ${n} x ${g}`);
    continue;
  }
  console.log(`\n${id} ${n} x ${g}`);
  console.log(`  ${'numpy exact SVD'.padEnd(22)} ${fmt(ratios)}`);
  const got = await pcaScores(matrix, n, g, 3, { seed: 0 });
  // Numpy's figures are recorded to three decimals, so the tolerance is that rounding
  // plus a little: this is a check that the answer is still the same picture, not a
  // bit-comparison against a number written down by hand.
  compare('randomized', ratios, got.varianceRatio, 0.001);
}

console.log(failed === 0 ? '\nverify-pca: PASS' : `\nverify-pca: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
