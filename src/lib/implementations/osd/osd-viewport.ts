import { Observable, Subject, defer } from 'rxjs';
import { startWith } from 'rxjs/operators';
import type * as OpenSeadragon from 'openseadragon';

import { quiet } from './osd-lib';
import { ZOOM_BUTTON_STEP } from './osd-zoom';
import { imageRectToViewport, viewportRectToImage } from './osd-coords';
import { OsdCoordinateTransform } from './osd-coordinate-transform';
import { PlotModeRect, PlotModeViewport } from '../../contracts/plot-type-contribution.contract';
import { TileDescriptor } from '../tile-server';

/** The service state the viewport adapter reads — live, so it follows a viewer rebuild. */
export interface OsdViewportHost {
  viewer(): OpenSeadragon.Viewer | null;
  descriptor(): TileDescriptor | null;
  coordTransform(): OsdCoordinateTransform | null;
  overlayContainer(): HTMLElement | null;
}

/**
 * The OpenSeadragon viewport as the rest of the library sees it: the visible
 * image rect (settled, and per animation frame), the {@link PlotModeViewport} a
 * contributed plot mode draws over, and the zoom/fit commands.
 *
 * Every member reads the CURRENT viewer through the host, so one instance lives
 * as long as the service and stays valid across viewer rebuilds.
 */
export class OsdViewportAdapter {
  /** Visible image region (full-image pixel coords) emitted when the view
   *  settles, so the intensity inset can re-sample at the current zoom level. */
  readonly viewportChange$ = new Subject<PlotModeRect>();
  /** The visible rect on every redraw, coalesced to one emission per animation
   *  frame. Feeds {@link PlotModeViewport.frame$}. */
  private readonly frame$ = new Subject<PlotModeRect>();
  private frameRaf: number | null = null;
  private plotModeViewport: PlotModeViewport | null = null;

  constructor(private readonly host: OsdViewportHost) {}

  /** Compute the current viewport's image-pixel rectangle (clamped to the image)
   *  and broadcast it. */
  emitViewportChange(): void {
    const rect = this.visibleImageRect();
    if (rect) this.viewportChange$.next(rect);
  }

  /** The current viewport's image-pixel rectangle, clamped to the image, or
   *  null when there is no laid-out viewport. */
  visibleImageRect(): PlotModeRect | null {
    const viewer = this.host.viewer();
    const d = this.host.descriptor();
    const vp = viewer?.viewport;
    if (!vp || !d) return null;
    try {
      // Route through world item 0 (osd-coords): vp.viewportToImageRectangle is
      // inaccurate and warns when the world holds multiple images (per-channel
      // multichannel layers), which fed the intensity inset a wrong ROI.
      const r = viewportRectToImage(viewer, vp.getBounds(true));
      const iw = d.width,
        ih = d.height;
      const x = Math.max(0, Math.min(iw, r.x));
      const y = Math.max(0, Math.min(ih, r.y));
      const width = Math.max(1, Math.min(iw - x, r.width));
      const height = Math.max(1, Math.min(ih - y, r.height));
      return { x, y, width, height };
    } catch {
      return null; /* viewport not ready */
    }
  }

  /**
   * Image-pixel rectangle the drawer canvas currently covers. Unlike
   * {@link visibleImageRect}, this is NOT clamped to the image bounds: the canvas
   * maps 1:1 to the viewport rectangle, so leaving it unclamped keeps
   * `canvasPx -> imagePx` an exact affine map (clamping would skew coordinates
   * near the image edges). Routed through world item 0 (see
   * {@link viewportRectToImage}) for multi-layer accuracy.
   */
  displayedSourceRect(): PlotModeRect | null {
    const viewer = this.host.viewer();
    const vp = viewer?.viewport;
    if (!vp || !this.host.descriptor()) return null;
    try {
      const r = viewportRectToImage(viewer, vp.getBounds(true));
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    } catch {
      return null;
    }
  }

  /** Coalesce redraws into one {@link frame$} emission per animation frame.
   *  Skipped entirely while nothing listens. */
  scheduleFrame(): void {
    if (this.frameRaf !== null || !this.frame$.observed) return;
    this.frameRaf = requestAnimationFrame(() => {
      this.frameRaf = null;
      const rect = this.visibleImageRect();
      if (rect) this.frame$.next(rect);
    });
  }

