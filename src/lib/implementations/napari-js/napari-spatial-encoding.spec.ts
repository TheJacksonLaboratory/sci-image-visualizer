import { pointSymbolCode } from 'napari-js';

import { NO_CATEGORY } from '../../contracts/spatial-dataset.contract';
import { gatherSymbols, glyphSymbols } from './napari-spatial-2d-scene';
import { hideUnshown } from './napari-spatial-encoding';
import { GLYPH_SYMBOLS } from './spatial-tiles/transcript-layers';

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

describe('observation icons by gene', () => {
  it("draws each observation as its gene's icon, and a disc where it has none", () => {
    const codes = Uint16Array.of(0, 1, NO_CATEGORY);
    const symbols = glyphSymbols(codes, ['star', 'square']);
    expect(Array.from(symbols)).toEqual([
      pointSymbolCode(GLYPH_SYMBOLS.star),
      pointSymbolCode(GLYPH_SYMBOLS.square),
      pointSymbolCode('disc'),
    ]);
  });

  it('takes the drawn subset, and nothing to take when there are no icons', () => {
    expect(Array.from(gatherSymbols(Uint8Array.of(5, 6, 7), Uint32Array.of(2, 0))!)).toEqual([7, 5]);
    expect(gatherSymbols(null, Uint32Array.of(0))).toBeNull();
  });
});
