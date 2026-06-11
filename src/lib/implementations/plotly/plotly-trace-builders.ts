import { PlotType } from '../../contracts/plot-type';
import { bt601Luminance } from '../../contracts/intensity';

/**
 * Pluggable Plotly trace builders for the plot types added on top of the
 * original HEATMAP / SURFACE / RGB-image renderers.
 *
 * DESIGN / EXTRACTION ALIGNMENT
 * -----------------------------
 * Every function here is **pure** — it takes a `TraceBuildInput` and returns
 * Plotly trace dicts. There is no Angular, no RxJS, no host-state coupling
 * (`MainState`, `FilesService`, …). That keeps the module relocatable into the
 * future `@jax-data-science/image-visualization` library core (see the
 * `sketch/jit-plotting-extraction` SOW) without port surgery.
 *
 * Layout building stays in `PlotlyService` (it needs live service state such
 * as screen height, scale ratio and the current shapes); only TRACE building
 * is pluggable here. To add a new plot type: write a builder, register it in
 * `PLOTLY_PLOT_TYPE_IMPLS`, and add a descriptor in `contracts/plot-type.ts`.
 *
 * The original HEATMAP/SURFACE/RGB types intentionally keep their dedicated
 * renderers in `PlotlyService` (they are also reused by the high-def zoom
 * re-fetch path), so they are NOT registered here.
 */

/** Normalised input for a trace builder. Frames are per-z-plane matrices:
 *  grayscale cells are scalars, RGB cells are `[r, g, b]`. */
export interface TraceBuildInput {
  frames: any[];
  width: number;
  height: number;
  /** [xRatio, yRatio] — data units per pixel. */
  ratios: number[];
  /** [x0, x1, y0, y1] — true image extent in data units. */
  trueImageSize: number[];
  isGrayscale: boolean;
  /** Plotly colorscale value (e.g. from the active colormap). */
  colorscale: any;
  reversescale: boolean;
  /** Region polygons in data coords, for region-sourced plots (SCATTER). */
  regions: { xpoints: number[]; ypoints: number[] }[];
  /** Default marker/line colour for derived (non-image-LUT) traces. */
  shapeColor: string;
  /** ISOSURFACE intensity bounds (0–255): surfaces are drawn for values in
   *  [isoMin, isoMax], mapped straight onto Plotly's isomin/isomax. */
  isoMin: number;
  isoMax: number;
}

export type TraceBuilder = (input: TraceBuildInput) => any[];

export type PlotLayoutKind = '2d-image' | '2d-overlay' | '2d-chart' | '3d-volume';

