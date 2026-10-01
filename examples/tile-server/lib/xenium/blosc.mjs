// Blosc (v1 frame) decompression with the two inner codecs Xenium bundles use: lz4 and
// zstd. zstd comes from `node:zlib` (Node ≥ 22.15); lz4 is a block decoder small enough
// to carry here rather than add a native dependency.
//
// FRAME LAYOUT (c-blosc 1.x)
//   u8 version, u8 versionlz, u8 flags, u8 typesize,
//   u32 nbytes, u32 blocksize, u32 cbytes, then u32 bstarts[nblocks], then blocks.
//   flags: 0x1 byte-shuffle, 0x2 memcpyed (stored raw), 0x4 bit-shuffle,
//          0x10 no-split (one stream per block), bits 5-7 inner codec.
// A block is `nstreams` sub-streams, each `i32 csize` + bytes; csize == stream size
// means the stream was stored uncompressed.

import { zstdDecompressSync } from 'node:zlib';

const CODEC_NAMES = ['blosclz', 'lz4', 'snappy', 'zlib', 'zstd'];

/** Decompress one LZ4 *block* (no frame) of known output size. */
export function lz4DecompressBlock(src, dst) {
  let s = 0;
  let d = 0;
  const end = src.length;
  while (s < end) {
    const token = src[s++];
    let lit = token >>> 4;
    if (lit === 15) {
      let b;
      do { b = src[s++]; lit += b; } while (b === 255);
    }
    dst.set(src.subarray(s, s + lit), d);
    s += lit;
    d += lit;
    if (s >= end) break; // last sequence carries literals only
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    let len = token & 15;
    if (len === 15) {
      let b;
      do { b = src[s++]; len += b; } while (b === 255);
    }
    len += 4;
    let m = d - off;
    if (off === 0 || m < 0) throw new Error('[blosc] lz4: bad match offset');
    // Overlapping copies are the RLE case, so copy byte by byte when they overlap.
    if (off >= len) {
      dst.copyWithin(d, m, m + len);
      d += len;
    } else {
      for (let k = 0; k < len; k++) dst[d++] = dst[m++];
    }
  }
  return d;
}

function unshuffle(src, typesize, dst) {
  const n = Math.floor(src.length / typesize);
  for (let j = 0; j < typesize; j++) {
    const base = j * n;
    for (let i = 0; i < n; i++) dst[i * typesize + j] = src[base + i];
  }
  // Bytes past the last whole element are not shuffled.
  for (let k = n * typesize; k < src.length; k++) dst[k] = src[k];
}

function decodeStream(codec, src, size) {
  if (codec === 'lz4') {
    const out = new Uint8Array(size);
    const n = lz4DecompressBlock(src, out);
    if (n !== size) throw new Error(`[blosc] lz4 produced ${n} of ${size} bytes`);
    return out;
  }
  if (codec === 'zstd') {
    const out = zstdDecompressSync(src);
    if (out.length !== size) throw new Error(`[blosc] zstd produced ${out.length} of ${size} bytes`);
    return out;
  }
  throw new Error(`[blosc] inner codec "${codec}" is not supported`);
}

/** Decompress a whole blosc frame. Returns a Uint8Array of `nbytes`. */
export function bloscDecompress(frame) {
  const buf = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[2];
  const typesize = buf[3];
  const nbytes = dv.getUint32(4, true);
  const blocksize = dv.getUint32(8, true);
  const out = new Uint8Array(nbytes);
  if (nbytes === 0) return out;

  if (flags & 0x2) {
    out.set(buf.subarray(16, 16 + nbytes));
    return out;
  }
  if (flags & 0x4) throw new Error('[blosc] bit-shuffle is not supported');
  const codec = CODEC_NAMES[flags >>> 5] ?? `code ${flags >>> 5}`;
  const shuffle = (flags & 0x1) && typesize > 1;
  const noSplit = (flags & 0x10) !== 0;

  const nblocks = Math.ceil(nbytes / blocksize);
  const scratch = shuffle ? new Uint8Array(blocksize) : null;
  for (let b = 0; b < nblocks; b++) {
    const bsize = Math.min(blocksize, nbytes - b * blocksize);
    const leftover = bsize !== blocksize;
    const nstreams = !noSplit && !leftover ? typesize : 1;
    const ssize = bsize / nstreams;
    let p = dv.getUint32(16 + b * 4, true);
    const block = shuffle ? scratch.subarray(0, bsize) : out.subarray(b * blocksize, b * blocksize + bsize);
    for (let s = 0; s < nstreams; s++) {
      const csize = dv.getInt32(p, true);
      p += 4;
      if (csize < 0) {
        // Newer c-blosc run-length marker: the whole stream is one repeated byte.
        block.fill(-csize & 0xff, s * ssize, (s + 1) * ssize);
        continue;
      }
      const cs = buf.subarray(p, p + csize);
      p += csize;
      if (csize === ssize) block.set(cs, s * ssize);
      else block.set(decodeStream(codec, cs, ssize), s * ssize);
    }
    if (shuffle) unshuffle(block, typesize, out.subarray(b * blocksize, b * blocksize + bsize));
  }
  return out;
}
