import { HeadlessViewer } from 'napari-js/testing';
import type { SurfaceLayer, Viewer } from 'napari-js';

import {
  REGION_MESH_DIMMED_OPACITY,
  REGION_MESH_HIGHLIGHT_OPACITY,
  REGION_MESH_OPACITY,
  RegionMesh3D,
  VolumeRegionMeshes,
  toWorld,
} from './napari-volume-region-meshes';

/** napari-js's GPU-free viewer, with the surfaces it holds and the ones it was asked to add. */
function makeViewer() {
  const v = new HeadlessViewer({ canvasRect: { width: 200, height: 200 } });
  const surfaces = () => v.layers.items as SurfaceLayer[];
  return { viewer: v as unknown as Viewer, v, surfaces };
}

const mesh = (key: string, color = '#ff0000'): RegionMesh3D => ({
  key,
  color,
  vertices: Float32Array.of(0, 0, 0, 100, 0, 0, 0, 50, 9),
  faces: Uint32Array.of(0, 1, 2),
});

/** A square over the image (x 0..`w` px, y 0..100 px) on slice 5. */
const square = (key: string, w = 100): RegionMesh3D => ({
  key,
  color: '#ff0000',
  vertices: Float32Array.of(0, 0, 5, w, 0, 5, w, 100, 5, 0, 100, 5),
  faces: Uint32Array.of(0, 1, 2, 0, 2, 3),
});

describe('toWorld', () => {
  it('maps image px and slices onto the centred world box', () => {
    const out = toWorld(Float32Array.of(0, 0, 0, 100, 50, 9), { size: [100, 50, 10], world: [200, 100, 40] });
    expect(Array.from(out)).toEqual([-100, -50, -18, 100, 50, 18]);
  });
});

describe('VolumeRegionMeshes', () => {
  it('waits for the volume frame, then adds one translucent surface per mesh in its colour', () => {
    const { viewer, surfaces } = makeViewer();
    const meshes = new VolumeRegionMeshes(viewer);
    meshes.set([mesh('CTX'), mesh('MB', '#00ff00')]);
    expect(surfaces()).toHaveLength(0);
    meshes.setFrame({ size: [100, 50, 10], world: [100, 50, 10] });
    expect(surfaces()).toHaveLength(2);
    expect(surfaces()[0].opacity).toBe(REGION_MESH_OPACITY);
    expect(surfaces()[0].translucent).toBe(true);
    expect(surfaces()[1].color).toEqual([0, 1, 0, 1]);
    expect(meshes.shown.map((m) => m.key)).toEqual(['CTX', 'MB']);
  });

  it('keeps surfaces, updates a rebuilt or recoloured one and a new frame in place, removes dropped ones', () => {
    const { viewer, surfaces } = makeViewer();
    const meshes = new VolumeRegionMeshes(viewer);
    meshes.setFrame({ size: [100, 50, 10], world: [100, 50, 10] });
    const ctx = mesh('CTX');
    meshes.set([ctx, mesh('MB')]);
    const [ctxLayer] = surfaces();
    meshes.set([ctx]);
    expect(surfaces()).toEqual([ctxLayer]);
    // A new frame re-places the same surface.
    meshes.setFrame({ size: [100, 50, 10], world: [100, 50, 40] });
    expect(surfaces()).toEqual([ctxLayer]);
    expect(ctxLayer.vertices[2]).toBe(-18);
    // Rebuilt and recoloured: still the same surface.
    meshes.set([{ ...mesh('CTX', '#0000ff'), vertices: Float32Array.of(0, 0, 0, 50, 0, 0, 0, 25, 9) }]);
    expect(surfaces()).toEqual([ctxLayer]);
    expect(ctxLayer.color).toEqual([0, 0, 1, 1]);
    expect(ctxLayer.vertices[3]).toBe(0); // x 50 of 100 px: the box's middle
    meshes.clear();
    expect(surfaces()).toHaveLength(0);
  });

  it('highlights some surfaces near opaque and fades the others; none restores them', () => {
    const { viewer, surfaces } = makeViewer();
    const meshes = new VolumeRegionMeshes(viewer);
    meshes.setFrame({ size: [100, 50, 10], world: [100, 50, 10] });
    meshes.set([mesh('CTX'), mesh('MB')]);
    const opacity = () => surfaces().map((l) => l.opacity);
    meshes.setHighlight(['MB']);
    expect(opacity()).toEqual([REGION_MESH_DIMMED_OPACITY, REGION_MESH_HIGHLIGHT_OPACITY]);
    // A surface added later takes the highlight it falls under.
    meshes.set([mesh('CTX'), mesh('MB'), mesh('HPF')]);
    expect(opacity()[2]).toBe(REGION_MESH_DIMMED_OPACITY);
    meshes.setHighlight([]);
    expect(opacity()).toEqual([REGION_MESH_OPACITY, REGION_MESH_OPACITY, REGION_MESH_OPACITY]);
  });

  it('picks the surface under a screen point (napari-js pickSurface), and none beside it', () => {
    const { viewer, v } = makeViewer();
    const meshes = new VolumeRegionMeshes(viewer);
    meshes.setFrame({ size: [100, 100, 10], world: [2, 2, 2] });
    // A square over the left half of the image: world x in [-1, 0].
    meshes.set([square('L', 50)]);
    v.camera3d.target = [0, 0, 0];
    v.camera3d.distance = 6;
    const at = (x: number, y: number) => {
      const p = v.projectPoints(Float32Array.of(x, y, 0))!;
      return [p.screen[0], p.screen[1]] as const;
    };
    expect(meshes.pickAt(...at(-0.5, 0))?.key).toBe('L');
    expect(meshes.pickAt(...at(0.5, 0))).toBeNull();
    // Only its own surfaces: another surface there is not one of its regions.
    v.addSurface(Float32Array.of(0, -1, 0.5, 1, -1, 0.5, 1, 1, 0.5), Uint32Array.of(0, 1, 2), undefined, {
      fit: 'never',
    });
    expect(meshes.pickAt(...at(0.6, -0.5))).toBeNull();
  });

  it('hides surfaces, which then are not picked, and shows them again', () => {
    const { viewer, v, surfaces } = makeViewer();
    const meshes = new VolumeRegionMeshes(viewer);
    meshes.setFrame({ size: [100, 100, 10], world: [2, 2, 2] });
    meshes.setHidden(['A']);
    meshes.set([square('A')]);
    v.camera3d.target = [0, 0, 0];
    v.camera3d.distance = 6;
    const visible = () => surfaces().map((l) => l.visible);
    // A surface added while its key is hidden starts hidden.
    expect(visible()).toEqual([false]);
    expect(meshes.pickAt(100, 100)).toBeNull();
    meshes.setHidden([]);
    expect(visible()).toEqual([true]);
    expect(meshes.pickAt(100, 100)?.key).toBe('A');
  });
});
