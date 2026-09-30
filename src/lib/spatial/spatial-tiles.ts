/**
 * Level-of-detail planning for tiled spatial geometry — cell outlines and transcripts.
 *
 * The renderer knows its camera (a world-space centre, a zoom in canvas pixels per world
 * unit, a canvas size); a tiled dataset knows its grids (one per level, in observation
 * units). This module is the bridge: which level the zoom calls for, which tiles are on
 * screen, how big a transcript marker should be. Everything here is pure, so the policy
 * — the part that decides whether the view is fast and legible — is testable without a
 * GPU.
 *
 * Observation units map onto world units through the dataset's `imageRef` affine
 * (`world = data · scale + translate`), so "pixels per observation unit" is
 * `zoom · scale`. For a Xenium bundle the data unit is the micron and the world unit the
 * morphology pixel.
 */

import type {
  SpatialBounds, SpatialImageRef, SpatialTileLevel,
} from '../contracts/spatial-dataset.contract';
import type { SpatialViewState, TranscriptGlyphName } from '../contracts/display-types';
import type { SpatialDataset } from '../contracts/spatial-dataset.contract';

/** A rectangle in observation coordinates. */
export interface DataRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Tile address. */
export interface TileKey {
  level: number;
  gx: number;
  gy: number;
}

/** Whether cell outlines are drawn: the user's choice, else on when the dataset has any. */
export function cellsShown(
  dataset: Pick<SpatialDataset, 'polygonTiles' | 'polygons'> | null,
  view: Pick<SpatialViewState, 'showCells'>,
): boolean {
  const available = !!(dataset?.polygonTiles || dataset?.polygons);
  return available && (view.showCells ?? true);
}

/** A column holding a hand-curated cell-type annotation, by naming convention. */
export function isCuratedColumn(name: string): boolean {
  return /curated/i.test(name);
}

/**
 * The categorical column that names each cell's type: the view's choice when it is a
 * column of this dataset, else the first categorical column that is not a curated
 * annotation (a pipeline's clustering is the default; curation is opted into), else
 * any categorical column.
 */
export function cellTypeColumnFor(
  dataset: SpatialDataset, view: Pick<SpatialViewState, 'cellTypeColumn'>,
): string | null {
  const categorical = dataset.columns.filter((c) => c.kind === 'categorical');
  if (view.cellTypeColumn && categorical.some((c) => c.name === view.cellTypeColumn)) {
    return view.cellTypeColumn;
  }
  return (categorical.find((c) => !isCuratedColumn(c.name)) ?? categorical[0])?.name ?? null;
}

export function tileId(k: TileKey): string {
  return `${k.level}/${k.gx}/${k.gy}`;
}

/** Canvas pixels per observation unit along x, for a camera zoom and a data→world affine. */
export function pixelsPerDataUnit(zoom: number, ref?: SpatialImageRef | null): number {
  return zoom * Math.abs(ref?.scale?.[0] ?? 1);
}

/**
 * The part of observation space the camera shows, padded by `margin` (a fraction of the
 * viewport) so tiles just off screen are already there when a pan brings them in.
 */
export function visibleDataRect(
  center: readonly [number, number], zoom: number, canvasW: number, canvasH: number,
  ref?: SpatialImageRef | null, margin = 0.15,
): DataRect | null {
  if (!(zoom > 0) || !(canvasW > 0) || !(canvasH > 0)) return null;
  const sx = ref?.scale?.[0] ?? 1;
  const sy = ref?.scale?.[1] ?? 1;
  const tx = ref?.translate?.[0] ?? 0;
  const ty = ref?.translate?.[1] ?? 0;
  const halfW = (canvasW / zoom / 2) * (1 + 2 * margin);
  const halfH = (canvasH / zoom / 2) * (1 + 2 * margin);
  const wx0 = center[0] - halfW;
  const wx1 = center[0] + halfW;
  const wy0 = center[1] - halfH;
  const wy1 = center[1] + halfH;
  const ax = (wx0 - tx) / sx;
  const bx = (wx1 - tx) / sx;
  const ay = (wy0 - ty) / sy;
  const by = (wy1 - ty) / sy;
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/**
 * Tiles of one level intersecting `rect`, clipped to the dataset's `bounds` (so zooming
 * out over empty canvas does not ask for tiles that cannot exist). Ordered from the
 * rectangle's centre outward, so the middle of the screen fills in first.
 */
export function tilesInRect(
  rect: DataRect, level: number, levels: readonly SpatialTileLevel[],
  bounds?: SpatialBounds | null, limit = Infinity,
): TileKey[] {
  const size = levels[level]?.tileSize;
  if (!(size > 0)) return [];
  let { x0, y0, x1, y1 } = rect;
  if (bounds) {
    x0 = Math.max(x0, bounds[0]);
    y0 = Math.max(y0, bounds[1]);
    x1 = Math.min(x1, bounds[2]);
    y1 = Math.min(y1, bounds[3]);
    if (x1 < x0 || y1 < y0) return [];
  }
  const gx0 = Math.floor(x0 / size);
  const gx1 = Math.floor(x1 / size);
  const gy0 = Math.floor(y0 / size);
  const gy1 = Math.floor(y1 / size);
  const cx = (rect.x0 + rect.x1) / 2 / size;
  const cy = (rect.y0 + rect.y1) / 2 / size;
  const out: TileKey[] = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) out.push({ level, gx, gy });
  }
  out.sort((a, b) => ((a.gx + 0.5 - cx) ** 2 + (a.gy + 0.5 - cy) ** 2)
    - ((b.gx + 0.5 - cx) ** 2 + (b.gy + 0.5 - cy) ** 2));
  return out.length > limit ? out.slice(0, limit) : out;
}

