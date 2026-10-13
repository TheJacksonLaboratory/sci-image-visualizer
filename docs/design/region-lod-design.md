# Level-of-detail regions

Status: in progress (branch `feat/region-lod`).

## Problem

A slice can carry a very large region set: a brain-atlas section (a few hundred structures with
long outlines), a whole-slide cell segmentation (10⁵–10⁶ polygons). Today every region is a full
`Region` in `RegionStore`, every backend draws all of them at full resolution on every change, and
every tool and the Region Editor read and rewrite the whole array (`getRegions()` /
`setRegions(all)`). Past a few thousand regions that is unusable, and the whole GeoJSON has to be
parsed up front.

Goal: never hold or draw a large set at full resolution. Draw simplified outlines when zoomed out
and the exact coordinates when zoomed in, fetching only the tiles on screen (as the spatial cell
outlines do), and keep every region editable.

## Model: a tiled source under an in-memory working set

```
          ┌──────────────────────────────┐
 Region   │  RegionTileSource (per image)│  tiles per level, simplified per level;
 tiles ──▶│  worker (GeoJSON) or HTTP    │  feature index (id, label, colour, bbox, area);
          └──────────────┬───────────────┘  exact features by id
                         │ tiles in view / exact features on demand
          ┌──────────────▼───────────────┐
          │ RegionStore                  │  working set: today's Region[] (drawn, created
          │  working set + source overlay│  and edited regions, exact geometry), plus the
          └──────────────┬───────────────┘  overlay on the source: patches (label, colour),
                         │                  deletions, and which features are materialized
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
  tile layer (OSD,   overlays/tools      Region Editor
  napari): LOD       (unchanged: they    (table pages through the
  outlines of the    work on the         source index + overlay)
  untouched features working set)
```

- **Source.** A `RegionTileSource` describes one image's large region set: levels, bounds and a
  feature count; tiles (`getTile(z, level, gx, gy)`); the exact geometry of features by id
  (`getFeatures(z, ids)`); and a paged feature index for the editor (`getIndex`). Two
  implementations behind one contract: a **worker source** built from a GeoJSON string (the worker
  holds the parsed features; the main thread only ever sees tiles and index pages) and an **HTTP
  source** (a server that serves the same tiles; the example tile server does).
- **Tiles.** Level 0 is exact. Level *k* covers `tileSize · 2ᵏ` image pixels per tile and its
  outlines are simplified (Douglas–Peucker) to `2ᵏ⁻¹` image pixels, half a screen pixel when the
  view shows about `2ᵏ` image pixels per screen pixel. A feature smaller than the tolerance is left
  out of that level. A tile holds the **whole** simplified feature (not clipped) for every feature
  whose box meets it; the layer de-duplicates by id. So at level 0 the tiles in view already hold
  the exact geometry of everything visible.
- **Identity.** A source feature has a stable string id: the GeoJSON feature's `id` (or
  `properties.id`), else its position in the file. It is written back on export. A region
  materialized from a feature carries it as `Region.sourceId`.
- **Working set.** `RegionStore` keeps today's `Region[]` and API, so the overlays, tools, undo,
  selection and Plotly keep working unchanged on it. Next to it, per image (per slice in stack
  mode), the **source overlay**: `patches` (id → label/colour), `deleted` ids, and the ids
  materialized into the working set. The tile layer draws a feature only when it is neither
  materialized nor deleted, with its patch applied.
- **Editing = materializing.** Before anything edits a source feature its exact outline joins the
  working set as an ordinary `Region` (with `sourceId`), and the layer stops drawing the feature.
  - Select (click, marquee, Region Editor row): materialize the hit features, then select them as
    today.
  - Tools that pick up regions (wand/brush adopt, vertex eraser, merge-touching) materialize the
    features under the cursor or brush first. At level 0 that is synchronous (the tile has the
    exact geometry); zoomed out it fetches them first.
  - Label, colour and delete from the Region Editor need no geometry: they are patches and
    deletions on the overlay.
  - Undo snapshots the overlay with the working set.
- **Drawing.** A tile layer per backend under the editable regions: OSD and napari share an SVG
  layer of one compound path per (tile, colour), rebuilt only when the tiles or the overlay change,
  moved by the same world transform as the region overlay. Level and tiles come from the viewport
  (`lod.ts`), debounced while the camera moves, with an LRU tile cache. Hover and click hit-test
  the features of the tile under the cursor. Plotly (layout shapes) does not draw a source; it
  shows the working set only.
- **Loading.** `IImageInfo.regionSource` lets a host hand a source (HTTP) over; and an image's
  `roiJsonStr` / `roiJsonStrs[z]` (or a Region Editor import) above a size threshold becomes a
  worker source instead of being parsed into the store.
- **Saving.** Export streams the source's features through the overlay (patches, deletions,
  materialized replacements) plus the regions created in the working set into one GeoJSON, in the
  worker for a worker source.

## Phases

1. Contracts and the pure core: tile pyramid builder, level choice, tile merge, hit test.
2. Sources: the GeoJSON worker source (with an in-thread fallback) and the HTTP source.
3. Store: attach a source, the overlay, materialize, undo.
4. Drawing and picking on OSD and napari.
5. Editing paths: tools, marquee, region ops, Region Editor table and class operations.
6. Loading (threshold, host source) and saving (merged export).
7. Example tile server endpoints, the brain atlas, docs.
