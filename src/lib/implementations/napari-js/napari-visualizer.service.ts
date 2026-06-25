import { Inject, Injectable } from '@angular/core';
import { Observable, BehaviorSubject, Subject, Subscription, combineLatest, of } from 'rxjs';
import { Image } from 'image-js';
import { Viewer, Colormap } from 'napari-js';
import type { VolumeLayer, ImageLayer } from 'napari-js';

import { IImageInfo, IImageMetadata } from '../../contracts/image.contract';
import { Region } from '../../models/region';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { buildColormapLut, Rgb } from '../../contracts/colormap-lut';
import { PlotType, PlotTypeDescriptor, PLOT_TYPE_DESCRIPTORS } from '../../contracts/plot-type';
import {
  IVisualizer,
  PixelData,
  IntensityProfile,
  IIsosurfaceControls,
  IIntensityControls,
  ISurface3dControls,
} from '../../contracts/visualizer.contract';
import {
  ViewerCapabilities,
  ViewerFeature,
  capabilitiesOf,
} from '../../contracts/capabilities.contract';
import { IRegionOverlay } from '../../contracts/region-overlay.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { ColormapNode, IWandOptions, IBrushOptions } from '../../contracts/display-types';
import { VIZ_CONFIG, VizConfig } from '../../contracts/viz-config';
import { TILE_ACCESS_PORT, TileAccessPort } from '../../contracts/ports/tile-access.port';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { NapariScaleBar } from './napari-scale-bar';

/** Opaque handle from {@link NapariVisualizerService.load}, passed back to plot(). */
interface NapariLoaded {
  imageInfo: IImageInfo;
  z: number;
  /** Must match `IImageInfo.fileName` — the render orchestrator drops the result if the
   *  handle's `filename` doesn't match the requested image (guards against stale clicks). */
  filename: string;
}

const VOLUME_MAX_SLICE = 256; // downsample volume slices for a tractable 3D preview
const TILE_SIZE = 512; // server tile edge (matches the OSD backend)
/** Max tiles stitched for one displayed slice (512px tiles → up to ~6144² at full res). Beyond
 *  this we step to a coarser pyramid level so a large image stays tractable. */
const MAX_STITCH_TILES = 144;
/** WebGPU default `maxTextureDimension2D` — a stitched slice's longest side must fit a texture. */
const MAX_TEXTURE_DIM = 8192;
/** How long to poll `/tiles/info` (202 while the server caches the source) before falling back to
 *  a single tile. Generous like the OSD backend — a cold whole-slide can take minutes to cache. */
const DESCRIPTOR_TIMEOUT_MS = 120000;

/** Default per-channel tints (Fiji-style) when the store/descriptor offers no colour. */
const DEFAULT_TINTS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff'];

/** Default tint for a channel index, cycling the Fiji palette. */
function tintFor(channel: number): string {
  return DEFAULT_TINTS[channel % DEFAULT_TINTS.length];
}

/** One pyramid level from `GET /tiles/info` (res 0 = full resolution). */
interface TileLevel {
  res: number;
  width: number;
  height: number;
}

/** Subset of the `/tiles/info` descriptor this backend reads (tile grid, channels, scale). */
interface TileDescriptor {
  width: number;
  height: number;
  tileSize: number;
  z: number;
  channels: number;
  multichannel?: boolean;
  /** Real Bio-Formats levels at the front of `levels`; per-channel tiles exist only there. */
  realLevels?: number;
  channelInfo?: Array<{
    name?: string;
    color?: string;
    bitDepth?: number;
    minAllowed?: number;
    maxAllowed?: number;
  }> | null;
  levels: TileLevel[];
  mppX?: number;
  mppY?: number;
}

/**
 * A WebGPU image backend built on the published `napari-js` library — the POC engine for
 * jit-ui#102 (a browser-based napari shipped as a JS library, swapping image plotting with
 * OpenSeadragon and 3D slicing/isosurfaces with Plotly).
 *
 * Render strategy: rather than re-implement the server's tile/pyramid protocol (which OSD
 * already handles), this backend renders the **complete per-slice image URLs the app already
 * produces** (`IImageInfo.urls`) — `urls[z]` for the 2D image, and the full `urls` stack
 * assembled into a downsampled volume for the 3D types. Region state and display options
 * delegate to the shared {@link RegionStore} / {@link VisualizerStore}, exactly as OSD does.
 *
 * Follow-ups (jit-ui#102): native-resolution pyramidal tiling, on-canvas tools, region
 * overlay rendering, per-channel histograms, TIFF export.
 */
@Injectable({ providedIn: 'root' })
export class NapariVisualizerService implements IVisualizer {
  readonly capabilities: ViewerCapabilities = capabilitiesOf([
    ViewerFeature.ImageDisplay,
    ViewerFeature.StackSlider,
    ViewerFeature.PixelReadback,
    ViewerFeature.Surface3D,
    ViewerFeature.Isosurface,
  ]);

