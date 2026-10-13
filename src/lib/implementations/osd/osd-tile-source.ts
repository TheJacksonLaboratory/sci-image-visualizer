import { OSD } from './osd-lib';
import { buildTileUrl } from './tile-client';
import { TileDescriptor } from '../tile-server';

/**
 * Per-channel fit-view tile budget (tiles at the coarsest real level × channels).
 * Above it, a multichannel image renders server-composited instead of per-channel
 * — its full-res reads (it has no overview pyramid) would be too many × N channels.
 * 64 (e.g. a 4x4 single-FOV z-stack × 4ch) stays per-channel; a whole-slide
 * (hundreds–thousands) falls back.
 */
export const MAX_MULTICHANNEL_FIT_TILES = 256;

/** How a tiled image is drawn, decided once per mount by {@link planTiledMount}. */
export interface TiledMountPlan {
  /** Real Bio-Formats resolution levels (per-channel tiles exist only here). */
  realLevels: number;
  /** Composite client-side from one TiledImage per channel. */
  multiChannel: boolean;
  /** Tiles covering the whole image at the coarsest real level. */
  coarseTiles: number;
}

/**
 * Decide how to draw a tiled image. Multichannel fluorescence (indexed/LUT-bearing
 * stacks) composite client-side from per-channel tiles. Trust the server's explicit
 * `multichannel` flag — the old `channels>1 && grayscale` heuristic also matched RGB
 * photos Bio-Formats reads as separated planes (channels>1, rgbChannels==1),
 * splitting them into N per-channel TiledImages that flooded the tile endpoint and
 * hung on load.
 */
export function planTiledMount(d: TileDescriptor, maxFitTiles = MAX_MULTICHANNEL_FIT_TILES): TiledMountPlan {
  const realLevels = d.realLevels ?? d.levels.length;
  // Tiles to cover the whole image at the coarsest REAL Bio-Formats level (the
  // smallest level that has real, per-channel-fetchable tiles — synthetic overview
  // levels are server-composited only). A pyramidal image's coarsest real level is
  // tiny (few tiles); a flat/no-pyramid image's is the full-res grid (many tiles).
  const coarse = d.levels[realLevels - 1] ?? d.levels[d.levels.length - 1];
  const coarseW = coarse ? Math.ceil(coarse.width / d.tileSize) : 1;
  const coarseH = coarse ? Math.ceil(coarse.height / d.tileSize) : 1;
  const coarseTiles = coarseW * coarseH;
  let multiChannel = !!d.multichannel;
  if (multiChannel) {
    // Per-channel rendering can only use the REAL levels, so OSD requests the
    // coarsest real level's whole tile grid × N channels at fit. When that's large
    // (a whole-slide), it's too many (often slow, pyramid-less) full-res reads —
    // fall back to the single server-composited source (which keeps the fast
    // synthetic overviews). A small single-FOV z-stack stays per-channel. Size in
    // BYTES isn't the signal — tile count is.
    const fitTiles = coarseTiles * Math.max(1, d.channels ?? 1);
    if (fitTiles > maxFitTiles) {
      multiChannel = false;
      console.warn(
        '[OSD] multichannel composite too large for per-channel rendering: ' +
          `${coarseW}x${coarseH} tiles x ${d.channels} channels = ${fitTiles} at the coarsest ` +
          `real level (> ${maxFitTiles}); rendering server-composited for speed.`,
      );
    }
  }
  return { realLevels, multiChannel, coarseTiles };
}

/** Where the tiles of one slice (and optionally one channel) come from. */
export interface TileSourceSpec {
  api: string;
  infoB64: string;
  z: number;
  /** Fetch this channel's single-band tiles (per-channel multichannel rendering). */
  channel?: number;
  /** Drive OSD off the first N (real) levels only — see {@link buildOsdTileSource}. */
  realLevelsOnly?: number;
}

/**
 * Custom tile source built from the descriptor. OSD numbers levels
 * coarsest-first; the backend numbers resolutions full-res-first, so
 * `res = (levels-1) - osdLevel`. Overriding getLevelScale/getNumTiles lets us
 * honour Bio-Formats' actual per-level dimensions (not assume power-of-two).
 *
 * Multichannel images composite from per-channel tiles, which only exist at
 * real Bio-Formats resolutions — so `realLevelsOnly` drives OSD off the real
 * levels alone and skips the synthetic (server-composited) overviews. Every
 * displayed tile is then per-channel-fetchable at any zoom.
 */
export function buildOsdTileSource(d: TileDescriptor, spec: TileSourceSpec): Record<string, unknown> {
  const levels = spec.realLevelsOnly != null ? d.levels.slice(0, spec.realLevelsOnly) : d.levels;
  const n = levels.length;
  const t = d.tileSize;

  // OSD level i (0 = coarsest) <-> backend resolution (n-1-i) (res 0 = full).
  // The backend pyramid is NOT necessarily power-of-two, so we drive OSD off
  // the backend's real per-level dimensions. We override ONLY getLevelScale:
  // OSD derives getNumTiles, getTileBounds AND its per-zoom level selection
  // from getLevelScale, so they all stay consistent — requesting exactly the
  // tiles each resolution actually has (no out-of-range 400s, no flood).
  const resForLevel = (level: number) => n - 1 - level;
  const osd = OSD as unknown as {
    TileSource: new (o: object) => Record<string, unknown>;
    Point: new (x: number, y: number) => unknown;
  };
  const ts = new osd.TileSource({
    width: d.width,
    height: d.height,
    tileSize: t,
    tileOverlap: 0,
    minLevel: 0,
    maxLevel: n - 1,
  });
  ts['getLevelScale'] = (level: number) => {
    const lvl = levels[resForLevel(level)];
    return lvl ? lvl.width / d.width : 1;
  };
  // Drive the tile COUNT off each level's own (independently-rounded) dimensions,
  // not OSD's default `ceil(scale * fullDimension / tileSize)`. Synthetic AND real
  // Bio-Formats levels aren't exact proportional scales of the full image, so
  // `scale * fullHeight` can round up to one more row (or column) than the level
  // actually has — OSD then requests an out-of-range tile that the server 400s
  // ("Tile (col,row) out of range"). Using the level's real w/h matches the
  // server's own bounds check exactly.
  ts['getNumTiles'] = (level: number) => {
    const lvl = levels[resForLevel(level)];
    if (!lvl) return new osd.Point(0, 0);
    return new osd.Point(Math.ceil(lvl.width / t), Math.ceil(lvl.height / t));
  };
  ts['getTileUrl'] = (level: number, x: number, y: number) =>
    buildTileUrl(spec.api, spec.infoB64, {
      res: resForLevel(level),
      col: x,
      row: y,
      z: spec.z,
      tileSize: t,
      channel: spec.channel,
    });
  return ts;
}
