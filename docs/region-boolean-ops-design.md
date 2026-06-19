# Region merge / group / inverse / simplify — implementation plan

**Status:** proposed · **Owner:** TBD · **Tracking:** follow-up to jit-ui#85
**Depends on:** [`region-holes-design.md`](./region-holes-design.md) — *must land first.*

**Decisions locked in (see §9 for rationale):** geometry = **MultiPolygon**
(geometric union, flat model — *not* a nested group container); boolean engine =
**raster/mask** (reuse the wand/brush pipeline); **inverse** is relative to the
**full image rectangle**; **simplify** = **Douglas–Peucker**, epsilon in image
pixels. A reversible logical "group" — if ever needed — is a flat `groupId?` tag
on `Region`, never a hierarchy (§2).

## 1. Summary

Add region-set operations driven from the region context menu (right-click on a
region in the plot, or on the selection in the Region Editor):

| Op | Shown when | Effect |
|----|-----------|--------|
| **Merge / Group** | ≥2 selected | Geometric **union** of the selected regions → one region. |
| **Ungroup** | ≥1 selected that is multi-part | Split a region into its disconnected pieces, each its own region. |
| **Inverse** | ≥1 selected | Replace the selection with its inverse inside the image bounds. |
| **Simplify…** | ≥1 selected | Douglas–Peucker simplify each ring by an *altitude threshold* (px). |

