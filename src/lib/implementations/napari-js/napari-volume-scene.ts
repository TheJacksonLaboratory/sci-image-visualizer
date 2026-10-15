import { Subscription } from 'rxjs';
import { MultiChannelVolumeView, histogramScalar } from 'napari-js';
import type { Points3DLayer, VolumeChannel } from 'napari-js';
import { formatLength } from 'napari-js/overlays';
import type { AxisLabelSpec } from 'napari-js/overlays';

import { IImageInfo } from '../../contracts/image.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { IIsosurfaceControls, ISurface3dControls } from '../../contracts/visualizer.contract';
import { NapariVolumeZHandle } from './napari-volume-z-handle';
import { AssembledVolume } from './napari-tile-client';
import { TileDescriptor } from '../tile-server';
import { Axes3dGizmo, Box3, surface3dControls } from './napari-axes-gizmo';
import {
  SCATTER3D_MAX_POINTS,
  SCATTER3D_MAX_XY,
  VOLUME_WORLD_INPLANE_REF,
  isServerlessMultichannel,
  stackDepth,
  tintFor,
  toIHistogram,
  toNapariGamma,
  volumeResolutionFor,
} from './napari-helpers';
import type { NapariScene, SceneContext, VolumeVoxelsOnScreen } from './napari-scene';
import { RegionMesh3D, VolumeFrame, VolumeRegionMeshes } from './napari-volume-region-meshes';
import { SlicePlanes, VolumeSlicePlanes } from './napari-volume-slice-planes';
import { RegionMeshPointer } from './napari-region-mesh-pointer';

/** The intensity histogram of an assembled uint8 channel (or the single grayscale volume, key 0). */
function channelHistogram(data: Map<number, Uint8Array>, channel: number, bins: number): IHistogram | null {
  if (!data.size) return null;
  const plane = data.get(channel) ?? data.get(0);
  return plane ? toIHistogram(histogramScalar(plane, bins, 0, 255)) : null;
}

/** Assemble `info`'s stack into a uint8 volume under the stack progress bar; null once `loading`
 *  aborts (a Cancel or a new plot). The caller owns the loading flag and takes `loading` once per
 *  load: a Cancel replaces `ctx.loading()`, and a multichannel volume assembles channels in turn. */
function assemble(
  ctx: SceneContext,
  info: IImageInfo | undefined,
  opts: { maxSlice?: number; sliceStep?: number },
  loading: AbortSignal,
  channel?: number,
): Promise<AssembledVolume | null> {
  return ctx.tiles.assembleVolume(info, opts, channel, {
    signal: loading,
    progress: (p) => ctx.stack.progress(p),
  });
}

/**
 * NAPARI_VOLUME / NAPARI_ISOSURFACE (review Appendix B, cluster F): the stack assembled into a
 * decimated volume — one additive, tinted `VolumeLayer` per channel for a multichannel image, a
 * single grayscale volume otherwise — with the axes gizmo and the in-view Z-height handle.
 */
export class VolumeScene implements NapariScene {
  /** napari-js high-level view owning the volume layers. */
  view: MultiChannelVolumeView | null = null;
  /** True when the volume is composited from per-channel layers (vs a single grayscale volume). */
  private multichannel = false;
  /** Volume world box at Z-scale 1 (base) + the sampled voxel depth — enough to recompute the
   *  Z-axis voxel scale, axes depth, and overlay anchors as the handle stretches Z. */
  private worldBase: Box3 | null = null;
  private sampledDepth = 1;
  private dims: Box3 | null = null;
  /** Assembled uint8 volume data per channel (key = channel index), kept for the volume intensity
   *  histogram. Key 0 holds the grayscale/composite volume in the single-channel case. */
  private readonly channelData = new Map<number, Uint8Array>();
  gizmo: Axes3dGizmo | null = null;
  private zHandle: NapariVolumeZHandle | null = null;
  private displaySub: Subscription | null = null;
  /** Regions' 3D reconstructions shown in the volume (see {@link setRegionMeshes}). */
  private readonly regionMeshes: VolumeRegionMeshes;
  /** The planes of the sections shown beside the volume, marked and draggable in it. */
  private readonly slicePlanes: VolumeSlicePlanes;
  /** The image's full size (px, px, slices), which reconstructions are in. */
  private fullSize: [number, number, number] | null = null;
  /** Clicks and hover on the reconstructions (with the selection tool). */
  private meshPointer: RegionMeshPointer | null = null;
  private toolSub: Subscription | null = null;
  private selecting = false;

