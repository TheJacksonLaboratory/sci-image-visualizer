import { Subscription, combineLatest } from 'rxjs';
import type * as OpenSeadragon from 'openseadragon';

import { quiet } from './osd-lib';
import { DisplayPipeline } from './display-pipeline';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { buildColormapLut, Rgb } from '../../contracts/colormap-lut';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';

/** The service state the recolorer reads — live, so it follows a viewer rebuild. */
export interface TileRecolorHost {
  viewer(): OpenSeadragon.Viewer | null;
  isGrayscale(): boolean;
  isMultiChannel(): boolean;
  /** Serverless multichannel: recolor by re-compositing the cached planes. */
  isSimpleMultichannel(): boolean;
  currentZ(): number;
  /** Re-apply the current slice's per-channel visibility (multichannel). */
  revealChannelSlice(z: number): void;
  /** Invalidate only the visible slice's channel images (multichannel). */
  invalidateChannelDisplay(z: number): void;
  /** Re-composite the serverless-multichannel planes for display round `token`. */
  recomposite(token: number): void;
}

/** The tile-invalidated event's pixel accessors (OSD 5+/6), as used here. */
interface TileEvent {
  tile?: { getUrl?: () => string; url?: string };
  getData(type: string): Promise<unknown>;
  setData(data: unknown, type: string): Promise<unknown>;
}

type TilePixels = { ctx: CanvasRenderingContext2D; img: ImageData };

/**
 * Client-side display for OpenSeadragon tiles: window/gamma/colormap/invert and
 * per-channel tints, applied through OSD's `tile-invalidated` pixel pipeline.
 *
 * Owns the display state mirrored from the shared {@link VisualizerStore} (the
 * LUT, the channel states, invert) and the recolor invariant: invalidations are
 * coalesced to one per animation frame, and every round captures
 * {@link displayToken} — a round that a newer one has superseded must not write
 * its pixels back.
 */
export class OsdTileRecolorer {
  /** Pixel display pipeline (window/gamma/invert/colormap + additive tint) —
   *  shared by tile recoloring, the serverless compositor and the composite
   *  export so they stay identical (see DisplayPipeline). */
  readonly display = new DisplayPipeline({
    isGrayscale: () => this.host.isGrayscale(),
    colorLut: () => this.colorLut,
    channelStates: () => this.channelStates,
    invertBg: () => this.invertBg,
  });
  /** 256-entry RGB LUT for the active colormap, applied to grayscale tiles
   *  (mirrors Plotly's heatmap colorscale). Null while options resolve;
   *  recoloring is skipped until it's built. */
  colorLut: Rgb[] | null = null;
  /** Latest per-channel display state (window/gamma/visibility) from the store,
   *  read synchronously by recolorTile. Channel 0 drives grayscale windowing;
   *  R/G/B (indices 0-2) drive RGB per-channel windowing. */
  channelStates: IChannelState[] = [];
  /** Inverted background (white = zero): inverts the windowed value before the
   *  gamma and the LUT (grayscale) / per channel before the additive merge (RGB
   *  and multichannel), as napari-js does. */
  invertBg = false;
  /** Bumped by every display invalidation. A recolor round captures it and, after
   *  each `await`, abandons the tile once a newer round has started. Writing a
   *  superseded context back is not merely wasted work: OSD's conversion sees a
   *  canvas the newer round already replaced, throws `DOMException`, and
   *  `_handleConversionError` DESTROYS the cache record and unloads the tile
   *  (unlike the drawer's rasterBlob path, it does not re-prepare). Enough of
   *  those and the viewer goes white mid-drag. */
  displayToken = 0;
  /** Pending coalesced invalidation (see {@link scheduleInvalidate}). */
  private invalidateHandle: number | null = null;
  private sub: Subscription | null = null;

  constructor(
    private readonly host: TileRecolorHost,
    private readonly store: VisualizerStore,
  ) {}

  /** Whether display round `token` is still the current one. */
  isCurrent(token: number): boolean {
    return token === this.displayToken;
  }

