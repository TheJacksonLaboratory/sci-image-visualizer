import type { Viewer } from 'napari-js';

import { RegionMesh3D, VolumeRegionMeshes, toWorld } from './napari-volume-region-meshes';

/** A viewer that records the surfaces added and removed. */
function fakeViewer() {
  const items: object[] = [];
  const added: Array<{ vertices: Float32Array; opts: Record<string, unknown> }> = [];
  const viewer = {
    addSurface: (
      vertices: Float32Array,
      _faces: Uint32Array,
      _values: Float32Array,
      opts: Record<string, unknown>,
    ) => {
      const layer = { name: opts['name'] };
      items.push(layer);
      added.push({ vertices, opts });
      return layer;
    },
    layers: {
      remove: (l: object) => items.splice(items.indexOf(l), 1),
      get items() {
        return items;
      },
    },
    requestRender: () => undefined,
  };
  return { viewer: viewer as unknown as Viewer, items, added };
}

const mesh = (key: string, color = '#ff0000'): RegionMesh3D => ({
  key,
  color,
  vertices: Float32Array.of(0, 0, 0, 100, 0, 0, 0, 50, 9),
  faces: Uint32Array.of(0, 1, 2),
});

describe('toWorld', () => {
  it('maps image px and slices onto the centred world box', () => {
    const out = toWorld(Float32Array.of(0, 0, 0, 100, 50, 9), { size: [100, 50, 10], world: [200, 100, 40] });
    expect(Array.from(out)).toEqual([-100, -50, -18, 100, 50, 18]);
  });
});

describe('VolumeRegionMeshes', () => {
  it('waits for the volume frame, then adds one translucent surface per mesh in its colour', () => {
    const { viewer, items, added } = fakeViewer();
    const meshes = new VolumeRegionMeshes(viewer);
    meshes.set([mesh('CTX'), mesh('MB', '#00ff00')]);
    expect(items).toHaveLength(0);
    meshes.setFrame({ size: [100, 50, 10], world: [100, 50, 10] });
    expect(items).toHaveLength(2);
    expect(added[0].opts['opacity']).toBeGreaterThan(0);
    expect(added[0].opts['fit']).toBe('never');
    expect(meshes.shown.map((m) => m.key)).toEqual(['CTX', 'MB']);
  });

  it('keeps unchanged surfaces, removes dropped ones, and re-places all on a new frame', () => {
    const { viewer, items, added } = fakeViewer();
    const meshes = new VolumeRegionMeshes(viewer);
    meshes.setFrame({ size: [100, 50, 10], world: [100, 50, 10] });
    const ctx = mesh('CTX');
    meshes.set([ctx, mesh('MB')]);
    meshes.set([ctx]);
    expect(items).toHaveLength(1);
    expect(added).toHaveLength(2);
    meshes.setFrame({ size: [100, 50, 10], world: [100, 50, 40] });
    expect(added).toHaveLength(3);
    expect(added[2].vertices[2]).toBe(-18);
    meshes.clear();
    expect(items).toHaveLength(0);
  });
});
