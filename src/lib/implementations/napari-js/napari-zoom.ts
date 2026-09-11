import { WHEEL_DELTA_CLAMP } from 'napari-js';

import { OSD_ZOOM_PER_SCROLL } from '../osd/osd-zoom';

/**
 * Wheel-zoom sensitivity for the napari-js backend, as `exp(-delta * speed)` per normalized,
 * clamped wheel-delta unit.
 *
 * Derived from {@link OSD_ZOOM_PER_SCROLL} rather than written as its own number: the two backends
 * draw the same images, and a wheel that zooms further under one renderer than the other is a
 * difference the user has no way to explain.
 *
 * napari-js clamps a single event's delta before applying the speed — mouse notches and trackpad
 * momentum ticks both exceed the clamp, so the clamped step IS the per-notch step — which makes
 * matching the two a matter of solving `exp(WHEEL_DELTA_CLAMP * speed) = OSD_ZOOM_PER_SCROLL`.
 * The clamp is imported rather than copied: it belongs to napari-js, and a local literal would go
 * silently stale the day that library retuned it.
 */
export const NAPARI_WHEEL_ZOOM_SPEED = Math.log(OSD_ZOOM_PER_SCROLL) / WHEEL_DELTA_CLAMP;
