import * as OpenSeadragon from 'openseadragon';

/**
 * Coordinate conversions between screen (viewer-element) pixels, the OSD viewport,
 * and image (data) pixels.
 *
 * With the stack-slice cache the world holds several tiled images at once, which
 * makes the `Viewport.*` image conversions ambiguous — OpenSeadragon logs
 * "not accurate with multi-image; use TiledImage.* instead". All slices share the
 * same dimensions and placement, so we route the image<->viewport step through a
 * single reference tiled image (world item 0) and keep the viewport<->element
 * step on the viewport (which is unambiguous). Falls back to the viewport methods
 * when the world is empty.
 */
const osd: any = OpenSeadragon as any;

/** Reference tiled image for image<->viewport conversions (any slice works since
 *  they share geometry). */
function refItem(viewer: any): any | null {
  return viewer?.world?.getItemCount?.() > 0 ? viewer.world.getItemAt(0) : null;
}

/** Viewer-element pixel -> image (data) coordinates. */
export function elementToImage(viewer: any, x: number, y: number): { x: number; y: number } {
  const vp = viewer.viewport;
  const pt = new osd.Point(x, y);
  const item = refItem(viewer);
  const img = item
    ? item.viewportToImageCoordinates(vp.viewerElementToViewportCoordinates(pt))
    : vp.viewerElementToImageCoordinates(pt);
  return { x: img.x, y: img.y };
}

/** Image (data) coordinates -> viewer-element pixel point. */
export function imageToElement(viewer: any, x: number, y: number): { x: number; y: number } {
  const vp = viewer.viewport;
  const pt = new osd.Point(x, y);
  const item = refItem(viewer);
  const p = item
    ? vp.viewportToViewerElementCoordinates(item.imageToViewportCoordinates(pt))
    : vp.imageToViewerElementCoordinates(pt);
  return { x: p.x, y: p.y };
}

/** Image-space rectangle -> viewport rectangle (for fitBounds). */
export function imageRectToViewport(viewer: any, x: number, y: number, w: number, h: number): any {
  const rect = new osd.Rect(x, y, w, h);
  const item = refItem(viewer);
  return item ? item.imageToViewportRectangle(rect) : viewer.viewport.imageToViewportRectangle(rect);
}
