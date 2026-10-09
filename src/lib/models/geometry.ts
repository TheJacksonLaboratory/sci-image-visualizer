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
 * Split a single-subpath `M x,y L x,y ... [Z]` path into vertex arrays, plus
 * whether it is closed (ends in `Z`). No validation: a coordinate that doesn't
 * parse comes back as NaN. See {@link parseSvgPathPolygon} for the checked form.
 */
export function parseSvgPath(path: string): PolygonVertices & { closed: boolean } {
  const closed = path.endsWith('Z');
  const body = closed ? path.slice(1, -1) : path.slice(1); // drop M and optionally Z
  const xpoints: number[] = [];
  const ypoints: number[] = [];
  for (const seg of body.split('L')) {
    const [sx, sy] = seg.split(',');
    xpoints.push(parseFloat(sx));
    ypoints.push(parseFloat(sy));
  }
  return { xpoints, ypoints, closed };
}

/**
 * Parse a single-subpath `M x,y L x,y ... [Z]` path into vertex arrays.
 *
 * Returns null for paths we can't safely round-trip (multi-subpath, curves,
 * non-numeric coordinates, fewer than three vertices).
 */
export function parseSvgPathPolygon(path: string): PolygonVertices | null {
  if (!path || path[0] !== 'M') return null;
  if (path.indexOf('M', 1) !== -1) return null; // multi-subpath
  const { xpoints, ypoints } = parseSvgPath(path);
  if (xpoints.some((x, i) => !Number.isFinite(x) || !Number.isFinite(ypoints[i]))) return null;
  if (xpoints.length < 3) return null;
  return { xpoints, ypoints };
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
