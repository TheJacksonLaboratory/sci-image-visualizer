import { BehaviorSubject, of } from 'rxjs';

import { currentMicronsPerPixel, downsampleRgba, sampleViewAtScale, ViewSource } from './view-at-scale';

/** A view whose screen shows `rect` of a `imgW`×`imgH` image as `w`×`h` pixels (value = x). */
function view(
  w: number,
  h: number,
  rect: { x: number; y: number; width: number; height: number },
  imgW = 1000,
  imgH = 1000,
): ViewSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x % 256, y % 256, 0, 255], (y * w + x) * 4);
  return {
    getDisplayedPixelData: () => ({ width: w, height: h, channels: 4, data }),
    getDisplayedSourceRect: () => rect,
    getTrueImageSize: () => ({ width: imgW, height: imgH }),
  };
}

describe('sampleViewAtScale', () => {
  it('returns the screen pixels as they are without a target', async () => {
    const s = await sampleViewAtScale(view(100, 50, { x: 200, y: 100, width: 400, height: 200 }));
    expect(s).toMatchObject({ width: 100, height: 50, origin: 'displayed', coarse: false });
    expect(s!.rect).toEqual({ x: 200, y: 100, width: 400, height: 200 });
    expect(s!.factorX).toBe(4);
  });

  it('averages a zoomed-in screen down to the target (#98)', async () => {
    // 1 image px per screen px; the model wants 4.
    const s = await sampleViewAtScale(view(400, 200, { x: 0, y: 0, width: 400, height: 200 }), {
      targetFactor: 4,
    });
    expect(s).toMatchObject({ width: 100, height: 50, origin: 'resampled', factorX: 4, factorY: 4 });
  });

  it('re-crops a zoomed-out view on the server at the target', async () => {
    const zoomOnRegion = jest.fn(() => of(new ArrayBuffer(0)));
    const s = await sampleViewAtScale(view(100, 100, { x: 0, y: 0, width: 1000, height: 1000 }), {
      targetFactor: 2,
      tileAccess: { zoomOnRegion } as any,
    });
    expect(zoomOnRegion).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 1000, height: 1000 },
      { x: 0, y: 0, width: 500, height: 500 },
      0,
    );
    // The empty crop fails: the screen is used, and flagged coarser than asked.
    expect(s).toMatchObject({ width: 100, origin: 'displayed', coarse: true });
  });

  it('uses the screen pixels when zoomed out with no tile access', async () => {
    const s = await sampleViewAtScale(view(100, 100, { x: 0, y: 0, width: 1000, height: 1000 }), {
      targetFactor: 1,
    });
    expect(s).toMatchObject({ width: 100, origin: 'displayed', coarse: true });
  });

  it('clips the view to the image, dropping the margins', async () => {
    // A zoomed-out view: the screen covers -500..1500 of a 1000-px image at 10 px per screen px.
    const s = await sampleViewAtScale(view(200, 200, { x: -500, y: -500, width: 2000, height: 2000 }));
    expect(s!.rect).toEqual({ x: 0, y: 0, width: 1000, height: 1000 });
    expect(s).toMatchObject({ width: 100, height: 100 });
    // The first sample pixel is screen column 50.
    expect(s!.data[0]).toBe(50);
  });

  it('caps the output size and flags it coarse', async () => {
    const s = await sampleViewAtScale(view(1000, 1000, { x: 0, y: 0, width: 1000, height: 1000 }), {
      targetFactor: 1,
      maxPixels: 100 * 100,
    });
    expect(s).toMatchObject({ width: 100, height: 100, origin: 'resampled', coarse: true });
  });

  it('returns null with nothing on screen or a view off the image', async () => {
    expect(
      await sampleViewAtScale({
        getDisplayedPixelData: () => null,
        getDisplayedSourceRect: () => null,
        getTrueImageSize: () => null,
      }),
    ).toBeNull();
    expect(await sampleViewAtScale(view(10, 10, { x: 2000, y: 0, width: 100, height: 100 }))).toBeNull();
  });
});

describe('downsampleRgba', () => {
  it('area-averages', () => {
    const src = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]);
    expect(Array.from(downsampleRgba(src, 2, 1, 1, 1))).toEqual([50, 50, 50, 255]);
  });
});

describe('currentMicronsPerPixel', () => {
  it('reads the first positive mpp, or null', () => {
    expect(currentMicronsPerPixel({ getImageMeta: () => new BehaviorSubject([{ mppX: 0.25 } as any]) })).toBe(
      0.25,
    );
    expect(currentMicronsPerPixel({ getImageMeta: () => new BehaviorSubject([{} as any]) })).toBeNull();
  });
});
