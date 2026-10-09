# Spatial omics

Contracts for **spatial-omics datasets**: N observations (Visium spots,
segmented cells) positioned in a tissue image's pixel space, each carrying
categorical and continuous annotations plus a lazily-fetched feature (gene)
matrix.

```ts
import {
  SPATIAL_DATA_PORT, SpatialDataHttpService, SpatialDataset,
} from '@jax-data-science/sci-image-visualizer';

providers: [
  SpatialDataHttpService,
  { provide: SPATIAL_DATA_PORT, useExisting: SpatialDataHttpService },
]
```

Like `TILE_ACCESS_PORT`, this is a **port**: the library consumes typed arrays
and never learns how the data is stored. `SpatialDataHttpService` is an optional
reference adapter for the format the bundled example server speaks; a host with
its own backend implements `SpatialDataPort` instead and imports neither.

Two properties the design turns on:

- **Metadata is eager, values are lazy.** A `SpatialDataset` holds coordinates
  plus column and feature *descriptors*; vectors arrive one at a time, for the
  one column or gene being displayed. A Visium table is ~31k genes wide — the
  dense matrix is ~800 MB — so loading a dataset can never mean loading its
  matrix.
- **Struct-of-arrays, not object-per-cell.** Datasets run 10³ (Visium) to 10⁶
  (Xenium/CosMx) observations; two `Float32Array`s beat 500k `{x, y}` objects
  and upload to the GPU without a copy.

Once a dataset is published, the spatial plot types appear in the selector (and
disappear when it is cleared — the same gating that hides Volume without a
z-stack):

- **Spatial omics** — one marker per observation over the tissue image the
  coordinates live in, positioned through `imageRef`'s affine.
- **Spatial omics 3D** — gated additionally on the observations carrying a `z`
  (`requiresSpatial3d`): the same observations as a point cloud under an orbit
  camera, inside the dataset's reference volume if it has one.

**A dataset whose 3D data is one file gets an image made from it.** A registered
volume (`SpatialDataset.volume` + `SpatialDataPort.getVolume()`) is published *as*
a grayscale z-stack image — one plane per slice, opened mid-volume — so the whole
image surface applies to it: the toolbar slice slider, the contrast window,
colormaps, the region tools, the physical scale bar, and Volume / Isosurface
through the ordinary stack path. In the 2D mode the displayed plane then draws
**that plane's** observations over that plane's anatomy, in the volume's own pixel
grid, and a region drawn there selects that plane's cells rather than the whole
depth behind them.

**Cluster density volumes** *(3D mode, optional)* — a checkbox that raymarches
each cluster as a smooth density field beside the cloud, tinted with its legend
colour and blended additively. Serial sections hundreds of microns apart cannot be
read as an anatomical distribution from points alone: the eye will not integrate a
stack of discs into a shape, and every gap between sections reads as absence.
Individual cells are never interpolated — consecutive sections sample different
cells, so there is nothing to interpolate along — but a density *field* is an
estimate legitimately defined between the imaged planes, and it renders as a
translucent cloud so it cannot be mistaken for measurement. The kernel is
anisotropic (σ along z clears one section gap) and the field is coverage-normalised
along z, so unimaged planes do not read as empty tissue.

