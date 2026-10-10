import {
  CategoricalColumnMeta,
  ContinuousColumnMeta,
  NO_CATEGORY,
  NO_OBSERVATION,
  SpatialColumn,
  SpatialColumnMeta,
  SpatialDataset,
  SpatialDensityMeta,
  SpatialDensityRaster,
  SpatialEmbedding,
  SpatialEmbeddingMeta,
  SpatialFeatureMeta,
  SpatialImageRef,
  SpatialObservations,
  SpatialPolygonTile,
  SpatialPolygonTilesMeta,
  SpatialPolygons,
  SpatialTranscriptBinsMeta,
  SpatialTranscriptGeneBinsMeta,
  SpatialTranscriptBinsStatus,
  SpatialTranscriptTile,
  SpatialTranscriptTilesMeta,
  SpatialVolumeMeta,
} from '../../contracts/spatial-dataset.contract';

/**
 * The wire format the bundled example server speaks, and its decoders.
 *
 * Pure by design — no Angular, no RxJS, no HTTP — so the format is testable on
 * its own and reusable by any transport (`SpatialDataHttpService` is one).
 * Mirrors the split in `plotly-trace-builders.ts`: the shape lives in a pure
 * module, the service just moves bytes.
 *
 * WHY BINARY
 * ----------
 * Vectors are one `Float32Array`/`Uint16Array` per request, delivered as raw
 * little-endian bytes. JSON would cost ~8–12× the size and a parse that
 * allocates one JS number per value; a typed-array view over the response
 * buffer is zero-copy and uploads to the GPU directly.
 *
 * ENDIANNESS
 * ----------
 * Little-endian, asserted at decode. Every platform a browser runs on today is
 * little-endian, so a `DataView` byte-by-byte read would cost real time for a
 * case that does not occur — but failing loudly beats rendering transposed
 * garbage if it ever does.
 *
 * ENDPOINTS (base = the server root)
 * ----------------------------------
 * Every route `SpatialDataHttpService` calls. `{id}` is the dataset id; names and
 * gene lists are URI-encoded.
 * ```
 * GET {base}/spatial/datasets              -> { datasets: [{ id, name, count }] }
 * GET {base}/spatial/{id}/manifest         -> SpatialManifest
 * GET {base}/spatial/{id}/coords           -> f32[N] x, f32[N] y, f32[N] z?
 * GET {base}/spatial/{id}/radius           -> f32[N]           (per-observation radius only)
 * GET {base}/spatial/{id}/ids              -> { ids: string[] } (hasIds only)
 * GET {base}/spatial/{id}/column/{name}    -> u16[N] codes | f32[N] values
 * GET {base}/spatial/{id}/feature/{name}   -> f32[N]
 * GET {base}/spatial/{id}/features?q=&limit= -> { names: string[] }
 * GET {base}/spatial/{id}/embedding/{name} -> f32[N] per dimension, see decodeEmbedding
 * GET {base}/spatial/{id}/polygons         -> u32 count, u32[count+1] offsets, f32[2*rings] coords
 * GET {base}/spatial/{id}/volume           -> u8[width*height*depth]   (manifest.volume only)
 * GET {base}/spatial/{id}/polygon-tile/{set}/{level}/{gx}/{gy}
 *                                          -> u32 count, u32[count] obs, u32[count+1] offsets, f32 coords
 * GET {base}/spatial/{id}/transcript-tile/{level}/{gx}/{gy}?genes=A,B&quality=high|all&box=
 *                                          -> see decodeTranscriptTile
 * GET {base}/spatial/{id}/transcript-bins/{level}/{tx}/{ty}
 *                                          -> transcript-tile layout, one entry per bin
 * GET {base}/spatial/{id}/gene-bins/{level}/{tx}/{ty}?genes=A,B
 *                                          -> transcript-tile layout, per-gene bins
 * GET {base}/spatial/{id}/density?genes=A,B&bin= -> see decodeDensity
 * GET {base}/spatial/{id}/transcript-summary?box=&genes=&cells= -> SpatialTranscriptSummary
 * GET {base}/spatial/{id}/transcript-counts?genes=A,B -> SpatialTranscriptCounts
 * GET {base}/spatial/{id}/markers/{column}?n=  -> SpatialMarkerGenes
 * POST {base}/spatial/{id}/groups?name=    (text/csv `cell_id,group`)
 *                                          -> { column: CategoricalColumnMeta, matched }
 * ```
 *
 * The optional routes are advertised in the manifest (`polygons`, `volume`,
 * `polygonTiles`, `transcriptTiles`, `transcriptBins`, `transcriptGeneBins`,
 * `density`); a server without them never sees them requested.
 */

