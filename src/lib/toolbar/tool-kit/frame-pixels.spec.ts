import { framePixels, isPackedFrame, packedFrame, PackedFrame } from './frame-pixels';
import { WandImage, WandService } from '../wand/wand.service';
import type { CachedImageData } from '../wand/wand-tool.service';
import { frameToRgba } from '../segmentation/sam-prompt';
import { cropImageRegion } from '../crop/slide-crop';

/** A W×H RGB test image: a bright disc on a textured background. */
const W = 40;
const H = 30;
function rgbAt(x: number, y: number): [number, number, number] {
  const inDisc = (x - 18) ** 2 + (y - 14) ** 2 < 64;
  return inDisc ? [220, 200 + ((x * 3) % 20), 180] : [(x * 7 + y * 3) % 40, (x * 5) % 30, (y * 11) % 50];
}

function nestedRgb(): number[][][] {
  return Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => rgbAt(x, y)));
}

function packedRgba(): PackedFrame {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgbAt(x, y);
      data.set([r, g, b, 255], (y * W + x) * 4);
    }
  }
  return packedFrame(data, W, H);
}

function cached(frame: CachedImageData['frames'][number]): CachedImageData {
  return { frames: [frame], width: W, height: H, ratios: [2, 3], isGrayscale: false, originX: 10, originY: 20 };
}

describe('framePixels', () => {
  it('tells the packed form from the nested ones', () => {
    expect(isPackedFrame(packedRgba())).toBe(true);
    expect(isPackedFrame(nestedRgb())).toBe(false);
    expect(isPackedFrame([[1, 2]])).toBe(false);
    expect(isPackedFrame(undefined)).toBe(false);
  });

  it('reads the same RGB from a nested and a packed frame', () => {
    const nested = framePixels(nestedRgb(), false);
    const packed = framePixels(packedRgba(), false);
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        expect(nested.rgb(x, y, a)).toBe(true);
        expect(packed.rgb(x, y, b)).toBe(true);
        expect(b).toEqual(a);
      }
    }
  });

  it('reports pixels outside the frame as missing and leaves out untouched', () => {
    const out = [7, 7, 7];
    for (const px of [framePixels(nestedRgb(), false), framePixels(packedRgba(), false)]) {
      expect(px.rgb(-1, 0, out)).toBe(false);
      expect(px.rgb(W, 0, out)).toBe(false);
      expect(px.rgb(0, H, out)).toBe(false);
    }
    expect(out).toEqual([7, 7, 7]);
  });

  it('replicates an unclamped grayscale value', () => {
    const out = [0, 0, 0];
    expect(framePixels([[0, 1000]], true).rgb(1, 0, out)).toBe(true);
    expect(out).toEqual([1000, 1000, 1000]);
  });

  it('writes a row as opaque RGBA, black where the window leaves the frame', () => {
    for (const frame of [nestedRgb(), packedRgba()]) {
      const dst = new Uint8ClampedArray(3 * 4);
      framePixels(frame, false).rgbaRow(5, W - 2, 3, dst, 0);
      expect(Array.from(dst)).toEqual([...rgbAt(W - 2, 5), 255, ...rgbAt(W - 1, 5), 255, 0, 0, 0, 255]);
    }
  });
});

describe('nested and packed frames are equivalent for every pixel tool', () => {
  const wand = new WandService();
  const image = (data: WandImage['data']): WandImage => ({ data, width: W, height: H, isGrayscale: false });

  it('wand: the same patch mask and region, RGB and GRAY sampling', () => {
    for (const type of ['RGB', 'GRAY'] as const) {
      const opts = { patchSize: 21, type };
      const a = wand.computePatchMask(image(nestedRgb()), 18, 14, opts);
      const b = wand.computePatchMask(image(packedRgba()), 18, 14, opts);
      expect(a).not.toBeNull();
      expect(Array.from(b!.mask)).toEqual(Array.from(a!.mask));
      const region = wand.computeRegion(image(nestedRgb()), 18, 14, opts);
      expect(region).not.toBeNull();
      expect(wand.computeRegion(image(packedRgba()), 18, 14, opts)).toEqual(region);
    }
  });

  it('wand: the same patch where it overhangs the frame edge', () => {
    const opts = { patchSize: 21, simpleMode: true };
    const a = wand.computePatchMask(image(nestedRgb()), 1, 1, opts);
    const b = wand.computePatchMask(image(packedRgba()), 1, 1, opts);
    expect(Array.from(b!.mask)).toEqual(Array.from(a!.mask));
  });

  it('SAM: the same encoder RGBA', () => {
    expect(Array.from(frameToRgba(cached(packedRgba()), 0))).toEqual(
      Array.from(frameToRgba(cached(nestedRgb()), 0)),
    );
  });

  it('Cellpose crop: the same crop and origin', () => {
    const box = { x0: 20, y0: 30, x1: 60, y1: 80 };
    const a = cropImageRegion(cached(nestedRgb()), 0, box)!;
    const b = cropImageRegion(cached(packedRgba()), 0, box)!;
    expect(a.width).toBeGreaterThan(0);
    expect({ ...b, data: Array.from(b.data) }).toEqual({ ...a, data: Array.from(a.data) });
  });
});
