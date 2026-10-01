// Build the ALL-GENE transcript grouping pyramid for a Xenium bundle.
//
// 10x ships transcripts pre-aggregated per GENE; across all genes even its coarsest level
// is ~32 million clusters, far more than a canvas can draw. Showing "every transcript" at
// any zoom needs a gene-independent grouping: square bins, each level four times coarser
// than the one below, each bin carrying how many transcripts fell in it, their centroid,
// and the cell that contributed most of them (so the viewer can colour it by cell type).
// The viewer then picks the finest level whose bins on screen fit its marker budget, and
// draws the transcripts themselves once THEY fit.
//
// GEOMETRY
//   Source tiles are 10x's 250 µm level-0 grid. The finest bin is 250/128 µm (1.95 µm) so
//   every level's bins nest inside the source tiles: levels m = 0..6 have bins of
//   1.95 · 2^m µm (1.95 … 125 µm). Each level is stored in tiles of 64 × 64 bins.
//   Coordinates are relative to `origin`, the near corner of the lowest source tile.
//
// ON DISK  (<out>/)
//   index.json   { version, origin, baseBin, tileBins, total, levels: [{ bin, tileSize,
//                  file, tiles: { "tx,ty": [firstRecord, recordCount] } }] }
//   L{m}.bin     records of 16 bytes: f32 cx, f32 cy, u32 count, u32 cell (0xffffffff: none)
//
// COST
//   One pass over every transcript (~1.2 billion rows, ~7.6 GB of compressed locations)
//   plus the cell mask for the cell lookup — tens of minutes. Run it next to the data
//   (Cloud Build against the GCS copy); the result is a few hundred MB.

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openXeniumSource, readAllTranscripts, BIN_RECORD } from '../spatial-xenium.mjs';

const SOURCE_TILE = 250;
const BASE_PER_SOURCE = 128;
const TILE_BINS = 64;
const LEVELS = 7;
const NO_CELL = 0xffffffff;
const CELL_SHIFT = 2 ** 20; // cell index + 1 fits below this (717k cells)

/** A level-file writer that remembers where each tile's records start. */
function levelWriter(file) {
  const stream = createWriteStream(file);
  const tiles = {};
  let records = 0;
  return {
    tiles,
    async writeTile(key, buf) {
      const n = buf.length / BIN_RECORD;
      if (!n) return;
      tiles[key] = [records, n];
      records += n;
      if (!stream.write(buf)) await new Promise((r) => stream.once('drain', r));
    },
    close: () => new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.end(resolve);
    }),
  };
}

function record(cx, cy, count, cell) {
  const b = Buffer.alloc(BIN_RECORD);
  b.writeFloatLE(cx, 0);
  b.writeFloatLE(cy, 4);
  b.writeUInt32LE(count, 8);
  b.writeUInt32LE(cell, 12);
  return b;
}

/**
 * Bin one source tile at the base resolution.
 * Returns per local bin: count, centroid, and the dominant cell.
 */
function binSourceTile(t, gx, gy, baseBin) {
  const nb = BASE_PER_SOURCE * BASE_PER_SOURCE;
  const count = new Uint32Array(nb);
  const sx = new Float64Array(nb);
  const sy = new Float64Array(nb);
  const keys = new Float64Array(t.n);
  const x0 = gx * SOURCE_TILE;
  const y0 = gy * SOURCE_TILE;
  for (let i = 0; i < t.n; i++) {
    const bx = Math.min(BASE_PER_SOURCE - 1, Math.max(0, Math.floor((t.x[i] - x0) / baseBin)));
    const by = Math.min(BASE_PER_SOURCE - 1, Math.max(0, Math.floor((t.y[i] - y0) / baseBin)));
    const b = by * BASE_PER_SOURCE + bx;
    count[b]++;
    sx[b] += t.x[i];
    sy[b] += t.y[i];
    keys[i] = b * CELL_SHIFT + (t.cell[i] === NO_CELL ? 0 : t.cell[i] + 1);
  }
  // Dominant cell per bin: sort (bin, cell) keys and take the longest run of an assigned
  // cell; a bin whose transcripts all lie outside cells keeps NO_CELL.
  keys.sort();
  const cell = new Uint32Array(nb).fill(NO_CELL);
  const best = new Uint32Array(nb);
  for (let i = 0; i < keys.length;) {
    let j = i;
    while (j < keys.length && keys[j] === keys[i]) j++;
    const b = Math.floor(keys[i] / CELL_SHIFT);
    const c = keys[i] - b * CELL_SHIFT;
    if (c > 0 && j - i > best[b]) {
      best[b] = j - i;
      cell[b] = c - 1;
    }
    i = j;
  }
  return { count, sx, sy, cell };
}