/**
 * Typical cell diameter, in observation units, used to judge how large cells appear.
 * Derived from the per-observation radius when there is one; 12 µm otherwise.
 */
export function typicalCellDiameter(radius: Float32Array | number | undefined, fallback = 12): number {
  if (typeof radius === 'number') return radius > 0 ? radius * 2 : fallback;
  if (!radius?.length) return fallback;
  // The median of a sample is plenty — this sets a threshold, not a measurement.
  const step = Math.max(1, Math.floor(radius.length / 2048));
  const sample: number[] = [];
  for (let i = 0; i < radius.length; i += step) {
    if (radius[i] > 0) sample.push(radius[i]);
  }
  if (!sample.length) return fallback;
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1] * 2;
}

/**
 * On-screen cell diameter (px) at or above which each polygon level is used. A level
 * halves the vertices of the one below, so each should take over when the cell is about
 * half as large on screen. Below the last finite threshold outlines are not drawn at
 * all — a cell a few pixels wide is a dot, and the observation markers already draw it
 * as one.
 *
 * Xenium's fourth level (3 vertices per cell) is deliberately never used: seen on
 * screen it is a field of triangles, which reads as an artefact rather than as cells.
 * The dots below 8 px say the same thing more honestly.
 */
export const POLYGON_LEVEL_MIN_CELL_PX = [36, 18, 8, Infinity];

/**
 * Which polygon level suits this zoom, or -1 for "too small to outline".
 * `detail` > 1 prefers finer levels (sharper, slower); < 1 coarser.
 */
export function polygonLevelFor(
  pxPerUnit: number, cellDiameter: number, levelCount: number, detail = 1,
): number {
  const cellPx = pxPerUnit * cellDiameter * detail;
  const table = POLYGON_LEVEL_MIN_CELL_PX;
  for (let l = 0; l < levelCount; l++) {
    // Past the table, keep halving: each level still halves the vertices.
    const min = table[l] ?? table[table.length - 1] / 2 ** (l - table.length + 1);
    if (cellPx >= min) return l;
  }
  return -1;
}

/**
 * Which transcript level suits this zoom: the one whose tiles come out closest to
 * `targetTilePx` on screen. Coarser levels aggregate more, so this keeps the number of
 * markers per screen roughly constant however far out the camera is — the property that
 * keeps the view fast.
 */
export function transcriptLevelFor(
  pxPerUnit: number, levels: readonly SpatialTileLevel[], targetTilePx = 512,
): number {
  if (!levels.length || !(pxPerUnit > 0)) return 0;
  let best = 0;
  let bestErr = Infinity;
  for (let l = 0; l < levels.length; l++) {
    const err = Math.abs(Math.log2((levels[l].tileSize * pxPerUnit) / targetTilePx));
    if (err < bestErr) {
      bestErr = err;
      best = l;
    }
  }
  return best;
}

/** Smallest and largest transcript marker, in canvas pixels. */
export const TRANSCRIPT_MIN_PX = 4;
export const TRANSCRIPT_MAX_PX = 32;
/**
 * Physical diameter a single transcript is drawn at, in µm — clearly larger than the
 * imaged spot (~0.3 µm) so it stays legible, and small enough that neighbouring
 * molecules inside one cell stay apart.
 */
export const TRANSCRIPT_PHYSICAL_UM = 1.2;

