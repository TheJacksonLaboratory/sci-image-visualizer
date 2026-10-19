/**
 * The members of a `.zip`, read in the browser: annotations handed over as one archive (a folder
 * of per-slice GeoJSON, a label volume with its ontology, an OME-Zarr store's labels).
 *
 * Only what such archives use: stored or deflated members, ZIP64 sizes and offsets, UTF-8 or
 * legacy names. An encrypted or otherwise compressed member throws when it is read, rather than be
 * read wrongly; a member's CRC-32 is checked. Members are read on demand, so an archive of many
 * chunks (a zarr store) is not inflated whole. Pure: usable from workers.
 */
import type { RegionImportFile } from './region-import';

/** One member of an archive. */
export interface ZipEntry {
  /** Its path in the archive, '/'-separated. */
  name: string;
  /** Its uncompressed size, in bytes. */
  size: number;
  bytes(): Promise<Uint8Array>;
}

/** Inflate raw DEFLATE data (default: the platform's `DecompressionStream('deflate-raw')`). */
export type InflateRaw = (bytes: Uint8Array) => Promise<Uint8Array>;

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const U32 = 0xffffffff;

/** Whether a file name is a zip archive. */
export function isZipName(name: string): boolean {
  return /\.zip$/i.test(name);
}

/** The members of the archive in `bytes` (directories and macOS metadata left out). */
export function readZip(bytes: Uint8Array, inflateRaw: InflateRaw = platformInflateRaw): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  let count = view.getUint16(eocd + 10, true);
  let dirOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || dirOffset === U32) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR)
      throw new Error('zip: ZIP64 locator missing');
    const z64 = num(view, locator + 8);
    if (view.getUint32(z64, true) !== ZIP64_EOCD) throw new Error('zip: ZIP64 directory end missing');
    count = num(view, z64 + 32);
    dirOffset = num(view, z64 + 48);
  }
  const entries: ZipEntry[] = [];
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('zip: bad central directory');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    let compressed = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    let local = view.getUint32(at + 42, true);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLen);
    const name = (flags & 0x800 ? new TextDecoder() : new TextDecoder('latin1'))
      .decode(nameBytes)
      .replace(/\\/g, '/');
    // ZIP64: the 32-bit fields that overflowed are in the extra field, in this order.
    let x = at + 46 + nameLen;
    const extraEnd = x + extraLen;
    while (x + 4 <= extraEnd) {
      const id = view.getUint16(x, true);
      const len = view.getUint16(x + 2, true);
      if (id === 0x0001) {
        let p = x + 4;
        if (size === U32) ((size = num(view, p)), (p += 8));
        if (compressed === U32) ((compressed = num(view, p)), (p += 8));
        if (local === U32) local = num(view, p);
      }
      x += 4 + len;
    }
    at = extraEnd + commentLen;
    if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name)) continue;
    const entry = { flags, method, crc, compressed, size, local };
    entries.push({ name, size, bytes: () => readMember(bytes, view, name, entry, inflateRaw) });
  }
  return entries;
}

/**
 * `files` with every `.zip` among them replaced by its members, named by their paths in it (a
 * single top folder the archive wraps everything in is kept, as a folder pick would keep it).
 */
export async function expandZips(
  files: readonly RegionImportFile[],
  inflateRaw?: InflateRaw,
): Promise<RegionImportFile[]> {
  const out: RegionImportFile[] = [];
  for (const file of files) {
    if (!isZipName(file.name)) {
      out.push(file);
      continue;
    }
    for (const entry of readZip(await file.bytes(), inflateRaw)) {
      out.push({
        name: entry.name,
        bytes: () => entry.bytes(),
        text: async () => new TextDecoder().decode(await entry.bytes()),
      });
    }
  }
  return out;
}

interface Member {
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  local: number;
}

async function readMember(
  bytes: Uint8Array,
  view: DataView,
  name: string,
  m: Member,
  inflateRaw: InflateRaw,
): Promise<Uint8Array> {
  if (m.flags & 0x1) throw new Error(`zip: ${name} is encrypted`);
  if (view.getUint32(m.local, true) !== LOCAL) throw new Error(`zip: ${name}: bad local header`);
  const start = m.local + 30 + view.getUint16(m.local + 26, true) + view.getUint16(m.local + 28, true);
  const raw = bytes.subarray(start, start + m.compressed);
  if (raw.length !== m.compressed) throw new Error(`zip: ${name} is truncated`);
  let out: Uint8Array;
  if (m.method === 0) out = raw;
  else if (m.method === 8) out = await inflateRaw(raw);
  else throw new Error(`zip: ${name} uses compression method ${m.method}, not stored or deflate`);
  if (out.length !== m.size) throw new Error(`zip: ${name} is ${out.length} bytes, expected ${m.size}`);
  if (crc32(out) !== m.crc) throw new Error(`zip: ${name} fails its CRC check`);
  return out;
}

/** The end-of-central-directory record: the last one, within the 64 KiB a comment may take. */
function findEocd(view: DataView): number {
  const stop = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= stop; at--) {
    if (view.getUint32(at, true) === EOCD) return at;
  }
  throw new Error('zip: not a zip archive (no central directory)');
}

/** A little-endian u64 that fits a double (archives under 8 PB). */
function num(view: DataView, at: number): number {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x100000000;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE), as zip records it. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function platformInflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new Error('zip: deflated members need DecompressionStream');
  let inflater: DecompressionStream;
  try {
    // Compression Streams' raw DEFLATE (Chrome 103, Firefox 113, Safari 16.4 on).
    inflater = new DecompressionStream('deflate-raw');
  } catch {
    throw new Error('zip: this browser cannot inflate zip members (no DecompressionStream "deflate-raw")');
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(inflater);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
