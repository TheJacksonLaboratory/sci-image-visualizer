import * as Plotly from 'plotly.js-dist-min';
import { Image } from 'image-js';
import { Buffer } from 'buffer';
import { MessageService } from 'primeng/api';

import { IImageInfo } from '../../contracts/image.contract';
import { TileAccessPort } from '../../contracts/ports/tile-access.port';
import { ImageStatePort } from '../../contracts/ports/image-state.port';
import { PlotUtilities } from '../../plot.utilities';
import { VIZ_ALERT_TOAST_KEY } from '../../toast-outlets';
import { ZOOM_BUTTON_STEP } from '../osd/osd-zoom';

/** A Plotly graph div, as far as the zoom reads it. */
type GraphDiv = HTMLElement & {
  _fullLayout?: { xaxis?: PlotAxis; yaxis?: PlotAxis };
};
type PlotAxis = { range?: number[]; _offset: number; p2d(px: number): number };

/** The service state and render hooks the zoom drives. */
export interface PlotlyZoomHost {
  plotDiv(): string;
  /** [x0, x1, y0, y1] of the plotted image, or undefined before one. */
  trueImgSize(): number[] | undefined;
  imageInfo(): IImageInfo | undefined;
  fileName(): string | undefined;
  imageCached(): boolean;
  zIndex(): number;
  /** Start a render generation; a newer one supersedes a crop in flight. */
  nextRenderGen(): number;
  isCurrentRender(gen: number): boolean;
  heatmapLayout(xRange: number[], yRange: number[]): Plotly.Layout;
  setScreenHeight(height: number): void;
  /** Called at request time: returns the hook that samples the crop's pixels
   *  (tools + intensity profiles), or drops them when sampling moved on. */
  cropSampler(): (frame: any[], ratios: number[], origin: [number, number]) => void;
  /** Re-render the crop in the plot type on screen; `reapplyRange` when the
   *  layout is image-aligned (the heatmap range must be re-applied). */
  renderCrop(frame: any[], ratios: number[], size: [number, number], imageSize: number[], fileName?: string):
    { rendered: Promise<unknown>; reapplyRange: boolean };
  /** Clear the plot after a failed relayout. */
  reset(): void;
}

/**
 * Plotly zoom: the step and box zooms, autoscale, and the HIGH-DEF zoom — a
 * zoomed-in range is re-fetched from the server at screen resolution and
 * re-rendered in place, so the user sees the data at the zoom level rather
 * than the upscaled preview. Owns the current zoom box.
 */
export class PlotlyZoomController {
  /** The zoomed range [x0, x1, y0, y1], or [] when not zoomed. */
  zoomCoordinates: number[] = [];
  /** Whether a 2D drag-zoom re-fetches at high definition. */
  isRealZoom = true;
  private readonly utils = new PlotUtilities();

  constructor(private readonly host: PlotlyZoomHost,
              private readonly state: ImageStatePort,
              private readonly tiles: TileAccessPort,
              private readonly messages: MessageService) {}

  private gd(): GraphDiv | null {
    const id = this.host.plotDiv();
    return id ? document.getElementById(id) as GraphDiv | null : null;
  }

  /** The axis-range part of a `plotly_relayout` event: remember the drag-zoom
   *  box and, outside stack mode, re-fetch it at high definition. */
  onRelayout(event: Record<string, any>): void {
    const keys = Object.keys(event);
    if (keys.length !== 4 || !this.isRealZoom) return;
    const coordinates = keys
      .filter((key) => key.startsWith('xaxis.range[') || key.startsWith('yaxis.range['))
      .map((key) => event[key]);
    this.zoomCoordinates = coordinates;
    if (!this.host.imageInfo()?.showStack) this.triggerZoom(coordinates);
  }

  /** Autoscale the plot (and forget the zoom box). */
  autoscale(): void {
    const plotDiv = this.host.plotDiv();
    if (!plotDiv) return;
    this.zoomCoordinates = [];
    Plotly.relayout(plotDiv, { 'xaxis.autorange': true, 'yaxis.autorange': false });
  }

  /** Back to the whole image. */
  resetAxes(): void {
    this.zoomCoordinates = [];
    this.relayout();
  }

  /**
   * Re-apply the image layout at the current DOM height: over the zoom box when
   * zoomed, else over `trueImageSize` (default: the plotted image). A failed
   * relayout clears the plot and tells the user to reopen the image.
   */
  relayout(trueImageSize?: number[]): void {
    const imgSize = trueImageSize ?? this.host.trueImgSize()!;
    const plotDiv = this.host.plotDiv();
    if (!plotDiv) return;
    // Refresh height from current DOM so panel resizes are reflected
    const plotEl = document.getElementById(plotDiv);
    if (plotEl?.offsetHeight) this.host.setScreenHeight(plotEl.offsetHeight);
    try {
      const z = this.zoomCoordinates;
      Plotly.relayout(plotDiv, z.length > 0
        ? this.host.heatmapLayout([z[0], z[1]], [z[2], z[3]]) // reverse the y range
        // autorange is off and the axis not reversed, so the y range is set here
        : this.host.heatmapLayout([imgSize[0], imgSize[1]], [imgSize[3], imgSize[2]]));
    } catch (err: any) {
      const msg = err?.error?.message || err?.message || err?.statusText || String(err);
      console.error('Error occured', err);
      this.messages.add({ key: VIZ_ALERT_TOAST_KEY, sticky: true, severity: 'error', summary: 'An error occured',
        detail: `The following
                                  error occured: ${msg}. Please try to open the image again through the
                                  file navigator.` });
      // TODO correctly clear the plot
      this.host.reset();
    }
  }

  zoomIn(): void {
    this.stepZoom(1 / ZOOM_BUTTON_STEP);
  }

