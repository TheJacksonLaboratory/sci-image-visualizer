import { Subscription } from 'rxjs';
import { heightField, histogramScalar } from 'napari-js';
import type { SurfaceLayer } from 'napari-js';

import { IChannelState, IHistogram } from '../../contracts/channel-histogram-api.contract';
import { ISurface3dControls } from '../../contracts/visualizer.contract';
import { formatUm } from '../../overlays/scale-bar-core';
import { AxisLabelSpec } from './napari-axes-labels';
import { Axes3dGizmo, surface3dControls } from './napari-axes-gizmo';
import {
  LumaPlane, SURFACE_Z_ASPECT, VOLUME_FETCH_CONCURRENCY, isServerlessMultichannel, mapPool,
  stackDepth, surfaceResolutionFor, toIHistogram, toNapariGamma,
} from './napari-helpers';
import type { NapariScene, SceneContext } from './napari-scene';

/**
 * NAPARI_SURFACE (review Appendix B, cluster G): the slice as a height field. A height field is
 * single-scalar, so for a multichannel image the surface follows ONE band — the pane-selected
 * channel — coloured by that channel's window/colormap (like the Plotly SURFACE, which is
 * grayscale-only). Every slice's plane is pre-loaded with a progress bar (as the volume does) so
 * the stack slider re-slices instantly. All mesh + GPU work lives in napari-js (`heightField` +
 * `Viewer.addSurface`); this scene supplies scalar slices.
 */
export class SurfaceScene implements NapariScene {
  /** The height-field mesh (null until the first build). */
  layer: SurfaceLayer | null = null;
  /** Which band the surface samples (a channel index for multichannel, else the composite). */
  private channel: number | undefined = undefined;
  /** True when the surface follows one band of a multichannel image. */
  private multichannel = false;
  /** Pre-loaded per-slice luminance planes (already decimated to the surface grid), keyed by z,
   *  so the stack slider rebuilds the surface instantly. Filled by {@link preloadPlanes}. */
  readonly planes = new Map<number, LumaPlane>();
  /** The preload in flight; a newer one (a channel switch) aborts it. */
  private preload: AbortController | null = null;
  /** In-plane grid cap for this load (full grid ÷ the decimate factor). */
  private maxGrid = surfaceResolutionFor(1).maxGrid;
  /** Contrast window [min,max] the current mesh was built with. A change reshapes the mesh (pixel
   *  height = intensity within [min,max]), so it triggers a geometry rebuild. */
  private window: [number, number] | null = null;
  /** The current slice's plane, for the intensity histogram. */
  private histogramPlane: Uint8Array | null = null;
  private gizmo: Axes3dGizmo | null = null;
  private displaySub: Subscription | null = null;

  constructor(private readonly ctx: SceneContext) {}

  async mount(): Promise<void> {
    const { ctx } = this;
    const desc = await ctx.tiles.ensureDescriptor(ctx.info());
    const info = ctx.info();
    // Serverless multichannel (tiled:false + channelUrls) has no descriptor — detect
    // it from imageMeta so the Surface still follows one band.
    const simpleMc = isServerlessMultichannel(ctx.tiles.isSimple(info), info);
    this.multichannel = simpleMc || (!!desc?.multichannel && (desc?.channels ?? 1) > 1);
    // A height field is single-scalar → follow the pane-SELECTED channel.
    this.channel = this.multichannel ? ctx.store.currentSelectedChannel() : undefined;
    this.maxGrid = surfaceResolutionFor(ctx.settings.resolutionScale).maxGrid;
    await this.preloadPlanes();
    if (ctx.signal.aborted) return;
    await this.build(ctx.z());
    this.installAxes();
    // Subscribe after the first build so display-state edits target a live layer.
    this.followDisplayState();
  }

  /** One slice → one mesh: re-build the height field for the new slice. Not built yet → nothing to
   *  do; the build at the end of the mount reads the current slice. */
  setZ(z: number): void {
    if (!this.layer) return;
    void this.build(z).catch((err) => console.error('[napari-js] setZIndex surface failed:', err));
  }

  /** The current slice's intensity histogram (the plane the mesh was built from). */
  histogram(_channel: number, bins: number): IHistogram | null {
    const plane = this.histogramPlane;
    return plane ? toIHistogram(histogramScalar(plane, bins, 0, 255)) : null;
  }

  surface3dControls(): ISurface3dControls | null {
    return this.layer ? surface3dControls(this.ctx, () => this.gizmo, () => this.layer) : null;
  }

