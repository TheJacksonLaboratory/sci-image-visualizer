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
  /**
   * Heading the column is listed under in a group picker — e.g. "Xenium Onboard Analysis
   * groups" for a pipeline's clusterings, "Imported groups" for ones added by a user.
   */
  section?: string;
  /**
   * Columns that are variants of one choice — k-means at k = 2…10 — share a family: a
   * picker lists the family once and offers the variants beside it.
   */
  family?: { id: string; label: string; variant: string };
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

/** Descriptor of one per-observation column, discriminated by `kind`. */
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

/** A loaded column with its values, discriminated by `meta.kind`. */
export type SpatialColumn = CategoricalColumn | ContinuousColumn;

/** Narrow a loaded column to a categorical one. */
export function isCategoricalColumn(c: SpatialColumn): c is CategoricalColumn {
  return c.meta.kind === 'categorical';
}
/** Narrow a loaded column to a continuous one. */
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
 * A precomputed low-dimensional embedding over the SAME observations — UMAP, t-SNE, PCA.
 *
 * Announced in the dataset and fetched on demand, exactly like a column or a gene: the
 * coordinates are another per-observation vector, and a dataset may carry several.
 */
export interface SpatialEmbeddingMeta {
  /** Key as the source names it, e.g. `X_umap`. */
  name: string;
  /** Short label for menus; falls back to {@link name}. */
  label?: string;
  /** 2 for a plane, 3 for a cloud. */
  dims: 2 | 3;
  /**
   * True when the coordinates were COMPUTED for this bundle rather than published with the
   * dataset. Worth surfacing: a UMAP recomputed with different parameters is a different picture,
   * and a reader comparing against a paper's figure needs to know which they are looking at.
   */
  derived?: boolean;
  /**
   * Fraction of total variance each axis accounts for, index-aligned with the dimensions.
   *
   * Only meaningful for a LINEAR embedding — PCA. Its axes are ordered, and each one explains a
   * measurable share of the variance, which is the whole reason to look at a PCA rather than a
   * UMAP: "PC1 (23%)" says something, where "UMAP 1" says nothing at all. A UMAP's coordinates
   * are an arbitrary output of an optimisation with no variance to report, so this stays absent
   * there rather than being faked.
   */
  varianceRatio?: number[];
  /**
   * How a derived embedding was computed, in a few words — e.g. "PCA(50) then perplexity 30,
   * seed 0".
   *
   * Not decoration. A t-SNE or UMAP is stochastic, and its picture changes materially with
   * perplexity or `n_neighbors`; two runs at different settings are different pictures of the same
   * cells, and neither is more correct. Saying "computed here" without saying HOW leaves a reader
   * unable to reproduce or compare it. Absent for a published embedding, whose parameters belong
   * to whoever published it.
   */
  params?: string;
}

/**
 * One embedding's coordinates.
 *
 * Deliberately shaped like {@link SpatialObservations}' `x`/`y`/`z` rather than an (N, D) matrix:
 * the point of an embedding here is to be swapped in as the scatter's coordinate source, and
 * matching that shape means the renderer, the hover hit-test and the selection code need no
 * variant for it.
 */
export interface SpatialEmbedding {
  meta: SpatialEmbeddingMeta;
  x: Float32Array;
  y: Float32Array;
  z?: Float32Array;
}

/**
 * Level-of-detail geometry, served one grid tile at a time.
 *
 * Whole-dataset vectors stop working somewhere past 10^5 observations: 717k Xenium cell
 * outlines are ~140 MB, and a whole-transcriptome run has ~10^9 transcripts. What scales
 * is what map tiles do — a square grid in the observations' coordinate space, one grid
 * per level, each level's tiles twice the size of the one below and carrying coarser
 * geometry. The renderer asks only for the tiles on screen, at the level the zoom needs.
 *
 * Tile `(gx, gy)` at level `l` covers `[gx·s, (gx+1)·s) × [gy·s, (gy+1)·s)` with
 * `s = levels[l].tileSize`, in the same units as {@link SpatialObservations.x}.
 */