  zoomOut(): void {
    this.stepZoom(ZOOM_BUTTON_STEP);
  }

  /** Scale the visible range about its centre by `factor` (< 1 zooms in). */
  private stepZoom(factor: number): void {
    const plotDiv = this.host.plotDiv();
    const layout = this.gd()?._fullLayout;
    if (!plotDiv || !layout) return;
    const xl = layout.xaxis;
    const yl = layout.yaxis;
    // 3D scenes have no 2D xaxis/yaxis (they live under `scene`); the step-zoom
    // is meaningless there and would throw on `xl.range`. Plotly's scene handles
    // scroll-zoom natively, so just bail.
    if (!xl?.range || !yl?.range) return;
    const xc = (xl.range[0] + xl.range[1]) / 2;
    const yc = (yl.range[0] + yl.range[1]) / 2;
    const dx = (xl.range[1] - xl.range[0]) * factor;
    const dy = (yl.range[1] - yl.range[0]) * factor;
    const x0 = xc - dx / 2, x1 = xc + dx / 2;
    const y0 = yc - dy / 2, y1 = yc + dy / 2;
    this.zoomCoordinates = [x0, x1, y0, y1];
    Plotly.relayout(plotDiv, {
      'xaxis.range[0]': x0, 'xaxis.range[1]': x1,
      'yaxis.range[0]': y0, 'yaxis.range[1]': y1,
    } as Plotly.Layout);
  }

  /** Overlay pixel → data coords via the axis objects (minus the plot margin);
   *  the zoom-to-box tool calls this through its host. */
  pixelToData(px: number, py: number): { x: number; y: number } {
    const layout = this.gd()!._fullLayout!;
    const xaxis = layout.xaxis!;
    const yaxis = layout.yaxis!;
    return { x: xaxis.p2d(px - xaxis._offset), y: yaxis.p2d(py - yaxis._offset) };
  }

  /**
   * Apply a zoom-to-box selection: stack mode does a pure axis-range relayout;
   * otherwise the high-def pipeline re-fetches the box at the new resolution.
   */
  applyZoomToBox(coordinates: number[]): void {
    this.zoomCoordinates = coordinates;
    if (this.host.imageInfo()?.showStack) {
      Plotly.relayout(this.host.plotDiv(), {
        'xaxis.range[0]': coordinates[0],
        'xaxis.range[1]': coordinates[1],
        'yaxis.range[0]': coordinates[2],
        'yaxis.range[1]': coordinates[3],
      } as Plotly.Layout);
    } else {
      this.triggerZoom(coordinates);
    }
  }

  /**
   * The high-def zoom: fetch `coordinates` from the server at screen resolution
   * and re-render it in place (in the plot type on screen), unless the user
   * moved on meanwhile — another file, another render of the div (a new zoom or
   * plot, or the div handed to another backend). A box covering the whole image
   * autoscales instead.
   */
  triggerZoom(coordinates: number[]): void {
    const trueImgSize = this.host.trueImgSize();
    if (coordinates.length === 0 || !trueImgSize) return;
    this.zoomCoordinates = coordinates;
    const rect = this.utils.getRectangle(coordinates, trueImgSize);
    if (this.utils.isZoomSameAsImgSize(rect, trueImgSize)) {
      this.autoscale();
      return;
    }
    // A brief "Caching image..." message for uncached files (large files take a
    // moment to cache); just a spinner otherwise.
    this.state.setImageLoadingMessage(this.host.imageCached() ? '' : 'Caching image...');
    // Sized from this viewer's own plot div, not jit-ui's `#diagram` wrapper,
    // which other hosts (and the pipeline preview) don't have.
    const screen = this.utils.getDomRectangle(this.host.plotDiv());
    const imageSize = [rect.x, rect.x + rect.width, rect.y, rect.y + rect.height];
    // Snapshot the filename so a response that arrives after the user switched
    // files is dropped (the request carried the file selected at call time).
    const reqName = this.host.fileName();
    const gen = this.host.nextRenderGen();
    const sample = this.host.cropSampler();
    this.state.setImageLoading(true);
    this.state.setZoom(true);
    this.tiles.zoomOnRegion(rect, screen, this.host.zIndex()).subscribe({
      next: (zoomData) => {
        Image.load(Buffer.from(new Uint8Array(zoomData))).then((image: any) => {
          const ratios = [rect.width / image.width, rect.height / image.height];
          const current = this.host.fileName() === reqName && this.host.isCurrentRender(gen);
          if (!current || !this.gd()?._fullLayout) return;
          const frame = this.host.imageInfo()?.isGrayscale
            ? this.utils.arrayToMatrix(image.grey().data, image.width)
            : this.utils.arrayToMatrix(image.getPixelsArray(), image.width);
          // Also sample the intensity profiles (and the tools) from the crop, so
          // they reflect the zoom-level resolution (origin = crop top-left).
          sample([frame], ratios, [imageSize[0], imageSize[2]]);
          const { rendered, reapplyRange } =
            this.host.renderCrop(frame, ratios, [image.width, image.height], imageSize, reqName);
          rendered.then(() => {
            this.state.setImageCached(true);
            this.state.setImageLoading(false);
            image = null;
            if (reapplyRange) this.relayout(imageSize);
          });
        });
      },
      error: (err) => {
        const msg = err?.error?.message || err?.message || err?.statusText || String(err);
        console.error('Error occured when zooming', err);
        this.messages.add({ key: VIZ_ALERT_TOAST_KEY, sticky: true, severity: 'error', summary: 'An error occured',
          detail: `The following error occured while zooming: ${msg}.
                          Please try to open the image again through the file navigator and
                          zoom on the selected area once more.` });
        this.state.setLoadingError(true);
        this.state.setImageLoading(false);
      },
    });
  }
}