/** Bumped when the layout changes incompatibly; the client refuses anything else. */
export const SPATIAL_WIRE_VERSION = 1;

/** Per-observation marker radius: one shared value, or a served f32 vector. */
export type SpatialRadiusSpec = { mode: 'uniform'; value: number } | { mode: 'per-observation' };

/** `GET /spatial/{id}/manifest` — everything cheap enough to send up front. */
export interface SpatialManifest {
  version: number;
  id: string;
  name: string;
  /** N — observation count; every served vector has exactly this length. */
  count: number;
  hasZ?: boolean;
  hasIds?: boolean;
  radius?: SpatialRadiusSpec;
  columns: SpatialColumnMeta[];
  features?: SpatialFeatureMeta;
  polygons?: { count: number };
  imageRef?: SpatialImageRef;
  volume?: SpatialVolumeMeta;
  embeddings?: SpatialEmbeddingMeta[];
  micronsPerUnit?: number;
  polygonTiles?: SpatialPolygonTilesMeta;
  transcriptTiles?: SpatialTranscriptTilesMeta;
  density?: SpatialDensityMeta;
  transcriptBins?: SpatialTranscriptBinsMeta;
  transcriptBinsStatus?: SpatialTranscriptBinsStatus;
  transcriptGeneBins?: SpatialTranscriptGeneBinsMeta;
}

/** `GET /spatial/datasets` */
export interface SpatialDatasetSummary {
  id: string;
  name: string;
  count: number;
}

/** True on a little-endian host. */
export function isLittleEndian(): boolean {
  const probe = new Uint16Array([1]);
  return new Uint8Array(probe.buffer)[0] === 1;
}

function assertLittleEndian(): void {
  if (!isLittleEndian()) {
    throw new Error(
      '[spatial] wire format is little-endian; this platform is big-endian. ' +
        'Serve JSON vectors, or byte-swap in a custom SpatialDataPort adapter.',
    );
  }
}

/** Guard a decode against a truncated or oversized response. */
function assertByteLength(buf: ArrayBuffer, expected: number, what: string): void {
  if (buf.byteLength !== expected) {
    throw new Error(
      `[spatial] ${what}: expected ${expected} bytes, got ${buf.byteLength}. ` +
        'Manifest count and served vector length disagree.',
    );
  }
}

/**
 * Reject a manifest this client cannot read, with a message naming the fix.
 *
 * Besides the version, the values every decoder sizes its views from: an observation
 * count that is not a non-negative integer, or an embedding that is not 2-D or 3-D, would
 * otherwise surface later as a RangeError deep inside a renderer.
 */
export function assertManifestVersion(manifest: SpatialManifest): void {
  if (manifest.version !== SPATIAL_WIRE_VERSION) {
    throw new Error(
      `[spatial] unsupported wire version ${manifest.version} ` +
        `(this client speaks ${SPATIAL_WIRE_VERSION}). Update the server or the library.`,
    );
  }
  if (!Number.isSafeInteger(manifest.count) || manifest.count < 0) {
    throw new Error(`[spatial] manifest count ${manifest.count} is not a non-negative integer`);
  }
  for (const e of manifest.embeddings ?? []) assertEmbeddingDims(e);
}

function assertEmbeddingDims(meta: SpatialEmbeddingMeta): void {
  if (meta.dims !== 2 && meta.dims !== 3) {
    throw new Error(`[spatial] embedding "${meta.name}": dims ${meta.dims} is not 2 or 3`);
  }
}

