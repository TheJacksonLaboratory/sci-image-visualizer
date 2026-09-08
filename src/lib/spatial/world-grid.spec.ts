import {
  PIXEL_WORLD_QUANTUM, WORLD_GRID_STEPS, snapToWorldGrid, worldQuantumForExtent,
} from './world-grid';

describe('worldQuantumForExtent', () => {
  it('never goes finer than a whole unit for a large world', () => {
    // A non-pixel world can still be huge — the Allen atlas spans ~11,000 microns — and
    // there a sub-unit step buys nothing. An IMAGE never reaches this function at all:
    // its caller keeps the pixel grid by not asking, because the extent cannot tell a
    // 2,000-pixel slide from a 2,000-micron section.
    expect(worldQuantumForExtent(11000, 11000)).toBe(PIXEL_WORLD_QUANTUM);
    expect(worldQuantumForExtent(46000, 32914)).toBe(PIXEL_WORLD_QUANTUM);
  });

  it('goes finer than a pixel for a world only a few units across', () => {
    // seqFISH: 5.07 x 6.98 units for the WHOLE sample. On the pixel grid that is about
    // six by eight placeable positions, which is why an ROI could not be drawn.
    const q = worldQuantumForExtent(5.0697, 6.9842);
    expect(q).toBeLessThan(PIXEL_WORLD_QUANTUM);
    expect(6.9842 / q).toBeGreaterThan(1000);
  });

  it('is driven by the LARGER span, so the narrow axis is not starved', () => {
    // A tall thin sample must not get a step chosen from its width.
    expect(worldQuantumForExtent(0.5, 900)).toBe(worldQuantumForExtent(900, 0.5));
  });

  it('gives at least the asked-for number of steps across the extent', () => {
    for (const span of [2, 5.07, 40, 999]) {
      expect(span / worldQuantumForExtent(span, span))
        .toBeGreaterThanOrEqual(WORLD_GRID_STEPS);
    }
  });

  it('is a power of ten, so stored geometry reads cleanly', () => {
    const q = worldQuantumForExtent(6.9842, 6.9842);
    const exponent = Math.log10(q);
    expect(Number.isInteger(exponent)).toBe(true);
  });

  it('falls back to the pixel grid for an extent it cannot use', () => {
    // An unknown world gets the established answer, not an invented precision.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(worldQuantumForExtent(bad, bad)).toBe(PIXEL_WORLD_QUANTUM);
    }
  });
});

describe('snapToWorldGrid', () => {
  it('rounds to whole units on the pixel grid', () => {
    expect(snapToWorldGrid(12.4, PIXEL_WORLD_QUANTUM)).toBe(12);
    expect(snapToWorldGrid(12.6, PIXEL_WORLD_QUANTUM)).toBe(13);
    expect(snapToWorldGrid(-0.4, PIXEL_WORLD_QUANTUM)).toBe(-0);
  });

  it('rounds to the step on a finer grid', () => {
    expect(snapToWorldGrid(1.23456, 0.001)).toBe(1.235);
    expect(snapToWorldGrid(-2.54941, 0.001)).toBe(-2.549);
  });

  it('leaves no float dust behind', () => {
    // 0.001 * 3 is not exactly 0.003 in binary floating point, and geometry that was
    // supposed to be tidied would come back with a trail of digits.
    const snapped = snapToWorldGrid(0.0030000000000000005, 0.001);
    expect(String(snapped)).toBe('0.003');
  });

  it('does not snap at all when the step is zero or negative', () => {
    expect(snapToWorldGrid(1.23456, 0)).toBe(1.23456);
    expect(snapToWorldGrid(1.23456, -1)).toBe(1.23456);
  });

  it('passes a non-finite coordinate through rather than turning it into a number', () => {
    // NaN reaching the store as 0 would place a vertex at the origin, which is worse
    // than a shape the caller can see is broken.
    expect(snapToWorldGrid(NaN, 0.001)).toBeNaN();
  });

  it('keeps seqFISH-scale coordinates distinguishable', () => {
    // The reported bug, as an assertion: two nearby cells must not collapse onto one
    // vertex. On the pixel grid both of these snap to -2.
    const q = worldQuantumForExtent(5.0697, 6.9842);
    expect(snapToWorldGrid(-2.5494, q)).not.toBe(snapToWorldGrid(-2.5203, q));
    expect(snapToWorldGrid(-2.5494, PIXEL_WORLD_QUANTUM))
      .toBe(snapToWorldGrid(-2.5203, PIXEL_WORLD_QUANTUM));
  });
});
