import { TestBed } from '@angular/core/testing';

import { RegionStore } from './region-store.service';
import { VisualizerStore } from './visualizer-store.service';
import { Region, Rectangle, Polygon } from '../models/region';
import { IImageInfo } from '../contracts/image.contract';

function rectRegion(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const rect = new Rectangle();
  rect.x = x; rect.y = y; rect.width = w; rect.height = h;
  r.bounds = rect;
  return r;
}

function polyRegion(xs: number[], ys: number[], closed = true): Region {
  const r = new Region();
  const p = new Polygon();
  p.npoints = xs.length;
  p.xpoints = xs.slice();
  p.ypoints = ys.slice();
  p.coordinates = xs.map((x, i) => [x, ys[i]]);
  p.closed = closed;
  r.bounds = p;
  return r;
}

function imageInfo(url: string): IImageInfo {
  const info = ({} as IImageInfo);
  info.urls = [url];
  return info;
}

describe('RegionStore', () => {
  let store: RegionStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [RegionStore, VisualizerStore] });
    store = TestBed.inject(RegionStore);
  });

  describe('addRegion', () => {
    it('mints an id, selects the new region, and emits the full list', () => {
      const emitted: Region[][] = [];
      const selected: number[][] = [];
      store.getRegionUpdateEvent().subscribe(rs => emitted.push(rs as Region[]));
      store.getSelectedShapeIndices$().subscribe(s => selected.push(s));

      const id = store.addRegion(rectRegion(0, 0, 10, 10));

      expect(id).toBeGreaterThan(0);
      expect(store.getRegions().length).toBe(1);
      expect(emitted[emitted.length - 1].length).toBe(1);
      expect(selected[selected.length - 1]).toEqual([0]);
    });

    it('assigns distinct ids across calls', () => {
      const a = store.addRegion(rectRegion(0, 0, 1, 1));
      const b = store.addRegion(rectRegion(2, 2, 1, 1));
      expect(a).not.toBe(b);
    });
  });

  describe('setRegions', () => {
    it('replaces the current regions', () => {
      store.setRegions([rectRegion(0, 0, 1, 1), rectRegion(2, 2, 1, 1)]);
      expect(store.getRegions().length).toBe(2);
      store.setRegions([rectRegion(5, 5, 1, 1)]);
      expect(store.getRegions().length).toBe(1);
    });

    it('append de-dupes by identical geometry', () => {
      store.setRegions([rectRegion(0, 0, 10, 10)]);
      store.setRegions([rectRegion(0, 0, 10, 10)], undefined, undefined, undefined, true);
      expect(store.getRegions().length).toBe(1);
      store.setRegions([rectRegion(3, 3, 10, 10)], undefined, undefined, undefined, true);
      expect(store.getRegions().length).toBe(2);
    });

    it('does not store transient regions when isRegionSaveOn is false', () => {
      const emitted: Region[][] = [];
      store.getRegionUpdateEvent().subscribe(rs => emitted.push(rs as Region[]));
      store.setRegions([rectRegion(0, 0, 1, 1)], undefined, false);
      expect(store.getRegions().length).toBe(0);
      expect(emitted[emitted.length - 1].length).toBe(1); // emitted transiently
    });
  });

  describe('vertex edits', () => {
    let id: number;
    beforeEach(() => {
      id = store.addRegion(polyRegion([0, 10, 10, 0], [0, 0, 10, 10]));
    });

    it('moveVertex updates a single vertex', () => {
      store.moveVertex(id, 1, 99, 88);
      const poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.xpoints[1]).toBe(99);
      expect(poly.ypoints[1]).toBe(88);
      expect(poly.coordinates[1]).toEqual([99, 88]);
    });

    it('addVertex inserts after the segment index and bumps npoints', () => {
      store.addVertex(id, 0, 5, -1);
      const poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.xpoints).toEqual([0, 5, 10, 10, 0]);
      expect(poly.npoints).toBe(5);
      expect(poly.coordinates.length).toBe(5);
    });

    it('deleteVertex removes a vertex', () => {
      store.deleteVertex(id, 0);
      const poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.xpoints.length).toBe(3);
      expect(poly.npoints).toBe(3);
    });

    it('deleteVertex refuses to drop a closed polygon below 3 vertices', () => {
      const triId = store.addRegion(polyRegion([0, 10, 5], [0, 0, 10]));
      store.deleteVertex(triId, 0);
      const poly = store.getRegions().find(r => r.id === triId)!.bounds as Polygon;
      expect(poly.xpoints.length).toBe(3);
    });

    it('vertex edits are no-ops on rectangles', () => {
      const rectId = store.addRegion(rectRegion(0, 0, 10, 10));
      store.moveVertex(rectId, 0, 5, 5);
      const b = store.getRegions().find(r => r.id === rectId)!.bounds as Rectangle;
      expect(b.x).toBe(0);
    });
  });

  describe('setBezier', () => {
    it('toggles the bezier flag on a polygon without moving anchors', () => {
      const id = store.addRegion(polyRegion([0, 10, 5], [0, 0, 10]));
      store.setBezier(id, true);
      let poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.bezier).toBe(true);
      expect(poly.xpoints).toEqual([0, 10, 5]); // anchors untouched
      store.setBezier(id, false);
      poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.bezier).toBe(false);
    });

    it('converts a rectangle to a 4-anchor closed polygon when smoothing', () => {
      const id = store.addRegion(rectRegion(0, 0, 10, 20));
      store.setBezier(id, true);
      const b = store.getRegions()[0].bounds as Polygon;
      expect(b).toBeInstanceOf(Polygon);
      expect(b.bezier).toBe(true);
      expect(b.closed).toBe(true);
      expect(b.xpoints.length).toBe(4);
    });

    it('bezier=false on a rectangle is a no-op', () => {
      const id = store.addRegion(rectRegion(0, 0, 10, 10));
      store.setBezier(id, false);
      expect(store.getRegions()[0].bounds).toBeInstanceOf(Rectangle);
    });

    it('seeds editable handles when bezier is turned on and clears them when off', () => {
      const id = store.addRegion(polyRegion([0, 10, 5], [0, 0, 10]));
      store.setBezier(id, true);
      let poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.handlesIn?.length).toBe(3);
      expect(poly.handlesOut?.length).toBe(3);
      store.setBezier(id, false);
      poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.handlesIn).toBeUndefined();
      expect(poly.handlesOut).toBeUndefined();
    });

    it('moveBezierHandle stores the handle relative to its anchor', () => {
      const id = store.addRegion(polyRegion([10, 30, 20], [10, 10, 30]));
      store.setBezier(id, true);
      store.moveBezierHandle(id, 0, 'out', 14, 7); // anchor 0 is (10,10)
      const poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.handlesOut![0]).toEqual([4, -3]); // offset = handle - anchor
    });
  });

  describe('moveRegion', () => {
    it('translates a rectangle', () => {
      const id = store.addRegion(rectRegion(1, 2, 10, 10));
      store.moveRegion(id, 5, -1);
      const b = store.getRegions()[0].bounds as Rectangle;
      expect(b.x).toBe(6);
      expect(b.y).toBe(1);
    });

    it('translates every polygon vertex', () => {
      const id = store.addRegion(polyRegion([0, 10, 5], [0, 0, 10]));
      store.moveRegion(id, 2, 3);
      const poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.xpoints).toEqual([2, 12, 7]);
      expect(poly.ypoints).toEqual([3, 3, 13]);
    });
  });

  describe('selection', () => {
    it('survives an edit and prunes ids on removal', () => {
      const a = store.addRegion(rectRegion(0, 0, 1, 1));
      const b = store.addRegion(rectRegion(2, 2, 1, 1));
      store.setSelectedShapeIndices([1]); // select b

      let latest: number[] = [];
      store.getSelectedShapeIndices$().subscribe(s => latest = s);
      expect(latest).toEqual([1]);

      store.removeRegion(a); // shifts b from index 1 -> 0
      expect(latest).toEqual([0]); // selection follows b by id
      expect(store.getRegions()[0].id).toBe(b);
    });

    it('deleteActiveShape removes the selection and clears it', () => {
      store.addRegion(rectRegion(0, 0, 1, 1));
      store.addRegion(rectRegion(2, 2, 1, 1));
      store.setSelectedShapeIndices([0]);
      store.deleteActiveShape();
      expect(store.getRegions().length).toBe(1);
      let latest: number[] = [-1];
      store.getSelectedShapeIndices$().subscribe(s => latest = s);
      expect(latest).toEqual([]);
    });

    it('deleteActiveShape removes every selected region when multi-selected', () => {
      ['s0', 's1', 's2', 's3'].forEach((name, i) => {
        const r = rectRegion(i, i, 1, 1);
        r.name = name;
        store.addRegion(r);
      });
      store.setSelectedShapeIndices([0, 2]); // out of order on purpose
      store.deleteActiveShape();
      expect(store.getRegions().map(r => r.name)).toEqual(['s1', 's3']);
      expect(store.getSelectedShapeIndices()).toEqual([]);
    });
  });

  describe('batching', () => {
    it('emits once per batch, not per edit', () => {
      const id = store.addRegion(polyRegion([0, 10, 10, 0], [0, 0, 10, 10]));
      let emits = 0;
      store.getRegionUpdateEvent().subscribe(() => emits++);

      store.beginBatch();
      store.moveVertex(id, 0, 1, 1);
      store.moveVertex(id, 0, 2, 2);
      store.moveVertex(id, 0, 3, 3);
      expect(emits).toBe(0);
      store.endBatch();
      expect(emits).toBe(1);

      const poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.xpoints[0]).toBe(3); // last write wins
    });
  });

  describe('undo (jit-ui#85)', () => {
    // The store coalesces a burst of rapid commits into one undo entry via an
    // idle timer (UNDO_COALESCE_MS). Fake timers let us close a burst
    // deterministically between distinct "actions".
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

    /** Advance past the coalescing window so the next edit opens a new entry. */
    const settle = () => jest.advanceTimersByTime(500);

    it('starts with nothing to undo', () => {
      expect(store.canUndo()).toBe(false);
    });

    it('undoes a single add, restoring the prior (empty) state', () => {
      store.addRegion(rectRegion(0, 0, 10, 10));
      expect(store.getRegions().length).toBe(1);
      expect(store.canUndo()).toBe(true);

      store.undo();
      expect(store.getRegions().length).toBe(0);
      expect(store.canUndo()).toBe(false);
    });

    it('retains at most 10 steps, then greys out', () => {
      // 12 distinct add actions -> only the last 10 are undoable.
      for (let i = 0; i < 12; i++) { store.addRegion(rectRegion(i, i, 1, 1)); settle(); }
      expect(store.getRegions().length).toBe(12);

      // Undo the full retained depth (10): the two oldest adds can't be reverted.
      for (let i = 0; i < 10; i++) {
        expect(store.canUndo()).toBe(true);
        store.undo();
      }
      expect(store.getRegions().length).toBe(2); // floored at the first two adds
      expect(store.canUndo()).toBe(false);

      store.undo(); // no-op
      expect(store.getRegions().length).toBe(2);
    });

    it('emits canUndo state changes', () => {
      const states: boolean[] = [];
      store.getCanUndo$().subscribe(s => states.push(s));
      expect(states).toEqual([false]);

      store.addRegion(rectRegion(0, 0, 1, 1));
      expect(states[states.length - 1]).toBe(true);

      store.undo();
      expect(states[states.length - 1]).toBe(false);
    });

    it('undoes a delete, bringing the region back', () => {
      store.addRegion(rectRegion(0, 0, 1, 1)); settle();
      store.setSelectedShapeIndices([0]);
      store.deleteActiveShape();
      expect(store.getRegions().length).toBe(0);

      store.undo();
      expect(store.getRegions().length).toBe(1);
    });

    it('coalesces a rapid burst (a drag) into a single undo entry', () => {
      const id = store.addRegion(rectRegion(0, 0, 1, 1)); settle(); // entry 1
      // Simulate a wand/brush drag: many commits within the coalescing window.
      store.moveRegion(id, 1, 0);
      store.moveRegion(id, 1, 0);
      store.moveRegion(id, 1, 0);
      const moved = store.getRegions()[0].bounds as Rectangle;
      expect(moved.x).toBe(3);

      store.undo(); // one undo reverts the whole drag, not just the last tick
      expect((store.getRegions()[0].bounds as Rectangle).x).toBe(0);
    });

    it('does not alias the live region — an edit after undo is independent', () => {
      const id = store.addRegion(polyRegion([0, 10, 5], [0, 0, 10])); settle();
      store.moveVertex(id, 0, 99, 99); settle();
      store.undo(); // restore pre-move vertices
      const poly = store.getRegions()[0].bounds as Polygon;
      expect(poly.xpoints[0]).toBe(0);

      // Mutating again must not corrupt any retained snapshot.
      store.moveVertex(id, 1, 50, 50); settle();
      expect((store.getRegions()[0].bounds as Polygon).xpoints[1]).toBe(50);
    });

    it('resetUndoHistory clears the stack', () => {
      store.addRegion(rectRegion(0, 0, 1, 1));
      expect(store.canUndo()).toBe(true);
      store.resetUndoHistory();
      expect(store.canUndo()).toBe(false);
    });

    it('clears undo history on image switch', () => {
      store.setActiveImage(imageInfo('a.tif')); settle();
      store.addRegion(rectRegion(0, 0, 1, 1)); settle();
      expect(store.canUndo()).toBe(true);

      store.setActiveImage(imageInfo('b.tif'));
      expect(store.canUndo()).toBe(false);
    });

    it('a transient (isRegionSaveOn=false) display records no history', () => {
      store.setRegions([rectRegion(0, 0, 1, 1)], undefined, false);
      expect(store.canUndo()).toBe(false);
    });

    it('redo re-applies an undone action', () => {
      store.addRegion(rectRegion(0, 0, 1, 1)); settle();
      expect(store.canRedo()).toBe(false);

      store.undo();
      expect(store.getRegions().length).toBe(0);
      expect(store.canRedo()).toBe(true);

      store.redo();
      expect(store.getRegions().length).toBe(1);
      expect(store.canRedo()).toBe(false);
      expect(store.canUndo()).toBe(true);
    });

    it('redoes the full undone chain in order', () => {
      store.addRegion(rectRegion(0, 0, 1, 1)); settle();
      store.addRegion(rectRegion(2, 2, 1, 1)); settle();
      store.addRegion(rectRegion(4, 4, 1, 1)); settle();

      store.undo(); store.undo();
      expect(store.getRegions().length).toBe(1);

      store.redo();
      expect(store.getRegions().length).toBe(2);
      store.redo();
      expect(store.getRegions().length).toBe(3);
      expect(store.canRedo()).toBe(false);

      store.redo(); // no-op
      expect(store.getRegions().length).toBe(3);
    });

    it('a new action after undo clears the redo future', () => {
      store.addRegion(rectRegion(0, 0, 1, 1)); settle();
      store.addRegion(rectRegion(2, 2, 1, 1)); settle();
      store.undo();
      expect(store.canRedo()).toBe(true);

      store.addRegion(rectRegion(9, 9, 1, 1)); settle(); // diverge
      expect(store.canRedo()).toBe(false);
      store.redo(); // no-op — the old redo future is gone
      expect(store.getRegions().map(r => (r.bounds as Rectangle).x)).toEqual([0, 9]);
    });

    it('resetUndoHistory clears redo too', () => {
      store.addRegion(rectRegion(0, 0, 1, 1)); settle();
      store.undo();
      expect(store.canRedo()).toBe(true);
      store.resetUndoHistory();
      expect(store.canRedo()).toBe(false);
    });

    it('emits canRedo state changes', () => {
      const states: boolean[] = [];
      store.getCanRedo$().subscribe(s => states.push(s));
      expect(states).toEqual([false]);

      store.addRegion(rectRegion(0, 0, 1, 1));
      store.undo();
      expect(states[states.length - 1]).toBe(true);
      store.redo();
      expect(states[states.length - 1]).toBe(false);
    });
  });

  describe('per-image cache', () => {
    it('snapshots and restores regions across image switches', () => {
      store.setActiveImage(imageInfo('a.tif'));
      store.addRegion(rectRegion(0, 0, 1, 1));
      store.addRegion(rectRegion(2, 2, 1, 1));
      expect(store.getRegions().length).toBe(2);

      store.setActiveImage(imageInfo('b.tif'));
      expect(store.getRegions().length).toBe(0); // fresh image
      store.addRegion(rectRegion(9, 9, 1, 1));

      store.setActiveImage(imageInfo('a.tif'));
      expect(store.getRegions().length).toBe(2); // restored

      store.setActiveImage(imageInfo('b.tif'));
      expect(store.getRegions().length).toBe(1);
    });

    it('is idempotent for the same image (keeps regions on replot)', () => {
      store.setActiveImage(imageInfo('a.tif'));
      store.addRegion(rectRegion(0, 0, 1, 1));
      store.setActiveImage(imageInfo('a.tif'));
      expect(store.getRegions().length).toBe(1);
    });

    it('keys by URL so the same basename in different folders does not collide', () => {
      const a = ({} as IImageInfo); a.urls = ['s3://bkt/folderA/img.tif']; a.fileName = 'img.tif';
      const b = ({} as IImageInfo); b.urls = ['s3://bkt/folderB/img.tif']; b.fileName = 'img.tif';

      store.setActiveImage(a);
      const ra = rectRegion(0, 0, 1, 1); ra.name = 'A-only'; store.addRegion(ra);
      store.setActiveImage(b);
      const rb = rectRegion(2, 2, 1, 1); rb.name = 'B-only'; store.addRegion(rb);

      store.setActiveImage(a);
      expect(store.getRegions().map(r => r.name)).toEqual(['A-only']);
    });

    it('falls back to fileName as the key when no URL is present', () => {
      const a = ({} as IImageInfo); a.fileName = 'only-name.tif';
      store.setActiveImage(a);
      store.addRegion(rectRegion(0, 0, 1, 1));
      store.setActiveImage(imageInfo('b.tif'));
      expect(store.getRegions().length).toBe(0);
      store.setActiveImage(a);
      expect(store.getRegions().length).toBe(1);
    });

    it('clearRegionsByImageKey wipes the cache', () => {
      store.setActiveImage(imageInfo('a.tif'));
      store.addRegion(rectRegion(0, 0, 1, 1));
      store.clearRegionsByImageKey();
      store.setActiveImage(imageInfo('a.tif'));
      expect(store.getRegions().length).toBe(0);
    });
  });

  describe('holes (jit-ui#85)', () => {
    const holedPoly = () => {
      const r = polyRegion([0, 20, 20, 0], [0, 0, 20, 20]);
      (r.bounds as Polygon).holes = [[[5, 5], [10, 5], [10, 10], [5, 10]]];
      return r;
    };

    it('moveRegion translates holes with the exterior', () => {
      const id = store.addRegion(holedPoly());
      store.moveRegion(id, 100, 0);
      const b = store.getRegions()[0].bounds as Polygon;
      expect(b.holes![0]).toEqual([[105, 5], [110, 5], [110, 10], [105, 10]]);
    });

    it('moveHoleVertex moves a single hole vertex, leaving others + exterior intact', () => {
      const id = store.addRegion(holedPoly()); // hole [[5,5],[10,5],[10,10],[5,10]]
      store.moveHoleVertex(id, 0, 1, 99, 88);
      const b = store.getRegions()[0].bounds as Polygon;
      expect(b.holes![0][1]).toEqual([99, 88]);
      expect(b.holes![0][0]).toEqual([5, 5]);     // sibling untouched
      expect(b.xpoints).toEqual([0, 20, 20, 0]);  // exterior untouched
    });

    it('moveHoleVertex is a no-op for an out-of-range hole or vertex index', () => {
      const id = store.addRegion(holedPoly());
      store.moveHoleVertex(id, 5, 0, 1, 1); // bad hole index
      store.moveHoleVertex(id, 0, 99, 1, 1); // bad vertex index
      expect((store.getRegions()[0].bounds as Polygon).holes![0][0]).toEqual([5, 5]);
    });

    it('append dedupe distinguishes the same exterior with different holes', () => {
      store.setRegions([holedPoly()]);
      store.setRegions([holedPoly()], undefined, undefined, undefined, true); // identical → deduped
      expect(store.getRegions().length).toBe(1);
      // Same exterior, no holes → a different region → appended.
      store.setRegions([polyRegion([0, 20, 20, 0], [0, 0, 20, 20])],
        undefined, undefined, undefined, true);
      expect(store.getRegions().length).toBe(2);
    });

    it('undo restores holes without aliasing the live region', () => {
      jest.useFakeTimers();
      try {
        const id = store.addRegion(holedPoly());
        jest.advanceTimersByTime(500);
        store.moveRegion(id, 100, 0);
        jest.advanceTimersByTime(500);
        store.undo();
        const b = store.getRegions()[0].bounds as Polygon;
        expect(b.holes![0][0]).toEqual([5, 5]);
      } finally {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
      }
    });
  });

  describe('getRegionPolygons', () => {
    it('returns closed polygons and excludes open polylines', () => {
      store.addRegion(polyRegion([0, 10, 5], [0, 0, 10], true));
      store.addRegion(polyRegion([0, 10], [0, 10], false)); // open polyline
      const polys = store.getRegionPolygons();
      expect(polys.length).toBe(1);
      expect(polys[0].closed).toBe(true);
    });
  });

  describe('classification colours', () => {
    it('applies a stored class colour to a region by label', () => {
      store.setClassificationColor('Tumor', '#123456');
      const r = polyRegion([0, 10, 5], [0, 0, 10]);
      r.label = 'Tumor';
      store.addRegion(r);
      expect(store.getRegions()[0].color).toBe('#123456');
    });
  });

  describe('colour / label + previous-shapes accessors', () => {
    it('round-trips the show-label, shape-colour and fill-colour toggles', () => {
      store.setShowShapeLabel(true);
      store.setShapeColor('#abcdef');
      store.setFillColor('#fedcba');
      expect(store.getShowShapeLabel()).toBe(true);
      expect(store.getShapeColor()).toBe('#abcdef');
      expect(store.getFillColor()).toBe('#fedcba');
    });

    it('exposes classification colours from the shared store', () => {
      store.setClassificationColor('Tumor', '#112233');
      expect(store.getClassificationColors().get('Tumor')).toBe('#112233');
    });

    it('buffers and replays the previous-shapes snapshot without touching stored regions', () => {
      store.setPreviousShapes([polyRegion([0, 1, 2], [0, 1, 2])]);
      expect(store.getPreviousShapes().length).toBe(1);

      const replayed: Region[][] = [];
      store.getRegionUpdateEvent().subscribe(rs => replayed.push(rs as Region[]));
      store.plotPreviousShapes();
      expect(replayed[replayed.length - 1].length).toBe(1);
      expect(store.getRegions().length).toBe(0); // stored state untouched
    });
  });

  describe('GeoJSON round-trip helpers', () => {
    it('serialises regions to a GeoJSON string and parses them back', () => {
      const json = store.getGeoJsonString([polyRegion([0, 10, 5], [0, 0, 10])]);
      expect(typeof json).toBe('string');
      expect(store.importRegions(json).length).toBeGreaterThan(0);
    });
  });

  describe('updateBounds clones the incoming bounds (no aliasing)', () => {
    it('deep-clones a Bézier polygon including its handles', () => {
      const id = store.addRegion(polyRegion([0, 10, 5], [0, 0, 10]));
      const poly = new Polygon();
      poly.npoints = 3; poly.xpoints = [1, 2, 3]; poly.ypoints = [4, 5, 6];
      poly.coordinates = [[1, 4], [2, 5], [3, 6]];
      poly.closed = true; poly.bezier = true;
      poly.handlesIn = [[0, 0], [0, 0], [0, 0]];
      poly.handlesOut = [[1, 1], [1, 1], [1, 1]];
      store.updateBounds(id, poly);

      const stored = store.getRegions()[0].bounds as Polygon;
      expect(stored).not.toBe(poly);               // cloned, not aliased
      expect(stored.xpoints).toEqual([1, 2, 3]);
      expect(stored.handlesOut).toEqual([[1, 1], [1, 1], [1, 1]]);
      expect(stored.handlesOut).not.toBe(poly.handlesOut);
    });

    it('clones a Rectangle bounds', () => {
      const id = store.addRegion(rectRegion(0, 0, 5, 5));
      const rect = new Rectangle(); rect.x = 1; rect.y = 2; rect.width = 3; rect.height = 4;
      store.updateBounds(id, rect);
      const stored = store.getRegions()[0].bounds as Rectangle;
      expect(stored).not.toBe(rect);
      expect([stored.x, stored.y, stored.width, stored.height]).toEqual([1, 2, 3, 4]);
    });

    it('is a no-op for an unknown id', () => {
      store.updateBounds(9999, rectRegion(0, 0, 1, 1).bounds as Rectangle);
      expect(store.getRegions().length).toBe(0);
    });
  });

  describe('setRegions(append) de-duplicates by geometry equality', () => {
    it('rejects an appended polygon with identical coordinates, keeps a different one', () => {
      store.setRegions([polyRegion([0, 10, 5], [0, 0, 10])], true, true);
      expect(store.getRegions().length).toBe(1);

      // same coordinates → deduped
      store.setRegions([polyRegion([0, 10, 5], [0, 0, 10])], true, true, undefined, true);
      expect(store.getRegions().length).toBe(1);

      // different coordinates → appended
      store.setRegions([polyRegion([0, 20, 5], [0, 0, 20])], true, true, undefined, true);
      expect(store.getRegions().length).toBe(2);
    });

    it('treats a closed and an open polygon with the same points as different', () => {
      store.setRegions([polyRegion([0, 10, 5], [0, 0, 10], true)], true, true);
      store.setRegions([polyRegion([0, 10, 5], [0, 0, 10], false)], true, true, undefined, true);
      expect(store.getRegions().length).toBe(2); // closed !== open
    });

    it('de-dupes equal rectangles on append', () => {
      store.setRegions([rectRegion(0, 0, 10, 10)], true, true);
      store.setRegions([rectRegion(0, 0, 10, 10)], true, true, undefined, true);
      expect(store.getRegions().length).toBe(1);
    });
  });
});