  /**
   * Subscribe to the shared VisualizerStore colormap/reverse so OSD recolors in
   * lock-step with Plotly. Idempotent and self-healing: the service is a root
   * singleton, but `unsubscribe()` (called on VisualizerComponent destroy)
   * tears the subscription down — and the constructor never runs again. So
   * `plot()` calls this to re-establish it after a component teardown/recreate
   * (e.g. switching images), otherwise colormap changes would be silently
   * dropped on every image after the first switch.
   */
  ensureSubscription(): void {
    if (this.sub) return;
    // Colormap/reverse + per-channel window/gamma/visibility + invert all live in
    // the shared VisualizerStore. Rebuild the LUT and re-run the pixel pipeline
    // whenever any of them changes, so the Channels & Histogram pane updates the
    // image live and OSD stays in lock-step with Plotly.
    this.sub = combineLatest([
      this.store.getColormap(),
      this.store.getReverseScale(),
      this.store.getChannelStates(),
      this.store.getInvert(),
    ]).subscribe(([cm, rev, channels, invert]) => {
      this.colorLut = buildColormapLut(cm?.data?.value, !!rev);
      this.channelStates = channels;
      this.invertBg = !!invert;
      // Multichannel: each channel is its own TiledImage — visibility is the
      // image's opacity (window/gamma/colour are applied by recolorChannelTile
      // on the invalidate below). Re-applying the current slice's reveal picks up
      // the new per-channel visibility (cached slices stay hidden).
      if (this.host.isMultiChannel()) {
        this.host.revealChannelSlice(this.host.currentZ());
      }
      // requestInvalidate(true) restores each tile to its original data before
      // re-running recolorTile, so a change always maps afresh (no compounding).
      // RGB now recolors too (per-channel window/visibility), so don't gate on
      // grayscale. Coalesced: PrimeNG's slider fires (onChange) continuously, so
      // a single drag would otherwise queue dozens of overlapping restore +
      // re-process rounds over every channel image. (Serverless multichannel
      // re-composites from its cached planes instead — see invalidateDisplay.)
      this.scheduleInvalidate();
    });
  }

