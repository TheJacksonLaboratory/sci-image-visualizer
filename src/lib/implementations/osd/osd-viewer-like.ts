import type * as OpenSeadragon from 'openseadragon';

/**
 * The slice of an OpenSeadragon `Viewer` that the OSD helpers (osd-coords, the
 * coordinate transform, the scale bar, the region overlay and the slice cache)
 * actually use — and nothing more (OSD-PLOTLY-27).
 *
 * The real `OpenSeadragon.Viewer` is assignable to it as is, so the service
 * passes its viewer straight through; the specs build a small fake (see
 * `testing/fake-osd-viewer.ts`) instead of casting a partial object. Points and
 * rectangles are structural where the helpers only read `x`/`y`/`width`/`height`;
 * `OpenSeadragon.Rect` is kept only where the result goes back into OSD
 * (`imageToViewportRectangle` → `viewport.fitBounds`).
 */
export interface OsdViewerLike {
  /** The element OSD draws into; overlays (scale bar, region SVG) are appended
   *  here and its client rect anchors client↔element conversions. */
  canvas: HTMLElement;
  /** The viewer's root element (an ancestor of the canvas and of the tool
   *  overlays) — the wheel-zoom listener is bound here. */
  element: HTMLElement;
  viewport: {
    viewerElementToViewportCoordinates(p: OsdXY): OsdXY;
    viewportToViewerElementCoordinates(p: OsdXY): OsdXY;
    /** Image conversions on the viewport — ambiguous once the world holds
     *  several images; used only as the empty-world fallback. */
    viewerElementToImageCoordinates(p: OsdXY): OsdXY;
    imageToViewerElementCoordinates(p: OsdXY): OsdXY;
    imageToViewportRectangle(r: OpenSeadragon.Rect): OpenSeadragon.Rect;
    viewportToImageRectangle(r: OsdRectLike): OsdRectLike;
    /** Viewer-element pixel → viewport point (the wheel-zoom anchor). */
    pointFromPixel(p: OsdXY): OsdXY;
    zoomBy(factor: number, refPoint?: OsdXY): unknown;
    applyConstraints(immediately?: boolean): unknown;
  };
  world: {
    getItemCount(): number;
    /** `undefined` past the end of the world (OSD returns it at runtime). */
    getItemAt(index: number): OsdTiledImageLike | undefined;
    /** -1 when the item is no longer in the world (evicted / removed). */
    getIndexOfItem(item: OsdTiledImageLike): number;
    removeItem(item: OsdTiledImageLike): void;
  };
  /** Queue a tiled image into the world; `success` fires once it is added (not
   *  once its tiles have loaded). */
  addTiledImage(options: OsdAddTiledImageOptions): void;
  addHandler(event: OsdViewerEventName, handler: () => void): unknown;
  removeHandler(event: OsdViewerEventName, handler: () => void): unknown;
  /** OSD's own pan/zoom (drag + wheel); region tools switch it off. */
  setMouseNavEnabled(enabled: boolean): unknown;
  isMouseNavEnabled(): boolean;
}

/** A point in any OSD space (viewer-element px, viewport units or image px —
 *  the method it comes from says which). */
export interface OsdXY {
  x: number;
  y: number;
}

/** An axis-aligned rectangle, in the space of the method that produced it. */
export interface OsdRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The members of an OSD `TiledImage` (one world item: an image, a stack slice
 *  or one channel layer) the helpers use. */
export interface OsdTiledImageLike {
  viewportToImageCoordinates(p: OsdXY): OsdXY;
  imageToViewportCoordinates(p: OsdXY): OsdXY;
  imageToViewportRectangle(r: OpenSeadragon.Rect): OpenSeadragon.Rect;
  viewportToImageRectangle(r: OsdRectLike): OsdRectLike;
  setOpacity(opacity: number): void;
  /** False while any of the image's tiles are still loading. */
  getFullyLoaded(): boolean;
  /** Re-run the tile pipeline (restore + re-process) for this image's tiles;
   *  tiles already stamped at `>= tStamp` are skipped. Optional: the slice
   *  cache feature-tests it. */
  requestInvalidate?(restoreTiles?: boolean, viewportOnly?: boolean, tStamp?: number): unknown;
}

/** The `addTiledImage` options the slice cache passes. Image placement is in
 *  viewport units (`width: 1` = the primary image's normalized width). */
export interface OsdAddTiledImageOptions {
  tileSource: string | object;
  x?: number;
  y?: number;
  width?: number;
  opacity?: number;
  /** Load tiles even while hidden (opacity 0). */
  preload?: boolean;
  /** Canvas composite operation, e.g. `'lighter'` for additive channels. */
  compositeOperation?: string;
  /** Fires once the image is in the world. OSD types the payload as a DOM
   *  `Event`; at runtime it carries the added `item`. */
  success?(event: Event & { item?: OsdTiledImageLike }): void;
  error?(): void;
}

/** The viewer events the helpers subscribe to. */
export type OsdViewerEventName = 'update-viewport' | 'animation' | 'resize' | 'rotate';
