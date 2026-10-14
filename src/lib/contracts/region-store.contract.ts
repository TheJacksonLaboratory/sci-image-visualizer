import { Rectangle, Polygon, MultiPolygon } from '../models/region';
import { Region } from '../models/region';
import type { Observable } from 'rxjs';
import type { RegionSourceView } from '../region-source/region-source';
import type { RegionStyle } from '../region-overlay/region-style';

/**
 * Region-native editing surface — typed geometry operations on the neutral
 * {@link Region} model. The OpenSeadragon overlay (and any future editing UI)
 * mutates regions through these calls instead of reaching into a backend's
 * own shape representation (e.g. Plotly's `x0/y0/x1/y1` / `M…L…Z` dicts).
 *
 * Implemented by the shared `RegionStore`, which owns region *state*; backends
 * own *rendering* and react to the store's update event. This replaces the
 * Plotly-shaped `IRegionEditStore` (getShapes/applyShapesChange) the OSD
 * overlay used to depend on.
 *
 * Coordinates are always **image pixels**. Vertex operations apply to polygon
 * regions only; calling them on a rectangle (or with an out-of-range id/index)
 * is a no-op.
 */
export interface IRegionEditApi {
  /** Add a region to the current image, mint its id, select it, and emit.
   *  Returns the assigned id. */
  addRegion(region: Region): number;

  /** Remove the region with this id (and drop it from the selection). */
  removeRegion(id: number): void;

  /** Replace a region's geometry wholesale (e.g. after a rectangle resize). */
  updateBounds(id: number, bounds: Rectangle | Polygon | MultiPolygon): void;

  /** Translate the whole region by (dx, dy) image pixels. */
  moveRegion(id: number, dx: number, dy: number): void;

  /** Move a single polygon vertex to (x, y). No-op for rectangles. */
  moveVertex(id: number, index: number, x: number, y: number): void;

  /** Move a single vertex on interior ring `holeIndex` (a hole) to (x, y).
   *  No-op for rectangles, or an out-of-range hole/vertex index (jit-ui#85). */
  moveHoleVertex(id: number, holeIndex: number, index: number, x: number, y: number): void;

  /** Insert a vertex on interior ring `holeIndex` after `segIndex` (jit-ui#85). */
  addHoleVertex(id: number, holeIndex: number, segIndex: number, x: number, y: number): void;

  /** Delete the vertex at `index` on interior ring `holeIndex`; dropping the
   *  ring below 3 vertices removes the whole hole (jit-ui#85). */
  deleteHoleVertex(id: number, holeIndex: number, index: number): void;

  /** Insert a vertex at (x, y) immediately after `segIndex` (the start vertex
   *  of the edge the point lies on). No-op for rectangles. */
  addVertex(id: number, segIndex: number, x: number, y: number): void;

  /** Delete the vertex at `index`. No-op for rectangles, or when removing it
   *  would drop the polygon below its minimum (3 closed / 2 open). */
  deleteVertex(id: number, index: number): void;

  /**
   * Toggle the bezier-curve flag on a region (toBezier = `true`,
   * toPolygon = `false`). The vertices stay put — only the smooth-curve
   * rendering/export is added or removed. A rectangle is first converted to a
   * 4-anchor closed polygon when smoothing; turning bezier off on a rectangle
   * is a no-op.
   */
  setBezier(id: number, bezier: boolean): void;

  /**
   * Move one of a bezier vertex's two cubic control handles to absolute point
   * (x, y). `side` is the in- or out-handle. No-op unless the region is a bezier
   * polygon. The handle is stored relative to its anchor, so it follows the
   * anchor when the vertex is moved.
   */
  moveBezierHandle(id: number, index: number, side: 'in' | 'out', x: number, y: number): void;

  /**
   * Move a bezier control handle on an interior ring (donut hole) — like
   * {@link moveBezierHandle} but for `holes[holeIndex]`. No-op unless the region is a bezier
   * polygon with hole handles (jit-ui#102).
   */
  moveHoleBezierHandle(
    id: number,
    holeIndex: number,
    index: number,
    side: 'in' | 'out',
    x: number,
    y: number,
  ): void;

  /**
   * Coalesce the emits from a burst of edits (e.g. a live vertex drag) into a
   * single update on `endBatch`. Calls nest; the update fires when the
   * outermost batch closes. The overlay still redraws itself per frame — this
   * only throttles the store's `regionUpdate$` so downstream consumers (the
   * Region Editor table) update once per gesture, not once per pointer move.
   */
  beginBatch(): void;
  endBatch(): void;
}

/**
 * The region-source side of the store, as the overlays use it: a large region set held as a
 * tiled source (see `RegionStore.attachRegionSource`) that the overlays draw at the zoom's level
 * of detail and pick from. Optional on the overlays' store: a store without it simply has no
 * source to draw.
 */
export interface IRegionSourceApi {
  /** The current slice's source as a layer draws it, and every change of it; null without one. */
  getRegionSourceView$(): Observable<RegionSourceView | null>;
  /** Take source features into the working set as regions and select them (added to the
   *  selection with `additive`). Resolves the region ids. */
  selectSourceFeatures(ids: readonly string[], additive?: boolean): Promise<number[]>;
  /** The region look (outlines, or filled with inside labels). */
  getRegionStyle(): RegionStyle;
  /** Whether a class's label is left out because a subclass of it is drawn too. */
  isLabelCovered(label: string | undefined): boolean;
}
