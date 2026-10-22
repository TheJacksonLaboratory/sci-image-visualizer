/**
 * The 3D reconstruction of a region from its outlines on a stack of slices: each slice's outlines
 * filled (each feature even-odd, the features as their union) into a voxel mask, the mask's
 * boundary meshed by surface nets and smoothed; and its open lines lofted into a sheet.
 *
 * Pure: usable from workers.
 */
import { pointInRing, ringArea, smoothMesh, surfaceNets } from 'napari-js/geometry';
import type { Mesh } from 'napari-js/geometry';

import { loftLines } from './loft';

/**
 * A region's outlines on one slice: rings as interleaved `x, y` image pixels (holes included), and
 * open polylines (a layer boundary), likewise.
 */
export interface SliceOutlines {
  z: number;
  rings: ArrayLike<number>[];
  /**
   * The feature each ring is part of (equal ids, one feature): a feature's rings fill even-odd (its
   * holes), the features as their union, so one inside or over another cuts no hole in it. Absent:
   * the rings are one feature.
   */
  ringGroups?: ArrayLike<number>;
  lines?: ArrayLike<number>[];
}

export interface ReconstructOptions {
  /** In-plane voxel edge, image px (default 1). Raised to keep the mask within `maxVoxels`. */
  pixelStep?: number;
  /** At most this many voxels (default 32 M). */
  maxVoxels?: number;
  /** Laplacian smoothing passes (default 2). */
  smooth?: number;
}

/**
 * The mesh of the region outlined by `slices`, in image pixels (x, y) and slice indices (z: slice
 * k's plane at z = k): the filled outlines' surface, and the sheet through the lines (see
 * {@link loftLines}). Empty when no slice has an area and no two slices have lines.
 */
export function reconstruct(slices: readonly SliceOutlines[], opts: ReconstructOptions = {}): Mesh {
  const filled = fill(slices, opts);
  const lines = slices.filter((s) => s.lines?.length);
  if (!lines.length) return filled;
  const sheet = loftLines(
    lines.map((s) => ({ z: s.z, lines: s.lines ?? [] })),
    opts.pixelStep ?? 1,
  );
  return mergeMeshes(filled, sheet);
}

/** The surface of the filled outlines. */
function fill(slices: readonly SliceOutlines[], opts: ReconstructOptions): Mesh {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const s of slices) {
    for (const r of s.rings) {
      for (let i = 0; i + 1 < r.length; i += 2) {
        if (r[i] < x0) x0 = r[i];
        if (r[i] > x1) x1 = r[i];
        if (r[i + 1] < y0) y0 = r[i + 1];
        if (r[i + 1] > y1) y1 = r[i + 1];
      }
    }
    if (s.rings.length) {
      z0 = Math.min(z0, s.z);
      z1 = Math.max(z1, s.z);
    }
  }
  if (!(x1 > x0) || !(y1 > y0)) return { vertices: new Float32Array(0), faces: new Uint32Array(0) };
  const nz = z1 - z0 + 1;
  const maxVoxels = opts.maxVoxels ?? 32_000_000;
  let step = Math.max(opts.pixelStep ?? 1, 1e-6);
  while (Math.ceil((x1 - x0) / step) * Math.ceil((y1 - y0) / step) * nz > maxVoxels) step *= 1.25;
  const nx = Math.max(1, Math.ceil((x1 - x0) / step));
  const ny = Math.max(1, Math.ceil((y1 - y0) / step));
  const mask = new Uint8Array(nx * ny * nz);
  for (const s of slices) {
    for (const rings of featureRings(s.rings, s.ringGroups)) {
      fillSlice(mask, nx, ny, (s.z - z0) * nx * ny, rings, x0, y0, step);
    }
  }

  // Voxel i spanning [i, i + 1) (napari-js centres it on i): the scaling below maps cell edges to px.
  const mesh = smoothMesh(surfaceNets(mask, [nx, ny, nz], { origin: [0.5, 0.5, 0.5] }), {
    iterations: opts.smooth ?? 2,
  });
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) {
    v[i] = x0 + v[i] * step;
    v[i + 1] = y0 + v[i + 1] * step;
    // Voxel k spans [k, k+1) with its centre (the slice) at k + 0.5.
    v[i + 2] = z0 + v[i + 2] - 0.5;
  }
  return mesh;
}

