import {
  NEIGHBOUR_FACTOR, affinities, conditionalAffinities, knnGraph, plainRepulsion, tsneEmbed,
} from './tsne';

/**
 * t-SNE's coordinates have no right answer — the objective is non-convex, the start is
 * random, and the result is defined only up to rotation — so comparing against a stored
 * embedding would test nothing. These check the parts that DO have one.
 */

/** Planted clusters in high dimensions: the embedding should recover them. */
function clustered(perCluster: number, nClusters: number, nDims: number, spread = 0.35) {
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const n = perCluster * nClusters;
  const x = new Float32Array(n * nDims);
  const label = new Int32Array(n);
  const centres = Array.from({ length: nClusters }, () => (
    Array.from({ length: nDims }, () => rnd() * 8 - 4)
  ));
  for (let i = 0; i < n; i++) {
    const c = Math.floor(i / perCluster);
    label[i] = c;
    for (let d = 0; d < nDims; d++) x[i * nDims + d] = centres[c][d] + (rnd() - 0.5) * spread;
  }
  return { x, label, n };
}

describe('knnGraph', () => {
  it('matches brute force exactly', () => {
    // The graph is exact, so it either agrees or it is wrong — no tolerance to argue over.
    const { x, n } = clustered(20, 3, 6);
    const k = 8;
    const graph = knnGraph(x, n, 6, k);
    for (const probe of [0, 17, 42]) {
      const all: Array<[number, number]> = [];
      for (let j = 0; j < n; j++) {
        if (j === probe) continue;
        let d = 0;
        for (let t = 0; t < 6; t++) {
          const delta = x[probe * 6 + t] - x[j * 6 + t];
          d += delta * delta;
        }
        all.push([d, j]);
      }
      all.sort((a, b) => a[0] - b[0]);
      const truth = new Set(all.slice(0, k).map((e) => e[1]));
      const got = new Set(Array.from(graph.indices.subarray(probe * k, probe * k + k)));
      expect([...got].sort()).toEqual([...truth].sort());
    }
  });

  it('never includes a point as its own neighbour', () => {
    const { x, n } = clustered(10, 2, 4);
    const k = 5;
    const graph = knnGraph(x, n, 4, k);
    for (let i = 0; i < n; i++) {
      expect(Array.from(graph.indices.subarray(i * k, i * k + k))).not.toContain(i);
    }
  });
});

describe('conditionalAffinities', () => {
  const { x, n } = clustered(40, 3, 8);
  const k = 30;
  const graph = knnGraph(x, n, 8, k);

  it.each([5, 10, 20])('calibrates every row to perplexity %i', (target) => {
    // The definition: the entropy of each row must be log(perplexity). This is the only
    // check that sees the bisection at all — a version with the bandwidth fixed at 1
    // still produced 90.7% neighbourhood purity, because separated clusters do not care.
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
    expect(worst).toBeLessThan(0.02);
  });

  it('gives every row a distribution summing to one', () => {
    const cond = conditionalAffinities(graph, n, 10);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let t = 0; t < k; t++) sum += cond[i * k + t];
      expect(sum).toBeCloseTo(1, 6);
    }
  });
});

describe('affinities', () => {
  it('is symmetric and sums to one', () => {
    // P is a joint distribution over pairs; if it does not sum to 1 the gradient is
    // scaled wrongly and the learning rate silently means something else.
    const { x, n } = clustered(15, 3, 5);
    const graph = knnGraph(x, n, 5, 10);
    const { rowPtr, colIdx, val } = affinities(graph, n, 4);
    let total = 0;
    const lookup = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      for (let e = rowPtr[i]; e < rowPtr[i + 1]; e++) {
        total += val[e];
        lookup.set(`${i}:${colIdx[e]}`, val[e]);
      }
    }
    expect(total).toBeCloseTo(1, 5);
    for (const [key, v] of lookup) {
      const [i, j] = key.split(':');
      expect(lookup.get(`${j}:${i}`)).toBeCloseTo(v, 12);
    }
  });
});

