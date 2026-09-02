import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

import {
  SpatialColumn, SpatialDataset, SpatialPolygons,
} from '../spatial-dataset.contract';

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
