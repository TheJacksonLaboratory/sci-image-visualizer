import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, EMPTY, Observable, of } from 'rxjs';
import {
  ImageStatePort,
  TileAccessPort,
  RegionIoPort,
  IImageInfo,
  Rectangle,
} from '@jax-data-science/sci-image-visualizer';
import { decodeDicom } from './dicom';
import { decodeTiffStack, DecodedTiff } from './tiff';

/**
 * Serverless (Mode B) host ports for the browser example — modeled on jit-ui's
 * pipeline-preview adapters. No backend: every image becomes a self-contained
 * blob (`IImageInfo.tiled === false`) that OpenSeadragon opens directly, so the
 * tile-server path (`/tiles/info`, `/tile`, `/zoom/region`) is never hit.
 *
 * Three serverless shapes, all decoded in the browser:
 *  - single image — PNG/JPEG direct, TIFF via image-js, DICOM via dicom-parser;
 *  - a DICOM folder loaded as a z-STACK — one decoded PNG blob per slice emitted
 *    as `urls[]` with `isStack`, so the viewer's slice slider scrubs between them
 *    (the serverless mirror of jit-ui's `loadSeriesAsStack`).
 */
@Injectable()
export class ExampleImageStateAdapter implements ImageStatePort, OnDestroy {
  private readonly imageInfo$ = new BehaviorSubject<IImageInfo | null>(null);
  private readonly loading$ = new BehaviorSubject<boolean>(false);
  private readonly filename$ = new BehaviorSubject<string | undefined>(undefined);
  /** Object URLs WE created (decoded TIFF/DICOM blobs, or a picked File) — revoke
   *  these on the next load. Bundled asset URLs aren't ours, so they never go here. */
  private ownedUrls: string[] = [];

  /** Load a user-picked File (the "Load your own…" input). */
  async setImageFromFile(file: File | null): Promise<void> {
    if (!file) { this.clear(); return; }
    if (isTiff(file.name)) {
      await this.loadTiff(await file.arrayBuffer(), file.name);
    } else if (isDicom(file.name)) {
      await this.loadDicom(await file.arrayBuffer(), file.name);
    } else {
      const url = URL.createObjectURL(file);
      await this.loadDirect(url, file.name, [url]);
    }
  }

  /** Load a bundled sample by URL. PNG/JPEG open directly; TIFF is decoded
   *  client-side with image-js (browsers can't render TIFF) and handed to OSD as
   *  a PNG blob. */
  async setImageFromUrl(url: string, fileName: string): Promise<void> {
    if (isTiff(fileName)) {
      await this.loadTiff(await fetch(url).then((r) => r.arrayBuffer()), fileName);
    } else {
      await this.loadDirect(url, fileName, []);
    }
  }

  /** Load a single DICOM slice by URL (decoded to a grayscale PNG blob). */
  async setImageFromDicomUrl(url: string, fileName: string): Promise<void> {
    await this.loadDicom(await fetch(url).then((r) => r.arrayBuffer()), fileName);
  }

  /** Load a folder of DICOM slices as a z-stack: decode each to a PNG blob and
   *  emit them as `urls[]` with `isStack`, so the viewer's slice slider scrubs
   *  between them. Opens on `initialIndex` (the slice the user right-clicked). */
  async setStackFromDicomUrls(urls: string[], stackName: string, initialIndex: number): Promise<void> {
    this.loading$.next(true);
    try {
      const decoded: DecodedSlice[] = [];
      for (const url of urls) {
        decoded.push(await decodeDicom(await fetch(url).then((r) => r.arrayBuffer())));
      }
      if (!decoded.length) { this.clear(); return; }
      const blobs = decoded.map((d) => d.blobUrl);
      this.emit(blobs, stackName, decoded[0].width, decoded[0].height, /*grayscale*/ true, blobs, {
        isStack: true,
        initialZIndex: Math.min(Math.max(0, initialIndex), blobs.length - 1),
      });
    } catch (e) {
      console.error('[example] DICOM stack decode failed', e);
      this.clear();
    } finally {
      this.loading$.next(false);
    }
  }

