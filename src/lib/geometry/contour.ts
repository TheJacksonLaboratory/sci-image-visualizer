import { Polygon } from '../models/region';

/**
 * Pure contour tracing: binary mask / label map → polygons with holes. No DOM,
 * no Angular. Output vertices are pixel coordinates translated by the caller's
 * origin and are never clamped: a mask may sit partly outside the readback
 * window it was painted in (jit-ui#102).
 */

/** A traced boundary vertex in mask-local pixel coordinates. */
interface Vertex { x: number; y: number }

/** Build a closed Polygon from mask-local vertices translated by (ox, oy). */
function toPolygon(verts: Vertex[], ox: number, oy: number): Polygon {
  const xpoints: number[] = [];
  const ypoints: number[] = [];
  const coordinates: number[][] = [];
  for (const v of verts) {
    const ix = Math.round(ox + v.x);
    const iy = Math.round(oy + v.y);
    xpoints.push(ix);
    ypoints.push(iy);
    coordinates.push([ix, iy]);
  }
  const poly = new Polygon();
  poly.npoints = xpoints.length;
  poly.xpoints = xpoints;
  poly.ypoints = ypoints;
  poly.coordinates = coordinates;
  return poly;
}

/**
 * Trace EVERY 4-connected blob in `mask` (sized w*h) whose area is at least
 * `minSize` pixels, returning one Polygon per blob translated via
 * (originX, originY), ordered largest-first (ties in raster order). Enclosed
 * background runs of at least `minHoleSize` pixels become the bordering blob's
 * {@link Polygon.holes}. An erase that cuts a region in two therefore yields
 * both pieces, and a donut keeps its hole.
 */
export function maskToPolygons(mask: Uint8Array, w: number, h: number,
                               originX: number, originY: number, minSize = 4,
                               minHoleSize = minSize): Polygon[] {
  // Label all 4-connected components, recording each one's pixel count.
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0]; // sizes[label]; label 0 unused
  let nextLabel = 0;
  const queue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || labels[idx]) continue;
      nextLabel++;
      labels[idx] = nextLabel;
      let size = 0;
      queue.push(idx);
      while (queue.length) {
        const i = queue.pop() as number;
        size++;
        const px = i % w;
        const py = (i - px) / w;
        if (px > 0)     { const j = i - 1;
          if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
        if (px < w - 1) { const j = i + 1;
          if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
        if (py > 0)     { const j = i - w;
          if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
        if (py < h - 1) { const j = i + w;
          if (mask[j] && !labels[j]) { labels[j] = nextLabel; queue.push(j); } }
      }
      sizes[nextLabel] = size;
    }
  }

  const wanted: number[] = [];
  for (let lbl = 1; lbl <= nextLabel; lbl++) {
    if (sizes[lbl] >= minSize) wanted.push(lbl);
  }
  wanted.sort((a, b) => sizes[b] - sizes[a]); // largest-first

  // Interior rings (holes) per foreground label — jit-ui#85.
  const holesByLabel = detectHoles(mask, labels, w, h, originX, originY, minHoleSize);

  const polys: Polygon[] = [];
  const comp = new Uint8Array(w * h);
  for (const lbl of wanted) {
    comp.fill(0);
    for (let i = 0; i < comp.length; i++) comp[i] = labels[i] === lbl ? 1 : 0;
    const verts = mooreBoundary(comp, w, h);
    if (!verts || verts.length < 3) continue;
    const poly = toPolygon(verts, originX, originY);
    const holes = holesByLabel.get(lbl);
    if (holes && holes.length) poly.holes = holes;
    polys.push(poly);
  }
  return polys;
}

/**
 * Find interior rings (holes) of each foreground component in `mask`: a
 * 4-connected run of background (0) pixels that is fully enclosed — i.e. not
 * reachable from the grid border through background — is a hole, attributed to
 * the foreground component that borders it most. Returns `fgLabel → rings`,
 * each ring a list of `[x, y]` pairs translated by the origin (same convention
 * as a polygon's `coordinates`). Holes smaller than `minHoleSize` are dropped.
 */
function detectHoles(mask: Uint8Array, fgLabels: Int32Array, w: number, h: number,
                     originX: number, originY: number, minHoleSize: number): Map<number, number[][][]> {
  const result = new Map<number, number[][][]>();

  // 1. Flood-fill background reachable from the grid border ("outside").
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (idx: number) => {
    if (!mask[idx] && !outside[idx]) { outside[idx] = 1; stack.push(idx); }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop() as number;
    const px = i % w, py = (i - px) / w;
    if (px > 0) seed(i - 1);
    if (px < w - 1) seed(i + 1);
    if (py > 0) seed(i - w);
    if (py < h - 1) seed(i + w);
  }

  // 2. Remaining unvisited background pixels are enclosed holes. BFS each,
  //    tally the bordering foreground label, and trace its boundary.
  const visited = new Uint8Array(w * h);
  const holeMask = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || outside[start] || visited[start]) continue;
    let size = 0;
    const owners = new Map<number, number>();
    const pixels: number[] = [];
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    while (queue.length) {
      const i = queue.pop() as number;
      size++;
      pixels.push(i);
      const px = i % w, py = (i - px) / w;
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
    if (size < minHoleSize || owners.size === 0) continue;
    let owner = 0, best = -1;
    owners.forEach((cnt, lbl) => { if (cnt > best) { best = cnt; owner = lbl; } });

    holeMask.fill(0);
    for (const i of pixels) holeMask[i] = 1;
    const verts = mooreBoundary(holeMask, w, h);
    if (!verts || verts.length < 3) continue;
    // No viewport clamp, exactly like the exterior (jit-ui#102): a hole may lie
    // partly outside the readback window.
    const ring: number[][] = [];
    for (const v of verts) {
      ring.push([Math.round(originX + v.x), Math.round(originY + v.y)]);
    }
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
 * polygon per blob. Coords are translated via originX/originY (not clamped).
 */
export function labelsToPolygons(labels: Uint32Array, w: number, h: number,
                                 originX: number, originY: number, minSize = 10): Polygon[] {
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
  const out: Polygon[] = [];
  const bin = new Uint8Array(w * h);
  for (let lbl = 1; lbl <= maxLabel; lbl++) {
    let any = false;
    for (let i = 0; i < labels.length; i++) {
      const on = labels[i] === lbl; bin[i] = on ? 1 : 0; if (on) any = true;
    }
    if (!any) continue;
    for (const p of maskToPolygons(bin, w, h, originX, originY, minSize)) {
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
export function mooreBoundary(mask: Uint8Array, w: number, h: number,
                              maxSteps = w * h * 8): Vertex[] {
  // Find the first foreground pixel in raster order — guaranteed to lie
  // on the boundary.
  let startIdx = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { startIdx = i; break; }
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
      { x: sx,     y: sy     },
      { x: sx + 1, y: sy     },
      { x: sx + 1, y: sy + 1 },
      { x: sx,     y: sy + 1 },
    ];
  }

  // 8-connected neighbour offsets in clockwise order starting from West.
  const dx = [-1, -1,  0,  1, 1, 1, 0, -1];
  const dy = [ 0, -1, -1, -1, 0, 1, 1,  1];

  let cx = sx, cy = sy;
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
