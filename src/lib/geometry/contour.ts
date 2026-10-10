import { Polygon } from '../models/region';

/**
 * Pure contour tracing: binary mask / label map → polygons with holes. No DOM,
 * no Angular. Output vertices are pixel coordinates translated by the caller's
 * origin and are never clamped: a mask may sit partly outside the readback
 * window it was painted in (jit-ui#102).
 */

/** A traced boundary vertex in mask-local pixel coordinates. */
interface Vertex {
  x: number;
  y: number;
}

/**
 * Build a closed Polygon from crop-local vertices. A vertex (x, y) of a crop
 * whose (0,0) sits at (cropX, cropY) in the mask maps to
 * `round(originX + (cropX + x))`, the same value a full-mask trace produces.
 */
function toRing(
  verts: Vertex[],
  cropX: number,
  cropY: number,
  originX: number,
  originY: number,
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const v of verts) {
    xs.push(Math.round(originX + (cropX + v.x)));
    ys.push(Math.round(originY + (cropY + v.y)));
  }
  return { xs, ys };
}

/**
 * Trace EVERY 4-connected blob in `mask` (sized w*h) whose area is at least
 * `minSize` pixels, returning one Polygon per blob translated via
 * (originX, originY), ordered largest-first (ties in raster order). Enclosed
 * background runs of at least `minHoleSize` pixels become the bordering blob's
 * {@link Polygon.holes}. An erase that cuts a region in two therefore yields
 * both pieces, and a donut keeps its hole.
 *
 * The mask is labelled once; each blob and each hole is then traced inside its
 * own bounding box (RT-16), so the cost is O(w·h + Σ bbox areas) rather than
 * O(w·h) per blob.
 */
export function maskToPolygons(
  mask: Uint8Array,
  w: number,
  h: number,
  originX: number,
  originY: number,
  minSize = 4,
  minHoleSize = minSize,
): Polygon[] {
  return traceMask(mask, w, h, 0, 0, originX, originY, minSize, minHoleSize, w * h * 8);
}

/** Growable per-label bounding boxes and pixel counts (index 0 unused). */
class LabelStats {
  size: number[] = [0];
  minX: number[] = [0];
  minY: number[] = [0];
  maxX: number[] = [0];
  maxY: number[] = [0];

  add(): number {
    this.size.push(0);
    this.minX.push(Infinity);
    this.minY.push(Infinity);
    this.maxX.push(-Infinity);
    this.maxY.push(-Infinity);
    return this.size.length - 1;
  }

  grow(lbl: number, x: number, y: number): void {
    this.size[lbl]++;
    if (x < this.minX[lbl]) this.minX[lbl] = x;
    if (x > this.maxX[lbl]) this.maxX[lbl] = x;
    if (y < this.minY[lbl]) this.minY[lbl] = y;
    if (y > this.maxY[lbl]) this.maxY[lbl] = y;
  }
}

/**
 * {@link maskToPolygons} over a mask that is itself a crop at (cropX, cropY) of
 * a larger frame; `maxSteps` caps the boundary walk as for the full frame.
 */
function traceMask(
  mask: Uint8Array,
  w: number,
  h: number,
  cropX: number,
  cropY: number,
  originX: number,
  originY: number,
  minSize: number,
  minHoleSize: number,
  maxSteps: number,
): Polygon[] {
  // 1. Label all 4-connected components once, recording size + bbox.
  const labels = new Int32Array(w * h);
  const stats = new LabelStats();
  const queue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || labels[idx]) continue;
      const lbl = stats.add();
      labels[idx] = lbl;
      queue.push(idx);
      while (queue.length) {
        const i = queue.pop() as number;
        const px = i % w;
        const py = (i - px) / w;
        stats.grow(lbl, px, py);
        if (px > 0) {
          const j = i - 1;
          if (mask[j] && !labels[j]) {
            labels[j] = lbl;
            queue.push(j);
          }
        }
        if (px < w - 1) {
          const j = i + 1;
          if (mask[j] && !labels[j]) {
            labels[j] = lbl;
            queue.push(j);
          }
        }
        if (py > 0) {
          const j = i - w;
          if (mask[j] && !labels[j]) {
            labels[j] = lbl;
            queue.push(j);
          }
        }
        if (py < h - 1) {
          const j = i + w;
          if (mask[j] && !labels[j]) {
            labels[j] = lbl;
            queue.push(j);
          }
        }
      }
    }
  }

  const wanted: number[] = [];
  for (let lbl = 1; lbl < stats.size.length; lbl++) {
    if (stats.size[lbl] >= minSize) wanted.push(lbl);
  }
  wanted.sort((a, b) => stats.size[b] - stats.size[a]); // largest-first (stable)

  // 2. Interior rings (holes) per foreground label — jit-ui#85.
  const holesByLabel = detectHoles(mask, labels, w, h, cropX, cropY, originX, originY, minHoleSize, maxSteps);

  // 3. Trace each wanted blob inside its own bbox.
  const polys: Polygon[] = [];
  for (const lbl of wanted) {
    const bx = stats.minX[lbl],
      by = stats.minY[lbl];
    const bw = stats.maxX[lbl] - bx + 1,
      bh = stats.maxY[lbl] - by + 1;
    const comp = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const row = (by + y) * w + bx;
      for (let x = 0; x < bw; x++) if (labels[row + x] === lbl) comp[y * bw + x] = 1;
    }
    const verts = mooreBoundary(comp, bw, bh, maxSteps);
    if (verts.length < 3) continue;
    const ring = toRing(verts, cropX + bx, cropY + by, originX, originY);
    const poly = makeTracedPolygon(ring.xs, ring.ys);
    const holes = holesByLabel.get(lbl);
    if (holes && holes.length) poly.holes = holes;
    polys.push(poly);
  }
  return polys;
}