  private async loadDirect(url: string, fileName: string, owned: string[]): Promise<void> {
    this.loading$.next(true);
    try {
      const { width, height } = await readImageSize(url);
      this.emit([url], fileName, width, height, /*isGrayscale*/ false, owned);
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
      // Decode: an ImageJ hyperstack (channels > 1) loads as a client-composited
      // MULTICHANNEL stack; a plain multi-page TIFF as a scrubbable z-stack; a
      // flat TIFF as a single image.
      const dec = await decodeTiffStack(buf);
      if (dec.channelCount > 1 && dec.channelUrls) {
        this.emitMultichannel(dec, fileName);
      } else {
        this.emit(
          dec.slices, fileName, dec.width, dec.height, dec.isGrayscale, dec.slices,
          dec.slices.length > 1 ? { isStack: true, initialZIndex: 0 } : {},
        );
      }
    } catch (e) {
      // Fall back to image-js's first frame for any TIFF the lightweight decoder
      // can't handle (exotic compression / tiling) — better than failing outright.
      console.warn('[example] multi-page TIFF decode failed; using image-js first frame', e);
      try {
        const { Image: IJImage } = await import('image-js');
        const decoded = await IJImage.load(buf);
        const blobUrl = URL.createObjectURL(await decoded.toBlob('image/png'));
        this.emit([blobUrl], fileName, decoded.width, decoded.height, decoded.channels === 1, [blobUrl]);
      } catch (e2) {
        console.error('[example] TIFF decode failed', e2);
        this.clear();
      }
    } finally {
      this.loading$.next(false);
    }
  }

  private async loadDicom(buf: ArrayBuffer, fileName: string): Promise<void> {
    this.loading$.next(true);
    try {
      const { width, height, blobUrl } = await decodeDicom(buf);
      this.emit([blobUrl], fileName, width, height, /*isGrayscale*/ true, [blobUrl]);
    } catch (e) {
      console.error('[example] DICOM decode failed', e);
      this.clear();
    } finally {
      this.loading$.next(false);
    }
  }

  /** Push an IImageInfo to the viewer. `owned` are the blob URLs to revoke on the
   *  next load (empty for bundled asset URLs). A stack passes every slice blob as
   *  `urls`/`owned` and `opts.isStack`; `imageMeta.z` carries the slice count. */
  private emit(
    urls: string[],
    fileName: string,
    width: number,
    height: number,
    isGrayscale: boolean,
    owned: string[],
    opts: { isStack?: boolean; initialZIndex?: number } = {},
  ): void {
    this.revoke();
    this.ownedUrls = owned;
    const isStack = !!opts.isStack;
    const rgbChannels = isGrayscale ? 1 : 3;
    this.imageInfo$.next({
      isGrayscale,
      trueImageSize: [width, height],
      urls,
      isStack,
      showStack: false,
      scaleRatio: true,
      fileName,
      // One metadata entry; `z` carries the slice count for a stack (matching
      // jit-ui's loadSeriesAsStack), or 1 for a single image.
      imageMeta: [
        { channelCount: rgbChannels, rgbChannels, x: width, y: height, z: isStack ? urls.length : 1, mppX: null, mppY: null },
      ],
      initialZIndex: isStack ? opts.initialZIndex ?? 0 : undefined,
      tiled: false, // ← the switch that keeps everything serverless
    });
    this.filename$.next(fileName);
  }

  /** Emit a SERVERLESS multichannel hyperstack: per-channel plane URLs
   *  (`channelUrls[z][c]`) so the viewer composites the channels client-side
   *  (per-channel colour/window/gamma) with per-channel histograms.
   *  `rgbChannels:1` + `channelCount > 1` makes the library derive one tinted
   *  channel per band; `z` is the slice count for the scrubber. */
  private emitMultichannel(dec: DecodedTiff, fileName: string): void {
    this.revoke();
    this.ownedUrls = dec.channelUrls!.flat(); // every plane blob is ours to revoke
    const z = dec.slices.length;
    this.imageInfo$.next({
      isGrayscale: false,
      trueImageSize: [dec.width, dec.height],
      urls: dec.slices,
      channelUrls: dec.channelUrls,
      isStack: z > 1,
      showStack: false,
      scaleRatio: true,
      fileName,
      imageMeta: [
        { channelCount: dec.channelCount, rgbChannels: 1, x: dec.width, y: dec.height, z, mppX: null, mppY: null },
      ],
      initialZIndex: z > 1 ? 0 : undefined,
      tiled: false,
    });
    this.filename$.next(fileName);
  }

  private clear(): void { this.revoke(); this.imageInfo$.next(null); this.filename$.next(undefined); }
  private revoke(): void { for (const u of this.ownedUrls) URL.revokeObjectURL(u); this.ownedUrls = []; }
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

interface DecodedSlice { width: number; height: number; blobUrl: string; }

const isTiff = (name: string): boolean => /\.tiff?$/i.test(name);
const isDicom = (name: string): boolean => /\.dcm$/i.test(name);

/** Decode just enough of an image URL to read its natural pixel dimensions. */
function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = url;
  });
}
