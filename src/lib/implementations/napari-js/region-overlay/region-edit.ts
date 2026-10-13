import { Rectangle } from '../../../models/region';
import type { HandleHit } from '../../../region-overlay/region-geometry';
import type { RegionStore } from '../../../store/region-store.service';

/**
 * A live drag of the select/move tools: the region's body, or one of its handles as the
 * shared `hitHandle` names it (a rectangle corner with its fixed opposite `anchor`, or a
 * vertex / bézier control point on `ring` -1 for the exterior, else a hole).
 */
export type RegionEdit = { id: number; last: [number, number] } & ({ kind: 'body' } | HandleHit);

/** Apply the drag of `edit` to the pointer at world point `(x, y)`, through the store's edit ops. */
export function applyRegionEdit(store: RegionStore, edit: RegionEdit, x: number, y: number): void {
  switch (edit.kind) {
    case 'body': {
      const [lx, ly] = edit.last;
      store.moveRegion(edit.id, x - lx, y - ly);
      edit.last = [x, y];
      return;
    }
    case 'corner': {
      const [ax, ay] = edit.anchor;
      const rect = new Rectangle();
      rect.x = Math.min(ax, x);
      rect.y = Math.min(ay, y);
      rect.width = Math.abs(x - ax);
      rect.height = Math.abs(y - ay);
      store.updateBounds(edit.id, rect);
      return;
    }
    case 'vertex':
      if (edit.ring < 0) store.moveVertex(edit.id, edit.index, x, y);
      else store.moveHoleVertex(edit.id, edit.ring, edit.index, x, y);
      return;
    case 'bezier':
      if (edit.ring < 0) store.moveBezierHandle(edit.id, edit.index, edit.side, x, y);
      else store.moveHoleBezierHandle(edit.id, edit.ring, edit.index, edit.side, x, y);
      return;
  }
}
