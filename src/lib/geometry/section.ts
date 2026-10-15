/**
 * A section through a stack of slices' outlines: where a plane across the slices (x = const or
 * y = const) cuts each class's regions. A class's closed shapes cut into one interval per slice
 * they cross; stacked one slice thick, the intervals are traced into outlines. Its open lines
 * (a layer boundary on each B-scan, say) cut into one point per slice they cross, joined slice to
 * slice into the line the boundary draws across the stack.
 *
 * Section coordinates `(u, v)`: through `x = at`, u is the slice (slice k spans [k, k + 1)) and
 * v the image y; through `y = at`, u is the image x and v the slice.
 *
 * Pure: usable from workers.
 */
import { maskToPolygons } from './contour';
import type { SliceOutlines } from './reconstruct';

/** The plane: x = const (a section along y and the slices) or y = const (along x and the slices). */
export type SectionAxis = 'x' | 'y';

/** A class's outlines in a section, as interleaved `u, v`. */
export interface ClassSection {
  /** Closed outlines, holes included (even-odd). */
  rings: Float64Array[];
  /** Open lines; a line of one point is where the class crosses on one slice only. */
  lines: Float64Array[];
}

export interface SectionOptions {
  /** Slices in the stack. */
  depth: number;
  /** Image px across the section's in-plane axis: the image height through x, its width through y. */
  extent: number;
  /** In-plane cell size of the closed shapes' cut, image px (default 1). */
  step?: number;
  /** Farthest a line moves between neighbouring slices and is still joined, image px (default extent / 10). */
  maxJump?: number;
}

/** Each class's cut by the plane `axis = at`; classes the plane misses are left out. */
export function sectionOutlines(
  byClass: ReadonlyMap<string, readonly SliceOutlines[]>,
  axis: SectionAxis,
  at: number,
  opts: SectionOptions,
): Map<string, ClassSection> {
  const out = new Map<string, ClassSection>();
  for (const [label, slices] of byClass) {
    const rings = cutShapes(slices, axis, at, opts);
    const lines = cutLines(slices, axis, at, opts);
    if (rings.length || lines.length) out.set(label, { rings, lines });
  }
  return out;
}

/** The closed shapes' cut: intervals per slice, rasterised one slice thick and traced. */
function cutShapes(
  slices: readonly SliceOutlines[],
  axis: SectionAxis,
  at: number,
  opts: SectionOptions,
): Float64Array[] {
  const step = Math.max(opts.step ?? 1, 1e-6);
  const depth = Math.max(1, Math.ceil(opts.depth));
  const cells = Math.max(1, Math.ceil(opts.extent / step));
  // Through x: columns are slices, rows in-plane cells. Through y: the other way round.
  const w = axis === 'x' ? depth : cells;
  const h = axis === 'x' ? cells : depth;
  let mask: Uint8Array | null = null;
  for (const s of slices) {
    if (!s.rings.length || s.z < 0 || s.z >= depth) continue;
    const crossings = ringCrossings(s.rings, axis, at);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      // Cells whose centre lies in the interval (the pixel-centre rule).
      const from = Math.max(0, Math.ceil(crossings[c] / step - 0.5));
      const to = Math.min(cells - 1, Math.floor(crossings[c + 1] / step - 0.5));
      if (to < from) continue;
      mask ??= new Uint8Array(w * h);
      for (let k = from; k <= to; k++) mask[axis === 'x' ? k * w + s.z : s.z * w + k] = 1;
    }
  }
  if (!mask) return [];
  const toSection = (cx: number, cy: number): [number, number] =>
    axis === 'x' ? [cx, cy * step] : [cx * step, cy];
  const rings: Float64Array[] = [];
  for (const p of maskToPolygons(mask, w, h, 0, 0, 1, 1)) {
    rings.push(flat(p.xpoints.map((x, i) => toSection(x, p.ypoints[i]))));
    for (const hole of p.holes ?? []) rings.push(flat(hole.map(([x, y]) => toSection(x, y))));
  }
  return rings;
}

