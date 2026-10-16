import { loftLines } from './loft';

/** The mesh's vertices as [x, y, z] triples. */
function points(vertices: Float32Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < vertices.length; i += 3) out.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
  return out;
}

/** Each edge's face count: a sheet's border edges have one, its inner edges two. */
function edgeUse(faces: Uint32Array): number[] {
  const edges = new Map<string, number>();
  for (let i = 0; i < faces.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = faces[i + e],
        b = faces[i + ((e + 1) % 3)];
      const key = a < b ? `${a}/${b}` : `${b}/${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()];
}

describe('loftLines', () => {
  it('joins a line on each slice into a sheet, one row of vertices per line', () => {
    const mesh = loftLines(
      [
        { z: 0, lines: [Float64Array.of(0, 10, 100, 10)] },
        { z: 1, lines: [Float64Array.of(0, 12, 100, 12)] },
        { z: 2, lines: [Float64Array.of(0, 14, 100, 14)] },
      ],
      10,
    );
    // 100 px at a 10 px step: 11 points per line, 10 quads per strip, 2 strips.
    expect(mesh.vertices.length / 3).toBe(33);
    expect(mesh.faces.length / 3).toBe(40);
    const pts = points(mesh.vertices);
    expect(pts.slice(0, 11).every(([, y, z]) => y === 10 && z === 0)).toBe(true);
    expect(pts.slice(22).every(([, y, z]) => y === 14 && z === 2)).toBe(true);
    expect(pts[5][0]).toBeCloseTo(50);
    // A sheet: no edge is shared by more than two faces, and the middle row is shared.
    expect(Math.max(...edgeUse(mesh.faces))).toBe(2);
    expect(edgeUse(mesh.faces).filter((n) => n === 2).length).toBeGreaterThan(20);
  });

  it('follows a line drawn the other way on the next slice instead of twisting', () => {
    const mesh = loftLines(
      [
        { z: 0, lines: [Float64Array.of(0, 0, 100, 0)] },
        { z: 1, lines: [Float64Array.of(100, 0, 0, 0)] },
      ],
      50,
    );
    // Every triangle spans at most one step in x: the strip's rungs join x to x.
    const v = points(mesh.vertices);
    for (let i = 0; i < mesh.faces.length; i += 3) {
      const xs = [mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]].map((k) => v[k][0]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(50 + 1e-6);
    }
  });

  it('pairs the pieces of a line broken in two with their counterparts, and bridges a gap in slices', () => {
    const left = (y: number) => Float64Array.of(0, y, 40, y);
    const right = (y: number) => Float64Array.of(60, y, 100, y);
    const mesh = loftLines(
      [
        { z: 0, lines: [right(0), left(0)] },
        { z: 5, lines: [left(2), right(2)] },
      ],
      10,
    );
    const v = points(mesh.vertices);
    for (let i = 0; i < mesh.faces.length; i += 3) {
      const xs = [mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]].map((k) => v[k][0]);
      // No triangle crosses the gap between the pieces.
      expect(xs.every((x) => x <= 40) || xs.every((x) => x >= 60)).toBe(true);
    }
    expect(new Set(v.map(([, , z]) => z))).toEqual(new Set([0, 5]));
    expect(mesh.faces.length / 3).toBe(2 * 2 * 4); // 2 strips of 4 quads (5 points on a 40 px line)
  });

  it('leaves lines far apart unjoined, and is empty with fewer than two slices of lines', () => {
    expect(
      loftLines([
        { z: 0, lines: [Float64Array.of(0, 0, 10, 0)] },
        { z: 1, lines: [Float64Array.of(500, 500, 510, 500)] },
      ]).faces.length,
    ).toBe(0);
    expect(loftLines([{ z: 0, lines: [Float64Array.of(0, 0, 10, 0)] }]).faces.length).toBe(0);
    expect(loftLines([]).vertices.length).toBe(0);
  });
});