/**
 * Ring offsets must start at 0 and never go backwards: a decreasing pair is a negative
 * vertex count, which a renderer turns into `new Float32Array(negative)` on every frame.
 * (That the last offset matches the coordinate block is the byte-length check's job.)
 */
function assertRingOffsets(offsets: Uint32Array, what: string): void {
  if (offsets[0] !== 0) throw new Error(`[spatial] ${what}: offsets must start at 0`);
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] < offsets[i - 1]) {
      throw new Error(`[spatial] ${what}: offsets decrease at ring ${i - 1}`);
    }
  }
}

/** Every entry must name an observation below `count`, or {@link NO_OBSERVATION}. */
function assertObservations(observation: Uint32Array, count: number | undefined, what: string): void {
  if (count === undefined) return;
  for (let i = 0; i < observation.length; i++) {
    const o = observation[i];
    if (o >= count && o !== NO_OBSERVATION) {
      throw new Error(`[spatial] ${what}: observation ${o} is past the ${count} in the dataset`);
    }
  }
}

/** A header-sized prefix must be there before any view over it is made. */
function assertHeader(buf: ArrayBuffer, bytes: number, what: string): void {
  if (buf.byteLength < bytes) {
    throw new Error(`[spatial] ${what}: response too short for its header (${buf.byteLength} < ${bytes} bytes)`);
  }
}

/**
 * `GET /coords` → x/y(/z). One request rather than two or three: the vectors
 * are always fetched together, and a single response keeps them consistent if
 * the dataset changes underneath.
 */
export function decodeCoords(
  buf: ArrayBuffer,
  count: number,
  hasZ = false,
): Pick<SpatialObservations, 'x' | 'y' | 'z'> {
  assertLittleEndian();
  const axes = hasZ ? 3 : 2;
  assertByteLength(buf, count * axes * 4, 'coords');
  const x = new Float32Array(buf, 0, count);
  const y = new Float32Array(buf, count * 4, count);
  const z = hasZ ? new Float32Array(buf, count * 8, count) : undefined;
  return { x, y, z };
}

/** `GET /radius` → per-observation radii in image pixels. */
export function decodeRadius(buf: ArrayBuffer, count: number): Float32Array {
  assertLittleEndian();
  assertByteLength(buf, count * 4, 'radius');
  return new Float32Array(buf, 0, count);
}

/**
 * `GET /spatial/{id}/embedding/{name}` — one plane per dimension, same layout as coords.
 *
 * Struct of arrays, not interleaved: every dimension is contiguous, so an axis can be handed to
 * the renderer as a view with no copy and no stride.
 */
export function decodeEmbedding(buf: ArrayBuffer, meta: SpatialEmbeddingMeta, count: number): SpatialEmbedding {
  assertLittleEndian();
  assertEmbeddingDims(meta);
  assertByteLength(buf, count * meta.dims * 4, `embedding "${meta.name}"`);
  return {
    meta,
    x: new Float32Array(buf, 0, count),
    y: new Float32Array(buf, count * 4, count),
    ...(meta.dims === 3 ? { z: new Float32Array(buf, count * 8, count) } : {}),
  };
}

/** `GET /feature/{name}` → one gene's expression vector. */
export function decodeFeatureVector(buf: ArrayBuffer, count: number): Float32Array {
  assertLittleEndian();
  assertByteLength(buf, count * 4, 'feature vector');
  return new Float32Array(buf, 0, count);
}

/**
 * `GET /column/{name}` → a loaded column, typed by its descriptor: `u16` codes
 * for a categorical, `f32` values for a continuous. Codes outside the category
 * list are normalised to {@link NO_CATEGORY} so a renderer can trust the
 * invariant instead of bounds-checking every point.
 */
