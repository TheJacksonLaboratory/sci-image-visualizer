import { IViewportHost, IRegionDataHost } from '../../contracts/coordinate-transform.contract';
import type { CanvasToolId } from '../../contracts/display-types';
import type { CachedFrame } from './frame-pixels';

/**
 * The pixel readback a backend (Plotly, OpenSeadragon or napari-js) hands the
 * canvas tools for sampling. Returned by {@link CanvasToolHost.getCachedImageData}.
 */
export interface CachedImageData {
  /**
   * One frame per stack slice (length 1 for non-stack images): a nested `[y][x]`
   * matrix (Plotly) or a packed RGBA readback (OpenSeadragon, napari-js). Read
   * them through `framePixels()` (`tool-kit/frame-pixels`).
   */
  frames: CachedFrame[];
  /** Image-pixel width of each frame matrix. */
  width: number;
  /** Image-pixel height of each frame matrix. */
  height: number;
  /**
   * Data coords per matrix pixel: `[x, y]`. OSD and napari report distinct
   * ratios for a non-square viewport; a single entry applies to both axes
   * (see `MatrixFrame`).
   */
  ratios: number[];
  /** Whether each nested frame is a 2-D scalar matrix (true) or 3-channel RGB
   *  (false). Packed frames always read as RGB. */
  isGrayscale: boolean;
  /**
   * Data-coords of matrix pixel (0,0). Lets the matrix be a *crop* of the data
   * space rather than starting at the origin — e.g. the OSD backend samples the
   * currently rendered viewport, so when zoomed in the matrix covers only the
   * visible sub-region at screen resolution. Defaults to 0 (full-frame matrix,
   * as Plotly provides). matrixIndex = (data - origin) / ratio.
   */
  originX?: number;
  originY?: number;
}

/**
 * Everything a canvas tool needs from the backend it runs on — one interface
 * for every tool (it replaces the wand's, the vertex eraser's and the
 * zoom-to-box's own host types). Keeping it explicit keeps the dependency
 * one-way: the tools never import a backend.
 */
export interface CanvasToolHost extends IViewportHost, IRegionDataHost {
  /** Pixel data for sampling, and the data↔matrix frame. null when no image is loaded yet. */
  getCachedImageData(): CachedImageData | null;
  /** Index of the currently visible frame in a stack (0 for non-stack). */
  getActiveFrameIndex(): number;
  /** Current image's filename — stamped onto new shapes for filtering. */
  getFileName(): string | undefined;
  /** Default stroke colour for new shapes. */
  getShapeColor(): string;
  /**
   * Zoom-to-box: an overlay-pixel point (relative to the overlay container's
   * top-left) in the backend's data coordinates.
   */
  pixelToData?(px: number, py: number): { x: number; y: number };
  /**
   * Zoom-to-box: apply the selected rectangle, ordered `[xMin, xMax, yMax, yMin]`.
   * Plotly re-fetches or relayouts its axes; OpenSeadragon and napari-js fit the
   * view to the image rectangle.
   */
  applyZoomToBox?(dataBox: number[]): void;
}

/**
 * An on-canvas tool (wand, brush, vertex eraser, zoom-to-box, SAM point). One
 * instance per backend, owned by that backend's `CanvasToolManager`, so no
 * in-progress state (a stroke, SAM points) is shared between backends.
 */
export interface ICanvasTool<O = unknown> {
  readonly id: CanvasToolId;
  /** Arm the tool on `host` (lay its overlay over the plot). Arming the armed
   *  tool again only applies `options`; it keeps the work in progress. */
  activate(host: CanvasToolHost, options?: O): void;
  /** Remove the overlay and drop the work in progress. */
  deactivate(): void;
  /** Live option updates (also while disarmed: they apply to the next arming). */
  setOptions?(options: O): void;
  /** Drop the work in progress but stay armed (undo/redo, image switch). */
  reset?(): void;
}
