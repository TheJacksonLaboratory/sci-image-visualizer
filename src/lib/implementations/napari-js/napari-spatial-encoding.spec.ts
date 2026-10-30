import { hideUnshown } from './napari-spatial-encoding';

describe('hideUnshown', () => {
  it('makes the observations left out transparent, keeping the others', () => {
    const colors = Float32Array.of(1, 0, 0, 1, 0, 1, 0, 0.5);
    const out = hideUnshown(colors, Uint8Array.of(0, 1));
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 0, 1, 0, 0.5]);
    expect(colors[3]).toBe(1); // the input, which may be held elsewhere, is left alone
  });

  it('spreads a broadcast colour to every observation first', () => {
    const out = hideUnshown([0.2, 0.4, 0.6, 0.9], Uint8Array.of(1, 0, 1));
    expect(Array.from(out)).toEqual([0.2, 0.4, 0.6, 0.9, 0.2, 0.4, 0.6, 0, 0.2, 0.4, 0.6, 0.9].map(Math.fround));
  });
});
