import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import {
  SpatialColumn, SpatialDataset, SpatialDensityRaster, SpatialEmbedding, SpatialPolygonTile,
  CategoricalColumnMeta, SpatialMarkerGenes, SpatialPolygons, SpatialTranscriptCounts, SpatialTranscriptSummary,
  SpatialTranscriptTile,
} from '../spatial-dataset.contract';

/** Options for {@link SpatialDataPort.getTranscriptTile}. */
export interface TranscriptTileQuery {
  /**
   * Genes to include, by name; the tile's `gene` codes index this list. `[ALL_GENES]`
   * asks for every gene, unaggregated, at level 0 only and clipped to {@link box} — the
   * `gene` codes are then the dataset's own gene indices.
   */
  genes: string[];
  /** `high` (default) keeps only confidently decoded transcripts. */
  quality?: 'high' | 'all';
  /** Clip to `[x0, y0, x1, y1]` in observation units. */
  box?: [number, number, number, number];
}

/** {@link TranscriptTileQuery.genes} value meaning "every gene". */
export const ALL_GENES = '*';

/**
 * Spatial-omics data access, inverted as a port so the visualization library
 * never learns how the data is stored or served — exactly like
 * `TILE_ACCESS_PORT` for tiles and `REGION_IO_PORT` for annotations. The host
 * supplies an adapter; the library consumes typed arrays.
 *
 * WHY A PORT AND NOT A READER
 * ---------------------------
 * The interchange format for this data (SpatialData Zarr v3 + AnnData
 * conventions + GeoParquet shapes) needs three parsers, and its expression
 * matrix is stored observation-major — so reading a single gene's column means
 * touching every row. A server can pre-index that once; a browser cannot. So
 * the library takes vectors it can render and leaves ingest to whoever owns the
 * data. `SpatialDataHttpService` is a ready-made adapter for the wire format
 * the bundled example server speaks; a host with its own backend implements
 * this interface instead.
 *
 * LAZINESS IS THE POINT
 * ---------------------
 * `getDataset$()` yields only what is cheap to hold: coordinates plus column
 * and feature *metadata*. Every accessor below fetches one vector at a time,
 * for the one column or gene currently being displayed.
 */
export interface SpatialDataPort {
  /**
   * The dataset currently being visualized, or null when none is selected.
   * Emits again when the host switches datasets, so the view can rebuild.
   */
  getDataset$(): Observable<SpatialDataset | null>;

  /**
   * Values for one annotation column, index-aligned with the observations.
   * The column must be one advertised in `SpatialDataset.columns`; reject
   * (don't resolve empty) when it isn't, so a typo surfaces instead of
   * rendering as "no data".
   *
   * Implementations should cache — colouring by cluster, then by a gene, then
   * back by cluster must not refetch.
   */
  getColumn(name: string): Promise<SpatialColumn>;

  /**
   * One feature's (gene's) expression vector, index-aligned with the
   * observations. Rejects for an unknown feature.
   */
  getFeatureVector(name: string): Promise<Float32Array>;

  /**
   * One embedding's coordinates, index-aligned with the observations.
   *
   * The name must be one advertised in `SpatialDataset.embeddings`; rejects otherwise, for the
   * same reason `getColumn` does — a typo should surface rather than render as an empty plot.
   *
   * Optional: a host with no embeddings simply omits it, and the UI offers no embedding views.
   */
  getEmbedding?(name: string): Promise<SpatialEmbedding>;

  /**
   * Typeahead over feature names, for datasets too wide to inline the list
   * (`SpatialFeatureMeta.names` absent). Optional: a host whose panel is small
   * enough to inline every name need not implement it — the UI falls back to
   * filtering `names` locally.
   */
  searchFeatures?(query: string, limit?: number): Promise<string[]>;

  /**
   * Per-observation boundary geometry, when the dataset advertises
   * `polygons`. Optional — a spot-based assay (Visium) has no segmentation.
   */
  getPolygons?(): Promise<SpatialPolygons>;