/** A closed traced polygon with its `coordinates` mirror filled in. */
function makeTracedPolygon(xs: number[], ys: number[]): Polygon {
  const poly = new Polygon();
  poly.npoints = xs.length;
  poly.xpoints = xs;
  poly.ypoints = ys;
  poly.coordinates = xs.map((x, i) => [x, ys[i]]);
  return poly;
}

/**
 * Find interior rings (holes) of each foreground component in `mask`: a
 * 4-connected run of background (0) pixels that is fully enclosed — i.e. not
 * reachable from the grid border through background — is a hole, attributed to
 * the foreground component that borders it most. Returns `fgLabel → rings`,
 * each ring a list of `[x, y]` pairs translated by the origin (same convention
 * as a polygon's `coordinates`). Holes smaller than `minHoleSize` are dropped.
 * Each hole is traced inside its own bbox.
 */
function detectHoles(
  mask: Uint8Array,
  fgLabels: Int32Array,
  w: number,
  h: number,
  cropX: number,
  cropY: number,
  originX: number,
  originY: number,
  minHoleSize: number,
  maxSteps: number,
): Map<number, number[][][]> {
  const result = new Map<number, number[][][]>();

  // 1. Flood-fill background reachable from the grid border ("outside").
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (idx: number) => {
    if (!mask[idx] && !outside[idx]) {
      outside[idx] = 1;
      stack.push(idx);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const px = i % w,
      py = (i - px) / w;
    if (px > 0) seed(i - 1);
    if (px < w - 1) seed(i + 1);
    if (py > 0) seed(i - w);
    if (py < h - 1) seed(i + w);
  }

  // 2. Remaining unvisited background pixels are enclosed holes. BFS each,
  //    tally the bordering foreground label, and trace its boundary.
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || outside[start] || visited[start]) continue;
    const owners = new Map<number, number>();
    const pixels: number[] = [];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    while (queue.length) {
      const i = queue.pop() as number;
      pixels.push(i);
      const px = i % w,
        py = (i - px) / w;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      const visit = (j: number) => {
        if (mask[j]) {
          const lbl = fgLabels[j];
          if (lbl) owners.set(lbl, (owners.get(lbl) ?? 0) + 1);
        } else if (!outside[j] && !visited[j]) {
          visited[j] = 1;
          queue.push(j);
        }
      };
      if (px > 0) visit(i - 1);
      if (px < w - 1) visit(i + 1);
      if (py > 0) visit(i - w);
      if (py < h - 1) visit(i + w);
    }
    if (pixels.length < minHoleSize || owners.size === 0) continue;
    let owner = 0,
      best = -1;
    owners.forEach((cnt, lbl) => {
      if (cnt > best) {
        best = cnt;
        owner = lbl;
      }
    });

    const hw = maxX - minX + 1,
      hh = maxY - minY + 1;
    const holeMask = new Uint8Array(hw * hh);
    for (const i of pixels) {
      const px = i % w,
        py = (i - px) / w;
      holeMask[(py - minY) * hw + (px - minX)] = 1;
    }
    const verts = mooreBoundary(holeMask, hw, hh, maxSteps);
    if (verts.length < 3) continue;
    // No viewport clamp, exactly like the exterior (jit-ui#102): a hole may lie
    // partly outside the readback window.
    const r = toRing(verts, cropX + minX, cropY + minY, originX, originY);
    const ring: number[][] = r.xs.map((x, k) => [x, r.ys[k]]);
    const list = result.get(owner) ?? [];
    list.push(ring);
    result.set(owner, list);
  }
  return result;
}

