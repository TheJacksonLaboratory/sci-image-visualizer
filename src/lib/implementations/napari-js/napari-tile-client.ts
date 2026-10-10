import { Observable, from, of } from 'rxjs';
import { saveAs } from 'file-saver';
import type { PixelChunk, TileKey, TiledSource } from 'napari-js';

import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState, IHistogram } from '../../contracts/channel-histogram-api.contract';
import { TileAccessPort } from '../../contracts/ports/tile-access.port';
import { SimpleSliceAccessService } from '../simple-slice-access.service';
import {
  TileDescriptor,
  TileLevel,
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
  DESCRIPTOR_POLL_INTERVAL_MS, DESCRIPTOR_TIMEOUT_MS, LumaPlane, MAX_STITCH_TILES, MAX_TEXTURE_DIM,
  STITCH_BUDGET_COEFF, TILE_FETCH_CONCURRENCY, TILE_SIZE, VOLUME_FETCH_CONCURRENCY, VOLUME_MAX_SLICE,
  create2dCanvas, mapPool, rgbaToLuminance, stackDepth,
} from './napari-helpers';

/** An assembled uint8 (luminance) volume, x-fastest then y then z. */
export interface AssembledVolume {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
}

/** Decode an `ImageBitmap` to a single-channel uint8 luminance plane (server bands are grey,
 *  R=G=B, and decode exactly; a colour composite becomes its BT.601 luminance). `maxSide` caps
 *  the longest side (downscaling on the canvas draw) — used to keep pre-loaded surface slice
 *  planes small. Closes the bitmap. */
export function bitmapToLuminance(bmp: ImageBitmap, maxSide?: number): LumaPlane {
  const scale = maxSide ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height, 1)) : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const { ctx } = create2dCanvas(w, h, 'channel readback');
  // Scale the WHOLE bitmap into the (possibly smaller) target canvas — drawing at natural size
  // would crop to the top-left w×h corner when downscaling a large slice (maxSide < bmp size).
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  rgbaToLuminance(rgba, data);
  return { data, width: w, height: h };
}

