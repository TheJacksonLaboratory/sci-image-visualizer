/**
 * The Xenium reader's building blocks: blosc frames, nested stored zips, zarr v2 over a
 * zip, and 10x's cell-id encoding. Frames and zips are built by hand here so the tests
 * need no encoder dependency and pin the exact byte layouts the reader relies on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { bloscDecompress, lz4DecompressBlock } from '../lib/xenium/blosc.mjs';
import { readZipDirectory, openStoredMember } from '../lib/xenium/zip.mjs';
import { openByteSource } from '../lib/xenium/byte-source.mjs';
import { ZarrZipStore } from '../lib/xenium/zarr2-zip.mjs';
import { xeniumCellId } from '../lib/spatial-xenium.mjs';

// ── blosc ────────────────────────────────────────────────────────────────────────────

/** A blosc v1 frame around already-encoded streams (one block). */
function bloscFrame({ flags, typesize, nbytes, streams }) {
  const header = Buffer.alloc(16 + 4);
  header[0] = 2; header[1] = 1; header[2] = flags; header[3] = typesize;
  header.writeUInt32LE(nbytes, 4);
  header.writeUInt32LE(nbytes, 8); // blocksize = nbytes → one block
  const body = Buffer.concat(streams.map((s) => {
    const len = Buffer.alloc(4);
    len.writeInt32LE(s.length, 0);
    return Buffer.concat([len, s]);
  }));
  header.writeUInt32LE(20, 16); // bstarts[0]
  const frame = Buffer.concat([header, body]);
  frame.writeUInt32LE(frame.length, 12);
  return frame;
}

test('blosc: a memcpyed frame is returned verbatim', () => {
  const data = Buffer.from([1, 2, 3, 4, 5]);
  const frame = Buffer.concat([Buffer.from([2, 1, 0x2, 1, 5, 0, 0, 0, 5, 0, 0, 0, 21, 0, 0, 0]), data]);
  assert.deepEqual(Buffer.from(bloscDecompress(frame)), data);
});

test('blosc: zstd, byte-shuffled, unsplit — the transcripts/density layout', () => {
  const values = Float32Array.from([1.5, -2.25, 1e6, 3.14159]);
  const raw = Buffer.from(values.buffer);
  // Byte-shuffle: all first bytes, then all second bytes, …
  const shuffled = Buffer.alloc(raw.length);
  for (let i = 0; i < 4; i++) for (let b = 0; b < 4; b++) shuffled[b * 4 + i] = raw[i * 4 + b];
  const frame = bloscFrame({
    flags: 0x1 | 0x10 | (4 << 5), typesize: 4, nbytes: raw.length, streams: [zstdCompressSync(shuffled)],
  });
  const out = new Float32Array(bloscDecompress(frame).buffer);
  assert.deepEqual(Array.from(out), Array.from(values));
});

test('blosc: a stream whose size equals its decoded size is stored, not compressed', () => {
  const raw = Buffer.from([9, 8, 7, 6]);
  const frame = bloscFrame({ flags: 0x10 | (1 << 5), typesize: 1, nbytes: 4, streams: [raw] });
  assert.deepEqual(Buffer.from(bloscDecompress(frame)), raw);
});

test('lz4: literals, then an overlapping match (the run-length case)', () => {
  // token 0x11: 1 literal, match length 1+4 = 5; literal 'a'; offset 1 → "aaaaaa";
  // then a literals-only last sequence "bc".
  const block = Uint8Array.from([0x11, 0x61, 0x01, 0x00, 0x20, 0x62, 0x63]);
  const out = new Uint8Array(8);
  assert.equal(lz4DecompressBlock(block, out), 8);
  assert.equal(Buffer.from(out).toString(), 'aaaaaabc');
});

test('blosc: split into one stream per byte of the type, then unshuffled', () => {
  const values = Uint16Array.from([0x0102, 0x0102, 0x0102, 0x0102]);
  // Shuffled bytes are 02 02 02 02 | 01 01 01 01; each typesize stream holds one of them.
  // Stored (size == decoded size), so this pins the split + unshuffle, not the codec.
  const s1 = Buffer.from([2, 2, 2, 2]);
  const s2 = Buffer.from([1, 1, 1, 1]);
  const frame = bloscFrame({ flags: 0x1 | (1 << 5), typesize: 2, nbytes: 8, streams: [s1, s2] });
  assert.deepEqual(Array.from(new Uint16Array(bloscDecompress(frame).buffer)), Array.from(values));
});

