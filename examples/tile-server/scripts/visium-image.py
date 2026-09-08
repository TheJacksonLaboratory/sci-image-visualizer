#!/usr/bin/env python3
"""
Extract a Visium tissue image from an AnnData `.h5ad` and derive its registration.

A Visium `.h5ad` carries the H&E image inside `uns/spatial/<library>/images/<tier>`, at a
DOWNSCALE of the resolution the spot coordinates are recorded in — `obsm/spatial` is in
full-resolution pixels, while what ships in the file is the 2000 px `hires` tier (or the
600 px `lowres`). That ratio is the whole reason this script exists: the numbers relating
the two are in the file, and typing them by hand is where the alignment quietly breaks.

    pip install h5py numpy pillow
    python3 scripts/visium-image.py --h5ad visium_hne_adata.h5ad --out visium-hne.png

Writes the PNG and prints the registration for `make-pyramid.mjs` and
`h5ad-to-spatial.py`. Nothing here touches the bundle: the image goes through the same
pyramid path as a real slide, so the server serves it identically.

## The physical scale is MEASURED, not read out of scalefactors

The obvious source for µm/px is `scalefactors/spot_diameter_fullres` against the 55 µm
Visium spot. It is wrong, and quietly: on the squidpy H&E dataset that field is 89.44 px,
which against a measured lattice works out at 65.0 µm rather than 55 µm — an 18% error in
every distance on screen, with nothing to give it away because the picture still looks
entirely plausible.

What is dependable is the SPOT PITCH. Visium spots sit on a regular hexagonal lattice
100 µm centre-to-centre, a property of the slide rather than of the sample or of whichever
spaceranger version wrote the file. `array_row`/`array_col` say where each spot sits on
that lattice, so fitting coordinates against them recovers the pitch in pixels to a
fraction of a pixel — and the hex regularity is then a CHECK on the whole assumption
rather than something to hope for.

    µm per full-res px = SPOT_PITCH_UM / pitch measured in full-res px
    µm per served px   = µm per full-res px / tissue_<tier>_scalef
    imageRef.scale     = tissue_<tier>_scalef     (full-res coords -> served pixels)
    radius             = (SPOT_DIAMETER_UM / 2) / µm per full-res px

Note which constant does which job: the PITCH sets the scale, and the 55 µm DIAMETER only
sizes the drawn marker. Deriving the radius from `spot_diameter_fullres` instead would draw
65 µm spots over a 55 µm reality — more overlap between neighbours than the assay has.
"""

import argparse
import sys

import h5py
import numpy as np
from PIL import Image

#: Centre-to-centre spot spacing on a Visium slide, in µm. Fixes the physical scale.
SPOT_PITCH_UM = 100.0
#: Capture-spot diameter, in µm. Sizes the drawn marker, and nothing else.
SPOT_DIAMETER_UM = 55.0
#: How far the lattice may depart from a regular hexagon before the fit is not trustworthy.
HEX_TOLERANCE = 0.02


def to_uint8(arr: np.ndarray) -> np.ndarray:
    """The tier's pixels as uint8 RGB.

    squidpy stores these as float32, and as 0..1 rather than 0..255 — but not always, and a
    silently misread range is a black or blown-out slide, so the range decides rather than
    the dtype alone.
    """
    if arr.dtype == np.uint8:
        return arr
    peak = float(np.nanmax(arr))
    scale = 255.0 if peak <= 1.0 else 1.0
    return np.clip(np.rint(np.asarray(arr, dtype=np.float64) * scale), 0, 255).astype(np.uint8)


def pitch_from_lattice(coords: np.ndarray, row: np.ndarray, col: np.ndarray) -> tuple[float, str]:
    """Spot pitch in coordinate units, fitted against the array indices.

    Visium's axes are image-aligned, so x depends only on `array_col` and y only on
    `array_row` — two independent 1-D fits rather than a 2-D affine, which keeps the residual
    interpretable as "how well does this look like the lattice it claims to be".

    Consecutive spots in one row differ by TWO in `array_col` (the odd/even offset that makes
    the grid hexagonal), so the same-row neighbour distance is `2 * dx`. Its adjacent-row
    neighbour is one step in each, at `hypot(dx, dy)`. On a regular hexagon those are equal,
    and their ratio is returned as the check.
    """
    a = np.c_[col, np.ones_like(col)]
    b = np.c_[row, np.ones_like(row)]
    fit_x = np.linalg.lstsq(a, coords[:, 0], rcond=None)[0]
    fit_y = np.linalg.lstsq(b, coords[:, 1], rcond=None)[0]
    dx, dy = abs(float(fit_x[0])), abs(float(fit_y[0]))
    if not (dx > 0 and dy > 0):
        raise SystemExit("array_row/array_col do not vary; cannot fit the lattice")
    same_row = 2 * dx
    diagonal = float(np.hypot(dx, dy))
    ratio = diagonal / same_row
    if abs(ratio - 1.0) > HEX_TOLERANCE:
        raise SystemExit(
            f"lattice is not a regular hexagon (diagonal/same-row = {ratio:.4f}); "
            "coordinates may not be full-resolution pixels"
        )
    residual = float(np.hypot(np.std(coords[:, 0] - a @ fit_x), np.std(coords[:, 1] - b @ fit_y)))
    return (same_row + diagonal) / 2, f"hex ratio {ratio:.4f}, residual {residual:.2f} px"


