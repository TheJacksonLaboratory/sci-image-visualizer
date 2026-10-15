import { makePolygon } from '../models/polygon-factory';
import { Rectangle, Region } from '../models/region';
import { changedClasses, classSignatures } from './class-signatures';

const rect = (id: number, label: string | undefined, x: number) =>
  Object.assign(new Region(), {
    id,
    label,
    bounds: Object.assign(new Rectangle(), { x, y: 0, width: 10, height: 10 }),
  });

describe('classSignatures / changedClasses', () => {
  it('names the classes whose regions changed: moved, added, removed or relabelled', () => {
    const before = classSignatures([rect(1, 'A', 0), rect(2, 'B', 0), rect(3, 'C', 0)]);
    const after = classSignatures([rect(1, 'A', 5), rect(2, 'B', 0), rect(3, 'D', 0), rect(4, 'E', 0)]);
    expect(changedClasses(before, after)).toEqual(new Set(['A', 'C', 'D', 'E']));
  });

  it('is unchanged by reordering, and leaves unlabelled regions and profile lines out', () => {
    const profile = Object.assign(rect(9, 'A', 50), { kind: 'profile' });
    const a = classSignatures([rect(1, 'A', 0), rect(2, 'A', 20)]);
    const b = classSignatures([rect(2, 'A', 20), rect(1, 'A', 0), rect(3, undefined, 0), profile]);
    expect(changedClasses(a, b).size).toBe(0);
    expect([...b.keys()]).toEqual(['A']);
  });

  it("sees a polygon's vertex, hole or bézier handle move", () => {
    const poly = (dx = 0, hole = 0, handle = 0) => {
      const p = makePolygon([0, 10 + dx, 10], [0, 0, 10], {
        holes: [
          [
            [2, 2],
            [3 + hole, 2],
            [3, 3],
          ],
        ],
      });
      p.bezier = true;
      p.handlesIn = [
        [handle, 0],
        [0, 0],
        [0, 0],
      ];
      return [Object.assign(new Region(), { id: 1, label: 'A', bounds: p })];
    };
    const base = classSignatures(poly());
    expect(changedClasses(base, classSignatures(poly())).size).toBe(0);
    expect(changedClasses(base, classSignatures(poly(1)))).toEqual(new Set(['A']));
    expect(changedClasses(base, classSignatures(poly(0, 1)))).toEqual(new Set(['A']));
    expect(changedClasses(base, classSignatures(poly(0, 0, 1)))).toEqual(new Set(['A']));
  });
});
