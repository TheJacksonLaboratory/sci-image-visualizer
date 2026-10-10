import { colormapFromLut, LUT_SIZE } from 'napari-js';
import type { Colormap } from 'napari-js';

import { Rgb } from '../../contracts/colormap-lut';
import { CategoricalColumn, NO_CATEGORY } from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import {
  contrastWindow,
  encodeContinuous,
  parseHex,
  resolveCategoryColors,
  MISSING_COLOR,
  SPATIAL_3D_MAX_CATEGORIES,
  type RGBA,
} from '../../spatial/spatial-encoding';
import { SpatialSelectionMask, maskToIndices } from '../../spatial/spatial-selection';

/**
 * The spatial scenes' pure colour and grouping math: what the 2D markers, the 3D cloud and the
 * density volumes are coloured with, as functions of the data, the view and a LUT. No viewer, no
 * port, no store (review Appendix B, step 1).
 */

/** Marker radius (image px) for a dataset that declares none — segmented cells often don't. */
export const SPATIAL_FALLBACK_RADIUS = 4;
/** Smallest marker DIAMETER, in slice pixels, over a volume-backed dataset. A cell's real
 *  size is honoured wherever it survives the grid: the ABC atlas serves 5 µm radii on a
 *  40 µm/px template, so drawing them to scale would put every cell a fifth of a pixel wide
 *  and the section would come up empty. The point-size control scales up from this floor. */
export const SPATIAL_SLICE_MIN_DIAMETER_PX = 1.5;
/** Longest side of the gene-map raster, in field pixels. A gene map is a smooth
 *  field read as territory, so it gains nothing from matching a 2 Gpx slide's
 *  resolution — and the estimate costs one pass over this many pixels. */
export const GENE_MAP_MAX_SIDE = 512;
/** Kernel σ in field pixels at smoothing 1: wide enough to read between cells,
 *  tight enough to keep a nucleus-scale structure distinct. */
export const GENE_MAP_SIGMA = 2.5;
/**
 * In-plane coarsening of the 3D gene map's lattice, relative to the reference
 * volume. The field is smooth, so its detail is set by the kernel rather than the
 * raster — and the estimate is a pair of separable blurs, which at the template's
 * full resolution means seconds of work per toggle.
 */
export const GENE_MAP_VOLUME_STRIDE = 2;
/** Clusters drawn as density volumes at once. Past a handful, additive translucent
 *  clouds stop being separable by eye — and each one is a full rasterisation. */
export const DENSITY_MAX_CLUSTERS = 6;
/** How much larger a selected marker is drawn, so a small selection is findable inside a
 *  3.7M-point cloud rather than merely brighter. */
export const SPATIAL_SELECTED_SIZE_SCALE = 1.6;
/** Base marker diameter for the 3D cloud, in SCREEN pixels (the layer's unit). */
export const SPATIAL_3D_BASE_SIZE = 3;

/** Colour for observations when nothing is selected to colour by: visible, neutral, and
 *  obviously not encoding anything. */
export const SPATIAL_NEUTRAL_COLOR: [number, number, number, number] = [0.35, 0.72, 0.95, 0.9];
/** {@link SPATIAL_NEUTRAL_COLOR} as a hex colour (alpha dropped), for the encoders and the
 *  density-volume tint. */
export const SPATIAL_NEUTRAL_HEX = `#${SPATIAL_NEUTRAL_COLOR.slice(0, 3)
  .map((c) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, '0'),
  )
  .join('')}`;

/**
 * Contrast windows memoised per (values array, lo, hi, log). `contrastWindow` sorts every value,
 * and the spatial colouring re-runs it on each opacity, selection or colormap change while the
 * coloured vector itself is unchanged (review SPATIAL-12). Keyed by the vector's identity, so a
 * new column or gene vector is a miss and an old one is collected with its windows.
 */
export class ContrastWindowCache {
  private readonly byVector = new WeakMap<Float32Array, Map<string, [number, number]>>();

  get(
    values: Float32Array,
    lo: number,
    hi: number,
    log: boolean,
    compute: () => [number, number],
  ): [number, number] {
    let windows = this.byVector.get(values);
    if (!windows) {
      windows = new Map();
      this.byVector.set(values, windows);
    }
    const key = `${lo}|${hi}|${log ? 1 : 0}`;
    let w = windows.get(key);
    if (!w) {
      w = compute();
      windows.set(key, w);
    }
    return w;
  }
}

/**
 * What the 3D points layer needs to colour a cloud: one scalar per point, a colormap, and the
 * window that maps scalars onto it. Categorical and continuous colourings both reduce to this,
 * because the layer offers no per-point colour channel.
 */
export interface Spatial3dEncoding {
  values: Float32Array;
  colormap: Colormap;
  contrastLimits: [number, number];
}

