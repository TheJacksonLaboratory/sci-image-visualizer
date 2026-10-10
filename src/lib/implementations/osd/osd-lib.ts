import * as OpenSeadragon from 'openseadragon';

/**
 * The real OpenSeadragon object, normalized for the packaged (FESM) build.
 *
 * OpenSeadragon ships as plain CommonJS (`module.exports = OpenSeadragon`, no
 * `__esModule` flag). Bundled into this library's FESM and re-bundled by a
 * consuming app, `import * as OpenSeadragon` resolves to a synthesized ES
 * namespace whose only reliable slot is `.default` (the real `module.exports`).
 * The factory itself and every static member (Viewer, Point, Rect, TileSource, …)
 * live on that object, NOT on the namespace — so `OpenSeadragon(...)` or
 * `new OpenSeadragon.Point()` against the namespace fail once packaged
 * ("is not a function" / "not a constructor"). Normalize ONCE here and import
 * { OSD } wherever a runtime VALUE is needed; import the `openseadragon` namespace
 * directly only for its TYPES (e.g. `OpenSeadragon.Viewer`).
 *
 * (plotly.js-dist-min needs no equivalent: it sets `__esModule`, so webpack gives
 * it real named exports and plain member access works.)
 */
export const OSD: typeof OpenSeadragon = (OpenSeadragon as any).default ?? OpenSeadragon;

/**
 * Run an operation on an OSD tiled image, navigator or viewer that may already
 * have been torn down (a slice evicted mid-load, the viewer destroyed during an
 * animation or a timed refit). A throw there is expected and harmless, so it is
 * only logged at debug level instead of being swallowed silently.
 */
export function quiet(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.debug('[OSD] ignored error from a torn-down viewer item', err);
  }
}
