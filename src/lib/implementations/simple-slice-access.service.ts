import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { IImageInfo } from '../contracts/image.contract';

/**
 * Shared access to a "simple" (`IImageInfo.tiled === false`) stack — a
 * self-contained per-slice-URL image, as opposed to one server-tiled file
 * with an internal z dimension (the tile-pyramid case each backend already
 * handles on its own, since the tiling protocol itself IS backend-specific).
 * A numbered image series assembled client-side from separate files (the
 * jit-ui folder-stack feature) is the current producer of this shape.
 *
 * Every backend that can render a 2D image (OSD, napari-js) needs the exact
 * same three things for this case — detect it, resolve `urls[z]`, and fetch
 * that URL with the app's auth applied — so they live here once instead of
 * being reimplemented per backend. Plotly needs no equivalent: its `load()`
 * already fetches `urls[i]` generically for every plot type, with no
 * tile-server concept to route around.
 *
 * Fetches go through Angular's `HttpClient` so the app's auth interceptor
 * (Bearer token) applies — a raw `fetch()`/`<img src>` bypasses it and, behind
 * an OAuth2-proxied deployment, gets redirected to the login page and then
 * CORS-fails. Mirrors `PlotlyService.loadImage`, the reference
 * implementation this generalizes for the other backends.
 */
@Injectable({ providedIn: 'root' })
export class SimpleSliceAccessService {
  /** raw slice URL → already-fetched blob: URL, so a backend that opens a
   *  URL (OSD) doesn't repeat the auth round-trip revisiting a slice (scrub
   *  back, the small→large tier re-fetch). Shared across backends: switching
   *  plot types on the same file (e.g. Image → Volume) reuses entries. */
  private readonly blobUrls = new Map<string, string>();
  private currentFileName: string | undefined;

  constructor(private http: HttpClient) {}

  /** True when `imageInfo` is a self-contained per-slice-URL stack with no
   *  server tile pyramid to route to. */
  isSimple(imageInfo: IImageInfo | null | undefined): boolean {
    return imageInfo?.tiled === false;
  }

  /** The URL for slice `z` of a simple stack (falls back to slice 0 if `z`
   *  is out of range or unset). */
  urlFor(imageInfo: IImageInfo, z: number): string | undefined {
    return imageInfo.urls?.[z] ?? imageInfo.urls?.[0];
  }

  /** Call once per backend `load()` so the blob cache is evicted when a
   *  genuinely different file is selected — not on every phase/z-scrub of
   *  the SAME file, and not wrongly evicted by a second backend loading the
   *  same file for a different plot type. */
  noteActiveFile(fileName: string | undefined): void {
    if (fileName && this.currentFileName && fileName !== this.currentFileName) {
      this.revokeAll();
    }
    this.currentFileName = fileName;
  }

  /** Fetch a slice's own URL and hand back a blob: URL — for backends (OSD)
   *  that open a URL rather than decode bytes directly. A true in-memory
   *  blob:/data: URL (the processing-pipeline's original tiled:false use
   *  case) is already self-contained and returned as-is, no fetch/cache. */
  async fetchAsBlobUrl(rawUrl: string): Promise<string> {
    if (rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) return rawUrl;
    const cached = this.blobUrls.get(rawUrl);
    if (cached) return cached;
    const blob = await firstValueFrom(this.http.get(rawUrl, { responseType: 'blob' }));
    const blobUrl = URL.createObjectURL(blob);
    this.blobUrls.set(rawUrl, blobUrl);
    return blobUrl;
  }

  /** Fetch a slice's own URL and decode it as an `ImageBitmap` — for
   *  backends (napari-js) that upload pixels directly rather than opening a
   *  URL. Not cached (ImageBitmaps are consumed once and closed by the
   *  caller); the underlying HTTP response may still hit the browser cache. */
  async fetchAsBitmap(rawUrl: string): Promise<ImageBitmap> {
    const blob = await firstValueFrom(this.http.get(rawUrl, { responseType: 'blob' }));
    return createImageBitmap(blob);
  }

  private revokeAll(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
  }
}
