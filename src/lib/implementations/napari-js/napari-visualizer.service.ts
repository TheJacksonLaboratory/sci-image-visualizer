import { Inject, Injectable, Optional } from '@angular/core';
import { Observable, BehaviorSubject, Subject, Subscription, combineLatest, from, of } from 'rxjs';
import { Image } from 'image-js';
import { saveAs } from 'file-saver';
import {
  Viewer,
  histogramScalar,
  colormapFromLut,
  tintColormap,
  reverseColormap,
  heightField,
  MultiChannelImageView,
  MultiChannelVolumeView,
} from 'napari-js';
import type {
  AxesLayer,
  SurfaceLayer,
  PointsLayer,
  Points3DLayer,
  TiledSource,
  TileKey,
  PixelChunk,
  ChannelView,
  VolumeChannel,
  Colormap,
} from 'napari-js';

import { IImageInfo, IImageMetadata } from '../../contracts/image.contract';
import { Region } from '../../models/region';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { buildColormapLut, Rgb } from '../../contracts/colormap-lut';
import {
  PlotType,
  PlotTypeDescriptor,
  PLOT_TYPE_DESCRIPTORS,
  isNapari3d,
  isNapariIsosurface,
  isNapariSurface,
  isNapariScatter,
  isNapariScatter3d,
  NAPARI_DEFAULT_DECIMATE,
} from '../../contracts/plot-type';
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
import { NapariScaleBar, formatUm } from './napari-scale-bar';
import { NapariRegionOverlay } from './napari-region-overlay';
import { NapariAxesLabels, AxisLabelSpec } from './napari-axes-labels';
import {
  ICoordinateTransform,
} from '../../contracts/coordinate-transform.contract';
import { WandToolService, WandToolHost, CachedImageData } from '../../toolbar/wand/wand-tool.service';
import { WandOptions } from '../../toolbar/wand/wand.service';
import { BrushToolService, BrushOptions } from '../../toolbar/brush/brush-tool.service';
import {
  VertexEraserToolService,
  VertexEraserToolHost,
} from '../../toolbar/vertex-eraser/vertex-eraser-tool.service';
import {
  ZoomToBoxToolService,
  ZoomToBoxToolHost,
} from '../../toolbar/zoom-to-box/zoom-to-box-tool.service';
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { ICellSegmenter, CELL_SEGMENTER } from '../../contracts/cell-segmenter.contract';

/** ICoordinateTransform over the napari camera: pointer client coords ↔ image/world coords. */
class NapariCoordinateTransform implements ICoordinateTransform {
  constructor(
    private readonly viewer: {
      canvasToWorld(clientX: number, clientY: number): [number, number];
      readonly camera: { zoom: number };
    },
    private readonly ready: () => boolean,
  ) {}
  clientToData(clientX: number, clientY: number): { x: number; y: number } {
    const [x, y] = this.viewer.canvasToWorld(clientX, clientY);
    return { x, y };
  }
  dataLengthToScreen(dataLength: number): number {
    return dataLength * this.viewer.camera.zoom; // CSS px per world unit
  }
  isReady(): boolean {
    return this.ready();
  }
}

/** Opaque handle from {@link NapariVisualizerService.load}, passed back to plot(). */
interface NapariLoaded {
  imageInfo: IImageInfo;
  z: number;
  /** Must match `IImageInfo.fileName` — the render orchestrator drops the result if the
   *  handle's `filename` doesn't match the requested image (guards against stale clicks). */
  filename: string;
}

const VOLUME_MAX_SLICE = 1024; // "Full" in-plane cap; the default ¼ load uses 256
/** Reference in-plane world size (long side) for the volume/axes box, in arbitrary world units.
 *  The box is anchored to this reference regardless of the chosen decimate factor, so changing the
 *  resolution changes DETAIL, not the volume's proportions (Z no longer appears to shrink when the
 *  in-plane sampling grows). Set to the DEFAULT decimate's in-plane cap so the default view is
 *  unchanged; higher/lower resolutions keep that same shape. See {@link mountVolume}. */
const VOLUME_WORLD_INPLANE_REF = VOLUME_MAX_SLICE / NAPARI_DEFAULT_DECIMATE;
/** Max concurrent slice fetches when assembling a volume — keeps the connection pool busy
 *  without flooding it (browsers cap ~6/host) on a deep stack. */
const VOLUME_FETCH_CONCURRENCY = 8;

/** Volume/isosurface sampling for a decimate factor `scale` (1 = Full 1024, 2 = ½ 512, 4 = ¼ 256
 *  default, 8 = ⅛ 128): the in-plane cap halves each step; slices stay un-subsampled until ⅛, then
 *  subsample. */
function volumeResolutionFor(scale: number): { maxSlice: number; sliceStep: number } {
  const s = Math.max(1, Math.round(scale));
  return {
    maxSlice: Math.max(8, Math.round(VOLUME_MAX_SLICE / s)),
    sliceStep: Math.max(1, Math.floor(s / 4)),
  };
}
/** Fully-normalized intensity height as a fraction of the in-plane extent — matches the Plotly
 *  SURFACE z-aspect (~0.4) so the relief isn't exaggerated. */
const SURFACE_Z_ASPECT = 0.4;
/** "Full" mesh grid cap; the decimate factor divides it (default ¼ → 220, ½ → 440, Full → 880). */
const SURFACE_MAX_GRID = 880;
/** Coefficient scaling the pyramid tile budget with the target resolution — a higher target pulls a
 *  finer pyramid level (more real detail). Shared by the surface plane fetch + volume assembly. */
const STITCH_BUDGET_COEFF = 16;
/** Surface mesh target grid for a decimate factor `scale`: the grid cap shrinks by `scale` (every
 *  slice is kept — the z-slider needs them all). The source is fetched at a matching resolution. */
function surfaceResolutionFor(scale: number): { maxGrid: number } {
  const s = Math.max(1, Math.round(scale));
  return { maxGrid: Math.max(16, Math.round(SURFACE_MAX_GRID / s)) };
}

/** 3D scatter: in-plane cap for the assembled voxel grid, and the max number of points emitted
 *  (the grid is flat-strided down to this) — keeps the billboard count interactive. */
const SCATTER3D_MAX_XY = 64;
const SCATTER3D_MAX_POINTS = 150000;

const TILE_SIZE = 512; // server tile edge (matches the OSD backend)
/** Max tiles stitched for one displayed slice (512px tiles → up to ~6144² at full res). Beyond
 *  this we step to a coarser pyramid level so a large image stays tractable. */
const MAX_STITCH_TILES = 144;
/** WebGPU default `maxTextureDimension2D` — a stitched slice's longest side must fit a texture. */
const MAX_TEXTURE_DIM = 8192;
/** Concurrent tile requests per stitched slice. Firing a whole grid at once (hundreds of requests
 *  for a large level) overwhelmed the tile server (504s); a small pool keeps the pipe full without
 *  flooding it — and slice-level workers already run several stitches in parallel on top of this. */
