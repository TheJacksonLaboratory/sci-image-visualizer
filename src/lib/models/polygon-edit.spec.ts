import { MultiPolygon, Polygon, Rectangle } from './region';
import { defaultHandleOffsets } from './bezier';
import * as edit from './polygon-edit';

/** Freeze `o` and everything under it, so an in-place edit throws. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function poly(xs: number[], ys: number[], extra: Partial<Polygon> = {}): Polygon {
  return Object.assign(new Polygon(), {
    npoints: xs.length, xpoints: xs, ypoints: ys, coordinates: xs.map((x, i) => [x, ys[i]]), closed: true,
  }, extra);
}
const square = () => poly([0, 10, 10, 0], [0, 0, 10, 10]);
const donut = () => poly([0, 20, 20, 0], [0, 0, 20, 20], { holes: [[[7, 7], [13, 7], [13, 13], [7, 13]]] });
const bezierDonut = () => {
  const p = donut();
  const off = defaultHandleOffsets(p.xpoints, p.ypoints, true);
  return Object.assign(p, { bezier: true, handlesIn: off.in, handlesOut: off.out });
};

describe('polygon-edit (copy-on-write)', () => {
  /** Every edit, applied to a deep-frozen input: none may touch it. */
  const ops: Array<[string, () => Polygon, (p: Polygon) => Polygon | null]> = [
    ['moveVertex', square, (p) => edit.moveVertex(p, 1, 11, 1)],
    ['addVertex', square, (p) => edit.addVertex(p, 0, 5, 0)],
    ['addVertex (bezier)', bezierDonut, (p) => edit.addVertex(p, 0, 10, 0)],
    ['deleteVertex', square, (p) => edit.deleteVertex(p, 0)],
    ['deleteVertex (bezier)', bezierDonut, (p) => edit.deleteVertex(p, 0)],
    ['moveHoleVertex', donut, (p) => edit.moveHoleVertex(p, 0, 0, 8, 8)],
    ['addHoleVertex', bezierDonut, (p) => edit.addHoleVertex(p, 0, 0, 10, 7)],
    ['deleteHoleVertex', bezierDonut, (p) => edit.deleteHoleVertex(p, 0, 0)],
    ['setBezier on', donut, (p) => edit.setBezier(p, true)],
    ['setBezier off', bezierDonut, (p) => edit.setBezier(p, false)],
    ['moveBezierHandle', bezierDonut, (p) => edit.moveBezierHandle(p, 0, 'out', 5, -5)],
    ['moveBezierHandle (seeds)', () => Object.assign(square(), { bezier: true }),
      (p) => edit.moveBezierHandle(p, 0, 'in', -1, 0)],
    ['moveHoleBezierHandle (seeds)', () => Object.assign(donut(), { bezier: true }),
      (p) => edit.moveHoleBezierHandle(p, 0, 0, 'out', 5, 6)],
    ['translatePolygon', donut, (p) => edit.translatePolygon(p, 3, 4)],
  ];
  it.each(ops)('%s returns a new polygon and leaves the input untouched', (_name, make, apply) => {
    const before = make();
    const snapshot = JSON.stringify(before);
    const after = apply(deepFreeze(before));
    expect(after).toBeInstanceOf(Polygon);
    expect(after).not.toBe(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('shares the arrays an edit does not touch', () => {
    const p = bezierDonut();
    const moved = edit.moveVertex(p, 0, 1, 1)!;
    expect(moved.holes).toBe(p.holes);
    expect(moved.handlesIn).toBe(p.handlesIn);
    const holeMoved = edit.moveHoleVertex(p, 0, 0, 8, 8)!;
    expect(holeMoved.xpoints).toBe(p.xpoints);
  });

  it('vertex edits', () => {
    expect(edit.moveVertex(square(), 1, 11, 1)!.coordinates[1]).toEqual([11, 1]);
    const added = edit.addVertex(square(), 0, 5, 0);
    expect([added.xpoints, added.npoints, added.coordinates[1]]).toEqual([[0, 5, 10, 10, 0], 5, [5, 0]]);
    expect(edit.addVertex(square(), 99, 5, 5).xpoints).toEqual([0, 10, 10, 0, 5]); // clamped
    const del = edit.deleteVertex(square(), 0)!;
    expect([del.xpoints, del.npoints]).toEqual([[10, 10, 0], 3]);
  });

  it('a bezier vertex insert gets smooth handles and keeps the others', () => {
    const p = bezierDonut();
    const added = edit.addVertex(p, 0, 10, 0);
    expect(added.handlesIn).toHaveLength(5);
    expect(added.handlesOut![1]).toEqual([20 / 6, 0]); // (next - prev) / 6 = ((20,0) - (0,0)) / 6
    expect(added.handlesOut![0]).toEqual(p.handlesOut![0]);
  });

  it.each<[string, () => Polygon | null]>([
    ['moveVertex out of range', () => edit.moveVertex(square(), 4, 0, 0)],
    ['deleteVertex below a triangle', () => edit.deleteVertex(poly([0, 1, 0], [0, 0, 1]), 0)],
    ['deleteVertex below an open segment', () => edit.deleteVertex(poly([0, 1], [0, 0], { closed: false }), 0)],
    ['moveHoleVertex without holes', () => edit.moveHoleVertex(square(), 0, 0, 1, 1)],
    ['moveHoleVertex index out of range', () => edit.moveHoleVertex(donut(), 0, 4, 1, 1)],
    ['addHoleVertex hole out of range', () => edit.addHoleVertex(donut(), 1, 0, 1, 1)],
    ['deleteHoleVertex index out of range', () => edit.deleteHoleVertex(donut(), 0, -1)],
    ['setBezier already on', () => edit.setBezier(bezierDonut(), true)],
    ['moveBezierHandle on a straight polygon', () => edit.moveBezierHandle(square(), 0, 'in', 1, 1)],
    ['moveHoleBezierHandle on a straight polygon', () => edit.moveHoleBezierHandle(donut(), 0, 0, 'in', 1, 1)],
  ])('%s is a no-op (null)', (_name, apply) => {
    expect(apply()).toBeNull();
  });

  it('hole edits', () => {
    expect(edit.moveHoleVertex(donut(), 0, 1, 14, 6)!.holes![0][1]).toEqual([14, 6]);
    expect(edit.addHoleVertex(donut(), 0, 0, 10, 7)!.holes![0])
      .toEqual([[7, 7], [10, 7], [13, 7], [13, 13], [7, 13]]);
    expect(edit.deleteHoleVertex(donut(), 0, 0)!.holes![0]).toEqual([[13, 7], [13, 13], [7, 13]]);
    // A triangle hole cannot lose a vertex and stay a ring: the hole goes.
    const tri = poly([0, 20, 20, 0], [0, 0, 20, 20], { holes: [[[7, 7], [13, 7], [13, 13]]] });
    expect(edit.deleteHoleVertex(tri, 0, 0)!.holes).toBeUndefined();
  });

  it('hole edits on a bezier polygon re-seed the hole handles in parallel', () => {
    const added = edit.addHoleVertex(bezierDonut(), 0, 0, 10, 7)!;
    expect(added.holeHandlesIn![0]).toHaveLength(5);
    expect(added.holeHandlesOut![0]).toHaveLength(5);
  });

  it('setBezier seeds and drops every handle; the anchors never move', () => {
    const on = edit.setBezier(donut(), true)!;
    expect([on.bezier, on.handlesIn!.length, on.holeHandlesIn![0].length]).toEqual([true, 4, 4]);
    expect(on.xpoints).toEqual([0, 20, 20, 0]);
    const off = edit.setBezier(on, false)!;
    expect([off.bezier, off.handlesIn, off.holeHandlesOut]).toEqual([false, undefined, undefined]);
  });

  it('bezier handles store offsets relative to their anchor', () => {
    expect(edit.moveBezierHandle(bezierDonut(), 1, 'in', 15, 5)!.handlesIn![1]).toEqual([-5, 5]);
    expect(edit.moveHoleBezierHandle(Object.assign(donut(), { bezier: true }), 0, 0, 'out', 5, 6)!
      .holeHandlesOut![0][0]).toEqual([-2, -1]);
  });

  it('translateBounds moves rectangles, polygons with holes and every part, optionally rounded', () => {
    const rect = Object.assign(new Rectangle(), { x: 1, y: 2, width: 3, height: 4 });
    expect(edit.translateBounds(rect, 10, 20))
      .toEqual(Object.assign(new Rectangle(), { x: 11, y: 22, width: 3, height: 4 }));
    const moved = edit.translateBounds(donut(), 0.4, 0.6, Math.round) as Polygon;
    expect([moved.xpoints, moved.holes![0][0], moved.coordinates[1]]).toEqual([[0, 20, 20, 0], [7, 8], [20, 1]]);
    const multi = Object.assign(new MultiPolygon(), { polygons: [square(), donut()] });
    const mm = edit.translateBounds(deepFreeze(multi), 1, 1) as MultiPolygon;
    expect(mm.polygons.map((p) => p.xpoints[0])).toEqual([1, 1]);
    expect(mm.polygons[1].holes![0][0]).toEqual([8, 8]);
  });
});
