import { indexOutlines, sectionOutlines } from './section';

const square = (x: number, y: number, s: number) => Float64Array.of(x, y, x + s, y, x + s, y + s, x, y + s);

/** The (u, v) bounding box of a section's rings. */
function box(rings: Float64Array[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      b[0] = Math.min(b[0], r[i]);
      b[1] = Math.min(b[1], r[i + 1]);
      b[2] = Math.max(b[2], r[i]);
      b[3] = Math.max(b[3], r[i + 1]);
    }
  }
  return b;
}

describe('sectionOutlines', () => {
  // A 20 px square on slices 2..5 at (10..30, 40..60), a 10 px one on slice 7.
  const stack = new Map([
    [
      'A',
      [...[2, 3, 4, 5].map((z) => ({ z, rings: [square(10, 40, 20)] })), { z: 7, rings: [square(100, 0, 10)] }],
    ],
  ]);

  it('cuts closed shapes along x: slices across (u), image y down (v), one slice thick', () => {
    const cut = sectionOutlines(stack, 'x', 20, { depth: 10, extent: 100 });
    expect([...cut.keys()]).toEqual(['A']);
    // Slices 2..5 → u 2..6; y 40..60. The square on slice 7 is at x 100..110: not cut.
    expect(box(cut.get('A')!.rings)).toEqual([2, 40, 6, 60]);
    expect(cut.get('A')!.lines).toEqual([]);
  });

  it('cuts closed shapes along y: image x across (u), slices down (v), at the cell size asked', () => {
    const cut = sectionOutlines(stack, 'y', 5, { depth: 10, extent: 200, step: 2 });
    expect(box(cut.get('A')!.rings)).toEqual([100, 7, 110, 8]);
    expect(sectionOutlines(stack, 'y', 500, { depth: 10, extent: 200 }).size).toBe(0);
  });

  it('keeps a hole: a ring around a hole cuts into two intervals per slice', () => {
    const donut = new Map([['D', [0, 1].map((z) => ({ z, rings: [square(0, 0, 30), square(10, 10, 10)] }))]]);
    const cut = sectionOutlines(donut, 'x', 15, { depth: 2, extent: 30 });
    // Two separate pieces: y 0..10 and 20..30.
    expect(cut.get('D')!.rings.length).toBe(2);
    expect(box(cut.get('D')!.rings)).toEqual([0, 0, 2, 30]);
  });

  it('joins a line crossing on each slice into the line it draws across the stack', () => {
    // A boundary at y = 50 + z on slices 0..3, and a second one at y = 90 on slices 0..1.
    const lines = new Map([
      [
        'ILM',
        [0, 1, 2, 3].map((z) => ({
          z,
          rings: [],
          lines: [Float64Array.of(0, 50 + z, 100, 50 + z), ...(z < 2 ? [Float64Array.of(100, 90, 0, 90)] : [])],
        })),
      ],
    ]);
    const cut = sectionOutlines(lines, 'x', 40, { depth: 4, extent: 120 });
    const drawn = cut.get('ILM')!.lines.map((l) => Array.from(l));
    expect(drawn).toContainEqual([0.5, 50, 1.5, 51, 2.5, 52, 3.5, 53]);
    expect(drawn).toContainEqual([0.5, 90, 1.5, 90]);
    expect(cut.get('ILM')!.rings).toEqual([]);
  });

  it('breaks a line that jumps farther than allowed between slices', () => {
    const lines = new Map([
      [
        'L',
        [
          { z: 0, rings: [], lines: [Float64Array.of(0, 10, 10, 10)] },
          { z: 1, rings: [], lines: [Float64Array.of(0, 80, 10, 80)] },
        ],
      ],
    ]);
    const cut = sectionOutlines(lines, 'x', 5, { depth: 2, extent: 100, maxJump: 20 });
    expect(cut.get('L')!.lines.map((l) => l.length)).toEqual([2, 2]);
    // Along y the line lies in the plane's direction: through y = 10 it is not crossed (half-open).
    expect(sectionOutlines(lines, 'y', 50, { depth: 2, extent: 100 }).size).toBe(0);
  });

  it('breaks a line at the slices without it, rather than bridging them', () => {
    const lines = new Map([
      ['L', [2, 3, 10].map((z) => ({ z, rings: [], lines: [Float64Array.of(0, 50, 100, 50)] }))],
    ]);
    const cut = sectionOutlines(lines, 'x', 40, { depth: 12, extent: 120 });
    expect(cut.get('L')!.lines.map((l) => Array.from(l))).toEqual([
      [2.5, 50, 3.5, 50],
      [10.5, 50],
    ]);
  });

  it('cuts the same from an index made once as from the outlines', () => {
    const index = indexOutlines(stack);
    for (const at of [0, 15, 20, 29, 105, 500]) {
      expect(sectionOutlines(index, 'x', at, { depth: 10, extent: 100 })).toEqual(
        sectionOutlines(stack, 'x', at, { depth: 10, extent: 100 }),
      );
    }
    expect([...indexOutlines(new Map([['empty', [{ z: 0, rings: [] }]]])).classes.keys()]).toEqual([]);
  });
});
