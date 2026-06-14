# Region holes (donuts) — implementation plan

**Status:** proposed · **Owner:** TBD · **Tracking:** jit-ui#85 (brush) + follow-up

## 1. Problem

Brushing a ring that encloses an unpainted area produces a **filled disc, not a
donut**. The same applies to the wand and to any mask-derived region
(segmentation): an enclosed background hole is silently filled.

Two root causes, both structural:

1. **The boundary tracer returns only the outer contour.**
   `WandService.maskToPolygons()` labels 4‑connected foreground components and
   traces each with `mooreBoundary()` — the *outer* ring only. Interior holes
   are never traced.
   `libs/jax-image-visualization/src/lib/toolbar/wand/wand.service.ts:243` (and
   `:288`, `:644`).

2. **The neutral region model is a single ring.**
   `Polygon` holds one ring (`xpoints` / `ypoints` / `coordinates`); there is no
   concept of interior rings.
   `libs/jax-image-visualization/src/lib/models/region.ts:142`.

Every downstream consumer — both renderers, GeoJSON I/O, hit‑testing, area,
vertex editing — assumes one ring. Donuts therefore cannot be *represented*,
not merely cannot be *drawn*.

## 2. Goal

A closed polygon region can carry zero or more **interior rings (holes)**.
Holes are produced by the mask tools (brush, wand, segmentation), render with
even‑odd fill on both backends, round‑trip through GeoJSON (QuPath‑compatible),
are excluded from hit‑testing and area, and survive Bézier conversion and the
per‑image cache / undo snapshots.

Non‑goal for the first cut: hole‑aware *vertex editing* (grab/insert/delete a
vertex on a hole ring). See §7.

## 3. Data model

Add an optional interior‑ring list to `Polygon`; the existing fields stay the
exterior ring (fully backward compatible — absent/empty `holes` == today).

```ts
// models/region.ts — class Polygon
/**
 * Interior rings (holes). Each ring is a list of [x, y] image-pixel pairs in
 * the SAME closed-polygon convention as the exterior (no repeated closing
 * point). Present only on closed polygons. A point inside the exterior but
 * inside any hole is OUTSIDE the region (even-odd rule).
 */
holes?: number[][][];
```

Why `number[][][]` (rings of `[x,y]`) and not nested `Polygon`s: holes need only
geometry, never their own colour/label/bezier handles; this keeps cloning,
GeoJSON, and equality trivial. Bézier holes are out of scope (§7), so a hole
never needs handles.

**Touch points that must clone/compare the new field:**
- `RegionStore.cloneBounds()` — deep‑copy `holes`
  (`store/region-store.service.ts:490`). This is also what undo/redo snapshots
  use (`cloneRegion` → `cloneBounds`), so holes ride along for free.
- `RegionStore.regionsEqual()` — compare holes for the append‑dedupe path
  (`:508`).

## 4. Phased plan

Each phase is independently shippable and leaves the build green. Gate the
user‑visible behaviour behind a `regionHoles` capability/flag (see §8) until the
renderers + I/O all land, so partial phases can merge without shipping
half‑rendered donuts.

### Phase 1 — Tracing: detect and emit holes

`WandService.maskToPolygons()` (`wand.service.ts:243`):

1. After labelling foreground components, **find holes**: flood‑fill background
   (value 0) 4‑connected from the mask‑bbox border. Any background pixel *not*
   reached is enclosed → belongs to a hole.
2. Group enclosed background into its own connected components; trace each with
   `mooreBoundary()`.
3. **Attribute** each hole to the foreground label that surrounds it (sample a
   4‑neighbour foreground pixel of any hole‑boundary pixel; all such neighbours
   share one label for a true hole).
4. Emit holes on the matching `Polygon` (translate + clamp coords exactly like
   the exterior loop at `:293`).
5. Respect a `minHoleSize` (reuse/mirror `minSize`) so 1–2px noise holes don't
   create specks.

Output stays `Polygon[]`; polygons now may carry `holes`. `labelsToPolygons`
(`:318`) inherits this automatically.

**`rasterizePolygon()` (`wand.service.ts:161`) must punch holes back out** so the
adopt/merge round‑trip (brush re‑rasterizes an adopted region into the stroke
accumulator) preserves them — otherwise re‑tracing fills the donut on the next
tick. Fill the exterior, then zero every pixel inside a hole ring.

### Phase 2 — Hit-testing & area

- `WandService.pointInPolygon()` (`wand.service.ts:115`): inside ==
  in‑exterior **and** not‑in‑any‑hole. Callers: brush `tryAdoptShapeAt`
  (`brush-tool.service.ts:398`), wand adopt, overlay selection.
- Region area (wherever computed for the Regions tab / sorting): subtract hole
  areas (shoelace per ring). Audit `getRegionPolygons()`
  (`region-store.service.ts:122`) consumers.

### Phase 3 — Rendering (both backends, even-odd fill)

