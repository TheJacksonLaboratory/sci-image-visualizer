import { HeadlessViewer } from 'napari-js/testing';
import type { AxesLayer, Points3DLayer, Viewer, VolumeLayer } from 'napari-js';

import {
  SPATIAL_Z_SCALE_MIN,
  Spatial3dScene,
  spatialAxesLabels,
  spatialZPixelsPerDouble,
  spatialZScaleMax,
} from './napari-spatial-3d-scene';
import { VolumeRegionMeshes } from './napari-volume-region-meshes';
import { Spatial3dTranscripts } from './napari-spatial-3d-transcripts';

/** A thin section: 1000 x 500 units wide, 20 deep, 0.5 µm per unit; no reference volume. */
function section(): any {
  const x = Float32Array.of(0, 1000, 500);
  const y = Float32Array.of(0, 500, 250);
  const z = Float32Array.of(0, 20, 10);
  return { id: 'ileum', micronsPerUnit: 0.5, observations: { count: 3, x, y, z } };
}

/** The scene with what its frame, axes and stretch use (its constructor needs a whole session). */
function scene(dataset: any, spatialZScale = 1) {
  const v = new HeadlessViewer({ canvasRect: { width: 300, height: 200 } });
  const viewer = v as unknown as Viewer;
  const host = document.createElement('div');
  const settings = { axesVisible: true, spatialZScale };
  const s = Object.assign(Object.create(Spatial3dScene.prototype), {
    ctx: { viewer, host, settings },
    session: { latest: [dataset, {}, {}], geneMapVolume: { field: null, key: null } },
    regionMeshes: new VolumeRegionMeshes(viewer),
    cells3d: {
      setPlacement: jest.fn(),
      setHiddenClasses: jest.fn(),
      setDataset: jest.fn(),
      pick: () => -1,
      dispose: jest.fn(),
    },
    transcripts3d: new Spatial3dTranscripts(viewer, () => () => undefined),
    baseVoxels: new WeakMap(),
    densityLayers: [],
    origin: [0, 0, 0],
    box: null,
    boxKey: null,
    gizmo: null,
    zHandle: null,
    points: null,
    volume: null,
    geneMapLayer: null,
  }) as Spatial3dScene;
  const axes = () => v.layers.items.find((l) => l.kind === 'axes') as AxesLayer | undefined;
  return { s, v, viewer, host, settings, axes };
}

describe('Spatial3dScene Z stretch', () => {
  it('sits the cloud in a box centred on the origin, with the axes gizmo and the Z handle on it', () => {
    const { s, host, axes } = scene(section());
    (s as any).ensureFrame(section());
    // The density grid's box: 128 voxels along the longest side, measured from the coordinate origin.
    const box = (s as any).box;
    expect(box.width).toBeCloseTo(1000, 6);
    expect(box.height).toBeCloseTo(500, 6);
    expect(box.depth).toBeGreaterThanOrEqual(20);
    expect((s as any).origin).toEqual([-box.width / 2, -box.height / 2, -box.depth / 2]);
    expect([axes()!.width, axes()!.height, axes()!.depth]).toEqual([box.width, box.height, box.depth]);
    expect(host.textContent).toContain('↕'); // the Z handle
  });

  it('stretches the cloud, the volumes and the axes together, and keeps the choice', () => {
    const { s, viewer, settings, axes } = scene(section());
    (s as any).ensureFrame(section());
    const points = viewer.addPoints3D(Float32Array.of(0, 0, 1, 2, 2, 3)) as Points3DLayer;
    (s as any).points = points;
    const volume = (s as any).addVolume(viewer, new Uint8Array(8), 2, 2, 2, {
      voxelSize: [3, 4, 5],
    }) as VolumeLayer;
    (s as any).volume = volume;
    const depth = (s as any).box.depth;

    s.setZScale(4);
    expect(settings.spatialZScale).toBe(4);
    expect(points.scale3d).toEqual([1, 1, 4]);
    expect(volume.voxelSize).toEqual([3, 4, 20]);
    expect(axes()!.depth).toBeCloseTo(depth * 4, 6);

    // A volume added later is stretched as it is added.
    const later = (s as any).addVolume(viewer, new Uint8Array(8), 2, 2, 2, {
      voxelSize: [1, 1, 2],
    }) as VolumeLayer;
    expect(later.voxelSize).toEqual([1, 1, 8]);

    s.setZScale(1);
    expect(points.scale3d).toEqual([1, 1, 1]);
    expect(volume.voxelSize).toEqual([3, 4, 5]);
  });

  it('clamps the stretch to what the box allows, and applies a kept stretch to the next box', () => {
    const { s, settings } = scene(section(), 1e6);
    (s as any).ensureFrame(section());
    const max = spatialZScaleMax((s as any).box);
    expect(s.zScale()).toBe(max);
    s.setZScale(1e-6);
    expect(settings.spatialZScale).toBe(SPATIAL_Z_SCALE_MIN);
  });

  it("allows a thin section to be stood up to twice its width, and a block the Volume view's 10x", () => {
    expect(spatialZScaleMax({ width: 1000, height: 500, depth: 20 })).toBe(100);
    expect(spatialZScaleMax({ width: 100, height: 100, depth: 100 })).toBe(10);
    expect(spatialZScaleMax({ width: 1e6, height: 1, depth: 1 })).toBe(1000);
    // Wider ranges drag faster, so the whole range is about the same drag.
    expect(spatialZPixelsPerDouble(10)).toBeCloseTo(162.6, 1);
    expect(spatialZPixelsPerDouble(100)).toBeCloseTo(81.3, 1);
    expect(spatialZPixelsPerDouble(1000)).toBe(60);
  });

  it('labels the axes with their true lengths, and says how much Z is stretched', () => {
    const drawn = { width: 1000, height: 500, depth: 80 };
    const [x, y, z] = spatialAxesLabels(drawn, 4, 0.5);
    expect(x.text).toBe('X · 500 µm');
    expect(y.text).toBe('Y · 250 µm');
    expect(z.text).toBe('Z · 10 µm (×4)');
    expect(z.anchor).toEqual([-500, -250, 40]);
    expect(spatialAxesLabels(drawn, 1)[2].text).toBe('Z · 80 units');
  });

  it('takes the axes down with the cloud', () => {
    const { s, v, host } = scene(section());
    (s as any).ensureFrame(section());
    (s as any).removeLayers(v as unknown as Viewer);
    expect(v.layers.items.some((l) => l.kind === 'axes')).toBe(false);
    expect(host.textContent).not.toContain('↕');
  });
});
