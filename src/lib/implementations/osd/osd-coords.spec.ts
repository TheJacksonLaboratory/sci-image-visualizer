import { elementToImage, imageToElement, imageRectToViewport, viewportRectToImage } from './osd-coords';
import { OSD } from './osd-lib';
import { OsdRectLike, OsdViewerLike } from './osd-viewer-like';
import { fakeOsdTiledImage, fakeOsdViewer } from '../../testing/fake-osd-viewer';

/**
 * CHARACTERIZATION TESTS (refactoring plan, Step 0).
 *
 * Pins the coordinate-conversion routing that every region/tool interaction
 * depends on: with a multi-image world (stack slices / per-channel layers) the
 * image<->viewport leg must go through world item 0; with an empty world it
 * falls back to the viewport methods. The fake viewer uses distinct scale
 * factors per leg so the path taken is provable from the output value.
 */

/** element↔viewport scale 100, viewport↔image scale 1000, fallback scale 7.
 *  Rect results are tagged with the path that produced them (`via`). */
function fakeViewer(withItem: boolean): OsdViewerLike {
  const tagged = (r: OsdRectLike, via: string) =>
    Object.assign(new OSD.Rect(r.x, r.y, r.width, r.height), { via });
  const item = fakeOsdTiledImage({
    viewportToImageCoordinates: (p) => ({ x: p.x * 1000, y: p.y * 1000 }),
    imageToViewportCoordinates: (p) => ({ x: p.x / 1000, y: p.y / 1000 }),
    imageToViewportRectangle: (r) =>
      tagged({ x: r.x / 1000, y: r.y / 1000, width: r.width / 1000, height: r.height / 1000 }, 'item'),
    viewportToImageRectangle: (r) =>
      tagged({ x: r.x * 1000, y: r.y * 1000, width: r.width * 1000, height: r.height * 1000 }, 'item'),
  });
  return fakeOsdViewer({
    world: {
      getItemCount: () => (withItem ? 1 : 0),
      getItemAt: () => (withItem ? item : undefined),
    },
    viewport: {
      viewerElementToViewportCoordinates: (p) => ({ x: p.x / 100, y: p.y / 100 }),
      viewportToViewerElementCoordinates: (p) => ({ x: p.x * 100, y: p.y * 100 }),
      // Fallback-only methods (deliberately different scale so use is detectable).
      viewerElementToImageCoordinates: (p) => ({ x: p.x * 7, y: p.y * 7 }),
      imageToViewerElementCoordinates: (p) => ({ x: p.x / 7, y: p.y / 7 }),
      imageToViewportRectangle: (r) => tagged(r, 'viewport'),
      viewportToImageRectangle: (r) => tagged(r, 'viewport'),
    },
  });
}

describe('osd-coords (characterization)', () => {
  describe('with a populated world (stack slices / channel layers)', () => {
    const viewer = fakeViewer(true);

    it('elementToImage routes element→viewport→item-0→image', () => {
      expect(elementToImage(viewer, 50, 100)).toEqual({ x: 500, y: 1000 });
    });

    it('imageToElement routes image→item-0→viewport→element', () => {
      expect(imageToElement(viewer, 500, 1000)).toEqual({ x: 50, y: 100 });
    });

    it('element↔image round-trips', () => {
      const img = elementToImage(viewer, 12, 34);
      const back = imageToElement(viewer, img.x, img.y);
      expect(back.x).toBeCloseTo(12);
      expect(back.y).toBeCloseTo(34);
    });

    it('imageRectToViewport converts through item 0', () => {
      const r = imageRectToViewport(viewer, 100, 200, 300, 400);
      expect(r).toMatchObject({ x: 0.1, y: 0.2, width: 0.3, height: 0.4, via: 'item' });
    });

    it('viewportRectToImage converts through item 0', () => {
      const r = viewportRectToImage(viewer, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
      expect(r).toMatchObject({ x: 100, y: 200, width: 300, height: 400, via: 'item' });
    });
  });

  describe('with an empty world (no tiled image yet)', () => {
    const viewer = fakeViewer(false);

    it('elementToImage falls back to the viewport conversion', () => {
      expect(elementToImage(viewer, 10, 20)).toEqual({ x: 70, y: 140 });
    });

    it('imageToElement falls back to the viewport conversion', () => {
      expect(imageToElement(viewer, 70, 140)).toEqual({ x: 10, y: 20 });
    });

    it('rect conversions fall back to the viewport methods', () => {
      expect(imageRectToViewport(viewer, 1, 2, 3, 4)).toMatchObject({ via: 'viewport' });
      expect(viewportRectToImage(viewer, { x: 1, y: 2, width: 3, height: 4 })).toMatchObject({ via: 'viewport' });
    });
  });
});