/** A one-colour colormap, for the "nothing to colour by" state. */
export function spatialFlatColormap(): Colormap {
  const [r, g, b] = SPATIAL_NEUTRAL_COLOR;
  const rgb: Rgb = [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  // Two identical stops: colormapFromLut needs at least two, and equal ends
  // make every value resolve to the same colour.
  return colormapFromLut('spatial-flat', [rgb, rgb]);
}

/**
 * Category codes → a stepped LUT, exact for up to {@link SPATIAL_3D_MAX_CATEGORIES}.
 *
 * Categorical data is smuggled through the 3D layer's scalar channel: codes map to LUT blocks,
 * and `contrastLimits` of `[-0.5, K - 0.5]` puts code `i` at the centre of block `i`, which is
 * what makes the round-trip exact instead of approximately right.
 */
export function encodeSpatial3dCategorical(codes: Uint16Array, colors: string[]): Spatial3dEncoding | null {
  // Slot 0 is reserved for "no category", so the palette occupies 1..K and the
  // block count is one more than the category count — which is why the published
  // ceiling is 95 categories rather than the LUT's 96 distinguishable blocks.
  if (colors.length > SPATIAL_3D_MAX_CATEGORIES) {
    console.warn(
      `[napari-js] ${colors.length} categories exceeds the ${SPATIAL_3D_MAX_CATEGORIES} the 3D ` +
        "layer's 256-entry LUT can hold distinctly; drawing flat instead of with wrong colours",
    );
    return null;
  }
  const k = colors.length + 1;
  const palette: Rgb[] = [MISSING_COLOR, ...colors.map(parseHex)];
  const lut: Rgb[] = new Array(LUT_SIZE);
  for (let j = 0; j < LUT_SIZE; j++) {
    lut[j] = palette[Math.min(k - 1, Math.floor((j * k) / LUT_SIZE))];
  }
  const values = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i++) {
    values[i] = codes[i] === NO_CATEGORY ? 0 : codes[i] + 1;
  }
  return {
    values,
    colormap: colormapFromLut('spatial-categories', lut),
    contrastLimits: [-0.5, k - 0.5],
  };
}

/** Continuous values → `lut` over a percentile-clipped window (log1p first when the view's log
 *  scale is on), for the 3D cloud's scalar channel. */
export function encodeSpatial3dContinuous(
  source: Float32Array,
  view: SpatialViewState,
  lut: Rgb[],
  windows: ContrastWindowCache,
): Spatial3dEncoding {
  const [lo, hi] = view.percentileClip ?? [0.01, 0.99];
  const log = !!view.logScale;
  let values = source;
  if (log) {
    values = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) values[i] = Math.log1p(Math.max(0, source[i]));
  }
  // Keyed by the SOURCE vector: the log copy above is new on every call.
  const [min, max] = windows.get(source, lo, hi, log, () => contrastWindow(values, lo, hi));
  return {
    values,
    colormap: colormapFromLut('spatial-continuous', lut),
    // A degenerate window would divide by zero in the shader's normalisation.
    contrastLimits: max > min ? [min, max] : [min, min + 1],
  };
}

/** Continuous values → per-point RGBA through `lut` and a clipped window (log scale per the
 *  view), for the 2D markers. */
export function encodeSpatialContinuous(
  values: Float32Array,
  view: SpatialViewState,
  lut: Rgb[],
  windows: ContrastWindowCache,
  muted: Uint8Array | null = null,
): Float32Array {
  const [lo, hi] = view.percentileClip ?? [0.01, 0.99];
  // The window is taken on the raw values (encodeContinuous applies the log itself).
  const [min, max] = windows.get(values, lo, hi, false, () => contrastWindow(values, lo, hi));
  return encodeContinuous(values, {
    lut,
    min,
    max,
    log: view.logScale,
    opacity: view.opacity,
    muted,
  });
}

/** Whether a colour input is one RGBA per point rather than one broadcast RGBA. */
export function isPerPoint(colors: RGBA[] | RGBA): colors is RGBA[] {
  return Array.isArray(colors[0]);
}

/** Per-point colours for the drawn subset. A broadcast tuple stays broadcast —
 *  it is one colour for every point either way. (A tuple is an array too, so it is told
 *  apart from a per-point list by its elements, not by `Array.isArray`.) */
export function gatherColors(colors: RGBA[] | RGBA, indices?: Uint32Array): RGBA[] | RGBA {
  if (!indices || !isPerPoint(colors)) return colors;
  const out: RGBA[] = new Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = colors[indices[i]];
  return out;
}

/** One density volume's observations: a cluster (or all cells), with its legend colour. */
export interface DensityGroup {
  name: string;
  color: string;
  indices?: Uint32Array;
}

/** The single group drawn when the colouring is not categorical: total cell density, within the
 *  selection when there is one. */
export function totalDensityGroup(selection: SpatialSelectionMask): DensityGroup {
  const inSelection = selection.count > 0 ? selection.mask : null;
  return {
    name: inSelection ? 'selected cells' : 'all cells',
    color: SPATIAL_NEUTRAL_HEX,
    indices: inSelection ? maskToIndices(inSelection) : undefined,
  };
}

/**
 * The clusters of a categorical column to rasterise, biggest first and capped at
 * {@link DENSITY_MAX_CLUSTERS}, each with its legend colour — restricted to the selection when
 * there is one, so "select a region, check the box" answers which clusters live there.
 */
export function rankDensityGroups(
  columnName: string,
  column: CategoricalColumn,
  count: number,
  selection: SpatialSelectionMask,
): DensityGroup[] {
  const inSelection = selection.count > 0 ? selection.mask : null;
  const colors = resolveCategoryColors(column.meta);
  const counts = new Uint32Array(column.meta.categories.length);
  for (let i = 0; i < count; i++) {
    if (inSelection && !inSelection[i]) continue;
    const code = column.codes[i];
    if (code !== NO_CATEGORY && code < counts.length) counts[code]++;
  }
  const ranked = Array.from(counts, (n, code) => ({ code, n }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, DENSITY_MAX_CLUSTERS);
  if (counts.filter((c) => c > 0).length > ranked.length) {
    console.warn(
      `[napari-js] ${columnName}: drawing the ${ranked.length} largest clusters as density ` +
        'volumes; more than that stop being separable by eye',
    );
  }
  return ranked.map(({ code }) => {
    const indices = new Uint32Array(counts[code]);
    let k = 0;
    for (let i = 0; i < count; i++) {
      if (inSelection && !inSelection[i]) continue;
      if (column.codes[i] === code) indices[k++] = i;
    }
    return {
      name: column.meta.categories[code],
      color: colors[code] ?? '#888888',
      indices: indices.subarray(0, k),
    };
  });
}
