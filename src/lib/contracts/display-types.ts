/**
 * Publication-critical types that were `any` on the public contracts
 * (refactoring plan, Step 6). Deliberately permissive — every field optional —
 * so existing hosts (which pass PrimeNG `TreeNode`s and plain option objects)
 * keep compiling unchanged while consumers finally get named shapes.
 */

/** A colormap value as Plotly understands it: a built-in scale name (e.g.
 *  'Viridis') or an inline array of `[stop, color]` pairs. */
export type ColormapValue = string | Array<[number, string]>;

/** One node of the colormap selector tree (structurally compatible with the
 *  PrimeNG `TreeNode`s the host passes): group nodes carry `children`, leaf
 *  nodes carry the scale in `data.value` (+ a preview image in `data.src`). */
export interface ColormapNode {
  label?: string;
  data?: { value?: ColormapValue; src?: string };
  children?: ColormapNode[];
}

/** Magic-wand pixel-comparison space. */
export type WandType = 'GRAY' | 'RGB' | 'LAB_DISTANCE';

/** Options for the magic-wand tool (QuPath-style). */
export interface IWandOptions {
  type?: WandType;
  /** Gaussian sigma applied to the patch before thresholding. */
  sigma?: number;
  /** Higher = stricter (smaller selection) for GRAY/RGB; higher = looser for
   *  LAB_DISTANCE — matches QuPath. */
  sensitivity?: number;
  /** Square patch size in pixels (must be odd). */
  patchSize?: number;
  /** When true, skip blur/threshold and flood-fill at exact-match
   *  (Cmd/Ctrl-click in QuPath). */
  simpleMode?: boolean;
}

/** Options for the brush region tool (QuPath-style). */
export interface IBrushOptions {
  /** Brush diameter in matrix (image) pixels. */
  size?: number;
}

/** What drives point colour in the spatial-omics mode: an annotation column
 *  from the dataset, or one feature (gene) vector fetched on demand. */
export interface SpatialColorBy {
  kind: 'column' | 'feature';
  name: string;
}

/** Display state for the spatial-omics plot mode. Lives in `VisualizerStore`
 *  alongside the colormap/channel state so the renderer reacts to edits the
 *  same way it does for an image. */
export interface SpatialViewState {
  /** Colour source; `null` renders every observation in one neutral colour
   *  (useful on its own — it shows where the tissue actually is). */
  colorBy: SpatialColorBy | null;
  /** Multiplier on the dataset's physical marker size. 1 = true size, which for
   *  a 55 µm Visium spot is correct but can be invisible when zoomed out. */
  pointScale: number;
  /** Alpha for points that are not muted. */
  opacity: number;
  /** Log-scale continuous values before mapping them onto the colormap. Seeded
   *  from the column's `logScaleHint` — count data needs it. */
  logScale: boolean;
  /** Percentile clip for the contrast window as `[lo, hi]` fractions, so a
   *  handful of saturated observations don't flatten the rest. */
   percentileClip: [number, number];
  /**
   * Draw each cluster as a translucent DENSITY volume alongside the 3D cloud.
   *
   * Serial sections hundreds of microns apart make a cloud hard to read as an
   * anatomical distribution — the eye cannot integrate discs into a shape. A
   * density field can be estimated between the imaged planes (a continuous
   * estimate, unlike individual cells, which have no correspondence to
   * interpolate along) and renders as a cloud that reads as an estimate.
   */
  densityVolume: boolean;
  /** Multiplier on the default kernel bandwidth. Above 1 is smoother and less
   *  committal; below 1 exposes the individual sections. */
  densitySmoothing: number;
}

export const DEFAULT_SPATIAL_VIEW: SpatialViewState = {
  colorBy: null,
  pointScale: 1,
  opacity: 1,
  logScale: false,
  percentileClip: [0.01, 0.99],
  densityVolume: false,
  densitySmoothing: 1,
};