All four go through the shared `RegionStore` mutate path, so they are covered by
undo/redo (jit-ui#85) automatically (§6).

A merged region can be **disconnected** ("sparse bits") and can have **holes**
("donuts"). Neither is representable today, which is why this plan **requires the
holes work first** and then generalises the geometry from one ring to a
**MultiPolygon** (list of parts, each an exterior ring + holes).

## 2. Why it depends on holes (and adds MultiPolygon)

- **Holes** — the inverse of a blob is the image rectangle *with a hole* where
  the blob was; merging a ring yields a donut. Holes are specified in
  `region-holes-design.md` (adds `Polygon.holes`).
- **MultiPolygon** — merging two disjoint regions, or inverting a region into
  several disconnected background areas, yields **one region with several
  parts**. The neutral model is single-ring today
  (`models/region.ts:142`), so we add a parts container.

### Geometry model (decided: MultiPolygon)

Introduce a third neutral bounds type; reuse `Polygon` (with `holes` from the
holes plan) as the per-part shape so closed/bezier/holes semantics are shared:

```ts
// models/region.ts
export class MultiPolygon {
  /** ≥1 disjoint parts. Each part is a closed Polygon that may carry holes. */
  polygons: Polygon[] = [];
}
// Region.bounds: Rectangle | Polygon | MultiPolygon | null
```

This is the "possibly refactoring" part: every `instanceof Polygon | Rectangle`
site must learn about `MultiPolygon`. Inventory (audit before starting):

- `region.ts` `getShape()` / `toString()` (`:46`, `:75`)
- `region-store.service.ts` `cloneBounds` (`:490`), `regionsEqual` (`:508`),
  `moveRegion`/vertex ops (`instanceof` guards)
- `plot.utilities.ts` `getPolygon` (`:285`), GeoJSON import/export (`:350`, `:460`)
- `osd-region-overlay.ts` render + hit-test (`:262`)
- `wand.service.ts` `regionVerts`-style readers, `brush-tool.service.ts:366`
- `models/shape.ts` Plotly path build (`:69`)

**Why not a nested group container.** A parent region holding intact child
regions (ungroup restores exact children) gives perfect reversibility but
introduces a *tree* into a flat, geometry-first model: selection, the Region
Editor table, rendering, GeoJSON (no native group — needs a custom encoding
QuPath won't read), and undo all become group-aware. It fights the existing
design and is a much larger, riskier change, and it does **not** itself produce
donuts/sparse geometry. The request ("merge/group", "donut", "bits not
connected", "ungroup") describes geometric union, so MultiPolygon is the choice.

**If reversible grouping is ever required**, do it *without* hierarchy: add a
flat `groupId?: string` tag on `Region`. Same-`groupId` regions
render/select/move together; "group" sets the tag, "ungroup" clears it; the list
stays flat and the ops stay pure. This is a separate, additive feature from the
lossy geometric **Merge** below — not a replacement for it. (For undoing a
geometric merge, the undo stack already does that; ungroup is connectivity-split,
§3.)

## 3. The operations engine

Add a **pure, DOM-free** `RegionOpsService` (lib) — the dumping ground for the
set operations, alongside `models/geometry.ts`. It takes `Region[]` (+ image
width/height) and returns `Region[]`. It is unit-testable in isolation and is
the single place the store and any future caller go through.

**Decided: raster (mask) based**, reusing existing infra:
`BBoxMask`, `unionMasks`, `masksOverlap` (`models/geometry.ts:11,112,132`),
`WandService.rasterizePolygon` (`wand.service.ts:161`), and the hole-aware
`maskToPolygons` from the holes plan (`wand.service.ts:243`).

- **Merge** = rasterize each selected region (exterior minus holes) onto a shared
  mask over the union bbox → OR them → `maskToPolygons` → assemble all returned
  components (with holes) into one `MultiPolygon`.
- **Inverse** = allocate a full-image mask, paint the union of the selection,
  bitwise-NOT inside the image rectangle → `maskToPolygons` → `MultiPolygon`.
  (Image rect minus selection; the former selection becomes hole(s).)
- **Ungroup** = if `MultiPolygon`, emit one region per `polygons[]` part
  (each keeps its holes); if a single `Polygon`, also offer split-by-connected-
  components via a one-shot rasterize→`maskToPolygons`. No-op/disabled for a
  single connected part. *Note:* ungroup splits by connectivity — it does **not**
  recover pre-merge originals that overlapped. Document this.
- **Simplify** = **vector**, not raster: Douglas–Peucker per ring with
  `epsilon = altitudeThresholdPx`. (Add `simplifyRing(xs, ys, eps)` to
  `geometry.ts`.) Applies to exterior + every hole, every part; drop a ring that
  degenerates below 3 vertices (and the part if its exterior degenerates).

**Why raster, not a vector clipping lib.** The codebase is already
raster-centric for *building* regions: the wand and brush trace masks
(`rasterizePolygon` → `unionMasks` → `maskToPolygons`). "Merge two regions" is
the same operation the brush does when you paint across two blobs — so sharing
the mask pipeline means **one code path and identical geometry** between
"brush together" and "select + merge". A vector lib (martinez /
polygon-clipping) would be a *second, parallel* geometry pipeline with its own
edge cases — two sources of truth for "combine polygons", and merge would
subtly diverge from the brush. Donuts + multi-part also fall out of
`maskToPolygons` for free. **Cost:** sub-pixel rounding at ring edges
(irrelevant for pixel-space ROIs, and Simplify cleans the staircase), and
inverse allocates a full-image mask once per call (bounded, one-shot). Revisit a
vector engine only if exact sub-pixel boolean geometry becomes a hard
requirement.

Colour/label of the result: inherit from the first (top-most) selected region;
merged/inverse regions get one label. Keep it simple, document it.

## 4. Store API & wiring

Add to `IRegionStore` (`contracts/visualizer.contract.ts`) and implement in
`RegionStore` (so they share the mutate→cache→emit→**undo** path):

```ts
mergeRegions(indices: number[]): void;     // union → single region, selects it
ungroupRegions(indices: number[]): void;   // split parts → many regions
inverseRegions(indices: number[]): void;   // replace selection with inverse
simplifyRegions(indices: number[], altitudePx: number): void;
```

Each implementation: resolve indices→ids, snapshot via the existing
`recordUndoSnapshot()` (already at the top of every mutator,
`region-store.service.ts`), compute the new `Region[]` via `RegionOpsService`,
splice out the inputs, push the result(s), set selection, `syncCache()`,
`emitSelection()`, `emit()`. Delegate through `OpenSeadragon`/`Plotly`/
`RoutingVisualizerService` exactly like the existing region methods.

## 5. UI

### 5.1 Plot context menu
`buildContextMenuItems()` (`visualization.component.ts:1091`) is currently a
static toolbar mirror. Make it **selection-aware**: read
`plotService.getSelectedShapeIndices()` and prepend a "Region" group when ≥1
selected:

- ≥1: **Inverse**, **Simplify…**, and **Ungroup** (only if a selected region is
  multi-part).
- ≥2: **Merge / Group**.

The menu must reflect what was right-clicked — ensure a right-click on a region
selects it first (today the menu is generic). Capture the clicked region via the
overlay/Plotly hit-test, add it to the selection if not already selected.

### 5.2 Region Editor
The editor already multi-selects rows (PrimeNG table). Add the same four actions
as a row context menu or a small action bar above the table, routed through the
`IRegionEditorApi` (`routing-visualizer.service.ts:240` `getAnnotationRegions` /
`setAnnotationRegions`) so profile lines stay untouched.

### 5.3 Simplify parameter
"Altitude threshold in pixels" = Douglas–Peucker epsilon. Use a tiny dialog (or
overlay slider) defaulting to ~2 px, range 0.5–20. Live-preview is optional
(simplify is cheap; could preview on the overlay before commit).

## 6. Undo / redo

No new machinery. Because each op is one `RegionStore` mutation that begins with
`recordUndoSnapshot()`, undo restores the pre-op regions and redo re-applies —
identical to delete/wand/etc. (jit-ui#85). A merge that replaces 3 regions with 1
is a single undo step. Add explicit tests that undo/redo round-trips each op.

## 7. Rendering & GeoJSON for MultiPolygon (extends the holes plan)

- **OSD overlay** (`osd-region-overlay.ts`): render a `MultiPolygon` as one
  `<path>` with a subpath per part-exterior and per hole, `fill-rule="evenodd"`
  (the holes plan already moves holed polygons to `<path>`; MultiPolygon just
  adds more subpaths). Selection highlight + hit-test iterate parts.
- **Plotly** (`models/shape.ts`, `region.ts:getShape`): one shape `path` with all
  subpaths + `fillrule:'evenodd'`.
- **GeoJSON** (`plot.utilities.ts`): a `MultiPolygon` region ↔ GeoJSON
  `MultiPolygon` (`coordinates: [[exterior,...holes], ...]`); single-part stays a
  `Polygon`. QuPath round-trips both.
- **Hit-test**: inside == inside some part's exterior and not in that part's hole.

## 8. Phasing

0. **Holes** (`region-holes-design.md`) — prerequisite.
1. **MultiPolygon model** — type + `cloneBounds`/`regionsEqual` + render + hit-test
   + GeoJSON; no ops yet (build dark behind the holes flag).
2. **RegionOpsService** — merge, inverse, ungroup (raster); store methods + undo;
   unit tests on the pure service.
3. **Simplify** — `simplifyRing` (Douglas–Peucker) + store method + param UI.
4. **Context menu + Region Editor** — selection-aware items, wire commands.
5. **Docs/CHANGELOG/tests** + flag flip.

## 9. Decisions (resolved)

Chosen for architectural fit — each *extends* the flat, geometry-first,
raster-centric region subsystem instead of grafting a new paradigm onto it.

1. **Group semantics → geometric union → MultiPolygon.** Flat model, additive
   bounds type, maps 1:1 onto GeoJSON `MultiPolygon` and QuPath's own
   (JTS) geometry. A nested group *container* (tree) was rejected as it fights
   the flat model and isn't QuPath-encodable. §2.
2. **Boolean engine → raster/mask.** Same pipeline the wand/brush already use,
   so "select + merge" yields identical geometry to "brush together"; one code
   path, holes + multi-part for free, no new dependency. §3.
3. **Inverse bounds → full image rectangle.** Deterministic; independent of
   transient viewport/zoom state.
4. **Ungroup → split by connected components.** Geometric merge is lossy by
   design; *undoing* a merge is the undo stack's job, not ungroup's. §3.
5. **Simplify → Douglas–Peucker**, epsilon = "altitude threshold" in image
   pixels; default ≈2 px (range 0.5–20). §3, §5.3.

**Deferred (product call, not architectural):** a *reversible* logical group, if
ever wanted, is a flat `groupId?` tag on `Region` (not a hierarchy), and is a
separate, additive feature from the lossy geometric Merge. §2.

## 10. Testing

- `region-ops.spec` (pure): merge of two overlapping rects → one part; merge of
  two disjoint rects → MultiPolygon with two parts; inverse of a centred blob →
  image rect with one hole; inverse of two blobs → one part, two holes; ungroup
  of a 2-part region → two regions; simplify reduces vertex count and respects
  epsilon; degenerate rings dropped.
- `region-store.spec`: each store op records exactly one undo entry; undo→redo
  round-trips; selection ends on the result.
- `plot.utilities.spec`: MultiPolygon GeoJSON export→import round-trip; QuPath
  MultiPolygon fixture imports.
- Render specs: MultiPolygon → `<path>` with the right subpath count + evenodd.
- Manual: select two regions in the editor and on the plot → Merge; Inverse;
  Simplify with a couple of thresholds; Ungroup; undo/redo each.

## 11. Risks

- **Refactor surface** — adding `MultiPolygon` touches every `instanceof` site;
  do the audit in §2 first and land Phase 1 behind the holes flag.
- **Raster fidelity / memory** — merge/inverse rasterize the selection (bounded
  by its bbox, not the whole image) and trace contours. **Mitigated (jit-ui#85):**
  `RegionOpsService.MAX_OP_PIXELS` (16 MP) caps the working raster — a selection
  whose clipped bbox exceeds it is rasterized at a proportional downscale and the
  traced polygons are scaled back to full image coordinates. Without this, a
  large-extent selection on a whole-slide image (e.g. a region spanning a
  119040×90112 NDPI) allocates a multi-GB `Uint8Array` (typed-array length error)
  and freezes the tab.
  - **Trade-off:** the cap is deliberately low so the op stays a sub-second,
    synchronous, undo-tracked main-thread call (a worker would complicate the
    undo flow). Selections within 16 MP keep **full resolution** (`scale === 1`,
    byte-identical to the original path); only very large-extent selections are
    downscaled, which **coarsens their boundary** (error ≈ a few full-res px) and
    can drop sub-pixel holes. Acceptable for selection set-ops; raise
    `MAX_OP_PIXELS` to trade responsiveness for fidelity, or move the op to a
    worker for exact full-res geometry without blocking.
  - The mask export (jit-ui#95) has the analogous cap `MAX_MASK_PIXELS` (100 MP)
    in `region-editor/mask-raster.ts`, but runs in a Web Worker and records the
    original resolution + scale in the PNG metadata, so it is non-blocking and
    traceable rather than fidelity-capped on the main thread.
- **Plotly even-odd multi-subpath fill** — same open risk as the holes plan;
  spike before committing the Plotly path; OSD is the primary Image-view backend.
- **Ungroup ≠ inverse-of-merge** — connectivity split won't recover overlapped
  originals; set expectations in the tooltip/help.
