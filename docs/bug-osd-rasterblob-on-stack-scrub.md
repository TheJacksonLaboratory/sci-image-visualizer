# Bug: `unsupported type 'rasterBlob' for the target drawer` when scrubbing a tiled multichannel z-stack

_Filed: 2026-07-28 · Repo: **sci-image-visualizer** (`src/lib/implementations/osd`) · Status:
⏸ Deferred — fix intentionally held until the jit-service multichannel gate is fixed (see
[Why this is deferred](#why-this-is-deferred))_

## Symptom

Scrubbing the z-slider on a **tiled, multichannel** image floods the console:

```
Attempt to draw tile cache Cache rasterBlob [used e.g. by 6/17_28] with unsupported type 'rasterBlob' for the target drawer!
Attempt to draw tile cache Cache rasterBlob [used e.g. by 6/17_27] with unsupported type 'rasterBlob' for the target drawer!
```

One line per affected tile, typically several adjacent tiles at the same pyramid level.

**Impact is cosmetic-plus:** OpenSeadragon recovers on its own. The statement immediately
after the error is `this.prepareForRendering(drawer); return undefined;` — it converts the
cache and draws the tile on a later frame. So the visible cost is console noise plus at
most a one-frame gap per affected tile while dragging. Nothing renders permanently wrong.

## Root cause

`rasterBlob` is OpenSeadragon's own cache type for a tile whose bytes arrived as a `Blob`
(openseadragon 6.0.2, `context.finish(blb, request, "rasterBlob")`). The WebGL/Canvas
drawer cannot draw that type — the cache has to be converted to something drawable first.
OSD's guard says as much:

```js
// Ensure cache in a format suitable for the current drawer. If not it is an error,
// prepareForRendering should be called at the end of invalidation routine instead.
const supportedTypes = drawer.getSupportedDataFormats();
if (!supportedTypes.includes(this.type)) { ... }
```

In our `tile-invalidated` pipeline the conversion is only ever **committed** by the final

```ts
try {
  await event.setData(ctx, 'context2d');
} catch {
  /* tile evicted */
}
```

and `recolorChannelTile` has several paths that return before reaching it —
`openseadragon-visualizer.service.ts:1776` (no pixels obtainable), `:1780` / `:1784` (no
2D context), `:1802` (`!changed`, nothing opaque to tint) — plus that last line
deliberately swallows the failure.

Scrubbing is what makes those paths hot. Each slice change reveals one cached channel
group and hides the others (`slice-cache.ts` `revealChannelSlice` /
`invalidateChannelDisplay`), so tiles get evicted **while the `await`s above are still in
flight**. `setData` then throws on a dead canvas, we swallow it as designed, and the cache
is left holding `rasterBlob` — which the drawer then refuses.

So the error is not a decode or a server problem. It is a lifetime race: _we bail out of
the invalidation routine without leaving the cache in a drawable type._

## Why it only shows up now

This is the first time the **per-channel tiled** path has ever run on a **z-stack**:

- No previously bundled tiled demo image is a stack — `cmu-1`, `bc18` and `sirius-red` are
  all `z: 1`, so `revealChannelSlice` had nothing to churn.
- On the JAX Image Tools dev instance the same files fall through jit-service's
  `TileService.isMultichannelComposite()` LUT gate and are served as a flat composite, so
  `isMultiChannel` is false and `recolorChannelTile` never executes at all.

It surfaced locally only because the example tile server now serves a genuine
`multichannel: true` z-stack (see [Reproducing](#reproducing)).

## Why this is deferred

The LUT gate in jit-service has been **masking** this. Fixing that gate is what makes the
per-channel tiled path reachable in production — and that is precisely when this error
starts appearing for real users on stacks. The two are sequenced:

1. Fix `isMultichannelComposite()` so a LUT-less fluorescence stack is flagged
   multichannel (the actual reported bug: channels not rendering / pane toggles inert).
2. Then apply the fix below, because step 1 is what turns this from a local-only
   annoyance into a user-visible one.

Doing 2 first would be fixing a path nothing currently reaches.

## Fix (planned, not yet applied)

Guarantee that **every** exit path leaves the cache in a drawer-supported type, instead of
relying on OSD to error and re-prepare:

```ts
/** OSD draws straight from the cache, and a tile fetched as a Blob ('rasterBlob') is
 *  not a drawable type — so any early return must still leave a converted context
 *  behind, or the drawer errors and has to re-prepare it a frame later. */
private async ensureDrawable(event: any, ctx: CanvasRenderingContext2D | null): Promise<void> {
  if (!ctx) return;
  try { await event.setData(ctx, 'context2d'); } catch { /* tile really is gone */ }
}
```

Then replace the bare `return`s in `recolorTile` / `recolorChannelTile` with
`return this.ensureDrawable(event, ctx);`.

Note the `!ctx` case still returns without committing — if we could not obtain a context at
all there is nothing to hand back, and OSD's own `prepareForRendering` recovery remains the
correct fallback for that (rarer) path.

### Verifying the fix

Scrub the full stack end to end, in both directions, with the console open:

- no `unsupported type 'rasterBlob'` lines
- no `internal cache non-ready state` lines (the sibling guard a few lines below in OSD)
- tiles keep painting while dragging (no one-frame gaps)

## Reproducing

Needs a tiled image that is multichannel **and** a z-stack — the example tile server can
build one from an ImageJ hyperstack:

```bash
cd examples/tile-server
node scripts/make-cog.mjs <imagej-hyperstack.tif> project002-stack --channels auto --slices auto
npm start
# then, in the repo root:
VITE_TILE_SERVER=http://localhost:8090/ npm run start:example
```

Open the stack entry from the tiled section of the gallery and drag the z-slider. (Built
locally from `Project002-8-CR_series2_st_8bit_BFlif.tif` — 2 channels × 27 slices,
`multichannel: true`, `realLevels: 7`.)

## Affected files

- `src/lib/implementations/osd/openseadragon-visualizer.service.ts` — `recolorTile`
  (~1688), `recolorChannelTile` (~1759); the early returns listed above
- `src/lib/implementations/osd/slice-cache.ts` — `revealChannelSlice`,
  `invalidateChannelDisplay`: the eviction churn that makes the race hot

## Related

- jit-service `TileService.isMultichannelComposite()` — the LUT gate that currently masks
  this path; fixing it is the prerequisite (step 1 above)
- openseadragon 6.0.2 cache-type conversion (`learn("rasterBlob", "image", …)` and
  friends) and the `getSupportedDataFormats()` drawer guard
