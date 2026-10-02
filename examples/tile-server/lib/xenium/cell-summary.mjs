/** A bounded top-cells summary per bin (Space-Saving), shared by the pyramid builders. */

const NO_CELL = 0xffffffff;

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
