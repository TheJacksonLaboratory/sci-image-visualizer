/**
 * Keys for the toast outlets the library renders for itself.
 *
 * PrimeNG delivers a message to a `<p-toast>` only when the keys match — a
 * keyless message reaches a keyless toast and nothing else. The library used to
 * emit its notices with no key, or with jit-ui's own keys (`app-toast`,
 * `center-toast`), which meant its user-facing feedback silently depended on the
 * host mounting the right markup. In jit-ui it did; in every other host —
 * including this repo's browser example — errors and results went nowhere, so a
 * failed or no-op action looked like a dead button.
 *
 * These keys are owned by the library and their outlets are rendered by
 * {@link VisualizerComponent}, so the feedback works in any host. A host that
 * wants these notices somewhere else should not render an outlet with the same
 * key — two matching outlets show the message twice.
 */

/** General notices: save results, validation, action outcomes. Default position. */
export const VIZ_TOAST_KEY = 'sci-viz-notice';

/**
 * Failures that must interrupt: rendering/tile errors that leave the viewer in a
 * bad state. Centered and sticky, matching how these were surfaced before.
 */
export const VIZ_ALERT_TOAST_KEY = 'sci-viz-alert';