  constructor(
    private readonly ctx: SceneContext,
    private readonly info: IImageInfo | undefined,
    private readonly rendering: 'iso' | 'mip',
  ) {
    this.regionMeshes = new VolumeRegionMeshes(ctx.viewer);
    this.slicePlanes = new VolumeSlicePlanes(ctx.viewer, ctx.host, ctx.viewer.camera3d, {
      onMove: (axis, value) => ctx.inZone(() => ctx.slicePlaneMoved(axis, value)),
    });
  }

  /** Show these region reconstructions in the volume (replacing the ones shown). */
  setRegionMeshes(meshes: readonly RegionMesh3D[]): void {
    this.regionMeshes.set(meshes);
  }

  setRegionHighlight(keys: readonly string[]): void {
    this.regionMeshes.setHighlight(keys);
  }

  setRegionHidden(keys: readonly string[]): void {
    this.regionMeshes.setHidden(keys);
  }

  /** Show the planes of the sections beside the volume where they are (null: hide one). */
  setSlicePlanes(planes: SlicePlanes): void {
    this.slicePlanes.set(planes);
  }

  /**
   * The assembled volume's voxels per channel (key 0: the grayscale one), its frame, and whether
   * it is a multichannel composite — what the sections beside it are cut from. Null before it is
   * assembled.
   */
  volumeVoxels(): VolumeVoxelsOnScreen | null {
    const base = this.worldBase;
    if (!this.dims || !base || !this.fullSize || !this.channelData.size) return null;
    const depth = base.depth * this.ctx.settings.volumeZScale;
    return {
      ...this.dims,
      channels: this.channelData,
      multichannel: this.multichannel,
      frame: { size: this.fullSize, world: [base.width, base.height, depth] },
    };
  }

  /**
   * Picking the reconstructions: with the selection tool armed, a click on one selects its class
   * (null beside them); resting over one names it, whatever the tool.
   */
  private listenToRegionMeshes(): void {
    const { ctx } = this;
    if (this.meshPointer) return;
    this.toolSub = ctx.store.getActiveTool$().subscribe((tool) => (this.selecting = tool === 'select'));
    this.meshPointer = ctx.outsideZone(
      () =>
        new RegionMeshPointer(ctx.canvas, ctx.host, {
          pickAt: (x, y) => this.regionMeshes.pickAt(x, y),
          active: () => this.selecting && this.regionMeshes.shown.length > 0,
          hoverable: () => this.regionMeshes.shown.length > 0,
          onPick: (key, additive) => ctx.inZone(() => ctx.regionMeshPicked(key, additive)),
        }),
    );
  }

  /** Image px per voxel of the assembled volume (in-plane), or null before it is assembled. */
  voxelStep(): number | null {
    return this.fullSize && this.dims ? this.fullSize[0] / Math.max(1, this.dims.width) : null;
  }

  /** Place the region reconstructions in the volume's world box as it is now. */
  private frameRegionMeshes(): void {
    const base = this.worldBase;
    if (!base || !this.fullSize) return;
    const depth = base.depth * this.ctx.settings.volumeZScale;
    const frame: VolumeFrame = { size: this.fullSize, world: [base.width, base.height, depth] };
    this.regionMeshes.setFrame(frame);
    this.slicePlanes.setFrame(frame);
  }

