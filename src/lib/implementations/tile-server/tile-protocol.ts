/**
 * The jit-service tile protocol, shared by the OpenSeadragon and napari-js backends: the
 * `/tiles/info` descriptor, and the URLs of `/tiles/info`, `/tile`, `/histogram` and
 * `/export/tiff`. Each URL shape lives here once — the backends used to string-build them
 * separately and had already drifted (napari's `/histogram` lacked the cache-buster).
 */

/** One pyramid level from `GET /tiles/info` (res 0 = full resolution). */
export interface TileLevel {
  res: number;
  width: number;
  height: number;
}

/** Tile-source descriptor returned by `GET /tiles/info`. */
export interface TileDescriptor {
  width: number;
  height: number;
  tileSize: number;
  z: number;
  channels: number;
  /** True only for genuine multi-channel composites (indexed/LUT-bearing
   *  fluorescence stacks) the client should split into per-channel layers. The
   *  server sets it; an RGB photo read as separated planes has channels>1 but
   *  multichannel=false, so it stays a single composite tile source. */
  multichannel?: boolean;
  /** Real Bio-Formats resolution levels at the front of `levels`; the remaining
   *  levels are synthetic composited overviews (no per-channel tiles). */
  realLevels?: number;
  /** Per-channel metadata (name/color/bitDepth/min-maxAllowed) for native 16-bit
   *  windowing + histogram; null for plain 8-bit/RGB sources. */
  channelInfo?: Array<{
    name?: string;
    color?: string;
    bitDepth?: number;
    minAllowed?: number;
    maxAllowed?: number;
  }> | null;
  levels: TileLevel[];
  /** Physical pixel size in µm (0 when the format doesn't report it). */
  mppX?: number;
  mppY?: number;
}

/** Tile coordinates for one `/tile` request. `channel == null` (or omitted)
 *  requests the server-composited tile; an index (including 0) requests that
 *  single channel as grayscale. */
export interface TileCoords {
  res: number;
  col: number;
  row: number;
  z: number;
  tileSize: number;
  channel?: number | null;
}

/** The `/tiles/info` descriptor URL for one source. */
export function tilesInfoUrl(api: string, infoB64: string): string {
  return `${api}tiles/info?info=${infoB64}`;
}

/** Build the `/tile` request URL — the one place its query shape lives (the
 *  server caches on the exact parameter order). */
export function buildTileUrl(api: string, infoB64: string, c: TileCoords): string {
  const ch = c.channel == null ? '' : `&channel=${c.channel}`;
  return `${api}tile?info=${infoB64}&res=${c.res}&col=${c.col}&row=${c.row}&z=${c.z}&tileSize=${c.tileSize}${ch}`;
}

/**
 * Per-app-load cache-buster for `/histogram`. The server marks the response
 * cacheable for 24 h, and a hard refresh can't bust a post-load XHR. A token
 * stable within a session (so the backends' in-session caches still dedupe) but
 * new on each full load always reflects the live backend after a reload.
 */
export const HISTOGRAM_CACHE_BUSTER = Date.now();

/** Where one channel's native-bit-depth histogram is read. */
export interface NativeHistogramRequest {
  z: number;
  channel: number;
  bins: number;
}

/** The `/histogram` URL, with the cache-buster (see {@link HISTOGRAM_CACHE_BUSTER}). */
export function nativeHistogramUrl(
  api: string,
  infoB64: string,
  r: NativeHistogramRequest,
  cacheBuster: number = HISTOGRAM_CACHE_BUSTER,
): string {
  return `${api}histogram?info=${infoB64}&channel=${r.channel}&z=${r.z}&bins=${r.bins}&_=${cacheBuster}`;
}

/**
 * The `/export/tiff` URL for slice `z`. `visible` are the channel indices to
 * export; the `channels` param is omitted when every one of the `channelCount`
 * channels is visible (or none is), which is the server default (all).
 */
export function exportTiffUrl(
  api: string,
  infoB64: string,
  z: number,
  visible: readonly number[],
  channelCount: number,
): string {
  const ch = visible.length && visible.length < channelCount ? `&channels=${visible.join(',')}` : '';
  return `${api}export/tiff?info=${infoB64}&z=${z}${ch}`;
}

/** The saved name of a native-bit-depth TIFF export of `fileName`. */
export function exportTiffFilename(fileName: string | null | undefined): string {
  const stem = (fileName || 'image').replace(/\.[^.]+$/, '');
  return `${stem}_16bit.ome.tif`;
}
