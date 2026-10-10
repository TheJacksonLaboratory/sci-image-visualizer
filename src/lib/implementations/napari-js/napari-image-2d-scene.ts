import { Subscription } from 'rxjs';
import { MultiChannelImageView, histogramScalar } from 'napari-js';
import type { ChannelView, PointsLayer, TiledSource } from 'napari-js';

import { IChannelState, IHistogram } from '../../contracts/channel-histogram-api.contract';
import { TileDescriptor } from '../tile-server';
import { regionCentroids } from '../region-centroids';
import { NapariScaleBar } from './napari-scale-bar';
import { NapariNavigator } from './napari-navigator';
import { LumaPlane, tintFor, tintedComposite, toIHistogram, toNapariGamma, typedPlane } from './napari-helpers';
import type { NapariScene, SceneContext } from './napari-scene';

/** What the scenes built over the 2D image add to it. */
export interface Image2dOptions {
  /** Draw the loaded image (false: an image-less spatial dataset, the observations alone). */
  image?: boolean;
  /** Whether to fit the camera to the image once it is drawn (default: when there is one). */
  fit?: () => boolean;
  /** After a slice change. `rerendered` when the stitched path re-rendered the image — which
   *  CLEARS the layer list, taking every other layer with it. */
  onSlice?: (rerendered: boolean) => void;
  /** The navigator is being dragged. */
  onNavigatorInteract?: () => void;
}

/**
 * The 2D image (review Appendix B, cluster E): pyramidal `TiledSource`s against the `/tile`
 * endpoint when `/tiles/info` describes the image, else a single stitched level (`tiled:false`
 * stacks fetch each slice's own URL); multichannel additive tints, grayscale colormap or RGB; the
 * coarse histogram samples of the tiled path, the scale bar, the overview navigator and the 2D
 * interaction stack (region overlay + pixel tools). The region-centroid scatter and the spatial
 * 2D scene are built over it.
 */
export class Image2dScene implements NapariScene {
  /** How the image is composited (drives the histogram and the display-state updates). */
  imageMode: 'grayscale' | 'multichannel' | 'rgb' = 'rgb';
  /** True when the image is rendered via pyramidal TiledSources (descriptor available). */
  tiled = false;
  /** napari-js high-level view owning the per-channel layer set for {@link imageMode}. */
  private channelView: MultiChannelImageView | null = null;
  /** Latest wins for a stitched slice: a slow older slice can't clobber a newer one. */
  private sliceReq = 0;
  /** Coarse per-channel luminance sample (keyed by channel index) for the histogram in tiled mode,
   *  where the layers have no full in-memory pixels. Refreshed on mount + slice change. */
  readonly histSamples = new Map<number, Uint8Array>();
  /** Latest-wins token for {@link refreshHistogramSamples}. */
  private histGen = 0;
  /** Physical scale bar overlay (null when the image has no µm/pixel). */
  private scaleBar: NapariScaleBar | null = null;
  /** Overview minimap (bottom-right), as OSD's navigator. */
  private navigator: NapariNavigator | null = null;
  /** Bumped per thumbnail request, so a slow one cannot overwrite a newer slice's. */
  private navigatorToken = 0;
  /** The current slice's per-channel thumbnail bitmaps (multichannel only), kept so a tint or
   *  visibility change recolours the thumbnail without re-fetching it. */
  private navigatorChannels: ImageBitmap[] | null = null;
  /** The tints/visibility the thumbnail was last composited with — see {@link recolorNavigator}. */
  private navigatorTintKey = '';
  private displaySub: Subscription | null = null;

  constructor(
    private readonly ctx: SceneContext,
    private readonly opts: Image2dOptions = {},
  ) {}

  private get hasImage(): boolean {
    return this.opts.image !== false;
  }

