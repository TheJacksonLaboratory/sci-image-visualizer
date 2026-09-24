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

  it('dataToClient maps through the viewport, then adds the canvas rect', () => {
    const viewer = {
      canvas: { getBoundingClientRect: () => ({ left: 5, top: 7 }) },
      world: { getItemCount: () => 0 },
      viewport: { imageToViewerElementCoordinates: (p: any) => ({ x: p.x / 2, y: p.y / 3 }) },
    };
    // element pt = (30/2, 39/3) = (15, 13) -> + (5, 7) = (20, 20)
    expect(new OsdCoordinateTransform(viewer).dataToClient(30, 39)).toEqual({ x: 20, y: 20 });
  });

  it('dataToClient and clientToData round-trip, on the viewport and the world-item path', () => {
    // A zoomed, panned view: element = (image - pan) * zoom.
    const zoom = 0.37, panX = 1200, panY = -340;
    const viewport = {
      imageToViewerElementCoordinates: (p: any) => ({ x: (p.x - panX) * zoom, y: (p.y - panY) * zoom }),
      viewerElementToImageCoordinates: (p: any) => ({ x: p.x / zoom + panX, y: p.y / zoom + panY }),
      // World-item path: viewport coords are image coords / 1000 here.
      viewportToViewerElementCoordinates: (p: any) =>
        ({ x: (p.x * 1000 - panX) * zoom, y: (p.y * 1000 - panY) * zoom }),
      viewerElementToViewportCoordinates: (p: any) =>
        ({ x: (p.x / zoom + panX) / 1000, y: (p.y / zoom + panY) / 1000 }),
    };
    const item = {
      imageToViewportCoordinates: (p: any) => ({ x: p.x / 1000, y: p.y / 1000 }),
      viewportToImageCoordinates: (p: any) => ({ x: p.x * 1000, y: p.y * 1000 }),
    };
    const canvas = { getBoundingClientRect: () => ({ left: 40, top: 96 }) };
    for (const count of [0, 1]) {
      const viewer = { canvas, viewport, world: { getItemCount: () => count, getItemAt: () => item } };
      const t = new OsdCoordinateTransform(viewer);
      for (const [x, y] of [[0, 0], [1234.5, 678.25], [40000, 31000]]) {
        const c = t.dataToClient(x, y);
        const back = t.clientToData(c.x, c.y);
        expect(back.x).toBeCloseTo(x, 6);
        expect(back.y).toBeCloseTo(y, 6);
      }
    }
  });
});
