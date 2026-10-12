import { Observable, from, of } from 'rxjs';
import { saveAs } from 'file-saver';
import {
  LruCache,
  assembleVolume,
  bitmapToScalar,
  chooseStitchLevel,
  decodeImageRGBA,
  readLevel,
} from 'napari-js';
import type { PixelChunk, StitchBudget, TileKey, TiledSource } from 'napari-js';

import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState, IHistogram } from '../../contracts/channel-histogram-api.contract';
import { TileAccessPort } from '../../contracts/ports/tile-access.port';
import { SimpleSliceAccessService } from '../simple-slice-access.service';
import {
  TileDescriptor,
  buildTileUrl,
  exportTiffFilename,
  exportTiffUrl,
  fetchJsonWithAuth,
  fetchWithAuth,
  isAbortError,
  nativeHistogram,
  pollDescriptor,
  tilesInfoUrl,
} from '../tile-server';
import {
  DESCRIPTOR_POLL_INTERVAL_MS,
  DESCRIPTOR_TIMEOUT_MS,
  LumaPlane,
  MAX_STITCH_TILES,
  MAX_TEXTURE_DIM,
  RGB_BAND_CACHE_TILES,
  STITCH_BUDGET_COEFF,
  TILE_FETCH_CONCURRENCY,
  TILE_SIZE,
  VOLUME_FETCH_CONCURRENCY,
  VOLUME_MAX_SLICE,
  create2dCanvas,
  splitRgbBands,
  stackDepth,
} from './napari-helpers';

/** What the navigator draws: a whole-slice picture (a canvas read from the pyramid, or a bitmap). */
export type OverviewImage = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

/** An assembled uint8 (luminance) volume, x-fastest then y then z. */
export interface AssembledVolume {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
}

/** Decode an `ImageBitmap` to a single-channel uint8 luminance plane with napari-js's
 *  `bitmapToScalar` (server bands are grey, R=G=B, and decode exactly; a colour composite
 *  becomes its BT.601 luminance). `maxSide` caps the longest side (downscaling on the canvas
 *  draw) — used to keep pre-loaded surface slice planes small. Closes the bitmap. */
export function bitmapToLuminance(bmp: ImageBitmap, maxSide?: number): LumaPlane {
  const plane = bitmapToScalar(bmp, { maxSide, weights: 'bt601' });
  bmp.close?.();
  return plane;
}

/** A colour tile's R, G and B bands (closes a bitmap tile). */
function chunkToBands(chunk: PixelChunk): LumaPlane[] {
  if (typeof ImageBitmap !== 'undefined' && chunk.data instanceof ImageBitmap) {
    const bmp = chunk.data;
    try {
      return splitRgbBands(decodeImageRGBA(bmp));
    } finally {
      bmp.close?.();
    }
  }
  return splitRgbBands({ data: chunk.data as Uint8Array, width: chunk.width, height: chunk.height });
}

/**
 * The napari-js backend's client of the jit-service tile server (review Appendix B, step 2), on
 * the shared `tile-server/` protocol: the `/tiles/info` descriptor (polled, cached per source,
 * shared between concurrent callers), whole-slice reads from the pyramid (napari-js `readLevel`), the pyramidal
 * {@link TiledSource}s the 2D image draws, volume assembly, surface planes, the native `/histogram`
 * and the `/export/tiff` download.
 *
 * The image is always passed in — the client never reads which image the service has loaded —
 * so a descriptor can only ever describe the image a caller asked about (NAPARI-SVC-2).
 *
 * Scene-scoped state (the poll in flight, the sources that answered "no", the native histograms)
 * lives until {@link startScene}; the descriptor cache itself survives scenes, keyed by source.
 */
export class NapariTileClient {
  /** Cached `/tiles/info` pyramid descriptor + the infoB64 it was fetched for. */
  private descriptor: TileDescriptor | null = null;
  private descriptorKey: string | null = null;
  /** The poll in flight, shared by every caller asking for the same `infoB64`. */
  private descriptorPoll: { key: string; promise: Promise<TileDescriptor | null> } | null = null;
  /** `infoB64`s this scene's poll got no descriptor for (non-202 status, empty body, timeout).
   *  Scene-scoped, so a re-plot retries a slow or flaky server once. */
  private readonly descriptorMisses = new Set<string>();
  /** Native-bit-depth histograms from `/histogram`, keyed `${z}|${channel}` (>8-bit images). */
  private readonly nativeHistograms = new Map<string, IHistogram>();
  /** The current scene's lifetime: a poll started under it ends when it is aborted. */
  private scene: AbortSignal = new AbortController().signal;

