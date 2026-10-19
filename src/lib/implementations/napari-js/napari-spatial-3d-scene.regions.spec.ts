import { HeadlessViewer } from 'napari-js/testing';
import type { SurfaceLayer, Viewer } from 'napari-js';

import { Spatial3dScene } from './napari-spatial-3d-scene';
import { VolumeRegionMeshes } from './napari-volume-region-meshes';

/** The reference volume of the ABC atlas example, small: 4 x 2 voxels x 3 slabs of 25 x 25 x 200. */
const VOLUME = { width: 4, height: 2, depth: 3, voxelSize: [25, 25, 200] as [number, number, number] };
const DATASET: any = { id: 'abc', volume: VOLUME };
/** Its stack, as showVolumeAsImage publishes it. */
const STACK: any = { isStack: true, trueImageSize: [4, 2], urls: ['z0', 'z1', 'z2'] };

/** A square over the whole image on slice 1. */
const square = () => ({
  key: 'HPF',
  color: '#7ed04b',
  vertices: Float32Array.of(0, 0, 1, 4, 0, 1, 4, 2, 1, 0, 2, 1),
  faces: Uint32Array.of(0, 1, 2, 0, 2, 3),
});

/** The scene with what its region surfaces use (its constructor needs a whole session and viewer). */
function scene(info: any) {
  const v = new HeadlessViewer({ canvasRect: { width: 200, height: 200 } });
  const viewer = v as unknown as Viewer;
  const volume: any = { blending: 'translucent' };
  const s = Object.assign(Object.create(Spatial3dScene.prototype), {
    info,
    ctx: { viewer },
    regionMeshes: new VolumeRegionMeshes(viewer),
    regionsThrough: false,
    volume,
    session: { latest: [DATASET, {}, {}] },
  }) as Spatial3dScene;
  const surfaces = () => v.layers.items as SurfaceLayer[];
  return { s, surfaces, volume };
}

describe('Spatial3dScene region surfaces', () => {
  it("places them in the reference volume's box, where the cloud sits, as the Volume view does", () => {
    const { s, surfaces } = scene(STACK);
    s.setRegionMeshes([square()]);
    expect(surfaces()).toHaveLength(0); // no box yet
    (s as any).placeRegionMeshes(DATASET);
    expect(surfaces()).toHaveLength(1);
    // The box is 100 x 50 x 600 world units, centred: x 0..4 px -> -50..50, y 0..2 -> -25..25,
    // slice 1's centre -> z 300 - 300 = 0 (a cell 300 um deep sits at the same world z).
    expect(Array.from(surfaces()[0].vertices.slice(0, 6))).toEqual([-50, -25, 0, 50, -25, 0]);
    expect(s.voxelStep()).toBe(1);
  });

  it("takes the surfaces down when the dataset's volume no longer matches the stack, and back when it does", () => {
    const { s, surfaces } = scene(STACK);
    s.setRegionMeshes([square()]);
    (s as any).placeRegionMeshes(DATASET);
    expect(surfaces()).toHaveLength(1);
    // Another dataset, its volume another size: these surfaces have no box in it.
    (s as any).placeRegionMeshes({ id: 'other', volume: { ...VOLUME, width: 8 } });
    expect(surfaces()).toHaveLength(0);
    // And a dataset with no volume at all.
    (s as any).placeRegionMeshes(DATASET);
    expect(surfaces()).toHaveLength(1);
    (s as any).placeRegionMeshes({ id: 'none' });
    expect(surfaces()).toHaveLength(0);
    // The meshes are kept: the matching volume brings them back.
    (s as any).placeRegionMeshes(DATASET);
    expect(surfaces()).toHaveLength(1);
  });

  it('shows none over an image that is not the volume stack', () => {
    const { s, surfaces } = scene({ isStack: false, trueImageSize: [400, 200], urls: ['tissue'] });
    s.setRegionMeshes([square()]);
    (s as any).placeRegionMeshes(DATASET);
    expect(surfaces()).toHaveLength(0);
    expect(s.voxelStep()).toBeNull();
  });

  it('lets the reference volume hide the surfaces behind it, or none, as the Volume view', () => {
    const { s, volume } = scene(STACK);
    s.setRegionsThroughVolume(true);
    expect(volume.blending).toBe('translucent_no_depth');
    s.setRegionsThroughVolume(false);
    expect(volume.blending).toBe('translucent');
  });
});
