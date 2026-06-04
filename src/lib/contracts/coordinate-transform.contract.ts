import { Region } from '../models/region';

/**
 * The viewport math the on-canvas tools (wand, vertex eraser) need, abstracted
 * away from any specific backend. Plotly implements it over its axis objects
 * (`_fullLayout.xaxis/yaxis`), OpenSeadragon over its viewport API. This is what
 * lets the tools run on either backend.
 *
 * "Data coordinates" are the backend's shape coordinate space: Plotly data
 * coords for Plotly, image-pixel coords for OpenSeadragon. The tools convert
 * data -> image-matrix using the per-image ratio they already get from the host
 * (`getCachedImageData().ratios` / `getCachedImageRatio()`), so that division
 * stays in the tool and the transform stays purely screen<->data.
 */
export interface ICoordinateTransform {
  /** Client (mouse event) pixel -> data coordinates. */
  clientToData(clientX: number, clientY: number): { x: number; y: number };
  /** A length in data coordinates -> length in screen pixels. */
  dataLengthToScreen(dataLength: number): number;
  /** True once the viewport is laid out and conversions are valid. */
  isReady(): boolean;
}

/** What a backend supplies so the tools can attach + convert coordinates. */
export interface IViewportHost {
  /** The element the tool's canvas overlay attaches to (fills the plot area). */
  getOverlayContainer(): HTMLElement | null;
  /** Live coordinate transform for the current viewport state. */
  getCoordinateTransform(): ICoordinateTransform;
}

/**
 * Region read/write access for the on-canvas tools, in the backend-neutral
 * {@link Region} model — so the wand and vertex eraser operate on regions, not
 * a backend's own shape representation. Both backends implement this by
 * delegating to the shared RegionStore.
 */
export interface IRegionDataHost {
  /** Current regions (neutral model). */
  getRegions(): Region[];
  /** Commit the (possibly mutated) region set; the backend renders + emits. */
  setRegions(regions: Region[]): void;
}
