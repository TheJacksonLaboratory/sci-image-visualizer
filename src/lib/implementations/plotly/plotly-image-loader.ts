import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';
import { Image } from 'image-js';
import { Buffer } from 'buffer';

import { IImageInfo } from '../../contracts/image.contract';
import { PlotUtilities } from '../../plot.utilities';
import { firstValueFromAbortable, throwIfAborted } from '../tile-server/transport';

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
    const image = await this.loadImage(zIndex ? urls[zIndex] : urls[0], signal);
    const ratios = [imageInfo.trueImageSize[0] / image.width, imageInfo.trueImageSize[1] / image.height];
    const sizes = [image.width, image.height];
    onProbe();
    if (!(imageInfo.isStack && imageInfo.showStack)) {
      return { data: [this.toMatrix(image, !!isGrayscale)], ratios, sizes, filename: imageInfo.fileName };
    }
    const wanted = () => stillWanted() && this.stackLoading$.value && !signal?.aborted;
    const images: any[] = new Array(urls.length);
    let next = 0;
    let loaded = 0;
    this.stackLoadingProgress$.next(0);
    // One URL per slice, fetched by a small pool of workers; each slice keeps its index.
    const worker = async () => {
      while (next < urls.length && wanted()) {
        const i = next++;
        images[i] = this.toMatrix(await this.loadImage(urls[i], signal), !!isGrayscale);
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
    this.stackLoadingProgress$.next(0);
    return { data: images, ratios, sizes, filename: imageInfo.fileName };
  }

  private toMatrix(img: any, isGrayscale: boolean): any[] {
    return isGrayscale
      ? this.utils.arrayToMatrix(Array.from(img.grey().data), img.width)
      : this.utils.arrayToMatrix(img.getPixelsArray(), img.width);
  }
}
