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

from anndata_x import dense_matrix, shape_of


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
        n_obs, n_vars = shape_of(f, x)
        matrix = dense_matrix(x, n_obs, n_vars)
        # Overwritten rather than refused: re-running to record the parameters, or with a
        # different neighbours/seed, is a normal thing to want, and the sibling scripts
        # replace their keys too. The published coordinates live under other keys and are
        # never touched.
        if args.key in f["obsm"]:
            print(f"  replacing existing obsm/{args.key}")

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

    note = (f"PCA({comps}) then UMAP, n_neighbors {args.neighbors}, "
            f"min_dist {args.min_dist:g}, seed {args.seed}")
    with h5py.File(args.h5ad, "a") as f:
        if args.key in f["obsm"]:
            del f["obsm"][args.key]
        f["obsm"].create_dataset(args.key, data=np.asarray(embedded, dtype=np.float32))
        # Recorded so the panel can say HOW, not just that it was computed here.
        pkey = f"{args.key}_params"
        if pkey in f["uns"]:
            del f["uns"][pkey]
        f["uns"].create_dataset(pkey, data=np.bytes_(note))
    print(f"  wrote obsm/{args.key} — {note}")


if __name__ == "__main__":
    sys.exit(main())
