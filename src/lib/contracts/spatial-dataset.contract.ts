/**
 * Backend-neutral data model for a **spatial-omics dataset**: N observations
 * (Visium spots, segmented cells, nuclei, …) positioned in the pixel space of a
 * tissue image, each carrying categorical and continuous annotations, plus an
 * optional feature (gene) matrix and optional per-observation boundaries.
 *
 * DESIGN
 * ------
 * 1. **Struct-of-arrays, not object-per-cell.** Real datasets run 10^3 (Visium)
 *    to 10^6 (Xenium/CosMx) observations. `{x, y}[]` at 500k cells is ~500k
 *    objects the GC has to walk; two `Float32Array`s are two allocations and
 *    upload to the GPU without a copy.
 *
 * 2. **Metadata is eager, values are lazy.** A dataset advertises *which*
 *    columns and features exist ({@link SpatialColumnMeta},
 *    {@link SpatialFeatureMeta}); the vectors themselves are fetched on demand
 *    through {@link SpatialDataPort}. A Visium table is ~30k genes wide — the
 *    dense matrix is ~800 MB — so "load the dataset" can never mean "load the
 *    matrix". Only the handful of columns actually being displayed is resident.
 *
 * 3. **Data stays data.** No I/O, no RxJS, no Angular in this file — the same
 *    rule `plotly-trace-builders.ts` follows. Fetching lives on the port.
 *
 * The shape mirrors how the field already stores this (SpatialData/AnnData:
 * `obs` annotations, `var` features, `obsm/spatial` coordinates, shapes with a
 * coordinate transform) so an adapter is a projection, not a translation.
 */

/**
 * Observation positions. Every array is length {@link count} and index-aligned:
 * observation `i` is at `(x[i], y[i])`, and column/feature vectors index the
 * same way. This shared index is the join key for the whole model.
 */
export interface SpatialObservations {
  /** N — number of observations. */
  readonly count: number;
  /** X in the reference image's pixel space (see {@link SpatialImageRef}). */
  x: Float32Array;
  /** Y in the reference image's pixel space. */
  y: Float32Array;
  /** Z, for serial sections or genuinely 3D assays. Absent for a single plane. */
  z?: Float32Array;
  /** Stable per-observation ids (barcodes, cell ids) for tooltips and export.
   *  Optional — omit for large datasets where the strings cost more than they
   *  are worth. */
  ids?: string[];
  /** Marker RADIUS in image pixels: one value shared by all observations (a
   *  Visium spot is a fixed 55 µm ⇒ `27.5 / mppX` px), or one per observation
   *  (segmented cells). Absent ⇒ the renderer picks a display default. */
  radius?: Float32Array | number;
}

/** Fields common to every column descriptor. */
interface SpatialColumnMetaBase {
  /** Column name as the user sees it (`leiden`, `total_counts`). */
  name: string;
  /** Longer human-readable description for tooltips/menus. */
  description?: string;
}

/**
 * A discrete annotation — cluster, cell type, region, sample. Rendered as a
 * palette + legend; a legend click selects the category's observations.
 */
export interface CategoricalColumnMeta extends SpatialColumnMetaBase {
  kind: 'categorical';
  /** Category labels; a value's label is `categories[codes[i]]`. */
  categories: string[];
  /** Authored display colours as `#rrggbb`, index-aligned with
   *  {@link categories}. Supply these to keep the viewer's palette identical to
   *  the figures the same analysis produced in R/Python; omit to let the viewer
   *  derive one. */
  colors?: string[];
}

/**
 * A continuous measurement — expression, QC metric, area, density. Rendered
 * through the shared colormap/LUT + contrast window.
 */
export interface ContinuousColumnMeta extends SpatialColumnMetaBase {
  kind: 'continuous';
  /** Unit for axis/tooltip labels (`counts`, `µm²`). */
  unit?: string;
  /** True when the column reads best log-scaled — count data almost always
   *  does, and a linear scale collapses it against a few bright outliers. */
  logScaleHint?: boolean;
  /** Observed extremes, when the producer knows them. Lets the UI seed a
   *  contrast window and axis range without first scanning the vector. */
  min?: number;
  max?: number;
}

export type SpatialColumnMeta = CategoricalColumnMeta | ContinuousColumnMeta;

/**
 * Code meaning "this observation has no category" (unassigned / filtered out /
 * not in tissue). Renderers should draw it in the muted background style rather
 * than as a real category, and it must never index {@link
 * CategoricalColumnMeta.categories}.
 */
export const NO_CATEGORY = 0xffff;

/** A loaded categorical column: per-observation indices into `meta.categories`,
 *  or {@link NO_CATEGORY}. */
export interface CategoricalColumn {
  meta: CategoricalColumnMeta;
  /** Length = {@link SpatialObservations.count}. */
  codes: Uint16Array;
}

