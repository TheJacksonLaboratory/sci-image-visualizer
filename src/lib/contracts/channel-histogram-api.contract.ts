import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { IImageMetadata } from './image.contract';

/**
 * Display state for one image channel in the Channels & Histogram pane.
 * `min`/`max` are the display window (contrast/brightness) in raw 0..255 space;
 * `gamma` shapes the transfer curve; `color` is the channel's display tint
 * (used when compositing multiple channels); `visible` toggles it on/off.
 */
export interface IChannelState {
  index: number;
  name: string;
  /** Display tint as `#rrggbb`. */
  color: string;
  min: number;
  max: number;
  gamma: number;
  visible: boolean;
}

/** A binned intensity histogram for one channel. */
export interface IHistogram {
  /** Left edge of each bin (0..255 space), length = bin count. */
  bins: number[];
  /** Pixel count per bin, length = bin count. */
  counts: number[];
  /** Largest bin count, for y-axis scaling. */
  max: number;
}

/**
 * Public, implementation-agnostic surface the Channels & Histogram pane (an
 * external consumer of the visualization package) depends on. It exposes the
 * per-channel display window/gamma/visibility, an intensity histogram computed
 * from the currently-displayed pixels, and the LUT/colormap controls that used
 * to live in the toolbar. The pane injects this via {@link CHANNEL_HISTOGRAM_API}
 * (bound to the concrete `RoutingVisualizerService` with `useExisting`) so it
 * never reaches the implementation. Every setter live-updates whichever backend
 * (Plotly or OpenSeadragon) is on screen.
 */
export interface IChannelHistogramApi {
  // ── channels ──────────────────────────────────────────────────────────
  /** The channels of the current image (1 for grayscale, 3 for RGB). */
  getChannels$(): Observable<IChannelState[]>;
  /** Patch one channel's state (window/gamma/visibility/color); live-updates. */
  setChannelState(index: number, partial: Partial<IChannelState>): void;
  /** Auto-window the given channels by saturating `saturation` (0..1) of pixels
   *  at each end of their histogram. */
  autoContrast(indices: number[], saturation: number): void;
  /** Reset the given channels to the full display range (0..255). */
  resetContrast(indices: number[]): void;

  // ── histogram ─────────────────────────────────────────────────────────
  /** Binned histogram for a channel from the displayed pixels, or null when no
   *  image/pixels are available. */
  getHistogram(channelIndex: number, bins: number): IHistogram | null;

  // ── display options (moved out of the toolbar) ────────────────────────
  getColormap(): Observable<any>;
  setColormap(colormap: any): void;
  getColormapOptions(): any;
  getReverseScale(): Observable<boolean>;
  setReverseScale(reverse: boolean): void;
  getGrayscale$(): Observable<boolean>;
  setGrayscale(on: boolean): void;
  getInvert$(): Observable<boolean>;
  setInvert(on: boolean): void;

  // ── image ─────────────────────────────────────────────────────────────
  getImageMeta(): Observable<IImageMetadata[]>;
}

export const CHANNEL_HISTOGRAM_API = new InjectionToken<IChannelHistogramApi>('CHANNEL_HISTOGRAM_API');