  private readonly api: string;

  private viewer: Viewer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private host: HTMLElement | null = null;
  private loaded: NapariLoaded | null = null;
  private lastPixels: PixelData | null = null;
  private currentPlotType: PlotType = PlotType.NAPARI_IMAGE;
  private volumeLayer: VolumeLayer | null = null;
  private volumeDims: { width: number; height: number; depth: number } | null = null;
  private imageW = 0;
  private imageH = 0;
  /** Monotonic slice-request id so a slow out-of-order slice fetch can't clobber a newer one. */
  private sliceReq = 0;
  /** Cached `/tiles/info` pyramid descriptor + the infoB64 it was fetched for. */
  private descriptor: TileDescriptor | null = null;
  private descriptorKey: string | null = null;

  /** How the current 2D image is composited (drives histogram + state application). */
  private imageMode: 'grayscale' | 'multichannel' | 'rgb' = 'rgb';
  /** Per-channel scalar layers for the multichannel/grayscale modes, keyed by channel index. */
  private readonly channelLayers = new Map<number, ImageLayer>();
  /** Live subscription applying channel-state / colormap changes to the layers. */
  private displaySub: Subscription | null = null;
  /** Latest grayscale colormap selection from the store (applied to the single gray layer). */
  private currentColormap: ColormapNode | null = null;
  private currentReverse = false;
  /** Latest invert toggle from the store (flips intensity before the colormap, like OSD). */
  private invertEnabled = false;
  /** Physical scale bar overlay for the 2D image (null when 3D or the image has no µm/pixel). */
  private scaleBar: NapariScaleBar | null = null;

  private readonly stackLoading$ = new BehaviorSubject<boolean>(false);
  private readonly stackLoadingProgress$ = new BehaviorSubject<number>(0);
  private readonly autoscaleEvent$ = new Subject<unknown>();
  private readonly intensityProfile$ = new Subject<IntensityProfile[]>();
  private readonly viewportChange$ = new Subject<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>();

  constructor(
    @Inject(TILE_ACCESS_PORT) private readonly tiles: TileAccessPort,
    private readonly store: VisualizerStore,
    private readonly regionStore: RegionStore,
    @Inject(VIZ_CONFIG) config: VizConfig,
  ) {
    this.api = config.slideCropServer;
  }