  /** Tear the store subscription down and drop a queued invalidation, so it
   *  can't fire against a torn-down viewer. */
  unsubscribe(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    if (this.invalidateHandle !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.invalidateHandle);
      else clearTimeout(this.invalidateHandle as unknown as ReturnType<typeof setTimeout>);
      this.invalidateHandle = null;
    }
  }

  /** Seed the Intensity channel with a measured auto-window while it's still
   *  at full range (never clobber the user's manual window); if the user
   *  already windowed, just re-invalidate so painted tiles pick the LUT up. */
  seedGrayWindow(min: number, max: number): void {
    const ch0 = this.store.currentChannelStates()[0];
    if (ch0 && ch0.min === 0 && ch0.max === 255) {
      this.store.setChannelState(0, { min, max });
    } else if (this.host.viewer() && this.colorLut) {
      // Coalesced (and visible-slice-only for multichannel) — not a raw
      // whole-world restore + re-recolor per sampled slice.
      this.scheduleInvalidate();
    }
  }

  /**
   * Hook a freshly opened viewer (and its navigator, a separate mini-viewer with
   * its own tiles that doesn't receive the main viewer's events) into the pixel
   * pipeline, and paint what is already loaded when there is anything to apply.
   */
  attach(viewer: OpenSeadragon.Viewer): void {
    // The handler runs per tile on load (and on requestInvalidate); recoloring
    // is a no-op for RGB images at default display or before the LUT resolves.
    viewer.addHandler('tile-invalidated', (event) => this.recolorTile(event as unknown as TileEvent));
    viewer.navigator?.addHandler('tile-invalidated', (event) => this.recolorTile(event as unknown as TileEvent));
    if ((this.host.isGrayscale() && this.colorLut) || this.host.isMultiChannel()) this.invalidateWorld();
  }

  /** Collapse a burst of display-state changes into ONE invalidation on the next
   *  frame. Dragging a window slider emits per pixel of travel, and each round
   *  restores and re-processes every tile of every channel — so the burst is both
   *  wasted work and the race that breaks cache records (see {@link displayToken}).
   *  The store write stays live, so the pane itself remains responsive. */
  scheduleInvalidate(): void {
    if (this.invalidateHandle !== null) return; // already queued for this frame
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    this.invalidateHandle = raf(() => {
      this.invalidateHandle = null;
      this.invalidateDisplay();
    });
  }

  /** Re-apply the display pipeline (window/gamma/colour/invert) after a state change.
   *  Multichannel invalidates ONLY the visible slice's channel images — invalidating
   *  the whole world would re-process every hidden/preloaded slice's tiles (hundreds),
   *  flooding OSD with "[CacheRecord] … InvalidStateError" and wasting work on tiles
   *  that aren't on screen. The other cached slices are marked stale and re-tinted
   *  lazily when revealed. Composite/grayscale invalidate the world; serverless
   *  multichannel re-composites its cached planes. */
  invalidateDisplay(): void {
    // Supersede any in-flight recolor round before restarting one (see displayToken).
    this.displayToken++;
    if (!this.host.viewer()) return;
    if (this.host.isSimpleMultichannel()) {
      this.host.recomposite(this.displayToken);
      return;
    }
    if (this.host.isMultiChannel()) {
      this.host.invalidateChannelDisplay(this.host.currentZ());
      return;
    }
    this.invalidateWorld();
  }

  /** Restore and re-recolor every tile of the main viewer and the navigator. */
  invalidateWorld(): void {
    const v = this.host.viewer();
    if (!v) return;
    quiet(() => v.world.requestInvalidate(true));
    quiet(() => v.navigator?.world?.requestInvalidate(true));
  }

  /**
   * Recolor a grayscale tile through the active colormap LUT, using OSD's
   * tile-invalidated pixel pipeline (OSD 5+/6). Maps each pixel's grayscale
   * value (r==g==b) to the LUT's RGB. No-op for RGB images or until the LUT is
   * built. Handler is async — OSD awaits it (raiseEventAwaiting).
   */
  async recolorTile(event: TileEvent): Promise<void> {
    if (this.host.isMultiChannel()) {
      await this.recolorChannelTile(event);
      return;
    }
    const token = this.displayToken;
    if (this.host.isGrayscale()) {
      if (!this.colorLut) return;
    } else if (!this.display.rgbNeedsRecolor()) {
      return; // RGB at default (all visible, full window, γ=1, no invert) → passthrough
    }

    const px = await this.readTilePixels(event);
    if (!px || !this.display.applyToRgba(px.img.data)) return; // nothing opaque
    await this.writeTilePixels(event, px, token);
  }

  /**
   * Tint a single channel's tile in place. Each channel is its own OpenSeadragon
   * TiledImage (a single-band grayscale tile); OSD composites the N images
   * additively ('lighter') in its drawer — so this just maps the tile's intensity
   * through the channel's window/gamma and its pseudo-colour. Synchronous (no
   * cross-tile fetch) → no race, no seams. Channel is parsed from the tile URL.
   */
  async recolorChannelTile(event: TileEvent): Promise<void> {
    const token = this.displayToken;
    const tile = event?.tile;
    const url: string = (tile && (typeof tile.getUrl === 'function' ? tile.getUrl() : tile.url)) || '';
    const m = /[?&]channel=(\d+)/.exec(url);
    const ch = m ? parseInt(m[1], 10) : 0;
    const st = this.channelStates[ch];

    const px = await this.readTilePixels(event);
    if (!px) return;

    // Precompute lum(0..255) → tinted RGB once, then map each pixel by lookup —
    // the channel tile is single-band, so this turns ~262k per-pixel
    // channelIntensity() (with Math.pow for gamma) calls into 256 — the difference
    // between a snappy and a sluggish slider on a 4-channel stack.
    const { r: rL, g: gL, b: bL } = this.display.channelRgbLut(st);
    const d = px.img.data;
    let changed = false;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const lum = r >= g ? (r >= b ? r : b) : g >= b ? g : b; // single-band → max
      d[i] = rL[lum];
      d[i + 1] = gL[lum];
      d[i + 2] = bL[lum];
      changed = true;
    }
    if (!changed) return;
    await this.writeTilePixels(event, px, token);
  }

  /**
   * Read a tile's pixels for recoloring. Prefers the tile's rendering context,
   * but some tile caches (ajax PNG blobs) convert to an *empty* context2d —
   * recoloring that would blank the tile (white canvas). So if the context has
   * no opaque pixels, the tile's own bitmap/image is drawn to a scratch canvas
   * and read instead. Null when no pixels can be read: leave the tile untouched.
   */
  private async readTilePixels(event: TileEvent): Promise<TilePixels | null> {
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = (await event.getData('context2d')) as CanvasRenderingContext2D;
    } catch {
      /* try the bitmap below */
    }
    if (ctx && ctx.canvas && ctx.canvas.width && ctx.canvas.height) {
      let img: ImageData | null = null;
      try {
        img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      } catch {
        /* tainted/gone */
      }
      if (img && hasOpaque(img.data)) return { ctx, img };
    }
    type Drawable = CanvasImageSource & { width: number; height: number };
    let src: Drawable | null = null;
    try {
      src = (await event.getData('imageBitmap')) as Drawable;
    } catch {
      /* try the image below */
    }
    if (!src || !src.width) {
      try {
        src = (await event.getData('image')) as Drawable;
      } catch {
        /* none */
      }
    }
    if (!src || !src.width) return null;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const scratch = c.getContext('2d', { willReadFrequently: true });
    if (!scratch) return null;
    scratch.drawImage(src, 0, 0);
    return { ctx: scratch, img: scratch.getImageData(0, 0, c.width, c.height) };
  }

  /** Write recolored pixels back to the tile — unless a newer display round
   *  (`token`, see {@link displayToken}) has already restored it: writing a
   *  superseded context back makes OSD's conversion throw DOMException, which
   *  destroys the cache record and unloads the tile. */
  private async writeTilePixels(event: TileEvent, px: TilePixels, token: number): Promise<void> {
    if (token !== this.displayToken) return;
    px.ctx.putImageData(px.img, 0, 0);
    // The tile's cache can still be evicted between the awaits and here (a
    // slice change), making setData throw a DOMException on a dead canvas.
    // Swallow it — the tile is gone, so there's nothing to recolor.
    try {
      await event.setData(px.ctx, 'context2d');
    } catch {
      /* tile evicted */
    }
  }
}

/** True if any pixel in the RGBA buffer is non-transparent. */
function hasOpaque(d: Uint8ClampedArray): boolean {
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 0) return true;
  }
  return false;
}
