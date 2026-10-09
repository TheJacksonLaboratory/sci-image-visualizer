import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { IImageInfo } from '../image.contract';
import type { VisualizerHandle } from '../visualizer.contract';

/**
 * Host image/loading/zoom state, inverted as a port so the visualization library
 * doesn't import the app's `MainState`/`MainFacade`. The host supplies an adapter
 * that delegates to those. Read methods return the host's live streams; write
 * methods push state back to the host (e.g. loading flags, the updated image).
 */
export interface ImageStatePort {
  // ── reads ────────────────────────────────────────────────────────────
  getFilename$(): Observable<string | undefined>;
  isImageCached$(): Observable<boolean>;
  getImageInfo$(): Observable<IImageInfo | null>;
  getImageLoadingMessage$(): Observable<string>;
  getCacheProgress$(): Observable<number | null>;
  getPanelWidth$(): Observable<number>;
  isImageLoading$(): Observable<boolean>;
  isZoom$(): Observable<boolean>;

  // ── writes ───────────────────────────────────────────────────────────
  /** Push an updated image descriptor to the host (partial — only set fields). */
  setImageInfo(info: Partial<IImageInfo>): void;
  setImageLoading(loading: boolean): void;
  setImageLoadingMessage(message: string): void;
  setZoom(zoom: boolean): void;
  setImageCached(cached: boolean): void;
  setLoadingError(error: boolean): void;
  /** Register the mounted visualizer with the host, or `null` once it is destroyed. */
  setDiagram(diagram: VisualizerHandle | null): void;
}

export const IMAGE_STATE_PORT = new InjectionToken<ImageStatePort>('IMAGE_STATE_PORT');
