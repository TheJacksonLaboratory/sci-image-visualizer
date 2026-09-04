import { OSD_ZOOM_PER_SCROLL } from '../osd/osd-zoom';

/**
 * Wheel-zoom sensitivity for the napari-js backend, as `exp(-delta * speed)` per normalized,
 * clamped wheel-delta unit.
 *
 * Derived from {@link OSD_ZOOM_PER_SCROLL} rather than written as its own number: the two backends
 * draw the same images, and a wheel that zooms further under one renderer than the other is a
 * difference the user has no way to explain. napari-js clamps a single event's delta to 24 px
 * (mouse notches and trackpad momentum ticks both land on the clamp), so matching the per-notch
 * step means solving `exp(24 * speed) = OSD_ZOOM_PER_SCROLL`.
 */
export const NAPARI_WHEEL_DELTA_CLAMP = 24;

export const NAPARI_WHEEL_ZOOM_SPEED =
  Math.log(OSD_ZOOM_PER_SCROLL) / NAPARI_WHEEL_DELTA_CLAMP;