/**
 * Marker diameter in canvas pixels for an entry standing for `weight` transcripts.
 *
 * The convention spatial viewers share (deck.gl's `radiusMinPixels`/`radiusMaxPixels`,
 * Xenium Explorer's transcript size): a PHYSICAL size, clamped to a screen-pixel range.
 * Zoomed out, markers sit at the minimum and never vanish; zoomed in, they grow with the
 * tissue instead of shrinking to specks next to cells hundreds of pixels wide. A fixed
 * screen size does the opposite at high zoom, which is what made transcripts disappear
 * at pixel-level zoom.
 *
 * Aggregates grow with the cube root of their count: area ∝ count would let one dense
 * aggregate swallow its neighbours, the cube root keeps a 1000-transcript cluster clearly
 * larger than a 10-transcript one without covering the tile.
 *
 * `pxPerMicron` is omitted for data with no known physical unit; the marker is then
 * screen-sized only.
 */
export function transcriptMarkerPx(weight: number, scale = 1, pxPerMicron?: number): number {
  const counted = TRANSCRIPT_MIN_PX * Math.cbrt(Math.max(1, weight));
  const physical = pxPerMicron ? TRANSCRIPT_PHYSICAL_UM * pxPerMicron : 0;
  const px = Math.max(counted, physical) * scale;
  return Math.min(TRANSCRIPT_MAX_PX * Math.max(scale, 1), Math.max(TRANSCRIPT_MIN_PX * scale, px));
}

// ── Glyphs ────────────────────────────────────────────────────────────────────────────

/** Marker shapes for the transcript "icon" mode. All star-convex, so a fan fills them. */
export const TRANSCRIPT_GLYPHS = [
  'circle', 'star', 'triangle', 'square', 'diamond', 'cross', 'hexagon', 'triangle-down',
  'pentagon', 'x',
] as const;
export type TranscriptGlyph = typeof TRANSCRIPT_GLYPHS[number];
// The view state names glyphs without importing this module; keep the two in step.
const _glyphNamesMatch: TranscriptGlyph extends TranscriptGlyphName
  ? (TranscriptGlyphName extends TranscriptGlyph ? true : never) : never = true;
void _glyphNamesMatch;

/** Unit outline of a glyph, radius ≈ 1, centred on the origin, as `[x0, y0, x1, y1, …]`. */
export function glyphOutline(glyph: TranscriptGlyph): Float32Array {
  const poly = (n: number, rot = -Math.PI / 2, r = 1) => {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = rot + (i * 2 * Math.PI) / n;
      out[2 * i] = Math.cos(a) * r;
      out[2 * i + 1] = Math.sin(a) * r;
    }
    return out;
  };
  const star = (points: number, inner: number, rot = -Math.PI / 2) => {
    const out = new Float32Array(points * 4);
    for (let i = 0; i < points * 2; i++) {
      const a = rot + (i * Math.PI) / points;
      const r = i % 2 === 0 ? 1 : inner;
      out[2 * i] = Math.cos(a) * r;
      out[2 * i + 1] = Math.sin(a) * r;
    }
    return out;
  };
  // A plus built as a 12-gon: arms of half-width w.
  const plus = (w: number, rotate: boolean) => {
    const pts = [
      [w, -1], [w, -w], [1, -w], [1, w], [w, w], [w, 1],
      [-w, 1], [-w, w], [-1, w], [-1, -w], [-w, -w], [-w, -1],
    ];
    const out = new Float32Array(pts.length * 2);
    const c = Math.SQRT1_2;
    pts.forEach(([x, y], i) => {
      out[2 * i] = rotate ? (x - y) * c : x;
      out[2 * i + 1] = rotate ? (x + y) * c : y;
    });
    return out;
  };
  switch (glyph) {
    case 'circle': return poly(12);
    case 'star': return star(5, 0.45);
    case 'triangle': return poly(3);
    case 'triangle-down': return poly(3, Math.PI / 2);
    case 'square': return poly(4, Math.PI / 4, Math.SQRT2 * 0.8);
    case 'diamond': return poly(4, -Math.PI / 2);
    case 'hexagon': return poly(6, 0);
    case 'pentagon': return poly(5);
    case 'cross': return plus(0.32, false);
    case 'x': return plus(0.28, true);
  }
}

/** The glyph a gene gets by default: by its position in the selected list. */
export function defaultGlyphFor(slot: number): TranscriptGlyph {
  return TRANSCRIPT_GLYPHS[slot % TRANSCRIPT_GLYPHS.length];
}

