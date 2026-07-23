/**
 * Which groups of controls the visualization toolbar shows. All default to `true`
 * (the full toolbar); a consumer embedding `<visualizer>` can hide groups
 * it doesn't want via the `toolbarTools` input — e.g. the processing pipeline shows
 * only the zoom and region tools.
 *
 * Groups not listed here (stack navigation, 3D-scene controls, isosurface band) are
 * already shown only when the image/plot type calls for them, so a single 8-bit
 * image never surfaces them regardless of these flags.
 */
export interface ToolbarToolVisibility {
  /** Plot-type selector, intensity-profile line, Channels & Histogram, download,
   *  and fit-to-view (autoscale) — everything that isn't a zoom or region tool. */
  specialTools?: boolean;
  /** Zoom drag, zoom box, pan, zoom in, zoom out. */
  zoomTools?: boolean;
  /** Region drawing/editing: select, rectangle, polyline, freeform, polygon vertex
   *  editing, wand, vertex eraser, delete, Bézier/polygon conversion. */
  regionTools?: boolean;
  /** The Help button and its dialog. */
  help?: boolean;
}

/** Full toolbar — the default when no `toolbarTools` is supplied. */
export const ALL_TOOLBAR_TOOLS: Required<ToolbarToolVisibility> = {
  specialTools: true,
  zoomTools: true,
  regionTools: true,
  help: true,
};