  /**
   * Fetch + cache the server pyramid descriptor (`GET /tiles/info`): the REAL per-level tile grid,
   * tile size, channel metadata and physical pixel size. The backend returns 202 while the source
   * is still caching, so we poll briefly. Cached per `infoB64`; returns null if it never becomes
   * ready (callers fall back to a single-tile fetch). This is the authoritative grid — guessing
   * level dims from `trueImageSize` overshoots the real grid and the server 400s out-of-range tiles.
   */
  private async ensureDescriptor(): Promise<TileDescriptor | null> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return null;
    if (this.descriptor && this.descriptorKey === infoB64) return this.descriptor;
    const headers = await this.tiles
      .getAuthHeaders()
      .catch(() => ({}) as Record<string, string>);
    const url = `${this.api}tiles/info?info=${infoB64}`;
    const deadline = Date.now() + DESCRIPTOR_TIMEOUT_MS;
    for (;;) {
      try {
        const resp = await fetch(url, { headers });
        if (resp.status === 200) {
          const body = (await resp.json()) as TileDescriptor;
          if (body?.levels?.length) {
            this.descriptor = body;
            this.descriptorKey = infoB64;
            return body;
          }
        }
        // 202 (still caching) or empty body → re-poll until the deadline.
      } catch (err) {
        console.warn('[napari-js] tiles/info poll retry', err);
      }
      if (Date.now() > deadline) {
        console.warn('[napari-js] tiles/info not ready; falling back to single-tile fetch');
        return null;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  /**
   * Fetch a COMPLETE rendered slice as an `ImageBitmap` by stitching the server's REAL tile grid
   * (from `/tiles/info`) — not just the top-left tile, which only ever showed a large image's
   * corner. Picks the finest pyramid level whose grid fits `budgetTiles` and whose longest side is
   * within the GPU texture limit, fetches that grid concurrently, and stitches it into one canvas.
   *
   * `channel` selects a single band as grayscale (real levels only); omit for the server composite.
   * `budgetTiles` caps the grid: the 2D view uses the full budget for detail; the 3D volume passes
   * 1 for a cheap overview tile per slice (it downsamples to {@link VOLUME_MAX_SLICE}). Falls back
   * to a single `col=0,row=0` tile when no descriptor is available (small/simple images, volumes).
   */
  private async fetchSlice(
    z: number,
    channel?: number,
    budgetTiles: number = MAX_STITCH_TILES,
  ): Promise<ImageBitmap> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) throw new Error('[napari-js] no selected image info (getSelectedInfoB64 null)');
    const headers = await this.tiles
      .getAuthHeaders()
      .catch(() => ({}) as Record<string, string>);
    const desc = await this.ensureDescriptor();

    const ch = channel == null ? '' : `&channel=${channel}`;
    const fetchTile = async (
      res: number,
      col: number,
      row: number,
      t: number,
    ): Promise<ImageBitmap> => {
      const url = `${this.api}tile?info=${infoB64}&res=${res}&col=${col}&row=${row}&z=${z}&tileSize=${t}${ch}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        throw new Error(`[napari-js] slice fetch failed: ${resp.status} (${col}/${row} res ${res})`);
      }
      return createImageBitmap(await resp.blob());
    };

    // No descriptor → single top-left tile (legacy fallback; correct for small/simple images).
    if (!desc || !desc.levels?.length) return fetchTile(0, 0, 0, TILE_SIZE);

    const t = desc.tileSize || TILE_SIZE;
    // Per-channel tiles exist only at REAL Bio-Formats levels; the composite exists at all levels.
    const maxLevel = channel == null ? desc.levels.length : desc.realLevels ?? desc.levels.length;
    const usable = desc.levels.slice(0, Math.max(1, maxLevel));
    // Finest level (res 0 = full) whose grid fits the tile budget and the GPU texture limit.
    let chosen = usable[0];
    for (const lvl of usable) {
      chosen = lvl;
      const cols = Math.max(1, Math.ceil(lvl.width / t));
      const rows = Math.max(1, Math.ceil(lvl.height / t));
      if (cols * rows <= budgetTiles && Math.max(lvl.width, lvl.height) <= MAX_TEXTURE_DIM) break;
    }
    const cols = Math.max(1, Math.ceil(chosen.width / t));
    const rows = Math.max(1, Math.ceil(chosen.height / t));
    if (chosen !== usable[0] && budgetTiles === MAX_STITCH_TILES) {
      console.warn(
        `[napari-js] full resolution exceeds the ${budgetTiles}-tile/${MAX_TEXTURE_DIM}px budget; ` +
          `displaying overview level res ${chosen.res} (${chosen.width}×${chosen.height}).`,
      );
    }

    if (cols === 1 && rows === 1) return fetchTile(chosen.res, 0, 0, t);

    // Fetch the whole grid concurrently, then stitch into one level-sized canvas. Edge tiles are
    // narrower/shorter; drawImage places each at its grid offset so partial tiles line up.
    const jobs: Array<Promise<{ col: number; row: number; bmp: ImageBitmap }>> = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        jobs.push(fetchTile(chosen.res, col, row, t).then((bmp) => ({ col, row, bmp })));
      }
    }
    const tiles = await Promise.all(jobs);

    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(chosen.width, chosen.height);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = chosen.width;
      canvas.height = chosen.height;
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('[napari-js] slice stitch: 2D context unavailable');
    for (const { col, row, bmp } of tiles) {
      ctx.drawImage(bmp, col * t, row * t);
      bmp.close?.();
    }

    // Safety net: if the chosen level still exceeds the GPU texture limit (e.g. a multichannel
    // image whose coarsest REAL level is huge — overview levels are composite-only), downscale the
    // stitched canvas to fit so the WebGPU texture upload can't fail.
    const longest = Math.max(chosen.width, chosen.height);
    if (longest > MAX_TEXTURE_DIM) {
      const scale = MAX_TEXTURE_DIM / longest;
      const outW = Math.max(1, Math.floor(chosen.width * scale));
      const outH = Math.max(1, Math.floor(chosen.height * scale));
      console.warn(
        `[napari-js] stitched level ${chosen.width}×${chosen.height} exceeds the ` +
          `${MAX_TEXTURE_DIM}px texture limit; downscaling to ${outW}×${outH}.`,
      );
      let out: HTMLCanvasElement | OffscreenCanvas;
      if (typeof OffscreenCanvas !== 'undefined') {
        out = new OffscreenCanvas(outW, outH);
      } else {
        out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
      }
      const octx = out.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!octx) throw new Error('[napari-js] slice downscale: 2D context unavailable');
      octx.drawImage(canvas as unknown as CanvasImageSource, 0, 0, outW, outH);
      return createImageBitmap(out as unknown as ImageBitmapSource);
    }
    return createImageBitmap(canvas as unknown as ImageBitmapSource);
  }

  // ── IDataRenderer: load / render / viewport ───────────────────────────────
  async load(imageInfo: IImageInfo, zIndex: number): Promise<NapariLoaded> {
    this.loaded = { imageInfo, z: zIndex, filename: imageInfo.fileName };
    return this.loaded;
  }

  async plot(
    plotDiv: string,
    imageLoaded: unknown,
    imageInfo: IImageInfo,
    screenHeight: number,
    plotType: PlotType,
    _inPlace?: boolean,
  ): Promise<boolean> {
    const host = document.getElementById(plotDiv);
    if (!host) {
      console.error(`[napari-js] plot target #${plotDiv} not found`);
      return false;
    }
    this.reset();
    this.host = host;
    this.currentPlotType = plotType;

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = screenHeight ? `${screenHeight}px` : '100%';
    host.appendChild(canvas);
    this.canvas = canvas;

    const info = (imageLoaded as NapariLoaded)?.imageInfo ?? imageInfo;
    const z = (imageLoaded as NapariLoaded)?.z ?? 0;

    try {
      const viewer = new Viewer({ canvas, background: { r: 0.07, g: 0.07, b: 0.09, a: 1 } });
      this.viewer = viewer;
      await viewer.ready;

      const isVolume =
        plotType === PlotType.NAPARI_VOLUME || plotType === PlotType.NAPARI_ISOSURFACE;
      if (isVolume) {
        const vol = await this.assembleVolume(info);
        if (vol) {
          this.imageW = vol.width;
          this.imageH = vol.height;
          this.volumeDims = vol;
          this.volumeLayer = viewer.addVolume(vol.data, vol.width, vol.height, vol.depth, {
            colormap: 'magma',
            rendering: plotType === PlotType.NAPARI_ISOSURFACE ? 'iso' : 'mip',
          });
        }
      } else {
        await this.renderImage(z);
        this.fitCameraSoon();
        this.subscribeDisplayState();
        this.installScaleBar();
      }
      this.scheduleReadback();
      return true;
    } catch (err) {
      console.error('[napari-js] plot failed:', err);
      return false;
    }
  }