  async mount(): Promise<void> {
    const { ctx } = this;
    const z = ctx.z();
    if (this.hasImage) await this.render(z);
    if (this.opts.fit ? this.opts.fit() : this.hasImage) ctx.fitCameraSoon();
    this.followDisplayState();
    // The scale bar and navigator describe an image; with none loaded, whatever they would
    // read is left over from the last one.
    if (this.hasImage) {
      this.installScaleBar();
      this.installNavigator(z);
    }
    ctx.tools.install2dInteraction(ctx.viewer, ctx.host);
  }

  setZ(z: number): void {
    const { ctx } = this;
    if (this.navigator) void this.refreshNavigatorImage(z);
    // Tiled: just move the dims plane — the tiled visual fetches the new slice's tiles (cached per
    // z), no layer rebuild. Refresh the coarse histogram sample for the new slice.
    if (this.tiled) {
      ctx.viewer.dims.z = z;
      const desc = ctx.tiles.currentDescriptor(ctx.info());
      if (desc) void this.refreshHistogramSamples(z, desc);
      this.opts.onSlice?.(false);
      ctx.tools.scheduleReadback();
      return;
    }
    // Stitch fallback: re-render the slice (re-fetches per-channel / composite). The token lets
    // render drop a superseded scrub so a slow older slice can't clobber a newer one.
    const req = ++this.sliceReq;
    void this.render(z, req)
      .then(() => {
        if (req !== this.sliceReq || ctx.signal.aborted) return;
        // AFTER the image, never before: the render clears the layer list, so whatever sits over
        // the image is wiped by the very image meant to sit under it.
        this.opts.onSlice?.(true);
        ctx.tools.scheduleReadback();
      })
      .catch((err) => console.error('[napari-js] setZIndex slice failed:', err));
  }

  histogram(channel: number, bins: number): IHistogram | null {
    const { tools, viewer } = this.ctx;
    // Tiled mode has no full in-memory pixels → use the coarse per-channel sample (RGB: readback).
    if (this.tiled) {
      if (this.imageMode === 'rgb') return tools.rgbHistogram(channel, bins);
      const sample = this.histSamples.get(this.imageMode === 'grayscale' ? 0 : channel);
      return sample ? toIHistogram(histogramScalar(sample, bins, 0, 255)) : null;
    }
    // Grayscale/multichannel (stitch): native per-channel histogram straight from the in-memory
    // scalar layer (no GPU readback). RGB: bin the displayed pixels' R/G/B byte (8-bit client path).
    const layer = this.channelView?.layers[this.imageMode === 'grayscale' ? 0 : channel];
    if (layer) {
      const h = viewer.layerHistogram(layer, bins);
      if (h) return toIHistogram(h);
    }
    if (this.imageMode === 'rgb') return tools.rgbHistogram(channel, bins);
    return null;
  }

  setImageSmoothing(enabled: boolean): void {
    // Apply live to the rendered image layers; baked into the next render too.
    this.channelView?.setInterpolation(enabled ? 'linear' : 'nearest');
  }

  setNavigatorVisible(visible: boolean): void {
    this.navigator?.setVisible(visible);
  }

  /** Show the navigator only for a dataset that brings pixels of its own (and when the user
   *  wants it): with no image of its own there is nothing for an overview to show. */
  showNavigatorFor(datasetHasPixels: boolean): void {
    this.navigator?.setVisible(datasetHasPixels && this.ctx.settings.navigatorVisible);
  }

  dispose(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = null;
    this.scaleBar?.destroy();
    this.scaleBar = null;
    this.navigator?.destroy();
    this.navigator = null;
    this.setNavigatorChannels(null);
    this.histGen++;
    this.histSamples.clear();
    this.channelView = null;
  }

  /**
   * Render slice `z`. With a server pyramid descriptor each layer is a pyramidal
   * {@link TiledSource}, so the view refines to higher resolution on zoom (like OSD) and sits
   * naturally in full-resolution coordinates; without one, the single-level stitch. Three display
   * modes either way: multichannel additive tint, grayscale colormap, RGB.
   */
  async render(z: number, token?: number): Promise<void> {
    const { ctx } = this;
    const scene = ctx.signal;
    const desc = await ctx.tiles.ensureDescriptor(ctx.info());
    // Reset into a newer scene while the descriptor was in flight: this render is superseded.
    if (scene.aborted) return;
    if (desc && desc.levels?.length) {
      if (token != null && token !== this.sliceReq) return;
      await this.renderTiled(z, desc, scene);
      return;
    }
    return this.renderStitched(z, token);
  }

