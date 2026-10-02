/**
 * Marker genes of cell groups, from a gene-major CSR count matrix in one pass.
 *
 * For every (gene, group) the pass sums log1p(count) and counts the cells expressing it.
 * A gene's score for a group is its mean log1p(count) in the group minus that in all
 * other assigned cells; it qualifies when it is detected in at least MIN_PCT of the group's
 * cells and in a larger share of them than elsewhere. Several groupings are scored in the
 * same pass, since reading the matrix is the expensive part.
 */

export const MIN_PCT = 0.1;
/** Genes kept per group in a stored result; a request takes its top n. */
export const KEEP = 50;
export const NO_CATEGORY = 0xffff;

/**
 * @param groupings  [{ name, codes: Uint16Array (per cell), categories: string[] }]
 * @param geneCount  rows of the gene-major matrix
 * @param geneName   (g) => name
 * @param isReal     (g) => whether gene g is a real gene (not a control probe)
 * @param forEachNonzero  async (visit) => calls visit(gene, cell, count) for every non-zero
 * @returns Map(name → { column, groups: [{ name, cells, genes: [{ name, score, pctIn, pctOut }] }] })
 */
export async function computeMarkers({ groupings, geneCount, geneName, isReal, forEachNonzero }) {
  const offsets = [];
  let width = 0;
  for (const gr of groupings) {
    offsets.push(width);
    width += gr.categories.length;
  }
  const sum = new Float64Array(geneCount * width);
  const nz = new Uint32Array(geneCount * width);
  // Per grouping: cells per group, and the gene's totals over every assigned cell of it.
  const sizes = groupings.map((gr) => {
    const n = new Uint32Array(gr.categories.length);
    for (let c = 0; c < gr.codes.length; c++) if (gr.codes[c] !== NO_CATEGORY && gr.codes[c] < n.length) n[gr.codes[c]]++;
    return n;
  });
  await forEachNonzero((g, cell, count) => {
    if (!isReal(g)) return;
    const v = Math.log1p(count);
    const row = g * width;
    for (let i = 0; i < groupings.length; i++) {
      const k = groupings[i].codes[cell];
      if (k === NO_CATEGORY || k >= groupings[i].categories.length) continue;
      sum[row + offsets[i] + k] += v;
      nz[row + offsets[i] + k]++;
    }
  });

  const out = new Map();
  groupings.forEach((gr, i) => {
    const K = gr.categories.length;
    const n = sizes[i];
    const assigned = n.reduce((a, b) => a + b, 0);
    const groups = gr.categories.map((name, k) => {
      const nIn = n[k];
      const nOut = assigned - nIn;
      const genes = [];
      if (nIn > 0 && nOut > 0) {
        for (let g = 0; g < geneCount; g++) {
          if (!isReal(g)) continue;
          const row = g * width + offsets[i];
          let sumAll = 0;
          let nzAll = 0;
          for (let j = 0; j < K; j++) {
            sumAll += sum[row + j];
            nzAll += nz[row + j];
          }
          const pctIn = nz[row + k] / nIn;
          const pctOut = (nzAll - nz[row + k]) / nOut;
          if (pctIn < MIN_PCT || pctIn <= pctOut) continue;
          const score = sum[row + k] / nIn - (sumAll - sum[row + k]) / nOut;
          if (score > 0) genes.push({ name: geneName(g), score, pctIn, pctOut });
        }
      }
      genes.sort((a, b) => b.score - a.score);
      return { name, cells: nIn, genes: genes.slice(0, KEEP) };
    });
    out.set(gr.name, { column: gr.name, groups });
  });
  return out;
}

/** The top `n` genes per group of a stored result, scores rounded for the wire. */
export function topMarkers(result, n) {
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return {
    column: result.column,
    groups: result.groups.map((g) => ({
      name: g.name, cells: g.cells,
      genes: g.genes.slice(0, n).map((x) => ({ name: x.name, score: r(x.score), pctIn: r(x.pctIn), pctOut: r(x.pctOut) })),
    })),
  };
}