  // ── Channels: per-channel composite, LUT, native histograms (jit-ui#102) ──────────────────

  /** Build a napari `Colormap` from a 0..255 RGB LUT (256 stops, t = i/255). */
  private colormapFromLut(name: string, lut: Rgb[]): Colormap {
    const stops = lut.map((c, i) => ({
      t: i / (lut.length - 1),
      color: [c[0] / 255, c[1] / 255, c[2] / 255] as [number, number, number],
    }));
    return new Colormap(name, stops);
  }

  /** A black→tint ramp for a channel's hex colour (additive multichannel compositing). */
  private tintColormap(hex: string): Colormap {
    const h = (hex || '#ffffff').replace('#', '');
    const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
    const r = parseInt(full.slice(0, 2), 16) || 0;
    const g = parseInt(full.slice(2, 4), 16) || 0;
    const b = parseInt(full.slice(4, 6), 16) || 0;
    return new Colormap(`tint-${full}`, [
      { t: 0, color: [0, 0, 0] },
      { t: 1, color: [r / 255, g / 255, b / 255] },
    ]);
  }

  /** The grayscale display colormap from the store selection (+reverse), defaulting to gray. */
  private grayscaleColormap(): Colormap | string {
    const value = (this.currentColormap as { data?: { value?: unknown } } | null)?.data?.value;
    const lut = value != null ? buildColormapLut(value, this.currentReverse) : null;
    if (lut) return this.colormapFromLut('gray-cmap', lut);
    return this.currentReverse
      ? this.colormapFromLut('gray-rev', [[255, 255, 255], [0, 0, 0]] as Rgb[])
      : 'gray';
  }

  /** Fetch a stitched slice and read it back as a single-channel uint8 plane. `channel` selects a
   *  band (multichannel); omit it for the grayscale composite (all overview levels available, so a
   *  large image picks a fitting downscaled level rather than only the full-res real level). */
  private async fetchChannelData(
    z: number,
    channel?: number,
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const bmp = await this.fetchSlice(z, channel);
    const w = bmp.width;
    const h = bmp.height;
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('[napari-js] channel readback: 2D context unavailable');
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = rgba[i * 4]; // server bands are grayscale (R=G=B)
    return { data, width: w, height: h };
  }

  /**
   * Render the 2D image for slice `z` in one of three modes, mirroring the OSD display pipeline:
   *  - **multichannel** (fluorescence): one additive scalar `ImageLayer` per channel, each tinted
   *    by its channel colour and windowed by the shared channel state — true client-side compositing.
   *  - **grayscale**: a single scalar layer coloured by the store colormap (+reverse).
   *  - **rgb**: the server-composited bitmap as-is.
   */
  private async renderImage(z: number, token?: number): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    const desc = await this.ensureDescriptor();
    const states = this.store.currentChannelStates();
    const channelCount = desc?.channels ?? (states.length || 1);
    const multichannel = !!desc?.multichannel && channelCount > 1;

    // 1) Fetch all pixel data BEFORE touching the viewer, so a superseded scrub can bail without
    //    having torn down the visible layers (avoids flicker / out-of-order layer state).
    let mode: 'grayscale' | 'multichannel' | 'rgb';
    let planes: Array<{ data: Uint8Array; width: number; height: number }> = [];
    let bitmap: ImageBitmap | null = null;
    if (multichannel) {
      mode = 'multichannel';
      planes = await Promise.all(
        Array.from({ length: channelCount }, (_, c) => this.fetchChannelData(z, c)),
      );
    } else if (channelCount === 1) {
      mode = 'grayscale';
      // Composite fetch (no channel) → all overview levels usable, so a large grayscale image
      // selects a fitting downscaled level instead of the full-res real level (texture limit).
      planes = [await this.fetchChannelData(z)];
    } else {
      mode = 'rgb';
      bitmap = await this.fetchSlice(z);
    }

