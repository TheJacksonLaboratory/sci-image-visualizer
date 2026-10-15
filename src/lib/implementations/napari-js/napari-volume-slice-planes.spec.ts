import type { Viewer } from 'napari-js';

import { SLICE_PLANE_COLORS, SLICE_PLANE_DRAG_OPACITY, VolumeSlicePlanes } from './napari-volume-slice-planes';

/** A viewer that records the surfaces added and removed. */
function fakeViewer() {
  const items: Array<{ name: string; vertices: Float32Array; opacity: number }> = [];
  const viewer = {
    addSurface: (vertices: Float32Array, _f: Uint32Array, _v: Float32Array, opts: Record<string, unknown>) => {
      const layer = { name: opts['name'] as string, vertices, opacity: opts['opacity'] as number };
      items.push(layer);
      return layer;
    },
    layers: { remove: (l: (typeof items)[number]) => items.splice(items.indexOf(l), 1) },
    requestRender: () => undefined,
  };
  return { viewer: viewer as unknown as Viewer, items };
}

/** A 200 × 200 px host and an orthographic camera down -z: world x, y are NDC x, y. */
function setup() {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 200 });
  Object.defineProperty(host, 'clientHeight', { value: 200 });
  document.body.appendChild(host);
  const camera = {
    viewProjection: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.01, 0, 0, 0, 0.5, 1],
    changed: { connect: () => () => undefined },
  };
  const { viewer, items } = fakeViewer();
  const moves: Array<[string, number]> = [];
  const planes = new VolumeSlicePlanes(viewer, host, camera, {
    onMove: (axis, value) => moves.push([axis, value]),
  });
  // A 100 × 50 px image of 10 slices filling world x -1..1, y -0.5..0.5.
  planes.setFrame({ size: [100, 50, 10], world: [2, 1, 1] });
  return { host, items, moves, planes };
}

const pointer = (type: string, x: number, y: number) =>
  Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 1 });

describe('VolumeSlicePlanes', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('draws each plane in its axis colour with a grip, and hides one set to null', () => {
    const { host, items, planes } = setup();
    planes.set({ x: 50, y: 25, z: 4 });
    expect(items.map((l) => l.name)).toEqual(['x plane', 'y plane', 'z plane']);
    const grips = Array.from(host.querySelectorAll<HTMLElement>('.napari-slice-plane-grip'));
    expect(grips.map((g) => g.textContent)).toEqual(['X', 'Y', 'Z']);
    expect(grips[2].style.background).toBe('rgb(102, 140, 255)'); // SLICE_PLANE_COLORS.z
    expect(SLICE_PLANE_COLORS.z).toBe('#668cff');
    // The x plane spans the image's height and the whole stack at x = 50 (world 0).
    const x = items[0].vertices;
    expect(Array.from(x.filter((_, i) => i % 3 === 0))).toEqual([0, 0, 0, 0]);
    expect(Math.min(...x.filter((_, i) => i % 3 === 2))).toBeCloseTo(-0.5);

    planes.set({ x: 50, y: null, z: 4 });
    expect(items.map((l) => l.name)).toEqual(['x plane', 'z plane']);
    expect(host.querySelectorAll('.napari-slice-plane-grip').length).toBe(2);
    planes.destroy();
    expect(items.length).toBe(0);
    expect(host.querySelectorAll('.napari-slice-plane-grip').length).toBe(0);
  });

  it('drags a plane along its axis by its grip, without orbiting, highlighted while dragged', () => {
    const { host, items, moves, planes } = setup();
    planes.set({ x: 50, y: 25, z: 4 });
    const grip = host.querySelector<HTMLElement>('[data-axis="x"]')!;
    const orbit = jest.fn();
    host.addEventListener('pointerdown', orbit);
    grip.dispatchEvent(pointer('pointerdown', 100, 100));
    expect(orbit).not.toHaveBeenCalled();
    expect(items.find((l) => l.name === 'x plane')!.opacity).toBe(SLICE_PLANE_DRAG_OPACITY);
    // 50 px right on screen is 0.5 world units: a quarter of the image's width.
    grip.dispatchEvent(pointer('pointermove', 150, 120));
    expect(moves[moves.length - 1][0]).toBe('x');
    expect(moves[moves.length - 1][1]).toBeCloseTo(75);
    // Clamped to the image.
    grip.dispatchEvent(pointer('pointermove', 1000, 100));
    expect(moves[moves.length - 1][1]).toBe(99);
    grip.dispatchEvent(pointer('pointerup', 1000, 100));
    grip.dispatchEvent(pointer('pointermove', 0, 100));
    expect(moves.length).toBe(2);
  });
});
