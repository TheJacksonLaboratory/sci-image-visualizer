/**
 * A coarse transcript bin is coloured by its dominant cell: the cell with the most of its
 * transcripts across every base bin it folds, kept as a small top-cells summary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TOP_CELLS, addCell, topCell } from '../lib/xenium/transcript-index.mjs';

const NO_CELL = 0xffffffff;
const summary = (slots = 1) => ({
  cand: new Uint32Array(slots * TOP_CELLS).fill(NO_CELL), candN: new Uint32Array(slots * TOP_CELLS),
});

test("adds a cell's transcripts across base bins, rather than taking the busiest bin's cell", () => {
  const s = summary();
  // Base bin A: 100 transcripts, split 34 / 33 / 33 between cells 1, 2, 3.
  addCell(s.cand, s.candN, 0, 1, 34);
  addCell(s.cand, s.candN, 0, 2, 33);
  addCell(s.cand, s.candN, 0, 3, 33);
  // Base bin B: 50 transcripts, all cell 2. The busiest base bin's cell is 1; cell 2 has 83.
  addCell(s.cand, s.candN, 0, 2, 50);
  assert.equal(topCell(s.cand, s.candN, 0), 2);
});

test('is exact while a bin holds at most TOP_CELLS cells, and keeps slots apart', () => {
  const s = summary(2);
  for (let c = 0; c < TOP_CELLS; c++) addCell(s.cand, s.candN, 1, c, c + 1);
  assert.equal(topCell(s.cand, s.candN, 1), TOP_CELLS - 1);
  assert.equal(topCell(s.cand, s.candN, 0), NO_CELL);
});

test('a cell holding a real share survives many small ones', () => {
  const s = summary();
  addCell(s.cand, s.candN, 0, 7, 40);
  for (let c = 100; c < 140; c++) addCell(s.cand, s.candN, 0, c, 1);
  assert.equal(topCell(s.cand, s.candN, 0), 7);
});
