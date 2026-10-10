import { EDIT_TOL_PX, rectZone, resizeRect } from './region-hit-test';

describe('rectZone', () => {
  const box = { x0: 100, y0: 100, x1: 200, y1: 150 };

  it('finds the corners first, then the edges, then the body', () => {
    expect(rectZone(100, 100, box)).toBe('nw');
    expect(rectZone(203, 98, box)).toBe('ne');
    expect(rectZone(97, 152, box)).toBe('sw');
    expect(rectZone(200, 150, box)).toBe('se');
    expect(rectZone(100, 125, box)).toBe('w');
    expect(rectZone(200, 125, box)).toBe('e');
    expect(rectZone(150, 100, box)).toBe('n');
    expect(rectZone(150, 150, box)).toBe('s');
    expect(rectZone(150, 125, box)).toBe('move');
  });

  it('reaches the tolerance outside the box and no further', () => {
    expect(rectZone(100 - EDIT_TOL_PX, 125, box)).toBe('w');
    expect(rectZone(100 - EDIT_TOL_PX - 1, 125, box)).toBeNull();
    expect(rectZone(150, 125, box, 0)).toBe('move');
    expect(rectZone(99, 125, box, 0)).toBeNull();
  });
});

describe('resizeRect', () => {
  const orig = { x: 10, y: 20, width: 30, height: 40 };

  it('moves the body and drags single edges or corners', () => {
    expect(resizeRect(orig, 'move', 5, -5)).toEqual({ x: 15, y: 15, width: 30, height: 40 });
    expect(resizeRect(orig, 'e', 10, 99)).toEqual({ x: 10, y: 20, width: 40, height: 40 });
    expect(resizeRect(orig, 'n', 99, 10)).toEqual({ x: 10, y: 30, width: 30, height: 30 });
    expect(resizeRect(orig, 'sw', 5, 5)).toEqual({ x: 15, y: 20, width: 25, height: 45 });
  });

  it('flips when dragged past the opposite edge, and rounds to whole pixels', () => {
    expect(resizeRect(orig, 'w', 40, 0)).toEqual({ x: 40, y: 20, width: 10, height: 40 });
    expect(resizeRect(orig, 'se', 0.4, 0.6)).toEqual({ x: 10, y: 20, width: 30, height: 41 });
  });
});
