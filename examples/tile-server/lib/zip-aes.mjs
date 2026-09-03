// Read a ZIP archive, including WinZip-AES encrypted entries (method 99) —
// dependency-free, using only `node:crypto` and `node:zlib`.
//
// WHY THIS EXISTS
// ---------------
// Some public datasets ship AES-encrypted archives with the password published
// alongside them (the Zenodo HER2 breast-cancer deposition does exactly this:
// "All files are password protected (encrypted), use the passeword … to decrypt
// the data"). Info-ZIP — macOS's `unzip` — refuses those with
// "need PK compat. v5.1", and 7-Zip is not always installed. Node has
// PBKDF2-HMAC-SHA1, AES-256 and HMAC-SHA1 already, so the format is ~80 lines.
//
// The format (WinZip AE-1/AE-2, APPNOTE + the WinZip AES spec):
//   extra field 0x9901: version(2) | vendor "AE"(2) | strength(1) | method(2)
//   file data:          salt(8/12/16) | pwd-verify(2) | ciphertext | authcode(10)
//   keys:               PBKDF2-HMAC-SHA1(pw, salt, 1000, 2*keyLen + 2)
//                       -> AES key | HMAC key | 2-byte verifier
//   cipher:             AES-CTR with a LITTLE-endian counter starting at 1
//                       (which is why the counter is stepped by hand below —
//                       node's aes-256-ctr counts big-endian)

import { createCipheriv, pbkdf2Sync, createHmac } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { open, readFile } from 'node:fs/promises';

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
/** salt length and key length per AES strength code. */
const STRENGTH = { 1: { salt: 8, key: 16 }, 2: { salt: 12, key: 24 }, 3: { salt: 16, key: 32 } };

