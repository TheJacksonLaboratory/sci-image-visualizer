// Reading an AnnData `.h5ad` from Node — the replacement for the Python `anndata_x.py`.
//
// `.h5ad` is HDF5, which Node cannot read natively, so this leans on `h5wasm` (libhdf5
// compiled to wasm). Its node entrypoint reads host paths directly, so a 329 MB file is
// not copied into a virtual filesystem first.
//
// Everything here is READ-ONLY. Nothing writes back into the `.h5ad`, which is the main
// structural difference from the Python it replaces: the compute scripts now append to a
// bundle instead of round-tripping through HDF5, so the only thing that needs this module
// is the converter.

import * as h5wasm from 'h5wasm/node';

/** h5wasm reports shapes and int64 attrs as BigInt; every caller wants numbers. */
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

/** Open a `.h5ad` for reading. The caller closes it. */
export async function openH5ad(file) {
  await h5wasm.ready;
  return new h5wasm.File(file, 'r');
}

/** An attribute's value, or `undefined` when absent. */
export function attr(node, name) {
  const a = node?.attrs?.[name];
  return a === undefined ? undefined : a.value;
}

/** The `_index` dataset name a group uses for its labels. */
export function indexKey(group) {
  return attr(group, '_index') ?? '_index';
}

/** `X`'s storage layout: 'csc_matrix', 'csr_matrix', or '' for a dense array. */
export function encodingOf(x) {
  return String(attr(x, 'encoding-type') ?? '');
}

/** `[nObs, nVars]`, from the matrix attrs where present and from obs/var otherwise. */
export function shapeOf(f) {
  const x = f.get('X');
  const shape = attr(x, 'shape');
  if (shape) return Array.from(shape, num);
  const obs = f.get('obs');
  const varg = f.get('var');
  return [
    num(f.get(`obs/${indexKey(obs)}`).shape[0]),
    num(f.get(`var/${indexKey(varg)}`).shape[0]),
  ];
}

/**
 * `X` as CSC: `{ indptr, indices, data }`, whichever way it was stored.
 *
 * A gene is a COLUMN and every caller here wants columns, so CSR is the wrong way round —
 * reading one column from it means touching every row, once per gene.
 *
 * The transpose is a COUNTING SORT rather than an argsort: bucket the nonzeros by column,
 * prefix-sum the counts into the new `indptr`, then place each entry. That is O(nnz) with
 * no comparison sort over 15 million elements, and it is stable by construction — walking
 * the CSR in row order means each destination column receives its rows already ascending,
 * which is what makes the result a valid CSC rather than merely one this file can read.
 */
export function asCsc(f, nObs, nVar) {
  const x = f.get('X');
  const enc = encodingOf(x);
  if (enc === 'csc_matrix') {
    return {
      indptr: f.get('X/indptr').value,
      indices: f.get('X/indices').value,
      data: f.get('X/data').value,
    };
  }
  if (enc !== 'csr_matrix') {
    throw new Error(`X is ${enc || 'dense'}; this reads csc_matrix and csr_matrix`);
  }

  const rowPtr = f.get('X/indptr').value;
  const col = f.get('X/indices').value;
  const data = f.get('X/data').value;
  const nnz = data.length;

  const counts = new Int32Array(nVar);
  for (let k = 0; k < nnz; k++) counts[col[k]]++;
  const indptr = new Int32Array(nVar + 1);
  for (let j = 0; j < nVar; j++) indptr[j + 1] = indptr[j] + counts[j];

  const cursor = Int32Array.from(indptr.subarray(0, nVar));
  const indices = new Int32Array(nnz);
  const values = new Float32Array(nnz);
  for (let i = 0; i < nObs; i++) {
    const from = num(rowPtr[i]);
    const to = num(rowPtr[i + 1]);
    for (let k = from; k < to; k++) {
      const p = cursor[col[k]]++;
      indices[p] = i;
      values[p] = data[k];
    }
  }

  if (indptr[nVar] !== nnz) {
    throw new Error(`CSR->CSC lost nonzeros: ${indptr[nVar]} of ${nnz}`);
  }
  // Densify a few columns BOTH ways and require them equal, because the failure this
  // guards against is silent: a value placed under the wrong row writes a full matrix of
  // entirely plausible expression attributed to the wrong cells. Neither a nonzero count
  // nor a value total can detect that — both survive exactly that misalignment.
  verifyCsc({ indptr, indices, data: values }, { rowPtr, col, data }, nObs, nVar);
  return { indptr, indices, data: values };
}

