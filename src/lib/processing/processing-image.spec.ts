import { ProcessingImage } from './processing-image';

// jsdom has no ImageData; a minimal stand-in is enough to inspect the RGBA buffer.
class FakeImageData {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}

describe('ProcessingImage (RT-36)', () => {
  const g = globalThis as { ImageData?: unknown };
  const original = g.ImageData;
  beforeAll(() => { g.ImageData = FakeImageData; });
  afterAll(() => { g.ImageData = original; });

  it('expands gray+alpha (2 channels) to gray RGB with its alpha', () => {
    const img = new ProcessingImage(2, 1, 2, Uint8ClampedArray.from([10, 255, 200, 128]));
    expect(Array.from(img.toImageData().data)).toEqual([10, 10, 10, 255, 200, 200, 200, 128]);
  });

  it('expands gray and RGB with opaque alpha', () => {
    expect(Array.from(new ProcessingImage(1, 1, 1, Uint8ClampedArray.from([7])).toImageData().data))
      .toEqual([7, 7, 7, 255]);
    expect(Array.from(new ProcessingImage(1, 1, 3, Uint8ClampedArray.from([1, 2, 3])).toImageData().data))
      .toEqual([1, 2, 3, 255]);
  });

  it('rejects an unsupported channel count instead of producing transparent black', () => {
    expect(() => new ProcessingImage(1, 1, 5, new Uint8ClampedArray(5)).toImageData()).toThrow(/channel/);
  });

  it('toBlob rejects when the canvas cannot encode the image', async () => {
    const canvas = {
      width: 0, height: 0,
      getContext: () => ({ putImageData: jest.fn() }),
      toBlob: (cb: (b: Blob | null) => void) => cb(null),
    };
    const create = jest.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
    try {
      const img = new ProcessingImage(1, 1, 4, new Uint8ClampedArray(4));
      await expect(img.toBlob()).rejects.toThrow(/encode/);
    } finally {
      create.mockRestore();
    }
  });
});