  /** Single-level stitch fallback (no descriptor): the pre-tiling path. */
  private async renderStitched(z: number, token?: number): Promise<void> {
    const { ctx } = this;
    const info = ctx.info();
    const desc = await ctx.tiles.ensureDescriptor(info);
    const states = ctx.store.currentChannelStates();
    const channelCount = desc?.channels ?? (states.length || 1);
    const multichannel = !!desc?.multichannel && channelCount > 1;

    // 1) Fetch all pixel data BEFORE touching the viewer, so a superseded scrub can bail without
    //    having torn down the visible layers (avoids flicker / out-of-order layer state).
    let mode: 'grayscale' | 'multichannel' | 'rgb';
    let planes: LumaPlane[] = [];
    let bitmap: ImageBitmap | null = null;
    if (multichannel) {
      mode = 'multichannel';
      planes = await Promise.all(
        Array.from({ length: channelCount }, (_, c) => ctx.tiles.fetchChannelData(info, z, c)),
      );
    } else if (channelCount === 1) {
      mode = 'grayscale';
      // Composite fetch (no channel) → all overview levels usable, so a large grayscale image
      // selects a fitting downscaled level instead of the full-res real level (texture limit).
      planes = [await ctx.tiles.fetchChannelData(info, z)];
    } else {
      mode = 'rgb';
      bitmap = await ctx.tiles.fetchSlice(info, z);
    }

    // 2) Commit — unless a newer scrub superseded us or the scene was torn down.
    if ((token != null && token !== this.sliceReq) || ctx.signal.aborted) {
      bitmap?.close?.();
      return;
    }

    // The displayed texture may be a downscaled pyramid level; scale the layer into FULL-RESOLUTION
    // world coordinates (level-0 pixels) so the camera, readback and — critically — pre-saved
    // regions (stored in full-res coords, e.g. ndpi) all line up regardless of which level is shown.
    // This mirrors OSD, whose coordinate system is always level 0.
    const texW = mode === 'rgb' ? (bitmap as ImageBitmap).width : (planes[0]?.width ?? 0);
    const texH = mode === 'rgb' ? (bitmap as ImageBitmap).height : (planes[0]?.height ?? 0);
    const fullW = desc?.width || texW || 1;
    const fullH = desc?.height || texH || 1;
    const scale: [number, number] = [texW ? fullW / texW : 1, texH ? fullH / texH : 1];

    this.imageMode = mode;
    const interpolation: 'linear' | 'nearest' = ctx.settings.imageSmoothing ? 'linear' : 'nearest';
    this.channelView = new MultiChannelImageView(ctx.viewer);
    if (mode === 'multichannel') {
      const views = planes.map((d, c) => this.tintedChannelView(c, states, desc, typedPlane(d), scale));
      this.channelView.render('multichannel', views, { interpolation });
    } else if (mode === 'grayscale') {
      const view = this.grayscaleChannelView(states[0], typedPlane(planes[0]), scale);
      this.channelView.render('grayscale', [view], { interpolation });
    } else {
      this.channelView.render('rgb', [{ source: bitmap as ImageBitmap, scale }], { interpolation });
    }
    ctx.setImageSize(fullW, fullH);
  }

