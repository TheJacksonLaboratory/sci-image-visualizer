// Principal components of a large, short-and-wide expression matrix, in plain JS.
//
// The Python this replaces called `numpy.linalg.svd` on the whole centred matrix. That is
// not available here and a full SVD of 2,688 x 18,078 would not be worth writing: it
// computes 2,688 singular triples to use three of them.
//
// RANDOMIZED SUBSPACE ITERATION instead (Halko, Martinsson & Tropp 2011), which is the
// same thing scanpy reaches for at this size. Project the matrix onto a small random
// subspace, refine that subspace with a power iteration or two, and take an exact SVD of
// the tiny projected matrix. The top components come back to several decimal places and
// the cost is a handful of passes over the data rather than a cubic factorisation.
//
// Accuracy is checkable rather than asserted: `varianceRatio` from this reproduces what
// numpy's exact SVD reported for the same datasets (see the README).

/**
 * The gene-major matrix a bundle stores, centred per gene, as a flat Float32Array.
 *
 * `features/matrix.f32` is GENE-major — gene `j` occupies `[j*n, (j+1)*n)` — which is the
 * layout every operation below wants: centring is per gene, and both matrix products loop
 * genes on the outside, so each pass walks memory forwards.
 *
 * Returns the centred copy and the total variance, which is the denominator every
 * variance ratio needs and which cannot be recovered from the top components alone.
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

/** `Xc @ B`, with Xc held gene-major. Result is `nObs x p`, row-major. */
function mulXB(centred, nObs, nGenes, B, p) {
  const out = new Float64Array(nObs * p);
  for (let j = 0; j < nGenes; j++) {
    const base = j * nObs;
    const brow = j * p;
    for (let t = 0; t < p; t++) {
      const b = B[brow + t];
      if (b === 0) continue;
      for (let i = 0; i < nObs; i++) out[i * p + t] += centred[base + i] * b;
    }
  }
  return out;
}

/** `Xc^T @ Y`, with Xc held gene-major. Result is `nGenes x p`, row-major. */
function mulXtY(centred, nObs, nGenes, Y, p) {
  const out = new Float64Array(nGenes * p);
  for (let j = 0; j < nGenes; j++) {
    const base = j * nObs;
    const orow = j * p;
    for (let i = 0; i < nObs; i++) {
      const v = centred[base + i];
      if (v === 0) continue;
      for (let t = 0; t < p; t++) out[orow + t] += v * Y[i * p + t];
    }
  }
  return out;
}

/** Orthonormalise the columns of an `n x p` row-major matrix, in place (modified G-S). */
function orthonormalise(Y, n, p) {
  for (let t = 0; t < p; t++) {
    for (let s = 0; s < t; s++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += Y[i * p + t] * Y[i * p + s];
      for (let i = 0; i < n; i++) Y[i * p + t] -= dot * Y[i * p + s];
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += Y[i * p + t] * Y[i * p + t];
    norm = Math.sqrt(norm);
    // A dependent column contributes nothing; zero it rather than dividing by ~0 and
    // filling the basis with noise that later looks like a component.
    const scale = norm > 1e-9 ? 1 / norm : 0;
    for (let i = 0; i < n; i++) Y[i * p + t] *= scale;
  }
}

/**
 * Eigendecomposition of a small symmetric matrix by cyclic Jacobi rotations.
 *
 * `p` is the sketch width — a few dozen — so an O(p^3) method with no dependencies is the
 * right tool. Returns eigenvalues descending, with eigenvectors as columns.
 */
function jacobiEigen(A, p, sweeps = 60) {
  const a = Float64Array.from(A);
  const v = new Float64Array(p * p);
  for (let i = 0; i < p; i++) v[i * p + i] = 1;

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) off += a[i * p + j] ** 2;
    if (off < 1e-22) break;
    for (let i = 0; i < p; i++) {
      for (let j = i + 1; j < p; j++) {
        const aij = a[i * p + j];
        if (Math.abs(aij) < 1e-18) continue;
        const theta = (a[j * p + j] - a[i * p + i]) / (2 * aij);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < p; k++) {
          const aik = a[i * p + k];
          const ajk = a[j * p + k];
          a[i * p + k] = c * aik - s * ajk;
          a[j * p + k] = s * aik + c * ajk;
        }
        for (let k = 0; k < p; k++) {
          const aki = a[k * p + i];
          const akj = a[k * p + j];
          a[k * p + i] = c * aki - s * akj;
          a[k * p + j] = s * aki + c * akj;
        }
        for (let k = 0; k < p; k++) {
          const vki = v[k * p + i];
          const vkj = v[k * p + j];
          v[k * p + i] = c * vki - s * vkj;
          v[k * p + j] = s * vki + c * vkj;
        }
      }
    }
  }

  const order = Array.from({ length: p }, (_, i) => i)
    .sort((x, y) => a[y * p + y] - a[x * p + x]);
  return {
    values: order.map((i) => a[i * p + i]),
    vectors: order.map((i) => Float64Array.from({ length: p }, (_, k) => v[k * p + i])),
  };
}

