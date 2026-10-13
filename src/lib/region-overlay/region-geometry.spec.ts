import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { bezierAnchorHandles } from '../models/bezier';
import {
  WORLD,
  ToScreen,
  hitHandle,
  nearestEdge,
  nearestVertex,
  regionBBox,
  regionContains,
  regionHasHoles,
  regionPathD,
  regionsInRect,
  ringPathD,
  segmentDistance,
  topmostRegionAt,
} from './region-geometry';

/**
 * The geometry both region overlays share (review NAPARI-BOUNDARY-13,
 * OSD-PLOTLY-16). The containment table merges the cases the OSD and napari
 * overlay specs pinned separately, so the two overlays can no longer disagree.
 */

function region(bounds: unknown): Region {
  return Object.assign(new Region(), { bounds });
}
function poly(xs: number[], ys: number[], extra: Partial<Polygon> = {}): Polygon {
  return Object.assign(
    new Polygon(),
    {
      npoints: xs.length,
      xpoints: xs,
      ypoints: ys,
      coordinates: xs.map((x, i) => [x, ys[i]]),
      closed: true,
    },
    extra,
  );
}
function rect(x: number, y: number, width: number, height: number): Rectangle {
  return Object.assign(new Rectangle(), { x, y, width, height });
}
const square = (x0: number, y0: number, x1: number, y1: number, extra: Partial<Polygon> = {}) =>
  poly([x0, x1, x1, x0], [y0, y0, y1, y1], extra);
const HOLE = [
  [7, 7],
  [13, 7],
  [13, 13],
  [7, 13],
];

const tri = () => region(poly([0, 10, 5], [0, 0, 10]));
const donut = () => region(square(0, 0, 20, 20, { holes: [HOLE.map((p) => p.slice())] }));
/** Two parts: a 0–20 square with the 7–13 hole, and a 50–60 square. */
const multi = () =>
  region(
    Object.assign(new MultiPolygon(), {
      polygons: [square(0, 0, 20, 20, { holes: [HOLE.map((p) => p.slice())] }), square(50, 50, 60, 60)],
    }),
  );
/** A U: down the left, across the bottom, up the right. Open. */
const openU = () => region(poly([0, 0, 40, 40], [0, 40, 40, 0], { closed: false }));

