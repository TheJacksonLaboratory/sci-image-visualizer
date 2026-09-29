// A read-only Zarr v2 store over a zip ByteSource: `.zarray`/`.zattrs` JSON plus
// blosc-compressed chunks, read one ranged request per chunk.
//
// Only what Xenium stores use: blosc(lz4|zstd) or no compressor, numeric dtypes,
// C or F order, '.' or '/' dimension separators. Anything else throws naming the gap.

import { readZipDirectory, openStoredMember } from './zip.mjs';
import { bloscDecompress } from './blosc.mjs';

const DTYPES = {
  '|u1': Uint8Array, '|i1': Int8Array, '|b1': Uint8Array,
  '<u2': Uint16Array, '<i2': Int16Array,
  '<u4': Uint32Array, '<i4': Int32Array,
  '<u8': BigUint64Array, '<i8': BigInt64Array,
  '<f4': Float32Array, '<f8': Float64Array,
};

/** The typed-array constructor for an array's (normalised) dtype. */
export function typedArrayFor(meta) {
  return DTYPES[meta.dtype];
}

const product = (a) => a.reduce((n, v) => n * v, 1);

export class ZarrZipStore {
  /** @param {import('./byte-source.mjs').ByteSource} src  the `.zarr.zip` itself */
  static async open(src) {
    const store = new ZarrZipStore();
    store.src = src;
    store.entries = await readZipDirectory(src);
    store.jsonCache = new Map();
    return store;
  }

  has(key) {
    return this.entries.has(key);
  }

  /** Keys directly under `prefix/` (one path segment), e.g. group children. */
  children(prefix) {
    const p = prefix ? `${prefix}/` : '';
    const out = new Set();
    for (const k of this.entries.keys()) {
      if (!k.startsWith(p)) continue;
      const rest = k.slice(p.length);
      const slash = rest.indexOf('/');
      if (slash > 0) out.add(rest.slice(0, slash));
    }
    return [...out];
  }

  async raw(key) {
    const e = this.entries.get(key);
    if (!e) return null;
    const member = await openStoredMember(this.src, e);
    return member.read(0, member.size);
  }

  async json(key) {
    if (this.jsonCache.has(key)) return this.jsonCache.get(key);
    const buf = await this.raw(key);
    const v = buf ? JSON.parse(buf.toString('utf8')) : null;
    this.jsonCache.set(key, v);
    return v;
  }

  attrs(path) {
    return this.json(path ? `${path}/.zattrs` : '.zattrs');
  }

  async meta(path) {
    const m = await this.json(`${path}/.zarray`);
    if (!m) throw new RangeError(`no zarr array at ${path}`);
    // Some writers drop the byte-order character for single-byte types (`u1`).
    if (/^[a-z]\d$/.test(m.dtype)) m.dtype = `|${m.dtype}`;
    if (m.zarr_format !== 2) throw new Error(`${path}: zarr_format ${m.zarr_format}`);
    if (!DTYPES[m.dtype]) throw new Error(`${path}: unsupported dtype ${m.dtype}`);
    if (m.filters?.length) throw new Error(`${path}: zarr filters are not supported`);
    const id = m.compressor?.id;
    if (id && id !== 'blosc') throw new Error(`${path}: compressor "${id}" is not supported`);
    return m;
  }

  /** One chunk as a typed array of the full chunk shape (edge chunks are padded). */
  async chunk(path, meta, coords) {
    const sep = meta.dimension_separator ?? '.';
    const buf = await this.raw(`${path}/${coords.join(sep)}`);
    const T = DTYPES[meta.dtype];
    const n = product(meta.chunks);
    if (!buf) {
      const out = new T(n);
      if (meta.fill_value) out.fill(typeof out[0] === 'bigint' ? BigInt(meta.fill_value) : meta.fill_value);
      return out;
    }
    const bytes = meta.compressor ? bloscDecompress(buf) : new Uint8Array(buf);
    if (bytes.byteLength !== n * T.BYTES_PER_ELEMENT) {
      throw new Error(`${path}/${coords}: chunk is ${bytes.byteLength} bytes, expected ${n * T.BYTES_PER_ELEMENT}`);
    }
    // Copy so the typed array is aligned regardless of where the bytes landed.
    return new T(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  /**
   * A whole array as `{ data, shape }`, always C-order (row-major) in the result.
   * Fine for everything here but the per-transcript tables, which are read per tile.
   */
  async read(path) {
    const meta = await this.meta(path);
    const { shape, chunks } = meta;
    const T = DTYPES[meta.dtype];
    const out = new T(product(shape));
    const grid = shape.map((s, i) => Math.ceil(s / chunks[i]));
    const strides = shape.map((_, i) => product(shape.slice(i + 1)));
    const nd = shape.length;
    const idx = new Array(nd).fill(0);
    const jobs = [];
    for (let c = 0; c < product(grid); c++) {
      let r = c;
      for (let d = nd - 1; d >= 0; d--) { idx[d] = r % grid[d]; r = Math.floor(r / grid[d]); }
      jobs.push([...idx]);
    }
    await Promise.all(jobs.map(async (cc) => {
      const data = await this.chunk(path, meta, cc);
      copyChunk(data, meta, cc, shape, strides, out);
    }));
    return { data: out, shape };
  }
}

/** Place one chunk into a C-order output, honouring the chunk's own order and edges. */
function copyChunk(data, meta, cc, shape, strides, out) {
  const { chunks, order } = meta;
  const nd = shape.length;
  const origin = cc.map((c, d) => c * chunks[d]);
  const extent = chunks.map((c, d) => Math.min(c, shape[d] - origin[d]));
  // Chunk-local strides for the chunk's storage order.
  const cs = new Array(nd);
  if (order === 'F') {
    let s = 1;
    for (let d = 0; d < nd; d++) { cs[d] = s; s *= chunks[d]; }
  } else {
    let s = 1;
    for (let d = nd - 1; d >= 0; d--) { cs[d] = s; s *= chunks[d]; }
  }
  if (nd === 1) {
    out.set(data.subarray(0, extent[0]), origin[0]);
    return;
  }
  if (nd === 2) {
    for (let i = 0; i < extent[0]; i++) {
      const orow = (origin[0] + i) * strides[0] + origin[1];
      for (let j = 0; j < extent[1]; j++) out[orow + j] = data[i * cs[0] + j * cs[1]];
    }
    return;
  }
  throw new Error(`${nd}-D zarr arrays are not supported by read(); read chunks directly`);
}
