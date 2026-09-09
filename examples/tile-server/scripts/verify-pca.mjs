// Cross-check `lib/pca.mjs` against an independent PCA implementation.
//
//   npm run verify-pca
//
// `lib/pca.mjs` uses randomized subspace iteration, which is an APPROXIMATION — the only
// tractable one in JS for a matrix with 18,078 columns, where an exact SVD would compute
// 2,688 singular triples to use three. An approximation needs an oracle, and
// `pca-js` (bitanath/pca) is a good one: it takes the exact route, eigendecomposing the
// genes x genes covariance matrix, so it agrees or one of them is wrong.
//
// It is a devDependency and deliberately not the engine. Measured on the seqFISH bundle
// (19,416 x 351): pca-js 171.1 s, lib/pca.mjs 0.8 s, both reporting 18.2%, 7.1%, 5.0% —
// the same as numpy's exact SVD. And its cost is CUBIC in the gene count (measured at
// 2,000 observations: 2.2 s for 175 genes, 12.0 s for 351, 80.5 s for 700), which puts a
// whole-transcriptome dataset out of reach entirely — extrapolated, 18,078 genes is
// thousands of hours against 23 s. So it verifies at small scale and computes nothing.

import PCA from 'pca-js';

import { pcaScores } from '../lib/pca.mjs';

/**
 * Deterministic matrix with a SLOWLY DECAYING spectrum.
 *
 * The regime that matters. A fixture with a few well-separated signals is recovered even
 * by a single random projection, so it cannot tell whether the power iterations are doing
 * anything — verified: removing them left the answer inside half a percentage point. Real
 * whole-transcriptome data is the opposite case, with PC1 at 7% and PC2 at 3%, where the
 * leading components are close enough together that one projection mixes them. Many weak
 * signals with a gentle decay reproduces that, and then the iterations are load-bearing.
 */
function fixture(nObs, nGenes, nSignals) {
  let s = 42;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  // Gene-major, as a bundle stores it.
  const flat = new Float32Array(nObs * nGenes);
  const loads = Array.from({ length: nSignals }, () => Array.from({ length: nGenes }, () => rnd() - 0.5));
  for (let i = 0; i < nObs; i++) {
    // Each observation is a mix of a few latent signals plus noise, with the signals
    // deliberately unequal so the components have a definite order to get right.
    // Amplitudes decay gently — 1, 1/1.15, 1/1.3, ... — so no component stands clear of
    // its neighbour and the subspace has to be refined rather than guessed.
    const amps = Array.from({ length: nSignals }, (_, k) => (rnd() - 0.5) / (1 + 0.15 * k));
    for (let j = 0; j < nGenes; j++) {
      let v = (rnd() - 0.5) * 0.2;
      for (let k = 0; k < nSignals; k++) v += amps[k] * loads[k][j];
      flat[j * nObs + i] = v;
    }
  }
  return flat;
}

const nObs = 400;
const nGenes = 60;
const SIGNALS = 40;
const flat = fixture(nObs, nGenes, SIGNALS);

// pca-js wants rows of observations.
const rows = Array.from({ length: nObs }, (_, i) => (
  Array.from({ length: nGenes }, (_, j) => flat[j * nObs + i])
));

let t = Date.now();
const vectors = PCA.getEigenVectors(rows);
const oracleMs = Date.now() - t;
const total = vectors.reduce((sum, v) => sum + v.eigenvalue, 0);
const oracle = vectors.slice(0, 3).map((v) => v.eigenvalue / total);

t = Date.now();
const mine = await pcaScores(flat, nObs, nGenes, 3, { seed: 0 });
const mineMs = Date.now() - t;

console.log(`fixture ${nObs} x ${nGenes}, ${SIGNALS} weak signals, gently decaying`);
console.log(`  pca-js        ${String(oracleMs).padStart(6)} ms  ${oracle.map((v) => `${(v * 100).toFixed(2)}%`).join(', ')}`);
console.log(`  lib/pca.mjs   ${String(mineMs).padStart(6)} ms  ${mine.varianceRatio.map((v) => `${(v * 100).toFixed(2)}%`).join(', ')}`);

// Tight, because on this fixture the two implementations agree to several decimals when
// the method is intact. A loose tolerance is not "safe": it let a mutation that removed
// the power iterations pass, which is precisely the regression this exists to catch.
const TOLERANCE = 0.0005;
let failed = 0;
for (let i = 0; i < 3; i++) {
  const delta = Math.abs(oracle[i] - mine.varianceRatio[i]);
  if (delta > TOLERANCE) {
    console.error(`  FAIL PC${i + 1}: ${(delta * 100).toFixed(3)} points apart`);
    failed++;
  }
}
// The ORDER matters as much as the values: PCA's axes are ordered by construction, and
// that ordering is what makes "PCA 1 (18.2%)" mean anything.
for (let i = 1; i < 3; i++) {
  if (mine.varianceRatio[i] > mine.varianceRatio[i - 1] + 1e-9) {
    console.error(`  FAIL: PC${i + 1} explains more than PC${i}`);
    failed++;
  }
}
console.log(failed === 0 ? '\nverify-pca: PASS' : `\nverify-pca: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
