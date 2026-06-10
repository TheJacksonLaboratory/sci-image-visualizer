import { buildColormapLut } from './colormap-lut';

/**
 * CHARACTERIZATION TESTS (refactoring plan, Step 0).
 *
 * Pins the grayscale→RGB LUT builder that the OSD recolor pipeline (and the
 * composite export) depends on. Endpoints, midpoint interpolation, reversal,
 * named-scale lookup, and colour parsing must stay byte-stable — the displayed
 * pixels are a direct function of this table.
 */
describe('buildColormapLut (characterization)', () => {
  it('builds a 256-entry linear LUT for the Greys built-in', () => {
    const lut = buildColormapLut('Greys')!;
    expect(lut).toHaveLength(256);
    expect(lut[0]).toEqual([0, 0, 0]);
    expect(lut[255]).toEqual([255, 255, 255]);
    expect(lut[128]).toEqual([128, 128, 128]); // linear midpoint
  });

  it('reverse mirrors the scale (Plotly reversescale)', () => {
    const lut = buildColormapLut('Greys', true)!;
    expect(lut[0]).toEqual([255, 255, 255]);
    expect(lut[255]).toEqual([0, 0, 0]);
  });

  it('resolves two-stop named scales to their endpoints (Bluered)', () => {
    const lut = buildColormapLut('Bluered')!;
    expect(lut[0]).toEqual([0, 0, 255]);
    expect(lut[255]).toEqual([255, 0, 0]);
  });

  it('accepts inline [stop, color] arrays with hex colours (incl. #rgb shorthand)', () => {
    const lut = buildColormapLut([[0, '#000'], [1, '#ffffff']])!;
    expect(lut[0]).toEqual([0, 0, 0]);
    expect(lut[255]).toEqual([255, 255, 255]);
  });

  it('interpolates between unevenly spaced stops', () => {
    // 0→black until 0.5, then to white: value 128 sits just past the knee.
    const lut = buildColormapLut([[0, 'rgb(0,0,0)'], [0.5, 'rgb(0,0,0)'], [1, 'rgb(255,255,255)']])!;
    expect(lut[0]).toEqual([0, 0, 0]);
    expect(lut[127]).toEqual([0, 0, 0]); // t≈0.498, still in the flat segment
    expect(lut[255]).toEqual([255, 255, 255]);
    const mid = lut[191]; // t≈0.749 → ~halfway up the ramp
    expect(mid[0]).toBeGreaterThan(120);
    expect(mid[0]).toBeLessThan(135);
  });

  it('returns null for unknown names, non-scales, and degenerate input', () => {
    expect(buildColormapLut('NotAScale')).toBeNull();
    expect(buildColormapLut(null)).toBeNull();
    expect(buildColormapLut(undefined)).toBeNull();
    expect(buildColormapLut([[0, '#000']])).toBeNull(); // fewer than 2 stops
  });

  it('parses rgb() colours with whitespace', () => {
    const lut = buildColormapLut([[0, 'rgb( 10 , 20 , 30 )'], [1, 'rgb(40,50,60)']])!;
    expect(lut[0]).toEqual([10, 20, 30]);
    expect(lut[255]).toEqual([40, 50, 60]);
  });
});