  /**
   * Assemble and render the volume, then add the axes gizmo + labels and the Z handle and follow
   * the display state.
   */
  async mount(): Promise<void> {
    const { ctx, info } = this;
    const loading = ctx.loading(); // bail before rendering on a Cancel / new plot
    const desc = await ctx.tiles.ensureDescriptor(ctx.info());
    // Serverless multichannel (tiled:false + channelUrls): no tile descriptor, so
    // derive the channel count from imageMeta and assemble each band from its own
    // channelUrls[z][c] plane (fetchImage does the per-channel routing).
    const simpleMc = isServerlessMultichannel(ctx.tiles.isSimple(info), info);
    const channelCount = simpleMc ? info!.imageMeta![0].channelCount : (desc?.channels ?? 1);
    const multichannel = simpleMc || (!!desc?.multichannel && channelCount > 1);

    this.channelData.clear();
    this.multichannel = multichannel;
    const view = new MultiChannelVolumeView(ctx.viewer);
    this.view = view;
    const { dims, channels } = await this.assembleChannels(desc, channelCount, loading);
    if (!dims || !channels.length || loading.aborted) return; // cancelled → don't render

    const world = this.worldBox(dims);
    // Base box (Z-scale = 1) + the sampled depth drive the live Z-height handle below; the persisted
    // `volumeZScale` (user drag) applies on top so changing resolution keeps the chosen height.
    this.worldBase = world;
    this.sampledDepth = Math.max(1, dims.depth);
    const worldZ = world.depth * ctx.settings.volumeZScale;
    const voxelSize: [number, number, number] = [
      world.width / dims.width,
      world.height / dims.height,
      worldZ / this.sampledDepth,
    ];
    for (const ch of channels) ch.voxelSize = voxelSize;

    view.render(this.multichannel ? 'multichannel' : 'grayscale', channels, { rendering: this.rendering });
    ctx.setImageSize(dims.width, dims.height);
    this.dims = dims;

    // 3D coordinate-axes / scale gizmo + labels, sharing the volume's world box so the gizmo tracks
    // the rendered proportions. Physical scale text still comes from the FULL image extent.
    const box = { width: world.width, height: world.height, depth: worldZ };
    this.gizmo = new Axes3dGizmo(ctx.viewer, ctx.host, box, this.axesLabels(box), {
      visible: ctx.settings.axesVisible,
    });
    // In-view drag handle at the TOP END OF THE Z AXIS (the box's min-XY corner, where the blue
    // "Z" axis + label live), so it reads as the Z-height control. Floated a little past the axis
    // tip (×1.12) so the grip clears the "Z · …" label. Drag ↕ to restretch Z live.
    this.zHandle = new NapariVolumeZHandle(ctx.host, ctx.viewer.camera3d, {
      topAnchor: () => [
        -this.worldBase!.width / 2,
        -this.worldBase!.height / 2,
        ((this.worldBase!.depth * ctx.settings.volumeZScale) / 2) * 1.12,
      ],
      getScale: () => ctx.settings.volumeZScale,
      setScale: (s) => this.setZScale(s),
    });
    this.followDisplayState();
    this.frameRegionMeshes();
    this.listenToRegionMeshes();
  }

  /**
   * Assemble each channel's volume from the server tiles (or the single grayscale volume) under
   * the stack progress bar, with the display settings it is drawn with. `dims` is null when
   * nothing was assembled (a Cancel, a new plot, or no slices).
   */
  private async assembleChannels(
    desc: TileDescriptor | null,
    channelCount: number,
    loading: AbortSignal,
  ): Promise<{ dims: Box3 | null; channels: VolumeChannel[] }> {
    const { ctx, info } = this;
    const res = volumeResolutionFor(ctx.settings.resolutionScale);
    const states = ctx.store.currentChannelStates();

    // Assemble per-channel scalar volumes from the server tiles (jit-specific); the napari-js view
    // owns the layer orchestration (one additive tinted volume per channel, or a single grayscale
    // volume). The adapter computes each channel's colormap (incl. the reverse flip) and invert.
    let dims: Box3 | null = null;
    const channels: VolumeChannel[] = [];
    ctx.stack.loading(true);
    ctx.stack.progress(0);
    try {
      if (this.multichannel) {
        for (let c = 0; c < channelCount; c++) {
          const vol = await assemble(ctx, info, res, loading, c);
          if (loading.aborted) break; // a Cancel / new plot: fetch no further channel
          if (!vol) continue;
          dims = vol;
          this.channelData.set(c, vol.data);
          const st = states.find((s) => s.index === c);
          const color = st?.color ?? desc?.channelInfo?.[c]?.color ?? tintFor(c);
          channels.push({
            data: vol.data,
            width: vol.width,
            height: vol.height,
            depth: vol.depth,
            colormap: ctx.display.channelTintColormap(color),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
            invert: ctx.display.invert,
            visible: st?.visible ?? true,
          });
        }
      } else {
        const vol = await assemble(ctx, info, res, loading);
        if (vol) {
          dims = vol;
          this.channelData.set(0, vol.data);
          const st = states[0];
          channels.push({
            data: vol.data,
            width: vol.width,
            height: vol.height,
            depth: vol.depth,
            colormap: ctx.display.volumeColormap(st),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: toNapariGamma(st?.gamma), // ImageJ γ → napari-js γ
            invert: ctx.display.invert,
          });
        }
      }
    } finally {
      ctx.stack.loading(false);
      ctx.stack.progress(0);
    }
    return { dims, channels };
  }

