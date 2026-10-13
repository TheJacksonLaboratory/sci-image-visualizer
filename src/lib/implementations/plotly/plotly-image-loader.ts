import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';
import { Image } from 'image-js';
import { Buffer } from 'buffer';

import { IImageInfo } from '../../contracts/image.contract';
import { PlotUtilities } from '../../plot.utilities';
import { firstValueFromAbortable, throwIfAborted } from '../tile-server/transport';
import { channelPlaneUrls } from './plotly-image-recolor';

/** Parallel slice fetches when loading a stack (cf. napari's volume fetch pool). */
const PLOTLY_STACK_FETCH_CONCURRENCY = 4;

/** What Plotly's `load()` hands to `plot()`: per-slice pixel matrices. */
export interface PlotlyLoaded {
  /** One row-major matrix per slice: grayscale numbers or `[r, g, b]` cells. */
  data: any[];
  /** [xRatio, yRatio]: image units per decoded pixel. */
  ratios: number[];
  /** [width, height] of a decoded slice. */
  sizes: number[];
  filename: string | undefined;
  /** A serverless multichannel stack's raw channel planes (one byte per pixel), per loaded
   *  slice (aligned with `data`) and channel — what its `image` trace is composited from. */
  channelPlanes?: Uint8Array[][];
}

/**
 * Plotly's image source: fetches slices through HttpClient (so the auth
 * interceptors apply — a raw fetch() fails behind an OAuth2 proxy), decodes
 * them with image-js into pixel matrices, and loads a stack through a small
 * worker pool, reporting progress. Owns the stack-loading flag and progress.
 */
export class PlotlyImageLoader {
  /** Whether the whole stack is (to be) loaded; switching it off stops a stack load. */
  readonly stackLoading$ = new BehaviorSubject<boolean>(false);
  /** Stack load progress, 0–100 (0 when idle). */
  readonly stackLoadingProgress$ = new BehaviorSubject<number>(0);
  private readonly utils = new PlotUtilities();

  constructor(private readonly http: HttpClient) {}

  /** Fetch one image via HttpClient and decode it. */
  async loadImage(url: string, signal?: AbortSignal): Promise<Image> {
    const buffer = await firstValueFromAbortable(this.http.get(url, { responseType: 'arraybuffer' }), signal);
    return Image.load(Buffer.from(buffer));
  }

  /**
   * Load slice `zIndex` — or, for a shown stack, every slice (in parallel,
   * keeping slice order). `onProbe` runs once the displayed slice has decoded;
   * the stack load stops early when `stillWanted()` turns false (another file),
   * stack loading is switched off, or `signal` aborts (it then rejects with an
   * `AbortError`). A stopped load keeps the contiguous run of slices from the start.
   */
  async load(
    imageInfo: IImageInfo,
    zIndex: number,
    signal: AbortSignal | undefined,
    onProbe: () => void,
    stillWanted: () => boolean,
  ): Promise<PlotlyLoaded> {
    const urls = imageInfo.urls;
    const isGrayscale = imageInfo.isGrayscale;
    const chUrls = channelPlaneUrls(imageInfo);
    const planesOf = (z: number) => this.loadChannelPlanes(chUrls?.[z] ?? chUrls?.[0] ?? [], signal);
    const image = await this.loadImage(zIndex ? urls[zIndex] : urls[0], signal);
    const ratios = [imageInfo.trueImageSize[0] / image.width, imageInfo.trueImageSize[1] / image.height];
    const sizes = [image.width, image.height];
    onProbe();
    if (!(imageInfo.isStack && imageInfo.showStack)) {
      return {
        data: [this.toMatrix(image, !!isGrayscale)],
        ratios,
        sizes,
        filename: imageInfo.fileName,
        ...(chUrls ? { channelPlanes: [await planesOf(zIndex || 0)] } : {}),
      };
    }
    const wanted = () => stillWanted() && this.stackLoading$.value && !signal?.aborted;
    const images: any[] = new Array(urls.length);
    const planes: Uint8Array[][] = new Array(urls.length);
    let next = 0;
    let loaded = 0;
    this.stackLoadingProgress$.next(0);
    // One URL per slice, fetched by a small pool of workers; each slice keeps its index.
    const worker = async () => {
      while (next < urls.length && wanted()) {
        const i = next++;
        images[i] = this.toMatrix(await this.loadImage(urls[i], signal), !!isGrayscale);
        if (chUrls) planes[i] = await planesOf(i);
        this.stackLoadingProgress$.next(Math.round((++loaded * 100) / urls.length));
      }
    };
    const poolSize = Math.min(PLOTLY_STACK_FETCH_CONCURRENCY, urls.length);
    try {
      await Promise.all(Array.from({ length: poolSize }, () => worker()));
    } catch (err) {
      this.stackLoadingProgress$.next(0);
      throw err;
    }
    throwIfAborted(signal);
    const firstGap = images.findIndex((m) => m === undefined);
    if (firstGap >= 0) images.length = firstGap;
    planes.length = images.length;
    this.stackLoadingProgress$.next(0);
    return {
      data: images,
      ratios,
      sizes,
      filename: imageInfo.fileName,
      ...(chUrls ? { channelPlanes: planes } : {}),
    };
  }

  /** A slice's channel planes (`channelUrls[z]`), fetched in parallel and decoded to one byte per
   *  pixel (a 16-bit plane to its high byte, as a canvas decodes it for OSD). */
  private loadChannelPlanes(urls: string[], signal?: AbortSignal): Promise<Uint8Array[]> {
    return Promise.all(
      urls.map(async (url) => {
        const grey = (await this.loadImage(url, signal)).grey();
        const data = grey.data as ArrayLike<number>;
        return grey.bitDepth === 16 ? Uint8Array.from(data, (v) => v >> 8) : Uint8Array.from(data);
      }),
    );
  }

  /** Grayscale: the scalar matrix. Colour: `[r, g, b]` cells in 0..255, the only range an
   *  `image` trace draws — a 16-bit image keeps each sample's high byte, as the browser decodes
   *  it for OSD and napari-js (its full values saturated every cell). */
  private toMatrix(img: any, isGrayscale: boolean): any[] {
    if (isGrayscale) return this.utils.arrayToMatrix(Array.from(img.grey().data), img.width);
    const pixels: number[][] = img.getPixelsArray();
    const cells = img.bitDepth === 16 ? pixels.map((px) => px.map((v) => v >> 8)) : pixels;
    return this.utils.arrayToMatrix(cells, img.width);
  }
}
