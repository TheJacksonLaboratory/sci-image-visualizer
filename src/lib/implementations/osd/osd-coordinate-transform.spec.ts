import { OsdCoordinateTransform } from './osd-coordinate-transform';

/**
 * Tests use an empty world (getItemCount = 0) so the conversions take the
 * viewport-direct path (no reference TiledImage), letting us stub the viewport's
 * coordinate maps with simple linear functions. The world-item path is exercised
 * by osd-coords.spec.
 */
describe('OsdCoordinateTransform', () => {
  it('isReady is false without a viewport or world items', () => {
    expect(new OsdCoordinateTransform({ viewport: null, world: { getItemCount: () => 0 } }).isReady())
      .toBe(false);
    expect(new OsdCoordinateTransform({ viewport: {}, world: { getItemCount: () => 0 } }).isReady())
      .toBe(false);
  });

  it('isReady is true with a viewport and at least one world item', () => {
    expect(new OsdCoordinateTransform({ viewport: {}, world: { getItemCount: () => 1 } }).isReady())
      .toBe(true);
  });

  it('clientToData subtracts the canvas rect, then maps through the viewport', () => {
    const viewer = {
      canvas: { getBoundingClientRect: () => ({ left: 5, top: 7 }) },
      world: { getItemCount: () => 0 },
      viewport: { viewerElementToImageCoordinates: (p: any) => ({ x: p.x * 2, y: p.y * 3 }) },
    };
    // element pt = (20-5, 20-7) = (15, 13) -> (*2, *3) = (30, 39)
    expect(new OsdCoordinateTransform(viewer).clientToData(20, 20)).toEqual({ x: 30, y: 39 });
  });

  it('dataLengthToScreen is the element-space distance of a data-length step', () => {
    const viewer = {
      world: { getItemCount: () => 0 },
      viewport: { imageToViewerElementCoordinates: (p: any) => ({ x: p.x * 4, y: p.y }) },
    };
    // |imageToElement(10,0).x - imageToElement(0,0).x| = |40 - 0| = 40
    expect(new OsdCoordinateTransform(viewer).dataLengthToScreen(10)).toBe(40);
  });
});
