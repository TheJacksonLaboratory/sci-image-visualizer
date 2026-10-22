import { BehaviorSubject } from 'rxjs';

import { PlotType } from '../contracts/plot-type';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { SliceOutlines } from '../geometry/reconstruct';
import { Rectangle, Region } from '../models/region';
import { RegionStore } from '../store/region-store.service';
import { SpatialSelectionStore } from '../store/spatial-selection.service';
import { VisualizerStore } from '../store/visualizer-store.service';
import { SpatialControlsContext, SpatialControlsFacade } from './spatial-controls.facade';

/**
 * Three cells of a brain over its 10 × 10 × 2 reference volume (10 µm voxels): two in section 0
 * (one at voxel (2, 2), one at (7, 7)), one in section 1 at (2, 2).
 */
const dataset: SpatialDataset = {
  id: 'brain',
  observations: {
    count: 3,
    x: Float32Array.from([25, 75, 25]),
    y: Float32Array.from([25, 75, 25]),
    z: Float32Array.from([5, 5, 15]),
  },
  columns: [],
  volume: { width: 10, height: 10, depth: 2, voxelSize: [10, 10, 10] },
} as unknown as SpatialDataset;

/** A structure covering voxels (0..4, 0..4) of both sections. */
const structure: SliceOutlines[] = [0, 1].map((z) => ({ z, rings: [[0, 0, 4, 0, 4, 4, 0, 4]] }));

function rect(id: number, x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  r.id = id;
  r.bounds = Object.assign(new Rectangle(), { x, y, width: w, height: h });
  return r;
}

