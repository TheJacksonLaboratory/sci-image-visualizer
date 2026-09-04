import { NAPARI_WHEEL_DELTA_CLAMP, NAPARI_WHEEL_ZOOM_SPEED } from './napari-zoom';
import { OSD_ZOOM_PER_SCROLL } from '../osd/osd-zoom';

/**
 * The two backends draw the same images, so the wheel must not zoom further under
 * one than the other — a difference the user has no way to attribute to anything.
 * The napari speed is therefore DERIVED from the OSD step, and this pins that the
 * derivation actually lands on it.
 */
describe('the napari wheel-zoom speed', () => {
  /** What napari-js does with one clamped event: exp(-delta * speed). */
  const stepAtClamp = () => Math.exp(NAPARI_WHEEL_DELTA_CLAMP * NAPARI_WHEEL_ZOOM_SPEED);

  it('gives the same per-notch step as the OSD backend', () => {
    // A mouse notch (~100px) and a trackpad momentum tick (several hundred) both
    // exceed the clamp, so the clamped step IS the per-notch step on both.
    expect(stepAtClamp()).toBeCloseTo(OSD_ZOOM_PER_SCROLL, 10);
  });

  it('is gentle: a notch is a few percent, not a fifth', () => {
    const percent = (stepAtClamp() - 1) * 100;
    expect(percent).toBeGreaterThan(1);
    expect(percent).toBeLessThan(5);
  });

  it('zooms in rather than out — the sign convention napari-js applies', () => {
    // napari-js negates the delta, so a POSITIVE speed with a negative delta
    // (scroll up) must magnify. A sign slip here inverts the wheel.
    expect(NAPARI_WHEEL_ZOOM_SPEED).toBeGreaterThan(0);
    expect(Math.exp(-(-NAPARI_WHEEL_DELTA_CLAMP) * NAPARI_WHEEL_ZOOM_SPEED)).toBeGreaterThan(1);
  });

  it('matches the clamp napari-js actually applies', () => {
    // If napari-js changes its internal clamp, the derivation stops landing on the
    // OSD step and this constant has to be revisited. 24 is WHEEL_DELTA_CLAMP in
    // napari-js's camera/wheel module.
    expect(NAPARI_WHEEL_DELTA_CLAMP).toBe(24);
  });
});
