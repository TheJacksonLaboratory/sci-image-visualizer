import { newImageData } from './image-data';

describe('newImageData', () => {
  // jsdom has no ImageData; a stand-in that keeps what it was given is enough here.
  const original = (globalThis as { ImageData?: unknown }).ImageData;
  beforeAll(() => {
    (globalThis as { ImageData?: unknown }).ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
  });
  afterAll(() => {
    (globalThis as { ImageData?: unknown }).ImageData = original;
  });

  it('uses pixels in an ArrayBuffer as they are', () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 4]);
    const image = newImageData(rgba, 1, 1);
    expect(image.data).toBe(rgba);
    expect([image.width, image.height]).toEqual([1, 1]);
  });

  it('copies pixels in a SharedArrayBuffer', () => {
    const rgba = new Uint8ClampedArray(new SharedArrayBuffer(4));
    rgba.set([5, 6, 7, 8]);
    const image = newImageData(rgba, 1, 1);
    expect(image.data).not.toBe(rgba);
    expect(image.data.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...image.data]).toEqual([5, 6, 7, 8]);
  });
});
