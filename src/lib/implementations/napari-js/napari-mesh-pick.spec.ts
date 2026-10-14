import { invert4, meshBox, rayHitBox, rayHitMesh, screenRay } from './napari-mesh-pick';

/** Column-major perspective (WebGPU depth 0..1) × a view looking down -z from (0, 0, 10). */
function viewProjection(): Float64Array {
  const f = 1 / Math.tan(Math.PI / 8),
    near = 1,
    far = 100;
  const proj = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0];
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1];
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += proj[k * 4 + r] * view[c * 4 + k];
  return out;
}

/** napari-js's projectPoint: world → screen px. */
function project(m: ArrayLike<number>, [x, y, z]: number[], vw: number, vh: number): [number, number] {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
    cy = m[1] * x + m[5] * y + m[9] * z + m[13],
    w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [((cx / w) * 0.5 + 0.5) * vw, (1 - ((cy / w) * 0.5 + 0.5)) * vh];
}

/** A unit square (two triangles) at height z, centred on (cx, cy). */
function square(cx: number, cy: number, z: number) {
  const v = Float32Array.from([cx - 1, cy - 1, z, cx + 1, cy - 1, z, cx + 1, cy + 1, z, cx - 1, cy + 1, z]);
  return { vertices: v, faces: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
}

describe('mesh picking', () => {
  it('inverts a matrix', () => {
    const m = viewProjection();
    const inv = invert4(m)!;
    const id = new Float64Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) id[c * 4 + r] += m[k * 4 + r] * inv[c * 4 + k];
    id.forEach((v, i) => expect(v).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9));
    expect(invert4(new Float64Array(16))).toBeNull();
  });

  it('casts the ray through the point drawn under the cursor', () => {
    const m = viewProjection();
    const [sx, sy] = project(m, [2, -1, 3], 800, 600);
    const ray = screenRay(m, sx, sy, 800, 600)!;
    // The ray passes through (2, -1, 3): solve for the t where z = 3 and compare x, y.
    const t = (3 - ray.origin[2]) / ray.dir[2];
    expect(ray.origin[0] + t * ray.dir[0]).toBeCloseTo(2, 4);
    expect(ray.origin[1] + t * ray.dir[1]).toBeCloseTo(-1, 4);
  });

  it('hits the front-most mesh under the cursor and misses beside it', () => {
    const m = viewProjection();
    const front = square(0, 0, 2);
    const back = square(0, 0, -2);
    const [sx, sy] = project(m, [0.3, 0.2, 2], 800, 600);
    const ray = screenRay(m, sx, sy, 800, 600)!;
    const tf = rayHitMesh(ray, front.vertices, front.faces, meshBox(front.vertices));
    const tb = rayHitMesh(ray, back.vertices, back.faces, meshBox(back.vertices));
    expect(tf).toBeLessThan(tb);
    expect(tb).toBeLessThan(Infinity);

    const [ox, oy] = project(m, [3, 3, 2], 800, 600);
    const miss = screenRay(m, ox, oy, 800, 600)!;
    expect(rayHitBox(miss, meshBox(front.vertices))).toBe(Infinity);
    expect(rayHitMesh(miss, front.vertices, front.faces)).toBe(Infinity);
  });
});
