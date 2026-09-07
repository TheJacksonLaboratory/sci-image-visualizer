import { NO_CATEGORY, SpatialColumnMeta, isCategoricalColumn, isContinuousColumn } from '../../contracts/spatial-dataset.contract';
import {
  SPATIAL_WIRE_VERSION, SpatialManifest, assertManifestVersion, datasetFromManifest,
  decodeColumn, decodeCoords, decodeEmbedding, decodeFeatureVector, decodePolygons, decodeRadius,
  isLittleEndian,
} from './spatial-wire';

/** Concatenate typed arrays into one little-endian ArrayBuffer. */
function concat(...parts: ArrayBufferView[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
    at += p.byteLength;
  }
  return out.buffer;
}

const manifest = (over: Partial<SpatialManifest> = {}): SpatialManifest => ({
  version: SPATIAL_WIRE_VERSION,
  id: 'demo',
  name: 'Demo',
  count: 3,
  columns: [],
  ...over,
});

describe('spatial-wire', () => {
  it('runs on a little-endian host (the format assumes it)', () => {
    expect(isLittleEndian()).toBe(true);
  });

  describe('decodeCoords', () => {
    it('splits x/y (and z) out of one response', () => {
      const buf = concat(
        new Float32Array([1, 2, 3]),
        new Float32Array([4, 5, 6]),
        new Float32Array([7, 8, 9]),
      );
      const { x, y, z } = decodeCoords(buf, 3, true);
      expect(Array.from(x)).toEqual([1, 2, 3]);
      expect(Array.from(y)).toEqual([4, 5, 6]);
      expect(Array.from(z!)).toEqual([7, 8, 9]);
    });

    it('omits z when the manifest says there is none', () => {
      const buf = concat(new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6]));
      expect(decodeCoords(buf, 3, false).z).toBeUndefined();
    });

    it('throws on a truncated response rather than silently short-reading', () => {
      const buf = concat(new Float32Array([1, 2, 3]), new Float32Array([4, 5]));
      expect(() => decodeCoords(buf, 3, false)).toThrow(/expected 24 bytes, got 20/);
    });
  });

  describe('decodeColumn', () => {
    const categorical: SpatialColumnMeta = {
      kind: 'categorical', name: 'cluster', categories: ['A', 'B'],
    };
    const continuous: SpatialColumnMeta = { kind: 'continuous', name: 'counts' };

    it('decodes categorical codes', () => {
      const col = decodeColumn(concat(new Uint16Array([0, 1, 0])).slice(0), categorical, 3);
      expect(isCategoricalColumn(col)).toBe(true);
      if (isCategoricalColumn(col)) expect(Array.from(col.codes)).toEqual([0, 1, 0]);
    });

    it('normalises out-of-range codes to NO_CATEGORY so renderers can trust the invariant', () => {
      const col = decodeColumn(concat(new Uint16Array([0, 7, 1])).slice(0), categorical, 3);
      if (isCategoricalColumn(col)) {
        expect(Array.from(col.codes)).toEqual([0, NO_CATEGORY, 1]);
      }
    });

    it('decodes continuous values, preserving NaN as missing', () => {
      const col = decodeColumn(concat(new Float32Array([1.5, NaN, 3])).slice(0), continuous, 3);
      expect(isContinuousColumn(col)).toBe(true);
      if (isContinuousColumn(col)) {
        expect(col.values[0]).toBeCloseTo(1.5);
        expect(Number.isNaN(col.values[1])).toBe(true);
      }
    });

    it('sizes categorical at 2 bytes and continuous at 4 (a mismatch throws)', () => {
      const fourBytesEach = concat(new Float32Array([0, 1, 0])).slice(0);
      expect(() => decodeColumn(fourBytesEach, categorical, 3)).toThrow(/expected 6 bytes, got 12/);
    });
  });

  describe('decodeFeatureVector / decodeRadius', () => {
    it('decodes a gene vector', () => {
      const buf = concat(new Float32Array([0, 2.5, 10])).slice(0);
      expect(Array.from(decodeFeatureVector(buf, 3))).toEqual([0, 2.5, 10]);
    });

    it('decodes per-observation radii', () => {
      const buf = concat(new Float32Array([5, 5, 5])).slice(0);
      expect(Array.from(decodeRadius(buf, 3))).toEqual([5, 5, 5]);
    });
  });

  describe('decodePolygons', () => {
    it('decodes rings from the count/offsets/coords layout', () => {
      // Two rings: a triangle (3 vertices) and a square (4 vertices).
      const buf = concat(
        new Uint32Array([2]),
        new Uint32Array([0, 3, 7]),
        new Float32Array([0, 0, 1, 0, 0, 1, /* square */ 2, 2, 3, 2, 3, 3, 2, 3]),
      );
      const poly = decodePolygons(buf);
      expect(poly.count).toBe(2);
      expect(Array.from(poly.offsets)).toEqual([0, 3, 7]);
      expect(poly.coords.length).toBe(14);
      expect(Array.from(poly.coords.slice(0, 6))).toEqual([0, 0, 1, 0, 0, 1]);
    });

    it('throws when the coordinate block does not match the offsets', () => {
      const buf = concat(
        new Uint32Array([1]),
        new Uint32Array([0, 3]),
        new Float32Array([0, 0, 1, 0]), // 2 vertices, offsets promise 3
      );
      expect(() => decodePolygons(buf)).toThrow(/polygons: expected/);
    });
  });

  describe('assertManifestVersion', () => {
    it('accepts the current version', () => {
      expect(() => assertManifestVersion(manifest())).not.toThrow();
    });

    it('refuses a future version with an actionable message', () => {
      expect(() => assertManifestVersion(manifest({ version: 99 })))
        .toThrow(/unsupported wire version 99/);
    });
  });

  /**
 * Embeddings ride the same struct-of-arrays layout as coords, deliberately: the point is to swap
 * one in as the scatter's coordinate source, so it must arrive in the shape that path already
 * takes.
 */
