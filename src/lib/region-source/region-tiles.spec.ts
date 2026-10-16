import {
  RegionFeatureTable,
  featureAt,
  featuresInRect,
  levelMinExtent,
  levelTolerance,
  regionLevelFor,
  regionTilesInRect,
  simplifyPolyline,
  simplifyRings,
} from './region-tiles';

/** A square ring with `n` vertices per side (so simplification has something to drop). */
function denseSquare(x: number, y: number, size: number, perSide = 50): number[][] {
  const pts: number[][] = [];
  const corners = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[(c + 1) % 4];
    for (let i = 0; i < perSide; i++) pts.push([ax + ((bx - ax) * i) / perSide, ay + ((by - ay) * i) / perSide]);
  }
  pts.push(pts[0]);
  return pts;
}

function polygon(id: string | undefined, ring: number[][], extra: Record<string, unknown> = {}, z?: number) {
  return {
    type: 'Feature',
    ...(id === undefined ? {} : { id }),
    properties: { classification: { name: 'A', color: [255, 0, 0] }, ...extra },
    geometry: { type: 'Polygon', coordinates: [ring], ...(z === undefined ? {} : { plane: { z } }) },
  };
}

describe('region-tiles', () => {
  describe('levels', () => {
    it('picks level 0 at or above 1:1 and one level per halving of the zoom below it', () => {
      expect(regionLevelFor(4, 6)).toBe(0);
      expect(regionLevelFor(1, 6)).toBe(0);
      expect(regionLevelFor(0.9, 6)).toBe(1);
      expect(regionLevelFor(0.5, 6)).toBe(1);
      expect(regionLevelFor(0.3, 6)).toBe(2);
      expect(regionLevelFor(0.25, 6)).toBe(2);
      expect(regionLevelFor(1e-6, 6)).toBe(5);
      expect(regionLevelFor(0, 6)).toBe(0);
    });

    it('simplifies to half a screen pixel and drops what is under one', () => {
      expect(levelTolerance(0)).toBe(0);
      expect(levelTolerance(1)).toBe(1);
      expect(levelTolerance(3)).toBe(4);
      expect(levelMinExtent(0)).toBe(0);
      expect(levelMinExtent(3)).toBe(8);
    });
  });

  describe('regionTilesInRect', () => {
    it('lists the tiles of a level inside the bounds, centre first', () => {
      const tiles = regionTilesInRect([0, 0, 1500, 1000], 0, 512, [0, 0, 4000, 4000]);
      expect(tiles.length).toBe(6);
      expect(tiles[0]).toEqual({ level: 0, gx: 1, gy: 0 });
      expect(regionTilesInRect([0, 0, 1500, 1000], 2, 512, [0, 0, 4000, 4000])).toEqual([
        { level: 2, gx: 0, gy: 0 },
      ]);
    });

    it('asks for nothing outside the data', () => {
      expect(regionTilesInRect([5000, 5000, 6000, 6000], 0, 512, [0, 0, 4000, 4000])).toEqual([]);
      expect(regionTilesInRect([0, 0, 10, 10], 0, 512, null)).toEqual([]);
    });
  });

  describe('simplification', () => {
    it('keeps the corners of a dense square and drops the collinear points', () => {
      const ring = Float64Array.from(denseSquare(0, 0, 100).slice(0, -1).flat());
      const [exact] = simplifyRings([ring], false, 0);
      expect(exact.length).toBe(ring.length);
      const [coarse] = simplifyRings([ring], false, 2);
      expect(coarse.length / 2).toBe(4);
    });

    it('drops rings smaller than the level shows', () => {
      const tiny = Float64Array.from([0, 0, 3, 0, 3, 3, 0, 3]);
      expect(simplifyRings([tiny], false, 1)).toHaveLength(1);
      expect(simplifyRings([tiny], false, 2)).toHaveLength(0);
    });

    it('simplifies open polylines keeping both ends', () => {
      const xs = [0, 1, 2, 3, 4];
      const ys = [0, 0.1, 0, -0.1, 0];
      expect(simplifyPolyline(xs, ys, 0.5)).toEqual({ xs: [0, 4], ys: [0, 0] });
    });
  });

  describe('RegionFeatureTable', () => {
    const geo = {
      type: 'FeatureCollection',
      features: [
        polygon('a', denseSquare(0, 0, 100)),
        polygon(undefined, denseSquare(2000, 2000, 1000)),
        polygon('c', denseSquare(10, 10, 2), { acronym: 'X' }),
        polygon('a', denseSquare(600, 0, 50)),
        polygon('z1', denseSquare(0, 0, 100), {}, 1),
        {
          type: 'Feature',
          properties: { classification: 'Line' },
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 500],
              [400, 500],
            ],
          },
        },
      ],
    };
    const table = RegionFeatureTable.fromGeoJson(JSON.stringify(geo));

    it('identifies features by their id, else by position, never twice', () => {
      expect(table.ids).toEqual(['a', '#1', 'c', '#3', 'z1', '#5']);
    });

    it('describes the set: bounds, levels, planes and class colours', () => {
      const info = table.info();
      expect(info.featureCount).toBe(6);
      expect(info.bounds).toEqual([0, 0, 3000, 3000]);
      expect(info.levels).toBe(4);
      expect(info.planes).toEqual([0, 1]);
      expect(info.classColors).toEqual({ A: '#ff0000' });
    });

    it('serves whole features to every tile they meet, per plane', () => {
      const t00 = table.tile(0, 0, 0, 0);
      expect(t00.features.map((f) => f.id).sort()).toEqual(['#5', 'a', 'c']);
      expect(table.tile(0, 0, 1, 0).features.map((f) => f.id)).toEqual(['#3']);
      // The 1000 px square spans tiles 3..5 on each axis at level 0.
      expect(table.tile(0, 0, 5, 5).features.map((f) => f.id)).toEqual(['#1']);
      expect(table.tile(1, 0, 0, 0).features.map((f) => f.id)).toEqual(['z1']);
    });

    it('leaves out features under a screen pixel at coarse levels', () => {
      expect(table.tile(0, 0, 0, 0).features.some((f) => f.id === 'c')).toBe(true);
      expect(table.tile(0, 2, 0, 0).features.some((f) => f.id === 'c')).toBe(false);
    });

    it('serves fewer vertices on coarser levels', () => {
      const v = (level: number) => table.tile(0, level, 0, 0).features.find((f) => f.id === 'a')!.rings[0].length;
      expect(v(0)).toBe(400);
      expect(v(1)).toBe(8);
    });

    it('returns the raw features by id', () => {
      const [{ id, feature }] = table.features(['c']);
      expect(id).toBe('c');
      expect(feature.properties?.['acronym']).toBe('X');
      expect(table.features(['nope'])).toEqual([]);
    });

    it('pages a plane through its index, by class and without excluded ids', () => {
      const page = table.index(0, { offset: 1, limit: 2 });
      expect(page.total).toBe(5);
      expect(page.rows.map((r) => r.id)).toEqual(['#1', 'c']);
      expect(table.index(0, { offset: 0, limit: 10, label: 'lin' }).rows.map((r) => r.id)).toEqual(['#5']);
      expect(table.index(0, { offset: 0, limit: 10, exclude: ['a', '#1'] }).total).toBe(3);
    });

    it("gives each row its feature's area, 0 for a polyline", () => {
      const area = new Map(table.index(0, { offset: 0, limit: 10 }).rows.map((r) => [r.id, r.area]));
      expect(area.get('a')).toBeCloseTo(100 * 100);
      expect(area.get('#1')).toBeCloseTo(1000 * 1000);
      expect(area.get('#5')).toBe(0);
    });

    it('exports through the working set, every feature with an id', () => {
      const out = JSON.parse(table.exportGeoJson(['a', '#3'], [{ type: 'Feature', id: 'new', geometry: null }]));
      expect(out.type).toBe('FeatureCollection');
      expect(out.features.map((f: { id: string }) => f.id)).toEqual(['#1', 'c', 'z1', '#5', 'new']);
    });
  });

  describe('picking', () => {
    const table = RegionFeatureTable.fromGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          polygon('outer', denseSquare(0, 0, 100)),
          polygon('inner', denseSquare(40, 40, 20)),
          {
            type: 'Feature',
            id: 'donut',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [denseSquare(200, 0, 100), denseSquare(225, 25, 50)] },
          },
          {
            type: 'Feature',
            id: 'line',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 300],
                [100, 300],
              ],
            },
          },
        ],
      }),
    );
    const features = table.tile(0, 0, 0, 0).features;

    it('finds the innermost area under a point', () => {
      expect(featureAt(features, 10, 10)?.id).toBe('outer');
      expect(featureAt(features, 50, 50)?.id).toBe('inner');
      expect(featureAt(features, 150, 50)).toBeNull();
    });

    it('treats a hole as outside', () => {
      expect(featureAt(features, 210, 10)?.id).toBe('donut');
      expect(featureAt(features, 250, 50)).toBeNull();
    });

    it('finds a polyline within the tolerance', () => {
      expect(featureAt(features, 50, 303, 4)?.id).toBe('line');
      expect(featureAt(features, 50, 310, 4)).toBeNull();
    });

    it('collects the features whose box meets a rectangle', () => {
      expect(
        featuresInRect(features, [90, 90, 210, 95])
          .map((f) => f.id)
          .sort(),
      ).toEqual(['donut', 'outer']);
    });
  });

  describe('class hierarchy, style, labels and counts', () => {
    const table = RegionFeatureTable.fromGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        classHierarchy: [
          { name: 'root', title: 'root' },
          { name: 'CTX', title: 'Cerebral cortex', parent: 'root', color: [0, 128, 0], order: 2 },
          { bogus: true },
        ],
        style: { fillOpacity: 2, labels: true, stroke: '#333', strokeWidth: -1 },
        features: [
          polygon('a', denseSquare(0, 0, 100), { classification: { name: 'CTX' } }),
          polygon('b', denseSquare(200, 0, 100), { classification: { name: 'CTX' } }),
          {
            type: 'Feature',
            id: 'two',
            properties: { classification: { name: 'root' } },
            geometry: {
              type: 'MultiPolygon',
              coordinates: [[denseSquare(0, 300, 40)], [denseSquare(100, 300, 2)]],
            },
          },
        ],
      }),
    );

    it('reads a well-formed hierarchy and style from the collection', () => {
      const info = table.info();
      expect(info.hierarchy).toEqual([
        { name: 'root', title: 'root' },
        { name: 'CTX', title: 'Cerebral cortex', parent: 'root', color: '#008000', order: 2 },
      ]);
      expect(info.style).toEqual({ fillOpacity: 1, labels: true, stroke: '#333' });
    });

    it('keeps the hierarchy and style through an edited export', () => {
      const out = table.exportGeoJson(['a'], [{ type: 'Feature', id: 'new', geometry: null }]);
      const reopened = RegionFeatureTable.fromGeoJson(out).info();
      expect(reopened.hierarchy).toEqual(table.info().hierarchy);
      expect(reopened.style).toEqual(table.info().style);
      expect(JSON.parse(out).features.map((f: { id: string }) => f.id)).toEqual(['b', 'two', 'new']);
    });

    it('counts features per class on a plane', () => {
      expect(table.classCounts(0)).toEqual({ CTX: 2, root: 1 });
      expect(table.classCounts(3)).toEqual({});
    });

    it('counts features per class on every plane', () => {
      const all = table.classCounts(null);
      const planes = table.info().planes.map((z) => table.classCounts(z));
      const summed: Record<string, number> = {};
      for (const p of planes) for (const [k, n] of Object.entries(p)) summed[k] = (summed[k] ?? 0) + n;
      expect(all).toEqual(summed);
      expect(table.classCounts(null, ['a'])).toEqual({ ...summed, CTX: summed['CTX'] - 1 });
    });

    it('labels each part at its pole, dropping parts too small for the level', () => {
      const two = (level: number) => table.tile(0, level, 0, 0).features.find((f) => f.id === 'two')!;
      const exact = two(0).labels!;
      expect(exact.length).toBe(6);
      expect(exact[0]).toBeCloseTo(20, 0);
      expect(exact[1]).toBeCloseTo(320, 0);
      expect(exact[2]).toBeCloseTo(20, 0);
      expect(two(2).labels!.length).toBe(3);
    });

    it('filters the index by exact classes', () => {
      expect(table.index(0, { offset: 0, limit: 9, classes: ['root'] }).rows.map((r) => r.id)).toEqual(['two']);
    });
  });

  describe('what a plain reading would lose', () => {
    const at = (id: string | undefined, x: number, size: number) => ({
      type: 'Feature',
      ...(id === undefined ? {} : { id }),
      properties: {},
      geometry: { type: 'Polygon', coordinates: [denseSquare(x, 0, size, 2)] },
    });
    const tableOf = (features: unknown[]) =>
      RegionFeatureTable.fromGeoJson(JSON.stringify({ type: 'FeatureCollection', features }));

    it('never gives two features one id', () => {
      // An explicit "#1", then a feature without an id at position 1; a repeated explicit id at
      // position 3 whose own fallback, "#3", is taken too.
      const table = tableOf([at('#1', 0, 10), at(undefined, 20, 10), at('#3', 40, 10), at('#1', 60, 10)]);
      expect(table.ids).toEqual(['#1', '#1-1', '#3', '#3-1']);
      expect(table.features(['#1'])).toHaveLength(1);
      expect((table.features(['#1'])[0].feature.geometry?.coordinates as number[][][])[0][0][0]).toBe(0);
      expect(JSON.parse(table.exportGeoJson(['#1'], [])).features).toHaveLength(3);
      expect(table.index(0, { offset: 0, limit: 10, exclude: ['#3'] }).total).toBe(3);
    });

    it('keeps a feature spanning many tiles out of their listings, and in its tiles', () => {
      // A 1,000,000 px square with four vertices: listed in each tile, it would be 3.8 million entries.
      const table = tableOf([at('a', 0, 10), at('huge', 0, 1_000_000), at('c', 30, 10), at('far', 1e300, 10)]);
      expect(table.indexEntries(0, 0)).toBeLessThanOrEqual(4);
      const ids = (gx: number, gy: number) => table.tile(0, 0, gx, gy).features.map((f) => f.id);
      expect(ids(0, 0)).toEqual(['a', 'huge', 'c']);
      expect(ids(1000, 1000)).toEqual(['huge']);
      expect(ids(1953, 0)).toEqual(['huge']);
      expect(ids(1954, 0)).toEqual([]);
      expect(ids(-1, 0)).toEqual([]);
    });
  });
});