/**
 * The napari-js backend's client of the jit-service tile server (review Appendix B, step 2), on
 * the shared `tile-server/` protocol: the `/tiles/info` descriptor (polled, cached per source,
 * shared between concurrent callers), whole-slice stitching from the pyramid, the pyramidal
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
    // fallback, which — via fetchSlice's own SimpleSliceAccessService branch —
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
   * Fetch a COMPLETE rendered slice as an `ImageBitmap` by stitching the server's REAL tile grid
   * (from `/tiles/info`) — not just the top-left tile, which only ever showed a large image's
   * corner. Picks the finest pyramid level whose grid fits `budgetTiles` and whose longest side is
   * within the GPU texture limit, fetches that grid concurrently, and stitches it into one canvas.
   *
   * `channel` selects a single band as grayscale (real levels only); omit for the server composite.
   * `budgetTiles` caps the grid: the 2D view uses the full budget for detail; volume assembly and
   * the surface pass {@link tileBudgetFor} their target resolution, and the histogram samples and
   * navigator 1 for a cheap overview tile. Falls back
   * to a single `col=0,row=0` tile when no descriptor is available (small/simple images, volumes).
   */
  async fetchSlice(
    info: IImageInfo | undefined,
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
    // Self-contained multi-slice stack (tiled:false): `z` indexes a completely
    // different file's own preview URL, not an internal slice of one server-
    // tiled file — resolved and fetched via SimpleSliceAccessService (shared
    // with OSD; see its docs for why this can't be a bare fetch()) instead of
    // building a /tile?info=...&z= request against whichever single file
    // getSelectedInfoB64() points at (which would 400/mismatch for any z
    // beyond that one file's own extent).
    if (this.simpleStack.isSimple(info)) {
      // Serverless multichannel volume: fetch the requested channel's OWN plane
      // (channelUrls[z][channel]) so each band stays distinct — the client-side
      // analog of the server's per-channel /tile?channel=c. Else the z-anchor URL.
      const chUrls = (info as IImageInfo).channelUrls;
      const url = channel != null && chUrls?.[z]?.[channel] != null
        ? chUrls[z][channel]
        : this.simpleStack.urlFor(info as IImageInfo, z);
      if (!url) throw new Error(`[napari-js] no URL for slice ${z}`);
      return this.simpleStack.fetchAsBitmap(url);
    }
    const infoB64 = this.tiles.getSelectedInfoB64();
    if (!infoB64) throw new Error('[napari-js] no selected image info (getSelectedInfoB64 null)');
    const desc = await this.ensureDescriptor(info);

    // The requested band; may be dropped to the composite (undefined) below when the channel has no
    // pyramid level small enough to stitch within budget.
    let effectiveChannel = channel;
    const fetchTile = async (
      res: number,
      col: number,
      row: number,
      t: number,
    ): Promise<ImageBitmap> => {
      const url = buildTileUrl(this.api, infoB64, {
        res, col, row, z, tileSize: t, channel: effectiveChannel,
      });
      const resp = await fetchWithAuth(this.tiles, url);
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
    await mapPool(coords, TILE_FETCH_CONCURRENCY, async ({ col, row }) => {
      tiles.push({ col, row, bmp: await fetchTile(chosen.res, col, row, t) });
    });

    const { canvas, ctx } = create2dCanvas(chosen.width, chosen.height, 'slice stitch');
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
      const { canvas: out, ctx: octx } = create2dCanvas(outW, outH, 'slice downscale');
      octx.drawImage(canvas as unknown as CanvasImageSource, 0, 0, outW, outH);
      return createImageBitmap(out as unknown as ImageBitmapSource);
    }
    return createImageBitmap(canvas as unknown as ImageBitmapSource);
  }

  /** Fetch a stitched slice and read it back as a single-channel uint8 plane. `channel` selects a
   *  band (multichannel); omit it for the grayscale composite (all overview levels available, so a
   *  large image picks a fitting downscaled level rather than only the full-res real level). */
  async fetchChannelData(
    info: IImageInfo | undefined,
    z: number,
    channel?: number,
    budgetTiles?: number,
  ): Promise<LumaPlane> {
    return bitmapToLuminance(await this.fetchSlice(info, z, channel, budgetTiles));
  }

  /** Tile budget to stitch a whole slice at ~`targetPx` resolution from the pyramid: a higher target
   *  pulls a FINER pyramid level (more real detail). Shared by the surface plane fetch and the volume
   *  assembly so both scale their in-plane resolution with the decimate factor. */
  tileBudgetFor(info: IImageInfo | undefined, targetPx: number): number {
    const tileSize = this.currentDescriptor(info)?.tileSize || TILE_SIZE;
    return Math.min(
      MAX_STITCH_TILES,
      Math.max(1, Math.round((targetPx / tileSize) ** 2 * STITCH_BUDGET_COEFF)),
    );
  }

  /**
   * Build a pyramidal TiledSource backed by the server `/tile` endpoint. `channel` selects a band
   * (grayscale luminance, real levels only); omit it for the composite (RGBA, all levels).
   *
   * `scene` is the signal of the render that asked for it, taken before that render's awaits;
   * `onTile` is told of each tile request and handed back the tile's end. A request issued once
   * `scene` is aborted (a disposed source still fetching after a reset) is not reported, and one
   * that settles after it does not end, so it can never count toward the next scene.
   */
  tiledSource(
    desc: TileDescriptor,
    channel: number | undefined,
    channels: 1 | 4,
    scene: AbortSignal,
    onTile: () => () => void,
  ): TiledSource {
    const infoB64 = this.tiles.getSelectedInfoB64() ?? '';
    // Per-channel tiles exist only at REAL Bio-Formats levels; the composite exists at all levels.
    const usable =
      channel == null
        ? desc.levels
        : desc.levels.slice(0, Math.max(1, desc.realLevels ?? desc.levels.length));
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
      fetchTile: async (key: TileKey): Promise<PixelChunk> => {
        const res = usable[key.level]?.res ?? key.level;
        const url = buildTileUrl(api, infoB64, {
          res, col: key.col, row: key.row, z: key.z, tileSize, channel,
        });
        const end = scene.aborted ? null : onTile();
        try {
          const resp = await fetchWithAuth(this.tiles, url);
          if (!resp.ok) {
            throw new Error(`[napari-js] tile ${key.level}/${key.col}/${key.row} → ${resp.status}`);
          }
          const bmp = await createImageBitmap(await resp.blob());
          if (channels === 4) return { width: bmp.width, height: bmp.height, data: bmp };
          return bitmapToLuminance(bmp);
        } finally {
          if (!scene.aborted) end?.();
        }
      },
    };
  }

  /**
   * Assemble a downsampled uint8 volume (luminance) from the per-slice tile endpoint. Slices are
   * fetched with bounded concurrency (keeps the connection pool full without flooding it on a deep
   * stack) and read into the volume as each arrives, reporting `progress` (0–100) so the host shows
   * a determinate progress bar instead of a bare spinner. Null when there is nothing to assemble or
   * `signal` aborts (a Cancel or a new plot) — a partial volume is never returned.
   */
  async assembleVolume(
    info: IImageInfo | undefined,
    opts: { maxSlice?: number; sliceStep?: number },
    channel: number | undefined,
    hooks: { signal: AbortSignal; progress(percent: number): void },
  ): Promise<AssembledVolume | null> {
    const { signal } = hooks;
    const fullDepth = stackDepth(info) || 1;
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

    hooks.progress(0);
    try {
      // Fetch each slice at a pyramid level matching `maxSlice` (budget scales with the decimate
      // factor), so a higher factor pulls a finer level → more real in-plane detail; then downsample
      // to `maxSlice`. `channel` selects a band (multichannel volume); omit for the grayscale
      // composite. The caller owns the stackLoading flag (multichannel assembles channels in turn).
      const budget = this.tileBudgetFor(info, maxSlice);
      const first = await this.fetchSlice(info, zIndices[0], channel, budget);
      const scale = Math.min(1, maxSlice / Math.max(first.width, first.height, 1));
      const width = Math.max(1, Math.round(first.width * scale));
      const height = Math.max(1, Math.round(first.height * scale));
      const data = new Uint8Array(width * height * depth);

      const { ctx } = create2dCanvas(width, height, 'volume assembly');

      // Read one fetched slice bitmap into the volume plane `z` (luminance). Synchronous between
      // awaits, so the shared 2D context is safe to reuse across the concurrent fetch workers.
      let done = 0;
      const readSlice = (z: number, bmp: ImageBitmap): void => {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(bmp, 0, 0, width, height);
        rgbaToLuminance(ctx.getImageData(0, 0, width, height).data, data, z * width * height);
        bmp.close?.();
        done++;
        hooks.progress(Math.round((done / depth) * 100));
      };

      readSlice(0, first);

      // Remaining planes through a small fetch pool. Each plane `p` maps to source slice
      // `zIndices[p]` (subsampled for low-res).
      const planes = Array.from({ length: depth - 1 }, (_, i) => i + 1);
      await mapPool(
        planes,
        VOLUME_FETCH_CONCURRENCY,
        async (p) => readSlice(p, await this.fetchSlice(info, zIndices[p], channel, budget)),
        () => signal.aborted,
      );

      if (signal.aborted) return null; // cancelled → don't render a partial volume
      return { data, width, height, depth };
    } finally {
      hooks.progress(0);
    }
  }

  /**
   * Slice `z` as a single WHOLE-image luminance plane (decimated to `maxGrid`), for the surface.
   * Prefers the server pyramid, stitched at a resolution set by the decimate factor; without a
   * descriptor, the app's complete per-slice image (`urls`/`smallUrls`, as the Plotly surface) —
   * never a lone top-left tile, which would be a corner of the slice — and only as a last resort
   * the single-tile fetch.
   */
  async fetchPlane(
    info: IImageInfo | undefined,
    z: number,
    channel: number | undefined,
    maxGrid: number,
  ): Promise<LumaPlane> {
    const desc = await this.ensureDescriptor(info);
    let plane: LumaPlane | null = null;

    // Preferred: stitch the WHOLE slice from the server pyramid at a resolution driven by the
    // decimate factor — a higher target grid pulls a FINER pyramid level (more real detail). With a
    // descriptor, fetchSlice stitches the whole chosen level (never a corner), then we downscale to
    // the grid. This is what makes "Full" actually higher-res than "½", not just a fixed preview.
    if (desc?.levels?.length) {
      const budget = this.tileBudgetFor(info, maxGrid);
      // The surface is a single decimated plane, so the composite fallback is acceptable when the
      // channel has no small pyramid level (keeps it fast); a multichannel VOLUME must not do this.
      plane = bitmapToLuminance(await this.fetchSlice(info, z, channel, budget, true), maxGrid);
    }

    // Fallback (no pyramid): the app's COMPLETE per-slice image (urls[z], not the small blurry
    // thumbnail) — whole slice, avoids a corner tile. Capped at the image's own resolution.
    if (!plane) {
      const url = info?.urls?.[z] ?? info?.smallUrls?.[z];
      if (url) {
        try {
          const resp = await fetchWithAuth(this.tiles, url);
          if (resp.ok) {
            plane = bitmapToLuminance(await createImageBitmap(await resp.blob()), maxGrid);
          }
        } catch (err) {
          console.warn(`[napari-js] surface url fetch failed for z=${z}`, err);
        }
      }
    }

    // Last resort (no pyramid and no complete image): a single tile.
    if (!plane) {
      plane = bitmapToLuminance(
        await this.fetchSlice(info, z, channel, this.tileBudgetFor(info, maxGrid), true),
        maxGrid,
      );
    }
    return plane;
  }

  /**
   * Channel `channel`'s native-bit-depth histogram at slice `z` when `info` is a >8-bit image —
   * the displayed pixels are 8-bit, so a client histogram would be clipped — cached per
   * `(z, channel)`; null for an 8-bit channel, which the caller bins from the client data.
   */
  nativeHistogram$(
    info: IImageInfo | undefined, z: number, channel: number, bins: number,
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
  async fetchNativeHistogram(
    channel: number,
    bins: number,
    z: number,
    key: string,
  ): Promise<IHistogram | null> {
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
