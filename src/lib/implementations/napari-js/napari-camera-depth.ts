import type { Camera3D } from 'napari-js';

/**
 * Keep the whole scene within the 3D camera's depth range, however close the camera comes.
 *
 * napari-js (0.20) puts the far plane at `4 · distance + 1` from the eye, so the closer the camera
 * (the more one zooms in), the nearer the far plane: zoomed in on a long, flat specimen seen at an
 * angle (a MERFISH section, 9,000 px long), everything farther than four distances is cut away and
 * the canvas goes black past a straight edge — one cannot zoom close to a small part of it. Here the
 * far plane is pushed out to the far side of the scene (`distance + |target| + radius`, the scene
 * centred on the origin as the 3D views centre it), never nearer than napari-js's own; the near
 * plane, the field of view and the view are napari-js's, as are the matrices (copied: napari-js does
 * not export them). Its picking and projections read the same matrix, so they agree.
 *
 * TODO: napari-js should take the scene's extent itself (a far plane from the layers' bounds); this
 * override is removed once it does.
 *
 * Returns the function that restores napari-js's own projection.
 */
export function keepSceneInDepth(camera: Camera3D, radius: () => number | null): () => void {
  const original = camera.viewProjection;
  camera.viewProjection = function (this: Camera3D, vw: number, vh: number): Float32Array {
    const d = this.distance;
    const r = radius();
    const aspect = vh > 0 ? vw / vh : 1;
    const near = Math.max(1e-3, d * 0.05);
    const t = this.target;
    const far = Math.max(d * 4 + 1, r && r > 0 ? d + Math.hypot(t[0], t[1], t[2]) + r * 1.05 : 0);
    return multiply(perspective(this.fov, aspect, near, far), lookAt(this.eye(), t, [0, 1, 0]));
  } as typeof camera.viewProjection;
  return () => {
    camera.viewProjection = original;
  };
}

/** The radius of a centred box `[w, h, d]` (half its diagonal). */
export function boxRadius(w: number, h: number, d: number): number {
  return Math.hypot(w, h, d) / 2;
}

// ── napari-js's own (src/math/mat4.ts), column-major ─────────────────────────────────

/** WebGPU-style perspective (clip z in [0,1]). */
export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

function lookAt(eye: readonly number[], center: readonly number[], up: readonly number[]): Float32Array {
  const fx = center[0] - eye[0];
  const fy = center[1] - eye[1];
  const fz = center[2] - eye[2];
  let rl = 1 / Math.hypot(fx, fy, fz);
  const f = [fx * rl, fy * rl, fz * rl];
  let sx = f[1] * up[2] - f[2] * up[1];
  let sy = f[2] * up[0] - f[0] * up[2];
  let sz = f[0] * up[1] - f[1] * up[0];
  rl = 1 / Math.hypot(sx, sy, sz);
  sx *= rl;
  sy *= rl;
  sz *= rl;
  const ux = sy * f[2] - sz * f[1];
  const uy = sz * f[0] - sx * f[2];
  const uz = sx * f[1] - sy * f[0];
  const m = new Float32Array(16);
  m[0] = sx;
  m[1] = ux;
  m[2] = -f[0];
  m[4] = sy;
  m[5] = uy;
  m[6] = -f[1];
  m[8] = sz;
  m[9] = uz;
  m[10] = -f[2];
  m[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
  m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  m[14] = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2];
  m[15] = 1;
  return m;
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