  /**
   * Render with pyramidal {@link TiledSource}s — the view refines to higher resolution as you
   * zoom in (the visual fetches the level whose texels ≈ screen pixels) and sits in full-res
   * coordinates so regions align. Same three modes as the stitch path. Per-channel layers use the
   * REAL pyramid levels (per-channel tiles only exist there); the composite uses all levels.
   */
  private async renderTiled(z: number, desc: TileDescriptor, scene: AbortSignal): Promise<void> {
    const { ctx } = this;
    const states = ctx.store.currentChannelStates();
    const channelCount = desc.channels ?? (states.length || 1);
    const multichannel = !!desc.multichannel && channelCount > 1;
    const interpolation: 'linear' | 'nearest' = ctx.settings.imageSmoothing ? 'linear' : 'nearest';

    this.tiled = true;
    this.channelView = new MultiChannelImageView(ctx.viewer);

    if (multichannel) {
      this.imageMode = 'multichannel';
      const views = Array.from({ length: channelCount }, (_, c) =>
        this.tintedChannelView(c, states, desc, this.tiledSource(desc, c, 1, scene)),
      );
      this.channelView.render('multichannel', views, { interpolation });
    } else if (channelCount === 1) {
      this.imageMode = 'grayscale';
      const view = this.grayscaleChannelView(states[0], this.tiledSource(desc, undefined, 1, scene));
      this.channelView.render('grayscale', [view], { interpolation });
    } else {
      this.imageMode = 'rgb';
      this.channelView.render('rgb', [{ source: this.tiledSource(desc, undefined, 4, scene) }], {
        interpolation,
      });
    }
    ctx.setImageSize(desc.width, desc.height);
    // Await on the initial render so getHistogram/autoContrast have data immediately; slice changes
    // refresh fire-and-forget (the histogram pane retries).
    await this.refreshHistogramSamples(z, desc);
  }

  /** A pyramidal TiledSource whose tiles count on the loading badge while `scene` (the render that
   *  asked for it, taken before its awaits) is current. */
  tiledSource(
    desc: TileDescriptor,
    channel: number | undefined,
    channels: 1 | 4,
    scene: AbortSignal,
  ): TiledSource {
    return this.ctx.tiles.tiledSource(desc, channel, channels, scene, () => this.ctx.badge.begin('Image'));
  }

  /** Channel `c`'s layer in the additive multichannel composite: tinted by its display colour
   *  (store, else descriptor, else the Fiji palette), with its window, gamma and visibility. */
  private tintedChannelView(
    c: number,
    states: IChannelState[],
    desc: TileDescriptor | null,
    source: ChannelView['source'],
    scale?: [number, number],
  ): ChannelView {
    const st = states.find((s) => s.index === c);
    return {
      source,
      tint: st?.color ?? desc?.channelInfo?.[c]?.color ?? tintFor(c),
      name: st?.name ?? `ch${c}`,
      contrastLimits: [st?.min ?? 0, st?.max ?? 255],
      gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
      visible: st?.visible ?? true,
      invert: this.ctx.display.invert,
      ...(scale ? { scale } : {}),
    };
  }

  /** The single grayscale layer: the selected colormap, with the channel's window and gamma. */
  private grayscaleChannelView(
    st: IChannelState | undefined,
    source: ChannelView['source'],
    scale?: [number, number],
  ): ChannelView {
    return {
      source,
      colormap: this.ctx.display.grayscaleColormap(),
      contrastLimits: [st?.min ?? 0, st?.max ?? 255],
      gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
      invert: this.ctx.display.invert,
      ...(scale ? { scale } : {}),
    };
  }

  /** (Re)fetch a coarse per-channel luminance sample for the histogram (tiled mode has no full
   *  in-memory pixels). One cheap overview tile per channel, fetched together; cached by channel
   *  index. Latest wins: a scrub fires one refresh per slice, and an older slice's samples that
   *  land after a newer one's are dropped rather than shown as the current distribution. */
  async refreshHistogramSamples(z: number, desc: Pick<TileDescriptor, 'channels'>): Promise<void> {
    const gen = ++this.histGen;
    this.histSamples.clear();
    if (this.imageMode === 'rgb') return; // RGB uses the displayed-pixel readback (rgbHistogram)
    const multichannel = this.imageMode === 'multichannel';
    const channelCount = multichannel ? (desc.channels ?? 1) : 1;
    const info = this.ctx.info();
    const samples = await Promise.all(
      Array.from({ length: channelCount }, (_, c) =>
        // budget 1 → coarsest single tile; a failed channel leaves its sample unset.
        this.ctx.tiles.fetchChannelData(info, z, multichannel ? c : undefined, 1).then(
          (d) => d.data,
          () => null,
        ),
      ),
    );
    if (gen !== this.histGen) return;
    samples.forEach((data, c) => {
      if (data) this.histSamples.set(c, data);
    });
  }

