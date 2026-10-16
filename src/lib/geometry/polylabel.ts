/**
 * Where to put a label inside a polygon: its pole of inaccessibility, the inside point farthest
 * from every edge (Garcia-Castellanos & Lombardo's grid search, as in Mapbox's polylabel). Unlike
 * the centroid it is always inside, also for a U-shaped or ring-shaped region.
 *
 * Pure: usable from workers.
 */

/** A polygon as interleaved `x, y` rings: the exterior first, then its holes. */
export type FlatRings = readonly ArrayLike<number>[];

/** The pole of inaccessibility `[x, y]` and its distance to the nearest edge. */
export interface LabelPoint {
  x: number;
  y: number;
  /** Distance from the point to the nearest edge: how much room a label has around it. */
  distance: number;
}

interface Cell {
  x: number;
  y: number;
  /** Half the cell's edge. */
  h: number;
  /** Signed distance from the centre to the polygon (positive inside). */
  d: number;
  /** The best distance any point of the cell can reach. */
  max: number;
}

/**
 * The pole of inaccessibility of `rings`, to within `precision` (default: 1/100 of the shorter
 * side of the exterior's box, at least 0.5). Null for an exterior with fewer than three vertices.
 */
export function polylabel(rings: FlatRings, precision?: number): LabelPoint | null {
  const outer = rings[0];
  if (!outer || outer.length < 6) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i + 1 < outer.length; i += 2) {
    if (outer[i] < minX) minX = outer[i];
    if (outer[i] > maxX) maxX = outer[i];
    if (outer[i + 1] < minY) minY = outer[i + 1];
    if (outer[i + 1] > maxY) maxY = outer[i + 1];
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const cellSize = Math.min(width, height);
  const eps = precision ?? Math.max(0.5, cellSize / 100);
  if (cellSize <= 0) return { x: minX, y: minY, distance: 0 };

  const cell = (x: number, y: number, h: number): Cell => {
    const d = signedDistance(x, y, rings);
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };
  const queue = new MaxHeap();
  const h = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) queue.push(cell(x + h, y + h, h));
  }
  // The centroid of the box is a good first guess, the area centroid often a better one.
  let best = cell(minX + width / 2, minY + height / 2, 0);
  const centroid = areaCentroid(outer);
  if (centroid) {
    const c = cell(centroid[0], centroid[1], 0);
    if (c.d > best.d) best = c;
  }
  let guard = 0;
  while (queue.size && guard++ < 10_000) {
    const c = queue.pop() as Cell;
    if (c.d > best.d) best = c;
    if (c.max - best.d <= eps) continue;
    const q = c.h / 2;
    queue.push(cell(c.x - q, c.y - q, q));
    queue.push(cell(c.x + q, c.y - q, q));
    queue.push(cell(c.x - q, c.y + q, q));
    queue.push(cell(c.x + q, c.y + q, q));
  }
  return { x: best.x, y: best.y, distance: Math.max(0, best.d) };
}

/** Distance from (x, y) to the nearest edge of `rings`, positive inside (even-odd), negative outside. */
export function signedDistance(x: number, y: number, rings: FlatRings): number {
  let inside = false;
  let min = Infinity;
  for (const r of rings) {
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[2 * i],
        ay = r[2 * i + 1],
        bx = r[2 * j],
        by = r[2 * j + 1];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      const d = segmentDistanceSq(x, y, ax, ay, bx, by);
      if (d < min) min = d;
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(min);
}

function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  let x = ax,
    y = ay;
  let dx = bx - x,
    dy = by - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = bx;
      y = by;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}

/** The area centroid of one ring, or null for a degenerate one. */
function areaCentroid(r: ArrayLike<number>): [number, number] | null {
  const n = r.length >> 1;
  let area = 0,
    cx = 0,
    cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
    cx += (r[2 * i] + r[2 * j]) * f;
    cy += (r[2 * i + 1] + r[2 * j + 1]) * f;
    area += f * 3;
  }
  return area === 0 ? null : [cx / area, cy / area];
}

/** A binary max-heap of cells by `max`. */
class MaxHeap {
  private readonly items: Cell[] = [];

  get size(): number {
    return this.items.length;
  }

  push(c: Cell): void {
    const a = this.items;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].max >= a[i].max) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): Cell | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && a[l].max > a[m].max) m = l;
        if (r < a.length && a[r].max > a[m].max) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
