/** Per-gene pyramid levels: every level keeps every transcript, readable a gene at a time. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openByteSource } from '../lib/xenium/byte-source.mjs';
import { createGeneLevels, readGeneBlock, readGeneTile } from '../lib/xenium/gene-index.mjs';

const NO_CELL = 0xffffffff;

test('builds 8 levels from two source tiles; each gene readable on its own', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gene-levels-'));
  try {
    const levels = 8;
    const w = await createGeneLevels({
      outDir: dir, levels, baseBin: 250 / 128, sourceTile: 250, basePerSource: 128, tileBins: 64,
      gxMin: 0, gyMin: 0, geneNames: ['A', 'B', 'C'],
    });
    // Tile (0,0): gene A ×3 in cell 5 near (10,10), gene B ×1 at (200,200) in no cell.
    await w.addSourceTile(0, 0, {
      n: 4, x: Float32Array.of(10, 10.5, 11, 200), y: Float32Array.of(10, 10.5, 11, 200),
      cell: Uint32Array.of(5, 5, 5, NO_CELL), gene: Uint16Array.of(0, 0, 0, 1),
    });
    // Tile (1,0): gene C ×2 in cell 9.
    await w.addSourceTile(1, 0, {
      n: 2, x: Float32Array.of(300, 301), y: Float32Array.of(20, 21),
      cell: Uint32Array.of(9, 9), gene: Uint16Array.of(2, 2),
    });
    const index = await w.finish([0, 0]);
    assert.equal(index.levels.length, levels);
    for (const [m, l] of index.levels.entries()) {
      const file = await readFile(path.join(dir, l.file));
      let total = 0;
      for (const [off, len] of Object.values(l.tiles)) {
        const r = readGeneBlock(file.subarray(off, off + len), [0, 1, 2]);
        total += r.count.reduce((a, b) => a + b, 0);
      }
      assert.equal(total, 6, `level ${m} keeps every transcript`);
    }
    // Coarsest level: one tile; read only gene A, through a byte source.
    const top = index.levels[levels - 1];
    const [off, len] = Object.values(top.tiles)[0];
    const src = await openByteSource(path.join(dir, top.file));
    const a = await readGeneTile(src, off, len, [0], new Map());
    assert.equal(a.n, 1);
    assert.equal(a.count[0], 3);
    assert.equal(a.cell[0], 5);
    assert.ok(Math.abs(a.x[0] - 10.5) < 1e-4);
    const missing = await readGeneTile(src, off, len, [7], new Map());
    assert.equal(missing.n, 0);
    await src.close?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a shared table cache keeps levels apart: each level file has a tile at offset 0', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gene-levels-'));
  try {
    const w = await createGeneLevels({
      outDir: dir, levels: 3, baseBin: 250 / 128, sourceTile: 250, basePerSource: 128, tileBins: 64,
      gxMin: 0, gyMin: 0, geneNames: ['A'],
    });
    // Gene A at two spots far apart in one source tile: 2 bins at the finest level, 1 coarser.
    await w.addSourceTile(0, 0, {
      n: 2, x: Float32Array.of(1, 200), y: Float32Array.of(1, 200),
      cell: Uint32Array.of(NO_CELL, NO_CELL), gene: Uint16Array.of(0, 0),
    });
    const index = await w.finish([0, 0]);
    const tables = new Map();
    const read = async (m) => {
      const l = index.levels[m];
      const [off, len] = l.tiles['0,0'] ?? Object.values(l.tiles)[0];
      const src = await openByteSource(path.join(dir, l.file));
      const t = await readGeneTile(src, off, len, [0], tables, l.file);
      await src.close?.();
      return t;
    };
    const coarse = await read(2); // 7.8 µm bins in 500 µm tiles: tile 0,0 holds both spots
    const fine = await read(0);
    assert.equal(fine.count.reduce((a, b) => a + b, 0), 1); // L0's 125 µm tile 0,0 holds only the first
    assert.equal(coarse.count.reduce((a, b) => a + b, 0), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