def pitch_from_neighbours(coords: np.ndarray) -> tuple[float, str]:
    """Fallback pitch: the median nearest-neighbour distance.

    For a file without `array_row`/`array_col`. Weaker than the fit — a lattice edge or a
    dropped spot pulls individual distances, which is why it is the median — and it cannot
    check hex regularity, so it says so rather than implying the same confidence.
    """
    best = np.full(len(coords), np.inf)
    # Chunked, so a large section does not allocate an N x N distance matrix.
    for lo in range(0, len(coords), 2048):
        block = coords[lo:lo + 2048]
        d = np.sqrt(((block[:, None, :] - coords[None, :, :]) ** 2).sum(-1))
        d[np.arange(len(block)), np.arange(lo, lo + len(block))] = np.inf
        best[lo:lo + len(block)] = d.min(1)
    return float(np.median(best)), "median nearest neighbour, unchecked"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h5ad", required=True)
    ap.add_argument("--out", required=True, help="PNG to write")
    ap.add_argument("--tier", default="hires", help="images/<tier> to extract (hires|lowres)")
    ap.add_argument("--library", default=None, help="uns/spatial/<library>; the only one by default")
    ap.add_argument("--spatial-key", default="spatial")
    ap.add_argument("--spot-pitch-um", type=float, default=SPOT_PITCH_UM,
                    help="centre-to-centre spot spacing; sets the physical scale")
    ap.add_argument("--spot-diameter-um", type=float, default=SPOT_DIAMETER_UM,
                    help="capture-spot diameter; sizes the drawn marker")
    args = ap.parse_args()

    with h5py.File(args.h5ad, "r") as f:
        spatial = f["uns"]["spatial"] if "uns" in f and "spatial" in f["uns"] else None
        if spatial is None:
            raise SystemExit("no uns/spatial: not a Visium-style AnnData")
        libraries = list(spatial.keys())
        library = args.library or (libraries[0] if len(libraries) == 1 else None)
        if library is None:
            raise SystemExit(f"--library required, one of: {', '.join(libraries)}")
        if library not in spatial:
            raise SystemExit(f"no uns/spatial/{library}; have: {', '.join(libraries)}")
        group = spatial[library]

        images = group.get("images")
        if images is None or args.tier not in images:
            have = ", ".join(images.keys()) if images else "none"
            raise SystemExit(f"no images/{args.tier}; have: {have}")
        pixels = to_uint8(images[args.tier][:])
        if pixels.ndim != 3 or pixels.shape[2] not in (3, 4):
            raise SystemExit(f"images/{args.tier}: expected HxWx3, got {pixels.shape}")
        height, width = pixels.shape[0], pixels.shape[1]
        Image.fromarray(pixels[:, :, :3]).save(args.out)

        sf = group.get("scalefactors")
        tier_key = f"tissue_{args.tier}_scalef"
        if sf is None or tier_key not in sf:
            raise SystemExit(f"no uns/spatial/{library}/scalefactors/{tier_key}")
        scalef = float(sf[tier_key][()])
        if not scalef > 0:
            raise SystemExit(f"{tier_key} is not positive: {scalef}")

        coords = np.asarray(f["obsm"][args.spatial_key][:], dtype=np.float64)
        obs = f["obs"]
        if "array_row" in obs and "array_col" in obs:
            pitch_px, how = pitch_from_lattice(
                coords,
                np.asarray(obs["array_row"][:], dtype=np.float64),
                np.asarray(obs["array_col"][:], dtype=np.float64),
            )
        else:
            pitch_px, how = pitch_from_neighbours(coords)

        um_per_fullres = args.spot_pitch_um / pitch_px
        um_per_served = um_per_fullres / scalef
        radius = (args.spot_diameter_um / 2) / um_per_fullres

        # A check the caller can act on rather than a comment claiming it holds: the spots
        # must land INSIDE the tier they are about to be drawn over. Catches a coordinate
        # frame that is not full-resolution pixels, which no amount of correct arithmetic
        # downstream would fix.
        lo = coords.min(0) * scalef
        hi = coords.max(0) * scalef
        fits = lo[0] >= 0 and lo[1] >= 0 and hi[0] <= width and hi[1] <= height

        # What the obvious-but-wrong route would have produced, so the difference is on the
        # record instead of being a claim in a docstring.
        reported = sf.get("spot_diameter_fullres")
        stated = float(reported[()]) if reported is not None else None

    print(f"wrote {args.out}: {width}x{height} from images/{args.tier} of {library}")
    print(f"  lattice pitch {pitch_px:.2f} full-res px = {args.spot_pitch_um:g} µm  ({how})")
    print(f"    ->  {um_per_fullres:.6f} µm per full-res px")
    print(f"  {tier_key} {scalef:.8f}  ->  {um_per_served:.4f} µm per served px")
    if stated is not None:
        print(f"  (scalefactors/spot_diameter_fullres {stated:.2f} px would be "
              f"{stated * um_per_fullres:.1f} µm, not {args.spot_diameter_um:g} — not used)")
    print(f"  spots span x {lo[0]:.1f}..{hi[0]:.1f}, y {lo[1]:.1f}..{hi[1]:.1f} "
          f"in a {width}x{height} image: {'inside' if fits else 'OUT OF BOUNDS'}")
    print()
    print(f"  make-pyramid:  --mpp {um_per_served:.4f}")
    print(f"  converter:     --image-scale {scalef:.8f},{scalef:.8f} \\")
    print(f"                 --image-mpp {um_per_served:.4f},{um_per_served:.4f} \\")
    print(f"                 --microns-per-unit {um_per_fullres:.6f} --radius {radius:.2f}")
    if not fits:
        raise SystemExit("spots fall outside the image; check --spatial-key and --tier")


if __name__ == "__main__":
    sys.exit(main())
