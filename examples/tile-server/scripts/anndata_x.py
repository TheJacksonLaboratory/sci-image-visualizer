"""
Reading an AnnData `X` matrix, whichever way round it is stored.

Shared by the converter and the three compute scripts, which all need the same two things
and had drifted into three identical copies of one of them. The reason it is worth a module
rather than a copy each: scanpy writes CSR by default, so a CSC-only reader rejects most
`.h5ad` files in existence, and fixing that in one place is the difference between the
compute scripts working on an arbitrary dataset and working only on the ones already
converted here.

    pip install h5py numpy

Nothing in here is Visium- or dataset-specific, and nothing writes.
"""

import h5py
import numpy as np


def encoding_of(x) -> str:
    """`X`'s storage layout: 'csc_matrix', 'csr_matrix', or '' for a dense array."""
    enc = x.attrs.get("encoding-type", b"") if hasattr(x, "attrs") else ""
    return enc.decode() if isinstance(enc, bytes) else str(enc)


def dense_gene_column(x, n_obs: int, j: int) -> np.ndarray:
    """One gene's values from a CSC matrix, densified.

    CSC stores a column contiguously, which is exactly the access this needs — the
    alternative, CSR, would touch every row to collect one gene.
    """
    lo, hi = int(x["indptr"][j]), int(x["indptr"][j + 1])
    out = np.zeros(n_obs, dtype="<f4")
    if hi > lo:
        out[x["indices"][lo:hi]] = x["data"][lo:hi]
    return out


def csc_from_csr(x, n_obs: int, n_var: int) -> dict[str, np.ndarray]:
    """A CSR matrix's nonzeros re-sorted into column order, in memory.

    A gene is a COLUMN and the callers want columns, so CSR is the wrong way round:
    collecting a single column from it means touching every row, once per gene. Sorting the
    nonzeros by column instead is one pass, and what it produces IS the CSC of the same
    matrix — so no caller needs a second code path.

    The sort must be STABLE. `indices` within a CSR row are ascending in the row's own
    positions, so a stable sort by column leaves each resulting column's row indices
    ascending too, which is what CSC means. An unstable sort would still round-trip through
    `dense_gene_column` (it scatters by index), but the result would no longer be a valid
    CSC for anything else that read it.
    """
    indptr = x["indptr"][:]
    col = x["indices"][:]
    data = x["data"][:]
    # int32 for the row ids: an AnnData with >2^31 observations is not a thing this reads.
    row = np.repeat(np.arange(n_obs, dtype=np.int32), np.diff(indptr))
    order = np.argsort(col, kind="stable")
    counts = np.bincount(col, minlength=n_var)
    out = {
        "indptr": np.concatenate(([0], np.cumsum(counts))),
        "indices": row[order],
        "data": data[order],
    }
    if int(out["indptr"][-1]) != len(data):
        raise SystemExit(f"CSR->CSC lost nonzeros: {int(out['indptr'][-1])} of {len(data)}")

    # Densify a few columns BOTH ways and require them equal, because the failure this
    # guards against is silent: a permutation applied to `indices` but not to `data` writes
    # a full matrix of entirely plausible expression, attributed to the wrong cells. Nothing
    # downstream can detect that, and neither can a nonzero count or a value total — both
    # are preserved by exactly the misalignment in question. Actual columns, compared
    # elementwise, are the only check that distinguishes them.
    rng = np.random.default_rng(0)
    nonempty = np.flatnonzero(counts)
    if len(nonempty) > 0:
        for j in rng.choice(nonempty, min(8, len(nonempty)), replace=False):
            want = np.zeros(n_obs, dtype=np.float64)
            here = col == j
            want[row[here]] = data[here]
            if not np.array_equal(want, dense_gene_column(out, n_obs, int(j)).astype(np.float64)):
                raise SystemExit(f"CSR->CSC misplaced values in column {int(j)}")
    return out


def as_csc(x, n_obs: int, n_var: int):
    """`X` in a form `dense_gene_column` can read, whichever way it was stored."""
    enc = encoding_of(x)
    if enc == "csc_matrix":
        return x
    if enc == "csr_matrix":
        return csc_from_csr(x, n_obs, n_var)
    raise SystemExit(f"X is {enc or 'dense'}; this reads csc_matrix and csr_matrix")


def shape_of(f: h5py.File, x) -> tuple[int, int]:
    """`(n_obs, n_vars)`, from the matrix attrs where present and from obs/var otherwise."""
    if "shape" in getattr(x, "attrs", {}):
        return tuple(int(v) for v in x.attrs["shape"])  # type: ignore[return-value]
    obs, var = f["obs"], f["var"]
    n_obs = obs[obs.attrs.get("_index", "_index")].shape[0]
    n_var = var[var.attrs.get("_index", "_index")].shape[0]
    return int(n_obs), int(n_var)


def dense_matrix(x, n_obs: int, n_vars: int) -> np.ndarray:
    """The whole matrix as `(n_obs, n_vars)` float32.

    What the compute scripts want: PCA, UMAP and t-SNE all need every gene at once. Fine at
    these sizes — a dataset large enough to matter would need chunking, and would want a
    randomized SVD rather than a full one.
    """
    csc = as_csc(x, n_obs, n_vars)
    out = np.zeros((n_obs, n_vars), dtype=np.float32)
    indptr = csc["indptr"]
    indices = csc["indices"]
    data = csc["data"]
    for j in range(n_vars):
        lo, hi = int(indptr[j]), int(indptr[j + 1])
        if hi > lo:
            out[indices[lo:hi], j] = data[lo:hi]
    return out
