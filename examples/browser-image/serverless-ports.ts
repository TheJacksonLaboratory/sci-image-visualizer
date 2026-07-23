import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, EMPTY, Observable, of } from 'rxjs';
import {
  ImageStatePort,
  TileAccessPort,
  RegionIoPort,
  IImageInfo,
  Rectangle,
} from '@jax-data-science/sci-image-visualizer';

/**
 * Serverless (Mode B) host ports for the browser example — modeled on jit-ui's
 * pipeline-preview adapters. No backend: the image becomes a self-contained
 * single image (`IImageInfo.tiled === false`) that OpenSeadragon opens directly,
 * so the tile-server path (`/tiles/info`, `/tile`, `/zoom/region`) is never hit.
 */
@Injectable()
export class ExampleImageStateAdapter implements ImageStatePort, OnDestroy {
  private readonly imageInfo$ = new BehaviorSubject<IImageInfo | null>(null);
  private readonly loading$ = new BehaviorSubject<boolean>(false);
  private readonly filename$ = new BehaviorSubject<string | undefined>(undefined);
  /** Object URLs WE created (from a File or a decoded TIFF) — revoke these. A
   *  bundled asset URL isn't ours to revoke, so it stays null for that path. */
  private ownedUrl: string | null = null;

  /** Load a user-picked File (the "Load your own…" input). */
  async setImageFromFile(file: File | null): Promise<void> {
    if (!file) { this.clear(); return; }
    if (isTiff(file.name)) {
      await this.loadTiff(await file.arrayBuffer(), file.name);
    } else {
      await this.loadDirect(URL.createObjectURL(file), file.name, /*owned*/ true);
    }
  }

  /** Load a bundled sample by URL. PNG/JPEG open directly; TIFF is decoded
   *  client-side with image-js (browsers can't render TIFF) and handed to OSD as
   *  a PNG blob. Multi-frame files (z-stacks) show frame 0 on this serverless
   *  path — full z/channel rendering is the tiled-server example (Phase 2). */
  async setImageFromUrl(url: string, fileName: string): Promise<void> {
    if (isTiff(fileName)) {
      await this.loadTiff(await fetch(url).then((r) => r.arrayBuffer()), fileName);
    } else {
      await this.loadDirect(url, fileName, /*owned*/ false);
    }
  }

  private async loadDirect(url: string, fileName: string, owned: boolean): Promise<void> {
    this.loading$.next(true);
    try {
      const { width, height } = await readImageSize(url);
      this.emit(url, fileName, width, height, /*isGrayscale*/ false, owned);
    } catch (e) {
      console.error('[example] image load failed', e);
      this.clear();
    } finally {
      this.loading$.next(false);
    }
  }

  private async loadTiff(buf: ArrayBuffer, fileName: string): Promise<void> {
    this.loading$.next(true);
    try {
      // Lazy-loaded so image-js (+ its ml-matrix dep) stays off the app's init
      // path — the gallery + PNGs render without it; it loads on first TIFF click.
      const { Image: IJImage } = await import('image-js');
      const decoded = await IJImage.load(buf);
      const blobUrl = URL.createObjectURL(await decoded.toBlob('image/png'));
      this.emit(blobUrl, fileName, decoded.width, decoded.height, decoded.channels === 1, /*owned*/ true);
    } catch (e) {
      console.error('[example] TIFF decode failed', e);
      this.clear();
    } finally {
      this.loading$.next(false);
    }
  }

  private emit(url: string, fileName: string, width: number, height: number, isGrayscale: boolean, owned: boolean): void {
    this.revoke();
    this.ownedUrl = owned ? url : null;
    const rgbChannels = isGrayscale ? 1 : 3;
    this.imageInfo$.next({
      isGrayscale,
      trueImageSize: [width, height],
      urls: [url],
      isStack: false,
      showStack: false,
      scaleRatio: true,
      fileName,
      imageMeta: [{ channelCount: rgbChannels, rgbChannels, x: width, y: height, z: 1, mppX: null, mppY: null }],
      tiled: false, // ← the switch that keeps everything serverless
    });
    this.filename$.next(fileName);
  }

  private clear(): void { this.revoke(); this.imageInfo$.next(null); this.filename$.next(undefined); }
  private revoke(): void { if (this.ownedUrl) { URL.revokeObjectURL(this.ownedUrl); this.ownedUrl = null; } }
  ngOnDestroy(): void { this.revoke(); }

  // ── ImageStatePort: reads ────────────────────────────────────────────────
  getImageInfo$(): Observable<IImageInfo | null> { return this.imageInfo$.asObservable(); }
  isImageLoading$(): Observable<boolean> { return this.loading$.asObservable(); }
  getFilename$(): Observable<string | undefined> { return this.filename$.asObservable(); }
  isImageCached$(): Observable<boolean> { return of(true); }
  getImageLoadingMessage$(): Observable<string> { return of(''); }
  getCacheProgress$(): Observable<number | null> { return of(null); }
  getPanelWidth$(): Observable<number> { return of(0); }
  isZoom$(): Observable<boolean> { return of(false); }

  // ── ImageStatePort: writes (no-ops for this self-contained viewer) ───────
  setImageInfo(info: Partial<IImageInfo>): void { this.imageInfo$.next(info as IImageInfo); }
  setImageLoading(loading: boolean): void { this.loading$.next(loading); }
  setImageLoadingMessage(_m: string): void {}
  setZoom(_z: boolean): void {}
  setImageCached(_c: boolean): void {}
  setLoadingError(_e: boolean): void {}
  setDiagram(_d: unknown): void {}
}

/** Tile-access stub: never exercised because images carry `tiled: false`. */
@Injectable()
export class StubTileAccessAdapter implements TileAccessPort {
  getSelectedInfoB64(): string | null { return null; }
  zoomOnRegion(_roi: Rectangle, _screen: Rectangle, _z: number): Observable<ArrayBuffer> { return EMPTY; }
  selectDiagramDisplay(): void {}
  getAuthHeaders(): Promise<Record<string, string>> { return Promise.resolve({}); }
}

/** Region-I/O stub: no GeoJSON persistence here (regions live in memory). */
@Injectable()
export class StubRegionIoAdapter implements RegionIoPort {
  getSelectedFileName(): string | undefined { return undefined; }
  roiFileExists(_name: string): Observable<boolean> { return of(false); }
  saveGeoJson(_g: string, _f: string): Observable<void> { return of(undefined); }
  saveSliceGeoJsons(_s: { z: number; geoJsonStr: string }[]): Observable<void> { return of(undefined); }
}

const isTiff = (name: string): boolean => /\.tiff?$/i.test(name);

/** Decode just enough of an image URL to read its natural pixel dimensions. */
function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = url;
  });
}