export function decodeColumn(buf: ArrayBuffer, meta: SpatialColumnMeta, count: number): SpatialColumn {
  assertLittleEndian();
  if (meta.kind === 'categorical') {
    assertByteLength(buf, count * 2, `column "${meta.name}"`);
    const codes = new Uint16Array(buf, 0, count);
    const n = (meta as CategoricalColumnMeta).categories.length;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] >= n) codes[i] = NO_CATEGORY;
    }
    return { meta: meta as CategoricalColumnMeta, codes };
  }
  assertByteLength(buf, count * 4, `column "${meta.name}"`);
  return { meta: meta as ContinuousColumnMeta, values: new Float32Array(buf, 0, count) };
}

/**
 * `GET /polygons` → boundary rings. Layout is
 * `[u32 count][u32 offsets × (count+1)][f32 coords × 2·offsets[count]]`; every
 * field is 4-byte wide so each typed-array view stays aligned.
 */
export function decodePolygons(buf: ArrayBuffer): SpatialPolygons {
  assertLittleEndian();
  if (buf.byteLength < 8) {
    throw new Error('[spatial] polygons: response too short for a header');
  }
  const count = new Uint32Array(buf, 0, 1)[0];
  const coordsByteOffset = 4 + (count + 1) * 4;
  assertHeader(buf, coordsByteOffset, 'polygons');
  const offsets = new Uint32Array(buf, 4, count + 1);
  assertRingOffsets(offsets, 'polygons');
  const vertexCount = offsets[count];
  assertByteLength(buf, coordsByteOffset + vertexCount * 2 * 4, 'polygons');
  const coords = new Float32Array(buf, coordsByteOffset, vertexCount * 2);
  return { coords, offsets, count };
}

/**
 * `GET /polygon-tile/...` → one tile of rings with their owning observations. Layout
 * `[u32 count][u32 obs × count][u32 offsets × (count+1)][f32 coords × 2·offsets[count]]`.
 *
 * `observations` is the dataset's N; when given, every owner must be below it.
 */
export function decodePolygonTile(buf: ArrayBuffer, observations?: number): SpatialPolygonTile {
  assertLittleEndian();
  if (buf.byteLength < 8) {
    throw new Error('[spatial] polygon tile: response too short for a header');
  }
  const count = new Uint32Array(buf, 0, 1)[0];
  const coordsByteOffset = 4 + count * 4 + (count + 1) * 4;
  assertHeader(buf, coordsByteOffset, 'polygon tile');
  const observation = new Uint32Array(buf, 4, count);
  const offsets = new Uint32Array(buf, 4 + count * 4, count + 1);
  assertRingOffsets(offsets, 'polygon tile');
  const vertexCount = offsets[count];
  assertByteLength(buf, coordsByteOffset + vertexCount * 8, 'polygon tile');
  assertObservations(observation, observations, 'polygon tile');
  return {
    count,
    observation,
    offsets,
    coords: new Float32Array(buf, coordsByteOffset, vertexCount * 2),
  };
}

/**
 * `GET /transcript-tile/...` → transcripts or aggregates. Layout, 4-byte aligned:
 * `[u32 n][u32 flags][f32 x·n][f32 y·n][f32 z·n][u32 weight·n][u32 obs·n][u16 gene·n, padded]`;
 * flags bit 0 marks an aggregated level.
 *
 * `limits` bounds the indices when the caller knows them: `observations` is the dataset's
 * N, and `genes` the length of the gene list the codes index (omit it for `ALL_GENES`).
 */
export function decodeTranscriptTile(
  buf: ArrayBuffer,
  limits: { observations?: number; genes?: number } = {},
): SpatialTranscriptTile {
  assertLittleEndian();
  if (buf.byteLength < 8) {
    throw new Error('[spatial] transcript tile: response too short for a header');
  }
  const [n, flags] = new Uint32Array(buf, 0, 2);
  const genePad = Math.ceil((n * 2) / 4) * 4;
  assertByteLength(buf, 8 + n * 20 + genePad, 'transcript tile');
  const observation = new Uint32Array(buf, 8 + n * 16, n);
  const gene = new Uint16Array(buf, 8 + n * 20, n);
  assertObservations(observation, limits.observations, 'transcript tile');
  if (limits.genes !== undefined) {
    for (let i = 0; i < n; i++) {
      if (gene[i] >= limits.genes) {
        throw new Error(`[spatial] transcript tile: gene code ${gene[i]} is past the ${limits.genes} asked for`);
      }
    }
  }
  return {
    count: n,
    aggregated: (flags & 1) === 1,
    x: new Float32Array(buf, 8, n),
    y: new Float32Array(buf, 8 + n * 4, n),
    z: new Float32Array(buf, 8 + n * 8, n),
    weight: new Uint32Array(buf, 8 + n * 12, n),
    observation,
    gene,
  };
}

