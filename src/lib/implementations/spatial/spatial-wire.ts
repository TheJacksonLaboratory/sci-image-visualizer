import {
  CategoricalColumnMeta, ContinuousColumnMeta, NO_CATEGORY, SpatialColumn, SpatialColumnMeta,
  SpatialDataset, SpatialFeatureMeta, SpatialImageRef, SpatialObservations, SpatialPolygons,
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
 * ```
 * GET {base}/spatial/datasets              -> { datasets: [{ id, name, count }] }
 * GET {base}/spatial/{id}/manifest         -> SpatialManifest
 * GET {base}/spatial/{id}/coords           -> f32[N] x, f32[N] y, f32[N] z?
 * GET {base}/spatial/{id}/radius           -> f32[N]           (per-observation radius only)
 * GET {base}/spatial/{id}/ids              -> { ids: string[] } (hasIds only)
 * GET {base}/spatial/{id}/column/{name}    -> u16[N] codes | f32[N] values
 * GET {base}/spatial/{id}/feature/{name}   -> f32[N]
 * GET {base}/spatial/{id}/features?q=&limit= -> { names: string[] }
 * GET {base}/spatial/{id}/polygons         -> u32 count, u32[count+1] offsets, f32[2*rings] coords
 * ```
 */

/** Bumped when the layout changes incompatibly; the client refuses anything else. */
export const SPATIAL_WIRE_VERSION = 1;

/** Per-observation marker radius: one shared value, or a served f32 vector. */
export type SpatialRadiusSpec =
  | { mode: 'uniform'; value: number }
  | { mode: 'per-observation' };

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

/** Reject a manifest this client cannot read, with a message naming the fix. */
export function assertManifestVersion(manifest: SpatialManifest): void {
  if (manifest.version !== SPATIAL_WIRE_VERSION) {
    throw new Error(
      `[spatial] unsupported wire version ${manifest.version} ` +
      `(this client speaks ${SPATIAL_WIRE_VERSION}). Update the server or the library.`,
    );
  }
}

/**
 * `GET /coords` → x/y(/z). One request rather than two or three: the vectors
 * are always fetched together, and a single response keeps them consistent if
 * the dataset changes underneath.
 */
export function decodeCoords(
  buf: ArrayBuffer, count: number, hasZ = false,
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
export function decodeColumn(
  buf: ArrayBuffer, meta: SpatialColumnMeta, count: number,
): SpatialColumn {
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
  const offsets = new Uint32Array(buf, 4, count + 1);
  const vertexCount = offsets[count];
  const coordsByteOffset = 4 + (count + 1) * 4;
  assertByteLength(buf, coordsByteOffset + vertexCount * 2 * 4, 'polygons');
  const coords = new Float32Array(buf, coordsByteOffset, vertexCount * 2);
  return { coords, offsets, count };
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
  const radius = manifest.radius?.mode === 'uniform'
    ? manifest.radius.value
    : extras.radius;
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
  };
}
