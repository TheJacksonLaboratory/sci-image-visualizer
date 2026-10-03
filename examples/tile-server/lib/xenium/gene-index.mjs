/**
 * Per-gene levels of the transcript pyramid: for each level of the all-gene pyramid (same bins,
 * same origin), every (gene, bin) with its transcript count, centroid and dominant cell — so a
 * selection of genes can be drawn at any zoom from a few small reads.
 *
 * Layout, next to the all-gene pyramid in `<pyramid>/genes/`:
 *   index.json  { version, origin, baseBin, tileBins, genes: [names], levels: [{ bin, tileSize,
 *                 file, tiles: { "tx,ty": [byteOffset, byteLength] } }] }
 *   L<m>.bin    one block per 64 × 64-bin tile:
 *                 u32 G, then G × (u32 gene, u32 first, u32 count) sorted by gene,
 *                 then the records: f32 cx, f32 cy, u32 count, u32 cell (16 bytes), gene by gene.
 *
 * Every bin up to the 250 µm level nests inside one 250 µm source tile, so each source tile is
 * aggregated on its own. Levels whose output tiles fit inside a source tile are written as they
 * are made; coarser tiles collect their source tiles' records in temporary files, sorted by gene
 * at the end.
 */

import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TOP_CELLS, addCell, topCell } from './cell-summary.mjs';

const NO_CELL = 0xffffffff;
const RECORD = 16;
const TEMP_RECORD = 20; // gene + record

/**
 * @param o.outDir        `<pyramid>/genes`
 * @param o.levels        number of levels (as the all-gene pyramid)
 * @param o.baseBin       finest bin (µm)
 * @param o.sourceTile    source tile size (µm)
 * @param o.basePerSource finest bins per source tile side (128)
 * @param o.tileBins      bins per output tile side (64)
 * @param o.gxMin/gyMin   the grid origin, in source tiles
 * @param o.geneNames     gene names, by gene index
 */