**OpenSeadragon overlay** (`implementations/osd/osd-region-overlay.ts:262`): a
closed polygon currently renders as `<polygon points=…>`. For a polygon *with
holes*, render a `<path>` with one subpath per ring (`M…L…Z M…L…Z`) and
`fill-rule="evenodd"`. The bezier branch already emits `<path>` via
`bezierPathD()` (`:362`) — factor a shared `polygonPathD(poly)` that appends
hole subpaths, used by both. No‑hole polygons keep the existing `<polygon>` path
to minimise churn.

**Plotly** (`models/region.ts:75` `getShape()` → shape `path`): append a
`M…L…Z` subpath per hole to the path string and set the shape's
`fillrule: 'evenodd'`. Verify Plotly fills multi‑subpath shapes with even‑odd
(spike first; if not, gate Plotly donuts off and rely on OSD, which is the
Image‑view brush backend anyway).

### Phase 4 — GeoJSON I/O (QuPath round-trip)

GeoJSON `Polygon.coordinates` is already `[exterior, hole1, hole2, …]`, so this
is natural and QuPath‑compatible.

- **Export** `exportROIsToGeoJson()` (`plot.utilities.ts:523`): emit
  `coordinates: [ring, ...holeRings]` instead of `[ring]`. Each hole ring closed
  (first point repeated), same as the exterior.
- **Import** `importROIsFromGeoJson()` (`plot.utilities.ts:437`): read
  `coordinates[1..]` into `polygon.holes`. The rectangle‑detection special‑case
  (`:424`) only inspects `coordinates[0]`, so a holed polygon won't be
  misread as a rectangle — but add a guard: never treat a multi‑ring polygon as
  a rectangle.

### Phase 5 — Brush wiring & flag flip

The brush already commits whatever `maskToPolygons` returns
(`brush-tool.service.ts:248`, `commitComponents` `:465`), so once Phases 1–4
land it produces donuts with no further change. Flip the `regionHoles` flag on,
update the Regions help dialog (`toolbar.component.html`) and CHANGELOG.

## 5. Files touched (summary)

| Area | File | Change |
|------|------|--------|
| Model | `models/region.ts` | add `Polygon.holes` |
| Trace | `toolbar/wand/wand.service.ts` | hole detection in `maskToPolygons`, punch holes in `rasterizePolygon`, hole‑aware `pointInPolygon` |
| Store | `store/region-store.service.ts` | clone/compare holes (`cloneBounds`, `regionsEqual`) |
| Render | `implementations/osd/osd-region-overlay.ts` | even‑odd `<path>` for holed polygons |
| Render | `models/region.ts` (`getShape`) + Plotly shape build | hole subpaths + `fillrule` |
| I/O | `plot.utilities.ts` | export/import hole rings |
| UI/docs | `toolbar/toolbar.component.html`, `CHANGELOG.md` | help text + release note |

## 6. Testing

- **wand.service.spec** — `maskToPolygons` on a ring mask yields one polygon
  with one hole; nested/multiple holes; a hole below `minHoleSize` is dropped; a
  hole touching the bbox border is *not* a hole (it's an inlet).
  `pointInPolygon` false inside a hole, true in the solid annulus.
  `rasterizePolygon` of a holed polygon leaves the hole empty.
- **region-store.spec** — `cloneBounds`/undo snapshot preserves holes (no
  aliasing); `regionsEqual` distinguishes same‑exterior/different‑holes on
  append.
- **plot.utilities.spec** — GeoJSON export→import round‑trips a donut; a QuPath
  fixture polygon with an interior ring imports as a hole; rectangle detection
  unaffected.
- **osd-region-overlay.spec** — a holed polygon renders a `<path>` with
  `fill-rule="evenodd"` and N+1 subpaths.
- Manual: brush a ring in Image view → donut; erase across it; export → reopen.

## 7. Out of scope (follow-ups)

- **Hole vertex editing** — grabbing/inserting/deleting vertices on a hole ring
  in the OSD overlay (`startEdit`/handles at `osd-region-overlay.ts:190`). First
  cut renders + hit‑tests holes but only the exterior ring is vertex‑editable;
  the vertex eraser may still delete hole vertices via mask retrace.
- **Bézier holes** — holes are straight rings only; `toBezier` smooths the
  exterior, holes stay polygonal (document the limit, or smooth all rings later).
- **Self‑touching donuts** — a stroke whose ring closes to exactly 1px wide may
  trace as a hairline rather than a hole; acceptable.

## 8. Rollout & risk

- **Flag:** add `regionHoles` to the viewer capability set (or a simple build
  flag) so Phases 1–4 can merge dark; the brush keeps filling until Phase 5
  flips it. Avoids shipping export‑with‑holes before render‑with‑holes.
- **Backward compatibility:** `holes` is optional; every existing region has
  none, so all paths behave exactly as today when it's absent. Old GeoJSON (one
  ring) imports unchanged.
- **Main risks:** (a) Plotly even‑odd multi‑subpath fill may not behave —
  spike in Phase 3 before committing the Plotly path; (b) hole attribution to
  the wrong component in touching blobs — covered by tests; (c) performance of
  background flood‑fill — bounded by the stroke bbox, negligible.