  /** Channel states + grayscale colormap → live-apply to the rendered layers (no re-fetch; only z
   *  changes re-fetch), and recolour the navigator thumbnail. */
  private followDisplayState(): void {
    this.displaySub = this.ctx.display.watch((channels) => {
      this.applyDisplayState(channels);
      this.recolorNavigator();
    });
  }

  /** Apply the current channel states / colormap to the live layers (no re-fetch), delegating the
   *  per-channel layer mutations to the {@link MultiChannelImageView}. */
  private applyDisplayState(channels: IChannelState[]): void {
    const view = this.channelView;
    const { display } = this.ctx;
    if (!view) return;
    if (this.imageMode === 'multichannel') {
      view.layers.forEach((_, c) => {
        const st = channels.find((s) => s.index === c);
        if (!st) return;
        view.updateChannel(c, {
          tint: st.color,
          contrastLimits: [st.min, st.max],
          gamma: toNapariGamma(st.gamma), // ImageJ γ → napari-js γ
          visible: st.visible,
          invert: display.invert,
        });
      });
    } else if (this.imageMode === 'grayscale') {
      const st = channels[0];
      view.updateChannel(0, {
        colormap: display.grayscaleColormap(),
        invert: display.invert,
        ...(st ? { contrastLimits: [st.min, st.max] as [number, number], gamma: toNapariGamma(st.gamma) } : {}),
      });
    }
  }

  /** (Re)install the physical scale bar, sized from the image's µm/pixel (`/tiles/info` mppX,
   *  falling back to the image metadata). No-op without a physical size. */
  installScaleBar(): void {
    const { ctx } = this;
    this.scaleBar?.destroy();
    this.scaleBar = null;
    const mppX = ctx.tiles.mppX(ctx.info());
    if (mppX > 0) this.scaleBar = new NapariScaleBar(ctx.host, ctx.viewer.camera, mppX);
  }

  /**
   * The overview navigator: a coarse thumbnail of the whole image with the viewport on it; click
   * or drag to pan at the current zoom (as OSD).
   */
  private installNavigator(z: number): void {
    const { ctx } = this;
    this.navigator?.destroy();
    this.navigator = null;
    const { width, height } = ctx.imageSize();
    if (!width || !height) return;
    this.navigator = new NapariNavigator(ctx.host, ctx.viewer, width, height, () =>
      this.opts.onNavigatorInteract?.(),
    );
    this.navigator.setVisible(ctx.settings.navigatorVisible);
    void this.refreshNavigatorImage(z);
  }

  /**
   * Draw the navigator's thumbnail from the coarsest pyramid level. A multichannel image
   * is composited from its channels in their display colours (see {@link recolorNavigator}),
   * so the overview looks like the view rather than like channel 0 in grey.
   */
  private async refreshNavigatorImage(z: number): Promise<void> {
    const nav = this.navigator;
    if (!nav) return;
    const token = ++this.navigatorToken;
    const { tiles } = this.ctx;
    const info = this.ctx.info();
    try {
      const desc = await tiles.ensureDescriptor(info);
      // Superseded (a newer slice, or the scene was torn down): fetch nothing.
      if (token !== this.navigatorToken || this.navigator !== nav) return;
      const channels = desc?.multichannel ? (desc.channelInfo ?? []) : [];
      if (channels.length > 1) {
        const bitmaps = await Promise.all(channels.map((_c, c) => tiles.fetchSlice(info, z, c, 1)));
        if (token !== this.navigatorToken || this.navigator !== nav) return;
        this.setNavigatorChannels(bitmaps);
        this.recolorNavigator();
      } else {
        const image = await tiles.fetchSlice(info, z, undefined, 1);
        if (token !== this.navigatorToken || this.navigator !== nav) return;
        this.setNavigatorChannels(null);
        nav.setImage(image);
      }
    } catch (err) {
      console.warn('[napari-js] navigator thumbnail unavailable', err);
    }
  }