  constructor(
    private readonly tiles: TileAccessPort,
    private readonly simpleStack: SimpleSliceAccessService,
    private readonly api: string,
  ) {}

  /** Whether `info` is a self-contained stack (`tiled:false`: each slice its own file, no
   *  server pyramid). */
  isSimple(info: IImageInfo | undefined): boolean {
    return this.simpleStack.isSimple(info);
  }

  /** A new scene: forget the scene-scoped state and poll under `signal` from now on. */
  startScene(signal: AbortSignal): void {
    this.scene = signal;
    this.descriptorPoll = null;
    this.descriptorMisses.clear();
    this.nativeHistograms.clear();
  }

  /**
   * Fetch + cache the server pyramid descriptor (`GET /tiles/info`): the REAL per-level tile grid,
   * tile size, channel metadata and physical pixel size. The backend returns 202 while the source
   * is still caching, so we poll ({@link pollDescriptor}). Cached per `infoB64`; returns null if it
   * never becomes ready, or the server will not describe the source (callers fall back to a
   * single-tile fetch). Read it back through {@link currentDescriptor}. This is the authoritative
   * grid — guessing level dims from `trueImageSize` overshoots the real grid and the server 400s
   * out-of-range tiles.
   */
  ensureDescriptor(info: IImageInfo | undefined): Promise<TileDescriptor | null> {
    // Self-contained multi-slice stack (no tile server — e.g. a numbered image
    // series assembled client-side, each slice a different file): there is no
    // single server-tiled pyramid to describe. Returning null routes every
    // caller (2D image, volume, surface) to their stitched/single-fetch
    // fallback, which — via fetchImage's own SimpleSliceAccessService branch —
    // correctly fetches each slice's own URL instead of one fixed file's tile
    // pyramid.
    if (this.simpleStack.isSimple(info)) return Promise.resolve(null);
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return Promise.resolve(null);
    if (this.descriptor && this.descriptorKey === infoB64) return Promise.resolve(this.descriptor);
    // A source that answered "no" (or never answered) this scene is not asked again: the render,
    // the stitch fallback and every slice would otherwise each wait out their own poll.
    if (this.descriptorMisses.has(infoB64)) return Promise.resolve(null);
    // Concurrent callers (render, navigator, histogram) share one poll.
    if (this.descriptorPoll?.key === infoB64) return this.descriptorPoll.promise;
    const scene = this.scene;
    const promise = this.pollDescriptor(infoB64, scene).then((desc) => {
      if (this.descriptorPoll?.promise === promise) this.descriptorPoll = null;
      if (desc) {
        this.descriptor = desc;
        this.descriptorKey = infoB64;
      } else if (!scene.aborted) {
        this.descriptorMisses.add(infoB64);
      }
      return desc;
    });
    this.descriptorPoll = { key: infoB64, promise };
    return promise;
  }

  /**
   * The `/tiles/info` loop behind {@link ensureDescriptor}: the shared jit-service poll
   * (`tile-server/pollDescriptor`). Re-polls only on 202 (the server is still caching the source);
   * any other status means this server will not describe it, so the answer is null at once. Each
   * request gives up after its own timeout — a hung request would otherwise never reach the
   * deadline check — and the whole poll ends (null) as soon as `scene` is aborted.
   */
  private async pollDescriptor(infoB64: string, scene: AbortSignal): Promise<TileDescriptor | null> {
    try {
      return await pollDescriptor(fetchJsonWithAuth(this.tiles), tilesInfoUrl(this.api, infoB64), {
        deadlineMs: DESCRIPTOR_TIMEOUT_MS,
        intervalMs: DESCRIPTOR_POLL_INTERVAL_MS,
        signal: scene,
        tag: '[napari-js]',
      });
    } catch (err) {
      if (isAbortError(err)) return null; // the scene was reset
      throw err;
    }
  }

