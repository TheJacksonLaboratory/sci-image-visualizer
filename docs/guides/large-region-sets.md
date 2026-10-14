# Large region sets (level of detail)

A slice can carry far more regions than a viewer can hold as editable shapes: a brain-atlas
section with hundreds of long outlines, a whole-slide cell segmentation with 10⁵–10⁶ cells. Such a
set loads as a **region source** instead of as regions. The viewer draws only the part on screen,
at the detail the zoom can show, and a feature becomes an ordinary editable region only when
someone selects it.

## What the user sees

- **Zoomed out**, outlines are simplified to under a screen pixel, and features smaller than a
  pixel or two are left out. **At 1:1 and closer** they are exact. Zooming in sharpens the
  outlines tile by tile; the coarser outline stays on screen while the finer one loads.
- **Selecting** a feature (a click in Selection mode, a rubber band, or a row of the Region
  Editor's region-set list) takes it into the regions: it is now an ordinary region, with every
  editing tool, undo and the class tools. Undoing past the moment it was taken puts it back in the
  source.
- **The Region Editor** lists the features still in the source above its table, a page at a time,
  filterable by class. The bin on a row deletes a feature without taking it. **Delete all**
  clears the source too.
- **Save and export** write the source's remaining features with the regions, so nothing is lost.
  Each feature keeps its GeoJSON `id` and other properties.
- OpenSeadragon and napari draw a source. **Plotly** shows only the regions taken from it, and the
  3D views none.

The wand, brush, vertex eraser and merge tools work on regions: to grow, cut or merge a source
feature, select it first.

## Loading one

| How | When |
|---|---|
| `IImageInfo.roiJsonStr` (or a folder stack's `roiJsonStrs[z]`) of at least `VizConfig.regionSourceMinChars` characters | Default 1 000 000. The GeoJSON is parsed and tiled in a Web Worker; the main thread only sees tiles. |
| A Region Editor import of a file that large | Becomes the slice's source, replacing its regions. |
| `IImageInfo.regionSourceUrl` | A server serves the tiles itself; the browser never downloads the set. |

```ts
provideVisualization(),
{ provide: VIZ_CONFIG, useValue: { slideCropServer, regionSourceMinChars: 250_000 } },
```

`0` makes every ROI file a source, `Infinity` none. On a z-stack, a z-indexed file (QuPath's
`geometry.plane.z`) or server source serves each slice its own plane, and each large slice file of
a folder stack opens the first time its slice is shown (at most six stay open).

A host can also open one itself: `openGeoJsonRegionSource(text)` and
`openHttpRegionSource(url)` return a `RegionSource`.

## The server wire

`openHttpRegionSource(base)` reads, relative to `base`:

| Request | Answer |
|---|---|
| `GET info` | `RegionSourceInfo`: feature count, bounds, tile size, levels, planes, class colours |
| `GET tile/{z}/{level}/{gx}/{gy}` | `{ features: [{ id, label, color, bbox, rings, open? }] }`, rings as flat `[x, y, …]` |
| `POST features` `{ ids }` | `{ features: [{ id, feature }] }`, the exact GeoJSON features |
| `POST index` `{ z, offset, limit, label?, exclude? }` | `{ total, rows: [{ id, label, color, bbox }] }` |
| `POST export` `{ exclude, extra }` | a GeoJSON FeatureCollection: the set without `exclude`, then `extra` |

Level 0 is exact. A level-k tile covers `tileSize · 2ᵏ` image pixels and holds every feature
whose box meets it, whole (not clipped), simplified by Douglas–Peucker to `2ᵏ⁻¹` pixels, without
features under `2ᵏ` pixels. The library's own tiler (`src/lib/region-source/region-tiles.ts`) is
pure TypeScript; the example tile server bundles it to serve any GeoJSON file or folder of
per-slice files under `REGION_DIR` (see its README).
