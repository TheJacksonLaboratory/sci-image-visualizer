import {
  OsdRectLike, OsdTiledImageLike, OsdViewerLike, OsdXY,
} from '../implementations/osd/osd-viewer-like';

/** Overrides for {@link fakeOsdViewer}: any top-level member, plus any subset of
 *  the viewport's and the world's members. */
export interface FakeOsdViewerParts extends Partial<Omit<OsdViewerLike, 'viewport' | 'world'>> {
  viewport?: Partial<OsdViewerLike['viewport']>;
  world?: Partial<OsdViewerLike['world']>;
}

const samePoint = (p: OsdXY): OsdXY => ({ x: p.x, y: p.y });
const sameRect = (r: OsdRectLike): OsdRectLike => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/**
 * A complete {@link OsdViewerLike} for unit tests: identity coordinate
 * conversions (element px == viewport == image px), an empty world, detached
 * `<div>`s for the canvas/element and no-op handlers — with the given members
 * overriding those defaults. Specs pass only what they assert on, without
 * casting a partial object.
 */
export function fakeOsdViewer(parts: FakeOsdViewerParts = {}): OsdViewerLike {
  const { viewport, world, ...rest } = parts;
  return {
    canvas: document.createElement('div'),
    element: document.createElement('div'),
    addTiledImage: () => undefined,
    addHandler: () => undefined,
    removeHandler: () => undefined,
    setMouseNavEnabled: () => undefined,
    isMouseNavEnabled: () => true,
    ...rest,
    viewport: {
      viewerElementToViewportCoordinates: samePoint,
      viewportToViewerElementCoordinates: samePoint,
      viewerElementToImageCoordinates: samePoint,
      imageToViewerElementCoordinates: samePoint,
      imageToViewportRectangle: (r) => r,
      viewportToImageRectangle: sameRect,
      pointFromPixel: samePoint,
      zoomBy: () => undefined,
      applyConstraints: () => undefined,
      ...viewport,
    },
    world: {
      getItemCount: () => 0,
      getItemAt: () => undefined,
      getIndexOfItem: () => -1,
      removeItem: () => undefined,
      ...world,
    },
  };
}

/** A world item for {@link fakeOsdViewer}: identity image↔viewport conversions,
 *  fully loaded, no-op opacity — with the given members overriding those. */
export function fakeOsdTiledImage(parts: Partial<OsdTiledImageLike> = {}): OsdTiledImageLike {
  return {
    viewportToImageCoordinates: samePoint,
    imageToViewportCoordinates: samePoint,
    imageToViewportRectangle: (r) => r,
    viewportToImageRectangle: sameRect,
    setOpacity: () => undefined,
    getFullyLoaded: () => true,
    ...parts,
  };
}

/** A detached `<div>` whose client rect sits at (`left`, `top`) — the canvas
 *  offset the client↔element conversions subtract. */
export function fakeCanvasAt(left: number, top: number): HTMLElement {
  const canvas = document.createElement('div');
  canvas.getBoundingClientRect = () => ({
    left, top, x: left, y: top, right: left, bottom: top, width: 0, height: 0, toJSON: () => ({}),
  });
  return canvas;
}
