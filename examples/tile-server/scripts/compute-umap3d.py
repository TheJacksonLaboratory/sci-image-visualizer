#!/usr/bin/env python3
"""
Compute a 3-D UMAP for an `.h5ad` and write it back as a new `obsm` key.

Why this exists: every embedding published with a spatial dataset is 2-D, because a UMAP is made
to be looked at. A 3-D one therefore has to be computed, and the manifest marks it `derived` so a
reader knows it is not the published picture — a UMAP recomputed with different parameters is a
different picture, and someone comparing against a paper's figure has to be told.

    pip install umap-learn h5py numpy
    python3 scripts/compute-umap3d.py --h5ad seqfish.h5ad --key X_umap3d

Reads the expression matrix (CSC), reduces with PCA first as scanpy's workflow does — UMAP on raw
counts chases noise — then runs UMAP with `n_components=3`. Writes into the file in place, so the
existing 2-D `X_umap` stays and both can be offered.
"""

import argparse
import sys

import h5py
import numpy as np


def dense_from_csc(x: h5py.Group, n_obs: int, n_vars: int) -> np.ndarray:
    """Densify a CSC matrix. Fine at these sizes; a bigger one would need chunking."""
    out = np.zeros((n_obs, n_vars), dtype=np.float32)
    indptr = x["indptr"][:]
    indices = x["indices"][:]
    data = x["data"][:]
    for j in range(n_vars):
        lo, hi = int(indptr[j]), int(indptr[j + 1])
        if hi > lo:
            out[indices[lo:hi], j] = data[lo:hi]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h5ad", required=True)
    ap.add_argument("--key", default="X_umap3d", help="obsm key to write")
    ap.add_argument("--pcs", type=int, default=50, help="PCA components before UMAP")
    ap.add_argument("--neighbors", type=int, default=15)
    ap.add_argument("--min-dist", type=float, default=0.3)
    ap.add_argument("--seed", type=int, default=0, help="fixed, so the picture is reproducible")
    args = ap.parse_args()

    import umap  # imported late: it pulls numba, which is slow to load

    with h5py.File(args.h5ad, "r") as f:
        x = f["X"]
        enc = x.attrs.get("encoding-type", b"")
        enc = enc.decode() if isinstance(enc, bytes) else enc
        if enc != "csc_matrix":
            raise SystemExit(f"X is {enc or 'dense'}; this script reads csc_matrix only")
        n_obs, n_vars = (int(v) for v in x.attrs["shape"])
        matrix = dense_from_csc(x, n_obs, n_vars)
        if args.key in f["obsm"]:
            raise SystemExit(f"obsm/{args.key} already exists; pick another --key")

    print(f"  matrix {matrix.shape}")
    # PCA first, as the standard workflow does: UMAP straight off the genes follows noise.
    centred = matrix - matrix.mean(axis=0, keepdims=True)
    comps = min(args.pcs, min(centred.shape) - 1)
    _, _, vt = np.linalg.svd(centred, full_matrices=False)
    reduced = centred @ vt[:comps].T
    print(f"  reduced to {reduced.shape} by PCA")

    embedded = umap.UMAP(
        n_components=3,
        n_neighbors=args.neighbors,
        min_dist=args.min_dist,
        random_state=args.seed,
    ).fit_transform(reduced)
    print(f"  embedded {embedded.shape}, "
          f"extent {np.round(embedded.max(0) - embedded.min(0), 2)}")

    with h5py.File(args.h5ad, "a") as f:
        f["obsm"].create_dataset(args.key, data=np.asarray(embedded, dtype=np.float32))
    print(f"  wrote obsm/{args.key} into {args.h5ad}")


if __name__ == "__main__":
    sys.exit(main())