/** Where `rings` cross the plane, along the in-plane axis, sorted (even-odd: pairs are inside). */
function ringCrossings(rings: readonly ArrayLike<number>[], axis: SectionAxis, at: number): number[] {
  // Through x = at the crossings are y values; through y = at, x values.
  const a = axis === 'x' ? 0 : 1;
  const out: number[] = [];
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = r[2 * i + a],
        pj = r[2 * j + a];
      if (pi > at !== pj > at) {
        const qi = r[2 * i + 1 - a],
          qj = r[2 * j + 1 - a];
        out.push(qi + ((at - pi) * (qj - qi)) / (pj - pi));
      }
    }
  }
  return out.sort((p, q) => p - q);
}

/** The open lines' cut: a point per crossing, joined slice to slice (nearest first, each once). */
function cutLines(
  slices: readonly SliceOutlines[],
  axis: SectionAxis,
  at: number,
  opts: SectionOptions,
): Float64Array[] {
  const maxJump = opts.maxJump ?? opts.extent / 10;
  const stack = slices
    .map((s) => ({ z: s.z, hits: lineCrossings(s.lines ?? [], axis, at) }))
    .filter((s) => s.hits.length)
    .sort((p, q) => p.z - q.z);
  const done: number[][] = [];
  let open: Array<{ points: number[]; last: number }> = [];
  for (const { z, hits } of stack) {
    const pairs: Array<{ chain: number; hit: number; d: number }> = [];
    open.forEach((c, ci) => hits.forEach((q, hi) => pairs.push({ chain: ci, hit: hi, d: Math.abs(q - c.last) })));
    pairs.sort((p, q) => p.d - q.d);
    const nextOpen: typeof open = [];
    const usedChain = new Set<number>();
    const usedHit = new Set<number>();
    for (const p of pairs) {
      if (p.d > maxJump || usedChain.has(p.chain) || usedHit.has(p.hit)) continue;
      usedChain.add(p.chain);
      usedHit.add(p.hit);
      const chain = open[p.chain];
      chain.points.push(...point(axis, z, hits[p.hit]));
      chain.last = hits[p.hit];
      nextOpen.push(chain);
    }
    open.forEach((c, ci) => {
      if (!usedChain.has(ci)) done.push(c.points);
    });
    hits.forEach((q, hi) => {
      if (!usedHit.has(hi)) nextOpen.push({ points: point(axis, z, q), last: q });
    });
    open = nextOpen;
  }
  for (const c of open) done.push(c.points);
  return done.map((p) => Float64Array.from(p));
}

/** A line's crossing on slice `z` in section coordinates, at the slice's middle. */
function point(axis: SectionAxis, z: number, q: number): [number, number] {
  return axis === 'x' ? [z + 0.5, q] : [q, z + 0.5];
}

/** Where open `lines` cross the plane, along the in-plane axis. */
function lineCrossings(lines: readonly ArrayLike<number>[], axis: SectionAxis, at: number): number[] {
  const a = axis === 'x' ? 0 : 1;
  const out: number[] = [];
  for (const l of lines) {
    for (let i = 2; i + 1 < l.length; i += 2) {
      const p0 = l[i - 2 + a],
        p1 = l[i + a];
      // Half-open, so a vertex on the plane counts once.
      if (p0 > at !== p1 > at) {
        const q0 = l[i - 1 - a],
          q1 = l[i + 1 - a];
        out.push(q0 + ((at - p0) * (q1 - q0)) / (p1 - p0));
      }
    }
  }
  return out.sort((p, q) => p - q);
}

function flat(points: ReadonlyArray<readonly [number, number]>): Float64Array {
  const out = new Float64Array(points.length * 2);
  points.forEach(([u, v], i) => {
    out[2 * i] = u;
    out[2 * i + 1] = v;
  });
  return out;
}
