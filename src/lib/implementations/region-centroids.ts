import { Region } from '../models/region';

/**
 * Region centroids for the backends' "region centroid" scatter views (napari-js points, Plotly
 * markers), computed once here instead of in each backend. The centroid is the VERTEX MEAN, not the
 * area centroid: cheap, and what both views have always shown.
 */

/** Vertex mean of one ring, or null when it has no vertices. */
export function polygonCentroid(xs: ArrayLike<number>, ys: ArrayLike<number>): [number, number] | null {
  const n = xs.length;
  if (n === 0) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i];
    cy += ys[i];
  }
  return [cx / n, cy / n];
}

/**
 * Centroids of `regions` as flat `[x, y, x, y, …]` data coordinates: a rectangle's centre, a
 * polygon's vertex mean, and one point per part of a multipolygon. Regions without geometry (or
 * with an empty ring) contribute nothing.
 */
export function regionCentroids(regions: ReadonlyArray<Pick<Region, 'bounds'>>): Float32Array {
  const out: number[] = [];
  const push = (c: [number, number] | null): void => {
    if (c) out.push(c[0], c[1]);
  };
  for (const r of regions) {
    const b = r.bounds as
      | { x: number; y: number; width: number; height: number }
      | { xpoints: number[]; ypoints: number[] }
      | { polygons: { xpoints: number[]; ypoints: number[] }[] }
      | null
      | undefined;
    if (!b) continue;
    if ('width' in b && 'x' in b) {
      out.push(b.x + b.width / 2, b.y + b.height / 2);
    } else if ('xpoints' in b) {
      push(polygonCentroid(b.xpoints, b.ypoints));
    } else if ('polygons' in b) {
      for (const p of b.polygons) push(polygonCentroid(p.xpoints, p.ypoints));
    }
  }
  return new Float32Array(out);
}