describe('decodeEmbedding', () => {
  const meta2 = { name: 'X_umap', dims: 2 as const };
  const meta3 = { name: 'X_umap3', dims: 3 as const };

  it('reads a 2D embedding as one contiguous plane per dimension', () => {
    // Struct of arrays: every d0, THEN every d1 — not interleaved pairs.
    const buf = concat(Float32Array.from([1, 2, 3]), Float32Array.from([10, 20, 30]));
    const e = decodeEmbedding(buf, meta2, 3);
    expect(Array.from(e.x)).toEqual([1, 2, 3]);
    expect(Array.from(e.y)).toEqual([10, 20, 30]);
    expect(e.z).toBeUndefined();
    expect(e.meta).toBe(meta2);
  });

  it('reads the third plane only when the metadata says 3 dims', () => {
    const buf = concat(
      Float32Array.from([1, 2]), Float32Array.from([3, 4]), Float32Array.from([5, 6]),
    );
    const e = decodeEmbedding(buf, meta3, 2);
    expect(Array.from(e.z!)).toEqual([5, 6]);
  });

  it('views the buffer rather than copying it', () => {
    // These are 10^5-10^6 rows; a copy per axis would be pure waste.
    const buf = concat(Float32Array.from([1, 2]), Float32Array.from([3, 4]));
    const e = decodeEmbedding(buf, meta2, 2);
    expect(e.x.buffer).toBe(buf);
    expect(e.y.byteOffset).toBe(8);
  });

  it('rejects a buffer that is the wrong size for the declared dims', () => {
    // A 2D payload read as 3D would silently hand back garbage z values sliced from
    // beyond the data, so the length is checked against dims rather than assumed.
    const twoDims = concat(Float32Array.from([1, 2]), Float32Array.from([3, 4]));
    expect(() => decodeEmbedding(twoDims, meta3, 2)).toThrow(/embedding "X_umap3"/);
    expect(() => decodeEmbedding(twoDims, meta2, 3)).toThrow(/embedding "X_umap"/);
  });
});

describe('datasetFromManifest', () => {
    const coords = { x: new Float32Array([1, 2, 3]), y: new Float32Array([4, 5, 6]) };

    it('carries a uniform radius from the manifest', () => {
      const ds = datasetFromManifest(
        manifest({ radius: { mode: 'uniform', value: 27.5 } }), coords,
      );
      expect(ds.observations.radius).toBe(27.5);
      expect(ds.observations.count).toBe(3);
    });

    it('prefers the fetched vector for a per-observation radius', () => {
      const radius = new Float32Array([1, 2, 3]);
      const ds = datasetFromManifest(
        manifest({ radius: { mode: 'per-observation' } }), coords, { radius },
      );
      expect(ds.observations.radius).toBe(radius);
    });

    it('omits optional fields entirely rather than setting them undefined', () => {
      const ds = datasetFromManifest(manifest(), coords);
      expect('radius' in ds.observations).toBe(false);
      expect('ids' in ds.observations).toBe(false);
      expect('z' in ds.observations).toBe(false);
      expect(ds.features).toBeUndefined();
      expect(ds.polygons).toBeUndefined();
    });

    it('passes columns, features, polygons and imageRef through', () => {
      const ds = datasetFromManifest(manifest({
        columns: [{ kind: 'continuous', name: 'counts' }],
        features: { count: 2, names: ['Ttr', 'Fth1'] },
        polygons: { count: 3 },
        imageRef: { imageId: 'brain', scale: [2, 2], mppX: 0.5 },
      }), coords, { ids: ['a', 'b', 'c'] });
      expect(ds.columns).toHaveLength(1);
      expect(ds.features?.names).toEqual(['Ttr', 'Fth1']);
      expect(ds.polygons?.count).toBe(3);
      expect(ds.imageRef?.scale).toEqual([2, 2]);
      expect(ds.observations.ids).toEqual(['a', 'b', 'c']);
    });
  });
});
