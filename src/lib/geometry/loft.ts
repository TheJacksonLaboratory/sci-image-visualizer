/**
 * The sheet through open polylines traced on a stack of slices (a retinal layer boundary on each
 * B-scan, say): each line joined to its counterpart on the next slice that has lines by a strip of
 * triangles. Slices without lines in between are bridged straight across.
 *
 * Pure: usable from workers.
 */
import type { Mesh } from './surface-nets';

/** A class's open polylines on one slice: interleaved `x, y` image pixels. */
export interface SliceLines {
  z: number;
  lines: readonly ArrayLike<number>[];
}

/** Points per line at most: the longest line is resampled at about one point per `step` px. */
const MAX_POINTS = 2048;
/** Points per line when matching lines across slices. */
const MATCH_POINTS = 32;

/**
 * The sheet through `slices`' lines, in image pixels (x, y) and slice indices (z: slice k's line at
 * z = k). Every line is resampled at the same number of points, evenly along its length (about one
 * per `step` px of the longest), so a line shared by the strips above and below it is one row of
 * vertices. Lines are matched between neighbouring slices closest first, each at most once, and only
 * when their boxes overlap; a line without a match ends the sheet there. Empty without two slices
 * with lines.
 */
export function loftLines(slices: readonly SliceLines[], step = 1): Mesh {
  const stack = slices
    .map((s) => ({ z: s.z, lines: s.lines.filter((l) => l.length >= 4) }))
    .filter((s) => s.lines.length)
    .sort((a, b) => a.z - b.z);
  if (stack.length < 2) return { vertices: new Float32Array(0), faces: new Uint32Array(0) };

  let longest = 0;
  for (const s of stack) for (const l of s.lines) longest = Math.max(longest, lineLength(l));
  const n = Math.min(MAX_POINTS, Math.max(2, Math.ceil(longest / Math.max(step, 1e-6)) + 1));

  // Each line's resampled points, once: rows of n vertices.
  const rows: Line[][] = [];
  const verts: number[] = [];
  for (const s of stack) {
    rows.push(
      s.lines.map((l) => {
        const first = verts.length / 3;
        const pts = resample(l, n);
        for (let i = 0; i < n; i++) verts.push(pts[2 * i], pts[2 * i + 1], s.z);
        return { first, probe: resample(l, MATCH_POINTS), box: lineBox(l) };
      }),
    );
  }

  const faces: number[] = [];
  for (let k = 0; k + 1 < rows.length; k++) {
    for (const { a, b, reversed } of matchLines(rows[k], rows[k + 1])) {
      const at = (i: number) => b.first + (reversed ? n - 1 - i : i);
      for (let i = 0; i + 1 < n; i++) {
        const a0 = a.first + i,
          a1 = a0 + 1,
          b0 = at(i),
          b1 = at(i + 1);
        faces.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  if (!faces.length) return { vertices: new Float32Array(0), faces: new Uint32Array(0) };
  return { vertices: Float32Array.from(verts), faces: Uint32Array.from(faces) };
}

type Box = [number, number, number, number];
interface Line {
  first: number;
  probe: Float64Array;
  box: Box;
}

/** Pairs of lines of two neighbouring slices: closest first (mean distance, either direction), each once. */
function matchLines(as: readonly Line[], bs: readonly Line[]): Array<{ a: Line; b: Line; reversed: boolean }> {
  const pairs: Array<{ a: number; b: number; cost: number; reversed: boolean }> = [];
  as.forEach((a, i) =>
    bs.forEach((b, j) => {
      if (!boxesOverlap(a.box, b.box)) return;
      const forward = meanDistance(a.probe, b.probe, false);
      const backward = meanDistance(a.probe, b.probe, true);
      pairs.push({ a: i, b: j, cost: Math.min(forward, backward), reversed: backward < forward });
    }),
  );
  pairs.sort((p, q) => p.cost - q.cost);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: Array<{ a: Line; b: Line; reversed: boolean }> = [];
  for (const p of pairs) {
    if (usedA.has(p.a) || usedB.has(p.b)) continue;
    usedA.add(p.a);
    usedB.add(p.b);
    out.push({ a: as[p.a], b: bs[p.b], reversed: p.reversed });
  }
  return out;
}

function meanDistance(a: Float64Array, b: Float64Array, reversed: boolean): number {
  const n = a.length >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = reversed ? n - 1 - i : i;
    sum += Math.hypot(a[2 * i] - b[2 * j], a[2 * i + 1] - b[2 * j + 1]);
  }
  return sum / n;
}

/** `n` points evenly spaced along the polyline, both ends kept. */
function resample(line: ArrayLike<number>, n: number): Float64Array {
  const m = line.length >> 1;
  const cumulative = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    cumulative[i] =
      cumulative[i - 1] + Math.hypot(line[2 * i] - line[2 * i - 2], line[2 * i + 1] - line[2 * i - 1]);
  }
  const total = cumulative[m - 1];
  const out = new Float64Array(2 * n);
  let seg = 1;
  for (let i = 0; i < n; i++) {
    const d = n === 1 ? 0 : (total * i) / (n - 1);
    while (seg < m - 1 && cumulative[seg] < d) seg++;
    const span = cumulative[seg] - cumulative[seg - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (d - cumulative[seg - 1]) / span)) : 0;
    out[2 * i] = line[2 * seg - 2] + t * (line[2 * seg] - line[2 * seg - 2]);
    out[2 * i + 1] = line[2 * seg - 1] + t * (line[2 * seg + 1] - line[2 * seg - 1]);
  }
  return out;
}

function lineLength(line: ArrayLike<number>): number {
  let len = 0;
  for (let i = 2; i + 1 < line.length; i += 2) len += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
  return len;
}

function lineBox(line: ArrayLike<number>): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 1 < line.length; i += 2) {
    box[0] = Math.min(box[0], line[i]);
    box[1] = Math.min(box[1], line[i + 1]);
    box[2] = Math.max(box[2], line[i]);
    box[3] = Math.max(box[3], line[i + 1]);
  }
  return box;
}

/** Whether the boxes overlap, each grown by a tenth of its larger side (a flat line has a thin box). */
function boxesOverlap(a: Box, b: Box): boolean {
  const ga = 0.1 * Math.max(a[2] - a[0], a[3] - a[1]);
  const gb = 0.1 * Math.max(b[2] - b[0], b[3] - b[1]);
  const g = ga + gb;
  return a[0] - g <= b[2] && b[0] - g <= a[2] && a[1] - g <= b[3] && b[1] - g <= a[3];
}
