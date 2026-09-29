// Just enough (Big)TIFF to walk a tiled OME-TIFF pyramid: the main IFD plus its SubIFDs,
// with each level's tile offsets, byte counts and compression.
//
// Why not libvips: Xenium's morphology images are written by tifffile with JPEG-2000
// tile compression (TIFF code 34712), which libtiff has no codec for — vips opens the
// file, reports the right dimensions, and decodes every pixel as 0. Reading the tile
// tables ourselves and decoding the codestreams with openjpeg is the reliable path.

import { open } from 'node:fs/promises';

/** Bytes per value, by TIFF field type. */
const TYPE_SIZE = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8,
};

/**
 * @typedef {object} TiffLevel
 * @property {number} width
 * @property {number} height
 * @property {number} tileWidth
 * @property {number} tileHeight
 * @property {number} bitsPerSample
 * @property {number} compression   1 none, 8/32946 deflate, 34712 JPEG-2000
 * @property {number[]} offsets     per tile, row-major
 * @property {number[]} byteCounts
 */

/** Read the pyramid: level 0 is the main IFD, then its SubIFDs in order. */
export async function readTiffPyramid(file) {
  const fh = await open(file, 'r');
  try {
    const read = async (off, len) => {
      const b = Buffer.alloc(len);
      await fh.read(b, 0, len, off);
      return b;
    };
    const head = await read(0, 16);
    const le = head.toString('latin1', 0, 2) === 'II';
    if (!le) throw new Error(`${file}: big-endian TIFF is not supported`);
    const big = head.readUInt16LE(2) === 43;
    if (!big && head.readUInt16LE(2) !== 42) throw new Error(`${file}: not a TIFF`);
    const first = big ? Number(head.readBigUInt64LE(8)) : head.readUInt32LE(4);

    const readIfd = async (off) => {
      const countBytes = big ? 8 : 2;
      const entrySize = big ? 20 : 12;
      const nb = await read(off, countBytes);
      const n = big ? Number(nb.readBigUInt64LE(0)) : nb.readUInt16LE(0);
      const ent = await read(off + countBytes, n * entrySize);
      const tags = new Map();
      for (let i = 0; i < n; i++) {
        const e = i * entrySize;
        const tag = ent.readUInt16LE(e);
        const type = ent.readUInt16LE(e + 2);
        const count = big ? Number(ent.readBigUInt64LE(e + 4)) : ent.readUInt32LE(e + 4);
        const size = (TYPE_SIZE[type] ?? 1) * count;
        const inline = size <= (big ? 8 : 4);
        const valueAt = e + (big ? 12 : 8);
        const raw = inline
          ? ent.subarray(valueAt, valueAt + size)
          : await read(big ? Number(ent.readBigUInt64LE(valueAt)) : ent.readUInt32LE(valueAt), size);
        tags.set(tag, decodeValues(raw, type, count));
      }
      return tags;
    };

    const toLevel = (tags) => {
      const one = (t, d) => tags.get(t)?.[0] ?? d;
      if (!tags.has(322)) throw new Error(`${file}: level is not tiled`);
      return {
        width: one(256), height: one(257),
        tileWidth: one(322), tileHeight: one(323),
        bitsPerSample: one(258, 8), compression: one(259, 1),
        offsets: tags.get(324), byteCounts: tags.get(325),
      };
    };

    const main = await readIfd(first);
    const levels = [toLevel(main)];
    for (const off of main.get(330) ?? []) levels.push(toLevel(await readIfd(off)));
    return levels;
  } finally {
    await fh.close();
  }
}

function decodeValues(buf, type, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 3: out[i] = buf.readUInt16LE(i * 2); break;
      case 4: case 13: out[i] = buf.readUInt32LE(i * 4); break;
      case 16: case 18: out[i] = Number(buf.readBigUInt64LE(i * 8)); break;
      case 5: out[i] = buf.readUInt32LE(i * 8) / buf.readUInt32LE(i * 8 + 4); break;
      default: out[i] = buf[i];
    }
  }
  return out;
}
