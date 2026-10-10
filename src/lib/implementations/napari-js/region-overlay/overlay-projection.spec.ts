import type { OverlayViewer } from '../napari-region-overlay';
import { OverlayProjection } from './overlay-projection';

describe('OverlayProjection', () => {
  // World = client px / 10, with the svg 100 px right of and 50 px below the client origin.
  const viewer = {
    canvasToWorld: (x: number, y: number) => [x / 10, y / 10] as [number, number],
    worldToCanvas: (x: number, y: number) => [x * 10, y * 10] as [number, number],
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

  it('converts world points to svg-local pixels, reading the svg rect once per block', () => {
    const { projection, rect } = setup();
    expect(projection.toLocal(20, 10)).toEqual([100, 50]);
    rect.mockClear();
    projection.withOrigin(() => {
      projection.toLocal(1, 1);
      projection.toScreen(2, 2);
      projection.screenDist(110, 60, 1, 1);
    });
    expect(rect).toHaveBeenCalledTimes(1);
    expect(projection.affine()).toEqual([10, 0, 0, 10, -100, -50]);
  });

  it('measures world units per screen pixel through the transform', () => {
    expect(setup().projection.worldPerCanvasPixel()).toBeCloseTo(0.1);
  });
});