describe('SpatialControlsFacade selectFromRegions', () => {
  let plotType: PlotType;
  let picked: string[];
  let regions: Region[];
  let lassos: number[];
  let projection: Float32Array | null;
  let voxelStep: number | null;
  let selection: SpatialSelectionStore;
  let classSliceOutlines: jest.Mock;

  function facade(): SpatialControlsFacade {
    const port = { getDataset$: () => new BehaviorSubject<SpatialDataset | null>(dataset) };
    const ctx: SpatialControlsContext = {
      store: new VisualizerStore(),
      regionStore: {
        getRegions: () => regions,
        getPickedClasses: () => picked,
        getPickedClasses$: () => new BehaviorSubject(picked),
        classSliceOutlines,
      } as unknown as RegionStore,
      selectionStore: selection,
      napari: {
        transcriptEstimate$: new BehaviorSubject(null),
        geneCountsInView$: new BehaviorSubject(null),
        densityStats$: new BehaviorSubject(null),
        getSpatialScreenProjection: () => projection,
        getSpatialLassoIds: () => lassos,
        regionVoxelStep: () => voxelStep,
      },
      plotType: () => plotType,
      zIndex: () => 0,
    };
    return new SpatialControlsFacade(port as unknown as SpatialDataPort, ctx);
  }

  beforeEach(() => {
    plotType = PlotType.SPATIAL_OMICS_3D;
    picked = [];
    regions = [];
    lassos = [];
    // Each cell drawn at its voxel's canvas pixel ×10, say.
    projection = Float32Array.from([20, 20, 70, 70, 20, 20]);
    voxelStep = 1;
    selection = new SpatialSelectionStore();
    classSliceOutlines = jest.fn(async () => structure);
  });

  it('in 3D, selects the cells inside the volumes of the classes picked, through every section', async () => {
    picked = ['fiber tracts', 'cbf'];
    // A lasso drawn earlier does not count while classes are picked.
    regions = [rect(1, 60, 60, 20, 20)];
    lassos = [1];
    expect(await facade().controls.selectFromRegions()).toBe(2);
    expect(classSliceOutlines).toHaveBeenCalledWith(['fiber tracts', 'cbf']);
    expect(Array.from(selection.current().mask)).toEqual([1, 0, 1]);
  });

  it('in 3D without a pick, selects by the lassos drawn over the cloud only', async () => {
    // Region 2 is an atlas structure on the volume's stack (image px): it means nothing on screen.
    regions = [rect(1, 60, 60, 20, 20), rect(2, 0, 0, 30, 30)];
    lassos = [1];
    expect(await facade().controls.selectFromRegions()).toBe(1);
    expect(Array.from(selection.current().mask)).toEqual([0, 1, 0]);
    expect(classSliceOutlines).not.toHaveBeenCalled();
  });

  it('ignores the pick when the plotted image is not the reference volume (no regions in its grid)', async () => {
    picked = ['fiber tracts'];
    voxelStep = null;
    regions = [rect(1, 60, 60, 20, 20)];
    lassos = [1];
    const { controls } = facade();
    // The panel is told the same: it describes the lasso selection, not the classes.
    expect(controls.roiSelectionMode!()).toBe('regions');
    expect(await controls.selectFromRegions()).toBe(1);
    expect(classSliceOutlines).not.toHaveBeenCalled();
  });

  it('reports the class-volume mode exactly when the selection runs in it', () => {
    const { controls } = facade();
    expect(controls.roiSelectionMode!()).toBe('regions'); // nothing picked
    picked = ['fiber tracts'];
    expect(controls.roiSelectionMode!()).toBe('class-volumes');
    plotType = PlotType.SPATIAL_OMICS;
    expect(controls.roiSelectionMode!()).toBe('regions'); // the 2D view
  });

  it('in 2D, selects by the regions drawn over the section on screen, pick or not', async () => {
    plotType = PlotType.SPATIAL_OMICS;
    picked = ['fiber tracts'];
    // Voxel px: (0..3, 0..3) of section 0 holds the first cell only.
    regions = [rect(2, 0, 0, 3, 3)];
    expect(await facade().controls.selectFromRegions()).toBe(1);
    expect(Array.from(selection.current().mask)).toEqual([1, 0, 0]);
    expect(classSliceOutlines).not.toHaveBeenCalled();
  });

  describe('a class-volume selection superseded while its outlines are read', () => {
    let release: Array<(o: SliceOutlines[]) => void>;

    beforeEach(() => {
      picked = ['fiber tracts'];
      release = [];
      classSliceOutlines = jest.fn(() => new Promise<SliceOutlines[]>((r) => release.push(r)));
    });

    it('publishes nothing once the selection was cleared meanwhile', async () => {
      const { controls } = facade();
      selection.set({ mask: Uint8Array.from([0, 1, 0]), count: 1 });
      const pending = controls.selectFromRegions();
      controls.clearSelection();
      release[0](structure);
      expect(await pending).toBeNull();
      expect(selection.current().count).toBe(0);
    });

    it('leaves a newer linked selection standing', async () => {
      const { controls } = facade();
      const pending = controls.selectFromRegions();
      controls.selectIndices([1]);
      release[0](structure);
      expect(await pending).toBeNull();
      expect(Array.from(selection.current().mask)).toEqual([0, 1, 0]);
    });

    it('lets only the latest of two requests publish', async () => {
      const { controls } = facade();
      const first = controls.selectFromRegions();
      const second = controls.selectFromRegions();
      release[1](structure);
      expect(await second).toBe(2);
      release[0]([]);
      expect(await first).toBeNull();
      expect(Array.from(selection.current().mask)).toEqual([1, 0, 1]);
    });

    it('publishes nothing when the pick or the view changed, or the facade was disposed', async () => {
      let built = facade();
      let pending = built.controls.selectFromRegions();
      picked = ['cbf'];
      release[0](structure);
      expect(await pending).toBeNull();

      picked = ['fiber tracts'];
      pending = built.controls.selectFromRegions();
      plotType = PlotType.SPATIAL_OMICS;
      release[1](structure);
      expect(await pending).toBeNull();

      plotType = PlotType.SPATIAL_OMICS_3D;
      built = facade();
      pending = built.controls.selectFromRegions();
      built.dispose();
      release[2](structure);
      expect(await pending).toBeNull();
      expect(selection.current().count).toBe(0);
    });
  });
});
