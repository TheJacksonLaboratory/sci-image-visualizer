import { cropImage } from './image-crop';
import { ProcessingImage } from './processing-image';

/** width×height RGBA image whose red channel encodes the linear index (mod 256). */
function rampImage(width: number, height: number): ProcessingImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i % 256;
    data[i * 4 + 3] = 255;
  }
  return new ProcessingImage(width, height, 4, data);
}

describe('cropImage', () => {
  it('crops a rectangle out of the source at the requested origin', () => {
    const out = cropImage(rampImage(10, 10), { x: 2, y: 3, width: 4, height: 5 });
    expect(out.width).toBe(4);
    expect(out.height).toBe(5);
    expect(out.channels).toBe(4);
    expect(out.data[0]).toBe(32 % 256);       // top-left → source (2,3) = index 32
    expect(out.data[4]).toBe(33 % 256);       // one px right → (3,3) = 33
    expect(out.data[4 * 4]).toBe(42 % 256);   // one row down → (2,4) = 42
  });

  it('clamps an over-sized / out-of-bounds rectangle to the image', () => {
    const out = cropImage(rampImage(8, 8), { x: 6, y: 6, width: 100, height: 100 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });

  it('downsamples by 2^level when level > 0', () => {
    const out = cropImage(rampImage(16, 16), { x: 0, y: 0, width: 16, height: 16, level: 2 });
    expect(out.width).toBe(4);   // 16 / 2^2
    expect(out.height).toBe(4);
  });

  it('treats level 0 as full resolution (no downsample)', () => {
    const out = cropImage(rampImage(8, 8), { x: 0, y: 0, width: 8, height: 8, level: 0 });
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);
  });

  it('defaults to the whole image when no rectangle is given', () => {
    const out = cropImage(rampImage(6, 4));
    expect(out.width).toBe(6);
    expect(out.height).toBe(4);
  });
});
