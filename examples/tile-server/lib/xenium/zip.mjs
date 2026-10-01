// Read a zip's central directory over a ByteSource, zip64 included, and open STORED
// members as byte sources of their own.
//
// Xenium bundles are zips of zips: the `_xe_outs.zip` holds `cells.zarr.zip`,
// `transcripts.zarr.zip`, … each STORED (method 0), and each of those holds its zarr
// chunks, also stored. A stored member is just a byte range of its parent, so the
// nesting costs nothing — a chunk three zips deep is still one ranged read.
//
// DEFLATED members (the OME-TIFFs) cannot be read at random; `inflateMember` streams
// one out when a caller needs the whole thing.

import { createInflateRaw } from 'node:zlib';
import { sliceByteSource } from './byte-source.mjs';

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} method          0 = stored, 8 = deflated
 * @property {number} compressedSize
 * @property {number} size
 * @property {number} headerOffset    local file header offset
 */

/** Parse the central directory. Returns `Map<name, ZipEntry>`. */
export async function readZipDirectory(src) {
  const tailLen = Math.min(src.size, 65_557 + 20 + 56);
  const tail = await src.read(src.size - tailLen, tailLen);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) { e = i; break; }
  }
  if (e < 0) throw new Error(`${src.label}: not a zip (no end-of-central-directory)`);

  let count = tail.readUInt16LE(e + 10);
  let cdSize = tail.readUInt32LE(e + 12);
  let cdOffset = tail.readUInt32LE(e + 16);
  const loc = e - 20;
  if (loc >= 0 && tail.readUInt32LE(loc) === EOCD64_LOCATOR) {
    const eocd64Offset = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await src.read(eocd64Offset, 56);
    if (rec.readUInt32LE(0) !== EOCD64) throw new Error(`${src.label}: bad zip64 record`);
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }

  const cd = await src.read(cdOffset, cdSize);
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== CDH) throw new Error(`${src.label}: corrupt central directory`);
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let headerOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // Zip64 extra field: only the fields that overflowed are present, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let k = x + 4;
        if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(k)); k += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(k)); k += 8; }
        if (headerOffset === 0xffffffff) { headerOffset = Number(cd.readBigUInt64LE(k)); }
      }
      x += 4 + len;
    }
    entries.set(name, { name, method, compressedSize, size, headerOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Offset of a member's data: past its local header, whose extra field may differ. */
async function dataOffset(src, entry) {
  const h = await src.read(entry.headerOffset, 30);
  if (h.readUInt32LE(0) !== LFH) throw new Error(`${src.label}: bad local header for ${entry.name}`);
  return entry.headerOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

/** A stored member as a ByteSource over its parent. */
export async function openStoredMember(src, entry) {
  if (entry.method !== 0) {
    throw new Error(`${src.label}: ${entry.name} is compressed (method ${entry.method}); ` +
      'only stored members can be read in place');
  }
  const base = await dataOffset(src, entry);
  return sliceByteSource(src, base, entry.size, `${src.label}!${entry.name}`);
}

/** A member's full bytes — stored or deflated. For small files (JSON, metadata). */
export async function readMember(src, entry) {
  const base = await dataOffset(src, entry);
  const raw = await src.read(base, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    const { inflateRawSync } = await import('node:zlib');
    return inflateRawSync(raw);
  }
  throw new Error(`${src.label}: ${entry.name}: unsupported method ${entry.method}`);
}

/**
 * Stream a (possibly deflated) member into `sink` (a Writable), reading the parent in
 * `chunkBytes` pieces so a 21 GB OME-TIFF never sits in memory.
 */
export async function streamMember(src, entry, sink, { chunkBytes = 16 << 20, onProgress } = {}) {
  const base = await dataOffset(src, entry);
  const inflate = entry.method === 8 ? createInflateRaw() : null;
  const out = inflate ?? sink;
  if (inflate) inflate.pipe(sink);
  const done = new Promise((resolve, reject) => {
    sink.on('finish', resolve);
    sink.on('error', reject);
    inflate?.on('error', reject);
  });
  for (let off = 0; off < entry.compressedSize; off += chunkBytes) {
    const len = Math.min(chunkBytes, entry.compressedSize - off);
    const buf = await src.read(base + off, len);
    if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
    onProgress?.(off + len, entry.compressedSize);
  }
  out.end();
  await done;
}