export interface SpatialTileLevel {
  /** Edge length of one tile, in observation coordinate units. */
  tileSize: number;
}

/** Axis-aligned extent `[minX, minY, maxX, maxY]` in observation coordinates. */
export type SpatialBounds = [number, number, number, number];

/** Tiled cell/nucleus boundaries. Level 0 is the finest (every vertex). */
export interface SpatialPolygonTilesMeta {
  bounds: SpatialBounds;
  /** Boundary sets on offer — typically `cell` and `nucleus`. */
  sets: { name: string; label: string }[];
  /** The set to draw when the user has not chosen. */
  defaultSet?: string;
  levels: SpatialTileLevel[];
}

/** Tiled transcripts. Level 0 is one entry per transcript; coarser levels aggregate. */
export interface SpatialTranscriptTilesMeta {
  bounds: SpatialBounds;
  /** Total transcripts, for display. */
  count?: number;
  /** Real genes (control probes excluded). Names come from the feature search. */
  geneCount: number;
  hasZ: boolean;
  levels: (SpatialTileLevel & {
    /** True when an entry stands for several transcripts (see {@link SpatialTranscriptTile.weight}). */
    aggregated: boolean;
  })[];
  /**
   * Levels up to and including this one assign each entry to the cell it lies in
   * exactly; above it the assignment names the cell nearest an aggregate's centroid.
   */
  exactCellLevel?: number;
}

/**
 * The all-gene transcript grouping pyramid: square bins, four times coarser per level,
 * each holding a count, a centroid and the cell that contributed most of its transcripts.
 * Served per tile, in the {@link SpatialTranscriptTile} layout (one entry per bin).
 *
 * Tile `(tx, ty)` of level `l` covers `origin + [tx·s, (tx+1)·s) × [ty·s, (ty+1)·s)` with
 * `s = levels[l].tileSize` — note the origin, which the per-gene tiles do not have.
 */
export interface SpatialTranscriptBinsMeta {
  bounds: SpatialBounds;
  origin: [number, number];
  /** Transcripts the pyramid was built from. */
  count: number;
  levels: { binSize: number; tileSize: number }[];
}

/**
 * A grouping pyramid the server is still building (it builds one itself when a dataset
 * arrives without it). "All genes" becomes available once it is done.
 */
export interface SpatialTranscriptBinsStatus {
  state: 'queued' | 'building' | 'failed';
  /** Source tiles processed so far, of `total`. */
  done?: number;
  total?: number;
  message?: string;
}

/** What is in an area — the hover details of a transcript marker or grouped bin. */
export interface SpatialTranscriptSummary {
  /** Absent for a pure cell-id lookup. */
  transcripts?: number;
  /** Distinct genes among them. */
  genes?: number;
  topGenes?: { name: string; count: number }[];
  /** Distinct cells they fall in, and how many fall in none. */
  cells?: number;
  unassigned?: number;
  topCells?: { index: number; id?: string; count: number }[];
  /** Display ids of the cells asked for, by observation index. */
  cellIds?: Record<number, string>;
}

/** A per-gene transcript-count raster covering the section. */
export interface SpatialDensityMeta {
  /** Size of one raster cell, in observation units, `[x, y]`. */
  gridSize: [number, number];
  /** Observation-space position of raster cell (0, 0)'s near corner. */
  origin: [number, number];
  rows: number;
  cols: number;
}

/** "No observation" in {@link SpatialTranscriptTile.observation}. */
export const NO_OBSERVATION = 0xffffffff;

/** One tile of boundaries: rings as in {@link SpatialPolygons}, plus who owns each ring. */
export interface SpatialPolygonTile extends SpatialPolygons {
  /** Observation index of ring `i` — the join key to columns and features. */
  observation: Uint32Array;
}

