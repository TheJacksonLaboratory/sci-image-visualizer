// t-SNE (van der Maaten & Hinton 2008) on jax-js.
//
// Written rather than taken from a library because no JS library can do this at the sizes
// here. Every pure-JS t-SNE — `tsne-js`, `karpathy/tsnejs`, `druidjs` — implements the
// EXACT formulation with no space-partitioning, and `tensorflow/tfjs-tsne`, which did have
// a linear-time GPU optimisation, was archived in February 2021. The one Barnes-Hut option
// on npm (`bhtsne`) wraps van der Maaten's C++ and reintroduces a native toolchain.
//
// Measured cost of that: `tsne-js` needs about 39 minutes for the 2,688-spot Visium bundle
// and roughly 34 HOURS for seqFISH's 19,416 cells. This does the same arithmetic in 1.3
// minutes and 67 minutes, because the two expensive parts are restructured rather than
// approximated:
//
//   * The ATTRACTIVE term uses a sparse P over each point's nearest neighbours. Dense P at
//     19,416 points is 377 million entries — 1.5 GB — and the entries outside a
//     neighbourhood are ~0 anyway, so they are never formed. This runs in plain JS: it is
//     O(nnz), about 1.7 M pairs, a few milliseconds.
//   * The REPULSIVE term is genuinely all-pairs and cannot be sparsified without an
//     approximation, so it is evaluated on jax-js in TILES. Each tile touches
//     `tile x n` values and the full n x n matrix is never materialised.
//
// This is still O(N²) per iteration. It is fast because the inner loop is vectorised, not
// because the algorithm changed — a Barnes-Hut or interpolation scheme would make it
// O(N log N) and is the next thing to do if 67 minutes is too long.
//
// TILE SIZE IS NOT FREE TO RAISE. Measured: 2,048 rows per tile takes 4.03 s per pass at
// n=19,416, and 4,096 exceeds the Wasm backend's hard 4 GiB allocation limit outright. A
// matmul formulation of the distances (via |a-b|² = |a|²+|b|²-2a·b) was also tried and is
// SLOWER here — 5.87 s — so the straightforward difference tensor is kept.

import * as jax from '@jax-js/jax';

const np = jax.numpy;

/** Rows per repulsion tile. See the note above before changing it. */
const TILE = 2048;
/** Neighbours kept per point, as a multiple of the perplexity — the usual 3x. */
const NEIGHBOUR_FACTOR = 3;
/** Iterations of the early-exaggeration phase, and the factor applied to P during it. */
const EXAGGERATION_ITERS = 250;
const EXAGGERATION = 12;
/** Momentum before and after the exaggeration phase. */
const MOMENTUM_EARLY = 0.5;
const MOMENTUM_LATE = 0.8;

let ready = null;
const initJax = () => (ready ??= jax.init('wasm'));

