import { OSD } from './osd-lib';
import { OSD_ZOOM_PER_SCROLL } from './osd-zoom';

/**
 * Quiet OpenSeadragon's "[Viewport.*] is not accurate with multi-image" advisories.
 * A multichannel image is composited from one TiledImage per channel — a legitimate
 * multi-image world — and OSD logs that advisory (at error level) from its own
 * navigator/overview rendering on every animation frame, flooding the console. Our
 * own image<->viewport conversions already route through world item 0 (see
 * osd-coords), so the remaining advisories are OSD-internal and only affect the
 * minimap's box accuracy (cosmetic). This wraps OSD's logger in a Proxy that drops
 * only that one message string and forwards every other log untouched. Idempotent.
 */
export function silenceOsdMultiImageAdvisory(): void {
  const osd: any = OSD as any;
  if (osd.__multiImageFilterInstalled) return;
  const base: any = (osd.console && typeof osd.console.error === 'function')
    ? osd.console
    : (typeof console !== 'undefined' ? console : null);
  if (!base) return;
  const isAdvisory = (a: unknown) =>
    typeof a === 'string' && a.indexOf('not accurate with multi-image') !== -1;
  osd.console = new Proxy(base, {
    get(target: any, prop: string) {
      const orig = target[prop];
      if ((prop === 'error' || prop === 'warn') && typeof orig === 'function') {
        return (...args: any[]) => { if (isAdvisory(args[0])) return; orig.apply(target, args); };
      }
      return typeof orig === 'function' ? orig.bind(target) : orig;
    },
  });
  osd.__multiImageFilterInstalled = true;
}

/** What {@link buildViewerOptions} needs to know about the viewer being mounted. */
export interface ViewerOptionsInput {
  /** The DOM id OSD mounts into. */
  id: string;
  /** Show the overview navigator (minimap). */
  navigatorVisible: boolean;
  /** Bilinear smoothing; false gives crisp nearest-neighbour pixels. */
  smoothing: boolean;
  /** Bearer token for OSD's own tile fetches (its loader bypasses HttpClient). */
  authHeaders: Record<string, string>;
  /** Slices in the image (1 for a single image). */
  sliceCount: number;
  /** How many slices the slice cache keeps resident (see SliceCache.maxSlices). */
  maxSlices: number;
}

/**
 * The options object handed to the OpenSeadragon factory. Pure: every value
 * that depends on the service comes in through `input`.
 *
 * These are OSD config keys, not library code: OSD silently falls back to its
 * own default when one is misspelled or renamed upstream, so the values we rely
 * on are pinned by `openseadragon-viewer-options.spec.ts`.
 */
export function buildViewerOptions(input: ViewerOptionsInput): Record<string, unknown> {
  return {
    id: input.id,
    // Simple-mode z-scrub calls viewer.open() again per slice (see
    // setZIndex) — without this it resets to the home zoom/pan on every
    // slice change. Tiled mode never re-opens (it toggles pre-added
    // TiledImages' opacity instead), so this is a no-op there.
    preserveViewport: true,
    // Use the 2D canvas drawer, not WebGL: creating/destroying a viewer on
    // each engine toggle / image load churns WebGL contexts (browsers cap
    // how many exist at once), which surfaces as "WebGL context was lost"
    // and blank tiles. The canvas drawer has no such limit.
    drawer: 'canvas',
    showNavigationControl: false, // avoids needing the icon-image assets
    // Overview thumbnail with the current-viewport rectangle, bottom-right.
    showNavigator: input.navigatorVisible,
    // Nearest-neighbour when off → crisp pixels on zoom-in (pixel inspection).
    imageSmoothingEnabled: input.smoothing,
    navigatorPosition: 'BOTTOM_RIGHT',
    navigatorSizeRatio: 0.16,
    navigatorAutoFade: false,
    navigatorBackground: 'rgba(0,0,0,0.5)',
    loadTilesWithAjax: true,
    ajaxWithCredentials: true, // cookie auth (oauth2-proxy)
    ajaxHeaders: input.authHeaders, // bearer auth (Auth0), when available
    crossOriginPolicy: 'Anonymous',
    // Gentler zoom: the default (1.2) feels fast and big jumps cross several
    // pyramid levels at once, firing a burst of tile requests. Shared with the
    // region overlay, which takes the wheel over while a tool is active.
    zoomPerScroll: OSD_ZOOM_PER_SCROLL,
    // Click-to-zoom toward the clicked point (OpenSeadragon's default demo
    // behaviour). Only applies when no region tool is active — an active tool
    // disables OSD mouse-nav so clicks draw/select instead of zooming.
    gestureSettingsMouse: { clickToZoom: true, scrollToZoom: true },
    // Zoom limits (jit-ui#94). Default minZoomImageRatio (0.9) stops you from
    // zooming the image smaller than ~home; drop it so the image can be shrunk
    // freely (effectively no minimum). Default maxZoomPixelRatio (1.1) caps
    // zoom-in at ~1 screen px per image px; raise it so you can zoom in to
    // inspect individual pixels (paired with imageSmoothingEnabled=false for
    // crisp nearest-neighbour blocks).
    minZoomImageRatio: 0.01,
    maxZoomPixelRatio: 20,
    // OSD's stock value, restored. DO NOT RAISE IT: the name reads like
    // "minimum sharpness" but it is the opposite. From OSD's own
    // TiledImage._getLevelsInterval:
    //
    //   highestLevel = floor( log2( currentZeroRatio / minPixelRatio ) )
    //
    // minPixelRatio is a floor on how small a tile pixel may shrink, and it
    // DIVIDES into the ratio - so raising it lowers the chosen level, i.e.
    // picks a COARSER image. OSD's own comment on the default says as much:
    // "closer to 0 draws tiles meant for a higher zoom at this zoom".
    //
    // Measured on a flat 22304x24528 image (levels 697/1394/2788/5576/11152/
    // 22304), predicted level matching actual in all nine trials:
    //
    //            zoom 2        zoom 8        ~1:1
    //   1.0      1.34x up      1.34x up      1.86x up
    //   0.5      0.67x (none)  0.67x (none)  0.93x -> full res
    //   0.25     0.33x         0.33x         0.93x
    //
    // 0.5 is what gives "never upscaled below native, full resolution at 1:1".
    // 0.25 is not better - it jumps two rungs finer and fetches ~4x the tiles
    // for no visible gain, and tiles are not cached by the ingress.
    minPixelRatio: 0.5,
    // Wait for the view to settle before pulling new tiles (less churn).
    immediateRender: false,
    animationTime: 0.4,
    // Release memory aggressively: cap the tile cache so tiles outside the
    // current view (e.g. the coarser levels left behind after zooming in) are
    // evicted instead of accumulating. Large whole-slide tiles — doubled when
    // the colormap pipeline keeps a recolored copy — make an unbounded cache
    // costly. Tunable; lower = less memory, more re-fetch on pan-back.
    // Stacks keep many slices resident (the whole stack is background-loaded),
    // so they get a much larger tile budget — otherwise switching slices evicts
    // each other's tiles and scrubbing back re-fetches. Scaled to the resident
    // slice count; single images keep the lean default.
    maxImageCacheCount: input.sliceCount > 1 ? Math.min(2400, Math.max(600, input.maxSlices * 40)) : 150,
  };
}