  /** The volume's world box for the assembled `dims`, independent of the decimate factor. */
  private worldBox(dims: Box3): Box3 {
    const { ctx } = this;
    // Resolution-invariant world box; the per-axis `voxelSize` (napari `scale`) maps the sampled
    // grid onto it.
    //
    // A stack that declares its physical spacing on ALL THREE axes gets its true
    // extent as the world box — the only way anisotropy survives, and what makes a
    // resampled 40 x 40 x 200 µm volume read as a brain instead of a cube-aspect
    // brick. It needs none of the reference-box arithmetic: a physical box is
    // already independent of the decimate factor.
    //
    // Everything else keeps that arithmetic. Sizing the box by the sampled voxel
    // counts made higher in-plane resolution grow X/Y while the depth stayed the
    // (constant) slice count — so Z appeared to shrink at higher resolution.
    // Anchoring the in-plane long side to a fixed reference and letting Z span the
    // full slice count makes the box shape identical at every decimate factor.
    const meta = ctx.info()?.imageMeta?.[0];
    const mppXYZ: [number, number, number] | null =
      meta?.mppX && meta?.mppY && meta?.mppZ ? [meta.mppX, meta.mppY, meta.mppZ] : null;
    // The image's DECLARED pixel dimensions, which is what mpp is per: the sampled
    // dims are decimated, so sizing a physical box by them would make the world
    // box depend on the resolution the user happens to be viewing at.
    const imageDesc = ctx.tiles.currentDescriptor(ctx.info());
    const fullW = imageDesc?.width ?? meta?.x ?? dims.width;
    const fullH = imageDesc?.height ?? meta?.y ?? dims.height;
    const fullD = stackDepth(ctx.info()) || dims.depth;
    this.fullSize = [fullW, fullH, fullD];
    if (mppXYZ) {
      return {
        width: fullW * mppXYZ[0],
        height: fullH * mppXYZ[1],
        depth: fullD * mppXYZ[2],
      };
    }
    const fullLong = Math.max(1, fullW, fullH);
    return {
      width: (fullW * VOLUME_WORLD_INPLANE_REF) / fullLong,
      height: (fullH * VOLUME_WORLD_INPLANE_REF) / fullLong,
      depth: fullD,
    };
  }

  /**
   * The whole stack is already on screen: no plane to step. (This used to write `viewer.dims.z`,
   * which only a tiled 2D image reads — a volume raymarches every slice — and schedule a readback
   * of a frame that had not changed. The toolbar shows no slice control in volume / isosurface
   * mode, as Plotly's isosurface ignores the slice too.)
   */
  setZ(): void {
    /* nothing to step */
  }

  /** The intensity histogram of the assembled (downsampled) uint8 volume for the requested
   *  channel (multichannel) or the single grayscale volume. */
  histogram(channel: number, bins: number): IHistogram | null {
    return channelHistogram(this.channelData, channel, bins);
  }

  isoControls(): IIsosurfaceControls | null {
    if (!this.view) return null;
    return {
      setIsoRange: (isoMin: number, isoMax: number): void => {
        // Apply to every channel's volume layer.
        for (const layer of this.view?.layers ?? []) {
          layer.contrastLimits = [isoMin, isoMax];
          layer.rendering = 'iso';
          layer.isoThreshold = 0.5;
        }
        this.ctx.viewer.requestRender();
      },
    };
  }

  surface3dControls(): ISurface3dControls | null {
    return this.view ? surface3dControls(this.ctx, () => this.gizmo) : null;
  }