// ── zip + zarr ───────────────────────────────────────────────────────────────────────

/** A minimal STORED zip of `{ name: Buffer }` (no zip64 — small by construction). */
function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lfh, nameBuf, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('zarr over a zip nested in a zip: F-order chunks, edge chunks, one ranged read each', async () => {
  // A 5×2 float32 array in F order with chunks of 3 rows — two chunks, the second padded.
  const col = (vals) => Buffer.from(Float32Array.from(vals).buffer);
  const chunk0 = Buffer.concat([col([0, 1, 2]), col([10, 11, 12])]); // F: x then y
  const chunk1 = Buffer.concat([col([3, 4, 0]), col([13, 14, 0])]);
  const zarray = Buffer.from(JSON.stringify({
    zarr_format: 2, shape: [5, 2], chunks: [3, 2], dtype: '<f4', order: 'F',
    compressor: null, fill_value: 0, filters: null, dimension_separator: '.',
  }));
  const inner = storedZip({
    '.zgroup': Buffer.from('{"zarr_format":2}'),
    'loc/.zarray': zarray,
    'loc/.zattrs': Buffer.from('{"column_names":["x","y"]}'),
    'loc/0.0': chunk0,
    'loc/1.0': chunk1,
  });
  const outer = storedZip({ 'experiment.xenium': Buffer.from('{}'), 'cells.zarr.zip': inner });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xenium-test-'));
  const file = path.join(dir, 'x_xe_outs.zip');
  await writeFile(file, outer);

  const src = await openByteSource(file);
  const entries = await readZipDirectory(src);
  assert.ok(entries.has('cells.zarr.zip'));
  const store = await ZarrZipStore.open(await openStoredMember(src, entries.get('cells.zarr.zip')));
  assert.deepEqual(store.children(''), ['loc']);
  assert.deepEqual(await store.attrs('loc'), { column_names: ['x', 'y'] });
  const { data, shape } = await store.read('loc');
  assert.deepEqual(shape, [5, 2]);
  // C-order result: rows of (x, y).
  assert.deepEqual(Array.from(data), [0, 10, 1, 11, 2, 12, 3, 13, 4, 14]);
  await src.close();
});

test('zarr: a dtype without a byte-order prefix (`u1`) is accepted', async () => {
  const inner = storedZip({
    'v/.zarray': Buffer.from(JSON.stringify({
      zarr_format: 2, shape: [3], chunks: [3], dtype: 'u1', order: 'C', compressor: null, filters: null,
    })),
    'v/0': Buffer.from([1, 0, 1]),
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xenium-test-'));
  const file = path.join(dir, 'v.zarr.zip');
  await writeFile(file, inner);
  const store = await ZarrZipStore.open(await openByteSource(file));
  assert.deepEqual(Array.from((await store.read('v')).data), [1, 0, 1]);
});

// ── cell ids ─────────────────────────────────────────────────────────────────────────

test('xeniumCellId: hex digits shift into a–p, then the dataset suffix', () => {
  assert.equal(xeniumCellId(0, 1), 'aaaaaaaa-1');
  // 0x0123abcd → digits 0 1 2 3 a b c d → a b c d k l m n
  assert.equal(xeniumCellId(0x0123abcd, 1), 'abcdklmn-1');
  assert.equal(xeniumCellId(0xffffffff, 2), 'pppppppp-2');
});

test('derived vectors are read back from disk after a restart, density rasters included', async () => {
  const { derived } = await import('../lib/spatial-xenium.mjs');
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'xenium-derived-'));
  try {
    let computed = 0;
    const compute = (n) => async () => { computed++; return new Float32Array(n).fill(7); };
    // Same directory, a new in-memory cache key each time: what a restarted server sees.
    const ds = (run) => ({ count: 3, cfg: { id: 'x', source: `run-${run}`, derivedDir: dir } });
    await derived(ds(1), 'transcript_count', compute(3));
    await derived(ds(1), 'density_all_genes', compute(12), 12); // a 3 × 4 raster, not one per cell
    assert.equal(computed, 2);
    const cells = await derived(ds(2), 'transcript_count', compute(3));
    const density = await derived(ds(2), 'density_all_genes', compute(12), 12);
    assert.equal(computed, 2, 'both came from disk');
    assert.equal(cells.length, 3);
    assert.equal(density.length, 12);
    assert.deepEqual((await readdir(dir)).sort(), ['density_all_genes.f32', 'transcript_count.f32']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