describe('region-geometry', () => {
  describe('regionContains', () => {
    const cases: Array<[string, () => Region, number, number, boolean]> = [
      ['rectangle interior', () => region(rect(0, 0, 10, 10)), 5, 5, true],
      ['rectangle edge (inclusive)', () => region(rect(0, 0, 10, 10)), 10, 10, true],
      ['outside a rectangle', () => region(rect(0, 0, 10, 10)), 11, 5, false],
      ['triangle interior', tri, 5, 3, true],
      ['outside a triangle', tri, 9, 9, false],
      ['donut solid ring', donut, 2, 2, true],
      ['donut hole', donut, 10, 10, false],
      ['outside a donut', donut, 25, 5, false],
      ['multi-polygon first part', multi, 3, 3, true],
      ['multi-polygon second part', multi, 55, 55, true],
      ['multi-polygon part hole', multi, 10, 10, false],
      ['multi-polygon gap between parts', multi, 35, 35, false],
      ['open polyline: inside the implied interior', openU, 20, 20, false],
      ['open polyline: 3 px from the left stroke', openU, 3, 20, true],
      ['open polyline: 3 px from the bottom stroke', openU, 20, 37, true],
      ['open polyline: 7 px from any stroke', openU, 7, 20, false],
      ['JSON rectangle (no prototype)', () => region({ x: 0, y: 0, width: 10, height: 10 }), 5, 5, true],
      [
        'JSON polygon (no prototype)',
        () => region({ npoints: 3, xpoints: [0, 10, 5], ypoints: [0, 0, 10] }),
        5,
        3,
        true,
      ],
      [
        'JSON multi-polygon (no prototype)',
        () => region({ polygons: [{ xpoints: [20, 30, 25], ypoints: [20, 20, 30] }] }),
        25,
        23,
        true,
      ],
      ['no bounds', () => region(null), 0, 0, false],
    ];
    it.each(cases)('%s', (_name, make, x, y, expected) => {
      expect(regionContains(make(), x, y)).toBe(expected);
    });

    it('measures the open-polyline tolerance in screen pixels', () => {
      const zoom2: ToScreen = (x, y) => [2 * x, 2 * y];
      // 4 world units from the left stroke: 8 screen px at 2x, beyond the 6 px default.
      expect(regionContains(openU(), 4, 20)).toBe(true);
      expect(regionContains(openU(), 4, 20, { toScreen: zoom2 })).toBe(false);
      expect(regionContains(openU(), 4, 20, { toScreen: zoom2, tolPx: 10 })).toBe(true);
    });

    it('topmostRegionAt prefers the last region and honours skip', () => {
      const regions = [region(rect(0, 0, 10, 10)), region(rect(5, 5, 10, 10))];
      expect(topmostRegionAt(regions, 7, 7)).toBe(1);
      expect(topmostRegionAt(regions, 2, 2)).toBe(0);
      expect(topmostRegionAt(regions, 50, 50)).toBe(-1);
      expect(topmostRegionAt(regions, 7, 7, { skip: (r) => r === regions[1] })).toBe(0);
    });
  });

  describe('regionBBox', () => {
    it.each<[string, () => Region, ReturnType<typeof regionBBox>]>([
      ['rectangle', () => region(rect(1, 2, 3, 4)), { x0: 1, y0: 2, x1: 4, y1: 6 }],
      ['polygon', tri, { x0: 0, y0: 0, x1: 10, y1: 10 }],
      ['multi-polygon (all parts)', multi, { x0: 0, y0: 0, x1: 60, y1: 60 }],
      ['empty polygon', () => region(poly([], [])), null],
      ['no bounds', () => region(undefined), null],
    ])('%s', (_name, make, expected) => {
      expect(regionBBox(make())).toEqual(expected);
    });

    it('handles more vertices than a call can take arguments (OSD-PLOTLY-34)', () => {
      const n = 200_000;
      const xs = Array.from({ length: n }, (_, i) => 20 + 10 * Math.cos((2 * Math.PI * i) / n));
      const ys = Array.from({ length: n }, (_, i) => 20 + 10 * Math.sin((2 * Math.PI * i) / n));
      const bb = regionBBox(region(poly(xs, ys)))!;
      expect(bb.x0).toBeCloseTo(10);
      expect(bb.y1).toBeCloseTo(30);
    });
  });

  it('regionsInRect selects by bounding-box overlap and can skip profile lines', () => {
    const profile = Object.assign(region(rect(0, 0, 5, 5)), { kind: 'profile' as const });
    const regions = [region(rect(0, 0, 10, 10)), region(rect(100, 100, 10, 10)), profile];
    expect(regionsInRect(regions, -1, -1, 30, 30)).toEqual([0, 2]);
    expect(regionsInRect(regions, -1, -1, 30, 30, { skipProfiles: true })).toEqual([0]);
  });

  it('segmentDistance clamps to the segment ends', () => {
    expect(segmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(segmentDistance(-4, 3, 0, 0, 10, 0)).toBe(5);
    expect(segmentDistance(1, 1, 2, 2, 2, 2)).toBeCloseTo(Math.SQRT2);
  });

  describe('path data', () => {
    it('ringPathD: straight closed and open rings, projected', () => {
      expect(ringPathD([0, 10, 5], [0, 0, 10], true, WORLD)).toBe('M 0,0 L 10,0 L 5,10 Z');
      expect(ringPathD([0, 10], [0, 0], false, (x, y) => [x * 2, y + 1])).toBe('M 0,1 L 20,1');
      expect(ringPathD([3], [4], true, WORLD)).toBe('');
    });

    it('ringPathD: a bézier ring curves through its handles, or the default without them', () => {
      const xs = [0, 10, 5],
        ys = [0, 0, 10];
      const d = ringPathD(xs, ys, true, WORLD, {});
      expect(d.match(/ C /g)).toHaveLength(3);
      const [h0, h1] = bezierAnchorHandles(xs, ys, true);
      expect(d.startsWith(`M 0,0 C ${h0.out[0]},${h0.out[1]} ${h1.in[0]},${h1.in[1]} 10,0`)).toBe(true);
      const offsets = {
        in: [
          [0, 0],
          [0, -1],
          [0, 0],
        ],
        out: [
          [1, 0],
          [0, 0],
          [0, 0],
        ],
      };
      const stored = ringPathD(xs, ys, false, WORLD, offsets);
      expect(stored).toBe('M 0,0 C 1,0 10,-1 10,0 C 10,0 5,10 5,10');
    });

    it.each<[string, () => Region, string, boolean]>([
      ['rectangle', () => region(rect(0, 0, 10, 10)), 'M 0,0 L 10,0 L 10,10 L 0,10 Z', false],
      ['polygon', tri, 'M 0,0 L 10,0 L 5,10 Z', false],
      ['open polyline', () => region(poly([0, 10], [0, 5], { closed: false })), 'M 0,0 L 10,5', false],
      ['donut', donut, 'M 0,0 L 20,0 L 20,20 L 0,20 Z M 7,7 L 13,7 L 13,13 L 7,13 Z', true],
      [
        'multi-polygon (parts and holes)',
        multi,
        'M 0,0 L 20,0 L 20,20 L 0,20 Z M 7,7 L 13,7 L 13,13 L 7,13 Z M 50,50 L 60,50 L 60,60 L 50,60 Z',
        true,
      ],
    ])('regionPathD: %s', (_name, make, d, holes) => {
      expect(regionPathD(make())).toBe(d);
      expect(regionHasHoles(make())).toBe(holes);
    });

    it('regionPathD: a handle-less bézier region is curved, not straight (NAPARI-BOUNDARY-3)', () => {
      const r = tri();
      (r.bounds as Polygon).bezier = true;
      expect(regionPathD(r)).toContain(' C ');
      expect(regionPathD(r)).not.toContain(' L ');
    });

    it('regionPathD: a bézier donut curves its holes too', () => {
      const r = donut();
      (r.bounds as Polygon).bezier = true;
      expect(regionPathD(r).match(/M /g)).toHaveLength(2);
      expect(regionPathD(r)).not.toContain(' L ');
    });

    it('regionPathD: a multi-polygon skips degenerate parts', () => {
      const parts = [poly([0, 1], [0, 1]), square(0, 0, 1, 1)];
      const r = region(Object.assign(new MultiPolygon(), { polygons: parts }));
      expect(regionPathD(r).match(/M /g)).toHaveLength(1);
    });
  });

  describe('hitHandle', () => {
    it('grabs a rectangle corner with the opposite corner as the anchor', () => {
      const r = region(rect(0, 0, 10, 10));
      expect(hitHandle(r, 10, 10, WORLD, 8)).toEqual({ kind: 'corner', index: 3, anchor: [0, 0] });
      expect(hitHandle(r, 1, 9, WORLD, 8)).toEqual({ kind: 'corner', index: 2, anchor: [10, 0] });
      expect(hitHandle(r, 5, 5, WORLD, 2)).toBeNull();
    });

    it('grabs exterior and hole vertices', () => {
      expect(hitHandle(tri(), 1, 1, WORLD, 8)).toEqual({ kind: 'vertex', ring: -1, index: 0 });
      expect(hitHandle(donut(), 13, 13, WORLD, 2)).toEqual({ kind: 'vertex', ring: 0, index: 2 });
      expect(hitHandle(donut(), 10, 10, WORLD, 2)).toBeNull();
    });

    it('prefers a bézier control point over a vertex, default handles included', () => {
      const r = tri();
      const p = r.bounds as Polygon;
      p.bezier = true;
      const [h0] = bezierAnchorHandles(p.xpoints, p.ypoints, true);
      expect(hitHandle(r, h0.out[0], h0.out[1], WORLD, 1)).toEqual({
        kind: 'bezier',
        ring: -1,
        index: 0,
        side: 'out',
      });
      expect(hitHandle(r, h0.out[0], h0.out[1], WORLD, 1, { bezier: false })).toBeNull();
    });

    it('grabs a donut hole bézier handle (stored or default)', () => {
      const r = donut();
      const p = r.bounds as Polygon;
      p.bezier = true;
      const hole = bezierAnchorHandles(
        HOLE.map((q) => q[0]),
        HOLE.map((q) => q[1]),
        true,
      );
      expect(hitHandle(r, hole[1].in[0], hole[1].in[1], WORLD, 0.5)).toEqual({
        kind: 'bezier',
        ring: 0,
        index: 1,
        side: 'in',
      });
    });

    it('measures the radius in screen pixels', () => {
      const zoom4: ToScreen = (x, y) => [4 * x, 4 * y];
      expect(hitHandle(tri(), 40, 0, zoom4, 8)).toEqual({ kind: 'vertex', ring: -1, index: 1 });
      expect(hitHandle(tri(), 10, 0, zoom4, 8)).toBeNull();
    });
  });

  it('nearestEdge scans the exterior and the holes, in screen pixels', () => {
    expect(nearestEdge(tri(), 5, 0, WORLD)).toEqual({ ring: -1, segIndex: 0, dist: 0 });
    expect(nearestEdge(donut(), 10, 7.5, WORLD)).toEqual({ ring: 0, segIndex: 0, dist: 0.5 });
    expect(nearestEdge(region(rect(0, 0, 1, 1)), 0, 0, WORLD)).toBeNull();
    // An open polyline has no closing edge.
    const open = region(poly([0, 10, 10], [0, 0, 10], { closed: false }));
    expect(nearestEdge(open, 4, 6, WORLD)!.segIndex).not.toBe(2);
  });

  it('nearestVertex scans the exterior and the holes, in world units', () => {
    expect(nearestVertex(tri(), 9, 1)).toEqual({ ring: -1, index: 1, dist: Math.SQRT2 });
    expect(nearestVertex(donut(), 12, 12)).toEqual({ ring: 0, index: 2, dist: Math.SQRT2 });
    expect(nearestVertex(region(rect(0, 0, 1, 1)), 0, 0)).toBeNull();
  });
});
