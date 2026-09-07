#!/usr/bin/env python3
"""
Convert an AnnData `.h5ad` into a bundle dataset directory this server can serve.

Python rather than Node, unlike the sibling scripts: `.h5ad` is HDF5, and reading it from Node
would mean pulling in a wasm HDF5 reader for a conversion that runs ONCE, offline, and never at
request time. The output is plain binary in the server's wire layout, so nothing downstream knows
or cares which language wrote it.

    pip install h5py numpy
    python3 scripts/h5ad-to-spatial.py --h5ad seqfish.h5ad --out spatial/seqfish \
        --id seqfish --name "Mouse embryo seqFISH (Lohoff et al)" \
        --spatial-key spatial --embedding X_umap:UMAP \
        --column celltype_mapped_refined:categorical --column Area:continuous

Layout written (see lib/spatial.mjs for the reader):

    manifest.json            served verbatim
    coords.bin               f32[N] x, f32[N] y, f32[N] z?   — struct of arrays
    columns/<index>.bin      u16[N] codes (categorical) | f32[N] values (continuous)
    features/matrix.f32      f32[N] per gene, gene-major; ranged-read one gene at a time
    features/names.json      gene names, index-aligned with the matrix
    embeddings/<index>.bin   f32[N] dim0, f32[N] dim1, f32[N] dim2?  — same layout as coords

Files are addressed by their INDEX in the manifest, never by name: `readColumn` and friends look
the name up in the manifest and open `<index>.bin`, so no request string ever reaches the
filesystem. Anything added here has to keep that property.
"""

import argparse
import json
import os
import sys

import h5py
import numpy as np

NO_CATEGORY = 0xFFFF


def _index_key(group: h5py.Group) -> str:
    return group.attrs.get("_index", "_index")


def _decode(values) -> list[str]:
    return [v.decode() if isinstance(v, bytes) else str(v) for v in values]


def categories_for(f: h5py.File, name: str) -> list[str] | None:
    """Category names for an obs column, across both AnnData layouts.

    Modern files put them in `obs/<name>/categories`; older ones (which these squidpy datasets
    are) keep an int8 code array at `obs/<name>` and the names under `obs/__categories/<name>`.
    """
    col = f["obs"][name]
    if isinstance(col, h5py.Group) and "categories" in col:
        return _decode(col["categories"][:])
    legacy = f["obs"].get("__categories")
    if legacy is not None and name in legacy:
        return _decode(legacy[name][:])
    return None


def codes_for(f: h5py.File, name: str) -> np.ndarray:
    col = f["obs"][name]
    raw = col["codes"][:] if isinstance(col, h5py.Group) and "codes" in col else col[:]
    codes = np.asarray(raw).astype(np.int64)
    # A negative code is pandas' "missing"; the wire format says so with NO_CATEGORY, and the
    # client maps anything past the category list to it as well.
    out = np.where(codes < 0, NO_CATEGORY, codes)
    if out.max(initial=0) > NO_CATEGORY:
        raise SystemExit(f"column {name}: more than {NO_CATEGORY} categories")
    return out.astype("<u2")


def dense_gene_column(x: h5py.Group, n_obs: int, j: int) -> np.ndarray:
    """One gene's values from a CSC matrix, densified.

    CSC stores a column contiguously, which is exactly the access this needs — the alternative,
    CSR, would touch every row to collect one gene.
    """
    lo, hi = int(x["indptr"][j]), int(x["indptr"][j + 1])
    out = np.zeros(n_obs, dtype="<f4")
    if hi > lo:
        out[x["indices"][lo:hi]] = x["data"][lo:hi]
    return out


