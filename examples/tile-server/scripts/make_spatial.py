#!/usr/bin/env python3
"""Convert a SpatialData Zarr store into the example server's spatial bundle.

    pip install "spatialdata>=0.2" numpy pandas
    python scripts/make_spatial.py --input visium.zarr --list
    python scripts/make_spatial.py --input visium.zarr --sample ST8059048 --out ../spatial

Get the Visium mouse-brain store with:

    curl -O https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_spatialdata_0.7.1.zip
    unzip visium_spatialdata_0.7.1.zip        # -> data.zarr

WHY THIS RUNS OFFLINE AND NOT IN THE BROWSER
--------------------------------------------
The store is Zarr v3 + AnnData conventions + GeoParquet shapes — three parsers
— and its expression matrix is observation-major (CSR), so reading one gene's
column means touching every row. This script pays that cost once and writes a
GENE-MAJOR matrix, turning a per-gene fetch into a contiguous ranged read. See
../lib/spatial.mjs for the on-disk layout and the library's
`spatial-wire.ts` for the byte format.

STATUS: written against the documented spatialdata API but NOT executed in the
session that produced it (no spatialdata install was available). The
transformation lookup in particular falls back loudly rather than silently, and
`--scale`/`--coordinate-system` let you correct it. Treat the first run as a
verification step, not a formality.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys

import numpy as np


# ── obs column typing ───────────────────────────────────────────────────────

# Numeric obs columns with few distinct values (in_tissue, cluster ids stored as
# ints) read as categories, not as a continuous ramp.
MAX_CATEGORY_CARDINALITY = 64


def classify_columns(obs):
    """Split an AnnData .obs frame into categorical / continuous descriptors."""
    import pandas as pd

    columns = []
    for name in obs.columns:
        series = obs[name]
        if isinstance(series.dtype, pd.CategoricalDtype):
            cats = [str(c) for c in series.cat.categories]
            codes = series.cat.codes.to_numpy()
            columns.append(dict(
                kind="categorical", name=str(name), categories=cats,
                _codes=np.where(codes < 0, 0xFFFF, codes).astype(np.uint16),
            ))
        elif pd.api.types.is_bool_dtype(series):
            columns.append(dict(
                kind="categorical", name=str(name), categories=["False", "True"],
                _codes=series.to_numpy().astype(np.uint16),
            ))
        elif pd.api.types.is_numeric_dtype(series):
            values = series.to_numpy().astype(np.float32)
            finite = values[np.isfinite(values)]
            distinct = np.unique(finite)
            if distinct.size <= MAX_CATEGORY_CARDINALITY and np.all(distinct == np.floor(distinct)):
                cats = [str(int(v)) for v in distinct]
                lookup = {v: i for i, v in enumerate(distinct)}
                codes = np.array([lookup.get(v, 0xFFFF) for v in values], dtype=np.uint16)
                columns.append(dict(
                    kind="categorical", name=str(name), categories=cats, _codes=codes,
                ))
            else:
                columns.append(dict(
                    kind="continuous", name=str(name),
                    logScaleHint=bool(name.endswith("counts")),
                    min=float(finite.min()) if finite.size else 0.0,
                    max=float(finite.max()) if finite.size else 0.0,
                    _values=values,
                ))
        else:
            # Free-text obs (barcodes, file paths) carries no encoding — skip it.
            print(f"  skipping obs column {name!r} (dtype {series.dtype})")
    return columns


# ── coordinates ─────────────────────────────────────────────────────────────

def spot_coordinates(sdata, shapes_key, coordinate_system, scale_override):
    """Spot centroids and radii in the target image's pixel space.

    Returns (x, y, radius_or_none, note) where `note` records how the mapping
    was obtained, so the manifest can be honest about it.
    """
    gdf = sdata.shapes[shapes_key]

    transformed = None
    if scale_override is None:
        try:
            import spatialdata

            transformed = spatialdata.transform(gdf, to_coordinate_system=coordinate_system)
            note = f"spatialdata.transform -> {coordinate_system!r}"
        except Exception as err:  # noqa: BLE001 - any failure falls back loudly
            print(
                f"  ! could not transform shapes to {coordinate_system!r}: {err}\n"
                "    falling back to INTRINSIC coordinates. If spots do not line up with "
                "the image, re-run with --scale <factor> (e.g. the Visium hires "
                "scalefactor) or --coordinate-system <name>.",
                file=sys.stderr,
            )
            note = "intrinsic coordinates (transform unavailable)"
    else:
        note = f"intrinsic coordinates x --scale {scale_override}"

    source = transformed if transformed is not None else gdf
    geometry = source.geometry
    x = geometry.x.to_numpy().astype(np.float32)
    y = geometry.y.to_numpy().astype(np.float32)

    radius = None
    if "radius" in source.columns:
        radius = source["radius"].to_numpy().astype(np.float32)

    if scale_override is not None:
        x = (x * scale_override).astype(np.float32)
        y = (y * scale_override).astype(np.float32)
        if radius is not None:
            radius = (radius * scale_override).astype(np.float32)

    return x, y, radius, note


# ── feature selection ───────────────────────────────────────────────────────

def select_genes(adata, spec):
    """Resolve --genes into a list of var indices, most-expressed first."""
    names = [str(v) for v in adata.var_names]
    if spec == "all":
        return list(range(len(names))), names

    explicit = [g.strip() for g in spec.split(",") if g.strip() and not g.strip().isdigit()]
    if explicit:
        missing = [g for g in explicit if g not in names]
        if missing:
            raise SystemExit(f"genes not found in var_names: {', '.join(missing)}")
        lookup = {n: i for i, n in enumerate(names)}
        idx = [lookup[g] for g in explicit]
        return idx, [names[i] for i in idx]

    top_n = int(spec)
    # Rank by total expression: cheap, deterministic, and keeps the genes that
    # actually render as something other than zeros.
    X = adata.X
    if hasattr(X, "sum"):
        totals = np.asarray(X.sum(axis=0)).ravel()
    else:
        totals = np.asarray(X).sum(axis=0)
    order = np.argsort(totals)[::-1][:top_n]
    order = np.sort(order)
    return list(order), [names[i] for i in order]


def write_gene_major_matrix(adata, gene_indices, out_path, n_obs):
    """Stream X column-by-column into a gene-major float32 file."""
    import scipy.sparse as sp

    X = adata.X
    is_sparse = sp.issparse(X)
    # CSC makes a column slice contiguous; converting once beats slicing CSR
    # once per gene.
    if is_sparse and not sp.isspmatrix_csc(X):
        print("  converting X to CSC for column access (one-time cost)…")
        X = X.tocsc()

    with open(out_path, "wb") as fh:
        for count, gi in enumerate(gene_indices, start=1):
            column = X[:, gi]
            values = (column.toarray().ravel() if is_sparse else np.asarray(column).ravel())
            vector = np.ascontiguousarray(values, dtype=np.float32)
            if vector.size != n_obs:
                raise SystemExit(f"gene column {gi} has {vector.size} values, expected {n_obs}")
            fh.write(vector.tobytes())
            if count % 500 == 0:
                print(f"    {count}/{len(gene_indices)} genes")


# ── polygons ────────────────────────────────────────────────────────────────

RING_VERTICES = 16


def write_spot_polygons(x, y, radius, out_path):
    """Approximate circular spots as rings, in the client's wire layout."""
    n = len(x)
    offsets = (np.arange(n + 1, dtype=np.uint32) * RING_VERTICES)
    angles = np.linspace(0, 2 * math.pi, RING_VERTICES, endpoint=False, dtype=np.float32)
    cos, sin = np.cos(angles), np.sin(angles)
    r = radius if isinstance(radius, np.ndarray) else np.full(n, float(radius), dtype=np.float32)

    coords = np.empty((n, RING_VERTICES, 2), dtype=np.float32)
    coords[:, :, 0] = x[:, None] + cos[None, :] * r[:, None]
    coords[:, :, 1] = y[:, None] + sin[None, :] * r[:, None]

    with open(out_path, "wb") as fh:
        fh.write(np.uint32(n).tobytes())
        fh.write(offsets.tobytes())
        fh.write(coords.ravel().tobytes())


