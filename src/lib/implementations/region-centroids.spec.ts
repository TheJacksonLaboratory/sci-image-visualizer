import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { polygonCentroid, regionCentroids } from './region-centroids';

function region(bounds: Region['bounds']): Region {
  const r = new Region();
  r.bounds = bounds;
  return r;
}
function poly(xs: number[], ys: number[]): Polygon {
  return Object.assign(new Polygon(), { xpoints: xs, ypoints: ys, npoints: xs.length });
}

describe('region-centroids', () => {
  it('takes the vertex mean of a ring, and nothing from an empty one', () => {
    expect(polygonCentroid([0, 10, 5], [0, 0, 9])).toEqual([5, 3]);
    expect(polygonCentroid([], [])).toBeNull();
  });

  it('flattens rectangle centres, polygon vertex means and one point per multipolygon part', () => {
    const rect = Object.assign(new Rectangle(), { x: 10, y: 20, width: 4, height: 6 });
    const parts = [poly([0, 2], [0, 2]), poly([10, 12], [10, 14])];
    const multi = Object.assign(new MultiPolygon(), { polygons: parts });
    const out = regionCentroids([
      region(rect),
      region(poly([0, 10, 5], [0, 0, 9])),
      region(multi),
      region(null),
      region(poly([], [])),
    ]);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([12, 23, 5, 3, 1, 1, 11, 12]);
  });
});