/** A loaded continuous column. `NaN` marks a missing value. */
export interface ContinuousColumn {
  meta: ContinuousColumnMeta;
  /** Length = {@link SpatialObservations.count}. */
  values: Float32Array;
}

export type SpatialColumn = CategoricalColumn | ContinuousColumn;

export function isCategoricalColumn(c: SpatialColumn): c is CategoricalColumn {
  return c.meta.kind === 'categorical';
}
export function isContinuousColumn(c: SpatialColumn): c is ContinuousColumn {
  return c.meta.kind === 'continuous';
}

/**
 * The feature (gene) matrix, described but never delivered whole. Vectors come
 * one at a time from {@link SpatialDataPort.getFeatureVector}.
 */
export interface SpatialFeatureMeta {
  /** Number of features available. */
  count: number;
  /**
   * All feature names, when the producer chose to inline them. Present for
   * targeted panels (Xenium/CosMx ship 300–5,000 genes ⇒ a few dozen KB) and
   * absent for whole-transcriptome data (Visium ships ~31k ⇒ ~350 KB), where
   * the UI should use {@link SpatialDataPort.searchFeatures} for typeahead
   * instead of downloading the list. Consumers must handle both.
   */
  names?: string[];
  /** What a feature value means (`log1p normalized`, `raw counts`). */
  unit?: string;
  /** True when feature vectors read best log-scaled (raw counts). */
  logScaleHint?: boolean;
}

/**
 * Per-observation boundaries (cell/nucleus segmentation, spot outlines) as flat
 * rings — deliberately NOT GeoJSON objects, which cost one object + one array
 * per cell and would dominate memory at 10^5 polygons.
 *
 * Ring `i` occupies `coords[2*offsets[i] .. 2*offsets[i+1])` as `x0,y0,x1,y1,…`
 * and is implicitly closed. `offsets` has length `count + 1`.
 */
export interface SpatialPolygons {
  coords: Float32Array;
  offsets: Uint32Array;
  /** Number of rings — `offsets.length - 1`. */
  readonly count: number;
}

/** Presence/size of the boundary geometry, without loading it. */
export interface SpatialPolygonsMeta {
  count: number;
}

/**
 * How observation coordinates relate to the tissue image they are drawn over.
 * Applied as `world = coord * scale + translate`, matching the affine that
 * SpatialData records per coordinate system — and the full-resolution world
 * convention the napari-js backend already uses so pre-saved regions align on
 * pyramidal slides.
 */
export interface SpatialImageRef {
  /** Host-defined id of the image these coordinates live in, so the host can
   *  resolve it to an `IImageInfo`. */
  imageId?: string;
  /** Data→world scale. Defaults to `[1, 1]` (coordinates already in
   *  full-resolution image pixels). */
  scale?: [number, number];
  /** Data→world translation, in the same units as {@link scale}'s output. */
  translate?: [number, number];
  /** Physical pixel size in µm — drives the scale bar and physical marker
   *  sizing (a 55 µm Visium spot). */
  mppX?: number;
  mppY?: number;
}

/**
 * A spatial-omics dataset: everything cheap enough to hold resident. Column and
 * feature *values*, and polygon *geometry*, are fetched through
 * {@link SpatialDataPort} as they are displayed.
 */
export interface SpatialDataset {
  /** Stable id — the key the port's lazy accessors are scoped to. */
  id: string;
  /** Human-readable name for menus. */
  name: string;
  observations: SpatialObservations;
  /** Every column available, whether or not its values are loaded. */
  columns: SpatialColumnMeta[];
  features?: SpatialFeatureMeta;
  polygons?: SpatialPolygonsMeta;
  imageRef?: SpatialImageRef;
  /** Presence + geometry of a reference volume the observations sit inside. */
  volume?: SpatialVolumeMeta;
}

/**
 * A 3D scalar reference volume registered to the observation coordinates — the
 * anatomical backdrop for a point cloud (an atlas template, or an image z-stack).
 *
 * Geometry only; the voxels are fetched through
 * {@link SpatialDataPort.getVolume} when something is going to draw them. A cloud
 * without one still renders, just in empty space.
 *
 * The observations' coordinate frame must be the volume's own: voxel `(i, j, k)`
 * covers `[i * voxelSize[0], (i + 1) * voxelSize[0])` on x, and so on. That means
 * the volume's near corner sits at the coordinate origin, so a renderer can place
 * the two together knowing nothing else.
 */
export interface SpatialVolumeMeta {
  width: number;
  height: number;
  depth: number;
  /** World size of one voxel per axis, in the observations' units. */
  voxelSize: [number, number, number];
}

/** Look a column's descriptor up by name. */
export function findColumnMeta(
  dataset: SpatialDataset, name: string,
): SpatialColumnMeta | undefined {
  return dataset.columns.find((c) => c.name === name);
}
