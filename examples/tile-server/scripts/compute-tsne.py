#!/usr/bin/env python3
"""
Compute t-SNE coordinates for an `.h5ad` and write them back as new `obsm` keys.

Like a UMAP and unlike a PCA, t-SNE's axes carry NO meaning: they are unordered, unitless, and
reproducible only up to a rotation, so no variance ratio is written for them and the axis labels
stay bare. Claiming a percentage there would be an invention.

Worth having alongside UMAP rather than instead of it. Both preserve local neighbourhoods, but
t-SNE is the stricter of the two about it and the less trustworthy about anything global: it tends
to spread clusters into evenly-sized islands whose separations mean little, where UMAP retains a
little more of the large-scale arrangement. Two views that disagree are informative — a structure
both agree on is more likely real than one only one of them shows.

    pip install scikit-learn h5py numpy
    python3 scripts/compute-tsne.py --h5ad seqfish.h5ad

PCA first, as with the UMAP script: t-SNE straight off the genes chases noise, and the standard
workflow reduces to ~50 components first. A fixed seed, since t-SNE is stochastic.
"""

import argparse
import sys

import h5py
import numpy as np

from anndata_x import dense_matrix, shape_of


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h5ad", required=True)
    ap.add_argument("--key2d", default="X_tsne")
    ap.add_argument("--key3d", default="X_tsne3d")
    ap.add_argument("--pcs", type=int, default=50)
    ap.add_argument("--perplexity", type=float, default=30.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dims", default="2,3", help="which embeddings to compute")
    args = ap.parse_args()

    from sklearn.manifold import TSNE

    with h5py.File(args.h5ad, "r") as f:
        x = f["X"]
        n_obs, n_vars = shape_of(f, x)
        matrix = dense_matrix(x, n_obs, n_vars)

    print(f"  matrix {matrix.shape}")
    centred = matrix - matrix.mean(axis=0, keepdims=True)
    comps = min(args.pcs, min(centred.shape) - 1)
    _, _, vt = np.linalg.svd(centred, full_matrices=False)
    reduced = np.ascontiguousarray(centred @ vt[:comps].T)
    print(f"  reduced to {reduced.shape} by PCA")

    wanted = [int(d) for d in args.dims.split(",") if d.strip()]
    for dims in wanted:
        key = args.key2d if dims == 2 else args.key3d
        print(f"  running t-SNE for {dims}D (perplexity {args.perplexity:g})…")
        embedded = TSNE(
            n_components=dims,
            perplexity=args.perplexity,
            init="pca",  # more stable and faster to converge than random
            random_state=args.seed,
        ).fit_transform(reduced)
        extent = np.round(embedded.max(0) - embedded.min(0), 2)
        print(f"    embedded {embedded.shape}, extent {extent}")
        note = (f"PCA({comps}) then t-SNE, perplexity {args.perplexity:g}, "
                f"seed {args.seed}")
        with h5py.File(args.h5ad, "a") as f:
            if key in f["obsm"]:
                del f["obsm"][key]
            f["obsm"].create_dataset(key, data=np.asarray(embedded, dtype=np.float32))
            # Recorded so the panel can say HOW, not just that it was computed here.
            pkey = f"{key}_params"
            if pkey in f["uns"]:
                del f["uns"][pkey]
            f["uns"].create_dataset(pkey, data=np.bytes_(note))
        print(f"    wrote obsm/{key} — {note}")

    # Deliberately NO `uns/<key>_variance_ratio`: t-SNE has no variance per axis to report,
    # and the converter only labels axes when a ratio is actually there.


if __name__ == "__main__":
    sys.exit(main())