export async function createGeneLevels(o) {
  const { outDir, levels, baseBin, sourceTile, basePerSource, tileBins, gxMin, gyMin, geneNames } = o;
  await mkdir(outDir, { recursive: true });
  const tempDir = `${outDir}/.tmp`;
  await mkdir(tempDir, { recursive: true });

  // Final level files: blocks appended in the order tiles complete.
  const finals = [];
  for (let m = 0; m < levels; m++) {
    const file = `L${m}.bin`;
    const stream = createWriteStream(path.join(outDir, file));
    finals.push({ file, stream, offset: 0, tiles: {} });
  }
  const writeBlock = (m, key, block) => new Promise((resolve, reject) => {
    const f = finals[m];
    f.tiles[key] = [f.offset, block.length];
    f.offset += block.length;
    f.stream.write(block, (err) => (err ? reject(err) : resolve()));
  });

  // Coarse levels: records gathered per output tile in temp files, buffered in memory a while.
  const pending = new Map(); // "m|tx,ty" → Buffer[]
  let pendingBytes = 0;
  const flushPending = async () => {
    for (const [key, parts] of pending) await appendFile(path.join(tempDir, key.replace('|', '_')), Buffer.concat(parts));
    pending.clear();
    pendingBytes = 0;
  };

  /** Whether level m's output tiles fit inside a source tile (so they are complete with it). */
  const local = (m) => (tileBins << m) <= basePerSource;

  return {
    /** Aggregate one source tile's transcripts (`t` from readAllTranscripts) into every level. */
    async addSourceTile(gx, gy, t) {
      if (!t.n) return;
      const x0 = gx * sourceTile;
      const y0 = gy * sourceTile;
      const side = basePerSource;
      // Finest level: one group per (gene, bin), with a top-cells summary.
      const gid = new Map();
      const g0 = [];
      const b0 = [];
      const cnt = [];
      const sx = [];
      const sy = [];
      const cand = [];
      const candN = [];
      for (let i = 0; i < t.n; i++) {
        const bx = Math.min(side - 1, Math.max(0, Math.floor((t.x[i] - x0) / baseBin)));
        const by = Math.min(side - 1, Math.max(0, Math.floor((t.y[i] - y0) / baseBin)));
        const b = by * side + bx;
        const key = t.gene[i] * side * side + b;
        let k = gid.get(key);
        if (k === undefined) {
          k = cnt.length;
          gid.set(key, k);
          g0.push(t.gene[i]); b0.push(b); cnt.push(0); sx.push(0); sy.push(0);
          for (let j = 0; j < TOP_CELLS; j++) { cand.push(NO_CELL); candN.push(0); }
        }
        cnt[k]++;
        sx[k] += t.x[i];
        sy[k] += t.y[i];
        if (t.cell[i] !== NO_CELL) addCell(cand, candN, k, t.cell[i], 1);
      }
      for (let m = 0; m < levels; m++) {
        const sideM = Math.max(1, side >> m);
        // Roll the finest groups up to this level's bins.
        const acc = new Map(); // gene * sideM² + binM → index
        const out = { gene: [], bin: [], n: [], sx: [], sy: [], cand: [], candN: [] };
        for (let k = 0; k < cnt.length; k++) {
          const bx = (b0[k] % side) >> m;
          const by = Math.floor(b0[k] / side) >> m;
          const bm = Math.min(sideM - 1, by) * sideM + Math.min(sideM - 1, bx);
          const key = g0[k] * sideM * sideM + bm;
          let a = acc.get(key);
          if (a === undefined) {
            a = out.n.length;
            acc.set(key, a);
            out.gene.push(g0[k]); out.bin.push(bm); out.n.push(0); out.sx.push(0); out.sy.push(0);
            for (let j = 0; j < TOP_CELLS; j++) { out.cand.push(NO_CELL); out.candN.push(0); }
          }
          out.n[a] += cnt[k];
          out.sx[a] += sx[k];
          out.sy[a] += sy[k];
          for (let j = 0; j < TOP_CELLS; j++) {
            const c = cand[k * TOP_CELLS + j];
            if (c !== NO_CELL) addCell(out.cand, out.candN, a, c, candN[k * TOP_CELLS + j]);
          }
        }
        // Group by output tile, gene-ordered within it.
        const byTile = new Map();
        const order = [...acc.entries()].sort((p, q) => p[0] - q[0]).map((e) => e[1]);
        for (const a of order) {
          const gbx = (gx - gxMin) * sideM + (out.bin[a] % sideM);
          const gby = (gy - gyMin) * sideM + Math.floor(out.bin[a] / sideM);
          const tk = `${Math.floor(gbx / tileBins)},${Math.floor(gby / tileBins)}`;
          let list = byTile.get(tk);
          if (!list) byTile.set(tk, (list = []));
          list.push(a);
        }
        for (const [tk, list] of byTile) {
          const rec = (a, buf, off) => {
            buf.writeFloatLE(out.sx[a] / out.n[a], off);
            buf.writeFloatLE(out.sy[a] / out.n[a], off + 4);
            buf.writeUInt32LE(out.n[a], off + 8);
            buf.writeUInt32LE(topCell(out.cand, out.candN, a), off + 12);
          };
          if (local(m)) {
            const genesOf = list.map((a) => out.gene[a]);
            await writeBlock(m, tk, block(genesOf, list.length, (i, buf, off) => rec(list[i], buf, off)));
          } else {
            const buf = Buffer.alloc(list.length * TEMP_RECORD);
            list.forEach((a, i) => {
              buf.writeUInt32LE(out.gene[a], i * TEMP_RECORD);
              rec(a, buf, i * TEMP_RECORD + 4);
            });
            const key = `${m}|${tk}`;
            const parts = pending.get(key) ?? [];
            parts.push(buf);
            pending.set(key, parts);
            pendingBytes += buf.length;
          }
        }
      }
      if (pendingBytes > 256 << 20) await flushPending();
    },

    /** Sort and write the coarse tiles, and the index. */
    async finish(origin) {
      await flushPending();
      const { readdir } = await import('node:fs/promises');
      for (const name of await readdir(tempDir)) {
        const [m, tk] = name.split('_');
        const buf = await readFile(path.join(tempDir, name));
        const n = buf.length / TEMP_RECORD;
        // Stable order by gene (counting sort over the genes present).
        const idx = Uint32Array.from({ length: n }, (_v, i) => i);
        const geneAt = (i) => buf.readUInt32LE(i * TEMP_RECORD);
        idx.sort((a, b) => geneAt(a) - geneAt(b) || a - b);
        await writeBlock(Number(m), tk, block(Array.from(idx, geneAt), n,
          (i, out, off) => buf.copy(out, off, idx[i] * TEMP_RECORD + 4, idx[i] * TEMP_RECORD + TEMP_RECORD)));
        await rm(path.join(tempDir, name));
      }
      await rm(tempDir, { recursive: true, force: true });
      for (const f of finals) await new Promise((resolve) => f.stream.end(resolve));
      const index = {
        version: 1, origin, baseBin, tileBins, genes: geneNames,
        levels: finals.map((f, m) => ({
          bin: baseBin * 2 ** m, tileSize: baseBin * 2 ** m * tileBins, file: f.file, tiles: f.tiles,
        })),
      };
      await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index));
      return index;
    },
  };
}