  dispose(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = null;
    this.preload?.abort();
    this.preload = null;
    this.planes.clear();
    this.gizmo?.destroy();
    this.gizmo = null;
  }

  /** Add the axes gizmo + labels around the (origin-centered) mesh, matching the volume. The box
   *  tracks the mesh bounds, X/Y show the physical (or pixel) extent, and Z is the intensity axis. */
  private installAxes(): void {
    if (!this.layer) return;
    const { ctx } = this;
    const b = this.layer.bounds();
    const boxW = Math.max(1, b.max[0] - b.min[0]);
    const boxH = Math.max(1, b.max[1] - b.min[1]);
    const boxD = Math.max(1, b.max[2] - b.min[2]);
    const desc = ctx.tiles.currentDescriptor(ctx.info());
    const mppX = ctx.tiles.mppX(ctx.info());
    const imageW = ctx.imageSize().width;
    const voxel = mppX > 0 ? (mppX * (desc?.width ?? imageW)) / Math.max(1, imageW) : 1;
    this.gizmo = new Axes3dGizmo(
      ctx.viewer, ctx.host, { width: boxW, height: boxH, depth: boxD },
      this.axesLabels(boxW, boxH, boxD, mppX),
      { visible: ctx.settings.axesVisible, voxelSize: [voxel, voxel, 1] },
    );
  }

  /** X/Y/Z end-labels for the gizmo: X/Y are the physical (µm) or pixel extent of the FULL image;
   *  Z is the intensity/height axis. Anchors are in the centered box (matching AxesLayer). */
  private axesLabels(boxW: number, boxH: number, boxD: number, mppX: number): AxisLabelSpec[] {
    const hx = boxW / 2;
    const hy = boxH / 2;
    const hz = boxD / 2;
    const desc = this.ctx.tiles.currentDescriptor(this.ctx.info());
    const size = this.ctx.imageSize();
    const descW = desc?.width ?? size.width;
    const descH = desc?.height ?? size.height;
    const len = (px: number): string => (mppX > 0 ? formatUm(px * mppX) : `${px} px`);
    return [
      { anchor: [hx, -hy, -hz], text: `X · ${len(descW)}`, color: '#ed4545' },
      { anchor: [-hx, hy, -hz], text: `Y · ${len(descH)}`, color: '#4dd959' },
      { anchor: [-hx, -hy, hz], text: 'Z · intensity', color: '#668cff' },
    ];
  }

  /**
   * Pre-fetch every stack slice's luminance plane (decimated to the surface grid) into
   * {@link planes}, driving the stack progress — the same load-with-progress UX as the volume, but
   * keeping one 2D plane per slice rather than packing a 3D volume. Bounded concurrency keeps the
   * connection pool busy without flooding it on a deep stack.
   */
  async preloadPlanes(): Promise<void> {
    const { ctx } = this;
    // A channel switch starts a new preload while this one may still be in flight: the newer
    // one owns the plane cache and the progress bar from here on.
    this.preload?.abort();
    const preload = new AbortController();
    this.preload = preload;
    const loading = ctx.loading(); // bail on a Cancel / new plot while we fetch
    const stale = (): boolean => preload.signal.aborted || loading.aborted || ctx.signal.aborted;
    const depth = stackDepth(ctx.info()) || 1;
    const { maxGrid } = surfaceResolutionFor(ctx.settings.resolutionScale);
    this.planes.clear();
    ctx.stack.loading(true);
    ctx.stack.progress(0);
    try {
      let done = 0;
      const slices = Array.from({ length: depth }, (_, z) => z);
      await mapPool(slices, VOLUME_FETCH_CONCURRENCY, async (z) => {
        try {
          const plane = await this.fetchPlane(z, maxGrid);
          // Superseded while in flight: this plane may be the OLD band, and the cache is not
          // this preload's any more.
          if (stale()) return;
          this.planes.set(z, plane);
        } catch (err) {
          if (stale()) return;
          console.warn(`[napari-js] surface slice ${z} preload failed`, err);
        }
        done++;
        ctx.stack.progress(Math.round((done / depth) * 100));
      }, stale);
    } finally {
      // Only the newest preload ends the progress bar; a superseded one would hide it while
      // its successor is still loading.
      if (this.preload === preload) {
        this.preload = null;
        ctx.stack.loading(false);
        ctx.stack.progress(0);
      }
    }
  }

