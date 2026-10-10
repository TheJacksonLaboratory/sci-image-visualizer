import type { RegionStore } from '../../../store/region-store.service';
import { RegionEdit, applyRegionEdit } from './region-edit';

describe('applyRegionEdit', () => {
  const store = () => ({
    moveRegion: jest.fn(),
    updateBounds: jest.fn(),
    moveVertex: jest.fn(),
    moveHoleVertex: jest.fn(),
    moveBezierHandle: jest.fn(),
    moveHoleBezierHandle: jest.fn(),
  });
  const run = (edit: RegionEdit, x: number, y: number) => {
    const s = store();
    applyRegionEdit(s as unknown as RegionStore, edit, x, y);
    return s;
  };

  it('moves the body by the pointer delta and remembers where it got to', () => {
    const edit: RegionEdit = { kind: 'body', id: 7, last: [1, 1] };
    expect(run(edit, 4, 6).moveRegion).toHaveBeenCalledWith(7, 3, 5);
    expect(edit.last).toEqual([4, 6]);
  });

  it('resizes a rectangle from the fixed opposite corner', () => {
    const s = run({ kind: 'corner', index: 0, anchor: [10, 10], id: 7, last: [0, 0] }, 4, 16);
    expect(s.updateBounds).toHaveBeenCalledWith(7, expect.objectContaining({ x: 4, y: 10, width: 6, height: 6 }));
  });

  it('routes a vertex or bézier handle to the exterior or its hole ring', () => {
    expect(run({ kind: 'vertex', ring: -1, index: 2, id: 7, last: [0, 0] }, 1, 2).moveVertex).toHaveBeenCalledWith(
      7,
      2,
      1,
      2,
    );
    expect(
      run({ kind: 'vertex', ring: 1, index: 2, id: 7, last: [0, 0] }, 1, 2).moveHoleVertex,
    ).toHaveBeenCalledWith(7, 1, 2, 1, 2);
    expect(
      run({ kind: 'bezier', ring: -1, index: 3, side: 'in', id: 7, last: [0, 0] }, 1, 2).moveBezierHandle,
    ).toHaveBeenCalledWith(7, 3, 'in', 1, 2);
    expect(
      run({ kind: 'bezier', ring: 0, index: 3, side: 'out', id: 7, last: [0, 0] }, 1, 2).moveHoleBezierHandle,
    ).toHaveBeenCalledWith(7, 0, 3, 'out', 1, 2);
  });
});