const TILE_FETCH_CONCURRENCY = 6;
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
  /** napari-js high-level view owning the 3D volume layers (one additive tinted layer per channel
   *  for multichannel, or a single grayscale volume). Null in 2D. */
  private volumeView: MultiChannelVolumeView | null = null;
  /** True when the volume is composited from per-channel layers (vs a single grayscale volume). */
  private volumeMultichannel = false;
  /** napari-js height-field surface mesh (NAPARI_SURFACE plot type; null otherwise). Built from a
   *  single grayscale slice by {@link buildSurface} via napari-js's `heightField` + `addSurface`. */
  private surfaceLayer: SurfaceLayer | null = null;
  /** Which band the surface samples (a channel index for multichannel, else the composite). */
  private surfaceChannel: number | undefined = undefined;
  /** Pre-loaded per-slice luminance planes (already decimated to the surface grid), keyed by z,
   *  so the stack slider rebuilds the surface instantly. Filled by {@link preloadSurfacePlanes}. */
  private readonly surfacePlanes = new Map<
    number,
    { data: Uint8Array; width: number; height: number }
  >();
  /** In-plane grid cap for the active surface load (full grid ÷ the decimate factor). */
  private surfaceMaxGrid = SURFACE_MAX_GRID;
  /** Contrast window [min,max] the current surface mesh was built with. A change reshapes the
   *  mesh (pixel height = intensity within [min,max]), so it triggers a geometry rebuild. */
  private surfaceWindow: [number, number] | null = null;
  /** Persisted wireframe choice for the surface (re-applied when a new surface mounts). */
  private surfaceWireframe = false;
  /** napari-js 2D scatter points (region centroids) + its region-change subscription. */
  private scatter2dPoints: PointsLayer | null = null;
  private scatterRegionSub: Subscription | null = null;
  /** napari-js 3D scatter (voxel point cloud). */
  private scatter3dLayer: Points3DLayer | null = null;
  /** Monotonic load generation. Bumped by {@link reset} and {@link cancelLoading}; the frame-loading
   *  loops (volume assembly, surface preload) capture it and bail when it changes, so a Cancel (or a
   *  new plot) actually stops fetching frames instead of running to completion in the background. */
  private loadToken = 0;
  /** Decimate factor for the napari 3D types (1 = Full, 2 = ½ default, 4 = ¼, 8 = ⅛). Applied when a
   *  volume/isosurface/surface (re)loads; changing it needs a re-plot (it changes fetched data). */
  private resolutionScale = NAPARI_DEFAULT_DECIMATE;
  /** 3D coordinate-axes / scale gizmo for the volume/isosurface view (null in 2D). */
  private axesLayer: AxesLayer | null = null;
  /** DOM X/Y/Z + scale labels tracking the 3D axes gizmo (null in 2D). */
  private axesLabels: NapariAxesLabels | null = null;
  /** Persisted axes on/off choice, re-applied when a new volume mounts. Defaults on. */
  private axesVisible = true;
  private volumeDims: { width: number; height: number; depth: number } | null = null;
  /** Assembled uint8 volume data per channel (key = channel index), kept for the volume intensity
   *  histogram. Key 0 holds the grayscale/composite volume in the single-channel case. */
  private readonly volumeChannelData = new Map<number, Uint8Array>();
  private imageW = 0;
  private imageH = 0;
  /** Monotonic slice-request id so a slow out-of-order slice fetch can't clobber a newer one. */
  private sliceReq = 0;
  /** Cached `/tiles/info` pyramid descriptor + the infoB64 it was fetched for. */
  private descriptor: TileDescriptor | null = null;
  private descriptorKey: string | null = null;

  /** How the current 2D image is composited (drives histogram + state application). */
  private imageMode: 'grayscale' | 'multichannel' | 'rgb' = 'rgb';
  /** napari-js high-level view that owns the per-channel layer set (build + live display
   *  updates) for the current {@link imageMode}. Rebuilt on each (re)render. */
  private channelView: MultiChannelImageView | null = null;
  /** Live subscription applying channel-state / colormap changes to the layers. */
  private displaySub: Subscription | null = null;
  /** Latest grayscale colormap selection from the store (applied to the single gray layer). */
  private currentColormap: ColormapNode | null = null;
  private currentReverse = false;
  /** Latest invert toggle from the store (flips intensity before the colormap, like OSD). */
  private invertEnabled = false;
  /** Physical scale bar overlay for the 2D image (null when 3D or the image has no µm/pixel). */
  private scaleBar: NapariScaleBar | null = null;
  /** SVG region-drawing overlay for the 2D image (null until a 2D image is plotted). */
  private regionOverlay: NapariRegionOverlay | null = null;
  /** Pixel-tool plumbing: the plot div id, coord transform, and bound tool hosts. */
  private plotDivId = '';
  private coordTransform: ICoordinateTransform | null = null;
  private wandHost: WandToolHost | null = null;
  private eraserHost: VertexEraserToolHost | null = null;
  /** Cached CachedImageData built from the last readback (rebuilt when lastPixels changes). */
  private cachedImage: CachedImageData | null = null;
  private cachedImageSource: PixelData | null = null;
  /** Visible world rect captured AT the last readback — must pair with `lastPixels` so the pixel
   *  tools' ratios/origin match the matrix's camera (using the live rect after a pan/zoom would
   *  mis-scale the region). */
  private lastPixelsRect: { x: number; y: number; width: number; height: number } | null = null;
  /** Image smoothing (bilinear) vs nearest-neighbour (crisp pixels, the default). */
  private imageSmoothing = false;
  /** True when the 2D image is rendered via pyramidal TiledSources (descriptor available). */
  private tiled = false;
  /** Debounced readback timer + camera-change unsubscribe (keep lastPixels current for tools). */
  private readbackTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraReadbackOff: (() => void) | null = null;
  /** Coarse per-channel luminance sample (keyed by channel index) for the histogram in tiled mode,
   *  where the layers have no full in-memory pixels. Refreshed on plot + slice change. */
  private readonly histSamples = new Map<number, Uint8Array>();
  /** Native-bit-depth histograms from `/histogram`, keyed `${z}|${channel}` (>8-bit images). */
  private readonly nativeHistograms = new Map<string, IHistogram>();

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
    private readonly wandTool: WandToolService,
    private readonly brushTool: BrushToolService,
    private readonly eraserTool: VertexEraserToolService,
    private readonly zoomToBoxTool: ZoomToBoxToolService,
    private readonly samTool: SamToolService,
    private readonly samPointTool: SamPointToolService,
    private readonly cellSegmentTool: CellSegmentToolService,
    @Optional() @Inject(CELL_SEGMENTER) private readonly cellSegmenter: ICellSegmenter | null,
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
    /** When a specific channel has no pyramid level within `budgetTiles`, drop to the server
     *  COMPOSITE overview instead of stitching the huge per-channel level. Only safe when the caller
     *  wants a single decimated plane (the surface height): for a multichannel VOLUME every channel
     *  would then fetch the same composite and the channels would collapse into one, so volume
     *  assembly leaves this `false` to keep each band distinct. */
    allowCompositeFallback = false,
  ): Promise<ImageBitmap> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) throw new Error('[napari-js] no selected image info (getSelectedInfoB64 null)');
    const headers = await this.tiles
      .getAuthHeaders()
      .catch(() => ({}) as Record<string, string>);
    const desc = await this.ensureDescriptor();

    // The requested band; may be dropped to the composite (undefined) below when the channel has no
    // pyramid level small enough to stitch within budget.
    let effectiveChannel = channel;
    const fetchTile = async (
      res: number,
      col: number,
      row: number,
      t: number,
    ): Promise<ImageBitmap> => {
      const ch = effectiveChannel == null ? '' : `&channel=${effectiveChannel}`;
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
    // Per-channel tiles exist ONLY at REAL Bio-Formats levels (the front of `levels`); the server
    // composite exists at every level, including the small overviews.
    const perChannelLevels = desc.realLevels ?? desc.levels.length;
    const usable =
      channel == null ? desc.levels : desc.levels.slice(0, Math.max(1, perChannelLevels));

    // Finest level whose stitched grid fits BOTH the tile budget and the GPU texture limit; if none
    // fits, the coarsest available (fits=false).
    const tilesFor = (lvl: TileLevel): number =>
      Math.max(1, Math.ceil(lvl.width / t)) * Math.max(1, Math.ceil(lvl.height / t));
    const pick = (levels: TileLevel[]): { lvl: TileLevel; fits: boolean } => {
      let c = levels[0];
      for (const lvl of levels) {
        c = lvl;
        if (tilesFor(lvl) <= budgetTiles && Math.max(lvl.width, lvl.height) <= MAX_TEXTURE_DIM) {
          return { lvl, fits: true };
        }
      }
      return { lvl: c, fits: false };
    };

    let sel = pick(usable);
    // A specific channel only has tiles at the (few, large) real levels. When none of them fit the
    // budget — e.g. the coarsest real level is still 14982×18670 → ~1100 full-res tiles — stitching
    // it per slice floods the server (504s) and stalls the load. The composite pyramid has small
    // overview levels, so fetch the composite instead and derive luminance from it. Every caller here
    // (surface height, volume assembly, readback) downscales the plane anyway, so a composite-derived
    // plane is the right trade for one that actually loads. Only kicks in when the channel can't fit.
    if (allowCompositeFallback && !sel.fits && channel != null && desc.levels.length > perChannelLevels) {
      const composite = pick(desc.levels);
      if (composite.fits || tilesFor(composite.lvl) < tilesFor(sel.lvl)) {
        effectiveChannel = undefined;
        sel = composite;
        console.warn(
          `[napari-js] channel ${channel} has no pyramid level within the ${budgetTiles}-tile ` +
            `budget; using the composite overview (res ${sel.lvl.res}, ${sel.lvl.width}×` +
            `${sel.lvl.height}) for this plane.`,
        );
      }
    }
    const chosen = sel.lvl;
    const cols = Math.max(1, Math.ceil(chosen.width / t));
    const rows = Math.max(1, Math.ceil(chosen.height / t));
    if (!sel.fits && budgetTiles === MAX_STITCH_TILES) {
      console.warn(
        `[napari-js] full resolution exceeds the ${budgetTiles}-tile/${MAX_TEXTURE_DIM}px budget; ` +
          `displaying overview level res ${chosen.res} (${chosen.width}×${chosen.height}).`,
      );
    }

    if (cols === 1 && rows === 1) return fetchTile(chosen.res, 0, 0, t);

    // Stitch into one level-sized canvas. Fetch the grid with BOUNDED concurrency: firing every tile
    // at once (a big grid = hundreds of requests) overwhelmed the tile server (504s). Edge tiles are
    // narrower/shorter; drawImage places each at its grid offset so partial tiles line up.
    const coords: Array<{ col: number; row: number }> = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) coords.push({ col, row });
    }
    const tiles: Array<{ col: number; row: number; bmp: ImageBitmap }> = [];
    const stitchWorker = async (): Promise<void> => {
      for (;;) {
        const job = coords.shift();
        if (!job) return;
        const bmp = await fetchTile(chosen.res, job.col, job.row, t);
        tiles.push({ col: job.col, row: job.row, bmp });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, coords.length) }, () => stitchWorker()),
    );

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
    this.plotDivId = plotDiv;
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

      if (isNapariScatter(plotType)) {
        await this.mountScatter(viewer, z);
      } else if (isNapariScatter3d(plotType)) {
        await this.mountScatter3d(viewer, info);
      } else if (isNapariSurface(plotType)) {
        await this.mountSurface(viewer);
      } else if (isNapari3d(plotType)) {
        await this.mountVolume(viewer, info, plotType);
      } else {
        await this.renderImage(z);
        this.fitCameraSoon();
        this.subscribeDisplayState();
        this.installScaleBar();
        this.regionOverlay = new NapariRegionOverlay(host, viewer, this.regionStore);
        this.buildToolHosts();
        // Keep the pixel-tool readback (lastPixels) current as the view pans/zooms and tiled
        // levels load, so wand/brush/SAM sample the actually-displayed image (jit-ui#102).
        this.cameraReadbackOff = viewer.camera.changed.connect(() => this.armReadback());
      }
      this.scheduleReadback();
      return true;
    } catch (err) {
      console.error('[napari-js] plot failed:', err);
      return false;
    }
  }

  // ── Channels: per-channel composite, LUT, native histograms (jit-ui#102) ──────────────────

  /** The grayscale display colormap from the store selection (+reverse), defaulting to gray.
   *  Maps the jit-ui store colormap node to a napari `Colormap` via the library's LUT factory;
   *  the multichannel tint ramps are built inside {@link MultiChannelImageView} from each
   *  channel's hex colour. */
  private grayscaleColormap(): Colormap | string {
    const value = (this.currentColormap as { data?: { value?: unknown } } | null)?.data?.value;
    const lut = value != null ? buildColormapLut(value, this.currentReverse) : null;
    if (lut) return colormapFromLut('gray-cmap', lut);
    return this.currentReverse
      ? colormapFromLut('gray-rev', [[255, 255, 255], [0, 0, 0]] as Rgb[])
      : 'gray';
  }

  /** Fetch a stitched slice and read it back as a single-channel uint8 plane. `channel` selects a
   *  band (multichannel); omit it for the grayscale composite (all overview levels available, so a
   *  large image picks a fitting downscaled level rather than only the full-res real level). */
  private async fetchChannelData(
    z: number,
    channel?: number,
    budgetTiles?: number,
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const bmp = await this.fetchSlice(z, channel, budgetTiles);
    return this.bitmapToLuminance(bmp);
  }

  /** Decode an `ImageBitmap` (server bands are grayscale, R=G=B) to a single-channel uint8 plane.
   *  `maxSide` caps the longest side (downscaling on the canvas draw) — used to keep pre-loaded
   *  surface slice planes small. */
  private bitmapToLuminance(
    bmp: ImageBitmap,
    maxSide?: number,
  ): { data: Uint8Array; width: number; height: number } {
    const scale = maxSide ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height, 1)) : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
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
    // Scale the WHOLE bitmap into the (possibly smaller) target canvas — drawing at natural size
    // would crop to the top-left w×h corner when downscaling a large slice (maxSide < bmp size).
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = rgba[i * 4];
    return { data, width: w, height: h };
  }

  /**
   * Render the 2D image for slice `z`. With a server pyramid descriptor we use a pyramidal
   * {@link TiledSource} per layer so the view refines to higher resolution on zoom (like OSD) and
   * sits naturally in full-resolution coordinates; without one we fall back to the single-level
   * stitch. Three display modes either way: multichannel additive tint, grayscale colormap, RGB.
   */
  private async renderImage(z: number, token?: number): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    const desc = await this.ensureDescriptor();
    if (desc && desc.levels?.length) {
      if (token != null && token !== this.sliceReq) return;
      await this.renderImageTiled(z, desc);
      return;
    }
    return this.renderImageStitched(z, token);
  }

  /** Single-level stitch fallback (no descriptor): the pre-tiling path. */
  private async renderImageStitched(z: number, token?: number): Promise<void> {
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

    // The displayed texture may be a downscaled pyramid level; scale the layer into FULL-RESOLUTION
    // world coordinates (level-0 pixels) so the camera, readback and — critically — pre-saved
    // regions (stored in full-res coords, e.g. ndpi) all line up regardless of which level is shown.
    // This mirrors OSD, whose coordinate system is always level 0.
    const texW = mode === 'rgb' ? (bitmap as ImageBitmap).width : planes[0]?.width ?? 0;
    const texH = mode === 'rgb' ? (bitmap as ImageBitmap).height : planes[0]?.height ?? 0;
    const fullW = desc?.width || texW || 1;
    const fullH = desc?.height || texH || 1;
    const scale: [number, number] = [texW ? fullW / texW : 1, texH ? fullH / texH : 1];

    this.imageMode = mode;
    const interpolation: 'linear' | 'nearest' = this.imageSmoothing ? 'linear' : 'nearest';
    this.channelView = new MultiChannelImageView(v);
    if (mode === 'multichannel') {
      const views: ChannelView[] = planes.map((d, c) => {
        const st = states.find((s) => s.index === c);
        const color = st?.color ?? desc?.channelInfo?.[c]?.color ?? tintFor(c);
        return {
          source: { kind: 'typed', width: d.width, height: d.height, channels: 1, dtype: 'uint8', data: d.data },
          tint: color,
          name: st?.name ?? `ch${c}`,
          contrastLimits: [st?.min ?? 0, st?.max ?? 255],
          gamma: st?.gamma ?? 1,
          visible: st?.visible ?? true,
          invert: this.invertEnabled,
          scale,
        };
      });
      this.channelView.render('multichannel', views, { interpolation });
    } else if (mode === 'grayscale') {
      const d = planes[0];
      const st = states[0];
      this.channelView.render(
        'grayscale',
        [
          {
            source: { kind: 'typed', width: d.width, height: d.height, channels: 1, dtype: 'uint8', data: d.data },
            colormap: this.grayscaleColormap(),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: st?.gamma ?? 1,
            invert: this.invertEnabled,
            scale,
          },
        ],
        { interpolation },
      );
    } else {
      this.channelView.render('rgb', [{ source: bitmap as ImageBitmap, scale }], { interpolation });
    }
    this.imageW = fullW;
    this.imageH = fullH;
  }

  /**
   * Render the 2D image with pyramidal {@link TiledSource}s — the view refines to higher resolution
   * as you zoom in (the visual fetches the level whose texels ≈ screen pixels) and sits in full-res
   * coordinates so regions align. Same three modes as the stitch path. Per-channel layers use the
   * REAL pyramid levels (per-channel tiles only exist there); the composite uses all levels.
   */
  private async renderImageTiled(z: number, desc: TileDescriptor): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    const states = this.store.currentChannelStates();
    const channelCount = desc.channels ?? (states.length || 1);
    const multichannel = !!desc.multichannel && channelCount > 1;
    const interpolation: 'linear' | 'nearest' = this.imageSmoothing ? 'linear' : 'nearest';

    this.tiled = true;
    this.channelView = new MultiChannelImageView(v);

    if (multichannel) {
      this.imageMode = 'multichannel';
      const views: ChannelView[] = [];
      for (let c = 0; c < channelCount; c++) {
        const st = states.find((s) => s.index === c);
        const color = st?.color ?? desc.channelInfo?.[c]?.color ?? tintFor(c);
        views.push({
          source: this.buildTiledSource(desc, c, 1),
          tint: color,
          name: st?.name ?? `ch${c}`,
          contrastLimits: [st?.min ?? 0, st?.max ?? 255],
          gamma: st?.gamma ?? 1,
          visible: st?.visible ?? true,
          invert: this.invertEnabled,
        });
      }
      this.channelView.render('multichannel', views, { interpolation });
    } else if (channelCount === 1) {
      this.imageMode = 'grayscale';
      const st = states[0];
      this.channelView.render(
        'grayscale',
        [
          {
            source: this.buildTiledSource(desc, undefined, 1),
            colormap: this.grayscaleColormap(),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: st?.gamma ?? 1,
            invert: this.invertEnabled,
          },
        ],
        { interpolation },
      );
    } else {
      this.imageMode = 'rgb';
      this.channelView.render('rgb', [{ source: this.buildTiledSource(desc, undefined, 4) }], {
        interpolation,
      });
    }
    this.imageW = desc.width;
    this.imageH = desc.height;
    // Await on the initial render so getHistogram/autoContrast have data immediately; slice changes
    // refresh fire-and-forget (the histogram pane retries).
    await this.refreshHistogramSamples(z, desc);
  }

  /** Build a pyramidal TiledSource backed by the server `/tile` endpoint. `channel` selects a band
   *  (grayscale luminance, real levels only); omit it for the composite (RGBA, all levels). */
  private buildTiledSource(
    desc: TileDescriptor,
    channel: number | undefined,
    channels: 1 | 4,
  ): TiledSource {
    const infoB64 = this.tiles.getSelectedInfoB64() ?? '';
    // Per-channel tiles exist only at REAL Bio-Formats levels; the composite exists at all levels.
    const usable =
      channel == null
        ? desc.levels
        : desc.levels.slice(0, Math.max(1, desc.realLevels ?? desc.levels.length));
    const levelScales = usable.map((l) => desc.width / Math.max(1, l.width)); // level-0 px per level px
    const tileSize = desc.tileSize || TILE_SIZE;
    const ch = channel == null ? '' : `&channel=${channel}`;
    const api = this.api;
    return {
      kind: 'tiled',
      width: desc.width,
      height: desc.height,
      tileSize,
      levels: usable.length,
      levelScales,
      depth: Math.max(1, desc.z || 1),
      channels,
      dtype: 'uint8',
      fetchTile: async (key: TileKey): Promise<PixelChunk> => {
        const res = usable[key.level]?.res ?? key.level;
        const url = `${api}tile?info=${infoB64}&res=${res}&col=${key.col}&row=${key.row}&z=${key.z}&tileSize=${tileSize}${ch}`;
        const headers = await this.tiles
          .getAuthHeaders()
          .catch(() => ({}) as Record<string, string>);
        const resp = await fetch(url, { headers });
        if (!resp.ok) {
          throw new Error(`[napari-js] tile ${key.level}/${key.col}/${key.row} → ${resp.status}`);
        }
        const bmp = await createImageBitmap(await resp.blob());
        if (channels === 4) return { width: bmp.width, height: bmp.height, data: bmp };
        return this.bitmapToLuminance(bmp);
      },
    };
  }

  /** (Re)fetch a coarse per-channel luminance sample for the histogram (tiled mode has no full
   *  in-memory pixels). One cheap overview tile per channel; cached by channel index. */
  private async refreshHistogramSamples(z: number, desc: TileDescriptor): Promise<void> {
    this.histSamples.clear();
    if (this.imageMode === 'rgb') return; // RGB uses the displayed-pixel readback (rgbHistogram)
    const channelCount = this.imageMode === 'multichannel' ? desc.channels ?? 1 : 1;
    for (let c = 0; c < channelCount; c++) {
      try {
        const ch = this.imageMode === 'multichannel' ? c : undefined;
        const d = await this.fetchChannelData(z, ch, 1); // budget 1 → coarsest single tile
        this.histSamples.set(c, d.data);
      } catch {
        /* leave this channel's sample unset */
      }
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

  /** Subscribe the store colormap (+reverse), invert, and channel state → the volume/isosurface
   *  transfer function: colour (channel tint or selected colormap), the intensity **window
   *  (min/max → contrastLimits)** and **gamma**, mirroring the grayscale image's display controls
   *  so the histogram pane drives the 3D render. Replaces any prior subscription. */
  private subscribeVolumeDisplayState(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = combineLatest([
      this.store.getColormap(),
      this.store.getReverseScale(),
      this.store.getInvert(),
      this.store.getChannelStates(),
    ]).subscribe(([colormap, reverse, invert, channels]) => {
      this.currentColormap = (colormap as ColormapNode) ?? null;
      this.currentReverse = reverse;
      this.invertEnabled = invert;
      const view = this.volumeView;
      if (!view) return;
      if (this.volumeMultichannel) {
        // Each channel's layer is tinted by its colour and gets its own window/gamma/visibility.
        view.layers.forEach((_, c) => {
          const st = channels.find((s) => s.index === c);
          view.updateChannel(c, {
            colormap: this.channelTintColormap(st?.color ?? '#ffffff'),
            ...(st
              ? {
                  contrastLimits: [st.min, st.max] as [number, number],
                  gamma: st.gamma,
                  visible: st.visible,
                }
              : {}),
          });
        });
      } else {
        const st = channels[0];
        view.updateChannel(0, {
          colormap: this.volumeColormap(st),
          ...(st ? { contrastLimits: [st.min, st.max] as [number, number], gamma: st.gamma } : {}),
        });
      }
    });
  }

  /** A channel's tint colormap (black→colour) with reverse-scale / invert applied by flipping. */
  private channelTintColormap(color: string): Colormap | string {
    let cmap: Colormap | string = tintColormap(color);
    if (this.currentReverse) cmap = reverseColormap(cmap);
    if (this.invertEnabled) cmap = reverseColormap(cmap);
    return cmap;
  }

  /**
   * Colour map for the volume/isosurface. A real colormap selection (viridis/magma/…) wins;
   * otherwise the channel's colour tints it (so the channel-dialog colour swatch recolors the 3D
   * render). Reverse-scale and invert each flip the ramp — the `VolumeLayer` has no per-layer
   * invert, so both are emulated by reversing the colormap.
   */
  private volumeColormap(st: IChannelState | undefined): Colormap | string {
    const node = this.currentColormap as { label?: string; data?: { value?: unknown } } | null;
    // A colored colormap (viridis/magma/…) drives the volume; the default grayscale family
    // (gray / Greys / Greys Inv) yields to the channel's colour so the dialog colour swatch
    // recolors the 3D render.
    const label = (node?.label ?? '').toLowerCase();
    const grayFamily = label === '' || label.includes('grey') || label.includes('gray');
    const value = node?.data?.value;
    const lut = !grayFamily && value != null ? buildColormapLut(value, false) : null;
    let cmap: Colormap | string = lut
      ? colormapFromLut('vol-cmap', lut)
      : tintColormap(st?.color ?? '#ffffff');
    // Reverse-scale and invert each flip the ramp (the VolumeLayer has no per-layer invert).
    if (this.currentReverse) cmap = reverseColormap(cmap);
    if (this.invertEnabled) cmap = reverseColormap(cmap);
    return cmap;
  }

  /** Apply the current channel states / colormap to the live layers (no re-fetch), delegating the
   *  per-channel layer mutations to the {@link MultiChannelImageView}. */
  private applyDisplayState(channels: IChannelState[]): void {
    const view = this.channelView;
    if (!this.viewer || !view) return;
    if (this.imageMode === 'multichannel') {
      view.layers.forEach((_, c) => {
        const st = channels.find((s) => s.index === c);
        if (!st) return;
        view.updateChannel(c, {
          tint: st.color,
          contrastLimits: [st.min, st.max],
          gamma: st.gamma,
          visible: st.visible,
          invert: this.invertEnabled,
        });
      });
    } else if (this.imageMode === 'grayscale') {
      const st = channels[0];
      view.updateChannel(0, {
        colormap: this.grayscaleColormap(),
        invert: this.invertEnabled,
        ...(st ? { contrastLimits: [st.min, st.max] as [number, number], gamma: st.gamma } : {}),
      });
    }
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

  /**
   * Mount the 3D volume/isosurface. A multichannel image becomes one additive, tinted
   * {@link VolumeLayer} per channel (so each channel's colour composites into the render); a
   * grayscale/composite image uses a single volume. Adds the axes gizmo + labels and wires the
   * display-state subscription. The caller owns `viewer.ready`.
   */
  private async mountVolume(
    viewer: Viewer,
    info: IImageInfo | undefined,
    plotType: PlotType,
  ): Promise<void> {
    const token = this.loadToken; // bail before rendering if a Cancel / new plot bumps this
    const desc = await this.ensureDescriptor();
    const channelCount = desc?.channels ?? 1;
    const multichannel = !!desc?.multichannel && channelCount > 1;
    const res = volumeResolutionFor(this.resolutionScale);
    const rendering: 'iso' | 'mip' = isNapariIsosurface(plotType) ? 'iso' : 'mip';
    const states = this.store.currentChannelStates();

    this.volumeChannelData.clear();
    this.volumeMultichannel = multichannel;
    this.imageMode = multichannel ? 'multichannel' : 'grayscale';
    const view = new MultiChannelVolumeView(viewer);
    this.volumeView = view;

    // Assemble per-channel scalar volumes from the server tiles (jit-specific); the napari-js view
    // owns the layer orchestration (one additive tinted volume per channel, or a single grayscale
    // volume). The adapter computes each channel's colormap (incl. invert/reverse flips).
    let dims: { width: number; height: number; depth: number } | null = null;
    const channels: VolumeChannel[] = [];
    this.stackLoading$.next(true);
    this.stackLoadingProgress$.next(0);
    try {
      if (multichannel) {
        for (let c = 0; c < channelCount; c++) {
          const vol = await this.assembleVolume(info, res, c);
          if (!vol) continue;
          dims = vol;
          this.volumeChannelData.set(c, vol.data);
          const st = states.find((s) => s.index === c);
          const color = st?.color ?? desc?.channelInfo?.[c]?.color ?? tintFor(c);
          channels.push({
            data: vol.data,
            width: vol.width,
            height: vol.height,
            depth: vol.depth,
            colormap: this.channelTintColormap(color),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: st?.gamma ?? 1,
            visible: st?.visible ?? true,
          });
        }
      } else {
        const vol = await this.assembleVolume(info, res);
        if (vol) {
          dims = vol;
          this.volumeChannelData.set(0, vol.data);
          const st = states[0];
          channels.push({
            data: vol.data,
            width: vol.width,
            height: vol.height,
            depth: vol.depth,
            colormap: this.volumeColormap(st),
            contrastLimits: [st?.min ?? 0, st?.max ?? 255],
            gamma: st?.gamma ?? 1,
          });
        }
      }
    } finally {
      this.stackLoading$.next(false);
      this.stackLoadingProgress$.next(0);
    }

    if (!dims || !channels.length || this.loadToken !== token) return; // cancelled → don't render

    // Resolution-invariant world box. Sizing the box by the sampled voxel counts made higher
    // in-plane resolution grow X/Y while the depth stayed the (constant) slice count — so Z appeared
    // to shrink at higher resolution. Instead anchor the in-plane long side to a fixed reference and
    // let Z span the full slice count; the box shape is then identical at every decimate factor. The
    // per-axis `voxelSize` (napari `scale`) maps the sampled grid onto that fixed world box.
    const fullW = this.descriptor?.width ?? dims.width;
    const fullH = this.descriptor?.height ?? dims.height;
    const fullD =
      this.loaded?.imageInfo.imageMeta?.[0]?.z || this.loaded?.imageInfo.urls?.length || dims.depth;
    const fullLong = Math.max(1, fullW, fullH);
    const world = {
      width: (fullW * VOLUME_WORLD_INPLANE_REF) / fullLong,
      height: (fullH * VOLUME_WORLD_INPLANE_REF) / fullLong,
      depth: fullD,
    };
    const voxelSize: [number, number, number] = [
      world.width / dims.width,
      world.height / dims.height,
      world.depth / Math.max(1, dims.depth),
    ];
    for (const ch of channels) ch.voxelSize = voxelSize;

    view.render(multichannel ? 'multichannel' : 'grayscale', channels, { rendering });
    this.imageW = dims.width;
    this.imageH = dims.height;
    this.volumeDims = dims;

    // 3D coordinate-axes / scale gizmo + labels, sharing the volume's world box so the gizmo tracks
    // the rendered proportions. Physical scale text still comes from the FULL image extent.
    const mppX = this.descriptor?.mppX || this.loaded?.imageInfo.imageMeta?.[0]?.mppX || 0;
    this.axesLayer = viewer.addAxes(world.width, world.height, world.depth, {
      visible: this.axesVisible,
    });
    if (this.host) {
      this.axesLabels = new NapariAxesLabels(
        this.host,
        viewer.camera3d,
        this.buildAxesLabels(world, mppX),
      );
      this.axesLabels.setVisible(this.axesVisible);
    }
    this.subscribeVolumeDisplayState();
  }

  /** Build the X/Y/Z axis-end label specs for the 3D gizmo. Anchors are in the volume's centred
   *  world box (matching the AxesLayer geometry); the scale text reflects the FULL image extent —
   *  physical µm when µm/pixel is known, else pixel (X/Y) / slice (Z) counts. */
  private buildAxesLabels(
    vol: { width: number; height: number; depth: number },
    mppX: number,
  ): AxisLabelSpec[] {
    const hx = vol.width / 2;
    const hy = vol.height / 2;
    const hz = vol.depth / 2;
    const descW = this.descriptor?.width ?? vol.width;
    const descH = this.descriptor?.height ?? vol.height;
    const slices =
      this.loaded?.imageInfo.imageMeta?.[0]?.z || this.loaded?.imageInfo.urls?.length || vol.depth;
    const len = (px: number): string => (mppX > 0 ? formatUm(px * mppX) : `${px} px`);
    return [
      { anchor: [hx, -hy, -hz], text: `X · ${len(descW)}`, color: '#ed4545' },
      { anchor: [-hx, hy, -hz], text: `Y · ${len(descH)}`, color: '#4dd959' },
      { anchor: [-hx, -hy, hz], text: `Z · ${slices} px`, color: '#668cff' },
    ];
  }

  /**
   * Assemble a downsampled uint8 volume (luminance) from the per-slice tile endpoint. Slices are
   * fetched with bounded concurrency (keeps the connection pool full without flooding it on a deep
   * stack) and read into the volume as each arrives, driving {@link stackLoadingProgress$} so the
   * host shows a determinate progress bar instead of a bare spinner.
   */
  private async assembleVolume(
    info: IImageInfo | undefined,
    opts: { maxSlice?: number; sliceStep?: number } = {},
    channel?: number,
  ): Promise<{ data: Uint8Array; width: number; height: number; depth: number } | null> {
    const token = this.loadToken; // bail if a Cancel / new plot bumps this while we fetch
    const fullDepth = info?.imageMeta?.[0]?.z || info?.urls?.length || 1;
    if (fullDepth < 1) {
      console.warn('[napari-js] no slices to assemble a volume');
      return null;
    }
    const step = Math.max(1, Math.floor(opts.sliceStep ?? 1));
    const maxSlice = opts.maxSlice ?? VOLUME_MAX_SLICE;
    // Source-slice indices sampled into the volume (every `step`th plane → low-res is faster).
    const zIndices: number[] = [];
    for (let z = 0; z < fullDepth; z += step) zIndices.push(z);
    const depth = zIndices.length;

    this.stackLoadingProgress$.next(0);
    try {
      // Fetch each slice at a pyramid level matching `maxSlice` (budget scales with the decimate
      // factor), so a higher factor pulls a finer level → more real in-plane detail; then downsample
      // to `maxSlice`. `channel` selects a band (multichannel volume); omit for the grayscale
      // composite. The caller owns the stackLoading flag (multichannel assembles channels in turn).
      const budget = this.tileBudgetFor(maxSlice);
      const first = await this.fetchSlice(zIndices[0], channel, budget);
      const scale = Math.min(1, maxSlice / Math.max(first.width, first.height, 1));
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

      // Read one fetched slice bitmap into the volume plane `z` (luminance). Synchronous between
      // awaits, so the shared 2D context is safe to reuse across the concurrent fetch workers.
      let done = 0;
      const readSlice = (z: number, bmp: ImageBitmap): void => {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(bmp, 0, 0, width, height);
        const rgba = ctx.getImageData(0, 0, width, height).data;
        const base = z * width * height;
        for (let i = 0; i < width * height; i++) {
          data[base + i] =
            (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
        }
        bmp.close?.();
        done++;
        this.stackLoadingProgress$.next(Math.round((done / depth) * 100));
      };

      readSlice(0, first);

      // Remaining planes via a small pool of workers draining a shared queue. Each plane `p`
      // maps to source slice `zIndices[p]` (subsampled for low-res).
      const pending: number[] = [];
      for (let p = 1; p < depth; p++) pending.push(p);
      const worker = async (): Promise<void> => {
        for (;;) {
          const p = pending.shift();
          if (p === undefined || this.loadToken !== token) return;
          readSlice(p, await this.fetchSlice(zIndices[p], channel, budget));
        }
      };
      const poolSize = Math.min(VOLUME_FETCH_CONCURRENCY, Math.max(1, depth - 1));
      await Promise.all(Array.from({ length: poolSize }, () => worker()));

      if (this.loadToken !== token) return null; // cancelled → don't render a partial volume
      return { data, width, height, depth };
    } finally {
      this.stackLoadingProgress$.next(0);
    }
  }

  /**
   * Mount the NAPARI_SCATTER 2D scatter: the slice image with a points layer at each region's
   * centroid (napari-js analog of Plotly's region-centroid scatter). Rebuilds the points live as
   * regions change.
   */
  private async mountScatter(viewer: Viewer, z: number): Promise<void> {
    await this.renderImage(z);
    this.fitCameraSoon();
    this.subscribeDisplayState();
    this.installScaleBar();
    this.rebuildScatterPoints();
    this.scatterRegionSub = this.regionStore
      .getRegionUpdateEvent()
      .subscribe(() => this.rebuildScatterPoints());
    this.scheduleReadback();
  }

  /** (Re)build the 2D scatter's point layer at the current region centroids. */
  private rebuildScatterPoints(): void {
    const v = this.viewer;
    if (!v) return;
    if (this.scatter2dPoints) {
      v.layers.remove(this.scatter2dPoints);
      this.scatter2dPoints = null;
    }
    const centroids = this.regionCentroids();
    if (centroids.length === 0) return;
    this.scatter2dPoints = v.addPoints(centroids, {
      size: 12,
      faceColor: [1, 0.85, 0.2, 1],
      borderColor: [0, 0, 0, 1],
      borderWidth: 2,
    });
  }

  /** Region centroids as flat `[x, y, …]` data coords (rectangle / polygon / multipolygon). */
  private regionCentroids(): Float32Array {
    const out: number[] = [];
    const polyCentroid = (xs: number[], ys: number[]): void => {
      const n = xs.length;
      if (n === 0) return;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < n; i++) {
        cx += xs[i];
        cy += ys[i];
      }
      out.push(cx / n, cy / n);
    };
    for (const r of this.regionStore.getRegions()) {
      const b = r.bounds as
        | { x: number; y: number; width: number; height: number }
        | { xpoints: number[]; ypoints: number[] }
        | { polygons: { xpoints: number[]; ypoints: number[] }[] }
        | null
        | undefined;
      if (!b) continue;
      if ('width' in b && 'x' in b) {
        out.push(b.x + b.width / 2, b.y + b.height / 2);
      } else if ('xpoints' in b) {
        polyCentroid(b.xpoints, b.ypoints);
      } else if ('polygons' in b) {
        for (const p of b.polygons) polyCentroid(p.xpoints, p.ypoints);
      }
    }
    return new Float32Array(out);
  }

  /**
   * Mount the NAPARI_SCATTER3D 3D scatter: the downsampled voxel grid as a 3D point cloud colored
   * by intensity (napari-js analog of Plotly's voxel scatter3d). Assembles a coarse volume, then
   * emits a flat-strided sample of voxels (capped at {@link SCATTER3D_MAX_POINTS}) via `addPoints3D`.
   */
  private async mountScatter3d(viewer: Viewer, info: IImageInfo | undefined): Promise<void> {
    this.imageMode = 'grayscale';
    this.volumeMultichannel = false;
    const res = volumeResolutionFor(this.resolutionScale);
    this.stackLoading$.next(true);
    this.stackLoadingProgress$.next(0);
    let vol: { data: Uint8Array; width: number; height: number; depth: number } | null = null;
    try {
      vol = await this.assembleVolume(info, {
        maxSlice: Math.min(res.maxSlice, SCATTER3D_MAX_XY),
        sliceStep: res.sliceStep,
      });
    } finally {
      this.stackLoading$.next(false);
      this.stackLoadingProgress$.next(0);
    }
    if (!vol || this.viewer !== viewer) return;

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

    const st = this.store.currentChannelStates()[0];
    this.scatter3dLayer = viewer.addPoints3D(new Float32Array(pos), new Float32Array(val), {
      colormap: this.volumeColormap(st),
      contrastLimits: [st?.min ?? 0, st?.max ?? 255],
      size: 3,
    });
    this.imageW = width;
    this.imageH = height;
    this.volumeDims = { width, height, depth };
    // Feed the intensity histogram from the assembled volume (key 0).
    this.volumeChannelData.clear();
    this.volumeChannelData.set(0, data);
    this.subscribeScatter3dDisplayState();
    this.scheduleReadback();
  }

  /** Store colormap / reverse / invert / channel window → the 3D scatter's colormap + contrast. */
  private subscribeScatter3dDisplayState(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = combineLatest([
      this.store.getColormap(),
      this.store.getReverseScale(),
      this.store.getInvert(),
      this.store.getChannelStates(),
    ]).subscribe(([colormap, reverse, invert, channels]) => {
      this.currentColormap = (colormap as ColormapNode) ?? null;
      this.currentReverse = reverse;
      this.invertEnabled = invert;
      const layer = this.scatter3dLayer;
      if (!layer) return;
      const st = channels[0];
      layer.colormap = this.volumeColormap(st);
      if (st) layer.contrastLimits = [st.min, st.max];
      this.viewer?.requestRender();
    });
  }

  /**
   * Mount the NAPARI_SURFACE height-field surface. A height field is single-scalar, so for a
   * multichannel image the surface follows ONE band — the first visible channel (fallback 0) —
   * coloured by that channel's window/colormap (like the Plotly SURFACE, which is grayscale-only).
   * Pre-loads every slice's height data with a progress bar (as the volume does) so the stack
   * slider re-slices instantly, then builds the mesh for the current slice. All mesh + GPU work
   * lives in napari-js (`heightField` + `Viewer.addSurface`); this backend supplies scalar slices.
   */
  private async mountSurface(viewer: Viewer): Promise<void> {
    const desc = await this.ensureDescriptor();
    const multichannel = !!desc?.multichannel && (desc?.channels ?? 1) > 1;
    const states = this.store.currentChannelStates();
    this.surfaceChannel = multichannel ? states.find((s) => s.visible)?.index ?? 0 : undefined;
    this.surfaceMaxGrid = surfaceResolutionFor(this.resolutionScale).maxGrid;
    this.imageMode = 'grayscale';
    this.volumeMultichannel = false;
    await this.preloadSurfacePlanes(viewer);
    if (this.viewer !== viewer) return;
    await this.buildSurface(viewer, this.loaded?.z ?? 0);
    this.installSurfaceAxes(viewer);
    // Subscribe after the first build so display-state edits target a live layer.
    this.subscribeSurfaceDisplayState();
  }

  /** Add the 3D axes gizmo + DOM labels around the (origin-centered) surface mesh, matching the
   *  volume/isosurface. Installed once per mount; the box tracks the mesh bounds, X/Y show the
   *  physical (or pixel) extent, and Z is the intensity/height axis. */
  private installSurfaceAxes(viewer: Viewer): void {
    if (!this.surfaceLayer) return;
    const b = this.surfaceLayer.bounds();
    const boxW = Math.max(1, b.max[0] - b.min[0]);
    const boxH = Math.max(1, b.max[1] - b.min[1]);
    const boxD = Math.max(1, b.max[2] - b.min[2]);
    const mppX = this.descriptor?.mppX || this.loaded?.imageInfo.imageMeta?.[0]?.mppX || 0;
    const voxel = mppX > 0 ? (mppX * (this.descriptor?.width ?? this.imageW)) / Math.max(1, this.imageW) : 1;
    this.axesLayer = viewer.addAxes(boxW, boxH, boxD, {
      voxelSize: [voxel, voxel, 1],
      visible: this.axesVisible,
    });
    if (this.host) {
      this.axesLabels = new NapariAxesLabels(
        this.host,
        viewer.camera3d,
        this.buildSurfaceAxesLabels(boxW, boxH, boxD, mppX),
      );
      this.axesLabels.setVisible(this.axesVisible);
    }
  }

  /** X/Y/Z end-labels for the surface gizmo: X/Y are the physical (µm) or pixel extent of the FULL
   *  image; Z is the intensity/height axis. Anchors are in the centered box (matching AxesLayer). */
  private buildSurfaceAxesLabels(
    boxW: number,
    boxH: number,
    boxD: number,
    mppX: number,
  ): AxisLabelSpec[] {
    const hx = boxW / 2;
    const hy = boxH / 2;
    const hz = boxD / 2;
    const descW = this.descriptor?.width ?? this.imageW;
    const descH = this.descriptor?.height ?? this.imageH;
    const len = (px: number): string => (mppX > 0 ? formatUm(px * mppX) : `${px} px`);
    return [
      { anchor: [hx, -hy, -hz], text: `X · ${len(descW)}`, color: '#ed4545' },
      { anchor: [-hx, hy, -hz], text: `Y · ${len(descH)}`, color: '#4dd959' },
      { anchor: [-hx, -hy, hz], text: 'Z · intensity', color: '#668cff' },
    ];
  }

  /**
   * Pre-fetch every stack slice's luminance plane (decimated to the surface grid) into
   * {@link surfacePlanes}, driving {@link stackLoadingProgress$} — the same load-with-progress UX
   * as the volume, but keeping one 2D plane per slice rather than packing a 3D volume. Bounded
   * concurrency keeps the connection pool busy without flooding it on a deep stack.
   */
  private async preloadSurfacePlanes(viewer: Viewer): Promise<void> {
    const token = this.loadToken; // bail if a Cancel / new plot bumps this while we fetch
    const info = this.loaded?.imageInfo;
    const depth = info?.imageMeta?.[0]?.z || info?.urls?.length || 1;
    const { maxGrid } = surfaceResolutionFor(this.resolutionScale);
    this.surfacePlanes.clear();
    this.stackLoading$.next(true);
    this.stackLoadingProgress$.next(0);
    try {
      const pending: number[] = [];
      for (let z = 0; z < depth; z++) pending.push(z);
      let done = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const z = pending.shift();
          if (z === undefined || this.viewer !== viewer || this.loadToken !== token) return;
          try {
            this.surfacePlanes.set(z, await this.fetchSurfacePlane(z, maxGrid));
          } catch (err) {
            console.warn(`[napari-js] surface slice ${z} preload failed`, err);
          }
          done++;
          this.stackLoadingProgress$.next(Math.round((done / depth) * 100));
        }
      };
      const pool = Math.min(VOLUME_FETCH_CONCURRENCY, Math.max(1, depth));
      await Promise.all(Array.from({ length: pool }, () => worker()));
    } finally {
      this.stackLoading$.next(false);
      this.stackLoadingProgress$.next(0);
    }
  }

  /**
   * Fetch slice `z` as a single WHOLE-image luminance plane (decimated to `maxGrid`). Prefers the
   * app's complete per-slice image (`smallUrls`/`urls`, exactly like the Plotly surface) so the
   * surface always covers the FULL slice — the tile-pyramid `fetchSlice` path would fall back to a
   * single top-left tile (a corner) for self-contained / non-`/tiles/info` images. Falls back to
   * stitching the tile grid only when no complete-image URL is available.
   */
  /** Tile budget to stitch a whole slice at ~`targetPx` resolution from the pyramid: a higher target
   *  pulls a FINER pyramid level (more real detail). Shared by the surface plane fetch and the volume
   *  assembly so both scale their in-plane resolution with the decimate factor. */
  private tileBudgetFor(targetPx: number): number {
    const tileSize = this.descriptor?.tileSize || TILE_SIZE;
    return Math.min(
      MAX_STITCH_TILES,
      Math.max(1, Math.round((targetPx / tileSize) ** 2 * STITCH_BUDGET_COEFF)),
    );
  }

  private async fetchSurfacePlane(
    z: number,
    maxGrid: number,
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const info = this.loaded?.imageInfo;
    const desc = await this.ensureDescriptor();
    let plane: { data: Uint8Array; width: number; height: number } | null = null;

    // Preferred: stitch the WHOLE slice from the server pyramid at a resolution driven by the
    // decimate factor — a higher target grid pulls a FINER pyramid level (more real detail). With a
    // descriptor, fetchSlice stitches the whole chosen level (never a corner), then we downscale to
    // the grid. This is what makes "Full" actually higher-res than "½", not just a fixed preview.
    if (desc?.levels?.length) {
      const budget = this.tileBudgetFor(maxGrid);
      // The surface is a single decimated plane, so the composite fallback is acceptable when the
      // channel has no small pyramid level (keeps it fast); a multichannel VOLUME must not do this.
      plane = this.bitmapToLuminance(
        await this.fetchSlice(z, this.surfaceChannel, budget, true),
        maxGrid,
      );
    }

    // Fallback (no pyramid): the app's COMPLETE per-slice image (urls[z], not the small blurry
    // thumbnail) — whole slice, avoids a corner tile. Capped at the image's own resolution.
    if (!plane) {
      const url = info?.urls?.[z] ?? info?.smallUrls?.[z];
      if (url) {
        try {
          const headers = await this.tiles
            .getAuthHeaders()
            .catch(() => ({}) as Record<string, string>);
          const resp = await fetch(url, { headers });
          if (resp.ok) {
            plane = this.bitmapToLuminance(await createImageBitmap(await resp.blob()), maxGrid);
          }
        } catch (err) {
          console.warn(`[napari-js] surface url fetch failed for z=${z}`, err);
        }
      }
    }

    // Last resort (no pyramid and no complete image): a single tile.
    if (!plane) {
      plane = this.bitmapToLuminance(
        await this.fetchSlice(z, this.surfaceChannel, this.tileBudgetFor(maxGrid), true),
        maxGrid,
      );
    }
    return plane;
  }

  /** The channel state driving the surface: the chosen band for multichannel (matched by index),
   *  else the single grayscale channel. */
  private surfaceState(channels: IChannelState[]): IChannelState | undefined {
    if (this.surfaceChannel == null) return channels[0];
    return channels.find((s) => s.index === this.surfaceChannel) ?? channels[0];
  }

  /**
   * (Re)build the surface mesh for slice `z` from the pre-loaded plane cache (instant — this is
   * what the stack slider calls); a slice missing from the cache is fetched on demand. napari-js's
   * pure `heightField` builds the triangle grid (z = normalized intensity), then `addSurface`
   * renders it. The slice plane also feeds the intensity histogram (key 0).
   */
  private async buildSurface(viewer: Viewer, z: number): Promise<void> {
    let plane = this.surfacePlanes.get(z);
    if (!plane) {
      this.stackLoading$.next(true);
      try {
        plane = await this.fetchSurfacePlane(z, this.surfaceMaxGrid);
        this.surfacePlanes.set(z, plane);
      } catch (err) {
        console.error('[napari-js] surface slice fetch failed:', err);
      } finally {
        this.stackLoading$.next(false);
      }
    }
    if (!plane || plane.width < 2 || plane.height < 2 || this.viewer !== viewer) return;

    const st = this.surfaceState(this.store.currentChannelStates());
    const win: [number, number] = [st?.min ?? 0, st?.max ?? 255];
    this.surfaceWindow = win;
    // Height AND colour are normalized by the same contrast window, so changing min/max reshapes the
    // surface (a pixel's height = its intensity within [min,max]). Center it for the axes gizmo. The
    // plane is already decimated to the grid cap → stride 1.
    const zScale = SURFACE_Z_ASPECT * Math.max(plane.width, plane.height);
    const { vertices, faces, values } = heightField(plane.data, plane.width, plane.height, {
      zScale,
      zLimits: win,
      center: true,
    });

    // Preserve the orbit camera across a re-slice / window rebuild — only the first mount frames, so
    // stepping the stack or changing the window keeps the current zoom/pan/orientation.
    const cam = viewer.camera3d;
    const preserveCamera = this.surfaceLayer != null;
    const savedTarget = cam.target;
    const savedDistance = cam.distance;
    if (this.surfaceLayer) {
      viewer.layers.remove(this.surfaceLayer);
      this.surfaceLayer = null;
    }
    this.surfaceLayer = viewer.addSurface(vertices, faces, values, {
      colormap: this.volumeColormap(st),
      contrastLimits: win,
      gamma: st?.gamma ?? 1,
      wireframe: this.surfaceWireframe,
    });
    if (preserveCamera) {
      cam.target = savedTarget;
      cam.distance = savedDistance;
    }

    this.imageW = plane.width;
    this.imageH = plane.height;
    this.volumeDims = { width: plane.width, height: plane.height, depth: Math.max(1, Math.round(zScale)) };
    // Reuse the volume intensity-histogram path: the slice's scalar plane is the histogram source.
    this.volumeChannelData.clear();
    this.volumeChannelData.set(0, plane.data);
    this.scheduleReadback();
  }

  /** Subscribe the store colormap / reverse / invert / channel window → the surface, so histogram
   *  & channel-dialog edits update it live without a re-fetch. **min/max reshapes the surface's
   *  height** (a pixel's height = its intensity within [min,max]), so a window change rebuilds the
   *  mesh geometry (from the cached slice); colour-only edits (colormap/LUT, gamma, reverse, invert)
   *  just update the layer's uniforms. */
  private subscribeSurfaceDisplayState(): void {
    this.displaySub?.unsubscribe();
    this.displaySub = combineLatest([
      this.store.getColormap(),
      this.store.getReverseScale(),
      this.store.getInvert(),
      this.store.getChannelStates(),
    ]).subscribe(([colormap, reverse, invert, channels]) => {
      this.currentColormap = (colormap as ColormapNode) ?? null;
      this.currentReverse = reverse;
      this.invertEnabled = invert;
      const layer = this.surfaceLayer;
      if (!layer || !this.viewer) return;
      const st = this.surfaceState(channels);
      const win: [number, number] = [st?.min ?? 0, st?.max ?? 255];
      const windowChanged =
        !this.surfaceWindow || win[0] !== this.surfaceWindow[0] || win[1] !== this.surfaceWindow[1];
      if (windowChanged) {
        // Height follows the contrast window → rebuild the mesh for the new [min,max] (camera kept).
        void this.buildSurface(this.viewer, this.loaded?.z ?? 0).catch((err) =>
          console.error('[napari-js] surface window rebuild failed:', err),
        );
        return;
      }
      // Colour-only change: update uniforms in place, no geometry rebuild.
      layer.colormap = this.volumeColormap(st);
      if (st) {
        layer.contrastLimits = win;
        layer.gamma = st.gamma;
      }
      this.viewer.requestRender();
    });
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
    this.loadToken++; // invalidate any in-flight frame loading from the previous plot
    this.displaySub?.unsubscribe();
    this.displaySub = null;
    this.scaleBar?.destroy();
    this.scaleBar = null;
    this.regionOverlay?.destroy();
    this.regionOverlay = null;
    this.axesLabels?.destroy();
    this.axesLabels = null;
    this.cachedImage = null;
    this.cachedImageSource = null;
    this.lastPixelsRect = null;
    this.nativeHistograms.clear();
    this.tiled = false;
    this.histSamples.clear();
    if (this.readbackTimer != null) {
      clearTimeout(this.readbackTimer);
      this.readbackTimer = null;
    }
    this.cameraReadbackOff?.();
    this.cameraReadbackOff = null;
    this.channelView = null;
    this.viewer?.dispose();
    this.viewer = null;
    if (this.canvas && this.host?.contains(this.canvas)) this.host.removeChild(this.canvas);
    this.canvas = null;
    this.lastPixels = null;
    this.volumeView = null;
    this.volumeMultichannel = false;
    this.surfaceLayer = null;
    this.surfaceChannel = undefined;
    this.surfacePlanes.clear();
    this.surfaceWindow = null;
    this.scatterRegionSub?.unsubscribe();
    this.scatterRegionSub = null;
    this.scatter2dPoints = null;
    this.scatter3dLayer = null;
    this.axesLayer = null;
    this.volumeDims = null;
    this.volumeChannelData.clear();
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
    // No-op: pan and zoom are always the napari camera's default gestures, and pan/zoom gating for
    // drawing is owned by the region overlay's setMode (setControlsEnabled). Toggling controls here
    // would fight that — the host calls setDragMode(false) alongside overlay.setMode(<tool>).
  }

  setNavigatorVisible(_visible: boolean): void {
    /* napari-js has no minimap; no-op */
  }

  setImageSmoothingEnabled(enabled: boolean): void {
    this.imageSmoothing = enabled;
    // Apply live to the rendered image layers; baked into the next render too.
    this.channelView?.setInterpolation(enabled ? 'linear' : 'nearest');
  }

  setShowStack(_showstack: boolean): void {
    /* stack navigated via setZIndex */
  }

  setZIndex(zIndex: number): void {
    if (this.loaded) this.loaded.z = zIndex;
    const v = this.viewer;
    if (!v) return;
    // Surface: one slice → one mesh, so re-build the height field for the new slice.
    if (this.surfaceLayer) {
      void this.buildSurface(v, zIndex).catch((err) =>
        console.error('[napari-js] setZIndex surface failed:', err),
      );
      return;
    }
    // Volume / isosurface: step the volume's z plane in place.
    if (this.volumeView) {
      v.dims.z = zIndex;
      this.scheduleReadback();
      return;
    }
    // Tiled 2D image: just move the dims plane — the tiled visual fetches the new slice's tiles
    // (cached per z), no layer rebuild. Refresh the coarse histogram sample for the new slice.
    if (this.tiled) {
      v.dims.z = zIndex;
      if (this.descriptor) void this.refreshHistogramSamples(zIndex, this.descriptor);
      this.scheduleReadback();
      return;
    }
    // 2D image (stitch fallback): re-render the slice (re-fetches per-channel / composite). Branch
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

  /** Cancel in-flight frame loading: bump the load generation so the volume-assembly / surface
   *  preload workers stop fetching more frames, and clear the loading flag + progress. */
  cancelLoading(): void {
    this.loadToken++;
    this.stackLoading$.next(false);
    this.stackLoadingProgress$.next(0);
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

  /** Re-frame the 3D camera on the current 3D layer. A surface mesh sits in the positive octant
   *  (not centred), so frame it by its own bounds; a volume/isosurface uses its centred box. */
  resetSurfaceCamera(): void {
    if (!this.viewer) return;
    const meshLayer = this.surfaceLayer ?? this.scatter3dLayer;
    if (meshLayer) {
      const b = meshLayer.bounds();
      this.viewer.camera3d.target = b.center;
      this.viewer.camera3d.distance = Math.max(b.radius * 2.5, 1e-3);
      this.viewer.requestRender();
      return;
    }
    const d = this.volumeDims;
    if (d) this.viewer.camera3d.frame(d.width, d.height, d.depth);
  }

  getAutoscaleEvent(): Observable<unknown> {
    return this.autoscaleEvent$.asObservable();
  }

  getPlotTypeDescriptors(): PlotTypeDescriptor[] {
    // The WebGPU napari-js options, offered alongside (not replacing) the OSD/Plotly types.
    return [
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_IMAGE]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_SCATTER]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_SURFACE]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_SCATTER3D]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_VOLUME]!,
      PLOT_TYPE_DESCRIPTORS[PlotType.NAPARI_ISOSURFACE]!,
    ];
  }

  /** The napari 3D decimate factor (1 = full … 8 = ⅛). Read by the toolbar to init the control. */
  getResolutionScale(): number {
    return this.resolutionScale;
  }

  /** Set the decimate factor for the napari 3D types. Takes effect on the next (re)load — the host
   *  re-plots after calling this, since decimation changes the fetched/assembled data. */
  setResolutionScale(scale: number): void {
    this.resolutionScale = Math.max(1, Math.round(scale));
  }

  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.intensityProfile$.asObservable();
  }

  renderIntensityInset(_divId: string, _profiles: IntensityProfile[]): void {
    /* Plotly owns the intensity inset */
  }

  /** Read the displayed composite into `lastPixels` (the pixel-tools' source) + emit the clamped
   *  visible region. A fresh PixelData object means cachedImageData() rebuilds automatically. */
  private async runReadback(): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    try {
      const px = await v.readDisplayedPixels();
      if (this.viewer !== v) return;
      const rect = v.visibleWorldRect(); // capture WITH the pixels (same camera)
      this.lastPixels = px;
      this.lastPixelsRect = rect;
      const size = this.getTrueImageSize();
      if (size && rect) {
        const x = Math.max(0, Math.min(size.width, rect.x));
        const y = Math.max(0, Math.min(size.height, rect.y));
        const width = Math.max(1, Math.min(size.width - x, rect.width));
        const height = Math.max(1, Math.min(size.height - y, rect.height));
        this.viewportChange$.next({ x, y, width, height });
      }
    } catch {
      /* readback unavailable */
    }
  }

  private scheduleReadback(): void {
    if (!this.viewer) return;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => void this.runReadback());
    else setTimeout(() => void this.runReadback(), 0);
  }

  /** Debounced readback — armed on camera changes so `lastPixels` tracks the current view after a
   *  pan/zoom settles (and after tiled levels finish loading), which the on-canvas pixel tools
   *  (wand/brush/SAM) read synchronously. Coalesces rapid changes. */
  private armReadback(delayMs = 250): void {
    if (this.readbackTimer != null) clearTimeout(this.readbackTimer);
    this.readbackTimer = setTimeout(() => {
      this.readbackTimer = null;
      void this.runReadback();
    }, delayMs);
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

  // ── Pixel tools: reuse the shared, backend-agnostic tool services with a napari host ───────

  /** Build the coordinate transform + tool hosts for the current viewer (called from plot()). The
   *  pixel tools read displayed pixels synchronously from the last readback and convert pointer
   *  coords via the napari camera, exactly mirroring the OSD host. */
  private buildToolHosts(): void {
    if (!this.viewer) return;
    this.coordTransform = new NapariCoordinateTransform(
      this.viewer,
      () => !!this.viewer && this.imageW > 0,
    );
    const regions = this.regionStore;
    this.wandHost = {
      getRegions: () => regions.getRegions(),
      setRegions: (r) => regions.setRegions(r),
      getCachedImageData: () => this.cachedImageData(),
      getActiveFrameIndex: () => this.loaded?.z ?? 0,
      getOverlayContainer: () => this.host,
      getCoordinateTransform: () => this.coordTransform as ICoordinateTransform,
      getFileName: () => this.loaded?.filename,
      getShapeColor: () => regions.getShapeColor(),
    };
    this.eraserHost = {
      getRegions: () => regions.getRegions(),
      setRegions: (r) => regions.setRegions(r),
      invalidateWandRegion: () => this.wandTool.clearActiveRegion(),
      getOverlayContainer: () => this.host,
      getCoordinateTransform: () => this.coordTransform as ICoordinateTransform,
      getCachedImageRatio: () => this.cachedImageData()?.ratios[0] ?? 1,
    };
  }

  private zoomBoxHost(): ZoomToBoxToolHost {
    return {
      getPlotDiv: () => this.plotDivId,
      pixelToData: (px, py) => {
        const rect = this.host?.getBoundingClientRect();
        if (!this.viewer || !rect) return { x: 0, y: 0 };
        const [x, y] = this.viewer.canvasToWorld(rect.left + px, rect.top + py);
        return { x, y };
      },
      applyZoomToBox: (coords) => this.applyZoomToBox(coords),
    };
  }

  /** Zoom/pan the camera to fit a data-space rectangle `[xMin, xMax, yMax, yMin]`. */
  private applyZoomToBox(coordinates: number[]): void {
    const v = this.viewer;
    if (!v || !this.canvas || coordinates.length < 4) return;
    const [xMin, xMax, yA, yB] = coordinates;
    const x0 = Math.min(xMin, xMax);
    const x1 = Math.max(xMin, xMax);
    const y0 = Math.min(yA, yB);
    const y1 = Math.max(yA, yB);
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const vw = this.canvas.clientWidth || w;
    const vh = this.canvas.clientHeight || h;
    v.camera.center = [(x0 + x1) / 2, (y0 + y1) / 2];
    v.camera.zoom = Math.min(vw / w, vh / h);
    v.requestRender();
  }

  /** Build CachedImageData from the most recent readback (RGBA device pixels → [y][x]=[r,g,b]),
   *  with ratios/origin mapping image coords ↔ readback pixels. Cached until the readback changes. */
  private cachedImageData(): CachedImageData | null {
    const px = this.lastPixels;
    if (!px || !this.viewer) return null;
    if (this.cachedImage && this.cachedImageSource === px) return this.cachedImage;
    const w = px.width;
    const h = px.height;
    const data = px.data;
    const matrix: number[][][] = new Array(h);
    for (let y = 0; y < h; y++) {
      const row: number[][] = new Array(w);
      const base = y * w * 4;
      for (let x = 0; x < w; x++) {
        const o = base + x * 4;
        row[x] = [data[o], data[o + 1], data[o + 2]];
      }
      matrix[y] = row;
    }
    // Use the rect captured WITH this readback (not the live one) so ratios/origin match the
    // matrix's camera — otherwise a pan/zoom since the readback mis-scales the traced region.
    const rect = this.lastPixelsRect ?? this.viewer.visibleWorldRect();
    this.cachedImage = {
      frames: [matrix],
      width: w,
      height: h,
      ratios: [rect.width / w, rect.height / h],
      isGrayscale: false,
      originX: rect.x,
      originY: rect.y,
    };
    this.cachedImageSource = px;
    return this.cachedImage;
  }

  // ── IToolController ────────────────────────────────────────────────────────
  // Control gating: a tool that ACTIVATES disables the camera controls; deactivation is a no-op
  // because the host always calls the region overlay's setMode FIRST in each toggle (which sets
  // the baseline enabled/disabled), so re-enabling here would fight a freshly-activated draw mode.
  setWandMode(active: boolean, options?: IWandOptions): void {
    if (!this.viewer) return; // no plot yet → nothing to drive
    if (!active) {
      this.wandTool.setMode(false);
      return;
    }
    this.viewer?.setControlsEnabled(false);
    this.cachedImageSource = null;
    this.armReadback(0);
    if (this.wandHost) this.wandTool.bindHost(this.wandHost);
    this.wandTool.setMode(true, (options ?? {}) as unknown as WandOptions);
  }
  setWandOptions(options: IWandOptions): void {
    this.wandTool.setOptions((options ?? {}) as unknown as WandOptions);
  }
  clearActiveWandRegion(): void {
    this.wandTool.clearActiveRegion();
  }
  setBrushMode(active: boolean, options?: IBrushOptions): void {
    if (!this.viewer) return;
    if (!active) {
      this.brushTool.setMode(false);
      return;
    }
    this.viewer?.setControlsEnabled(false);
    this.cachedImageSource = null;
    this.armReadback(0);
    if (this.wandHost) this.brushTool.bindHost(this.wandHost);
    this.brushTool.setMode(true, (options ?? {}) as unknown as BrushOptions);
  }
  setBrushOptions(options: IBrushOptions): void {
    if (options?.size != null) this.brushTool.setSize(options.size);
  }
  setVertexEraserMode(active: boolean): void {
    if (!this.viewer) return;
    if (active) {
      this.viewer?.setControlsEnabled(false);
      this.cachedImageSource = null;
      if (this.eraserHost) this.eraserTool.bindHost(this.eraserHost);
    }
    this.eraserTool.setMode(active);
  }
  setVertexEraserRadius(radius: number): void {
    this.eraserTool.setRadius(radius);
  }
  setZoomToBoxMode(active: boolean): void {
    if (!this.viewer) return;
    if (active) {
      this.viewer?.setControlsEnabled(false);
      this.zoomToBoxTool.bindHost(this.zoomBoxHost());
    }
    this.zoomToBoxTool.setMode(active);
  }
  // SAM / cellpose — server round-trips that read the drawn rectangles + displayed pixels through
  // the same wand host (rectangles from the RegionStore, image from the readback).
  async segmentRectangles(): Promise<number> {
    if (!this.viewer || !this.wandHost) return 0;
    await this.runReadback(); // the SAM embedding samples the currently-displayed image
    this.cachedImageSource = null;
    this.samTool.bindHost(this.wandHost);
    return this.samTool.segmentBoxes();
  }
  async segmentRectanglesCellpose(): Promise<number> {
    if (!this.viewer || !this.wandHost || !this.cellSegmenter) return 0;
    await this.runReadback();
    this.cachedImageSource = null;
    this.cellSegmentTool.bindHost(this.wandHost);
    return this.cellSegmentTool.segmentBoxes(this.cellSegmenter);
  }
  setSamModel(id: string): void {
    this.samTool.setModel(id);
    this.samPointTool.setModel(id);
  }
  setSamPointMode(active: boolean): void {
    if (!this.viewer) return;
    if (active) {
      this.viewer?.setControlsEnabled(false);
      this.cachedImageSource = null;
      this.armReadback(0); // refresh the readback the click's embedding will sample
      if (this.wandHost) this.samPointTool.bindHost(this.wandHost);
    }
    this.samPointTool.setMode(active);
  }
  commitSamPoints(): void {
    this.samPointTool.commit();
  }
  clearSamPoints(): void {
    this.samPointTool.clear();
  }

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
    return this.regionOverlay;
  }
  getIsosurfaceControls(): IIsosurfaceControls | null {
    if (!this.volumeView) return null;
    return {
      setIsoRange: (isoMin: number, isoMax: number): void => {
        // Apply to every channel's volume layer.
        for (const layer of this.volumeView?.layers ?? []) {
          layer.contrastLimits = [isoMin, isoMax];
          layer.rendering = 'iso';
          layer.isoThreshold = 0.5;
        }
        this.viewer?.requestRender();
      },
    };
  }
  getIntensityControls(): IIntensityControls | null {
    return null;
  }
  getSurface3dControls(): ISurface3dControls | null {
    if (!this.volumeView && !this.surfaceLayer && !this.scatter3dLayer) return null;
    return {
      setSurfaceDragMode: (mode: string): void => this.setSurfaceDragMode(mode),
      resetSurfaceCamera: (): void => this.resetSurfaceCamera(),
      setAxesVisible: (visible: boolean): void => {
        this.axesVisible = visible;
        this.axesLabels?.setVisible(visible);
        if (this.axesLayer) {
          this.axesLayer.visible = visible;
          this.viewer?.requestRender();
        }
      },
      axesVisible: (): boolean => this.axesVisible,
      // Surface wireframe (napari-js surface only) — a live layer property, no rebuild needed.
      setWireframe: (on: boolean): void => {
        this.surfaceWireframe = on;
        if (this.surfaceLayer) {
          this.surfaceLayer.wireframe = on;
          this.viewer?.requestRender();
        }
      },
      wireframe: (): boolean => this.surfaceWireframe,
    };
  }
  getHistogram(channelIndex: number, bins: number): IHistogram | null {
    const v = this.viewer;
    if (!v) return null;
    // Volume / isosurface: intensity histogram of the assembled (downsampled) uint8 volume for the
    // requested channel (multichannel) or the single grayscale volume (key 0).
    if (this.volumeChannelData.size) {
      const data = this.volumeChannelData.get(channelIndex) ?? this.volumeChannelData.get(0);
      return data ? this.toIHistogram(histogramScalar(data, bins, 0, 255)) : null;
    }
    // Tiled mode has no full in-memory pixels → use the coarse per-channel sample (RGB: readback).
    if (this.tiled) {
      if (this.imageMode === 'rgb') return this.rgbHistogram(channelIndex, bins);
      const sample = this.histSamples.get(this.imageMode === 'grayscale' ? 0 : channelIndex);
      return sample ? this.toIHistogram(histogramScalar(sample, bins, 0, 255)) : null;
    }
    // Grayscale/multichannel (stitch): native per-channel histogram straight from the in-memory
    // scalar layer (no GPU readback). RGB: bin the displayed pixels' R/G/B byte (8-bit client path).
    const layer = this.channelView?.layers[this.imageMode === 'grayscale' ? 0 : channelIndex];
    if (layer) {
      const h = v.layerHistogram(layer, bins);
      if (h) return this.toIHistogram(h);
    }
    if (this.imageMode === 'rgb') return this.rgbHistogram(channelIndex, bins);
    return null;
  }
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null> {
    // >8-bit channels: fetch the true native distribution from the server (the displayed pixels
    // are 8-bit, so the client histogram would be clipped). 8-bit channels use the client path.
    const bitDepth = this.descriptor?.channelInfo?.[channelIndex]?.bitDepth ?? 8;
    if (bitDepth > 8) {
      const z = this.loaded?.z ?? 0;
      const key = `${z}|${channelIndex}`;
      const cached = this.nativeHistograms.get(key);
      if (cached) return of(cached);
      return from(this.fetchNativeHistogram(channelIndex, bins, z, key));
    }
    return of(this.getHistogram(channelIndex, bins));
  }

  /** Fetch + cache one channel's native-bit-depth histogram from `GET /histogram` (>8-bit). */
  private async fetchNativeHistogram(
    channel: number,
    bins: number,
    z: number,
    key: string,
  ): Promise<IHistogram | null> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return null;
    const headers = await this.tiles
      .getAuthHeaders()
      .catch(() => ({}) as Record<string, string>);
    const url = `${this.api}histogram?info=${infoB64}&channel=${channel}&z=${z}&bins=${bins}`;
    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) return null; // 202 (still caching) or transient → null; the pane retries
      const hi = (await resp.json()) as {
        bitDepth: number;
        rangeMin: number;
        rangeMax: number;
        observedMin: number;
        observedMax: number;
        binWidth: number;
        counts: number[];
      };
      if (!hi?.counts) return null;
      const out: IHistogram = {
        bins: hi.counts.map((_, i) => hi.rangeMin + i * hi.binWidth),
        counts: hi.counts,
        max: hi.counts.reduce((m, c) => (c > m ? c : m), 0),
        bitDepth: hi.bitDepth,
        rangeMin: hi.rangeMin,
        rangeMax: hi.rangeMax,
        observedMin: hi.observedMin,
        observedMax: hi.observedMax,
      };
      this.nativeHistograms.set(key, out);
      return out;
    } catch (err) {
      console.warn('[napari-js] native histogram fetch failed', err);
      return null;
    }
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
  /** Native-bit-depth (16/32-bit) multi-band TIFF export via the server `/export/tiff` endpoint —
   *  the displayed PNG is an 8-bit figure, this preserves the true pixel values. Visible channels
   *  only (omitted when all are visible → server default). Mirrors the OSD backend. */
  async exportData(): Promise<void> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return;
    const states = this.store.currentChannelStates();
    const visible = states.filter((c) => c.visible).map((c) => c.index);
    const chParam =
      visible.length && visible.length < states.length ? `&channels=${visible.join(',')}` : '';
    const z = this.loaded?.z ?? 0;
    const url = `${this.api}export/tiff?info=${infoB64}&z=${z}${chParam}`;
    const stem = (this.loaded?.filename || 'image').replace(/\.[^.]+$/, '');
    const headers = await this.tiles
      .getAuthHeaders()
      .catch(() => ({}) as Record<string, string>);
    try {
      const resp = await fetch(url, { headers });
      if (resp.status === 202) {
        console.warn('[napari-js] 16-bit export: file still caching — try again shortly.');
        return;
      }
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      saveAs(await resp.blob(), `${stem}_16bit.ome.tif`);
    } catch (err) {
      console.warn('[napari-js] 16-bit TIFF export failed', err);
    }
  }
  unsubscribe(): void {
    this.reset();
  }
}