  /** Slice `z` as a whole-image luminance plane of the surface's band, decimated to `maxGrid`. */
  fetchPlane(z: number, maxGrid: number): Promise<LumaPlane> {
    return this.ctx.tiles.fetchPlane(this.ctx.info(), z, this.channel, maxGrid);
  }

  /** The channel state driving the surface: the chosen band for multichannel (matched by index),
   *  else the single grayscale channel. */
  private channelState(channels: IChannelState[]): IChannelState | undefined {
    if (this.channel == null) return channels[0];
    return channels.find((s) => s.index === this.channel) ?? channels[0];
  }

  /**
   * (Re)build the mesh for slice `z` from the pre-loaded plane cache (instant — this is what the
   * stack slider calls); a slice missing from the cache is fetched on demand. napari-js's pure
   * `heightField` builds the triangle grid (z = normalized intensity), then `addSurface` renders
   * it. The slice plane also feeds the intensity histogram.
   */
  private async build(z: number): Promise<void> {
    const { ctx } = this;
    let plane = this.planes.get(z);
    if (!plane) {
      ctx.stack.loading(true);
      try {
        plane = await this.fetchPlane(z, this.maxGrid);
        this.planes.set(z, plane);
      } catch (err) {
        console.error('[napari-js] surface slice fetch failed:', err);
      } finally {
        ctx.stack.loading(false);
      }
    }
    if (!plane || plane.width < 2 || plane.height < 2 || ctx.signal.aborted) return;

    const st = this.channelState(ctx.store.currentChannelStates());
    const win: [number, number] = [st?.min ?? 0, st?.max ?? 255];
    this.window = win;
    // Height AND colour are normalized by the same contrast window, so changing min/max reshapes the
    // surface (a pixel's height = its intensity within [min,max]). Center it for the axes gizmo. The
    // plane is already decimated to the grid cap → stride 1.
    const zScale = SURFACE_Z_ASPECT * Math.max(plane.width, plane.height);
    const { vertices, faces, values } = heightField(plane.data, plane.width, plane.height, {
      zScale,
      zLimits: win,
      center: true,
    });

    // A re-slice / window rebuild keeps the orbit camera: the viewer's `fit3d: 'once'` frames only
    // the scene's first 3D add, so stepping the stack or changing the window keeps the pose.
    if (this.layer) {
      ctx.viewer.layers.remove(this.layer);
      this.layer = null;
    }
    this.layer = ctx.viewer.addSurface(vertices, faces, values, {
      colormap: ctx.display.volumeColormap(st),
      contrastLimits: win,
      gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
      wireframe: ctx.settings.surfaceWireframe,
    });

    ctx.setImageSize(plane.width, plane.height);
    this.histogramPlane = plane.data;
    ctx.tools.scheduleReadback();
  }

  /** The store colormap / reverse / invert / channel window → the surface, so histogram & channel
   *  dialog edits update it live without a re-fetch. **min/max reshapes the surface's height** (a
   *  pixel's height = its intensity within [min,max]), so a window change rebuilds the mesh
   *  geometry (from the cached slice); colour-only edits (colormap/LUT, gamma, reverse, invert)
   *  just update the layer's uniforms. */
  private followDisplayState(): void {
    const { ctx } = this;
    this.displaySub = ctx.display.watch((channels, selected) => {
      const layer = this.layer;
      if (!layer || ctx.signal.aborted) return;
      // Selected channel changed (multichannel): re-fetch THAT band's planes and
      // rebuild the height-field for the current slice.
      if (this.multichannel && selected !== this.channel) {
        this.channel = selected;
        void (async () => {
          await this.preloadPlanes();
          if (!ctx.signal.aborted) await this.build(ctx.z());
        })().catch((err) => console.error('[napari-js] surface channel switch failed:', err));
        return;
      }
      const st = this.channelState(channels);
      const win: [number, number] = [st?.min ?? 0, st?.max ?? 255];
      const windowChanged = !this.window || win[0] !== this.window[0] || win[1] !== this.window[1];
      if (windowChanged) {
        // Height follows the contrast window → rebuild the mesh for the new [min,max] (camera kept).
        void this.build(ctx.z()).catch((err) =>
          console.error('[napari-js] surface window rebuild failed:', err),
        );
        return;
      }
      // Colour-only change: update uniforms in place, no geometry rebuild.
      layer.colormap = ctx.display.volumeColormap(st);
      if (st) {
        layer.contrastLimits = win;
        layer.gamma = toNapariGamma(st.gamma); // ImageJ γ → napari-js γ
      }
      ctx.viewer.requestRender();
    });
  }
}