/** Build the pyramid for `source` into `outDir`. */
export async function buildTranscriptIndex(
  source, outDir,
  { concurrency = 4, log = console.log, limitTiles = Infinity, dataset = null, onProgress } = {},
) {
  const ds = dataset ?? await openXeniumSource(source);
  // `limitTiles` builds a partial pyramid over the first tiles only — for testing.
  const keys = [...ds.transcriptLevels[0]].map((k) => k.split(',').map(Number)).slice(0, limitTiles);
  const gxMin = Math.min(...keys.map((k) => k[0]));
  const gyMin = Math.min(...keys.map((k) => k[1]));
  const gxMax = Math.max(...keys.map((k) => k[0]));
  const gyMax = Math.max(...keys.map((k) => k[1]));
  const origin = [gxMin * SOURCE_TILE, gyMin * SOURCE_TILE];
  const baseBin = SOURCE_TILE / BASE_PER_SOURCE;
  const baseW = (gxMax - gxMin + 1) * BASE_PER_SOURCE;
  const baseH = (gyMax - gyMin + 1) * BASE_PER_SOURCE;

  // Accumulators for the coarser levels (the base level is written as it is made), one
  // block per output tile, allocated when a transcript first lands in it — so memory follows
  // the tissue, not the bounding rectangle with all its empty space.
  const dense = [];
  for (let m = 1; m < LEVELS; m++) {
    dense[m] = { w: Math.ceil(baseW / 2 ** m), h: Math.ceil(baseH / 2 ** m), blocks: new Map() };
  }
  const BLOCK = TILE_BINS * TILE_BINS;
  const blockAt = (L, tx, ty, create) => {
    const key = `${tx},${ty}`;
    let b = L.blocks.get(key);
    if (!b && create) {
      b = {
        count: new Uint32Array(BLOCK), sx: new Float64Array(BLOCK), sy: new Float64Array(BLOCK),
        best: new Uint32Array(BLOCK), cell: new Uint32Array(BLOCK).fill(NO_CELL),
      };
      L.blocks.set(key, b);
    }
    return b;
  };

  await mkdir(outDir, { recursive: true });
  const base = levelWriter(path.join(outDir, 'L0.bin'));
  let total = 0;
  let done = 0;
  const t0 = Date.now();

  /** Write one binned tile's base records and fold it into the coarser levels. */
  const emit = async ([gx, gy], n, { count, sx, sy, cell }) => {
    total += n;
    // Base level: this source tile is exactly 2 × 2 storage tiles.
    const sub = BASE_PER_SOURCE / TILE_BINS;
    for (let qy = 0; qy < sub; qy++) {
      for (let qx = 0; qx < sub; qx++) {
        const parts = [];
        for (let by = qy * TILE_BINS; by < (qy + 1) * TILE_BINS; by++) {
          for (let bx = qx * TILE_BINS; bx < (qx + 1) * TILE_BINS; bx++) {
            const b = by * BASE_PER_SOURCE + bx;
            if (count[b]) parts.push(record(sx[b] / count[b], sy[b] / count[b], count[b], cell[b]));
          }
        }
        const tx = (gx - gxMin) * sub + qx;
        const ty = (gy - gyMin) * sub + qy;
        await base.writeTile(`${tx},${ty}`, Buffer.concat(parts));
      }
    }
    // Fold into the coarser levels. A coarse bin's cell is the cell of its heaviest base
    // bin — the dominant contributor, without carrying every (bin, cell) pair upward.
    for (let by = 0; by < BASE_PER_SOURCE; by++) {
      for (let bx = 0; bx < BASE_PER_SOURCE; bx++) {
        const b = by * BASE_PER_SOURCE + bx;
        const c = count[b];
        if (!c) continue;
        const gbx = (gx - gxMin) * BASE_PER_SOURCE + bx;
        const gby = (gy - gyMin) * BASE_PER_SOURCE + by;
        for (let m = 1; m < LEVELS; m++) {
          const cx = gbx >> m;
          const cy = gby >> m;
          const B = blockAt(dense[m], Math.floor(cx / TILE_BINS), Math.floor(cy / TILE_BINS), true);
          const k = (cy % TILE_BINS) * TILE_BINS + (cx % TILE_BINS);
          B.count[k] += c;
          B.sx[k] += sx[b];
          B.sy[k] += sy[b];
          if (c > B.best[k] && cell[b] !== NO_CELL) {
            B.best[k] = c;
            B.cell[k] = cell[b];
          }
        }
      }
    }
    done++;
    onProgress?.(done, keys.length);
    if (done % 25 === 0 || done === keys.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      log(`[transcript-index] ${done}/${keys.length} tiles, ${(total / 1e6).toFixed(0)}M transcripts, ` +
        `~${Math.round((keys.length - done) / rate)}s left`);
    }
  };

  // Reads and binning run `concurrency` tiles at a time; the writes, which append to one
  // file, are chained so they happen one tile after another.
  let next = 0;
  let writing = Promise.resolve();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < keys.length) {
      const k = keys[next++];
      const t = await readAllTranscripts(ds, k[0], k[1]);
      const binned = binSourceTile(t, k[0], k[1], baseBin);
      writing = writing.then(() => emit(k, t.n, binned));
      await writing;
    }
  }));
  await base.close();

  const levels = [{
    bin: baseBin, tileSize: baseBin * TILE_BINS, file: 'L0.bin', tiles: base.tiles,
  }];
  for (let m = 1; m < LEVELS; m++) {
    const L = dense[m];
    const file = `L${m}.bin`;
    const w = levelWriter(path.join(outDir, file));
    for (let ty = 0; ty * TILE_BINS < L.h; ty++) {
      for (let tx = 0; tx * TILE_BINS < L.w; tx++) {
        const parts = [];
        const B = blockAt(L, tx, ty, false);
        if (B) {
          for (let by = ty * TILE_BINS; by < Math.min(L.h, (ty + 1) * TILE_BINS); by++) {
            for (let bx = tx * TILE_BINS; bx < Math.min(L.w, (tx + 1) * TILE_BINS); bx++) {
              const k = (by - ty * TILE_BINS) * TILE_BINS + (bx - tx * TILE_BINS);
              const c = B.count[k];
              if (c) parts.push(record(B.sx[k] / c, B.sy[k] / c, c, B.cell[k]));
            }
          }
          L.blocks.delete(`${tx},${ty}`); // written: free it
        }
        await w.writeTile(`${tx},${ty}`, Buffer.concat(parts));
      }
    }
    await w.close();
    const bin = baseBin * 2 ** m;
    levels.push({ bin, tileSize: bin * TILE_BINS, file, tiles: w.tiles });
  }

  const index = { version: 1, origin, baseBin, tileBins: TILE_BINS, total, levels };
  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index));
  log(`[transcript-index] done: ${total} transcripts, ${levels.length} levels -> ${outDir}`);
  return index;
}
