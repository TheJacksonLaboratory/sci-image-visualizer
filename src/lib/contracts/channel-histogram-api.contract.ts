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

/** The standard LUT pseudo-colours (mirrors Fiji's Merge Channels palette) for
 *  quick per-channel assignment. */
export const LUT_COLORS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Red', color: '#ff0000' },
  { name: 'Green', color: '#00ff00' },
  { name: 'Blue', color: '#0000ff' },
  { name: 'Gray', color: '#ffffff' },
  { name: 'Cyan', color: '#00ffff' },
  { name: 'Magenta', color: '#ff00ff' },
  { name: 'Yellow', color: '#ffff00' },
];

/** A binned intensity histogram for one channel.
 *
 * The 8-bit client path (RGB / 8-bit grayscale, sampled from displayed tiles)
 * leaves the native fields undefined and `bins` span 0..255. The native path
 * (>8-bit images, from the server `/histogram` endpoint) fills `bitDepth`,
 * `rangeMin`/`rangeMax` (the pixel-type span the bins cover) and
 * `observedMin`/`observedMax` (the actual extremes seen), so the dialog can
 * label the window/axis in native units. */
export interface IHistogram {
  /** Left edge of each bin (0..255 for the 8-bit path, native units otherwise). */
  bins: number[];
  /** Pixel count per bin, length = bin count. */
  counts: number[];
  /** Largest bin count, for y-axis scaling. */
  max: number;
  /** Native bit depth (8, 16, …) — present only on the native server path. */
  bitDepth?: number;
  /** Pixel-type range the bins span (e.g. 0..65535), native path only. */
  rangeMin?: number;
  rangeMax?: number;
  /** Actual min/max pixel observed (auto-contrast seed), native path only. */
  observedMin?: number;
  observedMax?: number;
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
  /** Reset the given channels to their derived defaults: full display range
   *  (0..255), gamma 1, and the channel's default tint colour. */
  resetContrast(indices: number[]): void;

  // ── histogram ─────────────────────────────────────────────────────────
  /** Binned histogram for a channel from the displayed pixels, or null when no
   *  image/pixels are available. Synchronous 8-bit path (used by auto-contrast). */
  getHistogram(channelIndex: number, bins: number): IHistogram | null;
  /** Histogram for a channel as an async stream: emits the **native** bit-depth
   *  histogram (from the server) for >8-bit images, else the 8-bit client
   *  histogram. The dialog uses this so 16-bit stacks get a true distribution. */
  getHistogram$(channelIndex: number, bins: number): Observable<IHistogram | null>;

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

  /** Export the displayed image — composited with the current per-channel
   *  pseudo-colours / window / colormap — as a publication-ready PNG download. */
  exportComposite(): void;

  /** Export the underlying image data — all (or the visible) channels at native
   *  bit depth — as a data-preserving multi-band TIFF download. Server-side, so
   *  it keeps true 16-bit values (the PNG composite is an 8-bit figure). Only
   *  meaningful for >8-bit images; a no-op on backends that can't provide it. */
  exportData(): void;
}

export const CHANNEL_HISTOGRAM_API = new InjectionToken<IChannelHistogramApi>('CHANNEL_HISTOGRAM_API');
