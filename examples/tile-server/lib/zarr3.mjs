// A minimal read-only Zarr v3 reader — enough to convert a SpatialData store,
// with NO dependencies.
//
// Node 24 ships zstd in `node:zlib`, and the only other codec these stores use
// is `vlen-utf8` (a numcodecs format that is four lines to decode), so a full
// Zarr library would be dependency weight for nothing. If a store turns up
// using a codec that is not here, the reader says which one rather than
// returning silent garbage.

import { readFile } from 'node:fs/promises';
import { gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import path from 'node:path';

const DTYPES = {
  int8: Int8Array, uint8: Uint8Array, bool: Uint8Array,
  int16: Int16Array, uint16: Uint16Array,
  int32: Int32Array, uint32: Uint32Array,
  int64: BigInt64Array, uint64: BigUint64Array,
  float32: Float32Array, float64: Float64Array,
};

/** numcodecs vlen-utf8: `[u32 count]` then `[u32 byteLength][utf8 bytes]` each. */
export function decodeVlenUtf8(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(0, true);
  const out = new Array(n);
  const dec = new TextDecoder();
  let o = 4;
  for (let i = 0; i < n; i++) {
    const len = dv.getUint32(o, true);
    o += 4;
    out[i] = dec.decode(buf.subarray(o, o + len));
    o += len;
  }
  return out;
}

function decompress(buf, codecs) {
  let out = buf;
  // Codecs are listed innermost-first; decoding runs in reverse.
  for (const codec of [...codecs].reverse()) {
    switch (codec.name) {
      case 'zstd': out = zstdDecompressSync(out); break;
      case 'gzip': out = gunzipSync(out); break;
      case 'blosc': throw new Error('[zarr3] blosc is not supported — re-write the store with zstd');
      case 'zlib': out = inflateSync(out); break;
      case 'bytes': case 'vlen-utf8': break; // handled by the caller
      default: throw new Error(`[zarr3] unsupported codec "${codec.name}"`);
    }
  }
  return out;
}

const product = (a) => a.reduce((n, v) => n * v, 1);

/** Read one array's metadata. */
export async function readMeta(storeDir, arrayPath) {
  return JSON.parse(await readFile(path.join(storeDir, arrayPath, 'zarr.json'), 'utf8'));
}

/**
 * Read a whole array. Returns a typed array (numeric) or `string[]` (vlen-utf8).
 *
 * Supports the two layouts these stores actually use: a single chunk covering
 * the array (images, coordinates, small columns), and a 1-D array split into
 * many chunks (the CSR data/indices, ~28M nonzeros here). Anything else throws
 * rather than mis-assembling.
 */
export async function readArray(storeDir, arrayPath) {
  const meta = await readMeta(storeDir, arrayPath);
  const shape = meta.shape;
  const chunkShape = meta.chunk_grid.configuration.chunk_shape;
  const codecs = meta.codecs ?? [];
  const isString = meta.data_type === 'string';
  const counts = shape.map((s, i) => Math.ceil(s / chunkShape[i]));
  const dir = path.join(storeDir, arrayPath);

  /**
   * One chunk's decompressed bytes, or `null` when the chunk file is absent.
   *
   * Zarr v3 OMITS a chunk that is entirely `fill_value` — a single-region
   * table's `region/codes` is all zeros and so is never written. A reader that
   * treats that as an error refuses perfectly valid stores.
   */
  const chunkBytes = async (coords) => {
    const file = path.join(dir, 'c', ...coords.map(String));
    try {
      return decompress(await readFile(file), codecs);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  };

  const total = product(shape);

  // Single chunk — the common case.
  if (counts.every((c) => c === 1)) {
    const raw = await chunkBytes(shape.map(() => 0));
    if (isString) {
      return { data: raw ? decodeVlenUtf8(raw) : new Array(total).fill(meta.fill_value ?? ''), shape, meta };
    }
    const Ctor = DTYPES[meta.data_type];
    if (!Ctor) throw new Error(`[zarr3] unsupported dtype "${meta.data_type}"`);
    const out = new Ctor(total);
    if (raw) {
      // Copy rather than view: the Buffer's byteOffset is rarely aligned for a
      // wider typed array, and a misaligned view throws.
      new Uint8Array(out.buffer).set(raw.subarray(0, out.byteLength));
    } else if (meta.fill_value) {
      out.fill(Ctor === BigInt64Array || Ctor === BigUint64Array
        ? BigInt(meta.fill_value) : meta.fill_value);
    }
    return { data: out, shape, meta };
  }

  if (shape.length !== 1) {
    throw new Error(
      `[zarr3] ${arrayPath}: multi-chunk ${shape.length}-D arrays are not supported ` +
      `(chunks ${JSON.stringify(counts)})`,
    );
  }

  // 1-D, many chunks: concatenate in order.
  const Ctor = DTYPES[meta.data_type];
  if (!Ctor) throw new Error(`[zarr3] unsupported dtype "${meta.data_type}"`);
  const out = new Ctor(shape[0]);
  const bytes = new Uint8Array(out.buffer);
  const chunkByteLen = chunkShape[0] * out.BYTES_PER_ELEMENT;
  for (let i = 0; i < counts[0]; i++) {
    const raw = await chunkBytes([i]);
    if (!raw) continue; // absent chunk = fill_value, and the buffer starts zeroed
    const at = i * chunkByteLen;
    bytes.set(raw.subarray(0, Math.min(raw.length, bytes.length - at)), at);
  }
  return { data: out, shape, meta };
}

/** An element's `attributes`, e.g. its coordinateTransformations. */
export async function readAttrs(storeDir, elementPath) {
  const meta = JSON.parse(await readFile(path.join(storeDir, elementPath, 'zarr.json'), 'utf8'));
  return meta.attributes ?? {};
}

/**
 * The scale factor an element's coordinateTransformations apply into
 * `coordinateSystem`. SpatialData records one per element; for Visium the spot
 * shapes carry the full-res → hires scale, which is exactly the affine the
 * viewer needs. Returns `[1, 1]` for an identity or absent transform.
 */
export function scaleFor(attrs, coordinateSystem) {
  const transforms = attrs?.coordinateTransformations ?? [];
  const match = transforms.find((t) => t?.output?.name === coordinateSystem) ?? transforms[0];
  if (!match || match.type !== 'scale') return [1, 1];
  const [sx, sy] = match.scale ?? [1, 1];
  return [sx, sy];
}