/** One tile of transcripts (or aggregates of them). Every array has length {@link count}. */
export interface SpatialTranscriptTile {
  readonly count: number;
  aggregated: boolean;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Transcripts each entry stands for — 1 at an unaggregated level. */
  weight: Uint32Array;
  /** Observation (cell) the entry falls in, or {@link NO_OBSERVATION}. */
  observation: Uint32Array;
  /** Index into the `genes` list the tile was requested with. */
  gene: Uint16Array;
}

/** The per-gene levels: each level's bin and tile size, on the all-gene pyramid's grid. */
export interface SpatialTranscriptGeneBinsMeta {
  origin: [number, number];
  levels: { binSize: number; tileSize: number }[];
}

/**
 * Marker genes of each group of a categorical column: per group, the real genes most
 * specific to it, best first. A gene's score is its mean `log1p(count)` in the group minus
 * that in every other cell; it must be detected in at least 10% of the group's cells, and
 * in more of them than elsewhere.
 */
export interface SpatialMarkerGenes {
  column: string;
  groups: {
    name: string;
    /** Cells in the group. */
    cells: number;
    genes: { name: string; score: number; pctIn: number; pctOut: number }[];
  }[];
}

/** Transcript totals for an estimate of how many markers a selection would draw. */
export interface SpatialTranscriptCounts {
  /** Total transcripts per requested gene, over the whole dataset. */
  counts: Record<string, number>;
  /** Total over every gene. */
  total: number;
  /** Extent the totals are spread over (observation units). */
  bounds: SpatialBounds;
}

/** A summed density raster for a list of genes; `values` is row-major `rows × cols`. */
export interface SpatialDensityRaster {
  meta: SpatialDensityMeta;
  genes: string[];
  values: Float32Array;
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
  /** Embeddings available for these observations, whose coordinates are fetched on demand. */
  embeddings?: SpatialEmbeddingMeta[];
  /** Level-of-detail boundaries, fetched per tile — see {@link SpatialPolygonTilesMeta}. */
  polygonTiles?: SpatialPolygonTilesMeta;
  /** Level-of-detail transcripts, fetched per tile — see {@link SpatialTranscriptTilesMeta}. */
  transcriptTiles?: SpatialTranscriptTilesMeta;
  /** A served per-gene transcript density raster. */
  density?: SpatialDensityMeta;
  /** The all-gene transcript grouping pyramid, when it has been built. */
  transcriptBins?: SpatialTranscriptBinsMeta;
  /** Per-gene levels of the transcript pyramid (same bins): a gene selection at any zoom. */
  transcriptGeneBins?: SpatialTranscriptGeneBinsMeta;
  /** Present while the server is still building {@link transcriptBins}. */
  transcriptBinsStatus?: SpatialTranscriptBinsStatus;
  /**
   * Microns per observation coordinate unit — what makes a scale bar possible.
   *
   * The 2D path gets this from `imageRef.mppX`, because there the coordinates are
   * image pixels. A 3D cloud has no image, so it has to say for itself: `1` means
   * the coordinates are already microns.
   *
   * Absent means the unit is UNKNOWN, and a renderer must then draw no scale bar
   * rather than assume one. A bar labelled in microns over pixel-space
   * coordinates is worse than no bar: it looks like a measurement.
   */
  micronsPerUnit?: number;
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

/**
 * A selection over a dataset's N observations: `mask[i] === 1` when observation `i` is
 * selected, and `count` the number selected. Pure data, so it lives with the dataset
 * contract; the selection logic that builds one is in `spatial/spatial-selection.ts`.
 */
export interface SpatialSelectionMask {
  mask: Uint8Array;
  count: number;
}

/** Look a column's descriptor up by name. */
export function findColumnMeta(dataset: SpatialDataset, name: string): SpatialColumnMeta | undefined {
  return dataset.columns.find((c) => c.name === name);
}
