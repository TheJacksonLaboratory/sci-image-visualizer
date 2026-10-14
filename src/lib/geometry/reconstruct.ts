/**
 * The 3D reconstruction of a region from its outlines on a stack of slices: each slice's outlines
 * filled (even-odd) into a voxel mask, the mask's boundary meshed by surface nets and smoothed.
 *
 * Pure: usable from workers.
 */
import { Mesh, smoothMesh, surfaceNets } from './surface-nets';

/** A region's outlines on one slice: rings as interleaved `x, y` image pixels (holes included). */
export interface SliceOutlines {
  z: number;
  rings: ArrayLike<number>[];
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
 * k's plane at z = k). Empty when no slice has an area.
 */
export function reconstruct(slices: readonly SliceOutlines[], opts: ReconstructOptions = {}): Mesh {
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
  for (const s of slices) fillSlice(mask, nx, ny, (s.z - z0) * nx * ny, s.rings, x0, y0, step);

  const mesh = smoothMesh(surfaceNets(mask, nx, ny, nz), opts.smooth ?? 2);
  const v = mesh.vertices;
  for (let i = 0; i < v.length; i += 3) {
    v[i] = x0 + v[i] * step;
    v[i + 1] = y0 + v[i + 1] * step;
    // Voxel k spans [k, k+1) with its centre (the slice) at k + 0.5.
    v[i + 2] = z0 + v[i + 2] - 0.5;
  }
  return mesh;
}

/** Fill one slice of the mask: even-odd over `rings`, sampled at voxel centres. */
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
  for (let j = 0; j < ny; j++) {
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
      if (insideRing(rings[j], x, y)) depth++;
    }
    area += (depth % 2 ? -1 : 1) * Math.abs(shoelace(r));
  }
  return Math.max(0, area);
}

/**
 * The volume of the region outlined by `slices`, in px² × slices (one slice thick per outline):
 * the sum of each slice's area (Cavalieri's estimator). Times µm per px² and per slice, µm³.
 */
export function outlinedVolume(slices: readonly SliceOutlines[]): number {
  let v = 0;
  for (const s of slices) v += ringsArea(s.rings);
  return v;
}

function shoelace(r: ArrayLike<number>): number {
  const n = r.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (r[2 * j] + r[2 * i]) * (r[2 * j + 1] - r[2 * i + 1]);
  return a / 2;
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

function insideRing(r: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = r[2 * i + 1],
      yj = r[2 * j + 1];
    if (yi > y !== yj > y && x < ((r[2 * j] - r[2 * i]) * (y - yi)) / (yj - yi) + r[2 * i]) inside = !inside;
  }
  return inside;
}
