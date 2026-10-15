import type { Viewer } from 'napari-js';

import { SLICE_PLANE_OPACITY, VolumeSlicePlane } from './napari-volume-slice-plane';

/** A viewer that records the surfaces added and removed. */
function fakeViewer() {
  const items: Array<{ vertices: Float32Array; opts: Record<string, unknown> }> = [];
  const viewer = {
    addSurface: (
      vertices: Float32Array,
      _faces: Uint32Array,
      _values: Float32Array,
      opts: Record<string, unknown>,
    ) => {
      const layer = { vertices, opts };
      items.push(layer);
      return layer;
    },
    layers: { remove: (l: (typeof items)[number]) => items.splice(items.indexOf(l), 1) },
    requestRender: () => undefined,
  };
  return { viewer: viewer as unknown as Viewer, items };
}

const FRAME = {
  size: [100, 50, 10] as [number, number, number],
  world: [200, 100, 40] as [number, number, number],
};

describe('VolumeSlicePlane', () => {
  it('marks the slice with one translucent plane across the image at its depth, once the volume has a frame', () => {
    const { viewer, items } = fakeViewer();
    const plane = new VolumeSlicePlane(viewer);
    plane.setZ(9);
    expect(items.length).toBe(0); // no frame yet
    plane.setFrame(FRAME);
    expect(items.length).toBe(1);
    const v = Array.from(items[0].vertices);
    // The image's corners (x ±100, y ±50), all at slice 9's depth (the box's last slice).
    expect(v.filter((_, i) => i % 3 === 0)).toEqual([-100, 100, 100, -100]);
    expect(v.filter((_, i) => i % 3 === 1)).toEqual([-50, -50, 50, 50]);
    expect(new Set(v.filter((_, i) => i % 3 === 2))).toEqual(new Set([18]));
    expect(items[0].opts['opacity']).toBe(SLICE_PLANE_OPACITY);
  });

  it('follows the slice and the stretched Z, and goes with null or clear', () => {
    const { viewer, items } = fakeViewer();
    const plane = new VolumeSlicePlane(viewer);
    plane.setFrame(FRAME);
    plane.setZ(0);
    expect(items[0].vertices[2]).toBe(-18);
    plane.setZ(0); // the same slice: kept
    const first = items[0];
    expect(items).toEqual([first]);
    plane.setFrame({ ...FRAME, world: [200, 100, 80] });
    expect(items.length).toBe(1);
    expect(items[0].vertices[2]).toBe(-36);
    plane.setZ(null);
    expect(items.length).toBe(0);
    plane.setZ(4);
    plane.clear();
    expect(items.length).toBe(0);
  });
});
