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
function scene(info: any, dataset: any = DATASET, frame: any = {}) {
  const v = new HeadlessViewer({ canvasRect: { width: 200, height: 200 } });
  const viewer = v as unknown as Viewer;
  const volume: any = { blending: 'translucent' };
  const s = Object.assign(Object.create(Spatial3dScene.prototype), {
    info,
    ctx: { viewer, settings: { spatialZScale: 1 } },
    regionMeshes: new VolumeRegionMeshes(viewer),
    regionsThrough: false,
    volume,
    session: { latest: [dataset, {}, {}] },
    regionPlanes: null,
    origin: [0, 0, 0],
    box: null,
    ...frame,
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

  describe("a region set's planes over the dataset's own image", () => {
    /** A MERFISH section's tissue image (one plane), its observations in its pixels, three planes 300 deep. */
    const TISSUE: any = { isStack: false, trueImageSize: [4096, 200], urls: ['plate'] };
    const SECTION: any = { id: 'ileum', volume: VOLUME, imageRef: { imageId: 'b.omics/image/plate.ome.tif' } };
    /** The box the cloud is offset into (100 x 50 x 600, centred). */
    const BOX = { box: { width: 100, height: 50, depth: 600 }, origin: [-50, -25, -300] };

    it("places slice k at its plane's z, among the observations, and steps by the image's width", () => {
      const { s, surfaces } = scene(TISSUE, SECTION, BOX);
      s.setRegionMeshes([square()]);
      expect(surfaces()).toHaveLength(0);
      s.setRegionPlanes([0, 300, 600]);
      expect(surfaces()).toHaveLength(1);
      // x, y the observations' (the image's pixels), moved as the cloud is; slice 1 at z 300 -> 0.
      expect(Array.from(surfaces()[0].vertices.slice(0, 6))).toEqual([-50, -25, 0, -46, -25, 0]);
      expect(s.voxelStep()).toBe(4);
      // Not known any more: no place for them.
      s.setRegionPlanes(null);
      expect(surfaces()).toHaveLength(0);
      expect(s.voxelStep()).toBeNull();
    });

    it("takes image pixels back to the observations' units through imageRef", () => {
      const dataset = { ...SECTION, imageRef: { ...SECTION.imageRef, scale: [2, 2], translate: [10, 4] } };
      const { s, surfaces } = scene(TISSUE, dataset, BOX);
      s.setRegionMeshes([square()]);
      s.setRegionPlanes([0, 300, 600]);
      // Pixel (0, 0) is observation (-5, -2); pixel (4, 0) is (-3, -2).
      expect(Array.from(surfaces()[0].vertices.slice(0, 6))).toEqual([-55, -27, 0, -53, -27, 0]);
    });

    it('needs the dataset to have an image of its own', () => {
      const { s, surfaces } = scene(TISSUE, { ...SECTION, imageRef: undefined }, BOX);
      s.setRegionMeshes([square()]);
      s.setRegionPlanes([0, 300, 600]);
      expect(surfaces()).toHaveLength(0);
    });

    it('leaves the volume stack placing its own slices', () => {
      const { s, surfaces } = scene(STACK, { ...DATASET, imageRef: SECTION.imageRef }, BOX);
      s.setRegionMeshes([square()]);
      s.setRegionPlanes([0, 300, 600]);
      // As the stack places slice 1: its voxel plane's centre.
      expect(Array.from(surfaces()[0].vertices.slice(0, 3))).toEqual([-50, -25, 0]);
      expect(s.voxelStep()).toBe(1);
    });
  });
});
