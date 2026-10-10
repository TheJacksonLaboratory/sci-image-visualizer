import { TRANSCRIPT_GLYPHS, glyphOutline, glyphRings } from './glyphs';

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

  it('expands entries into scaled, translated rings', () => {
    const tri = glyphOutline('triangle');
    const { coords, offsets } = glyphRings(
      Float32Array.from([10, 20]),
      Float32Array.from([0, 5]),
      Float32Array.from([1, 2]),
      () => tri,
    );
    expect(Array.from(offsets)).toEqual([0, 3, 6]);
    expect(coords[0]).toBeCloseTo(10 + tri[0], 6);
    expect(coords[7]).toBeCloseTo(5 + tri[1] * 2, 6);
  });
});