/**
 * Trace each instance in an integer label map (0 = background) into polygons —
 * used to turn a cellpose-style segmentation into region outlines. Labels with
 * area below `minSize` are skipped; a label made of several blobs yields one
 * polygon per blob, in label order. Coords are translated via originX/originY
 * (not clamped).
 *
 * One pass finds every label's bbox; each label is then traced inside it
 * (RT-16), instead of rescanning the whole map per label.
 */
export function labelsToPolygons(
  labels: Uint32Array,
  w: number,
  h: number,
  originX: number,
  originY: number,
  minSize = 10,
): Polygon[] {
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
  const minX = new Int32Array(maxLabel + 1).fill(w);
  const minY = new Int32Array(maxLabel + 1).fill(h);
  const maxX = new Int32Array(maxLabel + 1).fill(-1);
  const maxY = new Int32Array(maxLabel + 1).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lbl = labels[y * w + x];
      if (!lbl) continue;
      if (x < minX[lbl]) minX[lbl] = x;
      if (x > maxX[lbl]) maxX[lbl] = x;
      if (y < minY[lbl]) minY[lbl] = y;
      if (y > maxY[lbl]) maxY[lbl] = y;
    }
  }

  const out: Polygon[] = [];
  const maxSteps = w * h * 8;
  for (let lbl = 1; lbl <= maxLabel; lbl++) {
    if (maxX[lbl] < 0) continue; // label absent
    // The bbox crop is equivalent to the full map for this label: background
    // inside the bbox reaches the map border iff it reaches the bbox border.
    const bx = minX[lbl],
      by = minY[lbl];
    const bw = maxX[lbl] - bx + 1,
      bh = maxY[lbl] - by + 1;
    const bin = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const row = (by + y) * w + bx;
      for (let x = 0; x < bw; x++) if (labels[row + x] === lbl) bin[y * bw + x] = 1;
    }
    for (const p of traceMask(bin, bw, bh, bx, by, originX, originY, minSize, minSize, maxSteps)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Outer boundary of the first foreground blob (in raster order) of `mask`,
 * by Moore-neighbour following. A single isolated pixel yields its four
 * corners so callers always get a valid ring.
 */
export function mooreBoundary(mask: Uint8Array, w: number, h: number, maxSteps = w * h * 8): Vertex[] {
  // Find the first foreground pixel in raster order — guaranteed to lie
  // on the boundary.
  let startIdx = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return [];

  const sx = startIdx % w;
  const sy = (startIdx - sx) / w;
  const points: Vertex[] = [{ x: sx, y: sy }];

  // Single isolated pixel — emit the pixel's four corner points so callers
  // (which require ≥ 3 vertices to build a polygon) get a valid 1×1 square
  // instead of a degenerate single-vertex contour.
  const singleton = (idx: number): boolean => {
    const x = idx % w;
    const y = (idx - x) / w;
    const at = (xx: number, yy: number) => xx >= 0 && xx < w && yy >= 0 && yy < h && mask[yy * w + xx];
    return !(at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1));
  };
  if (singleton(startIdx)) {
    return [
      { x: sx, y: sy },
      { x: sx + 1, y: sy },
      { x: sx + 1, y: sy + 1 },
      { x: sx, y: sy + 1 },
    ];
  }

  // 8-connected neighbour offsets in clockwise order starting from West.
  const dx = [-1, -1, 0, 1, 1, 1, 0, -1];
  const dy = [0, -1, -1, -1, 0, 1, 1, 1];

  let cx = sx,
    cy = sy;
  // Backtrack direction — start from West (the side we'd be coming from in raster order).
  let prevDir = 0;

  for (let step = 0; step < maxSteps; step++) {
    // Standard Moore-neighbour tracing: search clockwise starting one step
    // after the backtrack direction.
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const dir = (prevDir + k) & 7;
      const nx = cx + dx[dir];
      const ny = cy + dy[dir];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (mask[ny * w + nx]) {
        // Backtrack direction is from new pixel back toward previous pixel.
        prevDir = (dir + 4) & 7;
        cx = nx;
        cy = ny;
        points.push({ x: cx, y: cy });
        found = true;
        break;
      }
    }
    if (!found) break;
    if (cx === sx && cy === sy && points.length > 1) {
      points.pop();
      break;
    }
  }

  return points;
}
