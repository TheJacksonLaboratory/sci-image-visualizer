/**
 * Region *rendering* abstraction — distinct from `IRegionStore` (which owns the
 * region data/state, shared across backends). An `IRegionOverlay` draws the
 * store's regions on a specific backend's canvas and handles draw/select
 * interaction:
 *
 *  - `PlotlyRegionOverlay` — Plotly renders regions natively as plot shapes and
 *    edits them via its own drag modes, so its adapter is thin (maps the mode
 *    onto Plotly drag modes; redraw is a no-op).
 *  - `OsdRegionOverlay` — OpenSeadragon shows pre-rendered tiles, so regions are
 *    drawn on an SVG layer kept aligned to the viewport, with custom draw/select.
 *
 * Both read the same `IRegionStore`, so regions stay in sync regardless of which
 * backend is rendering the image.
 */
/**
 * Region interaction modes.
 *
 *  - `none`          — display only; backend navigation (OSD pan/zoom) is live.
 *  - `select`        — click to select; on OSD also drag a vertex / resize a
 *                      rectangle / move the region body.
 *  - `drawrect`      — press-drag-release a rectangle.
 *  - `drawclosedpath`— freehand closed polygon (press-drag-release).
 *  - `drawopenpath`  — freehand open polyline (press-drag-release).
 *
 * Vertex-editing tools (OSD only; Plotly maps them to no-op):
 *  - `drawpolygon`   — click to place each vertex; click the first vertex (or
 *                      double-click) to close.
 *  - `addpoint`      — click an edge of the selected polygon to insert a vertex.
 *  - `deletepoint`   — click a vertex of the selected polygon to remove it.
 *  - `move`          — drag the selected region body to translate it.
 */
export type RegionToolMode =
  | 'none'
  | 'select'
  | 'drawrect'
  | 'drawclosedpath'
  | 'drawopenpath'
  | 'drawpolygon'
  | 'addpoint'
  | 'deletepoint'
  | 'move';

export interface IRegionOverlay {
  /** Set the active draw/select interaction (or 'none' to just display). */
  setMode(mode: RegionToolMode): void;
  /** Re-render the regions (e.g. after the store changes or the view moves). */
  redraw(): void;
  /**
   * Convert the selected region(s) to/from a bezier curve (toBezier /
   * toPolygon). A one-shot action, not a mode. No-op on backends
   * that don't render beziers (Plotly).
   */
  setSelectedBezier(bezier: boolean): void;
  /** Detach handlers/DOM and stop listening to the store. */
  destroy(): void;
}