/**
 * `GET /density?genes=&bin=` → the summed raster. Layout
 * `[u32 rows][u32 cols][f32 cellW][f32 cellH][f32 originX][f32 originY][f32 rows·cols]`:
 * the geometry travels with the values because re-binning changes it.
 */
export function decodeDensity(buf: ArrayBuffer, genes: string[]): SpatialDensityRaster {
  assertLittleEndian();
  if (buf.byteLength < 24) throw new Error('[spatial] density: response too short for a header');
  const [rows, cols] = new Uint32Array(buf, 0, 2);
  const [cw, ch, ox, oy] = new Float32Array(buf, 8, 4);
  // The cell size divides every downstream position; zero, negative or NaN is unusable.
  if (!(cw > 0 && ch > 0 && Number.isFinite(cw) && Number.isFinite(ch))) {
    throw new Error(`[spatial] density: grid size ${cw} x ${ch} is not positive and finite`);
  }
  assertByteLength(buf, 24 + rows * cols * 4, 'density');
  const meta: SpatialDensityMeta = { rows, cols, gridSize: [cw, ch], origin: [ox, oy] };
  return { meta, genes, values: new Float32Array(buf, 24, rows * cols) };
}

/**
 * Fold a manifest plus its fetched coordinate/id/radius vectors into the
 * library-facing {@link SpatialDataset}. Column and feature *values* are not
 * part of this — they stay lazy behind the port.
 */
export function datasetFromManifest(
  manifest: SpatialManifest,
  coords: Pick<SpatialObservations, 'x' | 'y' | 'z'>,
  extras: { ids?: string[]; radius?: Float32Array } = {},
): SpatialDataset {
  assertManifestVersion(manifest);
  const radius = manifest.radius?.mode === 'uniform' ? manifest.radius.value : extras.radius;
  const observations: SpatialObservations = {
    count: manifest.count,
    x: coords.x,
    y: coords.y,
    ...(coords.z ? { z: coords.z } : {}),
    ...(extras.ids ? { ids: extras.ids } : {}),
    ...(radius !== undefined ? { radius } : {}),
  };
  return {
    id: manifest.id,
    name: manifest.name,
    observations,
    columns: manifest.columns ?? [],
    ...(manifest.features ? { features: manifest.features } : {}),
    ...(manifest.polygons ? { polygons: manifest.polygons } : {}),
    ...(manifest.imageRef ? { imageRef: manifest.imageRef } : {}),
    ...(manifest.volume ? { volume: manifest.volume } : {}),
    ...(manifest.embeddings?.length ? { embeddings: manifest.embeddings } : {}),
    ...(manifest.micronsPerUnit !== undefined ? { micronsPerUnit: manifest.micronsPerUnit } : {}),
    ...(manifest.polygonTiles ? { polygonTiles: manifest.polygonTiles } : {}),
    ...(manifest.transcriptTiles ? { transcriptTiles: manifest.transcriptTiles } : {}),
    ...(manifest.density ? { density: manifest.density } : {}),
    ...(manifest.transcriptBins ? { transcriptBins: manifest.transcriptBins } : {}),
    ...(manifest.transcriptGeneBins ? { transcriptGeneBins: manifest.transcriptGeneBins } : {}),
    ...(manifest.transcriptBinsStatus ? { transcriptBinsStatus: manifest.transcriptBinsStatus } : {}),
  };
}
