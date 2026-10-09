# Bug: colormap can't be changed after switching to another image (OSD)

> **Historical — fixed bug write-up, filed against jit-ui before the library was extracted; paths and line numbers may no longer match.**

_Filed: 2026-06-04 · Repo: **jit-ui** · Area: visualization / OSD viewer · Status: ✅ Fixed_

## Resolution

Root cause was **not** the `isGrayscaleImage` gate or a stale flag (both candidate
causes in the original analysis below were ruled out via live console tracing — the
flag is correct and `requestInvalidate(true)` restores original grayscale tiles). The
real cause is a **lifetime mismatch**:

`OpenSeadragonVisualizerService` is `@Injectable({ providedIn: 'root' })` — a singleton
whose constructor (the only place the colormap subscription was created) runs **once**.
But `VisualizationComponent.ngOnDestroy()` → `plotService.unsubscribe()` →
`osd.unsubscribe()` calls `this.colormapSub.unsubscribe(); this.colormapSub = null`.
On the first image switch that destroys + recreates the component, the singleton's
colormap subscription is gone **permanently** — nothing rebuilds it. After that, the
dropdown still calls `setColormap` → `colormap$.next(...)`, but the OSD side has no
listener, so the recolor never re-runs (the colormap is "stuck"). Image-type
independent — reproduced switching between any OSD grayscale images.

**Fix** (commit pending): extracted the subscription into an idempotent
`ensureColormapSubscription()` (no-ops if already subscribed) and call it from both the
constructor **and** the top of `plot()`, so an image load after a component teardown
re-establishes it. Verified live: after a switch, `colormap$` emissions reach the OSD
recolor pipeline again and the image recolors.

The candidate root causes in the original write-up below are retained for history but
were **not** the actual defect.

## Symptom

1. Open an image in the OSD ("image" plot type), change the colormap → it updates correctly.
2. Click a **different** image.
3. Changing the colormap now does nothing — the view is **stuck on the last colormap picked**.

(Reproduced with grayscale images — DICOM `case1_008.dcm`, mask `002_masks.png`. The
colormap only applies to grayscale images.)

## Where it is

`apps/jit-ui/src/app/services/visualization/implementations/osd/openseadragon-visualizer.service.ts`

The colormap is applied client-side: a subscription rebuilds the LUT and forces the
viewer to re-run its recolor pipeline. The re-render is **gated**:

```ts
// colormap subscription handler (~line 145), set up once in the constructor (~line 129)
this.colorLut = buildColormapLut(cm?.data?.value, !!rev);
if (this.viewer && this.isGrayscaleImage) {           // ← gate
  this.viewer.world.requestInvalidate(true);          // re-runs recolorTile with the new LUT
  this.viewer.navigator?.world?.requestInvalidate(true);
}
```

So a colormap change is silently ignored whenever **`this.isGrayscaleImage`** (or
`this.viewer`) is false for the current image.

## Likely cause

`this.isGrayscaleImage` is (re)assigned during `plot()`:

```ts
// plot() / mount
if (inPlace && this.viewer) return Promise.resolve(true);   // ~line 259 — EARLY RETURN
...
this.isGrayscaleImage = !!imageInfo?.isGrayscale;           // ~line 269 — set AFTER the early return
this.destroyViewer();
this.viewer = OpenSeadragon({ ... });
```

Two candidate root causes (confirm via the console log below):

1. **Early-return skips the update** — if the second image load reaches line 259 with
   `inPlace && this.viewer` truthy, it returns **before** line 269, leaving
   `isGrayscaleImage` at its previous value. (Stale state across image switches.)
2. **`imageInfo.isGrayscale` not populated** for the second image → `isGrayscaleImage`
   becomes `false` → the gate blocks the re-render even though the image is grayscale.

The subscription itself is fine — it's created once in the constructor and reads
`this.viewer` / `this.isGrayscaleImage` at fire time, so it survives image switches.

## How to confirm (1 minute, no code change)

The handler already logs to the **browser console** on every colormap change:

```
[CMAP sub] fired label=… isGray=… viewer=… -> invalidate=…
```

Change the colormap on the *second* image and read that line:
- `isGray=false` → cause #1 or #2 above (the gate is blocking).
- `viewer=false` → the viewer reference was lost.
- `invalidate=true` but still no visual change → the problem is downstream in
  `recolorTile` / tile invalidation, not the gate.

## Proposed fix

- Set `this.isGrayscaleImage` (and refresh `this.descriptor`/viewer state) **before** the
  `inPlace && this.viewer` early-return — or don't early-return for a genuine image
  switch — so the flag always reflects the currently-displayed image.
- Verify `imageInfo.isGrayscale` is computed and passed on every image load (not just the
  first). Trace where `imageInfo.isGrayscale` originates (← `rgbChannels === 1`) and
  confirm it's set for the second image.
- After fixing, **remove the `[CMAP sub]`/`[plot]` debug `console.log`s** left in the
  service.
- Add a guard so the colormap change still re-renders if the image is grayscale even when
  the flag was set late.

## Related (sibling OSD/visualization issues)

- **DICOM/mask render as a flat colored rectangle** in the OSD image mode (works in
  heatmap) — a value-normalization/windowing gap; see
  `docs/history/bug-osd-image-normalization.md` (primary fix is front-end auto-range in
  `recolorTile`, same file as this bug).
- **`getExistingThumbnail(null)` NPE** for these images — tracked/fixed on the
  jit-service side.

This doc is the **jit-ui** half: the colormap-stuck-on-image-switch state bug.