# ── main ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="path to a SpatialData .zarr store")
    ap.add_argument("--out", default="../spatial", help="root output directory")
    ap.add_argument("--id", default=None, help="dataset id (default: the sample key)")
    ap.add_argument("--sample", default=None, help="shapes key to convert (see --list)")
    ap.add_argument("--coordinate-system", default=None, help="target coordinate system")
    ap.add_argument("--scale", type=float, default=None,
                    help="skip the transform and scale intrinsic coords by this factor")
    ap.add_argument("--genes", default="2000",
                    help="'all', a count of top-expressed genes, or a comma-separated list")
    ap.add_argument("--no-polygons", action="store_true", help="skip spot outline geometry")
    ap.add_argument("--list", action="store_true", help="print the store's elements and exit")
    args = ap.parse_args()

    import spatialdata

    print(f"reading {args.input}")
    sdata = spatialdata.read_zarr(args.input)

    if args.list:
        print("images:      ", ", ".join(sdata.images))
        print("shapes:      ", ", ".join(sdata.shapes))
        print("labels:      ", ", ".join(getattr(sdata, "labels", {})))
        print("tables:      ", ", ".join(sdata.tables))
        print("coord systems:", ", ".join(sdata.coordinate_systems))
        return 0

    shapes_key = args.sample or next(iter(sdata.shapes))
    if shapes_key not in sdata.shapes:
        raise SystemExit(f"no shapes element {shapes_key!r}; try --list")
    dataset_id = args.id or shapes_key
    coordinate_system = args.coordinate_system or (
        shapes_key if shapes_key in sdata.coordinate_systems
        else next(iter(sdata.coordinate_systems))
    )

    adata = sdata.tables[next(iter(sdata.tables))]
    # A multi-sample table holds every section; keep the rows for this one.
    region_key = adata.uns.get("spatialdata_attrs", {}).get("region_key")
    if region_key and region_key in adata.obs:
        mask = (adata.obs[region_key].astype(str) == shapes_key).to_numpy()
        if mask.any():
            adata = adata[mask].copy()
            print(f"  {int(mask.sum())} of {len(mask)} table rows belong to {shapes_key!r}")

    x, y, radius, note = spot_coordinates(sdata, shapes_key, coordinate_system, args.scale)
    n_obs = adata.n_obs
    if len(x) != n_obs:
        raise SystemExit(
            f"shapes have {len(x)} spots but the table has {n_obs} rows — "
            "pass --sample to pick one section"
        )
    print(f"  {n_obs} observations, coordinates via {note}")

    out_dir = pathlib.Path(args.out) / dataset_id
    (out_dir / "columns").mkdir(parents=True, exist_ok=True)
    (out_dir / "features").mkdir(parents=True, exist_ok=True)

    # coords.bin — [x f32*N][y f32*N], the client's decode layout verbatim.
    (out_dir / "coords.bin").write_bytes(
        np.ascontiguousarray(x).tobytes() + np.ascontiguousarray(y).tobytes()
    )
    (out_dir / "ids.json").write_text(json.dumps({"ids": [str(v) for v in adata.obs_names]}))

    radius_spec = None
    if radius is not None and radius.size:
        if float(radius.std()) < 1e-6:
            radius_spec = {"mode": "uniform", "value": float(radius[0])}
        else:
            radius_spec = {"mode": "per-observation"}
            (out_dir / "radius.bin").write_bytes(np.ascontiguousarray(radius).tobytes())

    print("  classifying obs columns")
    columns = classify_columns(adata.obs)
    for index, column in enumerate(columns):
        payload = column.pop("_codes", None)
        if payload is None:
            payload = column.pop("_values")
        (out_dir / "columns" / f"{index}.bin").write_bytes(np.ascontiguousarray(payload).tobytes())

    print(f"  selecting genes ({args.genes})")
    gene_indices, gene_names = select_genes(adata, args.genes)
    print(f"  writing {len(gene_names)} genes gene-major "
          f"({len(gene_names) * n_obs * 4 / 1e6:.1f} MB)")
    write_gene_major_matrix(adata, gene_indices, out_dir / "features" / "matrix.f32", n_obs)
    (out_dir / "features" / "names.json").write_text(json.dumps(gene_names))

    polygons = None
    if not args.no_polygons and radius is not None and radius.size:
        write_spot_polygons(x, y, radius, out_dir / "polygons.bin")
        polygons = {"count": int(n_obs)}

    manifest = {
        "version": 1,
        "id": dataset_id,
        "name": f"{dataset_id} ({pathlib.Path(args.input).name})",
        "count": int(n_obs),
        "hasIds": True,
        "columns": columns,
        "features": {
            "count": len(gene_names),
            # Inline the names only when the list is small enough that shipping
            # it beats a /features round-trip per keystroke.
            **({"names": gene_names} if len(gene_names) <= 2000 else {}),
            "logScaleHint": True,
        },
        "imageRef": {"scale": [1, 1], "translate": [0, 0], "_note": note},
    }
    if radius_spec:
        manifest["radius"] = radius_spec
    if polygons:
        manifest["polygons"] = polygons
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    print(f"wrote {out_dir}")
    print(f"  serve it with: SPATIAL_DIR={pathlib.Path(args.out).resolve()} npm start")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
