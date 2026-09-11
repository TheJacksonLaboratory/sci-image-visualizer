import { SPATIAL_FIT_MARGIN, framePositions } from './spatial-framing';

/**
 * Fitting a scatter to its own coordinates.
 *
 * The case this exists for, with real numbers: seqFISH's coordinates span about 5 x 7 units, and
 * left with a previous 512 x 383 image's framing the whole dataset drew at 9.7 x 13.4 PIXELS,
 * centred 256px from where the camera was pointing. Every point present and drawn, and invisible.
 */
describe('framePositions', () => {
  const pts = (...xy: number[]) => Float32Array.from(xy);

  it('centres on the middle of the extent, not on the origin', () => {
    // An extent that does not straddle 0: centring on the origin would put it offscreen.
    const fit = framePositions(pts(10, 20, 30, 60), 800, 600)!;
    expect(fit.center).toEqual([20, 40]);
  });

  it('zooms so the extent fills the tighter axis, with a margin', () => {
    // 20 wide by 40 tall into 800x600: height is the binding axis (600/40 < 800/20).
    const fit = framePositions(pts(10, 20, 30, 60), 800, 600)!;
    expect(fit.zoom).toBeCloseTo(SPATIAL_FIT_MARGIN * (600 / 40), 6);
  });

  it('fills a usable fraction of the viewport — the actual bug', () => {
    // seqFISH's real extent and a real canvas. Before the fix this drew at 10x13px.
    const fit = framePositions(pts(-2.5, -3.5, 2.57, 3.48), 1309, 772)!;
    const onScreenH = (3.48 - -3.5) * fit.zoom!;
    expect(onScreenH).toBeGreaterThan(700);
    expect(onScreenH).toBeLessThanOrEqual(772);
  });

  it('keeps the extent inside the viewport on both axes', () => {
    const fit = framePositions(pts(0, 0, 100, 10), 400, 400)!;
    expect(100 * fit.zoom!).toBeLessThanOrEqual(400);
    expect(10 * fit.zoom!).toBeLessThanOrEqual(400);
  });

  it('ignores a point whose coordinates are not both finite', () => {
    // A wholly-NaN point is harmless by accident: every comparison against NaN is
    // false, so it never widens the extent. A HALF-valid point is the case that needs
    // the check — x=1000 with a NaN y would otherwise stretch the extent to 1000 for a
    // point that cannot be drawn at all, and squash everything else to a speck.
    const halfValid = framePositions(pts(1000, NaN, 10, 20, 30, 60), 800, 600)!;
    expect(halfValid.center).toEqual([20, 40]);

    const allNaN = framePositions(pts(NaN, NaN, 10, 20, 30, 60), 800, 600)!;
    expect(allNaN.center).toEqual([20, 40]);
    expect(Number.isFinite(allNaN.zoom!)).toBe(true);
  });

  it('recentres but keeps the zoom for a degenerate extent', () => {
    // A single point, or a perfect line, has no span to divide by. Returning a zoom
    // would mean dividing by zero — an infinite zoom that blanks the view.
    const one = framePositions(pts(5, 7), 800, 600)!;
    expect(one.center).toEqual([5, 7]);
    expect(one.zoom).toBeNull();

    const line = framePositions(pts(0, 3, 10, 3), 800, 600)!;
    expect(line.center).toEqual([5, 3]);
    expect(line.zoom).toBeNull();
  });

  it('returns null when there is nothing to frame', () => {
    // Null means LEAVE THE CAMERA ALONE. A default would move the view for a dataset
    // that cannot be framed, which is worse than not moving it.
    expect(framePositions(pts(), 800, 600)).toBeNull();
    expect(framePositions(pts(1, 2), 0, 600)).toBeNull();
    expect(framePositions(pts(1, 2), 800, 0)).toBeNull();
    expect(framePositions(pts(NaN, NaN), 800, 600)).toBeNull();
  });

  it('honours a caller’s margin', () => {
    const tight = framePositions(pts(0, 0, 10, 10), 500, 500, 1)!;
    expect(tight.zoom).toBeCloseTo(50, 6);
  });
});
