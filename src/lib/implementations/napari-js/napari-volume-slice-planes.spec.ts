import { projectPoint } from 'napari-js';
import type { SurfaceLayer, Viewer } from 'napari-js';
import { HeadlessViewer } from 'napari-js/testing';

import { toWorld } from './napari-volume-region-meshes';
import {
  SLICE_PLANE_COLORS,
  SLICE_PLANE_DRAG_OPACITY,
  SLICE_PLANE_OPACITY,
  VolumeSlicePlanes,
} from './napari-volume-slice-planes';

// A 100 × 50 px image of 10 slices filling world x -1..1, y -0.5..0.5, z -0.5..0.5.
const FRAME = { size: [100, 50, 10] as [number, number, number], world: [2, 1, 1] as [number, number, number] };

function setup() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const v = new HeadlessViewer({ canvasRect: { width: 200, height: 200 } });
  v.camera3d.target = [0, 0, 0];
  v.camera3d.distance = 5;
  const moves: Array<[string, number]> = [];
  const planes = new VolumeSlicePlanes(v as unknown as Viewer, host, {
    onMove: (axis, value) => moves.push([axis, value]),
  });
  planes.setFrame(FRAME);
  const surfaces = () => v.layers.items as SurfaceLayer[];
  const grip = (axis: string) =>
    host.querySelector<HTMLElement>(`.napari-slice-plane-grip:nth-of-type(${'xyz'.indexOf(axis) + 1})`)!;
  return { host, v, planes, moves, surfaces, grip };
}

/** The world coordinate along `axis` of a plane's quad. */
const along = (layer: SurfaceLayer, a: 0 | 1 | 2) => layer.vertices[a];

describe('VolumeSlicePlanes', () => {
  it('shows nothing until a plane is set, then napari-js planes where the image px and slices put them', () => {
    const { planes, surfaces } = setup();
    expect(surfaces()).toHaveLength(0);
    planes.set({ x: 25, y: 10, z: 4 });
    const [x, y, z] = surfaces();
    // Where SIV's px / slice mapping (toWorld) puts them: px x 25, px y 10, slice 4.
    const p = toWorld(Float32Array.of(25, 10, 4), FRAME);
    expect(along(x, 0)).toBeCloseTo(p[0], 6);
    expect(along(y, 1)).toBeCloseTo(p[1], 6);
    expect(along(z, 2)).toBeCloseTo(p[2], 6);
    expect(x.color!.slice(0, 3).map((c) => Math.round(c * 255))).toEqual([0xff, 0x5c, 0x5c]);
    expect(z.opacity).toBe(SLICE_PLANE_OPACITY);
    expect(SLICE_PLANE_COLORS.z).toBe('#668cff');
  });

  it('moves a plane in place and hides one set to null, reporting none of it as a drag', () => {
    const { planes, surfaces, moves } = setup();
    planes.set({ x: 25, y: null, z: 4 });
    const before = surfaces().slice();
    planes.set({ x: 75, y: null, z: 4 });
    expect(surfaces()).toEqual(before); // the same layers
    expect(along(surfaces()[0], 0)).toBeCloseTo(toWorld(Float32Array.of(75, 0, 0), FRAME)[0], 6);
    expect(surfaces()[1].visible).toBe(false);
    expect(moves).toEqual([]);
  });

  it('reports a grip dragged along its axis in image px', () => {
    const { planes, v, moves, grip } = setup();
    planes.set({ x: 25, y: 10, z: 4 });
    const [vw, vh] = v.viewportSize();
    const mvp = v.camera3d.viewProjection(vw, vh);
    const g = grip('z');
    const at = (k: number) => {
      // The z grip sits on the plane's +x edge, at the middle of y.
      const w = toWorld(Float32Array.of(100, 25, k), FRAME);
      const s = projectPoint(mvp, [w[0], w[1], w[2]], vw, vh);
      return { clientX: s.x, clientY: s.y, pointerId: 1, bubbles: true };
    };
    g.dispatchEvent(Object.assign(new MouseEvent('pointerdown', at(4)), { pointerId: 1 }));
    g.dispatchEvent(Object.assign(new MouseEvent('pointermove', at(7)), { pointerId: 1 }));
    expect(moves.at(-1)?.[0]).toBe('z');
    expect(moves.at(-1)?.[1]).toBeCloseTo(7, 1);
    g.dispatchEvent(Object.assign(new MouseEvent('pointerup', at(7)), { pointerId: 1 }));
    expect(SLICE_PLANE_DRAG_OPACITY).toBeGreaterThan(SLICE_PLANE_OPACITY);
  });

  it('rebuilds over a new frame, and clears its planes and grips', () => {
    const { planes, surfaces, host } = setup();
    planes.set({ x: 25, y: 10, z: 4 });
    planes.setFrame({ size: [100, 50, 10], world: [2, 1, 4] });
    expect(surfaces()).toHaveLength(3);
    expect(along(surfaces()[2], 2)).toBeCloseTo(
      toWorld(Float32Array.of(0, 0, 4), { ...FRAME, world: [2, 1, 4] })[2],
      6,
    );
    planes.clear();
    expect(surfaces()).toHaveLength(0);
    expect(host.querySelectorAll('.napari-slice-plane-grip')).toHaveLength(0);
  });
});
