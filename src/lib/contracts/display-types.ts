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
   * Colormap for CONTINUOUS spatial colouring — a gene, a numeric column — as a
   * {@link ColormapValue}, the same shape the display colormap carries: a scale
   * NAME for the built-ins, or an inline `[stop, colour]` array for the rest.
   * Null follows the display colormap.
   *
   * Its own setting because the display colormap belongs to the tissue image and
   * is usually a grey ramp, which is the wrong thing to read a measurement
   * through: grey over grey cannot be told apart from the anatomy. Following it
   * (with a Viridis fallback for exactly that case) is a reasonable default and a
   * poor ceiling, since which gradient reads best is a judgement about the data.
   *
   * One setting for the markers, the 2D gene map and the 3D gene map together, so
   * the field under the cells and the cells over it cannot disagree about what a
   * colour means — and the panel's own colour bar is built from it too.
   */
  continuousColormap: ColormapValue | null;
  /**
   * What the 3D scene draws. The three things in it — the reference volume, the
   * observation cloud and the cluster density volumes — occupy the same space, so
   * any two of them hide each other to some degree. These are independent because
   * the useful views are the combinations: the volumes alone to read an estimated
   * distribution, one section's cells over them to check that estimate against the
   * measurement, the anatomy alone to find a landmark.
   *
   * Visibility only — the layers stay built, so toggling one back on is immediate
   * and does not re-run a rasterisation. {@link densityVolume} is the exception and
   * genuinely gates construction, because building six volumes is not free.
   */
  showVolume: boolean;
  /**
   * The reference volume's opacity.
   *
   * Its own, not {@link opacity} (which belongs to the markers): the volume is a
   * BACKDROP, and reading the cloud or a density field through it means turning
   * the anatomy down without touching the data drawn over it. Ranges lower than
   * the markers' slider for the same reason — a faint anatomical hint is a useful
   * setting for a backdrop and a useless one for the measurement.
   */
  volumeOpacity: number;
  /** Draw the observation cloud (3D). */
  showPoints: boolean;
  /**
   * Restrict the cloud to ONE imaged section, by index into the dataset's sampled
   * sections; null draws every section.
   *
   * The whole cloud is a stack of discs that hides whatever is drawn between them.
   * One section at a time is the view that answers "does the estimated field
   * actually follow the cells I measured" — and it is only offered for data that
   * really is sectioned (see `sampledSections`).
   */
  pointSection: number | null;
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
  /**
   * Draw the active GENE as a continuous field under the observations (2D).
   *
   * Colouring the markers by a gene says which cells express it; it cannot say
   * where, because the eye will not integrate thousands of dots into a territory.
   * The field is an estimate — a kernel-weighted mean per cell, transparent where
   * no cell was measured — and it is drawn beneath the cells, not instead of them,
   * so the measurement stays on screen next to the interpolation.
   *
   * Ignored unless the colour source is a gene: there is nothing else to map.
   */
  geneMap: boolean;
  /**
   * Restrict the 3D gene map to ONE imaged section, by index into the dataset's
   * sampled sections; null draws every section's sheet.
   *
   * Separate from {@link pointSection} so the combinations stay open: all the
   * sheets with one section's cells over them is a useful view, and so is one
   * sheet inside the whole cloud. Ignored while {@link geneMapVolume} is set —
   * interpolating a single section along z would smear one slide through the
   * specimen's whole depth and call it an estimate.
   */
  geneMapSection: number | null;
  /**
   * Smooth the per-section gene maps along z into a continuous VOLUME (3D).
   *
   * The sheets are what was measured — one field per imaged slide, with the gaps
   * between them empty. This turns them into an estimate defined between the
   * slides, the same move the cluster density volumes make and with the same
   * caveat: a field may be interpolated between sections, individual cells may
   * not, and the result is drawn as a translucent cloud so it cannot be mistaken
   * for measurement.
   */
  geneMapVolume: boolean;
  /** Multiplier on the gene map's kernel bandwidth. */
  geneMapSmoothing: number;
  /** The gene map's own opacity. Separate from {@link opacity}, which belongs to
   *  the markers: turning the cells down to read the field underneath must not
   *  turn the field down with them. */
  geneMapOpacity: number;
}

export const DEFAULT_SPATIAL_VIEW: SpatialViewState = {
  colorBy: null,
  pointScale: 1,
  opacity: 1,
  logScale: false,
  percentileClip: [0.01, 0.99],
  continuousColormap: null,
  showVolume: true,
  volumeOpacity: 0.5,
  showPoints: true,
  pointSection: null,
  densityVolume: false,
  densitySmoothing: 1,
  geneMap: false,
  geneMapSection: null,
  geneMapVolume: false,
  geneMapSmoothing: 1,
  geneMapOpacity: 0.85,
};