/**
 * Expand point markers into glyph rings for a shapes layer: entry `i` becomes a copy of
 * `glyphs[gene[i]]` scaled to `radius[i]` and centred on `(x[i], y[i])`.
 */
export function glyphRings(
  x: Float32Array, y: Float32Array, radius: Float32Array, glyphOf: (i: number) => Float32Array,
): { coords: Float32Array; offsets: Uint32Array } {
  const n = x.length;
  const offsets = new Uint32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = total;
    total += glyphOf(i).length / 2;
  }
  offsets[n] = total;
  const coords = new Float32Array(total * 2);
  for (let i = 0; i < n; i++) {
    const g = glyphOf(i);
    const r = radius[i];
    let o = offsets[i] * 2;
    for (let k = 0; k < g.length; k += 2) {
      coords[o++] = x[i] + g[k] * r;
      coords[o++] = y[i] + g[k + 1] * r;
    }
  }
  return { coords, offsets };
}

// ── Discrete colouring through a colormap ─────────────────────────────────────────────

/**
 * A shapes layer colours through a colormap LUT, not per-shape RGBA. A categorical
 * palette becomes a piecewise-constant colormap: category `c` of `n` owns the band
 * `[c/n, (c+1)/n)`, and a shape takes the value at its band's centre, so the LUT's
 * linear filtering never blends two categories.
 *
 * Returns the stops (linear 0..1 RGB) and a function mapping a category code to the
 * value to hand the layer. `missing` is the colour of the extra band used for "no
 * category".
 */
export function discreteColormapStops(
  rgb: readonly (readonly [number, number, number])[], missing: readonly [number, number, number],
): { stops: { t: number; color: [number, number, number] }[]; valueOf: (code: number) => number } {
  const bands = [...rgb, missing];
  const n = bands.length;
  const stops: { t: number; color: [number, number, number] }[] = [];
  const eps = 1e-6;
  bands.forEach((c, i) => {
    const color: [number, number, number] = [c[0] / 255, c[1] / 255, c[2] / 255];
    stops.push({ t: i / n + (i === 0 ? 0 : eps), color });
    stops.push({ t: (i + 1) / n - (i === n - 1 ? 0 : eps), color });
  });
  const missingCode = n - 1;
  return {
    stops,
    valueOf: (code: number) => ((code < 0 || code >= missingCode ? missingCode : code) + 0.5) / n,
  };
}

// ── Density raster ────────────────────────────────────────────────────────────────────

/**
 * Separable Gaussian blur of a row-major raster, `sigma` in raster cells.
 *
 * A per-gene count raster at 10 µm is mostly zeros and ones — drawn as-is it is speckle,
 * not a density. A σ of one to two cells (10–20 µm, about a cell diameter) turns it into
 * a field that reads as territory while keeping structures a few cells wide.
 */
export function smoothRaster(values: Float32Array, rows: number, cols: number, sigma: number): Float32Array {
  if (!(sigma > 0)) return values.slice();
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += (kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(values.length);
  const out = new Float32Array(values.length);
  for (let y = 0; y < rows; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < cols) acc += values[row + xx] * kernel[k + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < rows) acc += tmp[yy * cols + x] * kernel[k + r];
      }
      out[y * cols + x] = acc;
    }
  }
  return out;
}

/**
 * Colour a density raster as RGBA bytes: log-scaled, windowed at a high percentile of the
 * non-zero values, and faded in from transparent so empty tissue shows what is under it.
 */
export function colorDensity(
  values: Float32Array, lut: readonly (readonly [number, number, number])[], opacity: number,
  { log = true, percentile = 0.995 } = {},
): Uint8Array {
  const n = values.length;
  const t = log ? values.map((v) => Math.log1p(Math.max(0, v))) : values;
  const positive: number[] = [];
  for (let i = 0; i < n; i++) if (t[i] > 0) positive.push(t[i]);
  positive.sort((a, b) => a - b);
  const at = Math.min(positive.length - 1, Math.floor(percentile * positive.length));
  const hi = positive.length ? positive[at] : 1;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const f = Math.min(1, t[i] / (hi || 1));
    if (f < 0.02) continue;
    const c = lut[Math.min(lut.length - 1, Math.round(f * (lut.length - 1)))];
    rgba[4 * i] = c[0];
    rgba[4 * i + 1] = c[1];
    rgba[4 * i + 2] = c[2];
    rgba[4 * i + 3] = Math.round(255 * opacity * Math.pow(f, 0.6));
  }
  return rgba;
}
