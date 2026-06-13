import { cropImageRegion } from './slide-crop';
import { CachedImageData } from './wand-tool.service';

function grayCached(w: number, h: number): CachedImageData {
  // frame[y][x] = y*w + x (distinct values to verify the crop window)
  const frame = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => y * w + x));
  return { frames: [frame], width: w, height: h, ratios: [1], isGrayscale: true, originX: 0, originY: 0 };
}

describe('cropImageRegion (browser slide crop)', () => {
  it('extracts the box window as RGBA with the right size + origin', () => {
    const c = cropImageRegion(grayCached(10, 10), 0, { x0: 2, y0: 3, x1: 6, y1: 7 });
    expect(c).not.toBeNull();
    expect([c!.width, c!.height]).toEqual([4, 4]);
    expect([c!.matrixX0, c!.matrixY0]).toEqual([2, 3]);
    // top-left crop pixel = frame[3][2] = 3*10+2 = 32, replicated across RGB, opaque.
    expect(Array.from(c!.data.slice(0, 4))).toEqual([32, 32, 32, 255]);
  });

  it('clamps a box that runs past the image edge', () => {
    const c = cropImageRegion(grayCached(8, 8), 0, { x0: 5, y0: 5, x1: 100, y1: 100 });
    expect([c!.width, c!.height]).toEqual([3, 3]); // 5..8
    expect([c!.matrixX0, c!.matrixY0]).toEqual([5, 5]);
  });

  it('returns null for an empty/outside box', () => {
    expect(cropImageRegion(grayCached(8, 8), 0, { x0: 20, y0: 20, x1: 30, y1: 30 })).toBeNull();
  });

  it('honors origin/ratio (zoomed readback → data coords)', () => {
    const c: CachedImageData = {
      frames: [[[0, 0], [0, 0]]], width: 2, height: 2, ratios: [2], isGrayscale: true, originX: 10, originY: 10,
    };
    // data box (10,10)-(14,14) -> matrix (0,0)-(2,2)
    const out = cropImageRegion(c, 0, { x0: 10, y0: 10, x1: 14, y1: 14 });
    expect([out!.width, out!.height]).toEqual([2, 2]);
  });
});
