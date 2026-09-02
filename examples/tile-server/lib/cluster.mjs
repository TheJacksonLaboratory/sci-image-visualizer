// k-means clustering over an expression matrix, so a converted dataset has a
// meaningful categorical column to group and colour by.
//
// WHY THIS IS HERE AT ALL
// -----------------------
// The scverse sandbox stores are RAW: their tables carry ids, array indices and
// `in_tissue` and nothing else. There is no cluster or cell-type annotation to
// show, so a viewer demo built on them has nothing to put in a legend, split a
// violin by, or select a category of. Every spatial analysis starts by
// clustering; doing it once in the build step is what makes the rest
// demonstrable.
//
// This is a DEMO-DATA convenience, not an analysis tool: fixed seed, Lloyd's
// algorithm, no graph-based clustering. Real work belongs in scanpy/squidpy, and
// the column it writes says so in its description.

/** Deterministic PRNG (mulberry32) so a rebuild yields identical clusters. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scanpy's standard opening move: normalise each observation to a common total,
 * then `log1p`. Without it, clustering follows sequencing depth rather than
 * biology — the clusters come out as concentric count bands.
 */
function normalise(matrix, geneCount, n, target = 1e4) {
  const out = new Float32Array(matrix.length);
  const totals = new Float64Array(n);
  for (let g = 0; g < geneCount; g++) {
    const base = g * n;
    for (let i = 0; i < n; i++) totals[i] += matrix[base + i];
  }
  for (let g = 0; g < geneCount; g++) {
    const base = g * n;
    for (let i = 0; i < n; i++) {
      const scale = totals[i] > 0 ? target / totals[i] : 0;
      out[base + i] = Math.log1p(matrix[base + i] * scale);
    }
  }
  return out;
}

/** Indices of the `count` most variable genes — the usual dimensionality cut. */
function highlyVariable(normalised, geneCount, n, count) {
  const score = new Float64Array(geneCount);
  for (let g = 0; g < geneCount; g++) {
    const base = g * n;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += normalised[base + i];
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) {
      const d = normalised[base + i] - mean;
      varSum += d * d;
    }
    score[g] = varSum / n;
  }
  return Array.from(score.keys())
    .sort((a, b) => score[b] - score[a])
    .slice(0, Math.min(count, geneCount));
}

/** k-means++ seeding: spread the initial centroids instead of clumping them. */
function seedCentroids(features, dims, n, k, rand) {
  const centroids = new Float32Array(k * dims);
  const first = Math.floor(rand() * n);
  for (let d = 0; d < dims; d++) centroids[d] = features[first * dims + d];

  const best = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let dist = 0;
      for (let d = 0; d < dims; d++) {
        const diff = features[i * dims + d] - centroids[(c - 1) * dims + d];
        dist += diff * diff;
      }
      if (dist < best[i]) best[i] = dist;
      total += best[i];
    }
    // Pick the next centroid with probability proportional to D².
    let target = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= best[i];
      if (target <= 0) { pick = i; break; }
    }
    for (let d = 0; d < dims; d++) centroids[c * dims + d] = features[pick * dims + d];
  }
  return centroids;
}

function assign(features, dims, n, centroids, k, labels) {
  let moved = 0;
  for (let i = 0; i < n; i++) {
    let bestC = 0;
    let bestD = Infinity;
    for (let c = 0; c < k; c++) {
      let dist = 0;
      for (let d = 0; d < dims; d++) {
        const diff = features[i * dims + d] - centroids[c * dims + d];
        dist += diff * diff;
        if (dist >= bestD) break; // early out: most candidates lose quickly
      }
      if (dist < bestD) { bestD = dist; bestC = c; }
    }
    if (labels[i] !== bestC) moved++;
    labels[i] = bestC;
  }
  return moved;
}

/**
 * Cluster observations from a GENE-MAJOR matrix (`gene * n + obs`).
 *
 * Centroids are fitted on an even subsample when the dataset is large — 84k
 * cells x k x dims x iterations is minutes in plain JS, and a few thousand
 * observations locate the same centroids — then every observation is assigned.
 *
 * Returns per-observation labels, ordered so cluster 0 is the largest (stable,
 * readable legends) .
 */
export function kmeansClusters(matrix, geneCount, n, {
  k = 8,
  maxGenes = 50,
  maxFitPoints = 20_000,
  iterations = 25,
  seed = 20260902,
} = {}) {
  if (n === 0 || geneCount === 0) return new Uint16Array(n);
  const clusters = Math.max(2, Math.min(k, n));
  const rand = rng(seed);

  const normalised = normalise(matrix, geneCount, n);
  const genes = highlyVariable(normalised, geneCount, n, maxGenes);
  const dims = genes.length;

  // Observation-major features, so a distance loop walks contiguous memory.
  const features = new Float32Array(n * dims);
  for (let d = 0; d < dims; d++) {
    const base = genes[d] * n;
    for (let i = 0; i < n; i++) features[i * dims + d] = normalised[base + i];
  }

  const fitStep = Math.max(1, Math.floor(n / maxFitPoints));
  const fitCount = Math.floor((n + fitStep - 1) / fitStep);
  const fit = fitStep === 1 ? features : new Float32Array(fitCount * dims);
  if (fitStep !== 1) {
    for (let i = 0, at = 0; i < n; i += fitStep, at++) {
      fit.set(features.subarray(i * dims, (i + 1) * dims), at * dims);
    }
  }

  const centroids = seedCentroids(fit, dims, fitCount, clusters, rand);
  const fitLabels = new Uint16Array(fitCount).fill(0xffff);
  for (let it = 0; it < iterations; it++) {
    const moved = assign(fit, dims, fitCount, centroids, clusters, fitLabels);
    const sums = new Float64Array(clusters * dims);
    const counts = new Uint32Array(clusters);
    for (let i = 0; i < fitCount; i++) {
      const c = fitLabels[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) sums[c * dims + d] += fit[i * dims + d];
    }
    for (let c = 0; c < clusters; c++) {
      if (counts[c] === 0) continue; // keep an empty cluster's last position
      for (let d = 0; d < dims; d++) centroids[c * dims + d] = sums[c * dims + d] / counts[c];
    }
    if (moved === 0) break; // converged
  }

  const labels = new Uint16Array(n);
  assign(features, dims, n, centroids, clusters, labels);

  // Relabel largest-first: cluster numbering is otherwise an artefact of
  // seeding, and a legend ordered by size reads far better.
  const sizes = new Uint32Array(clusters);
  for (const c of labels) sizes[c]++;
  const order = Array.from(sizes.keys()).sort((a, b) => sizes[b] - sizes[a]);
  const remap = new Uint16Array(clusters);
  order.forEach((oldC, newC) => { remap[oldC] = newC; });
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];

  return labels;
}
