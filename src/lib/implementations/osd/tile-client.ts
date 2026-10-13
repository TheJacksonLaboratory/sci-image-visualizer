import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

/**
 * Single source of truth for jit-service `/tile` access from the OSD backend
 * (refactoring plan, Step 2). Before this module the tile URL was string-built
 * in four places and the fetch→decode pipeline copy-pasted in three — every
 * query-param change had to be repeated per site. The URL itself now lives in
 * the shared `tile-server/` client.
 *
 * Error handling is deliberately left to the CALL SITES: these helpers
 * propagate failures so each caller keeps its own tagged catch
 * (`[viz:histogram]`, `[viz:window]`, `[viz:export]`) and its own
 * skip/fallback semantics.
 */

/** The `/tile` URL shape moved to the backend-neutral jit-service client
 *  (`implementations/tile-server/`), shared with napari-js; re-exported so the OSD
 *  modules keep importing it from here. */
export { buildTileUrl } from '../tile-server/tile-protocol';
export type { TileCoords } from '../tile-server/tile-protocol';

/** Fetch a tile PNG and decode it to an ImageBitmap. The caller owns the
 *  bitmap (call `close()` when done). Throws on network/decode failure. */
export async function fetchTileBitmap(http: HttpClient, url: string, timeoutMs: number): Promise<ImageBitmap> {
  const blob = await firstValueFrom(http.get(url, { responseType: 'blob' }).pipe(timeout(timeoutMs)));
  return createImageBitmap(blob);
}

/** Fetch a tile and read its pixels back as RGBA ImageData (via an offscreen
 *  canvas). Returns null only when a 2d context can't be created; throws on
 *  network/decode failure (the caller's tagged catch handles it). */
export async function fetchTileRgba(http: HttpClient, url: string, timeoutMs: number): Promise<ImageData | null> {
  const bmp = await fetchTileBitmap(http, url, timeoutMs);
  try {
    return readRgba(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close?.();
  }
}

/** Draw a decoded image (bitmap, `<img>`, canvas) onto a scratch canvas and
 *  read its pixels back as RGBA ImageData. Null when a 2d context can't be
 *  created. */
export function readRgba(src: CanvasImageSource, width: number, height: number): ImageData | null {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}