/** Spot-check the transpose against the source it came from. */
function verifyCsc(csc, csr, nObs, nVar) {
  const probes = [];
  for (let j = 0; j < nVar && probes.length < 8; j += Math.max(1, Math.floor(nVar / 8))) {
    if (csc.indptr[j + 1] > csc.indptr[j]) probes.push(j);
  }
  for (const j of probes) {
    const want = new Float64Array(nObs);
    for (let i = 0; i < nObs; i++) {
      const from = num(csr.rowPtr[i]);
      const to = num(csr.rowPtr[i + 1]);
      for (let k = from; k < to; k++) if (csr.col[k] === j) want[i] = csr.data[k];
    }
    const got = denseColumn(csc, nObs, j);
    for (let i = 0; i < nObs; i++) {
      if (Math.abs(want[i] - got[i]) > 1e-6) {
        throw new Error(`CSR->CSC misplaced values in column ${j}`);
      }
    }
  }
}

/** One gene's values from a CSC matrix, densified. */
export function denseColumn(csc, nObs, j) {
  const out = new Float32Array(nObs);
  const from = num(csc.indptr[j]);
  const to = num(csc.indptr[j + 1]);
  for (let k = from; k < to; k++) out[num(csc.indices[k])] = csc.data[k];
  return out;
}

/**
 * Category names for an obs column, across both AnnData layouts.
 *
 * Modern files put them in `obs/<name>/categories`; older ones (which the squidpy datasets
 * are) keep an int8 code array at `obs/<name>` and the names under `obs/__categories`.
 */
export function categoriesFor(f, name) {
  const col = f.get(`obs/${name}`);
  if (col?.type === 'Group' && col.keys().includes('categories')) {
    return Array.from(f.get(`obs/${name}/categories`).value, String);
  }
  const legacy = f.get('obs/__categories');
  if (legacy?.keys?.().includes(name)) {
    return Array.from(f.get(`obs/__categories/${name}`).value, String);
  }
  return null;
}

/** Per-observation category codes, with pandas' negative "missing" mapped to NO_CATEGORY. */
export const NO_CATEGORY = 0xffff;

export function codesFor(f, name) {
  const col = f.get(`obs/${name}`);
  const raw = col?.type === 'Group' && col.keys().includes('codes')
    ? f.get(`obs/${name}/codes`).value
    : col.value;
  const out = new Uint16Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = num(raw[i]);
    if (v < 0) { out[i] = NO_CATEGORY; continue; }
    if (v > NO_CATEGORY) throw new Error(`column ${name}: more than ${NO_CATEGORY} categories`);
    out[i] = v;
  }
  return out;
}

/** A continuous obs column as f32. */
export function continuousFor(f, name) {
  return Float32Array.from(f.get(`obs/${name}`).value, num);
}

/** An `obsm` array as `{ rows, dims, at(i, d) }` without copying it row-major. */
export function obsmArray(f, key) {
  const node = f.get(`obsm/${key}`);
  if (!node) throw new Error(`no obsm/${key}`);
  const [rows, dims] = node.shape.map(num);
  const flat = node.value;
  return { rows, dims, flat };
}

/** Gene names, in matrix-column order. */
export function geneNames(f) {
  const varg = f.get('var');
  return Array.from(f.get(`var/${indexKey(varg)}`).value, String);
}

/** Observation count from the obs index. */
export function obsCount(f) {
  const obs = f.get('obs');
  return num(f.get(`obs/${indexKey(obs)}`).shape[0]);
}

/** A `uns` entry's value, or undefined. Used for published palettes. */
export function unsValue(f, key) {
  const uns = f.get('uns');
  if (!uns?.keys?.().includes(key)) return undefined;
  return f.get(`uns/${key}`).value;
}