/**
 * Fill one slice's outlines into `mask`, a `width × height` grid of image px (pixel i spanning
 * [i, i + 1)), as the reconstruction fills them: each feature even-odd, the features as their
 * union, sampled at pixel centres. Cells already set stay set. Open lines enclose nothing.
 */
export function fillOutlines(mask: Uint8Array, width: number, height: number, outlines: SliceOutlines): void {
  for (const rings of featureRings(outlines.rings, outlines.ringGroups)) {
    fillSlice(mask, width, height, 0, rings, 0, 0, 1);
  }
}

/** `a` and `b` as one mesh. */
function mergeMeshes(a: Mesh, b: Mesh): Mesh {
  if (!b.faces.length) return a;
  if (!a.faces.length) return b;
  const vertices = new Float32Array(a.vertices.length + b.vertices.length);
  vertices.set(a.vertices);
  vertices.set(b.vertices, a.vertices.length);
  const faces = new Uint32Array(a.faces.length + b.faces.length);
  faces.set(a.faces);
  const offset = a.vertices.length / 3;
  for (let i = 0; i < b.faces.length; i++) faces[a.faces.length + i] = b.faces[i] + offset;
  return { vertices, faces };
}

/**
 * Fill one feature into one slice of the mask: even-odd over its `rings`, sampled at voxel
 * centres. Cells already set stay set, so the features of a slice fill as their union.
 */
function fillSlice(
  mask: Uint8Array,
  nx: number,
  ny: number,
  offset: number,
  rings: readonly ArrayLike<number>[],
  x0: number,
  y0: number,
  step: number,
): void {
  const crossings: number[] = [];
  // Only the rows the feature spans.
  let top = Infinity,
    bottom = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      if (r[i] < top) top = r[i];
      if (r[i] > bottom) bottom = r[i];
    }
  }
  const j0 = Math.max(0, Math.floor((top - y0) / step - 0.5));
  const j1 = Math.min(ny - 1, Math.ceil((bottom - y0) / step - 0.5));
  for (let j = j0; j <= j1; j++) {
    const y = y0 + (j + 0.5) * step;
    crossings.length = 0;
    for (const r of rings) {
      const n = r.length >> 1;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const ya = r[2 * i + 1],
          yb = r[2 * k + 1];
        if (ya > y !== yb > y) {
          const xa = r[2 * i],
            xb = r[2 * k];
          crossings.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
        }
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    const row = offset + j * nx;
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const from = Math.max(0, Math.ceil((crossings[c] - x0) / step - 0.5));
      const to = Math.min(nx - 1, Math.floor((crossings[c + 1] - x0) / step - 0.5));
      for (let i = from; i <= to; i++) mask[row + i] = 1;
    }
  }
}

/**
 * The area inside `rings` (interleaved `x, y`), even-odd: a ring inside an odd number of others is
 * a hole. Exact for rings that do not cross (a polygon set's exteriors and holes).
 */
export function ringsArea(rings: readonly ArrayLike<number>[]): number {
  const boxes = rings.map(ringBox);
  let area = 0;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (r.length < 6) continue;
    const x = r[0],
      y = r[1];
    let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (j === i) continue;
      const b = boxes[j];
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInRing(x, y, rings[j])) depth++;
    }
    area += (depth % 2 ? -1 : 1) * Math.abs(ringArea(r));
  }
  return Math.max(0, area);
}

/**
 * The rings of each feature (see {@link SliceOutlines.ringGroups}), in the order first met; one
 * feature of every ring without `groups`.
 */
export function featureRings(
  rings: readonly ArrayLike<number>[],
  groups?: ArrayLike<number>,
): ArrayLike<number>[][] {
  if (!groups || !rings.length) return rings.length ? [rings.slice()] : [];
  const byGroup = new Map<number, ArrayLike<number>[]>();
  rings.forEach((r, i) => {
    const g = groups[i] ?? 0;
    const feature = byGroup.get(g);
    if (feature) feature.push(r);
    else byGroup.set(g, [r]);
  });
  return [...byGroup.values()];
}

/**
 * The area of a slice's outlines (px²): each feature's (even-odd, see {@link ringsArea}), the
 * features as their union, so a feature inside or over another of the slice adds only what it
 * covers beyond it. Features whose extents overlap are measured together, by the length of their
 * union along each row, exact between the rows through their vertices where no outline crosses
 * another (and refined where one does).
 */