/** One tile block: the gene table, then `n` records written by `put(i, buf, offset)`. */
function block(genesOfRecords, n, put) {
  const table = [];
  for (let i = 0; i < n; i++) {
    const g = genesOfRecords[i];
    const last = table[table.length - 1];
    if (last && last.gene === g) last.count++;
    else table.push({ gene: g, first: i, count: 1 });
  }
  const head = 4 + table.length * 12;
  const buf = Buffer.alloc(head + n * RECORD);
  buf.writeUInt32LE(table.length, 0);
  table.forEach((e, j) => {
    buf.writeUInt32LE(e.gene, 4 + j * 12);
    buf.writeUInt32LE(e.first, 8 + j * 12);
    buf.writeUInt32LE(e.count, 12 + j * 12);
  });
  for (let i = 0; i < n; i++) put(i, buf, head + i * RECORD);
  return buf;
}

/**
 * Read genes `wanted` (indices) from one tile block, as transcript-tile arrays: each entry's
 * `gene` is its position in `wanted`.
 */
export function readGeneBlock(buf, wanted) {
  const g = buf.readUInt32LE(0);
  const head = 4 + g * 12;
  const table = new Map();
  for (let j = 0; j < g; j++) {
    table.set(buf.readUInt32LE(4 + j * 12), [buf.readUInt32LE(8 + j * 12), buf.readUInt32LE(12 + j * 12)]);
  }
  let n = 0;
  for (const w of wanted) n += table.get(w)?.[1] ?? 0;
  const out = {
    n, x: new Float32Array(n), y: new Float32Array(n), count: new Uint32Array(n),
    cell: new Uint32Array(n), gene: new Uint16Array(n),
  };
  let o = 0;
  wanted.forEach((w, slot) => {
    const e = table.get(w);
    if (!e) return;
    for (let i = e[0]; i < e[0] + e[1]; i++, o++) {
      const off = head + i * RECORD;
      out.x[o] = buf.readFloatLE(off);
      out.y[o] = buf.readFloatLE(off + 4);
      out.count[o] = buf.readUInt32LE(off + 8);
      out.cell[o] = buf.readUInt32LE(off + 12);
      out.gene[o] = slot;
    }
  });
  return out;
}

/**
 * Read genes `wanted` (indices) of one tile through `source` (a byte source over its level file),
 * touching only the tile's gene table and those genes' records — a coarse tile can be hundreds of
 * MB, of which a selection needs a few KB. `tables` caches gene tables by file and `off` (a
 * {@link TableCache}, so panning a large index does not keep every table it visits).
 */
/** A Map of at most `max` entries, dropping the least recently read. */
export class TableCache extends Map {
  constructor(max = 512) {
    super();
    this.max = max;
  }

  get(key) {
    const v = super.get(key);
    if (v !== undefined) {
      super.delete(key);
      super.set(key, v);
    }
    return v;
  }

  set(key, value) {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.max) super.delete(this.keys().next().value);
    return this;
  }
}

export async function readGeneTile(source, off, len, wanted, tables, file = '') {
  // Keyed by file too: every level's file has a tile at offset 0.
  const key = `${file}|${off}`;
  let table = tables?.get(key);
  if (!table) {
    const g = (await source.read(off, 4)).readUInt32LE(0);
    const head = await source.read(off + 4, g * 12);
    table = { head: 4 + g * 12, genes: new Map() };
    for (let j = 0; j < g; j++) {
      table.genes.set(head.readUInt32LE(j * 12), [head.readUInt32LE(j * 12 + 4), head.readUInt32LE(j * 12 + 8)]);
    }
    tables?.set(key, table);
  }
  const parts = await Promise.all(wanted.map(async (w, slot) => {
    const e = table.genes.get(w);
    if (!e || e[1] === 0) return null;
    return { slot, n: e[1], buf: await source.read(off + table.head + e[0] * RECORD, e[1] * RECORD) };
  }));
  let n = 0;
  for (const p of parts) if (p) n += p.n;
  const out = {
    n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), count: new Uint32Array(n),
    cell: new Uint32Array(n), gene: new Uint16Array(n),
  };
  let o = 0;
  for (const p of parts) {
    if (!p) continue;
    for (let i = 0; i < p.n; i++, o++) {
      out.x[o] = p.buf.readFloatLE(i * RECORD);
      out.y[o] = p.buf.readFloatLE(i * RECORD + 4);
      out.count[o] = p.buf.readUInt32LE(i * RECORD + 8);
      out.cell[o] = p.buf.readUInt32LE(i * RECORD + 12);
      out.gene[o] = p.slot;
    }
  }
  void len;
  return out;
}
