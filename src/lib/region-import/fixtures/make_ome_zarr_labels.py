"""Fixtures for ome-zarr-labels.spec.ts: an OME-Zarr image with one label image, written by the
ome-zarr package itself. The labels are uint32, (z 3, y 6, x 8), chunked (1, 4, 4) so a slice
spans several chunks and edge chunks are partial; label (z, y, x) = 1 + x // 3 + 10 * (y // 3)
except 70000 on slice 2's last row (an id past 16 bits) and 0 (background) on slice 0's first
column. Colours and names for labels 1 and 70000 are in its image-label metadata.

    uv run --no-project --with 'ome-zarr<0.10' --with 'zarr<3' python make_ome_zarr_labels.py v04
    uv run --no-project --with 'ome-zarr>=0.11' --with 'zarr>=3' python make_ome_zarr_labels.py v05

v04: OME-Zarr 0.4 on zarr v2, Blosc lz4 with byte shuffle (zarr v2's default compressor).
v05: OME-Zarr 0.5 on zarr v3, zstd (zarr v3's default codec).
"""
import shutil
import sys

import numpy as np
import zarr
from ome_zarr.io import parse_url
from ome_zarr.writer import write_image, write_labels

version = sys.argv[1]
out = f"cells-{version}.ome.zarr"
shutil.rmtree(out, ignore_errors=True)

z, y, x = np.meshgrid(np.arange(3), np.arange(6), np.arange(8), indexing="ij")
labels = (1 + x // 3 + 10 * (y // 3)).astype(np.uint32)
labels[2, 5, :] = 70000
labels[0, :, 0] = 0
image = (labels % 251).astype(np.uint8)

meta = {
    "colors": [{"label-value": 1, "rgba": [255, 0, 0, 255]}, {"label-value": 70000, "rgba": [0, 0, 255, 255]}],
    "properties": [{"label-value": 1, "class": "Nucleus"}, {"label-value": 70000, "class": "Membrane"}],
}
axes = [{"name": "z", "type": "space", "unit": "micrometer"},
        {"name": "y", "type": "space", "unit": "micrometer"},
        {"name": "x", "type": "space", "unit": "micrometer"}]
scale = [{"type": "scale", "scale": [2.0, 0.5, 0.5]}]

if version == "v04":
    from numcodecs import Blosc
    store = parse_url(out, mode="w").store
    root = zarr.group(store=store)
    opts = {"chunks": (1, 4, 4), "compressor": Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE)}
    write_image(image, root, axes=axes, scaler=None, coordinate_transformations=[scale], storage_options=opts)
    write_labels(labels, root, name="cells", axes=axes, scaler=None, coordinate_transformations=[scale],
                 label_metadata=meta, storage_options=opts)
else:
    root = zarr.open_group(out, mode="w", zarr_format=3)
    opts = {"chunks": (1, 4, 4)}
    write_image(image, root, axes=axes, scaler=None, coordinate_transformations=[scale], storage_options=opts)
    write_labels(labels, root, name="cells", axes=axes, scaler=None, coordinate_transformations=[scale],
                 label_metadata=meta, storage_options=opts)
np.save(f"cells-{version}.expected.npy", labels)
print(out, labels.shape)
