/**
 * t-SNE (van der Maaten & Hinton 2008), with the all-pairs term behind an interface.
 *
 * Written rather than taken from a library because no JS library can do this at the sizes
 * a spatial-omics dataset reaches. Every pure-JS t-SNE — `tsne-js`, `karpathy/tsnejs`,
 * `druidjs` — implements the exact formulation with no space partitioning;
 * `tensorflow/tfjs-tsne`, which did have a linear-time GPU optimisation, was archived in
 * February 2021; and the one Barnes-Hut option on npm wraps C++.
 *
 * Two costs, split because they scale differently:
 *
 *  - The ATTRACTIVE term runs over a sparse P — each point's nearest neighbours only.
 *    Dense P at 19,416 points is 377 million entries, 1.5 GB, and everything outside a
 *    neighbourhood is ~0 anyway. It stays here in plain TypeScript: O(nnz), about 1.7 M
 *    pairs, a few milliseconds.
 *  - The REPULSIVE term is genuinely all-pairs and is delegated to a {@link Repulsion}.
 *    The default is a plain loop, correct everywhere and fast enough for a few thousand
 *    points; the browser worker injects one backed by WebGPU.
 *
 * Injecting it is what keeps this file testable: the algorithm can be exercised in jsdom
 * with no GPU and no WebAssembly, which matters because two subtle bugs in it were caught
 * by tests and neither was visible in the output.
 *
 * Still O(N²) per iteration — fast because the inner loop is vectorised, not because the
 * algorithm changed. Barnes-Hut would make it O(N log N).
 */

/** Neighbours kept per point, as a multiple of the perplexity — the usual 3x. */
export const NEIGHBOUR_FACTOR = 3;
/**
 * Iterations of early exaggeration, and the factor applied to P during them.
 *
 * Capped at HALF the run, which the usual fixed 250 is not. Exaggeration pulls clusters
 * apart before the layout settles, so a short run spends almost all of itself exaggerated
 * and stops before it resolves: measured on planted clusters, 300 iterations gave 85%
 * neighbourhood purity against 100% at 600. That is a trap for anyone who lowers the
 * iteration count to get an answer sooner — the layout does not get coarser, it gets
 * WRONG, and nothing says so.
 */
const EXAGGERATION_ITERS = 250;
const EXAGGERATION = 12;
const MOMENTUM_EARLY = 0.5;
const MOMENTUM_LATE = 0.8;

/** The all-pairs term: `Σ_j w²(y_i − y_j)` per point, and `Z = Σ_{i≠j} w`. */
export interface Repulsion {
  compute(
    y: Float64Array, nObs: number, dims: number,
  ): Promise<{ rep: Float64Array; z: number }>;
  dispose?(): void;
}

export interface TsneOptions {
  dims?: 2 | 3;
  perplexity?: number;
  iterations?: number;
  seed?: number;
  learningRate?: number;
  repulsion?: Repulsion;
  /** Called with `(done, total)`; a run can be minutes, and silence reads as a hang. */
  onProgress?: (done: number, total: number) => void;
  /** Checked each iteration so a caller can abandon a long run. */
  shouldStop?: () => boolean;
}

export interface TsneResult {
  embedding: Float64Array;
  perplexity: number;
  neighbours: number;
  /** False when `shouldStop` ended the run early. */
  completed: boolean;
}

