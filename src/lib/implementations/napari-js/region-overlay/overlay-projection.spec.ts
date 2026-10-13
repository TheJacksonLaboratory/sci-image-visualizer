import type { OverlayViewer } from '../napari-region-overlay';
import { OverlayProjection } from './overlay-projection';

describe('OverlayProjection', () => {
  // World = client px / 10, with the svg (and the canvas) 100 px right of and 50 px below the
  // client origin: world → svg-local is ×10 less that offset.
  const viewer = {
    canvasToWorld: (x: number, y: number) => [x / 10, y / 10] as [number, number],
    canvasTransform: () => [10, 0, 0, 10, -100, -50] as [number, number, number, number, number, number],
    setControlsEnabled: () => undefined,
    camera: { changed: { connect: () => () => undefined } },
  } as OverlayViewer;

  function setup() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const rect = jest.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50 } as DOMRect);
    return { projection: new OverlayProjection(svg, viewer), rect };
  }

  it('snaps placed points to the world quantum, but not picked ones', () => {
    const { projection } = setup();
    expect(projection.toImage(123, 47)).toEqual([12, 5]); // whole world units by default
    projection.setWorldQuantum(0.1);
    expect(projection.toImage(123, 47)).toEqual([12.3, 4.7]);
    projection.setWorldQuantum(0); // not a quantum: back to pixels
    expect(projection.toImage(123, 47)).toEqual([12, 5]);
    expect(projection.toWorld(123, 47)).toEqual([12.3, 4.7]);
  });

  it('converts world points to svg-local pixels through the camera affine, with no layout read', () => {
    const { projection, rect } = setup();
    expect(projection.toLocal(20, 10)).toEqual([100, 50]);
    expect(projection.affine()).toEqual([10, 0, 0, 10, -100, -50]);
    expect(rect).not.toHaveBeenCalled();
  });

  it('reads the svg rect once per block for pointers, however many it converts', () => {
    const { projection, rect } = setup();
    projection.withOrigin(() => {
      projection.toLocal(1, 1);
      projection.toScreen(2, 2);
      expect(projection.screenDist(110, 60, 11, 6)).toBe(0); // the same point, both ways
      projection.clientToLocal(5, 5);
    });
    expect(rect).toHaveBeenCalledTimes(1);
  });

  it('measures world units per screen pixel through the transform', () => {
    expect(setup().projection.worldPerCanvasPixel()).toBeCloseTo(0.1);
  });
});