export interface PlotlyPlotTypeImpl {
  buildTraces: TraceBuilder;
  /** Which layout `PlotlyService` should build for this type. */
  layoutKind: PlotLayoutKind;
  /** True for scene-based (3D) traces — picks the 3D Plotly config. */
  threeD: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Scalar value of a frame cell: `[r, g, b]` → BT.601 luminance, scalar as-is. */
function luminance(cell: any): number {
  if (Array.isArray(cell)) {
    return bt601Luminance(cell[0], cell[1], cell[2]);
  }
  return cell as number;
}

/** Project a frame to a scalar matrix (RGB → luminance, grayscale → as-is). */
function toScalarFrame(frame: any[], isGrayscale: boolean): number[][] {
  if (isGrayscale) return frame as number[][];
  return frame.map((row: any[]) => row.map(luminance));
}

/** Even stride that keeps an axis under `maxSamples` sample points. */
function strideFor(length: number, maxSamples: number): number {
  return Math.max(1, Math.ceil(length / maxSamples));
}

// ── builders ─────────────────────────────────────────────────────────────

/** Max cells per axis the contour grid is downsampled to. The heatmap trace can
 *  raster the full preview cheaply, but contour runs CPU marching-squares over
 *  every cell, so a full-resolution preview (~1000²) costs seconds. Contours
 *  interpolate, so a coarser grid looks the same while rendering near-instantly. */
const CONTOUR_MAX_SAMPLES = 400;

/** Every `sx`-th column / `sy`-th row of a scalar matrix. */
function downsampleMatrix(matrix: number[][], sx: number, sy: number): number[][] {
  if (sx <= 1 && sy <= 1) return matrix;
  const out: number[][] = [];
  for (let r = 0; r < matrix.length; r += sy) {
    const row = matrix[r];
    if (sx <= 1) { out.push(row); continue; }
    const sampled: number[] = [];
    for (let c = 0; c < row.length; c += sx) sampled.push(row[c]);
    out.push(sampled);
  }
  return out;
}

/** CONTOUR — per-frame iso-contours over a downsampled scalar matrix. Mirrors
 *  the heatmap trace geometry (x0/dx/y0/dy) so it lines up with the image axes;
 *  the stride scales dx/dy so the coarser grid still spans the true extent. */
function buildContourTraces(input: TraceBuildInput): any[] {
  const [x0, , y0] = [input.trueImageSize[0], input.trueImageSize[1], input.trueImageSize[2]];
  return input.frames.map((frame, index) => {
    const scalar = toScalarFrame(frame, input.isGrayscale);
    const height = scalar.length;
    const width = height > 0 ? scalar[0].length : 0;
    const sx = strideFor(width, CONTOUR_MAX_SAMPLES);
    const sy = strideFor(height, CONTOUR_MAX_SAMPLES);
    return {
      x0,
      dx: input.ratios[0] * sx,
      y0,
      dy: input.ratios[0] * sy,
      z: downsampleMatrix(scalar, sx, sy),
      type: 'contour',
      hoverinfo: 'none',
      colorscale: input.colorscale,
      reversescale: input.reversescale,
      contours: { coloring: 'heatmap' },
      // Cap the level count so it doesn't scale with the (now coarser) grid.
      ncontours: 15,
      name: `Slice ${index + 1}`,
      visible: index === 0,
    };
  });
}

/** SCATTER — region centroids as labelled markers (region-sourced). */
function buildScatterTraces(input: TraceBuildInput): any[] {
  const xs: number[] = [];
  const ys: number[] = [];
  const text: string[] = [];
  input.regions.forEach((poly, i) => {
    const n = poly.xpoints.length;
    if (n === 0) return;
    const cx = poly.xpoints.reduce((a, b) => a + b, 0) / n;
    const cy = poly.ypoints.reduce((a, b) => a + b, 0) / n;
    xs.push(cx);
    ys.push(cy);
    text.push(`R${i + 1}`);
  });
  return [{
    x: xs,
    y: ys,
    text,
    type: 'scatter',
    mode: 'markers+text',
    textposition: 'top center',
    marker: { size: 10, color: input.shapeColor, line: { color: '#000', width: 1 } },
    name: 'Region centroids',
  }];
}

/**
 * Collect a downsampled regular grid of voxels across the z-stack.
 * Returns parallel flat arrays suitable for both scatter3d and isosurface.
 * A single-frame image is thickened to two z-planes so 3D traces render.
 */
function sampleVolume(input: TraceBuildInput, maxXY: number, maxZ: number) {
  let frames = input.frames.map(f => toScalarFrame(f, input.isGrayscale));
  if (frames.length < 2) frames = [frames[0] || [], frames[0] || []];

  const height = frames[0].length;
  const width = height > 0 ? frames[0][0].length : 0;
  const sx = strideFor(width, maxXY);
  const sy = strideFor(height, maxXY);
  const sz = strideFor(frames.length, maxZ);

  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  const value: number[] = [];
  for (let zi = 0; zi < frames.length; zi += sz) {
    for (let yi = 0; yi < height; yi += sy) {
      const rowArr = frames[zi][yi] || [];
      for (let xi = 0; xi < width; xi += sx) {
        x.push(xi * input.ratios[0]);
        y.push(yi * input.ratios[0]);
        z.push(zi);
        value.push(rowArr[xi]);
      }
    }
  }
  return { x, y, z, value };
}

/** SCATTER3D — downsampled voxels as intensity-coloured 3D markers. */
function buildScatter3dTraces(input: TraceBuildInput): any[] {
  const { x, y, z, value } = sampleVolume(input, 48, 40);
  return [{
    type: 'scatter3d',
    mode: 'markers',
    x, y, z,
    marker: {
      size: 2,
      color: value,
      colorscale: input.colorscale,
      reversescale: input.reversescale,
      opacity: 0.8,
    },
    name: 'Voxels',
  }];
}

/** ISOSURFACE — iso-intensity surfaces over the downsampled volume grid.
 *  isomin/isomax come straight from the toolbar range slider (0–255). */
function buildIsosurfaceTraces(input: TraceBuildInput): any[] {
  const { x, y, z, value } = sampleVolume(input, 40, 40);
  // The caller (PlotlyService) maps the 0–255 slider onto the volume's real
  // intensity range before this runs, so the band always sits inside the data.
  // We only guard ordering here.
  const isoMin = Math.min(input.isoMin, input.isoMax);
  const isoMax = Math.max(input.isoMin, input.isoMax);
  return [{
    type: 'isosurface',
    x, y, z, value,
    isomin: isoMin,
    isomax: isoMax,
    // A few nested levels (not just the two band extremes): even if an extreme
    // grazes the data edge and draws nothing, an interior level still renders,
    // so the volume is never silently empty.
    surface: { count: 3 },
    colorscale: input.colorscale,
    reversescale: input.reversescale,
    opacity: 0.6,
    caps: { x: { show: false }, y: { show: false }, z: { show: false } },
    name: 'Isosurface',
  }];
}

/** Registry of the pluggable (non-original) plot types. */
export const PLOTLY_PLOT_TYPE_IMPLS: Partial<Record<PlotType, PlotlyPlotTypeImpl>> = {
  [PlotType.CONTOUR]:    { buildTraces: buildContourTraces,    layoutKind: '2d-image',   threeD: false },
  [PlotType.SCATTER]:    { buildTraces: buildScatterTraces,    layoutKind: '2d-overlay', threeD: false },
  [PlotType.SCATTER3D]:  { buildTraces: buildScatter3dTraces,  layoutKind: '3d-volume',  threeD: true },
  [PlotType.ISOSURFACE]: { buildTraces: buildIsosurfaceTraces, layoutKind: '3d-volume',  threeD: true },
};

export function getPlotTypeImpl(type: PlotType): PlotlyPlotTypeImpl | undefined {
  return PLOTLY_PLOT_TYPE_IMPLS[type];
}
