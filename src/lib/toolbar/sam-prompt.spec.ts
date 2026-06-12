import { frameToRgba, buildDecoderPrompt, binarizeMask, bestMaskIndex } from './sam-prompt';
import { CachedImageData } from './wand-tool.service';

describe('sam-prompt helpers', () => {
  describe('buildDecoderPrompt', () => {
    it('encodes a box as two points labelled 2 and 3, scaled', () => {
      const { pointCoords, pointLabels, numPoints } = buildDecoderPrompt(
        { box: { x0: 10, y0: 20, x1: 30, y1: 40 } }, 0.5,
      );
      expect(Array.from(pointCoords)).toEqual([5, 10, 15, 20]);
      expect(Array.from(pointLabels)).toEqual([2, 3]);
      expect(numPoints).toBe(2);
    });

    it('encodes positive/negative points and pads the absent box slot', () => {
      const { pointCoords, pointLabels } = buildDecoderPrompt(
        { points: [{ x: 10, y: 10, label: 1 }, { x: 4, y: 4, label: 0 }] }, 1,
      );
      // two points + a [0,0] pad point labelled -1
      expect(Array.from(pointCoords)).toEqual([10, 10, 4, 4, 0, 0]);
      expect(Array.from(pointLabels)).toEqual([1, 0, -1]);
    });

    it('combines points then box (no pad point when a box is present)', () => {
      const { pointLabels } = buildDecoderPrompt(
        { points: [{ x: 1, y: 1, label: 1 }], box: { x0: 0, y0: 0, x1: 9, y1: 9 } }, 1,
      );
      expect(Array.from(pointLabels)).toEqual([1, 2, 3]);
    });
  });

  it('binarizeMask thresholds logits at > 0 by default', () => {
    expect(Array.from(binarizeMask([-1, 0, 0.5, 2]))).toEqual([0, 0, 1, 1]);
  });

  it('bestMaskIndex returns the argmax IoU', () => {
    expect(bestMaskIndex([0.1, 0.9, 0.3])).toBe(1);
    expect(bestMaskIndex([0.5])).toBe(0);
  });

  describe('frameToRgba', () => {
    function cached(frames: any[], isGrayscale: boolean, w: number, h: number): CachedImageData {
      return { frames, width: w, height: h, ratios: [1], isGrayscale, originX: 0, originY: 0 };
    }

    it('replicates grayscale across RGB with opaque alpha', () => {
      const rgba = frameToRgba(cached([[[100, 200]]], true, 2, 1), 0);
      expect(Array.from(rgba)).toEqual([100, 100, 100, 255, 200, 200, 200, 255]);
    });

    it('copies RGB tuples through', () => {
      const rgba = frameToRgba(cached([[[[10, 20, 30]]]], false, 1, 1), 0);
      expect(Array.from(rgba)).toEqual([10, 20, 30, 255]);
    });
  });
});