describe('tsneEmbed', () => {
  const nDims = 10;
  const { x, label, n } = clustered(40, 4, nDims);

  it('separates planted clusters', async () => {
    const { embedding, completed } = await tsneEmbed(x, n, nDims, {
      dims: 2, perplexity: 12, iterations: 300, seed: 0,
    });
    expect(completed).toBe(true);

    // Neighbourhood preservation is the property the plot is READ for, and the only
    // meaningful check on the geometry.
    const K = 10;
    let same = 0;
    for (let i = 0; i < n; i++) {
      const d: Array<[number, number]> = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = embedding[i * 2] - embedding[j * 2];
        const dy = embedding[i * 2 + 1] - embedding[j * 2 + 1];
        d.push([dx * dx + dy * dy, j]);
      }
      d.sort((a, b) => a[0] - b[0]);
      for (let t = 0; t < K; t++) if (label[d[t][1]] === label[i]) same++;
    }
    expect(same / (n * K)).toBeGreaterThan(0.9);
  });

  it('spreads, rather than collapsing to a point', async () => {
    // A collapsed embedding scores perfectly on purity while showing nothing, because
    // every point is everyone's neighbour.
    const { embedding } = await tsneEmbed(x, n, nDims, {
      dims: 2, perplexity: 12, iterations: 200, seed: 0,
    });
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      min = Math.min(min, embedding[i * 2]);
      max = Math.max(max, embedding[i * 2]);
    }
    expect(max - min).toBeGreaterThan(1);
  });

  it('reports progress and can be stopped part-way', async () => {
    const seen: number[] = [];
    const result = await tsneEmbed(x, n, nDims, {
      dims: 2, perplexity: 12, iterations: 500, seed: 0,
      onProgress: (done) => seen.push(done),
      // A long run must be abandonable: this is what a Cancel button rides on.
      shouldStop: () => seen.length >= 3,
    });
    expect(result.completed).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(50);
    expect(Array.from(result.embedding).every(Number.isFinite)).toBe(true);
  });

  it('is deterministic for a given seed, and different for another', async () => {
    const opts = { dims: 2 as const, perplexity: 8, iterations: 60 };
    const a = await tsneEmbed(x, n, nDims, { ...opts, seed: 1 });
    const b = await tsneEmbed(x, n, nDims, { ...opts, seed: 1 });
    const c = await tsneEmbed(x, n, nDims, { ...opts, seed: 2 });
    expect(Array.from(a.embedding)).toEqual(Array.from(b.embedding));
    expect(Array.from(a.embedding)).not.toEqual(Array.from(c.embedding));
  });

  it('caps the neighbourhood at what the dataset can supply', async () => {
    // Perplexity is calibrated over the neighbours kept, so asking for more than exist
    // must lower the perplexity rather than silently calibrate against nothing.
    const tiny = clustered(4, 2, 3);
    const r = await tsneEmbed(tiny.x, tiny.n, 3, {
      dims: 2, perplexity: 50, iterations: 20, seed: 0,
    });
    expect(r.neighbours).toBe(tiny.n - 1);
    expect(r.perplexity).toBeLessThanOrEqual(Math.floor((tiny.n - 1) / NEIGHBOUR_FACTOR));
  });

  it('uses the repulsion it is given', async () => {
    // The GPU backend is swapped in exactly here, so the seam has to be real.
    let calls = 0;
    const counting = {
      compute: async (y: Float64Array, nObs: number, dims: number) => {
        calls++;
        return plainRepulsion.compute(y, nObs, dims);
      },
    };
    await tsneEmbed(x, n, nDims, {
      dims: 2, perplexity: 8, iterations: 12, seed: 0, repulsion: counting,
    });
    expect(calls).toBe(12);
  });
});
