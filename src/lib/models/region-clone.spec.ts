import { MultiPolygon, Rectangle, Region } from './region';
import { makePolygon } from './polygon-factory';
import { polygonsEqual, regionsEqual, withRegionPatch, withRegionZ } from './region-clone';

function region(bounds: Region['bounds']): Region {
  return Object.assign(new Region(), { id: 1, name: 'r', label: 'tumor', bounds });
}
function rect(x: number, y: number, w: number, h: number): Rectangle {
  return Object.assign(new Rectangle(), { x, y, width: w, height: h });
}

describe('region-clone', () => {
  it('withRegionPatch copies, keeping every other field, and never changes the input', () => {
    const r = region(rect(0, 0, 1, 1));
    const c = withRegionPatch(r, { color: '#FF0000' });
    expect(c).not.toBe(r);
    expect(c).toBeInstanceOf(Region);
    expect(c).toMatchObject({ id: 1, name: 'r', label: 'tumor', color: '#FF0000' });
    expect(c.bounds).toBe(r.bounds);
    expect(r.color).toBeUndefined();
  });

  it('withRegionZ returns the same instance when z already matches', () => {
    const r = region(rect(0, 0, 1, 1));
    r.z = 2;
    expect(withRegionZ(r, 2)).toBe(r);
    const c = withRegionZ(r, 3);
    expect(c).not.toBe(r);
    expect(c.z).toBe(3);
    expect(r.z).toBe(2);
  });

  it('regionsEqual compares rectangles by value', () => {
    expect(regionsEqual(region(rect(1, 2, 3, 4)), region(rect(1, 2, 3, 4)))).toBe(true);
    expect(regionsEqual(region(rect(1, 2, 3, 4)), region(rect(1, 2, 3, 5)))).toBe(false);
  });

  it('regionsEqual distinguishes open/closed, vertices and holes', () => {
    const a = makePolygon([0, 4, 4, 0], [0, 0, 4, 4]);
    expect(polygonsEqual(a, makePolygon([0, 4, 4, 0], [0, 0, 4, 4]))).toBe(true);
    expect(polygonsEqual(a, makePolygon([0, 4, 4, 0], [0, 0, 4, 4], { closed: false }))).toBe(false);
    expect(polygonsEqual(a, makePolygon([0, 4, 4, 1], [0, 0, 4, 4]))).toBe(false);
    const holed = makePolygon([0, 4, 4, 0], [0, 0, 4, 4], {
      holes: [
        [
          [1, 1],
          [2, 1],
          [2, 2],
        ],
      ],
    });
    expect(polygonsEqual(a, holed)).toBe(false);
  });

  it('regionsEqual compares multi-polygon parts in order; mixed kinds are never equal', () => {
    const mp = (...ps: ReturnType<typeof makePolygon>[]) => Object.assign(new MultiPolygon(), { polygons: ps });
    const p1 = makePolygon([0, 1, 1], [0, 0, 1]);
    const p2 = makePolygon([5, 6, 6], [5, 5, 6]);
    expect(regionsEqual(region(mp(p1, p2)), region(mp(p1, p2)))).toBe(true);
    expect(regionsEqual(region(mp(p1, p2)), region(mp(p2, p1)))).toBe(false);
    expect(regionsEqual(region(p1), region(mp(p1)))).toBe(false);
    expect(regionsEqual(region(rect(0, 0, 1, 1)), region(makePolygon([0, 1, 1, 0], [0, 0, 1, 1])))).toBe(false);
  });
});
