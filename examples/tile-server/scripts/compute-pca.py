#!/usr/bin/env python3
"""
Compute PCA coordinates for an `.h5ad` and write them back, WITH the variance each axis explains.

PCA earns its place beside a UMAP precisely because its axes mean something. They are ordered, and
each explains a measurable share of the total variance — "PC1 (23.4%)" is a statement a reader can
act on, where "UMAP 1" is not, because a UMAP's coordinates are an arbitrary output of an
optimisation. So the variance ratios are computed here and carried through to the axis labels; a
PCA served without them would just be a worse UMAP.

    pip install h5py numpy
    python3 scripts/compute-pca.py --h5ad seqfish.h5ad

Writes `obsm/X_pca` (PC1-2) and `obsm/X_pca3d` (PC1-3) so the same coordinates can be read as a
plane or a cloud, plus `uns/<key>_variance_ratio` for each, which the bundle converter picks up.

Deterministic up to a sign flip per component, unlike UMAP: the same input always gives the same
picture, so there is no seed to fix.
"""

import argparse
import sys

import h5py
import numpy as np

from anndata_x import dense_matrix, shape_of


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h5ad", required=True)
    ap.add_argument("--key2d", default="X_pca")
    ap.add_argument("--key3d", default="X_pca3d")
    args = ap.parse_args()

    with h5py.File(args.h5ad, "r") as f:
        x = f["X"]
        n_obs, n_vars = shape_of(f, x)
        matrix = dense_matrix(x, n_obs, n_vars)

    print(f"  matrix {matrix.shape}")
    centred = matrix - matrix.mean(axis=0, keepdims=True)
    # Singular values give the variance per component directly: var_i = s_i^2 / (n - 1), and
    # the ratio is that over the total variance of the centred data.
    _, s, vt = np.linalg.svd(centred, full_matrices=False)
    variance = (s ** 2) / (centred.shape[0] - 1)
    ratios = variance / variance.sum()
    scores = centred @ vt[:3].T
    print("  variance explained: " + ", ".join(
        f"PC{i + 1} {ratios[i] * 100:.1f}%" for i in range(3)))
    print(f"  first three components account for {ratios[:3].sum() * 100:.1f}% in total")

    with h5py.File(args.h5ad, "a") as f:
        for key, dims in ((args.key2d, 2), (args.key3d, 3)):
            if key in f["obsm"]:
                del f["obsm"][key]
            f["obsm"].create_dataset(key, data=np.ascontiguousarray(scores[:, :dims], dtype=np.float32))
            pkey = f"{key}_params"
            if pkey in f["uns"]:
                del f["uns"][pkey]
            # PCA is deterministic up to a sign flip, so there is no seed to record —
            # only what it was run on.
            f["uns"].create_dataset(pkey, data=np.bytes_("centred expression, exact SVD"))
            name = f"{key}_variance_ratio"
            if name in f["uns"]:
                del f["uns"][name]
            f["uns"].create_dataset(name, data=np.asarray(ratios[:dims], dtype=np.float64))
            print(f"  wrote obsm/{key} ({dims}D) and uns/{name}")


if __name__ == "__main__":
    sys.exit(main())