  /**
   * One tile of boundaries from `polygonTiles`. An empty tile resolves with `count` 0 —
   * a tile outside the tissue is an answer, not an error. Optional: only datasets that
   * advertise `polygonTiles` need it.
   */
  getPolygonTile?(set: string, level: number, gx: number, gy: number): Promise<SpatialPolygonTile>;

  /**
   * One tile of transcripts from `transcriptTiles`, restricted to `query.genes`.
   * Optional: only datasets that advertise `transcriptTiles` need it.
   */
  getTranscriptTile?(
    level: number, gx: number, gy: number, query: TranscriptTileQuery,
  ): Promise<SpatialTranscriptTile>;

  /**
   * One tile of the all-gene grouping pyramid (`transcriptBins`): an entry per bin, with
   * `weight` its transcript count and `observation` its dominant cell.
   */
  getTranscriptBins?(level: number, tx: number, ty: number): Promise<SpatialTranscriptTile>;

  /**
   * One tile of the per-gene levels for `genes`: each entry is one gene's transcripts in one bin
   * (centroid, count, dominant cell); its `gene` is the position in `genes`. Optional.
   */
  getTranscriptGeneBins?(level: number, tx: number, ty: number, genes: string[]): Promise<SpatialTranscriptTile>;

  /**
   * What is inside `box` (observation units): transcript count, distinct genes and cells,
   * the most frequent of each — optionally restricted to `genes` — plus display ids for
   * `cells`. Omit `box` for a cell-id lookup only. Optional; drives the hover details of
   * transcript markers.
   */
  getTranscriptSummary?(query: {
    box?: [number, number, number, number]; genes?: string[]; cells?: number[];
  }): Promise<SpatialTranscriptSummary>;

  /**
   * The summed transcript density of `genes` (`[ALL_GENES]` for every gene) on the
   * dataset's `density` raster, re-binned to `binSize` observation units when given.
   * Optional: only datasets that advertise `density` need it.
   */
  getDensity?(genes: string[], binSize?: number): Promise<SpatialDensityRaster>;

  /**
   * Import a cell grouping — a CSV/TSV of `cell_id` and `group` — under `label`. The new
   * categorical column is added to the dataset (which re-emits) and resolved. Optional.
   */
  importGroups?(label: string, table: string): Promise<{ column: CategoricalColumnMeta; matched: number }>;

  /** Transcript totals per gene, for estimating how many markers a selection draws. */
  getTranscriptCounts?(genes: string[]): Promise<SpatialTranscriptCounts>;

  /**
   * The top `perGroup` marker genes of every group of categorical `column`, for building
   * gene groups from cell clusters ("Macrophages: CD163, MRC1, …"). Optional, and possibly
   * slow the first time: the server makes one pass over the expression matrix.
   */
  getMarkerGenes?(column: string, perGroup?: number): Promise<SpatialMarkerGenes>;

  /**
   * The reference volume's voxels: a uint8 scalar field, x-fastest, of exactly
   * `width * height * depth` bytes as the dataset's {@link SpatialVolumeMeta}
   * declares.
   *
   * Optional, and only meaningful when the dataset advertises a volume. Separate
   * from `getDataset$()` because it is megabytes: a host that never opens the 3D
   * mode should never pay for it.
   */
  getVolume?(): Promise<Uint8Array>;

  /**
   * Server-side "which observations fall inside this polygon", for datasets
   * too large to hit-test client-side. Optional: without it the library
   * point-in-polygons the resident coordinates itself, which is fine into the
   * 10^5 range. Coordinates are in the same space as the observations.
   */
  queryRoi?(polygon: { x: number[]; y: number[] }): Promise<Uint32Array>;
}

export const SPATIAL_DATA_PORT = new InjectionToken<SpatialDataPort>('SPATIAL_DATA_PORT');