/** Entries in the central directory. */
export function listEntries(buf, base = 0) {
  // The EOCD sits at the end, after a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('[zip] no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  // The recorded offset is absolute in the FILE. `base` is where `buf` starts in
  // that file, so the central directory is at `offset - base` within the window —
  // treating the absolute value as a buffer index is what made every archive
  // larger than the tail throw, turning the ranged path into a full-file read.
  const cdStart = buf.readUInt32LE(eocd + 16);
  let at = cdStart - base;
  if (at < 0 || at >= buf.length) {
    throw new Error('[zip] central directory is outside the buffer');
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CEN) throw new Error('[zip] bad central directory entry');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    entries.push({
      name, method, flags, size, compressedSize, offset,
      encrypted: (flags & 1) !== 0,
      directory: name.endsWith('/'),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Parse the 0x9901 AES extra field out of a local header's extra block. */
function aesExtra(extra) {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const len = extra.readUInt16LE(at + 2);
    if (id === 0x9901) {
      return {
        vendorVersion: extra.readUInt16LE(at + 4),
        strength: extra.readUInt8(at + 8),
        method: extra.readUInt16LE(at + 9),
      };
    }
    at += 4 + len;
  }
  return null;
}

/**
 * AES-CTR with the little-endian, 1-based counter WinZip AES specifies.
 *
 * The counter blocks are built for the WHOLE entry and encrypted in one
 * `update()`, rather than a cipher per block: a per-block cipher meant ~65k
 * object constructions for a 1 MB entry, which made listing 36 sections take 33
 * seconds and extracting one 28 MB image take 24.
 */
function aesCtrDecrypt(key, ciphertext) {
  const blocks = Math.ceil(ciphertext.length / 16);
  const counters = Buffer.alloc(blocks * 16);
  // Little-endian counter, starting at 1, incremented across the low bytes.
  const counter = Buffer.alloc(16);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) {
      counter[i] = (counter[i] + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
    counter.copy(counters, b * 16);
  }
  // The keystream is the counter blocks ENCRYPTED — CTR always uses the block
  // cipher's forward direction, even when decrypting. (Decrypting them instead
  // still passes the password verifier and the HMAC, because that MAC is over
  // the ciphertext, and only shows up later as unreadable plaintext.)
  const ecb = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  ecb.setAutoPadding(false);
  const keystream = Buffer.concat([ecb.update(counters), ecb.final()]);

  const out = Buffer.allocUnsafe(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) out[i] = ciphertext[i] ^ keystream[i];
  return out;
}

/**
 * One entry's bytes, decrypting and decompressing as needed.
 *
 * `password` is required for an encrypted entry; a wrong one is rejected by the
 * 2-byte verifier rather than returning garbage.
 */
export function readEntry(buf, entry, password) {
  if (entry.directory) return Buffer.alloc(0);

  // The local header repeats the name/extra, whose lengths we need to skip.
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const extraAt = entry.offset + 30 + nameLen;
  const extra = buf.subarray(extraAt, extraAt + extraLen);
  let data = buf.subarray(extraAt + extraLen, extraAt + extraLen + entry.compressedSize);
  let method = entry.method;

  if (entry.encrypted) {
    if (method !== 99) {
      throw new Error(`[zip] ${entry.name}: legacy ZipCrypto is not supported (method ${method})`);
    }
    if (!password) throw new Error(`[zip] ${entry.name} is encrypted — a password is required`);
    const aes = aesExtra(extra);
    if (!aes) throw new Error(`[zip] ${entry.name}: method 99 without a 0x9901 extra field`);
    const { salt: saltLen, key: keyLen } = STRENGTH[aes.strength] ?? {};
    if (!keyLen) throw new Error(`[zip] ${entry.name}: unknown AES strength ${aes.strength}`);

    const salt = data.subarray(0, saltLen);
    const verifier = data.subarray(saltLen, saltLen + 2);
    const body = data.subarray(saltLen + 2, data.length - 10);
    const authCode = data.subarray(data.length - 10);

    const derived = pbkdf2Sync(password, salt, 1000, keyLen * 2 + 2, 'sha1');
    const aesKey = derived.subarray(0, keyLen);
    const macKey = derived.subarray(keyLen, keyLen * 2);
    if (!derived.subarray(keyLen * 2).equals(verifier)) {
      throw new Error(`[zip] ${entry.name}: wrong password`);
    }
    // The MAC is over the CIPHERTEXT, so check it before spending time inflating.
    const mac = createHmac('sha1', macKey).update(body).digest().subarray(0, 10);
    if (!mac.equals(authCode)) {
      throw new Error(`[zip] ${entry.name}: authentication failed (corrupt data)`);
    }
    data = aesCtrDecrypt(aesKey, body);
    method = aes.method;
  }

  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`[zip] ${entry.name}: unsupported compression method ${method}`);
}

/** Convenience: open a file and return `{ entries, read(entry) }`. */
export async function openZip(filePath, password) {
  const buf = await readFile(filePath);
  const entries = listEntries(buf);
  return { entries, read: (entry) => readEntry(buf, entry, password) };
}

/**
 * Same as {@link openZip} but reads only the bytes it needs: the central
 * directory from the tail, then each requested entry's own range.
 *
 * For a 592 MB archive holding 36 images, loading the whole file to pull one
 * JPEG out is most of a gigabyte of resident memory for nothing.
 *
 * The caller must `close()` when finished.
 */
export async function openZipRanged(filePath, password) {
  const fh = await open(filePath);
  const { size } = await fh.stat();

  const read = async (start, length) => {
    const buf = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
    if (buf.length) await fh.read(buf, 0, buf.length, start);
    return buf;
  };

  // The EOCD is within the last 64 KiB + 22 bytes; the central directory sits
  // just before it, so one tail read usually covers both.
  const tailLen = Math.min(size, 65557 + 1024 * 1024);
  let tail = await read(size - tailLen, tailLen);
  let base = size - tail.length;
  let entries;
  try {
    entries = listEntries(tail, base);
  } catch {
    // A central directory that starts before the window we grabbed: only then is
    // the whole file worth reading.
    tail = await readFile(filePath);
    base = 0;
    entries = listEntries(tail, base);
  }
  // Each entry's own `offset` is already absolute in the file, and `read()` seeks
  // the file — so nothing else needs re-basing.

  return {
    entries,
    async read(entry) {
      if (entry.directory) return Buffer.alloc(0);
      // Local header + name + extra + data, generously sized.
      const at = entry.offset;
      const header = await read(at, 30);
      const nameLen = header.readUInt16LE(26);
      const extraLen = header.readUInt16LE(28);
      const total = 30 + nameLen + extraLen + entry.compressedSize;
      const block = await read(at, total);
      // readEntry indexes from the entry offset, so present the block as if it
      // began at 0 and point the entry there.
      return readEntry(block, { ...entry, offset: 0 }, password);
    },
    close: () => fh.close(),
  };
}
