import { HeadlessViewer } from 'napari-js/testing';

import { boxRadius, keepSceneInDepth } from './napari-camera-depth';

/** Clip-space depth (0..1 drawn) of world point `p` through `m`. */
function depth(m: Float32Array, p: [number, number, number]): number {
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return z / w;
}

describe('keepSceneInDepth', () => {
  it("keeps the far side of the scene drawn zoomed in, where napari-js's far plane cut it", () => {
    const v = new HeadlessViewer({ canvasRect: { width: 400, height: 300 } });
    const camera = v.camera3d;
    camera.target = [0, 0, 0];
    camera.distance = 100; // zoomed in on a 9,000-unit section
    const eye = camera.eye();
    // A point of the section 2,000 units beyond the target, along the view.
    const dir = [-eye[0] / 100, -eye[1] / 100, -eye[2] / 100];
    const far: [number, number, number] = [dir[0] * 2000, dir[1] * 2000, dir[2] * 2000];
    const own = camera.viewProjection(400, 300);
    expect(depth(own, far)).toBeGreaterThan(1); // napari-js: beyond 4 · 100 + 1, cut away

    const restore = keepSceneInDepth(camera, () => boxRadius(9000, 5000, 100));
    const kept = camera.viewProjection(400, 300);
    expect(depth(kept, far)).toBeGreaterThan(0);
    expect(depth(kept, far)).toBeLessThan(1); // drawn
    // The target itself still in front of the far plane, as napari-js has it.
    expect(depth(kept, [0, 0, 0])).toBeLessThan(1);

    restore();
    expect(depth(camera.viewProjection(400, 300), far)).toBeGreaterThan(1);
  });

  it("never brings the far plane nearer than napari-js's", () => {
    const v = new HeadlessViewer({ canvasRect: { width: 400, height: 300 } });
    const camera = v.camera3d;
    camera.distance = 10_000;
    const own = camera.viewProjection(400, 300);
    keepSceneInDepth(camera, () => 1);
    expect(Array.from(camera.viewProjection(400, 300))).toEqual(Array.from(own));
  });
});