def write_soa(path: str, arr: np.ndarray) -> None:
    """Write an (N, D) array as D contiguous f32 planes — the coords/embedding layout."""
    with open(path, "wb") as fh:
        for d in range(arr.shape[1]):
            fh.write(np.ascontiguousarray(arr[:, d], dtype="<f4").tobytes())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h5ad", required=True)
    ap.add_argument("--out", required=True, help="dataset directory to create")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--spatial-key", default="spatial", help="obsm key holding the coordinates")
    ap.add_argument("--embedding", action="append", default=[],
                    help="obsm key, optionally key:Label (repeatable)")
    ap.add_argument("--column", action="append", default=[],
                    help="obs name:categorical|continuous (repeatable)")
    ap.add_argument("--radius", type=float, default=None,
                    help="uniform marker radius; default is half the mean point spacing")
    ap.add_argument("--derived", action="append", default=[],
                    help="embedding keys computed here rather than published with the dataset")
    args = ap.parse_args()

    with h5py.File(args.h5ad, "r") as f:
        n = f["obs"][_index_key(f["obs"])].shape[0]
        coords = np.asarray(f["obsm"][args.spatial_key][:], dtype=np.float64)
        if coords.shape[0] != n:
            raise SystemExit(f"{args.spatial_key}: {coords.shape[0]} rows for {n} observations")
        dims = coords.shape[1]
        if dims not in (2, 3):
            raise SystemExit(f"{args.spatial_key}: expected 2 or 3 columns, got {dims}")

        os.makedirs(os.path.join(args.out, "columns"), exist_ok=True)
        os.makedirs(os.path.join(args.out, "features"), exist_ok=True)

        write_soa(os.path.join(args.out, "coords.bin"), coords)

        # --- obs columns -----------------------------------------------------
        columns = []
        for spec in args.column:
            name, _, kind = spec.partition(":")
            kind = kind or "continuous"
            idx = len(columns)
            target = os.path.join(args.out, "columns", f"{idx}.bin")
            if kind == "categorical":
                cats = categories_for(f, name)
                if cats is None:
                    raise SystemExit(f"column {name}: no categories found; is it categorical?")
                codes_for(f, name).tofile(target)
                meta = {"kind": "categorical", "name": name, "categories": cats}
                colors = f["uns"].get(f"{name}_colors") if "uns" in f else None
                if colors is not None:
                    # Published colours, so the app matches the paper's figures.
                    meta["colors"] = _decode(colors[:])[: len(cats)]
            else:
                vals = np.asarray(f["obs"][name][:], dtype="<f4")
                vals.tofile(target)
                meta = {"kind": "continuous", "name": name}
            columns.append(meta)

        # --- expression ------------------------------------------------------
        var = f["var"]
        genes = _decode(var[_index_key(var)][:])
        x = f["X"]
        enc = x.attrs.get("encoding-type", b"")
        enc = enc.decode() if isinstance(enc, bytes) else enc
        if enc != "csc_matrix":
            raise SystemExit(f"X is {enc or 'dense'}; this script reads csc_matrix only")
        with open(os.path.join(args.out, "features", "matrix.f32"), "wb") as fh:
            for j in range(len(genes)):
                fh.write(dense_gene_column(x, n, j).tobytes())
        with open(os.path.join(args.out, "features", "names.json"), "w") as fh:
            json.dump(genes, fh)

        # --- embeddings ------------------------------------------------------
        embeddings = []
        if args.embedding:
            os.makedirs(os.path.join(args.out, "embeddings"), exist_ok=True)
        for spec in args.embedding:
            key, _, label = spec.partition(":")
            emb = np.asarray(f["obsm"][key][:], dtype=np.float64)
            if emb.shape[0] != n:
                raise SystemExit(f"{key}: {emb.shape[0]} rows for {n} observations")
            if emb.shape[1] not in (2, 3):
                raise SystemExit(f"{key}: expected 2 or 3 columns, got {emb.shape[1]}")
            idx = len(embeddings)
            write_soa(os.path.join(args.out, "embeddings", f"{idx}.bin"), emb)
            meta = {"name": key, "dims": int(emb.shape[1])}
            if label:
                meta["label"] = label
            if key in args.derived:
                meta["derived"] = True
            embeddings.append(meta)

        # --- manifest --------------------------------------------------------
        if args.radius is not None:
            radius = args.radius
        else:
            extent = coords[:, :2].max(0) - coords[:, :2].min(0)
            radius = float(np.sqrt(extent.prod() / n) / 2)

        manifest = {
            "version": 1,
            "id": args.id,
            "name": args.name,
            "count": int(n),
            "radius": {"mode": "uniform", "value": radius},
            "columns": columns,
            "features": {"count": len(genes), "names": genes},
        }
        if dims == 3:
            manifest["hasZ"] = True
        if embeddings:
            manifest["embeddings"] = embeddings
        # micronsPerUnit is deliberately absent: these coordinates are normalized, not physical,
        # so claiming a micron scale would put a scale bar on the screen that means nothing.
        with open(os.path.join(args.out, "manifest.json"), "w") as fh:
            json.dump(manifest, fh, indent=2)

    print(f"wrote {args.out}: {n} observations, {len(genes)} genes, "
          f"{len(columns)} columns, {len(embeddings)} embeddings, radius {radius:.4f}")


if __name__ == "__main__":
    sys.exit(main())
