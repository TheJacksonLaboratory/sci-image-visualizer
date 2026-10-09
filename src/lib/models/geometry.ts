/**
 * Pure SVG-path helpers (build and parse a vertex ring as a Plotly path).
 *
 * No DOM access, no service state, no `this`. Mask and ring geometry (the
 * rasterizer, mask set operations, point-in-ring, simplification, contour
 * tracing) lives in `src/lib/geometry/`.
 */

/** Parsed single-subpath polygon vertices. */
export interface PolygonVertices {
  xpoints: number[];
  ypoints: number[];
}

// ── SVG path parsing / building ──────────────────────────────────────

/**
 * Parse a single-subpath `M x,y L x,y ... Z` path into vertex arrays.
 *
 * Returns null for paths we can't safely round-trip (multi-subpath, curves,
 * fewer than three vertices). The wand only adopts shapes it produced or
 * that Plotly's drawclosedpath produces, both of which are single-subpath
 * polygons.
 */
export function parseSvgPathPolygon(path: string): PolygonVertices | null {
  if (!path || path[0] !== 'M') return null;
  if (path.indexOf('M', 1) !== -1) return null; // multi-subpath
  const trimmed = path.endsWith('Z') ? path.slice(1, -1) : path.slice(1);
  const segs = trimmed.split('L');
  const xpoints: number[] = [];
  const ypoints: number[] = [];
  for (const seg of segs) {
    const [sx, sy] = seg.split(',');
    const x = parseFloat(sx);
    const y = parseFloat(sy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    xpoints.push(x);
    ypoints.push(y);
  }
  if (xpoints.length < 3) return null;
  return { xpoints, ypoints };
}

/**
 * Build a closed SVG path string `M x,y L x,y L ... Z` from vertex arrays.
 * Returns '' for fewer than three vertices (degenerate).
 */
export function polygonToSvgPath(xpoints: number[], ypoints: number[]): string {
  if (xpoints.length < 3) return '';
  let path = 'M';
  for (let i = 0; i < xpoints.length; i++) {
    path += `${xpoints[i]},${ypoints[i]}`;
    path += i < xpoints.length - 1 ? 'L' : 'Z';
  }
  return path;
}

/**
 * Build an SVG path string from vertex arrays. Closed polygons end with `Z`,
 * open polylines do not. Returns '' for fewer than two vertices (degenerate).
 */
export function verticesToSvgPath(xs: number[], ys: number[], closed: boolean): string {
  if (xs.length < 2) return '';
  let path = 'M';
  for (let i = 0; i < xs.length; i++) {
    path += `${xs[i]},${ys[i]}`;
    if (i < xs.length - 1) path += 'L';
  }
  if (closed) path += 'Z';
  return path;
}

// ── Region equality ──────────────────────────────────────────────────

/**
 * Compare two Plotly shape objects for "same region" — used by the wand to
 * avoid appending duplicates when the user pushes the same find result more
 * than once. Polygons compare by SVG path string, rectangles compare by
 * (x0, y0, x1, y1).
 */
export function shapesEqual(a: any, b: any): boolean {
  if (a.path && b.path) {
    return a.path === b.path;
  }
  if (
    a.x0 !== undefined && a.y0 !== undefined &&
    a.x1 !== undefined && a.y1 !== undefined &&
    b.x0 !== undefined && b.y0 !== undefined &&
    b.x1 !== undefined && b.y1 !== undefined
  ) {
    return a.x0 === b.x0 &&
           a.y0 === b.y0 &&
           a.x1 === b.x1 &&
           a.y1 === b.y1;
  }
  return false;
}
