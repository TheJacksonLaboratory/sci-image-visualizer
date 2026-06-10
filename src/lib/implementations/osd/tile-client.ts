import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

/**
 * Single source of truth for jit-service `/tile` access from the OSD backend
 * (refactoring plan, Step 2). Before this module the tile URL was string-built
 * in four places and the fetch→decode pipeline copy-pasted in three — every
 * query-param change had to be repeated per site.
 *
 * Error handling is deliberately left to the CALL SITES: these helpers
 * propagate failures so each caller keeps its own tagged catch
 * (`[viz:histogram]`, `[viz:window]`, `[viz:export]`) and its own
 * skip/fallback semantics.
 */

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

/** Build the `/tile` request URL — the one place its query shape lives. */
export function buildTileUrl(api: string, infoB64: string, c: TileCoords): string {
  const ch = c.channel == null ? '' : `&channel=${c.channel}`;
  return `${api}tile?info=${infoB64}&res=${c.res}&col=${c.col}&row=${c.row}&z=${c.z}&tileSize=${c.tileSize}${ch}`;
}

/** Fetch a tile PNG and decode it to an ImageBitmap. The caller owns the
 *  bitmap (call `close()` when done). Throws on network/decode failure. */
export async function fetchTileBitmap(http: HttpClient, url: string, timeoutMs: number): Promise<ImageBitmap> {
  const blob = await firstValueFrom(http.get(url, { responseType: 'blob' }).pipe(timeout(timeoutMs)));
  return createImageBitmap(blob);
}

/** Fetch a tile and read its pixels back as RGBA ImageData (via an offscreen
 *  canvas). Returns null only when a 2d context can't be created; throws on
 *  network/decode failure (the caller's tagged catch handles it). */
export async function fetchTileRgba(
  http: HttpClient, url: string, timeoutMs: number,
): Promise<ImageData | null> {
  const bmp = await fetchTileBitmap(http, url, timeoutMs);
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, cv.width, cv.height);
}
