/**
 * Which triangle mesh is under the cursor in a 3D view: the cursor's ray, from the camera's
 * view-projection, hit-tested against each mesh's triangles (Möller–Trumbore) after a bounding-box
 * test. napari-js picks points but not surfaces; this is the surface counterpart (a candidate to
 * move into napari-js).
 *
 * Pure: no DOM, no GPU.
 */

/** A ray: points `origin + t·dir`, t ≥ 0 in front of the near plane. */
export interface Ray {
  origin: [number, number, number];
  dir: [number, number, number];
}

/** Axis-aligned bounds of a mesh. */
export interface MeshBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * The ray under screen point (`x`, `y`) of a `vw`×`vh` canvas (CSS px), through the column-major
 * view-projection `mvp` (napari-js's convention: NDC y up, depth 0..1). Null for a singular matrix.
 */
export function screenRay(mvp: ArrayLike<number>, x: number, y: number, vw: number, vh: number): Ray | null {
  const inv = invert4(mvp);
  if (!inv) return null;
  const nx = (x / vw) * 2 - 1;
  const ny = 1 - (y / vh) * 2;
  const near = unproject(inv, nx, ny, 0);
  const far = unproject(inv, nx, ny, 1);
  if (!near || !far) return null;
  const dir: [number, number, number] = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  return { origin: near, dir };
}

export function meshBox(vertices: Float32Array): MeshBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = vertices[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

/** The nearest t ≥ 0 at which `ray` enters `box`, or Infinity if it misses (slab test). */
export function rayHitBox(ray: Ray, box: MeshBox): number {
  let t0 = 0,
    t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = ray.origin[a],
      d = ray.dir[a];
    if (d === 0) {
      if (o < box.min[a] || o > box.max[a]) return Infinity;
      continue;
    }
    let ta = (box.min[a] - o) / d,
      tb = (box.max[a] - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** The nearest t ≥ 0 at which `ray` hits a triangle of the mesh (either side), or Infinity. */
export function rayHitMesh(ray: Ray, vertices: Float32Array, faces: Uint32Array, box?: MeshBox): number {
  if (box && rayHitBox(ray, box) === Infinity) return Infinity;
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;
  let best = Infinity;
  for (let f = 0; f + 2 < faces.length; f += 3) {
    const a = 3 * faces[f],
      b = 3 * faces[f + 1],
      c = 3 * faces[f + 2];
    const ax = vertices[a],
      ay = vertices[a + 1],
      az = vertices[a + 2];
    const e1x = vertices[b] - ax,
      e1y = vertices[b + 1] - ay,
      e1z = vertices[b + 2] - az;
    const e2x = vertices[c] - ax,
      e2y = vertices[c + 1] - ay,
      e2z = vertices[c + 2] - az;
    // p = dir × e2; det = e1 · p.
    const px = dy * e2z - dz * e2y,
      py = dz * e2x - dx * e2z,
      pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = ox - ax,
      sy = oy - ay,
      sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y,
      qy = sz * e1x - sx * e1z,
      qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

function unproject(inv: Float64Array, x: number, y: number, z: number): [number, number, number] | null {
  const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  if (!w) return null;
  return [
    (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) / w,
    (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) / w,
    (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) / w,
  ];
}

/** The inverse of a column-major 4×4 matrix, or null if it is singular. */
export function invert4(m: ArrayLike<number>): Float64Array | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10,
    b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12,
    b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30,
    b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  return Float64Array.from([
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]);
}