  /** Replace the per-channel thumbnail bitmaps (closing the previous ones). */
  private setNavigatorChannels(bitmaps: ImageBitmap[] | null): void {
    for (const bmp of this.navigatorChannels ?? []) bmp.close?.();
    this.navigatorChannels = bitmaps;
    this.navigatorTintKey = '';
  }

  /**
   * Composite the multichannel thumbnail in the channels' CURRENT display tints, skipping hidden
   * channels — the store's channel states, as the 2D layers use, not the server's defaults.
   * Re-run on every display-state change; it only redraws (never re-fetches), and only when a
   * tint or a visibility actually changed, so a window/gamma drag costs a string compare.
   */
  private recolorNavigator(): void {
    const nav = this.navigator;
    const bitmaps = this.navigatorChannels;
    if (!nav || !bitmaps) return;
    const info = this.ctx.tiles.currentDescriptor(this.ctx.info())?.channelInfo;
    const states = this.ctx.store.currentChannelStates();
    const shown = bitmaps
      .map((bmp, c) => {
        const st = states.find((s) => s.index === c);
        return { bmp, visible: st?.visible ?? true, color: st?.color ?? info?.[c]?.color ?? tintFor(c) };
      })
      .filter((ch) => ch.visible);
    const key = shown.map((ch) => `${bitmaps.indexOf(ch.bmp)}:${ch.color}`).join('|');
    if (key === this.navigatorTintKey) return;
    this.navigatorTintKey = key;
    nav.setImage(
      tintedComposite(
        shown.map((ch) => ch.bmp),
        shown.map((ch) => ch.color),
      ),
    );
  }
}

/**
 * NAPARI_SCATTER (review Appendix B, cluster H): the slice image with a points layer at each
 * region's centroid (the napari-js analog of Plotly's region-centroid scatter), rebuilt live as
 * regions change. This mode plots REGION centroids, so the image's region tools come with it —
 * drawing a region adds a point at once.
 */
export class ScatterRegionsScene implements NapariScene {
  readonly image: Image2dScene;
  private points: PointsLayer | null = null;
  private regionSub: Subscription | null = null;

  constructor(private readonly ctx: SceneContext) {
    this.image = new Image2dScene(ctx, {
      // The region-centroid points went with the re-render's layer clear.
      onSlice: (rerendered) => {
        if (rerendered && this.points) this.rebuildPoints();
      },
    });
  }

  async mount(): Promise<void> {
    await this.image.mount();
    this.rebuildPoints();
    this.regionSub = this.ctx.regionStore.getRegionUpdateEvent().subscribe(() => this.rebuildPoints());
    this.ctx.tools.scheduleReadback();
  }

  setZ(z: number): void {
    this.image.setZ(z);
  }

  histogram(channel: number, bins: number): IHistogram | null {
    return this.image.histogram(channel, bins);
  }

  setImageSmoothing(enabled: boolean): void {
    this.image.setImageSmoothing(enabled);
  }

  setNavigatorVisible(visible: boolean): void {
    this.image.setNavigatorVisible(visible);
  }

  dispose(): void {
    this.regionSub?.unsubscribe();
    this.regionSub = null;
    this.image.dispose();
  }

  /** (Re)build the point layer at the current region centroids. */
  private rebuildPoints(): void {
    const v = this.ctx.viewer;
    if (this.points) {
      v.layers.remove(this.points);
      this.points = null;
    }
    const centroids = regionCentroids(this.ctx.regionStore.getRegions());
    if (centroids.length === 0) return;
    this.points = v.addPoints(centroids, {
      size: 12,
      faceColor: [1, 0.85, 0.2, 1],
      borderColor: [0, 0, 0, 1],
      borderWidth: 2,
    });
  }
}