    // 2) Commit — unless a newer scrub superseded us or the viewer was torn down.
    if ((token != null && token !== this.sliceReq) || this.viewer !== v) {
      bitmap?.close?.();
      return;
    }

    this.imageMode = mode;
    v.layers.clear();
    this.channelLayers.clear();
    if (mode === 'multichannel') {
      planes.forEach((d, c) => {
        const st = states.find((s) => s.index === c);
        const color = st?.color ?? desc?.channelInfo?.[c]?.color ?? tintFor(c);
        const layer = v.addImage(
          { kind: 'typed', width: d.width, height: d.height, channels: 1, dtype: 'uint8', data: d.data },
          {
            name: st?.name ?? `ch${c}`,
            colormap: this.tintColormap(color),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: st?.gamma ?? 1,
            visible: st?.visible ?? true,
            invert: this.invertEnabled,
            blending: 'additive',
          },
        );
        this.channelLayers.set(c, layer);
      });
      this.imageW = planes[0]?.width ?? 0;
      this.imageH = planes[0]?.height ?? 0;
    } else if (mode === 'grayscale') {
      const d = planes[0];
      const st = states[0];
      const layer = v.addImage(
        { kind: 'typed', width: d.width, height: d.height, channels: 1, dtype: 'uint8', data: d.data },
        {
          colormap: this.grayscaleColormap(),
          contrastLimits: [st?.min ?? 0, st?.max ?? 255],
          gamma: st?.gamma ?? 1,
          invert: this.invertEnabled,
        },
      );
      this.channelLayers.set(0, layer);
      this.imageW = d.width;
      this.imageH = d.height;
    } else {
      v.addImage(bitmap as ImageBitmap);
      this.imageW = (bitmap as ImageBitmap).width;
      this.imageH = (bitmap as ImageBitmap).height;
    }
  }

  /** Subscribe channel states + grayscale colormap → live-apply to the rendered layers (no
   *  re-fetch; only z changes re-fetch). Replaces any prior subscription. */
  private subscribeDisplayState(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = combineLatest([
      this.store.getChannelStates(),
      this.store.getColormap(),
      this.store.getReverseScale(),
      this.store.getInvert(),
    ]).subscribe(([channels, colormap, reverse, invert]) => {
      this.currentColormap = (colormap as ColormapNode) ?? null;
      this.currentReverse = reverse;
      this.invertEnabled = invert;
      this.applyDisplayState(channels);
    });
  }

  /** Apply the current channel states / colormap to the live layers. */
  private applyDisplayState(channels: IChannelState[]): void {
    if (!this.viewer) return;
    if (this.imageMode === 'multichannel') {
      for (const [c, layer] of this.channelLayers) {
        const st = channels.find((s) => s.index === c);
        if (!st) continue;
        layer.colormap = this.tintColormap(st.color);
        layer.contrastLimits = [st.min, st.max];
        layer.gamma = st.gamma;
        layer.visible = st.visible;
        layer.invert = this.invertEnabled;
      }
    } else if (this.imageMode === 'grayscale') {
      const layer = this.channelLayers.get(0);
      const st = channels[0];
      if (layer) {
        layer.colormap = this.grayscaleColormap();
        layer.invert = this.invertEnabled;
        if (st) {
          layer.contrastLimits = [st.min, st.max];
          layer.gamma = st.gamma;
        }
      }
    }
    this.viewer.requestRender();
  }

  /** (Re)install the physical scale bar over the 2D image, sized from the image's µm/pixel
   *  (`/tiles/info` mppX, falling back to the image metadata). No-op without a physical size. */
  private installScaleBar(): void {
    this.scaleBar?.destroy();
    this.scaleBar = null;
    const mppX = this.descriptor?.mppX || this.loaded?.imageInfo.imageMeta?.[0]?.mppX || 0;
    if (this.viewer && this.host && mppX > 0) {
      this.scaleBar = new NapariScaleBar(this.host, this.viewer.camera, mppX);
    }
  }

  /** Convert a napari-js `Histogram` (bin count + min/max) to the pane's `IHistogram` (bin edges). */
  private toIHistogram(h: { counts: Uint32Array; bins: number; min: number; max: number }): IHistogram {
    const span = h.max - h.min || 1;
    const bins = Array.from({ length: h.bins }, (_, i) => h.min + (i * span) / h.bins);
    const counts = Array.from(h.counts);
    return { bins, counts, max: counts.reduce((m, c) => (c > m ? c : m), 0) };
  }

  /** Assemble a downsampled uint8 volume (luminance) from the per-slice tile endpoint. */
  private async assembleVolume(
    info: IImageInfo | undefined,
  ): Promise<{ data: Uint8Array; width: number; height: number; depth: number } | null> {
    const depth = info?.imageMeta?.[0]?.z || info?.urls?.length || 1;
    if (depth < 1) {
      console.warn('[napari-js] no slices to assemble a volume');
      return null;
    }
    // One cheap coarse tile per slice (budget 1) — the volume is downsampled to VOLUME_MAX_SLICE
    // regardless, so stitching the full-res grid per slice would be wasted fetches.
    const first = await this.fetchSlice(0, undefined, 1);
    const scale = Math.min(1, VOLUME_MAX_SLICE / Math.max(first.width, first.height, 1));
    const width = Math.max(1, Math.round(first.width * scale));
    const height = Math.max(1, Math.round(first.height * scale));
    const data = new Uint8Array(width * height * depth);

    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('napari-js volume assembly: 2D context unavailable');

    // Fetch all slices concurrently (the browser caps real parallelism), then read luminance
    // sequentially through the single 2D context.
    const bitmaps = await Promise.all(
      Array.from({ length: depth }, (_, z) =>
        z === 0 ? Promise.resolve(first) : this.fetchSlice(z, undefined, 1),
      ),
    );
    for (let z = 0; z < depth; z++) {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bitmaps[z], 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const base = z * width * height;
      for (let i = 0; i < width * height; i++) {
        data[base + i] =
          (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
      }
    }
    return { data, width, height, depth };
  }

  private fitCameraSoon(): void {
    const run = (): void => {
      if (this.viewer && this.canvas && this.imageW > 0 && this.imageH > 0) {
        this.viewer.camera.fit(
          this.imageW,
          this.imageH,
          this.canvas.clientWidth || this.imageW,
          this.canvas.clientHeight || this.imageH,
        );
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /** @deprecated Plotly-specific; host re-drives plot() from its image stream. */
  reloadAndPlot(): void {
    /* no-op */
  }

  reset(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = null;
    this.scaleBar?.destroy();
    this.scaleBar = null;
    this.channelLayers.clear();
    this.viewer?.dispose();
    this.viewer = null;
    if (this.canvas && this.host?.contains(this.canvas)) this.host.removeChild(this.canvas);
    this.canvas = null;
    this.lastPixels = null;
    this.volumeLayer = null;
    this.volumeDims = null;
  }

  relayout(_trueImageSize?: number[]): void {
    this.viewer?.requestRender();
  }

  /** @deprecated Plotly-specific axis reset. */
  resetAxes(): void {
    this.fitCameraSoon();
  }

  /** @deprecated Plotly-specific autoscale. */
  autoscale(): void {
    this.fitCameraSoon();
    this.autoscaleEvent$.next(undefined);
  }

  zoomIn(): void {
    if (this.viewer) this.viewer.camera.zoom = this.viewer.camera.zoom * 1.3;
  }

  zoomOut(): void {
    if (this.viewer) this.viewer.camera.zoom = this.viewer.camera.zoom / 1.3;
  }

  setDragMode(_mode: string | false): void {
    // POC: on-canvas region tools not yet wired (jit-ui#102 follow-up).
  }

  setNavigatorVisible(_visible: boolean): void {
    /* napari-js has no minimap; no-op */
  }

  setImageSmoothingEnabled(_enabled: boolean): void {
    // TODO(jit-ui#102): map to ImageLayer.interpolation once layers are exposed per-plot.
  }

  setShowStack(_showstack: boolean): void {
    /* stack navigated via setZIndex */
  }

  setZIndex(zIndex: number): void {
    if (this.loaded) this.loaded.z = zIndex;
    const v = this.viewer;
    if (!v) return;
    // Volume / isosurface: step the volume's z plane in place.
    if (this.volumeLayer) {
      v.dims.z = zIndex;
      this.scheduleReadback();
      return;
    }
    // 2D image: re-render the slice (re-fetches per-channel / composite). Branch on the presence
    // of a volume layer (not currentPlotType, which could be stale and silently no-op the swap).
    // The token lets renderImage drop a superseded scrub so a slow older slice can't clobber a newer one.
    const req = ++this.sliceReq;
    void this.renderImage(zIndex, req)
      .then(() => {
        if (req === this.sliceReq) this.scheduleReadback();
      })
      .catch((err) => console.error('[napari-js] setZIndex slice failed:', err));
  }

  setStackLoading(stackLoading: boolean): void {
    this.stackLoading$.next(stackLoading);
  }

  isStackLoading(): Observable<boolean> {
    return this.stackLoading$.asObservable();
  }

  getStackLoadingProgress(): Observable<number> {
    return this.stackLoadingProgress$.asObservable();
  }

  getTrueImageSize(): { width: number; height: number } | null {
    return this.imageW > 0 && this.imageH > 0 ? { width: this.imageW, height: this.imageH } : null;
  }

  getCurrentImage(): Promise<Image | null> {
    return Promise.resolve(null);
  }

  getDisplayedPixelData(): PixelData | null {
    return this.lastPixels;
  }

  getDisplayedSourceRect(): { x: number; y: number; width: number; height: number } | null {
    const v = this.viewer;
    const size = this.getTrueImageSize();
    if (!v || !size) return null;
    const r = v.visibleWorldRect();
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    return {
      x,
      y,
      width: Math.min(size.width, r.x + r.width) - x,
      height: Math.min(size.height, r.y + r.height) - y,
    };
  }

  downloadImage(): void {
    void this.exportComposite();
  }

  setPlotType(plotType: PlotType): void {
    this.currentPlotType = plotType;
  }

  /** Map a Plotly-style 3D drag mode onto napari-js's camera drag mode. */
  setSurfaceDragMode(mode: string): void {
    if (!this.viewer) return;
    const m = mode === 'pan' ? 'pan' : mode === 'zoom' ? 'zoom' : 'rotate'; // orbit/turntable → rotate
    this.viewer.setCameraDragMode(m);
  }

  /** @deprecated 3D not yet rendered by this backend. */
  resetSurfaceCamera(): void {
    const d = this.volumeDims;
    if (this.viewer && d) this.viewer.camera3d.frame(d.width, d.height, d.depth);
  }

  getAutoscaleEvent(): Observable<unknown> {
    return this.autoscaleEvent$.asObservable();
  }

  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    // The WebGPU napari-js options, offered alongside (not replacing) the OSD/Plotly types.
    return [
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_IMAGE]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_VOLUME]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_ISOSURFACE]!,
    ];
  }

  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.intensityProfile$.asObservable();
  }

  renderIntensityInset(_divId: string, _profiles: IntensityProfile[]): void {
    /* Plotly owns the intensity inset */
  }

  private scheduleReadback(): void {
    const v = this.viewer;
    if (!v) return;
    const run = (): void => {
      void v
        .readDisplayedPixels()
        .then((px) => {
          this.lastPixels = px;
          const size = this.getTrueImageSize();
          if (size) this.viewportChange$.next({ x: 0, y: 0, width: size.width, height: size.height });
        })
        .catch(() => undefined);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  // ── IRegionStore: delegate to the shared RegionStore ──────────────────────
  setRegions(
    regions: Region[],
    showRegionLabel?: boolean,
    isRegionSaveOn?: boolean,
    fillColor?: string,
    append?: boolean,
  ): void {
    this.regionStore.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
  }
  getRegions(): Region[] {
    return this.regionStore.getRegions();
  }
  getRegionPolygons(): unknown[] {
    return this.regionStore.getRegionPolygons();
  }
  getRegionUpdateEvent(): Observable<unknown[]> {
    return this.regionStore.getRegionUpdateEvent();
  }
  setSelectedShapeIndices(indices: number[]): void {
    this.regionStore.setSelectedShapeIndices(indices);
  }
  getSelectedShapeIndices$(): Observable<number[]> {
    return this.regionStore.getSelectedShapeIndices$();
  }
  selectRegion(region: Region): void {
    this.regionStore.selectRegion(region);
  }
  deleteActiveShape(): void {
    this.regionStore.deleteActiveShape();
  }
  getShowShapeLabel(): boolean {
    return this.regionStore.getShowShapeLabel();
  }
  getShapeColor(): string {
    return this.regionStore.getShapeColor();
  }
  getFillColor(): string {
    return this.regionStore.getFillColor();
  }
  getClassificationColors(): Map<string, string> {
    return this.store.getClassificationColors();
  }
  setClassificationColor(label: string, color: string): void {
    this.store.setClassificationColor(label, color);
  }
  plotPreviousShapes(): void {
    this.regionStore.plotPreviousShapes();
  }
  setPreviousShapes(shapes: unknown[]): void {
    this.regionStore.setPreviousShapes(shapes);
  }
  getPreviousShapes(): unknown[] {
    return this.regionStore.getPreviousShapes();
  }
  undo(): void {
    this.regionStore.undo();
  }
  redo(): void {
    this.regionStore.redo();
  }
  canUndo(): boolean {
    return this.regionStore.canUndo();
  }
  canRedo(): boolean {
    return this.regionStore.canRedo();
  }
  getCanUndo$(): Observable<boolean> {
    return this.regionStore.getCanUndo$();
  }
  getCanRedo$(): Observable<boolean> {
    return this.regionStore.getCanRedo$();
  }
  resetUndoHistory(): void {
    this.regionStore.resetUndoHistory();
  }
  importRegions(geoJsonStr: string): Region[] {
    return this.regionStore.importRegions(geoJsonStr);
  }
  exportRegions(regions: Region[]): void {
    this.regionStore.exportRegions(regions);
  }
  getGeoJsonString(regions: Region[]): string {
    return this.regionStore.getGeoJsonString(regions);
  }

  // ── IToolController: POC stubs (on-canvas tools are a jit-ui#102 follow-up) ─
  setWandMode(_active: boolean, _options?: IWandOptions): void {}
  setWandOptions(_options: IWandOptions): void {}
  clearActiveWandRegion(): void {}
  setBrushMode(_active: boolean, _options?: IBrushOptions): void {}
  setBrushOptions(_options: IBrushOptions): void {}
  setVertexEraserMode(_active: boolean): void {}
  setVertexEraserRadius(_radius: number): void {}
  setZoomToBoxMode(_active: boolean): void {}
  segmentRectangles(): Promise<number> {
    return Promise.resolve(0);
  }
  segmentRectanglesCellpose(): Promise<number> {
    return Promise.resolve(0);
  }
  setSamModel(_id: string): void {}
  setSamPointMode(_active: boolean): void {}
  commitSamPoints(): void {}
  clearSamPoints(): void {}

  // ── IDisplayOptions: delegate to the shared VisualizerStore ───────────────
  getColormap(): Observable<ColormapNode | null> {
    return this.store.getColormap();
  }
  setColormap(colormap: ColormapNode): void {
    this.store.setColormap(colormap);
  }
  getColormapOptions(): ColormapNode[] {
    return this.store.getColormapOptions();
  }
  getReverseScale(): Observable<boolean> {
    return this.store.getReverseScale();
  }
  setReverseScale(reverse: boolean): void {
    this.store.setReverseScale(reverse);
  }
  setImageMeta(imageMeta: IImageMetadata[]): void {
    this.store.setImageMeta(imageMeta);
  }
  getImageMeta(): Observable<IImageMetadata[]> {
    return this.store.getImageMeta();
  }

  // ── IIntensitySampling: Plotly owns sampling; emit viewport changes ───────
  ensureIntensitySampling(_imageInfo: IImageInfo, _zIndex: number): Promise<void> {
    return Promise.resolve();
  }
  refreshIntensitySamplingForRoi(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
    _zIndex: number,
  ): void {}
  getViewportChange$(): Observable<{ x: number; y: number; width: number; height: number }> {
    return this.viewportChange$.asObservable();
  }

  // ── IVisualizer composite members ─────────────────────────────────────────
  getRegionOverlay(): IRegionOverlay | null {
    // TODO(jit-ui#102): render regions as a DOM/canvas overlay positioned via worldToCanvas.
    return null;
  }
  getIsosurfaceControls(): IIsosurfaceControls | null {
    if (!this.volumeLayer) return null;
    return {
      setIsoRange: (isoMin: number, isoMax: number): void => {
        const vol = this.volumeLayer;
        if (!vol) return;
        vol.contrastLimits = [isoMin, isoMax];
        vol.rendering = 'iso';
        vol.isoThreshold = 0.5;
      },
    };
  }
  getIntensityControls(): IIntensityControls | null {
    return null;
  }
  getSurface3dControls(): ISurface3dControls | null {
    if (!this.volumeLayer) return null;
    return {
      setSurfaceDragMode: (mode: string): void => this.setSurfaceDragMode(mode),
      resetSurfaceCamera: (): void => this.resetSurfaceCamera(),
    };
  }
  getHistogram(channelIndex: number, bins: number): IHistogram | null {
    const v = this.viewer;
    if (!v) return null;
    // Grayscale/multichannel: native per-channel histogram straight from the in-memory scalar
    // layer (no GPU readback). RGB: bin the displayed pixels' R/G/B byte (8-bit client path).
    const layer = this.channelLayers.get(this.imageMode === 'grayscale' ? 0 : channelIndex);
    if (layer) {
      const h = v.layerHistogram(layer, bins);
      if (h) return this.toIHistogram(h);
    }
    if (this.imageMode === 'rgb') return this.rgbHistogram(channelIndex, bins);
    return null;
  }
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null> {
    return of(this.getHistogram(channelIndex, bins));
  }

  /** Per-channel histogram of the displayed RGB composite (R/G/B byte), from the last readback. */
  private rgbHistogram(channelIndex: number, bins: number): IHistogram | null {
    const px = this.lastPixels;
    if (!px) return null;
    const band = Math.max(0, Math.min(2, channelIndex));
    const n = Math.max(1, Math.min(256, Math.floor(bins) || 256));
    const counts = new Array(n).fill(0);
    const data = px.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // skip transparent padding
      counts[Math.min(n - 1, (data[i + band] * n) >> 8)]++;
    }
    const binsArr = Array.from({ length: n }, (_, i) => (i * 256) / n);
    return { bins: binsArr, counts, max: counts.reduce((m, c) => (c > m ? c : m), 0) };
  }
  exportComposite(): void {
    const v = this.viewer;
    if (!v) return;
    void v.screenshot().then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'napari-js.png';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  exportData(): void {
    // TODO(jit-ui#102): native-bit-depth TIFF export via the server /export/tiff endpoint.
  }
  unsubscribe(): void {
    this.reset();
  }
}
