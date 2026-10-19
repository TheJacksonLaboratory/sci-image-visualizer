/**
 * The chunk codecs of the zarr stores label images come in (OME-Zarr `labels/`): Blosc framing
 * with its lz4, zstd or zlib inner codecs (zarr v2's default, as ome-zarr-py writes), zstd (zarr
 * v3's default), gzip and zlib. Anything else throws rather than be decoded wrongly. Pure: usable
 * from workers.
 *
 * The Blosc framing follows jit-bioformats' `Blosc` (the decoder JIT validated on SpatialData
 * stores): `u8 version, u8 versionlz, u8 flags, u8 typesize, u32 nbytes, u32 blocksize,
 * u32 cbytes`, then `u32 bstarts[nblocks]`, then blocks of `nstreams` sub-streams, each
 * `i32 csize` + bytes (a stream whose csize equals its decoded size stored raw, a negative one a
 * run of one byte). Flags: 0x1 byte-shuffle, 0x2 memcpyed, 0x4 bit-shuffle, 0x10 no-split, bits
 * 5-7 the inner codec.
 */
import { decompress as zstdDecompress } from 'fzstd';

/** Inflate gzip or zlib data (default: the platform's `DecompressionStream`). */
export type Inflate = (bytes: Uint8Array, format: 'gzip' | 'deflate') => Promise<Uint8Array>;

const BLOSC_CODECS = ['blosclz', 'lz4', 'snappy', 'zlib', 'zstd'];

/** Decode a Blosc frame. */
export async function bloscDecompress(frame: Uint8Array, inflate: Inflate = platformInflate): Promise<Uint8Array> {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (frame.length < 16) throw new Error('blosc: frame too short');
  const flags = frame[2];
  const typesize = frame[3];
  const nbytes = view.getUint32(4, true);
  const blocksize = view.getUint32(8, true);
  const out = new Uint8Array(nbytes);
  if (nbytes === 0) return out;
  if (flags & 0x2) {
    out.set(frame.subarray(16, 16 + nbytes));
    return out;
  }
  if (flags & 0x4) throw new Error('blosc: bit-shuffle is not supported');
  const code = flags >>> 5;
  const codec = BLOSC_CODECS[code] ?? `code ${code}`;
  if (codec !== 'lz4' && codec !== 'zstd' && codec !== 'zlib') {
    throw new Error(`blosc: inner codec ${codec} is not supported (lz4, zstd or zlib)`);
  }
  const shuffle = (flags & 0x1) !== 0 && typesize > 1;
  const noSplit = (flags & 0x10) !== 0;
  const nblocks = Math.ceil(nbytes / blocksize);
  const scratch = shuffle ? new Uint8Array(blocksize) : null;
  for (let blk = 0; blk < nblocks; blk++) {
    const bsize = Math.min(blocksize, nbytes - blk * blocksize);
    const leftover = bsize !== blocksize;
    const nstreams = !noSplit && !leftover ? typesize : 1;
    const ssize = Math.floor(bsize / nstreams);
    let p = view.getUint32(16 + blk * 4, true);
    const block = scratch ?? out;
    const base = scratch ? 0 : blk * blocksize;
    for (let s = 0; s < nstreams; s++) {
      const csize = view.getInt32(p, true);
      p += 4;
      const dst = base + s * ssize;
      if (csize < 0) {
        block.fill(-csize & 0xff, dst, dst + ssize);
        continue;
      }
      const src = frame.subarray(p, p + csize);
      if (csize === ssize) {
        block.set(src, dst);
      } else {
        const dec =
          codec === 'lz4'
            ? lz4BlockDecompress(src, ssize)
            : codec === 'zstd'
              ? zstdDecompress(src)
              : await inflate(src, 'deflate');
        if (dec.length !== ssize) throw new Error(`blosc: ${codec} produced ${dec.length} of ${ssize} bytes`);
        block.set(dec, dst);
      }
      p += csize;
    }
    if (scratch) unshuffle(scratch, bsize, typesize, out, blk * blocksize);
  }
  return out;
}

/** Decode one LZ4 block (no frame) of `size` bytes. */
export function lz4BlockDecompress(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let literals = token >>> 4;
    if (literals === 15) {
      let b: number;
      do {
        b = src[i++];
        literals += b;
      } while (b === 255);
    }
    if (o + literals > size || i + literals > src.length) throw new Error('lz4: literals overrun');
    out.set(src.subarray(i, i + literals), o);
    i += literals;
    o += literals;
    if (i >= src.length) break; // the last sequence has no match
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error('lz4: bad match offset');
    let length = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = src[i++];
        length += b;
      } while (b === 255);
    }
    if (o + length > size) throw new Error('lz4: match overrun');
    // Byte by byte: a match may overlap what it copies (a run).
    for (let k = 0; k < length; k++, o++) out[o] = out[o - offset];
  }
  if (o !== size) throw new Error(`lz4: produced ${o} of ${size} bytes`);
  return out;
}

/**
 * Decode a zarr chunk through `codecs`, outermost last as zarr lists them (v2: the one
 * `compressor`; v3: the bytes-to-bytes codecs after `bytes`).
 */
export async function decodeChunk(
  bytes: Uint8Array,
  codecs: readonly { id: string; [k: string]: unknown }[],
  inflate: Inflate = platformInflate,
): Promise<Uint8Array> {
  let data = bytes;
  for (const codec of [...codecs].reverse()) {
    switch (codec.id) {
      case 'blosc':
        data = await bloscDecompress(data, inflate);
        break;
      case 'zstd':
        data = zstdDecompress(data);
        break;
      case 'gzip':
        data = await inflate(data, 'gzip');
        break;
      case 'zlib':
        data = await inflate(data, 'deflate');
        break;
      default:
        throw new Error(`zarr: codec ${codec.id} is not supported (blosc, zstd, gzip, zlib)`);
    }
  }
  return data;
}

function unshuffle(src: Uint8Array, len: number, typesize: number, dst: Uint8Array, off: number): void {
  const n = Math.floor(len / typesize);
  for (let j = 0; j < typesize; j++) {
    const base = j * n;
    for (let i = 0; i < n; i++) dst[off + i * typesize + j] = src[base + i];
  }
  // Bytes past the last whole element are not shuffled.
  for (let k = n * typesize; k < len; k++) dst[off + k] = src[k];
}

async function platformInflate(bytes: Uint8Array, format: 'gzip' | 'deflate'): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error(`zarr: ${format} chunks need DecompressionStream`);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