/**
 * Top-`k` principal component scores of a gene-major matrix.
 *
 * Returns `{ scores, varianceRatio }` — scores as `nObs x k` row-major, and the fraction
 * of TOTAL variance each component explains. The ratio's denominator is the full variance
 * of the centred data, computed while centring, so it is a real fraction and not a share
 * of the components that happen to have been computed.
 */
export function pcaScores(matrix, nObs, nGenes, k, { oversample = 10, power = 2, seed = 0 } = {}) {
  const p = Math.min(nObs, nGenes, k + oversample);
  const { centred, totalVariance } = centreByGene(matrix, nObs, nGenes);

  const normal = gaussians(seed + 1);
  const omega = new Float64Array(nGenes * p);
  for (let i = 0; i < omega.length; i++) omega[i] = normal();

  let Y = mulXB(centred, nObs, nGenes, omega, p);
  orthonormalise(Y, nObs, p);
  // Power iterations sharpen the subspace when the spectrum decays slowly, which is
  // exactly the case for a whole-transcriptome matrix: PC1 here explains 7%, not 70%, so
  // the tail is close behind and a single projection would mix the leading components.
  for (let q = 0; q < power; q++) {
    const Z = mulXtY(centred, nObs, nGenes, Y, p);
    Y = mulXB(centred, nObs, nGenes, Z, p);
    orthonormalise(Y, nObs, p);
  }

  // B = Q^T Xc, then the exact SVD of the tiny B B^T.
  const B = mulXtY(centred, nObs, nGenes, Y, p); // nGenes x p, i.e. B^T
  const C = new Float64Array(p * p);
  for (let j = 0; j < nGenes; j++) {
    const row = j * p;
    for (let s = 0; s < p; s++) {
      const bs = B[row + s];
      if (bs === 0) continue;
      for (let t = s; t < p; t++) C[s * p + t] += bs * B[row + t];
    }
  }
  for (let s = 0; s < p; s++) for (let t = s + 1; t < p; t++) C[t * p + s] = C[s * p + t];

  const { values, vectors } = jacobiEigen(C, p);
  const take = Math.min(k, p);
  const scores = new Float64Array(nObs * take);
  for (let c = 0; c < take; c++) {
    const vec = vectors[c];
    for (let i = 0; i < nObs; i++) {
      let acc = 0;
      for (let t = 0; t < p; t++) acc += Y[i * p + t] * vec[t];
      // U * s: the eigenvalue of B B^T is s^2, so the score is the left singular vector
      // scaled by the singular value — the projection onto that component.
      scores[i * take + c] = acc * Math.sqrt(Math.max(values[c], 0));
    }
  }

  const varianceRatio = values.slice(0, take)
    .map((lambda) => Math.max(lambda, 0) / (nObs - 1) / totalVariance);
  return { scores, varianceRatio, components: take };
}
