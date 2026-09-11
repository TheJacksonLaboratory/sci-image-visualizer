// Principal components of a large, short-and-wide expression matrix.
//
// Randomized subspace iteration (Halko, Martinsson & Tropp 2011) — the same approach
// scanpy takes at this size, and the only tractable one here: an exact SVD of
// 2,688 x 18,078 computes 2,688 singular triples to use three.
//
// The linear algebra is `@jax-js/jax`, which carries a real `linalg` (svd, eigh) and runs
// on a Wasm SIMD backend, WebGPU or WebGL. Measured on the operation this is dominated by
// — a 2688x18078 @ 18078x60 product — the Wasm backend takes 0.59 s against 4.21 s for the
// hand-written loop it replaces, so the whole reduction went from 23 s to a few. It also
// removes a hand-rolled Jacobi eigensolver in favour of a library `svd`.
//
// WebGPU is deliberately NOT requested. Node has none — `init('webgpu')` there silently
// returns the CPU and Wasm backends — so asking for it would imply an acceleration that is
// not happening. If this computation ever moves into the browser, that is where the device
// already exists (napari-js holds a `GPUDevice`) and where the request belongs.
//
// TWO jax-js RULES THIS CODE HAS TO OBEY, both silent when broken:
//
//   * MOVE SEMANTICS. An array is consumed by the operation that reads it. Reusing one
//     without `.ref` throws "Referenced tracer freed" — a getter, not a method. Every
//     value used twice below takes `.ref`, and the big intermediates are disposed.
//   * `eigh` AND `svd` ORDERING. `eigh` returns eigenvalues ASCENDING, where every caller
//     here wants the leading components first. `svd` returns singular values descending.
//     Mixing the two conventions silently reports the smallest component as PC1.
//
// Accuracy is checked rather than asserted: `npm run verify-pca` cross-checks the leading
// components against `pca-js`, an independent exact implementation, and the ratios match
// numpy's exact SVD on both example datasets (18.2/7.1/5.0 and 7.3/2.9/2.1).

import * as jax from '@jax-js/jax';

const np = jax.numpy;

/** Started once. Concurrent callers await the same initialisation. */
let ready = null;
function initJax() {
  ready ??= jax.init('wasm');
  return ready;
}

/**
 * The gene-major matrix a bundle stores, centred per gene, as a flat Float32Array.
 *
 * `features/matrix.f32` is GENE-major — gene `j` occupies `[j*n, (j+1)*n)` — so centring
 * is one forward pass per gene. Kept in plain JS: it is a single streaming pass, and it
 * also accumulates the TOTAL variance, which is the denominator every variance ratio needs
 * and which cannot be recovered from the top components alone.
 */
export function centreByGene(matrix, nObs, nGenes) {
  const centred = new Float32Array(matrix.length);
  let totalSq = 0;
  for (let j = 0; j < nGenes; j++) {
    const base = j * nObs;
    let sum = 0;
    for (let i = 0; i < nObs; i++) sum += matrix[base + i];
    const mean = sum / nObs;
    for (let i = 0; i < nObs; i++) {
      const v = matrix[base + i] - mean;
      centred[base + i] = v;
      totalSq += v * v;
    }
  }
  return { centred, totalVariance: totalSq / (nObs - 1) };
}

/** Deterministic standard-normal stream, so a rerun reproduces its components. */
function gaussians(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) || 1e-9;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * Top-`k` principal component scores of a gene-major matrix.
 *
 * Returns `{ scores, varianceRatio, components }` — scores as `nObs x components`
 * row-major, and the fraction of TOTAL variance each component explains.
 *
 * Async because the backend initialises asynchronously and device buffers read back the
 * same way. The heavy products never transpose the big matrix: `Xc @ M` is evaluated as
 * `(Mᵀ Xcᵀ)ᵀ`, so only the small `p`-column results are transposed and the 194 MB matrix
 * is never copied.
 */
export async function pcaScores(matrix, nObs, nGenes, k, { oversample = 10, power = 2, seed = 0 } = {}) {
  await initJax();
  const p = Math.min(nObs, nGenes, k + oversample);
  const { centred, totalVariance } = centreByGene(matrix, nObs, nGenes);

  // Xcᵀ, exactly as the bundle stores it — no transpose, no copy.
  const xt = np.array(centred, 'float32').reshape([nGenes, nObs]);

  /** `Xc @ M` for an `(nGenes, p)` M, as `(Mᵀ Xcᵀ)ᵀ`. Result `(nObs, p)`. */
  const xcTimes = (m) => np.matmul(m.transpose(), xt.ref).transpose();
  /** `Xcᵀ @ Q` for an `(nObs, p)` Q. Result `(nGenes, p)`. */
  const xcTTimes = (q) => np.matmul(xt.ref, q);

  /** An orthonormal basis for the columns of an `(nObs, p)` Y — the left singular vectors. */
  const orth = (y) => {
    const [u] = np.linalg.svd(y, { fullMatrices: false });
    return u;
  };

  const normal = gaussians(seed + 1);
  const omegaData = new Float32Array(nGenes * p);
  for (let i = 0; i < omegaData.length; i++) omegaData[i] = normal();

  let q = orth(xcTimes(np.array(omegaData, 'float32').reshape([nGenes, p])));
  // Power iterations sharpen the subspace when the spectrum decays slowly, which is
  // exactly the whole-transcriptome case: PC1 explains 7%, not 70%, so the tail is close
  // behind and a single projection would mix the leading components. Verified — removing
  // them moves the reported ratios by more than a point, which `verify-pca` fails on.
  for (let i = 0; i < power; i++) {
    const z = xcTTimes(q);
    q = orth(xcTimes(z));
  }

  // B = Qᵀ Xc, held as its transpose so the big matrix stays untransposed. Its singular
  // values are Xc's leading ones, and B's LEFT singular vectors are Btᵀ's right ones.
  const bt = xcTTimes(q.ref);
  const [, sv, vt] = np.linalg.svd(bt, { fullMatrices: false });
  const singular = Array.from(await sv.data());

  // scores = Q @ W @ diag(s), with W the left singular vectors of B.
  const w = vt.transpose();
  const projected = np.matmul(q, w);
  const flat = await projected.data();
  xt.dispose?.();

  const take = Math.min(k, p);
  const scores = new Float64Array(nObs * take);
  for (let c = 0; c < take; c++) {
    const s = singular[c];
    for (let i = 0; i < nObs; i++) scores[i * take + c] = flat[i * p + c] * s;
  }

  // var_c = s_c^2 / (n - 1), as a fraction of the variance of the whole centred matrix.
  const varianceRatio = singular.slice(0, take)
    .map((s) => (s * s) / (nObs - 1) / totalVariance);
  return { scores, varianceRatio, components: take };
}
