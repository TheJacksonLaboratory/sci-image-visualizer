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
//   every level's bins nest inside the source tiles: levels m = 0..L-1 have bins of
//   1.95 · 2^m µm. L defaults to 7 (1.95 … 125 µm); prepare-xenium builds one level per
//   level of the dataset's image pyramid (8 for the cervical bundle: up to 250 µm). Each
//   level is stored in tiles of 64 × 64 bins.
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openXeniumSource, readAllTranscripts, BIN_RECORD } from '../spatial-xenium.mjs';

const SOURCE_TILE = 250;
const BASE_PER_SOURCE = 128;
const TILE_BINS = 64;
/** Levels when nothing says otherwise; a build next to an image pyramid matches its levels. */
export const DEFAULT_LEVELS = 7;
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
  // Every (bin, cell, count) run, so the coarser levels can add up each cell's share.
  const runs = { bin: [], cell: [], n: [] };
  for (let i = 0; i < keys.length;) {
    let j = i;
    while (j < keys.length && keys[j] === keys[i]) j++;
    const b = Math.floor(keys[i] / CELL_SHIFT);
    const c = keys[i] - b * CELL_SHIFT;
    if (c > 0) {
      runs.bin.push(b);
      runs.cell.push(c - 1);
      runs.n.push(j - i);
      if (j - i > best[b]) {
        best[b] = j - i;
        cell[b] = c - 1;
      }
    }
    i = j;
  }
  return { count, sx, sy, cell, runs };
}

/** Cells a coarse bin tracks (Space-Saving): exact for bins with at most this many cells. */
export const TOP_CELLS = 4;

/**
 * Add `n` transcripts of `cell` to the top-cells summary at `slot` (TOP_CELLS entries of
 * `cand`/`candN` from `slot * TOP_CELLS`). Space-Saving: a new cell replaces the smallest
 * entry and inherits its count, so a cell holding a real share of the bin is never lost.
 */
export function addCell(cand, candN, slot, cell, n) {
  const at = slot * TOP_CELLS;
  let min = at;
  for (let i = at; i < at + TOP_CELLS; i++) {
    if (cand[i] === cell) {
      candN[i] += n;
      return;
    }
    if (cand[i] === NO_CELL) {
      cand[i] = cell;
      candN[i] = n;
      return;
    }
    if (candN[i] < candN[min]) min = i;
  }
  cand[min] = cell;
  candN[min] += n;
}

/** The cell with the most transcripts in the summary at `slot`, or NO_CELL. */
export function topCell(cand, candN, slot) {
  const at = slot * TOP_CELLS;
  let best = NO_CELL;
  let most = 0;
  for (let i = at; i < at + TOP_CELLS; i++) {
    if (cand[i] !== NO_CELL && candN[i] > most) {
      most = candN[i];
      best = cand[i];
    }
  }
  return best;
}

/**
 * How many levels the image pyramid in `dir` has (its `descriptor.json`), or null — so the
 * transcript pyramid can offer one level per image level.
 */
export async function imagePyramidLevels(dir) {
  try {
    const d = JSON.parse(await readFile(path.join(dir, 'descriptor.json'), 'utf8'));
    return Array.isArray(d.levels) && d.levels.length > 0 ? d.levels.length : null;
  } catch {
    return null;
  }
}

/** Build the pyramid for `source` into `outDir`, with `levels` levels (base bin doubling each). */
export async function buildTranscriptIndex(
  source, outDir,
  {
    concurrency = 4, log = console.log, limitTiles = Infinity, dataset = null, onProgress,
    levels = DEFAULT_LEVELS,
  } = {},
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
  for (let m = 1; m < levels; m++) {
    dense[m] = { w: Math.ceil(baseW / 2 ** m), h: Math.ceil(baseH / 2 ** m), blocks: new Map() };
  }
  const BLOCK = TILE_BINS * TILE_BINS;
  const blockAt = (L, tx, ty, create) => {
    const key = `${tx},${ty}`;
    let b = L.blocks.get(key);
    if (!b && create) {
      b = {
        count: new Uint32Array(BLOCK), sx: new Float64Array(BLOCK), sy: new Float64Array(BLOCK),
        cand: new Uint32Array(BLOCK * TOP_CELLS).fill(NO_CELL), candN: new Uint32Array(BLOCK * TOP_CELLS),
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
  const emit = async ([gx, gy], n, { count, sx, sy, cell, runs }) => {
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
    // Fold into the coarser levels: counts and centroids add up, and each coarse bin keeps
    // a top-cells summary of every cell's transcripts in it, so its cell is the one with the
    // most transcripts across all its base bins — not merely the cell of its busiest one.
    const coarse = (b, m) => {
      const cx = ((gx - gxMin) * BASE_PER_SOURCE + (b % BASE_PER_SOURCE)) >> m;
      const cy = ((gy - gyMin) * BASE_PER_SOURCE + Math.floor(b / BASE_PER_SOURCE)) >> m;
      const B = blockAt(dense[m], Math.floor(cx / TILE_BINS), Math.floor(cy / TILE_BINS), true);
      return [B, (cy % TILE_BINS) * TILE_BINS + (cx % TILE_BINS)];
    };
    for (let b = 0; b < count.length; b++) {
      const c = count[b];
      if (!c) continue;
      for (let m = 1; m < levels; m++) {
        const [B, k] = coarse(b, m);
        B.count[k] += c;
        B.sx[k] += sx[b];
        B.sy[k] += sy[b];
      }
    }
    for (let r = 0; r < runs.bin.length; r++) {
      for (let m = 1; m < levels; m++) {
        const [B, k] = coarse(runs.bin[r], m);
        addCell(B.cand, B.candN, k, runs.cell[r], runs.n[r]);
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

  const levelMeta = [{
    bin: baseBin, tileSize: baseBin * TILE_BINS, file: 'L0.bin', tiles: base.tiles,
  }];
  for (let m = 1; m < levels; m++) {
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
              if (c) parts.push(record(B.sx[k] / c, B.sy[k] / c, c, topCell(B.cand, B.candN, k)));
            }
          }
          L.blocks.delete(`${tx},${ty}`); // written: free it
        }
        await w.writeTile(`${tx},${ty}`, Buffer.concat(parts));
      }
    }
    await w.close();
    const bin = baseBin * 2 ** m;
    levelMeta.push({ bin, tileSize: bin * TILE_BINS, file, tiles: w.tiles });
  }

  const index = { version: 1, origin, baseBin, tileBins: TILE_BINS, total, levels: levelMeta };
  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index));
  log(`[transcript-index] done: ${total} transcripts, ${levelMeta.length} levels -> ${outDir}`);
  return index;
}
