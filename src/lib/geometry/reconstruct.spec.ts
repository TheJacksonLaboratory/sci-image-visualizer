import { outlinedVolume, outlinesArea, reconstruct, ringsArea } from './reconstruct';

/** Signed volume of a closed triangle mesh (positive when its faces point outward). */
function volume(vertices: Float32Array, faces: Uint32Array): number {
  let v = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = [faces[i], faces[i + 1], faces[i + 2]].map((k) => [
      vertices[3 * k],
      vertices[3 * k + 1],
      vertices[3 * k + 2],
    ]);
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

/** How many faces of the mesh the ray from `o` along `d` crosses (Möller–Trumbore). */
function hits(vertices: Float32Array, faces: Uint32Array, o: number[], d: number[]): number {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let n = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const [a, b, c] = [faces[i], faces[i + 1], faces[i + 2]].map((k) => [
      vertices[3 * k],
      vertices[3 * k + 1],
      vertices[3 * k + 2],
    ]);
    const e1 = sub(b, a),
      e2 = sub(c, a);
    const p = cross(d, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const t0 = sub(o, a);
    const u = dot(t0, p) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(t0, e1);
    const v = dot(d, q) / det;
    if (v < 0 || u + v > 1) continue;
    if (dot(e2, q) / det > 0) n++;
  }
  return n;
}

/** Whether every edge of the mesh is shared by exactly two faces (closed, manifold). */
function closed(faces: Uint32Array): boolean {
  const edges = new Map<string, number>();
  for (let i = 0; i < faces.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = faces[i + e],
        b = faces[i + ((e + 1) % 3)];
      const key = a < b ? `${a}/${b}` : `${b}/${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((n) => n === 2);
}

describe('reconstruct', () => {
  const square = (x: number, y: number, s: number) => Float32Array.of(x, y, x + s, y, x + s, y + s, x, y + s);

  it('stacks slice outlines into a closed mesh in image px and slice units', () => {
    const slices = [3, 4, 5, 6].map((z) => ({ z, rings: [square(100, 50, 40)] }));
    const mesh = reconstruct(slices, { pixelStep: 4, smooth: 0 });
    expect(closed(mesh.faces)).toBe(true);
    const xs = [],
      zs = [];
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      xs.push(mesh.vertices[i]);
      zs.push(mesh.vertices[i + 2]);
    }
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...xs)).toBeLessThanOrEqual(140);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(2.5);
    expect(Math.max(...zs)).toBeLessThanOrEqual(6.5);
  });

  it('leaves holes open (even-odd)', () => {
    const ring = [square(0, 0, 40), square(10, 10, 20)];
    const mesh = reconstruct([{ z: 0, rings: ring }], { pixelStep: 2, smooth: 0 });
    const solid = reconstruct([{ z: 0, rings: [square(0, 0, 40)] }], { pixelStep: 2, smooth: 0 });
    expect(closed(mesh.faces)).toBe(true);
    // A 40² slab without its 20² hole: about three quarters of the solid one.
    const ratio = volume(mesh.vertices, mesh.faces) / volume(solid.vertices, solid.faces);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.85);
  });

  it('fills features as their union: a child inside its parent (a hierarchy group) cuts no hole', () => {
    const rings = [square(0, 0, 20), square(5, 5, 10)];
    const slices = [0, 1, 2].map((z) => ({ z, rings, ringGroups: [0, 1] }));
    const mesh = reconstruct(slices, { smooth: 0 });
    expect(closed(mesh.faces)).toBe(true);
    // Up through the common centre: in at the bottom, out at the top.
    expect(hits(mesh.vertices, mesh.faces, [10.3, 10.6, -5], [0, 0, 1])).toBe(2);
    // The same rings as one feature (no groups, as an older source sends them): the inner ring is its hole.
    const holed = reconstruct(
      slices.map(({ z }) => ({ z, rings })),
      { smooth: 0 },
    );
    expect(hits(holed.vertices, holed.faces, [10.3, 10.6, -5], [0, 0, 1])).toBe(0);
    // A feature's own hole stays one: the rings of a feature are even-odd.
    const own = reconstruct(
      slices.map(({ z }) => ({ z, rings: [...rings, square(40, 0, 5)], ringGroups: [0, 0, 1] })),
      { smooth: 0 },
    );
    expect(hits(own.vertices, own.faces, [10.3, 10.6, -5], [0, 0, 1])).toBe(0);
    expect(hits(own.vertices, own.faces, [42.3, 2.6, -5], [0, 0, 1])).toBe(2);
  });

  it('coarsens to stay within the voxel budget, and is empty without area', () => {
    const big = reconstruct([{ z: 0, rings: [square(0, 0, 1000)] }], {
      pixelStep: 1,
      maxVoxels: 10_000,
      smooth: 0,
    });
    expect(big.faces.length).toBeGreaterThan(0);
    expect(reconstruct([{ z: 0, rings: [] }]).faces.length).toBe(0);
  });

  it('adds the sheet lofted through the slices’ lines to the filled outlines’ surface', () => {
    const solid = reconstruct([{ z: 0, rings: [square(0, 0, 40)] }], { pixelStep: 4, smooth: 0 });
    const lines = [0, 1].map((z) => ({ z, rings: [], lines: [Float32Array.of(0, 100, 40, 100)] }));
    const sheet = reconstruct(lines, { pixelStep: 4 });
    expect(sheet.faces.length / 3).toBe(20); // 11 points a line at a 4 px step: 10 quads
    const both = reconstruct([{ ...lines[0], rings: [square(0, 0, 40)] }, lines[1]], { pixelStep: 4, smooth: 0 });
    expect(both.faces.length).toBe(solid.faces.length + sheet.faces.length);
    expect(Math.max(...both.faces)).toBe(both.vertices.length / 3 - 1);
  });
});

describe('ringsArea / outlinedVolume', () => {
  const square = (x: number, y: number, s: number) => Float64Array.of(x, y, x + s, y, x + s, y + s, x, y + s);

  it('measures rings even-odd: a hole subtracts, an island in it adds back', () => {
    expect(ringsArea([square(0, 0, 10)])).toBe(100);
    expect(ringsArea([square(0, 0, 10), square(2, 2, 6)])).toBe(64);
    expect(ringsArea([square(0, 0, 10), square(2, 2, 6), square(4, 4, 2)])).toBe(68);
    // Either winding; side-by-side parts add.
    expect(ringsArea([square(0, 0, 10).reverse(), square(20, 0, 5)])).toBe(125);
  });

  it('measures features as their union, each one even-odd', () => {
    // A child inside its parent adds nothing; without groups (one feature) it is a hole.
    expect(outlinesArea([square(0, 0, 20), square(5, 5, 10)], [0, 1])).toBe(400);
    expect(outlinesArea([square(0, 0, 20), square(5, 5, 10)])).toBe(300);
    // Overlapping, side by side, and one filling another's hole.
    expect(outlinesArea([square(0, 0, 10), square(5, 5, 10)], [0, 1])).toBeCloseTo(175, 9);
    expect(outlinesArea([square(0, 0, 10), square(20, 0, 10)], [3, 7])).toBe(200);
    expect(outlinesArea([square(0, 0, 20), square(5, 5, 10), square(5, 5, 10)], [0, 0, 1])).toBeCloseTo(400, 9);
    // A feature's own hole stays one beside another feature.
    expect(outlinesArea([square(0, 0, 10), square(2, 2, 6), square(20, 0, 5)], [0, 0, 1])).toBe(89);
  });

  it('measures the union exactly where the outlines cross between vertices', () => {
    // A 10² square and the same square turned 45° about its centre: they cross between their
    // vertices' rows. The union is the square and the 4 corners of the turned one beyond it.
    const r = 5 * Math.SQRT2;
    const diamond = Float64Array.of(5, 5 - r, 5 + r, 5, 5, 5 + r, 5 - r, 5);
    const corner = 10 - 5 * Math.SQRT2;
    expect(outlinesArea([square(0, 0, 10), diamond], [0, 1])).toBeCloseTo(100 + 2 * corner * corner, 4);
  });

  it('sums each slice’s area, one slice thick (Cavalieri)', () => {
    expect(
      outlinedVolume([
        { z: 3, rings: [square(0, 0, 10)] },
        { z: 4, rings: [square(0, 0, 10), square(2, 2, 6)] },
      ]),
    ).toBe(164);
    expect(outlinedVolume([])).toBe(0);
  });
});