export function outlinesArea(rings: readonly ArrayLike<number>[], groups?: ArrayLike<number>): number {
  const features = featureRings(rings, groups).map((f) => ({ rings: f, box: featureBox(f) }));
  if (features.length < 2) return features.length ? ringsArea(features[0].rings) : 0;
  // Features whose extents overlap, joined (by x, so a feature meets only those it can overlap).
  features.sort((a, b) => a.box[0] - b.box[0]);
  const parent = features.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < features.length; i++) {
    const a = features[i].box;
    for (let j = i + 1; j < features.length && features[j].box[0] < a[2]; j++) {
      const b = features[j].box;
      if (b[1] < a[3] && a[1] < b[3]) parent[root(j)] = root(i);
    }
  }
  const clusters = new Map<number, ArrayLike<number>[][]>();
  features.forEach((f, i) => {
    const r = root(i);
    const cluster = clusters.get(r);
    if (cluster) cluster.push(f.rings);
    else clusters.set(r, [f.rings]);
  });
  let area = 0;
  for (const cluster of clusters.values())
    area += cluster.length === 1 ? ringsArea(cluster[0]) : unionArea(cluster);
  return area;
}

/**
 * The volume of the region outlined by `slices`, in px² × slices (one slice thick per outline):
 * the sum of each slice's area (see {@link outlinesArea}; Cavalieri's estimator). Times µm per px²
 * and per slice, µm³.
 */
export function outlinedVolume(slices: readonly SliceOutlines[]): number {
  let v = 0;
  for (const s of slices) v += outlinesArea(s.rings, s.ringGroups);
  return v;
}

/** The area of the union of `features` (each even-odd over its rings), row band by row band. */
function unionArea(features: readonly ArrayLike<number>[][]): number {
  const ys: number[] = [];
  for (const f of features) for (const r of f) for (let i = 1; i < r.length; i += 2) ys.push(r[i]);
  ys.sort((a, b) => a - b);
  let area = 0;
  for (let k = 0; k + 1 < ys.length; k++) if (ys[k + 1] > ys[k]) area += bandArea(features, ys[k], ys[k + 1], 0);
  return area;
}

/**
 * The union's area between rows `a` and `b`. Between two vertices' rows its width along a row is
 * linear in y unless outlines cross there: then the band is halved until it is (or thin enough).
 */
function bandArea(features: readonly ArrayLike<number>[][], a: number, b: number, depth: number): number {
  const h = b - a;
  const at = (t: number) => unionWidth(features, a + t * h);
  const mid = at(0.5);
  if (depth >= 10) return h * mid;
  const e = 1e-6;
  const tol = 1e-9 * (1 + Math.abs(mid));
  const linear = Math.abs(at(0.25) + at(0.75) - 2 * mid) <= tol && Math.abs(at(e) + at(1 - e) - 2 * mid) <= tol;
  if (linear) return h * mid;
  const m = a + h / 2;
  return bandArea(features, a, m, depth + 1) + bandArea(features, m, b, depth + 1);
}

/** The length of the union of `features` along the row `y`. */
function unionWidth(features: readonly ArrayLike<number>[][], y: number): number {
  const spans: Array<[number, number]> = [];
  const xs: number[] = [];
  for (const f of features) {
    xs.length = 0;
    for (const r of f) {
      const n = r.length >> 1;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const ya = r[2 * i + 1],
          yb = r[2 * k + 1];
        if (ya > y !== yb > y) xs.push(r[2 * i] + ((y - ya) * (r[2 * k] - r[2 * i])) / (yb - ya));
      }
    }
    xs.sort((p, q) => p - q);
    for (let c = 0; c + 1 < xs.length; c += 2) spans.push([xs[c], xs[c + 1]]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  let width = 0,
    from = -Infinity,
    to = -Infinity;
  for (const [s0, s1] of spans) {
    if (s0 > to) {
      if (to > from) width += to - from;
      from = s0;
      to = s1;
    } else if (s1 > to) to = s1;
  }
  if (to > from) width += to - from;
  return width;
}

/** The extent of a feature's rings. */
function featureBox(rings: readonly ArrayLike<number>[]): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) {
    const [x0, y0, x1, y1] = ringBox(r);
    box[0] = Math.min(box[0], x0);
    box[1] = Math.min(box[1], y0);
    box[2] = Math.max(box[2], x1);
    box[3] = Math.max(box[3], y1);
  }
  return box;
}

function ringBox(r: ArrayLike<number>): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i + 1 < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i];
    if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < y0) y0 = r[i + 1];
    if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return [x0, y0, x1, y1];
}