  dispose(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = null;
    this.gizmo?.destroy();
    this.gizmo = null;
    this.zHandle?.destroy();
    this.zHandle = null;
    this.regionMeshes.clear();
    this.slicePlanes.destroy();
    this.meshPointer?.destroy();
    this.meshPointer = null;
    this.toolSub?.unsubscribe();
    this.toolSub = null;
    this.worldBase = null;
  }

  /**
   * Restretch the volume's Z height live (driven by the in-view {@link NapariVolumeZHandle}). Only
   * the per-axis `voxelSize` / axes depth change — the voxel textures are untouched — so dragging is
   * smooth. `factor` is relative to the volume's natural proportions (1). Persists across re-mounts
   * (resolution changes) so the chosen height sticks.
   */
  setZScale(factor: number): void {
    const { settings } = this.ctx;
    settings.volumeZScale = Math.min(10, Math.max(0.1, factor));
    const base = this.worldBase;
    if (!base || !this.view) return;
    const worldZ = base.depth * settings.volumeZScale;
    const vsZ = worldZ / this.sampledDepth;
    for (const layer of this.view.layers) {
      const [sx, sy] = layer.voxelSize;
      layer.voxelSize = [sx, sy, vsZ];
    }
    this.gizmo?.setDepth(worldZ, this.axesLabels({ width: base.width, height: base.height, depth: worldZ }));
    this.zHandle?.reposition();
    this.frameRegionMeshes();
    this.ctx.viewer.requestRender();
  }

  /** The X/Y/Z axis-end label specs for the gizmo. Anchors are in the volume's centred world box
   *  (matching the AxesLayer geometry); the scale text reflects the FULL image extent — physical µm
   *  when µm/pixel is known, else pixel (X/Y) / slice (Z) counts. */
  axesLabels(vol: Box3): AxisLabelSpec[] {
    const hx = vol.width / 2;
    const hy = vol.height / 2;
    const hz = vol.depth / 2;
    // Measured from the IMAGE's own extent, never from the world box: the box is a
    // shape (and for a physically sized volume it is already in µm, so reading a
    // pixel count off it and multiplying by mpp would scale the label twice).
    const { px, mpp } = this.imageExtent();
    const len = (n: number, um: number): string => (um > 0 ? formatLength(n * um, 'µm') : `${n} px`);
    return [
      { anchor: [hx, -hy, -hz], text: `X · ${len(px[0], mpp[0])}`, color: '#ed4545' },
      { anchor: [-hx, hy, -hz], text: `Y · ${len(px[1], mpp[1])}`, color: '#4dd959' },
      // Physical when the stack declares its slice spacing (`mppZ`) — a resampled
      // volume knows how thick it is; a plain z-stack can only say how many slices.
      { anchor: [-hx, -hy, hz], text: `Z · ${len(px[2], mpp[2])}`, color: '#668cff' },
    ];
  }

  /**
   * The image's declared extent in pixels/slices, and its physical spacing per
   * axis in µm (0 = undeclared, and then that axis reads in pixels).
   *
   * One place, because the volume world box and the axis labels have to agree
   * about what the image's real dimensions are — the sampled grid is decimated and
   * says nothing about either.
   */
  private imageExtent(): { px: [number, number, number]; mpp: [number, number, number] } {
    const info = this.ctx.info();
    const meta = info?.imageMeta?.[0];
    const dims = this.dims;
    const desc = this.ctx.tiles.currentDescriptor(info);
    const mppX = desc?.mppX || meta?.mppX || 0;
    return {
      px: [
        desc?.width ?? meta?.x ?? dims?.width ?? 1,
        desc?.height ?? meta?.y ?? dims?.height ?? 1,
        stackDepth(info) || dims?.depth || 1,
      ],
      // A descriptor that reports only mppX is square-pixel by convention, which is
      // what the 2D scale bar already assumes of it.
      mpp: [mppX, desc?.mppY || meta?.mppY || mppX, meta?.mppZ || 0],
    };
  }

