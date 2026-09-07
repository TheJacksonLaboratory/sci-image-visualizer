/**
 * Wheel-zoom step for the OpenSeadragon backend.
 *
 * Applied per scroll EVENT, not per unit of delta — which is what OpenSeadragon's own
 * `zoomPerScroll` does, and what the region overlay does when an active tool has taken the wheel
 * over. That makes the step compound with the number of events a device sends: a mouse notch is
 * one event, but a trackpad swipe is a burst of them, so a step that feels right for a mouse runs
 * away under a trackpad.
 *
 * At the previous 1.1 (OpenSeadragon's default is 1.2) an image doubled in 7 notches, against the
 * ~24 the napari-js backend took for the same picture — the same gesture zoomed several times
 * further depending only on which renderer was active. 1.03 puts the two within a whisker of each
 * other, so the wheel feels the same whichever backend is drawing.
 *
 * Shared because the viewer option and the overlay's handler MUST agree: whether the wheel is
 * handled by OpenSeadragon or by the overlay depends on whether a region tool is active, and the
 * zoom visibly changing pace when a tool is picked up is the bug this constant prevents.
 */
export const OSD_ZOOM_PER_SCROLL = 1.03;
