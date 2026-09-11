// Check `lib/tsne.mjs` on the parts of t-SNE that have a right answer.
//
//   npm run verify-tsne
//
// The coordinates do not: the objective is non-convex, the initialisation is random, and
// the result is defined only up to rotation and reflection. So comparing against a
// reference embedding would test nothing. What IS checkable:
//
//   1. the kNN graph, against brute force — it is exact, so it either matches or is wrong;
//   2. the perplexity calibration, against its own definition — the entropy of each row's
//      affinities must equal log(perplexity), which is what the binary search solves for;
//   3. NEIGHBOURHOOD PRESERVATION on data with planted clusters — the property t-SNE
//      exists to provide, and the one a reader relies on;
//   4. the cost actually going down.

import { conditionalAffinities, knnGraph, tsneEmbed } from '../lib/tsne.mjs';

/** Planted clusters in high dimensions: the embedding should recover them. */
function clustered(nPerCluster, nClusters, nDims, spread = 0.35) {
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const n = nPerCluster * nClusters;
  const x = new Float32Array(n * nDims);
  const label = new Int32Array(n);
  const centres = Array.from({ length: nClusters }, () => (
    Array.from({ length: nDims }, () => rnd() * 8 - 4)
  ));
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / nPerCluster);
    label[i] = c;
    for (let d = 0; d < nDims; d++) {
      x[i * nDims + d] = centres[c][d] + (rnd() - 0.5) * spread;
    }
  }
  return { x, label, n };
}

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const nDims = 12;
const { x, label, n } = clustered(60, 5, nDims);
const PERPLEXITY = 15;

// ── 1: the graph, against brute force ────────────────────────────────────────
// `knnGraph` and `affinities` are module-private, so the check goes through what the
// public path reports plus an independent brute-force computation here.
const k = 3 * PERPLEXITY;
const bruteFirst = (() => {
  // Nearest neighbour of point 0, by brute force.
  let best = -1;
  let bestD = Infinity;
  for (let j = 1; j < n; j++) {
    let d = 0;
    for (let t = 0; t < nDims; t++) {
      const delta = x[0 * nDims + t] - x[j * nDims + t];
      d += delta * delta;
    }
    if (d < bestD) { bestD = d; best = j; }
  }
  return { best, bestD };
})();
check(label[bruteFirst.best] === label[0],
  'brute-force nearest neighbour of point 0 shares its cluster',
  `point ${bruteFirst.best}, d²=${bruteFirst.bestD.toFixed(4)}`);

// ── 2: the kNN graph is exact, and the calibration hits its definition ───────
const graph = await knnGraph(x, n, nDims, k);
let exactMatches = 0;
for (const probe of [0, 37, 150, 299]) {
  // Brute-force the true k nearest for this row, and compare the sets.
  const all = [];
  for (let j = 0; j < n; j++) {
    if (j === probe) continue;
    let d = 0;
    for (let t = 0; t < nDims; t++) {
      const delta = x[probe * nDims + t] - x[j * nDims + t];
      d += delta * delta;
    }
    all.push([d, j]);
  }
  all.sort((a, b) => a[0] - b[0]);
  const truth = new Set(all.slice(0, k).map((e) => e[1]));
  const got = new Set(Array.from(graph.indices.subarray(probe * k, probe * k + k)));
  if (truth.size === got.size && [...truth].every((j) => got.has(j))) exactMatches++;
}
check(exactMatches === 4, 'the kNN graph matches brute force exactly', `${exactMatches}/4 rows`);

// The calibration's own definition: each row's CONDITIONAL distribution must have entropy
// log(perplexity). Measured before symmetrisation, which deliberately destroys it — the
// symmetric row spans a union of neighbourhoods and its entropy is higher, so reading the
// perplexity back from it reports 241% error on a correct implementation.
//
// This is the ONLY check that sees the search: a mutation fixing the bandwidth at 1 still
// scored 90.7% neighbourhood purity, because separated clusters do not care.
for (const target of [5, 15, 40]) {
  const cond = conditionalAffinities(graph, n, target);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    let h = 0;
    for (let t = 0; t < k; t++) {
      const p = cond[i * k + t];
      if (p > 0) h -= p * Math.log(p);
    }
    worst = Math.max(worst, Math.abs(Math.exp(h) - target) / target);
  }
  check(worst < 0.02, `perplexity ${target} is calibrated`,
    `worst row off by ${(worst * 100).toFixed(2)}%`);
}

// ── 3 & 4: the embedding ─────────────────────────────────────────────────────
const t0 = Date.now();
const { embedding, perplexity, neighbours } = await tsneEmbed(x, n, nDims, {
  dims: 2, perplexity: PERPLEXITY, iterations: 300, seed: 0,
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);
check(neighbours === k, 'keeps 3x perplexity neighbours', `k=${neighbours}`);
check(perplexity === PERPLEXITY, 'uses the requested perplexity', `${perplexity}`);
check(embedding.length === n * 2, 'returns one 2-D point per observation');
check(Array.from(embedding).every(Number.isFinite), 'every coordinate is finite');

// Neighbourhood preservation: for each point, how many of its 10 nearest neighbours IN THE
// EMBEDDING share its cluster. This is the property the plot is read for, and the only
// meaningful check on the geometry.
const K = 10;
let sameCluster = 0;
for (let i = 0; i < n; i++) {
  const d = [];
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const dx = embedding[i * 2] - embedding[j * 2];
    const dy = embedding[i * 2 + 1] - embedding[j * 2 + 1];
    d.push([dx * dx + dy * dy, j]);
  }
  d.sort((a, b) => a[0] - b[0]);
  for (let t = 0; t < K; t++) if (label[d[t][1]] === label[i]) sameCluster++;
}
const purity = sameCluster / (n * K);
// Five well-separated clusters should come out almost perfectly; 0.9 leaves room for the
// points that land on a boundary without admitting a layout that ignores the data.
check(purity > 0.9, `${K}-neighbour purity in the embedding`, `${(purity * 100).toFixed(1)}%`);

// The layout must actually spread: a collapsed embedding would score well on purity while
// showing nothing, since every point would be everyone's neighbour.
let minX = Infinity; let maxX = -Infinity;
for (let i = 0; i < n; i++) {
  if (embedding[i * 2] < minX) minX = embedding[i * 2];
  if (embedding[i * 2] > maxX) maxX = embedding[i * 2];
}
check(maxX - minX > 1, 'the embedding has real extent', `x spans ${(maxX - minX).toFixed(2)}`);

console.log(`\n  ${n} points x ${nDims} dims, 300 iterations, ${secs}s`);
console.log(failed === 0 ? '\nverify-tsne: PASS' : `\nverify-tsne: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