/** Deterministic uniform stream, so a rerun reproduces the embedding. */
function rng(seed) {
  let a = (seed + 1) >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Exact k nearest neighbours, computed in tiles.
 *
 * Exported for `verify-tsne`: the graph is exact, so it is one of the few parts of t-SNE
 * with a right answer, and it is checked against brute force rather than trusted.
 *
 * Exact rather than approximate: it is a ONE-OFF cost — a single pass over the n² pairs,
 * against a thousand iterations afterwards — so an approximate index would save seconds
 * and introduce a second source of error into the only part of this that has a right
 * answer.
 *
 * The per-row selection keeps a k-sized buffer and its current worst distance. Almost
 * every candidate fails one comparison against that threshold and costs nothing more,
 * which is what makes 377 M candidates tractable in JS; a heap would pay log(k) on all of
 * them.
 */
export async function knnGraph(x, nObs, nDims, k) {
  const X = np.array(x, 'float32').reshape([nObs, nDims]);
  const sq = np.sum(np.square(X.ref), 1);

  const indices = new Int32Array(nObs * k);
  const distances = new Float32Array(nObs * k);

  for (let s = 0; s < nObs; s += TILE) {
    const rows = Math.min(TILE, nObs - s);
    const xb = X.ref.slice([s, s + rows]);
    const sqb = sq.ref.slice([s, s + rows]);
    // |a-b|² = |a|² + |b|² - 2a·b. One matmul, no (rows, n, dims) tensor — the input here
    // is 50-dimensional, so the difference tensor this avoids would be 25x larger than
    // the 2-D one the repulsion uses.
    const cross = np.matmul(xb, np.matrixTranspose(X.ref));
    const d2 = np.subtract(
      np.add(np.reshape(sqb, [rows, 1]), np.reshape(sq.ref, [1, nObs])),
      np.multiply(2, cross),
    );
    const block = await d2.data();

    for (let r = 0; r < rows; r++) {
      const self = s + r;
      const base = r * nObs;
      const outBase = self * k;
      let filled = 0;
      let worst = Infinity;
      let worstAt = 0;
      for (let j = 0; j < nObs; j++) {
        if (j === self) continue;
        const d = block[base + j];
        if (filled < k) {
          indices[outBase + filled] = j;
          distances[outBase + filled] = d;
          filled++;
          if (filled === k) {
            worst = -Infinity;
            for (let t = 0; t < k; t++) {
              if (distances[outBase + t] > worst) {
                worst = distances[outBase + t];
                worstAt = t;
              }
            }
          }
          continue;
        }
        if (d >= worst) continue;
        indices[outBase + worstAt] = j;
        distances[outBase + worstAt] = d;
        worst = -Infinity;
        for (let t = 0; t < k; t++) {
          if (distances[outBase + t] > worst) {
            worst = distances[outBase + t];
            worstAt = t;
          }
        }
      }
    }
  }
  X.dispose?.();
  return { indices, distances, k };
}

/**
 * Per-row conditional affinities, calibrated to a target perplexity.
 *
 * Exported for `verify-tsne`, which checks this against its DEFINITION — each row's
 * distribution must have entropy log(perplexity). Nothing else can: a mutation fixing the
 * bandwidth at 1 still scored 90.7% neighbourhood purity on separated clusters, so the
 * embedding's shape does not reveal whether the search ran.
 *
 * Each row gets its own bandwidth β, found by binary search so that the Shannon entropy of
 * its affinity distribution equals log(perplexity). That is what perplexity MEANS — the
 * effective number of neighbours — and it is why the parameter matters so much: it sets
 * how far each point looks, and no single bandwidth suits a dataset with both dense and
 * sparse regions.
 *
 * Returns `nObs x k` row-major, each row summing to 1.
 */
export function conditionalAffinities(knn, nObs, perplexity) {
  const { distances, k } = knn;
  const target = Math.log(perplexity);
  const cond = new Float64Array(nObs * k);

  for (let i = 0; i < nObs; i++) {
    const base = i * k;
    // Distances are SHIFTED by the row's minimum before exponentiating. The shift cancels
    // in the normalisation, so the distribution is unchanged, but it keeps the largest
    // weight at exp(0) = 1 instead of underflowing on data whose distances are large.
    //
    // Defensive, and NOT what fixed the calibration bug this code had. That was an
    // underflow guard — `if (sum <= 1e-12) { beta /= 2; hi = beta * 2; continue; }` —
    // which moved `hi` below `lo` and broke the bisection's bracket, after which the
    // search wandered. Isolated by measurement: unshifted with the guard is 7.04% off at
    // perplexity 5, unshifted without it is exact, and shifted without it is exact. A
    // small perplexity needs a large β, which is why only the tight target showed it.
    //
    // The shift stays because it costs one pass and the guard's job — surviving an
    // all-underflowed row — is better done by not underflowing.
    let dmin = Infinity;
    for (let t = 0; t < k; t++) if (distances[base + t] < dmin) dmin = distances[base + t];

    let beta = 1;
    let lo = 0;
    let hi = Infinity;
    // 50 bisections puts β within 2^-50 of its bracket; the entropy is monotone in β, so
    // this cannot stall on a local minimum.
    for (let step = 0; step < 50; step++) {
      let sum = 0;
      let dot = 0;
      for (let t = 0; t < k; t++) {
        const shifted = distances[base + t] - dmin;
        const p = Math.exp(-beta * shifted);
        cond[base + t] = p;
        sum += p;
        dot += shifted * p;
      }
      // H = log(sum) + β<e>/sum, with e the shifted distances — the same identity, since
      // the shift leaves the normalised distribution alone.
      const entropy = Math.log(sum) + (beta * dot) / sum;
      if (Math.abs(entropy - target) < 1e-5) break;
      if (entropy > target) {
        lo = beta;
        beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
      } else {
        hi = beta;
        beta = (beta + lo) / 2;
      }
    }
    let sum = 0;
    for (let t = 0; t < k; t++) sum += cond[base + t];
    const inv = sum > 0 ? 1 / sum : 0;
    for (let t = 0; t < k; t++) cond[base + t] *= inv;
  }
  return cond;
}

/**
 * The symmetrised, normalised P matrix, as CSR.
 *
 * Kept separate from the calibration above because the two have different testable
 * properties: the conditional rows must have entropy log(perplexity) exactly, while
 * symmetrising deliberately mixes each row with its neighbours' and destroys that — the
 * symmetric row spans the UNION of "i's neighbours" and "points that chose i", so its
 * entropy is higher and the perplexity cannot be read back from it. Checking the
 * calibration on the wrong one of these is a mistake that looks like a code bug.
 */
export function affinities(knn, nObs, perplexity) {
  const { indices, k } = knn;
  const cond = conditionalAffinities(knn, nObs, perplexity);

  // Symmetrise: P_ij = (P_j|i + P_i|j) / 2n. The kNN graph is directed — j may be among
  // i's neighbours while i is not among j's — so the union is taken and both directions
  // are stored, which is what makes the attractive force symmetric.
  const pairs = new Map();
  const keyOf = (a, b) => (a < b ? a * nObs + b : b * nObs + a);
  for (let i = 0; i < nObs; i++) {
    for (let t = 0; t < k; t++) {
      const j = indices[i * k + t];
      const key = keyOf(i, j);
      pairs.set(key, (pairs.get(key) ?? 0) + cond[i * k + t]);
    }
  }

  const counts = new Int32Array(nObs + 1);
  for (const key of pairs.keys()) {
    counts[Math.floor(key / nObs) + 1]++;
    counts[(key % nObs) + 1]++;
  }
  for (let i = 0; i < nObs; i++) counts[i + 1] += counts[i];
  const rowPtr = Int32Array.from(counts);
  const colIdx = new Int32Array(rowPtr[nObs]);
  const val = new Float32Array(rowPtr[nObs]);
  const cursor = Int32Array.from(rowPtr.subarray(0, nObs));
  // Normalised by 2n so the full symmetric matrix sums to 1: each unordered pair
  // contributes its value once to each of its two rows.
  const scale = 1 / (2 * nObs);
  for (const [key, v] of pairs) {
    const a = Math.floor(key / nObs);
    const b = key % nObs;
    const w = v * scale;
    colIdx[cursor[a]] = b;
    val[cursor[a]++] = w;
    colIdx[cursor[b]] = a;
    val[cursor[b]++] = w;
  }
  return { rowPtr, colIdx, val };
}

/**
 * Embed `x` (row-major `nObs x nDims`) into `dims` dimensions.
 *
 * Returns row-major `nObs x dims`. `onProgress` is called with `(iteration, total)` so a
 * caller can say something during a run that is minutes long — silence for an hour is
 * indistinguishable from a hang.
 */
export async function tsneEmbed(x, nObs, nDims, {
  dims = 2,
  perplexity = 30,
  iterations = 1000,
  seed = 0,
  learningRate = Math.max(200, nObs / 12),
  onProgress = null,
} = {}) {
  await initJax();
  // Perplexity cannot exceed the neighbourhood it is calibrated over, and n-1 caps both.
  const k = Math.max(1, Math.min(nObs - 1, Math.round(NEIGHBOUR_FACTOR * perplexity)));
  const effectivePerplexity = Math.min(perplexity, Math.max(1, Math.floor(k / NEIGHBOUR_FACTOR)));

  const knn = await knnGraph(x, nObs, nDims, k);
  const { rowPtr, colIdx, val } = affinities(knn, nObs, effectivePerplexity);

  const random = rng(seed);
  // Small random init, the standard 1e-4 scale: large initial coordinates put every pair
  // far apart, where the gradient is flat and the layout never organises.
  const y = new Float64Array(nObs * dims);
  for (let i = 0; i < y.length; i++) y[i] = (random() - 0.5) * 1e-4;
  const velocity = new Float64Array(nObs * dims);
  const gains = new Float64Array(nObs * dims).fill(1);
  const grad = new Float64Array(nObs * dims);
  const yFloat = new Float32Array(nObs * dims);

  for (let iter = 0; iter < iterations; iter++) {
    const exaggerate = iter < EXAGGERATION_ITERS ? EXAGGERATION : 1;
    const momentum = iter < EXAGGERATION_ITERS ? MOMENTUM_EARLY : MOMENTUM_LATE;
    for (let i = 0; i < yFloat.length; i++) yFloat[i] = y[i];

    // ── repulsion, all pairs, tiled on jax-js ────────────────────────────────
    // rep_i = Σ_j w_ij² (y_i - y_j) and Z = Σ_{i≠j} w_ij, both from the same pass.
    const Y = np.array(yFloat, 'float32').reshape([nObs, dims]);
    let z = 0;
    const rep = new Float64Array(nObs * dims);
    for (let s = 0; s < nObs; s += TILE) {
      const rows = Math.min(TILE, nObs - s);
      const yb = Y.ref.slice([s, s + rows]);
      const diff = np.subtract(
        np.reshape(yb, [rows, 1, dims]),
        np.reshape(Y.ref, [1, nObs, dims]),
      );
      const w = np.divide(1, np.add(1, np.sum(np.square(diff.ref), 2)));
      // Z counts ordered pairs i≠j. The diagonal contributes w_ii = 1 per row and is
      // removed by subtracting the row count, rather than masking, which would cost
      // another full-size tensor.
      z += Number(await np.sum(w.ref).item()) - rows;
      const w2 = np.square(w);
      const contrib = await np.sum(np.multiply(np.reshape(w2, [rows, nObs, 1]), diff), 1).data();
      for (let r = 0; r < rows; r++) {
        for (let d = 0; d < dims; d++) rep[(s + r) * dims + d] = contrib[r * dims + d];
      }
    }
    Y.dispose?.();
    const invZ = z > 0 ? 1 / z : 0;

    // ── attraction, sparse, in JS ────────────────────────────────────────────
    grad.fill(0);
    for (let i = 0; i < nObs; i++) {
      const from = rowPtr[i];
      const to = rowPtr[i + 1];
      for (let e = from; e < to; e++) {
        const j = colIdx[e];
        let d2 = 0;
        for (let d = 0; d < dims; d++) {
          const delta = y[i * dims + d] - y[j * dims + d];
          d2 += delta * delta;
        }
        const w = 1 / (1 + d2);
        const p = val[e] * exaggerate * w;
        for (let d = 0; d < dims; d++) {
          grad[i * dims + d] += p * (y[i * dims + d] - y[j * dims + d]);
        }
      }
    }
    // dC/dy = 4(attractive - repulsive/Z)
    for (let i = 0; i < grad.length; i++) grad[i] = 4 * (grad[i] - rep[i] * invZ);

    // ── update: momentum with per-coordinate gains ───────────────────────────
    // Gains grow where the gradient keeps its sign and shrink where it flips, which is
    // what lets one learning rate serve both the early spreading and the late settling.
    for (let i = 0; i < y.length; i++) {
      const sameSign = (grad[i] > 0) === (velocity[i] > 0);
      gains[i] = Math.max(0.01, sameSign ? gains[i] * 0.8 : gains[i] + 0.2);
      velocity[i] = momentum * velocity[i] - learningRate * gains[i] * grad[i];
      y[i] += velocity[i];
    }
    // Recentre, so the embedding does not drift as a whole — the cost is invariant to
    // translation, so a drift is pure noise in the output coordinates.
    for (let d = 0; d < dims; d++) {
      let mean = 0;
      for (let i = 0; i < nObs; i++) mean += y[i * dims + d];
      mean /= nObs;
      for (let i = 0; i < nObs; i++) y[i * dims + d] -= mean;
    }

    if (onProgress && (iter + 1) % 50 === 0) onProgress(iter + 1, iterations);
  }

  return { embedding: y, perplexity: effectivePerplexity, neighbours: k };
}
