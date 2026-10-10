/**
 * Screen-space hit testing for a selected rectangle's move/resize zones, and the
 * resize those zones drive. Pure; shared by the SVG region overlays. (Vertex,
 * bezier-handle and edge hits on polygons live in `region-geometry.ts`:
 * `hitHandle` and `nearestEdge`.)
 */

/** Move/resize zones on the selected rectangle. */
export type EditZone = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The cursor that advertises each zone. */
export const ZONE_CURSOR: Readonly<Record<EditZone, string>> = {
  move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

/** Screen-pixel tolerance for grabbing an edge, corner or vertex handle. */
export const EDIT_TOL_PX = 8;

/** A screen-space box: left, top, right, bottom. */
export interface ScreenBox { x0: number; y0: number; x1: number; y1: number; }

/**
 * Classify a screen point against a screen-space rectangle: a corner, an edge
 * (within `tolPx`), the body, or null when outside (beyond the tolerance).
 */
export function rectZone(px: number, py: number, box: ScreenBox, tolPx = EDIT_TOL_PX): EditZone | null {
  const { x0, y0, x1, y1 } = box;
  const t = tolPx;
  if (px < x0 - t || px > x1 + t || py < y0 - t || py > y1 + t) return null;
  const left = Math.abs(px - x0) <= t, right = Math.abs(px - x1) <= t;
  const top = Math.abs(py - y0) <= t, bottom = Math.abs(py - y1) <= t;
  if (top && left) return 'nw';
  if (top && right) return 'ne';
  if (bottom && left) return 'sw';
  if (bottom && right) return 'se';
  if (left) return 'w';
  if (right) return 'e';
  if (top) return 'n';
  if (bottom) return 's';
  if (px > x0 && px < x1 && py > y0 && py < y1) return 'move';
  return null;
}

/** An image-space rectangle. */
export interface RectBox { x: number; y: number; width: number; height: number; }

/**
 * The rectangle `orig` moved or resized through `zone` by the total drag
 * (`dx`, `dy`), normalised (a drag past the opposite edge flips it) and rounded
 * to whole pixels. Absolute from the gesture-start box, so applying it on every
 * frame is idempotent.
 */
export function resizeRect(orig: RectBox, zone: EditZone, dx: number, dy: number): RectBox {
  let x0 = orig.x, y0 = orig.y, x1 = orig.x + orig.width, y1 = orig.y + orig.height;
  switch (zone) {
    case 'move': x0 += dx; x1 += dx; y0 += dy; y1 += dy; break;
    case 'w': x0 += dx; break;
    case 'e': x1 += dx; break;
    case 'n': y0 += dy; break;
    case 's': y1 += dy; break;
    case 'nw': x0 += dx; y0 += dy; break;
    case 'ne': x1 += dx; y0 += dy; break;
    case 'sw': x0 += dx; y1 += dy; break;
    case 'se': x1 += dx; y1 += dy; break;
  }
  return {
    x: Math.round(Math.min(x0, x1)),
    y: Math.round(Math.min(y0, y1)),
    width: Math.round(Math.abs(x1 - x0)),
    height: Math.round(Math.abs(y1 - y0)),
  };
}