  /** The store's colormap, reverse, invert and channel windows → the volume's transfer function:
   *  colour (channel tint or selected colormap), the intensity window (min/max → contrastLimits)
   *  and gamma, mirroring the grayscale image's display controls so the histogram pane drives the
   *  3D render. */
  private followDisplayState(): void {
    const { display } = this.ctx;
    this.displaySub = display.watch((channels) => {
      const view = this.view;
      if (!view) return;
      if (this.multichannel) {
        // Each channel's layer is tinted by its colour and gets its own window/gamma/visibility.
        view.layers.forEach((_, c) => {
          const st = channels.find((s) => s.index === c);
          view.updateChannel(c, {
            colormap: display.channelTintColormap(st?.color ?? '#ffffff'),
            invert: display.invert,
            ...(st
              ? {
                  contrastLimits: [st.min, st.max] as [number, number],
                  gamma: toNapariGamma(st.gamma), // ImageJ γ → napari-js γ
                  visible: st.visible,
                }
              : {}),
          });
        });
      } else {
        const st = channels[0];
        view.updateChannel(0, {
          colormap: display.volumeColormap(st),
          invert: display.invert,
          ...(st ? { contrastLimits: [st.min, st.max] as [number, number], gamma: toNapariGamma(st.gamma) } : {}),
        });
      }
    });
  }
}

/**
 * NAPARI_SCATTER3D (review Appendix B, cluster H): the downsampled voxel grid as a 3D point cloud
 * coloured by intensity (the napari-js analog of Plotly's voxel scatter3d). Assembles a coarse
 * volume, then emits a flat-strided sample of voxels (capped at `SCATTER3D_MAX_POINTS`).
 */
export class Scatter3dScene implements NapariScene {
  private layer: Points3DLayer | null = null;
  /** The assembled volume (key 0), for the intensity histogram. */
  private readonly channelData = new Map<number, Uint8Array>();
  private displaySub: Subscription | null = null;

  constructor(
    private readonly ctx: SceneContext,
    private readonly info: IImageInfo | undefined,
  ) {}

  async mount(): Promise<void> {
    const { ctx } = this;
    const res = volumeResolutionFor(ctx.settings.resolutionScale);
    ctx.stack.loading(true);
    ctx.stack.progress(0);
    let vol: AssembledVolume | null = null;
    try {
      vol = await assemble(
        ctx,
        this.info,
        { maxSlice: Math.min(res.maxSlice, SCATTER3D_MAX_XY), sliceStep: res.sliceStep },
        ctx.loading(),
      );
    } finally {
      ctx.stack.loading(false);
      ctx.stack.progress(0);
    }
    if (!vol || ctx.signal.aborted) return;

    const { data, width, height, depth } = vol;
    const zScale = Math.max(width, height) / Math.max(1, depth); // ≈ cubic aspect
    const total = width * height * depth;
    const stride = Math.max(1, Math.ceil(total / SCATTER3D_MAX_POINTS));
    const pos: number[] = [];
    const val: number[] = [];
    for (let i = 0; i < total; i += stride) {
      const x = i % width;
      const y = Math.floor(i / width) % height;
      const zi = Math.floor(i / (width * height));
      pos.push(x, y, zi * zScale);
      val.push(data[i]);
    }

    const st = ctx.store.currentChannelStates()[0];
    this.layer = ctx.viewer.addPoints3D(new Float32Array(pos), new Float32Array(val), {
      colormap: ctx.display.volumeColormap(st),
      contrastLimits: [st?.min ?? 0, st?.max ?? 255],
      invert: ctx.display.invert,
      size: 3,
    });
    ctx.setImageSize(width, height);
    // Feed the intensity histogram from the assembled volume (key 0).
    this.channelData.clear();
    this.channelData.set(0, data);
    // Store colormap / reverse / invert / channel window → the cloud's colormap + contrast.
    this.displaySub = ctx.display.watch((channels) => {
      const layer = this.layer;
      if (!layer) return;
      const s = channels[0];
      layer.colormap = ctx.display.volumeColormap(s);
      layer.invert = ctx.display.invert;
      if (s) layer.contrastLimits = [s.min, s.max];
      ctx.viewer.requestRender();
    });
    ctx.tools.scheduleReadback();
  }

  /** The whole stack is already on screen: no plane to step. */
  setZ(): void {
    /* nothing to step */
  }

  histogram(channel: number, bins: number): IHistogram | null {
    return channelHistogram(this.channelData, channel, bins);
  }

  surface3dControls(): ISurface3dControls | null {
    return this.layer ? surface3dControls(this.ctx, () => null) : null;
  }

  dispose(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = null;
  }
}
