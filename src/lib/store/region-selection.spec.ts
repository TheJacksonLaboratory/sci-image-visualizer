import { RegionSelection } from './region-selection';

const regs = (...ids: number[]) => ids.map((id) => ({ id }));

describe('RegionSelection', () => {
  let sel: RegionSelection;
  let seen: number[][];

  beforeEach(() => {
    sel = new RegionSelection();
    seen = [];
    sel.indices$.subscribe((i) => seen.push(i));
  });

  it('selects by index, dropping invalid and duplicate indices, keeping order', () => {
    sel.selectIndices([2, -1, 0, 2, 7, NaN], regs(10, 11, 12));
    expect(sel.ids).toEqual([12, 10]);
    expect(sel.indices).toEqual([2, 0]);
  });

  it('follows ids across a reorder and prunes ids that are gone', () => {
    sel.selectIndices([0, 1], regs(10, 11));
    sel.sync(regs(11, 99));
    expect(sel.indices).toEqual([0]);
    expect(sel.ids).toEqual([11]);
  });

  it('replace and retain are silent until sync', () => {
    sel.replace([5, 6]);
    sel.retain((id) => id !== 5);
    expect(seen).toEqual([[]]);
    sel.sync(regs(6));
    expect(seen).toEqual([[], [0]]);
  });

  it('emits only when the projected index set changes', () => {
    sel.selectIndices([1], regs(1, 2));
    sel.sync(regs(1, 2));
    sel.selectIndices([1], regs(1, 2));
    expect(seen).toEqual([[], [1]]);
  });
});