  /**
   * The pyramid descriptor of `info`, or null when it has none.
   *
   * The cache is keyed by `infoB64` and survives image switches and failed polls, so reading it
   * directly would hand a `tiled:false` stack (or an image whose poll never answered) the
   * PREVIOUS image's size, µm/pixel, tile size and bit depth. Every read site goes through here.
   */
  currentDescriptor(info: IImageInfo | undefined): TileDescriptor | null {
    if (!this.descriptor || this.simpleStack.isSimple(info)) return null;
    return this.descriptorKey === this.tiles.getSelectedInfoB64() ? this.descriptor : null;
  }

  /** µm per pixel along x for `info`: the descriptor's, else the image metadata's; 0 when
   *  neither declares it. */
  mppX(info: IImageInfo | undefined): number {
    return this.currentDescriptor(info)?.mppX || info?.imageMeta?.[0]?.mppX || 0;
  }

  /**
   * Slice `z` as ONE image, for a source with no pyramid to read: a `tiled:false` stack's own
   * file for `z`, else (no descriptor) the server's single top-left tile — correct for
   * small/simple images.
   *
   * A self-contained multi-slice stack's `z` indexes a completely different file's own preview
   * URL, not an internal slice of one server-tiled file, so it is resolved and fetched via
   * SimpleSliceAccessService (shared with OSD; see its docs for why this can't be a bare fetch())
   * rather than as a /tile?info=...&z= request against whichever single file
   * getSelectedInfoB64() points at (which would 400/mismatch for any z beyond that one file's own
   * extent). `channel` selects a band: a serverless multichannel stack's own plane
   * (`channelUrls[z][channel]`, the client-side analog of the server's per-channel
   * `/tile?channel=c`), else the server's.
   */
  async fetchImage(info: IImageInfo | undefined, z: number, channel?: number): Promise<ImageBitmap> {
    if (this.simpleStack.isSimple(info)) {
      const chUrls = (info as IImageInfo).channelUrls;
      const url =
        channel != null && chUrls?.[z]?.[channel] != null
          ? chUrls[z][channel]
          : this.simpleStack.urlFor(info as IImageInfo, z);
      if (!url) throw new Error(`[napari-js] no URL for slice ${z}`);
      return this.simpleStack.fetchAsBitmap(url);
    }
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) throw new Error('[napari-js] no selected image info (getSelectedInfoB64 null)');
    const url = buildTileUrl(this.api, infoB64, { res: 0, col: 0, row: 0, z, tileSize: TILE_SIZE, channel });
    const resp = await fetchWithAuth(this.tiles, url);
    if (!resp.ok) throw new Error(`[napari-js] slice fetch failed: ${resp.status} (0/0 res 0)`);
    return createImageBitmap(await resp.blob());
  }

  /**
   * Slice `z` as a single-channel uint8 luminance plane. With a pyramid, napari-js's `readLevel`
   * reads it from the same {@link tiledSource} the 2D view draws: the finest level whose tile grid
   * fits `maxTiles` and whose longest side fits the GPU texture limit (no finer than `maxSide`
   * needs, when given), stitched with bounded concurrency and area-averaged down to `maxSide`.
   * Without one, the single image of {@link fetchImage}. `channel` selects a band (real levels
   * only); omit it for the composite, whose overview levels let a large image read a small level.
   * `compositeFallback`: see {@link planeSource}. `signal` cancels the read (it rejects).
   */
  async readPlane(
    info: IImageInfo | undefined,
    z: number,
    channel: number | undefined,
    opts: { maxTiles: number; maxSide?: number; compositeFallback?: boolean; signal?: AbortSignal },
  ): Promise<LumaPlane> {
    // A tiled:false stack has no pyramid: fetch its slice in this tick, as the 2D render does.
    const desc = this.simpleStack.isSimple(info) ? null : await this.ensureDescriptor(info);
    if (!desc?.levels?.length) return bitmapToLuminance(await this.fetchImage(info, z, channel), opts.maxSide);
    const budget: StitchBudget = {
      maxTiles: opts.maxTiles,
      maxSide: opts.maxSide,
      maxTextureDim: MAX_TEXTURE_DIM,
    };
    const source = opts.compositeFallback
      ? this.planeSource(desc, channel, budget)
      : this.tiledSource(desc, channel, 1);
    const img = await readLevel(source, z, {
      ...budget,
      concurrency: TILE_FETCH_CONCURRENCY,
      signal: opts.signal,
    });
    if (!img.fits && opts.maxTiles >= MAX_STITCH_TILES) {
      console.warn(
        `[napari-js] no level of slice ${z} fits the ${opts.maxTiles}-tile/${MAX_TEXTURE_DIM}px budget; ` +
          `read the coarsest (level ${img.level}) and downscaled it to ${img.width}×${img.height}.`,
      );
    }
    return { data: img.data as Uint8Array, width: img.width, height: img.height };
  }

  /**
   * The scalar source for one decimated plane of band `channel`. A band has tiles only at the
   * (few, large) real Bio-Formats levels; when none of them fits the budget — e.g. the coarsest
   * real level is still 14982×18670, ~1100 full-res tiles — stitching it per slice floods the
   * server (504s) and stalls the load. The composite pyramid has small overview levels, so the
   * plane is read from the composite instead (its luminance). Only for a caller that wants one
   * decimated plane (the surface height): for a multichannel VOLUME every channel would then read
   * the same composite and the channels would collapse into one, so volumes keep each band.
   */
  private planeSource(desc: TileDescriptor, channel: number | undefined, budget: StitchBudget): TiledSource {
    const band = this.tiledSource(desc, channel, 1);
    if (channel == null || desc.levels.length <= (desc.realLevels ?? desc.levels.length)) return band;
    const own = chooseStitchLevel(band, budget);
    if (own.fits) return band;
    const composite = this.tiledSource(desc, undefined, 1);
    const alt = chooseStitchLevel(composite, budget);
    if (!alt.fits && alt.cols * alt.rows >= own.cols * own.rows) return band;
    console.warn(
      `[napari-js] channel ${channel} has no pyramid level within the ${budget.maxTiles}-tile ` +
        `budget; using the composite overview (${alt.width}×${alt.height}) for this plane.`,
    );
    return composite;
  }

  /**
   * A small picture of the whole slice for the navigator: the composite (or band `channel`) at the
   * finest level a single tile holds, else the coarsest level, as an RGBA canvas. Without a
   * pyramid, the single image of {@link fetchImage}.
   */
  async overviewImage(info: IImageInfo | undefined, z: number, channel?: number): Promise<OverviewImage> {
    const desc = this.simpleStack.isSimple(info) ? null : await this.ensureDescriptor(info);
    if (!desc?.levels?.length) return this.fetchImage(info, z, channel);
    const img = await readLevel(this.tiledSource(desc, channel, 4), z, {
      maxTiles: 1,
      maxTextureDim: MAX_TEXTURE_DIM,
      concurrency: TILE_FETCH_CONCURRENCY,
    });
    const { canvas, ctx } = create2dCanvas(img.width, img.height, 'overview');
    const pixels = ctx.createImageData(img.width, img.height);
    pixels.data.set(img.data as Uint8Array);
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  }

  /**
   * Slice `z`'s R, G and B bands, as three uint8 planes: the composite read as RGBA at the
   * finest level within `maxTiles` (as {@link readPlane} picks it; 1 for a cheap overview
   * sample), else the single image of {@link fetchImage}. The raw bands of an RGB image, for the
   * per-band layers and their histograms.
   */
  async readRgbBands(
    info: IImageInfo | undefined,
    z: number,
    maxTiles: number = MAX_STITCH_TILES,
  ): Promise<LumaPlane[]> {
    const desc = this.simpleStack.isSimple(info) ? null : await this.ensureDescriptor(info);
    if (!desc?.levels?.length) {
      const bmp = await this.fetchImage(info, z);
      return chunkToBands({ width: bmp.width, height: bmp.height, data: bmp });
    }
    const img = await readLevel(this.tiledSource(desc, undefined, 4), z, {
      maxTiles,
      maxTextureDim: MAX_TEXTURE_DIM,
      concurrency: TILE_FETCH_CONCURRENCY,
    });
    return splitRgbBands({ data: img.data as Uint8Array, width: img.width, height: img.height });
  }

  /** Fetch slice `z` and read it back as a single-channel uint8 plane (see {@link readPlane}),
   *  within `budgetTiles`: the 2D stitch fallback reads at the full budget, the histogram samples
   *  at 1 for a cheap overview tile. */
  async fetchChannelData(
    info: IImageInfo | undefined,
    z: number,
    channel?: number,
    budgetTiles: number = MAX_STITCH_TILES,
  ): Promise<LumaPlane> {
    return this.readPlane(info, z, channel, { maxTiles: budgetTiles });
  }

  /** Tile budget to stitch a whole slice at ~`targetPx` resolution from the pyramid. Shared by the
   *  surface plane fetch and the volume assembly, so both cap their reads by the decimate factor. */
  tileBudgetFor(info: IImageInfo | undefined, targetPx: number): number {
    const tileSize = this.currentDescriptor(info)?.tileSize || TILE_SIZE;
    return Math.min(MAX_STITCH_TILES, Math.max(1, Math.round((targetPx / tileSize) ** 2 * STITCH_BUDGET_COEFF)));
  }

  /**
   * Build a pyramidal TiledSource backed by the server `/tile` endpoint. `channel` selects a band
   * (grayscale luminance, real levels only); omit it for the composite (RGBA, all levels).
   *
   * For the 2D view, `scene` is the signal of the render that asked for it, taken before that
   * render's awaits, and `onTile` is told of each tile request and handed back the tile's end. A
   * request issued once `scene` is aborted (a disposed source still fetching after a reset) is not
   * reported, and one that settles after it does not end, so it can never count toward the next
   * scene. A tile request's own `signal` (napari-js aborts a read it no longer needs) aborts the
   * HTTP request.
   */
  tiledSource(
    desc: TileDescriptor,
    channel: number | undefined,
    channels: 1 | 4,
    scene?: AbortSignal,
    onTile?: () => () => void,
  ): TiledSource {
    const infoB64 = this.tiles.getSelectedInfoB64() ?? '';
    // Per-channel tiles exist only at REAL Bio-Formats levels; the composite exists at all levels.
    const usable =
      channel == null ? desc.levels : desc.levels.slice(0, Math.max(1, desc.realLevels ?? desc.levels.length));
    const levelScales = usable.map((l) => desc.width / Math.max(1, l.width)); // level-0 px per level px
    const tileSize = desc.tileSize || TILE_SIZE;
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
      fetchTile: async (key: TileKey, signal?: AbortSignal): Promise<PixelChunk> => {
        const res = usable[key.level]?.res ?? key.level;
        const url = buildTileUrl(api, infoB64, {
          res,
          col: key.col,
          row: key.row,
          z: key.z,
          tileSize,
          channel,
        });
        const end = !onTile || scene?.aborted ? null : onTile();
        try {
          const resp = await fetchWithAuth(this.tiles, url, signal ? { signal } : {});
          if (!resp.ok) {
            throw new Error(`[napari-js] tile ${key.level}/${key.col}/${key.row} → ${resp.status}`);
          }
          const bmp = await createImageBitmap(await resp.blob());
          if (channels === 4) return { width: bmp.width, height: bmp.height, data: bmp };
          return bitmapToLuminance(bmp);
        } finally {
          if (!scene?.aborted) end?.();
        }
      },
    };
  }

  /**
   * The composite pyramid's R, G and B bands as three scalar {@link TiledSource}s — one per
   * additive layer, so each band takes its own window, gamma, invert, tint and visibility — that
   * share ONE `/tile` request per tile. The three layers ask for a tile in the same frame: the
   * first fetches the RGBA tile and splits it, the other two take their band from the same
   * promise, and the split tile is dropped once all three have it. A band that asks later (one
   * shown again after being hidden) finds it in a small LRU, else fetches it again. `scene` and
   * `onTile` as {@link tiledSource}: the loading badge counts the one request.
   */
  rgbBandSources(desc: TileDescriptor, scene?: AbortSignal, onTile?: () => () => void): TiledSource[] {
    const composite = this.tiledSource(desc, undefined, 4, scene, onTile);
    const split = new LruCache<{ bands: Promise<LumaPlane[]>; taken: Set<number> }>(RGB_BAND_CACHE_TILES);
    const band = (key: TileKey, b: number): Promise<PixelChunk> => {
      const id = `${key.z}/${key.level}/${key.col}/${key.row}`;
      let entry = split.get(id);
      if (!entry) {
        const bands = composite.fetchTile(key).then(chunkToBands);
        const fresh = { bands, taken: new Set<number>() };
        // A failed tile is not remembered: the next ask fetches it again.
        bands.catch(() => split.get(id) === fresh && split.delete(id));
        split.set(id, (entry = fresh));
      }
      entry.taken.add(b);
      if (entry.taken.size === 3) split.delete(id);
      return entry.bands.then((planes) => planes[b]);
    };
    return [0, 1, 2].map((b): TiledSource => ({
      ...composite,
      channels: 1,
      fetchTile: (key: TileKey) => band(key, b),
    }));
  }

  /**
   * Assemble a downsampled uint8 volume (luminance) of `info`'s stack with napari-js's
   * `assembleVolume`: every `sliceStep`th slice, read from the band's (or composite's) pyramid at
   * the level that `maxSlice` needs, within its tile budget, and area-averaged to `maxSlice` on
   * the longest side. Slices are read with bounded concurrency (the connection pool stays full
   * without flooding it on a deep stack), each reporting `progress` (0–100) as it lands so the host
   * shows a determinate progress bar. Null when `signal` aborts (a Cancel or a new plot), which
   * also aborts the tile requests in flight — a partial volume is never returned.
   */
  async assembleVolume(
    info: IImageInfo | undefined,
    opts: { maxSlice?: number; sliceStep?: number },
    channel: number | undefined,
    hooks: { signal: AbortSignal; progress(percent: number): void },
  ): Promise<AssembledVolume | null> {
    const { signal } = hooks;
    const fullDepth = stackDepth(info) || 1;
    const step = Math.max(1, Math.floor(opts.sliceStep ?? 1));
    const maxSlice = opts.maxSlice ?? VOLUME_MAX_SLICE;
    // Source-slice indices sampled into the volume (every `step`th plane → low-res is faster).
    const zIndices: number[] = [];
    for (let z = 0; z < fullDepth; z += step) zIndices.push(z);

    hooks.progress(0);
    try {
      // `channel` selects a band (multichannel volume); omit for the grayscale composite. The
      // caller owns the stackLoading flag (multichannel assembles channels in turn).
      const source = await this.volumeSource(info, channel, zIndices[0]);
      return await assembleVolume(source, zIndices, {
        maxSide: maxSlice,
        maxTiles: this.tileBudgetFor(info, maxSlice),
        maxTextureDim: MAX_TEXTURE_DIM,
        concurrency: VOLUME_FETCH_CONCURRENCY,
        tileConcurrency: TILE_FETCH_CONCURRENCY,
        onProgress: (done, total) => hooks.progress(Math.round((done / total) * 100)),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return null; // cancelled → don't render a partial volume
      throw err;
    } finally {
      hooks.progress(0);
    }
  }

  /**
   * The scalar source a volume reads: the band's (or composite's) pyramid; without one, one whole
   * image per slice ({@link fetchImage}) as a single-tile level sized by the first slice, which is
   * fetched here and served again as that slice's tile.
   */
  private async volumeSource(info: IImageInfo | undefined, channel: number | undefined, firstZ: number) {
    const desc = this.simpleStack.isSimple(info) ? null : await this.ensureDescriptor(info);
    if (desc?.levels?.length) return this.tiledSource(desc, channel, 1);
    let first: ImageBitmap | null = await this.fetchImage(info, firstZ, channel);
    const source: TiledSource = {
      kind: 'tiled',
      width: first.width,
      height: first.height,
      tileSize: Math.max(1, first.width, first.height),
      levels: 1,
      depth: stackDepth(info) || 1,
      channels: 1,
      dtype: 'uint8',
      fetchTile: async (key: TileKey): Promise<PixelChunk> => {
        let bmp: ImageBitmap;
        if (first && key.z === firstZ) {
          bmp = first;
          first = null;
        } else {
          bmp = await this.fetchImage(info, key.z, channel);
        }
        return { width: bmp.width, height: bmp.height, data: bmp };
      },
    };
    return source;
  }

  /**
   * Slice `z` as a single WHOLE-image luminance plane (decimated to `maxGrid`), for the surface.
   * Prefers the server pyramid, read at the level the grid needs ({@link readPlane}, which may
   * drop a band to the composite overview); without a descriptor, the app's complete per-slice
   * image (`urls`/`smallUrls`, as the Plotly surface) — never a lone top-left tile, which would be
   * a corner of the slice — and only as a last resort the single-tile fetch.
   */
  async fetchPlane(
    info: IImageInfo | undefined,
    z: number,
    channel: number | undefined,
    maxGrid: number,
  ): Promise<LumaPlane> {
    const desc = await this.ensureDescriptor(info);
    // Preferred: the WHOLE slice from the server pyramid at a resolution driven by the decimate
    // factor — a higher target grid reads a FINER pyramid level (more real detail). This is what
    // makes "Full" actually higher-res than "½", not just a fixed preview. The surface is a single
    // decimated plane, so the composite fallback is acceptable when the band has no small level.
    if (desc?.levels?.length) {
      return this.readPlane(info, z, channel, {
        maxTiles: this.tileBudgetFor(info, maxGrid),
        maxSide: maxGrid,
        compositeFallback: true,
      });
    }

    // Fallback (no pyramid): the app's COMPLETE per-slice image (urls[z], not the small blurry
    // thumbnail) — whole slice, avoids a corner tile. Capped at the image's own resolution.
    const url = info?.urls?.[z] ?? info?.smallUrls?.[z];
    if (url) {
      try {
        const resp = await fetchWithAuth(this.tiles, url);
        if (resp.ok) return bitmapToLuminance(await createImageBitmap(await resp.blob()), maxGrid);
      } catch (err) {
        console.warn(`[napari-js] surface url fetch failed for z=${z}`, err);
      }
    }

    // Last resort (no pyramid and no complete image): the single image.
    return bitmapToLuminance(await this.fetchImage(info, z, channel), maxGrid);
  }

  /**
   * Channel `channel`'s native-bit-depth histogram at slice `z` when `info` is a >8-bit image —
   * the displayed pixels are 8-bit, so a client histogram would be clipped — cached per
   * `(z, channel)`; null for an 8-bit channel, which the caller bins from the client data.
   */
  nativeHistogram$(
    info: IImageInfo | undefined,
    z: number,
    channel: number,
    bins: number,
  ): Observable<IHistogram | null> | null {
    const bitDepth = this.currentDescriptor(info)?.channelInfo?.[channel]?.bitDepth ?? 8;
    if (bitDepth <= 8) return null;
    const key = `${z}|${channel}`;
    const cached = this.nativeHistograms.get(key);
    if (cached) return of(cached);
    return from(this.fetchNativeHistogram(channel, bins, z, key));
  }

  /** Fetch + cache one channel's native-bit-depth histogram from `GET /histogram` (>8-bit),
   *  through the shared jit-service client — whose URL carries the per-app-load cache-buster
   *  this backend used to omit, so a reload showed the server's 24 h-cached histogram. */
  async fetchNativeHistogram(channel: number, bins: number, z: number, key: string): Promise<IHistogram | null> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return null;
    try {
      const out = await nativeHistogram(fetchJsonWithAuth(this.tiles), this.api, infoB64, {
        z,
        channel,
        bins,
      });
      if (!out) return null; // 202 (still caching) or transient → null; the pane retries
      this.nativeHistograms.set(key, out);
      return out;
    } catch (err) {
      console.warn('[napari-js] native histogram fetch failed', err);
      return null;
    }
  }

  /** Native-bit-depth (16/32-bit) multi-band TIFF export of slice `z` via the server
   *  `/export/tiff` endpoint — the displayed PNG is an 8-bit figure, this preserves the true pixel
   *  values. Visible channels only (omitted when all are visible → server default). Mirrors the
   *  OSD backend. */
  async exportTiff(z: number, states: IChannelState[], fileName: string | undefined): Promise<void> {
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) return;
    const visible = states.filter((c) => c.visible).map((c) => c.index);
    const url = exportTiffUrl(this.api, infoB64, z, visible, states.length);
    const saveName = exportTiffFilename(fileName);
    try {
      const resp = await fetchWithAuth(this.tiles, url);
      if (resp.status === 202) {
        console.warn('[napari-js] 16-bit export: file still caching — try again shortly.');
        return;
      }
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      saveAs(await resp.blob(), saveName);
    } catch (err) {
      console.warn('[napari-js] 16-bit TIFF export failed', err);
    }
  }
}