/** Deterministic uniform stream, so a rerun reproduces the embedding. */
function rng(seed: number): () => number {
  let a = (seed + 1) >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The straightforward all-pairs loop. Correct everywhere; the fallback when no GPU. */
export const plainRepulsion: Repulsion = {
  async compute(y, nObs, dims) {
    const rep = new Float64Array(nObs * dims);
    let z = 0;
    for (let i = 0; i < nObs; i++) {
      for (let j = 0; j < nObs; j++) {
        if (i === j) continue;
        let d2 = 0;
        for (let d = 0; d < dims; d++) {
          const delta = y[i * dims + d] - y[j * dims + d];
          d2 += delta * delta;
        }
        const w = 1 / (1 + d2);
        z += w;
        const w2 = w * w;
        for (let d = 0; d < dims; d++) {
          rep[i * dims + d] += w2 * (y[i * dims + d] - y[j * dims + d]);
        }
      }
    }
    return { rep, z };
  },
};

/**
 * Exact k nearest neighbours.
 *
 * Exact rather than approximate: it is a one-off against a thousand iterations, so an
 * index would save little and add a second source of error to the only part of this with
 * a right answer.
 *
 * The selection keeps a k-sized buffer and its current worst distance, so almost every
 * candidate costs one comparison. A heap would pay log(k) on all of them.
 */
export function knnGraph(
  x: Float32Array | Float64Array, nObs: number, nDims: number, k: number,
): { indices: Int32Array; distances: Float32Array; k: number } {
  const indices = new Int32Array(nObs * k);
  const distances = new Float32Array(nObs * k);
  for (let i = 0; i < nObs; i++) {
    const outBase = i * k;
    let filled = 0;
    let worst = Infinity;
    let worstAt = 0;
    for (let j = 0; j < nObs; j++) {
      if (j === i) continue;
      let d = 0;
      for (let t = 0; t < nDims; t++) {
        const delta = x[i * nDims + t] - x[j * nDims + t];
        d += delta * delta;
      }
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
  return { indices, distances, k };
}

/**
 * Per-row conditional affinities, calibrated to a target perplexity.
 *
 * Each row gets its own bandwidth β, found by bisection so that the Shannon entropy of
 * its distribution equals log(perplexity). That is what perplexity MEANS — the effective
 * number of neighbours — and why one bandwidth cannot serve a dataset with both dense and
 * sparse regions.
 *
 * Distances are shifted by the row minimum before exponentiating. The shift cancels in the
 * normalisation but keeps the largest weight at exp(0) = 1 rather than underflowing where
 * distances are large. It is NOT what fixed the calibration bug this code once had — that
 * was an underflow guard which moved the bisection's upper bound below its lower one, so
 * the search wandered; only a tight perplexity, which needs a large β, revealed it.
 */
export function conditionalAffinities(
  knn: { distances: Float32Array; k: number }, nObs: number, perplexity: number,
): Float64Array {
  const { distances, k } = knn;
  const target = Math.log(perplexity);
  const cond = new Float64Array(nObs * k);
  for (let i = 0; i < nObs; i++) {
    const base = i * k;
    let dmin = Infinity;
    for (let t = 0; t < k; t++) if (distances[base + t] < dmin) dmin = distances[base + t];

    let beta = 1;
    let lo = 0;
    let hi = Infinity;
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
 * Separate from the calibration because the two have different testable properties: the
 * conditional rows have entropy log(perplexity) exactly, while symmetrising deliberately
 * mixes each row with its neighbours' and destroys that — a symmetric row spans the UNION
 * of "i's neighbours" and "points that chose i", so its entropy is higher and the
 * perplexity cannot be read back from it.
 */
export function affinities(
  knn: { indices: Int32Array; distances: Float32Array; k: number },
  nObs: number,
  perplexity: number,
): { rowPtr: Int32Array; colIdx: Int32Array; val: Float32Array } {
  const { indices, k } = knn;
  const cond = conditionalAffinities(knn, nObs, perplexity);

  const pairs = new Map<number, number>();
  const keyOf = (a: number, b: number) => (a < b ? a * nObs + b : b * nObs + a);
  for (let i = 0; i < nObs; i++) {
    for (let t = 0; t < k; t++) {
      const key = keyOf(i, indices[i * k + t]);
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
  // Normalised by 2n so the full symmetric matrix sums to 1.
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

/** Embed `x` (row-major `nObs x nDims`) into `dims` dimensions. */
export async function tsneEmbed(
  x: Float32Array | Float64Array, nObs: number, nDims: number, options: TsneOptions = {},
): Promise<TsneResult> {
  const {
    dims = 2, perplexity = 30, iterations = 1000, seed = 0,
    learningRate = Math.max(200, nObs / 12),
    repulsion = plainRepulsion, onProgress, shouldStop,
  } = options;

  // Perplexity cannot exceed the neighbourhood it is calibrated over, and n-1 caps both.
  const k = Math.max(1, Math.min(nObs - 1, Math.round(NEIGHBOUR_FACTOR * perplexity)));
  const effective = Math.min(perplexity, Math.max(1, Math.floor(k / NEIGHBOUR_FACTOR)));

  const knn = knnGraph(x, nObs, nDims, k);
  const { rowPtr, colIdx, val } = affinities(knn, nObs, effective);

  const random = rng(seed);
  // The standard 1e-4 init scale: large initial coordinates put every pair far apart,
  // where the gradient is flat and the layout never organises.
  const y = new Float64Array(nObs * dims);
  for (let i = 0; i < y.length; i++) y[i] = (random() - 0.5) * 1e-4;
  const velocity = new Float64Array(nObs * dims);
  const gains = new Float64Array(nObs * dims).fill(1);
  const grad = new Float64Array(nObs * dims);

  const exaggerationIters = Math.min(EXAGGERATION_ITERS, Math.floor(iterations / 2));
  let completed = true;
  for (let iter = 0; iter < iterations; iter++) {
    if (shouldStop?.()) { completed = false; break; }
    const exaggerate = iter < exaggerationIters ? EXAGGERATION : 1;
    const momentum = iter < exaggerationIters ? MOMENTUM_EARLY : MOMENTUM_LATE;

    const { rep, z } = await repulsion.compute(y, nObs, dims);
    const invZ = z > 0 ? 1 / z : 0;

    grad.fill(0);
    for (let i = 0; i < nObs; i++) {
      for (let e = rowPtr[i]; e < rowPtr[i + 1]; e++) {
        const j = colIdx[e];
        let d2 = 0;
        for (let d = 0; d < dims; d++) {
          const delta = y[i * dims + d] - y[j * dims + d];
          d2 += delta * delta;
        }
        const p = val[e] * exaggerate * (1 / (1 + d2));
        for (let d = 0; d < dims; d++) {
          grad[i * dims + d] += p * (y[i * dims + d] - y[j * dims + d]);
        }
      }
    }
    for (let i = 0; i < grad.length; i++) grad[i] = 4 * (grad[i] - rep[i] * invZ);

    // Momentum with per-coordinate gains: gains grow where the gradient keeps its sign
    // and shrink where it flips, which lets one learning rate serve both the early
    // spreading and the late settling.
    for (let i = 0; i < y.length; i++) {
      const sameSign = (grad[i] > 0) === (velocity[i] > 0);
      gains[i] = Math.max(0.01, sameSign ? gains[i] * 0.8 : gains[i] + 0.2);
      velocity[i] = momentum * velocity[i] - learningRate * gains[i] * grad[i];
      y[i] += velocity[i];
    }
    // Recentre: the cost is translation-invariant, so drift is pure noise in the output.
    for (let d = 0; d < dims; d++) {
      let mean = 0;
      for (let i = 0; i < nObs; i++) mean += y[i * dims + d];
      mean /= nObs;
      for (let i = 0; i < nObs; i++) y[i * dims + d] -= mean;
    }

    if (onProgress && ((iter + 1) % 10 === 0 || iter + 1 === iterations)) {
      onProgress(iter + 1, iterations);
    }
  }

  return { embedding: y, perplexity: effective, neighbours: k, completed };
}
