import { reconstruct } from './reconstruct';
import { smoothMesh, surfaceNets } from './surface-nets';

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

describe('surfaceNets', () => {
  it('meshes a single voxel as a closed, outward surface around its centre', () => {
    const { vertices, faces } = surfaceNets(Uint8Array.of(1), 1, 1, 1);
    expect(vertices.length / 3).toBe(8);
    expect(faces.length / 3).toBe(12);
    expect(closed(faces)).toBe(true);
    expect(volume(vertices, faces)).toBeGreaterThan(0);
    for (const v of vertices) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('meshes a 4³ block with a volume close to its own', () => {
    const mask = new Uint8Array(6 * 6 * 6);
    for (let z = 1; z < 5; z++)
      for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) mask[x + 6 * (y + 6 * z)] = 1;
    const mesh = surfaceNets(mask, 6, 6, 6);
    expect(closed(mesh.faces)).toBe(true);
    expect(volume(mesh.vertices, mesh.faces)).toBeGreaterThan(27);
    expect(volume(mesh.vertices, mesh.faces)).toBeLessThan(64);
  });

  it('meshes nothing for an empty mask', () => {
    expect(surfaceNets(new Uint8Array(8), 2, 2, 2).faces.length).toBe(0);
  });

  it('smooths without moving an isolated vertex', () => {
    const m = smoothMesh(
      { vertices: Float32Array.of(0, 0, 0, 2, 0, 0, 0, 2, 0, 9, 9, 9), faces: Uint32Array.of(0, 1, 2) },
      1,
      1,
    );
    expect(Array.from(m.vertices.subarray(9))).toEqual([9, 9, 9]);
    expect(m.vertices[0]).toBeCloseTo(1);
  });
});

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

  it('coarsens to stay within the voxel budget, and is empty without area', () => {
    const big = reconstruct([{ z: 0, rings: [square(0, 0, 1000)] }], {
      pixelStep: 1,
      maxVoxels: 10_000,
      smooth: 0,
    });
    expect(big.faces.length).toBeGreaterThan(0);
    expect(reconstruct([{ z: 0, rings: [] }]).faces.length).toBe(0);
  });
});