  /** Drop a pending {@link scheduleFrame} (the viewer is going away). */
  cancelFrame(): void {
    if (this.frameRaf !== null) {
      cancelAnimationFrame(this.frameRaf);
      this.frameRaf = null;
    }
  }

  /**
   * The viewport a contributed plot mode draws over. One stable object per
   * service: every method reads the CURRENT viewer, so it stays valid across a
   * viewer rebuild and reports `isReady() === false` while none is mounted
   * (conversions then return NaN rather than throwing).
   */
  plotModeViewportFor(): PlotModeViewport {
    if (this.plotModeViewport) return this.plotModeViewport;
    const nan = { x: NaN, y: NaN };
    const ct = () => this.host.coordTransform();
    const ready = () => !!ct()?.isReady();
    this.plotModeViewport = {
      getOverlayContainer: () => this.host.overlayContainer(),
      dataToClient: (x, y) => (ready() ? ct()!.dataToClient(x, y) : nan),
      clientToData: (cx, cy) => (ready() ? ct()!.clientToData(cx, cy) : nan),
      dataLengthToScreen: (len) => (ready() ? ct()!.dataLengthToScreen(len) : NaN),
      isReady: ready,
      // Both start with the current visible rect when the viewport is ready: a mode
      // activates after the base render has gone idle, so without it an overlay
      // following `frame$.subscribe(redraw)` would stay blank until the next pan/zoom.
      frame$: this.withCurrentRect(this.frame$, ready),
      settled$: this.withCurrentRect(this.viewportChange$, ready),
      fitBounds: (rect, options) => {
        const viewer = this.host.viewer();
        if (!viewer || !ready() || !(rect.width > 0) || !(rect.height > 0)) return;
        const vpRect = imageRectToViewport(viewer, rect.x, rect.y, rect.width, rect.height);
        viewer.viewport.fitBoundsWithConstraints(vpRect, !!options?.immediately);
      },
    };
    return this.plotModeViewport;
  }

  /** `source`, preceded by the current visible rect for each subscriber (when ready). */
  private withCurrentRect(source: Subject<PlotModeRect>, ready: () => boolean): Observable<PlotModeRect> {
    return defer(() => {
      const rect = ready() ? this.visibleImageRect() : null;
      return rect ? source.pipe(startWith(rect)) : source.asObservable();
    });
  }

  /**
   * Keep the user's current view across a container/split resize instead of
   * snapping home. Viewport bounds are image-relative (image width = 1), so
   * they're independent of the container's pixel size — capture the visible
   * region now and re-fit it once the new size has settled. OSD's autoResize
   * fires asynchronously and the angular-split transition animates the width
   * over a few hundred ms, so restore on the next frame and again after the
   * transition completes.
   */
  keepViewAcrossResize(): void {
    const vp = this.host.viewer()?.viewport;
    if (!vp) return;
    const bounds = vp.getBounds(true);
    const restore = () =>
      quiet(() => {
        this.host.viewer()?.viewport.fitBounds(bounds, true);
        this.host.viewer()?.viewport.applyConstraints(true);
      });
    requestAnimationFrame(restore);
    setTimeout(restore, 350);
  }

  goHome(): void {
    this.host.viewer()?.viewport.goHome();
  }

  /** Zoom by one button step about the centre (`factor` > 1 zooms in). */
  zoomBy(direction: 1 | -1): void {
    const vp = this.host.viewer()?.viewport;
    vp?.zoomBy(direction > 0 ? ZOOM_BUTTON_STEP : 1 / ZOOM_BUTTON_STEP);
    vp?.applyConstraints();
  }

  /** Fit the OSD viewport to an image-space rectangle (coords ordered
   *  [xMin, xMax, yMax, yMin]). */
  applyZoomToBox(coordinates: number[]): void {
    const viewer = this.host.viewer();
    if (!viewer || coordinates.length < 4) return;
    const [a, b, c, d] = coordinates;
    const x = Math.min(a, b);
    const w = Math.abs(b - a);
    const y = Math.min(c, d);
    const h = Math.abs(c - d);
    if (w <= 0 || h <= 0) return;
    const rect = imageRectToViewport(viewer, x, y, w, h);
    viewer.viewport.fitBounds(rect, false);
  }
}
