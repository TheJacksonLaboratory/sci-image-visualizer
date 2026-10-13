import { TRANSCRIPT_GLYPHS, glyphOutline } from './glyphs';

describe('glyphs', () => {
  it('every glyph is a closed ring of at least three vertices within the unit disc (ish)', () => {
    for (const g of TRANSCRIPT_GLYPHS) {
      const o = glyphOutline(g);
      expect(o.length / 2).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < o.length; i += 2) {
        expect(Math.hypot(o[i], o[i + 1])).toBeLessThanOrEqual(1.2);
      }
    }
  });
});