In **3D** the same `Gene map` checkbox draws one field per imaged section, at its
own depth, with the gaps between sections empty — the measured slides, stacked.
`One map section at a time` isolates a single sheet (its own control, separate from
the cloud's, so every combination stays reachable), and `Volume rendering
(interpolate along z)` smooths the sheets into a continuous volume. The last is a
different object and the panel labels it as one: the planes between sections then
carry an estimate smoothed from their neighbours' mean, nothing is drawn past the
outermost section, and the section restriction is ignored because a volume built
from one slide would smear it through the whole specimen. It is estimated on the
reference volume's lattice — coarsened in-plane but never along z, so one plane is
one section — and shares the 2D map's bandwidth, window and colormap.

**Show** *(3D mode)* — the reference volume, the observation cloud and the cluster
density volumes share one space, so any two of them hide each other; 374k points
drawn as a stack of discs hide the density volumes almost entirely. Each is
toggled independently, so every combination is reachable — the estimated fields
alone, the fields with the anatomy behind them, the anatomy on its own. These are
visibility only: the layers stay built, so a toggle never re-fetches the template
or re-rasterises a field, and none of them re-frames the orbit camera. (The
density checkbox is the exception and still gates construction, since building six
volumes is not free.) **Volume opacity** is the backdrop's own slider, separate
from the markers': reading the cloud or a density field *through* the anatomy
means turning the anatomy down, not the data over it. **One section at a time** restricts the cloud to a single
imaged section, which is how you check whether the estimated field follows the
cells that were actually measured. Sections are the distinct z of the
observations — every cell on a slide shares that slide's registered z, so no
section-label column is needed — and a dataset whose z is continuous rather than
sectioned is offered no section control instead of having one invented for it.

**Hover and click** — hovering an observation names it in a cursor tooltip: the
class for a categorical column, the value with its unit for a gene or numeric one,
and nothing at all when no colour source is set (there is no cluster to name).
Clicking a marker selects that whole class, the same selection the legend's rows
produce, and clicking it again clears. Because a click means "select" here,
napari's click-to-zoom is off in the spatial modes — the wheel, the zoom buttons
and the zoom-box tool still zoom. A gene cannot be clicked to select: no set of
cells "is" a value.

**Colormap** *(continuous colouring)* — the low→high gradient for a gene or a
numeric column, chosen from the library's own `COLORMAP_OPTIONS` with the same
swatch previews the image's colormap picker uses. It defaults to following the
image's colormap (with a Viridis fallback, since a grey measurement over grey
anatomy cannot be told apart from it), and clearing the picker returns to that.
One setting drives the markers, both gene maps and the panel's colour bar, so none
of them can disagree about what a colour means.

**Gene map** *(2D mode, optional, with a gene selected)* — a checkbox that draws
the selected gene's expression as a smooth field *beneath* the cells. Coloured
markers answer "which cells express this gene"; they do not answer "where is it
expressed", because the eye cannot integrate thousands of small dots into a
territory. The field is the kernel-weighted **mean per cell, not a sum** — a sum
would make a crowded region glow whatever its cells were doing — and smoothing the
numerator and denominator together spreads *where*, not *how much*. That
denominator is also what lets the layer say nothing: where no cell was measured the
mean is undefined rather than zero, so those pixels stay fully transparent instead
of taking the colormap's low end, and alpha ramps with local support so a thinly
sampled pixel reads as tentative. `Smoothing` sets the kernel σ; `Map opacity` is
the field's own opacity, separate from the markers' — turn the markers down to read
the field under them. On a volume-backed dataset the field is re-estimated per
plane from that plane's cells.

Colour it through `getSpatialControls()`:

```ts
const controls = viz.getSpatialControls();   // null unless a port is bound
controls?.colorByColumn('region');           // categorical -> the column's palette
controls?.colorByFeature('Ttr');             // gene -> colormap, log, percentile-clipped
controls?.setViewState({ pointScale: 2 });
```

The view state lives in the shared store, so the controls work before any
backend has mounted and survive a plot-type switch.

The [example server](../../examples/tile-server/README.md#spatial-omics-endpoints)
implements the endpoints, and `npm run make-spatial-demo` generates a synthetic
Visium-geometry dataset **and a matching tissue image** so the
[browser example](../../examples/browser-image/README.md#spatial-omics-demo) runs the
whole path with no download. A converter for real SpatialData Zarr stores ships
alongside it.

A **Spatial omics** controls panel (`<spatial-controls>`, opened from the
toolbar) drives all of this from the UI: a column dropdown, a gene search over
the feature panel, a legend for categorical colourings and a colour bar for
continuous ones, plus point-size, opacity, log-scale and outlier-clip controls.
Its legend swatches and colour bar are built with the same functions the
renderer uses, so the key cannot drift from the canvas.

**Selection** reuses the region tools you already have: draw a rectangle,
polygon, freehand shape, wand or brush region, then *Select from ROIs* selects
every observation inside their union and mutes the rest. Legend rows select
their category on click.

**Linked distributions** sit in the same panel, below the colour controls, over
whatever the map is coloured by: histogram, violin or box for a continuous column
or a gene, and per-category **counts** for a categorical one — a histogram of a
category code would be meaningless, but "how many cells per class" is the question
the legend implies and never answers. Violin and box are splittable by a
categorical column. One dialog on purpose — changing the gene
and watching the distribution move is a single action. They follow the selection: the histogram
overlays *Selected* on the full distribution, violin and box narrow to it. The
chart's subject is the map's colour source rather than an independent picker, so
the two cannot disagree about what is being shown.

Categorical colouring has one renderer-specific limit worth knowing: the 3D
points layer maps a per-point scalar through a 256-entry LUT, which keeps 96
blocks apart exactly — one of them reserved for a missing value, so **95
categories** fit — and above that the cloud draws flat and the panel says so.
The 2D markers (per-point RGBA) and the density volumes (a scalar field per
cluster) have no such limit — which is why the example server serves `subclass`
(338) even though the cloud cannot colour by it.

Still to build: chart → map brushing. The design record, with the decisions behind
all of the above, is [`../design/spatial-omics-plot-mode-design.md`](../design/spatial-omics-plot-mode-design.md).
