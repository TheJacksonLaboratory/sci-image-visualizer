/**
 * A triangle mesh of the boundary of a binary voxel mask, by surface nets (Gibson's): one vertex
 * per cell that the boundary crosses, at the average of its crossing edges' midpoints, and a quad
 * (two triangles) per mask edge the boundary separates. Smoother than marching cubes' staircase at
 * the same resolution, closed for a mask padded with empty voxels, and a few dozen lines.
 *
 * Pure: usable from workers.
 */

/** A triangle mesh: `vertices` x, y, z triples, `faces` vertex index triples. */
export interface Mesh {
  vertices: Float32Array;
  faces: Uint32Array;
}

/**
 * The boundary of `mask` (`nx·ny·nz` voxels, x fastest; non-zero = inside), in voxel coordinates
 * (voxel i spans [i, i+1) on its axis, so its centre is i + 0.5). An empty mask gives an empty mesh.
 */
export function surfaceNets(mask: Uint8Array, nx: number, ny: number, nz: number): Mesh {
  // Cells sit between voxel centres: cell (x, y, z) has corners at voxels x..x+1, y..y+1, z..z+1,
  // and runs from -1 to n-1 on each axis so the boundary of voxels on the grid's edge is closed.
  const cx = nx + 1,
    cy = ny + 1,
    cz = nz + 1;
  const vertexOf = new Int32Array(cx * cy * cz).fill(-1);
  const verts: number[] = [];
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : mask[x + nx * (y + ny * z)] ? 1 : 0;
  const cell = (x: number, y: number, z: number) => x + 1 + cx * (y + 1 + cy * (z + 1));

  // The 12 edges of a cell as pairs of its 8 corners (corner bits: x = 1, y = 2, z = 4).
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const corner = new Uint8Array(8);
  for (let z = -1; z < nz; z++) {
    for (let y = -1; y < ny; y++) {
      for (let x = -1; x < nx; x++) {
        let any = 0,
          all = 1;
        for (let c = 0; c < 8; c++) {
          const v = at(x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1));
          corner[c] = v;
          any |= v;
          all &= v;
        }
        if (!any || all) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          n = 0;
        for (const [a, b] of EDGES) {
          if (corner[a] === corner[b]) continue;
          sx += ((a & 1) + (b & 1)) / 2;
          sy += (((a >> 1) & 1) + ((b >> 1) & 1)) / 2;
          sz += (((a >> 2) & 1) + ((b >> 2) & 1)) / 2;
          n++;
        }
        vertexOf[cell(x, y, z)] = verts.length / 3;
        // Corner (0,0,0) of cell x is voxel x, whose centre is at x + 0.5.
        verts.push(x + 0.5 + sx / n, y + 0.5 + sy / n, z + 0.5 + sz / n);
      }
    }
  }

  // A quad per voxel edge whose ends differ, between the four cells around that edge, wound so
  // the faces point out of the mask.
  const faces: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) faces.push(a, c, b, a, d, c);
    else faces.push(a, b, c, a, c, d);
  };
  for (let z = -1; z < nz; z++) {
    for (let y = -1; y < ny; y++) {
      for (let x = -1; x < nx; x++) {
        const here = at(x, y, z);
        // The edge from voxel (x, y, z) to (x+1, y, z) is shared by cells (x, y-1..y, z-1..z).
        if (here !== at(x + 1, y, z) && y >= 0 && z >= 0) {
          quad(
            vertexOf[cell(x, y - 1, z - 1)],
            vertexOf[cell(x, y, z - 1)],
            vertexOf[cell(x, y, z)],
            vertexOf[cell(x, y - 1, z)],
            !here,
          );
        }
        if (here !== at(x, y + 1, z) && x >= 0 && z >= 0) {
          quad(
            vertexOf[cell(x - 1, y, z - 1)],
            vertexOf[cell(x - 1, y, z)],
            vertexOf[cell(x, y, z)],
            vertexOf[cell(x, y, z - 1)],
            !here,
          );
        }
        if (here !== at(x, y, z + 1) && x >= 0 && y >= 0) {
          quad(
            vertexOf[cell(x - 1, y - 1, z)],
            vertexOf[cell(x, y - 1, z)],
            vertexOf[cell(x, y, z)],
            vertexOf[cell(x - 1, y, z)],
            !here,
          );
        }
      }
    }
  }
  return { vertices: Float32Array.from(verts), faces: Uint32Array.from(faces) };
}

/**
 * Smooth a mesh in place by `iterations` of Laplacian averaging (each vertex moved `lambda` of
 * the way to its neighbours' mean): softens the voxel steps of a reconstruction.
 */
export function smoothMesh(mesh: Mesh, iterations = 2, lambda = 0.5): Mesh {
  const n = mesh.vertices.length / 3;
  if (!n || iterations <= 0) return mesh;
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  const f = mesh.faces;
  for (let i = 0; i + 2 < f.length; i += 3) {
    const [a, b, c] = [f[i], f[i + 1], f[i + 2]];
    neighbours[a].push(b, c);
    neighbours[b].push(a, c);
    neighbours[c].push(a, b);
  }
  let v = mesh.vertices;
  for (let it = 0; it < iterations; it++) {
    const next = new Float32Array(v.length);
    for (let i = 0; i < n; i++) {
      const nb = neighbours[i];
      if (!nb.length) {
        next.set(v.subarray(3 * i, 3 * i + 3), 3 * i);
        continue;
      }
      let mx = 0,
        my = 0,
        mz = 0;
      for (const j of nb) {
        mx += v[3 * j];
        my += v[3 * j + 1];
        mz += v[3 * j + 2];
      }
      const k = nb.length;
      next[3 * i] = v[3 * i] + lambda * (mx / k - v[3 * i]);
      next[3 * i + 1] = v[3 * i + 1] + lambda * (my / k - v[3 * i + 1]);
      next[3 * i + 2] = v[3 * i + 2] + lambda * (mz / k - v[3 * i + 2]);
    }
    v = next;
  }
  return { vertices: v, faces: mesh.faces };
}
