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

describe('SpatialControlsFacade on a new dataset', () => {
  it("drops the group colours, chosen for the old dataset's groupings", () => {
    const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    const store = new VisualizerStore();
    const ctx = { store, selectionStore: new SpatialSelectionStore() } as unknown as SpatialControlsContext;
    const facade = new SpatialControlsFacade({ getDataset$: () => dataset$ } as unknown as SpatialDataPort, ctx);
    store.setSpatialView({ groupColors: { cluster: { A: '#ff0000' } } });
    dataset$.next({ ...dataset, id: 'same' } as SpatialDataset);
    dataset$.next(dataset);
    expect(store.currentSpatialView().groupColors).toEqual({});
    facade.dispose();
  });

  it("colours a grouping's legend and its categorical view with the user's colours over its own", async () => {
    const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    const store = new VisualizerStore();
    const ctx = { store, selectionStore: new SpatialSelectionStore() } as unknown as SpatialControlsContext;
    const column = {
      kind: 'categorical',
      name: 'cluster',
      meta: { kind: 'categorical', name: 'cluster', categories: ['A', 'B'], colors: ['#111111', '#222222'] },
      codes: Uint16Array.of(0, 1),
    };
    const port = { getDataset$: () => dataset$, getColumn: async () => column } as unknown as SpatialDataPort;
    const facade = new SpatialControlsFacade(port, ctx);
    store.setSpatialView({ groupColors: { cluster: { B: '#abcdef' }, other: { A: '#000000' } } });
    expect(await facade.controls.categoryColors('cluster')).toEqual(['#111111', '#abcdef']);
    expect((await facade.controls.categoricalView('cluster')).colors).toEqual(['#111111', '#abcdef']);
    facade.dispose();
  });

  it("colours a segmented dataset's markers by its cells' grouping, unless a colouring is chosen", () => {
    const cells = {
      ...dataset,
      id: 'ileum',
      columns: [{ kind: 'categorical', name: 'cell_type', categories: ['T', 'B'] }],
      polygonTiles: { bounds: [0, 0, 1, 1], levels: [], sets: [] },
    } as unknown as SpatialDataset;
    const dataset$ = new BehaviorSubject<SpatialDataset | null>(cells);
    const store = new VisualizerStore();
    const ctx = { store, selectionStore: new SpatialSelectionStore() } as unknown as SpatialControlsContext;
    const facade = new SpatialControlsFacade({ getDataset$: () => dataset$ } as unknown as SpatialDataPort, ctx);
    expect(store.currentSpatialView().colorBy).toEqual({ kind: 'column', name: 'cell_type' });

    // One colour chosen: kept for the next segmented dataset.
    store.setSpatialView({ colorBy: null, cellColorMode: 'single' });
    dataset$.next({ ...cells, id: 'other' } as SpatialDataset);
    expect(store.currentSpatialView().colorBy).toBeNull();
    // Without cells, the markers keep their flat colour.
    store.setSpatialView({ cellColorMode: 'group' });
    dataset$.next({ ...cells, id: 'spots', polygonTiles: undefined } as SpatialDataset);
    expect(store.currentSpatialView().colorBy).toBeNull();
    facade.dispose();
  });

  it('drops the gene filter, which names the old dataset genes', () => {
    const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    const store = new VisualizerStore();
    const ctx = {
      store,
      selectionStore: new SpatialSelectionStore(),
    } as unknown as SpatialControlsContext;
    const facade = new SpatialControlsFacade({ getDataset$: () => dataset$ } as unknown as SpatialDataPort, ctx);

    store.setSpatialView({ observationGenes: ['Ttr'], observationGenesMatch: 'all' });
    dataset$.next({ ...dataset, id: 'other' } as SpatialDataset);

    expect(store.currentSpatialView().observationGenes).toEqual([]);
    // How several genes combine is the user's preference, kept for the next filter.
    expect(store.currentSpatialView().observationGenesMatch).toBe('all');
    facade.dispose();
  });
});

describe('SpatialControlsFacade gene heatmap', () => {
  function controlsFor(port: Partial<SpatialDataPort>) {
    const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
    const ctx = {
      store: new VisualizerStore(),
      selectionStore: new SpatialSelectionStore(),
    } as unknown as SpatialControlsContext;
    const facade = new SpatialControlsFacade(
      { getDataset$: () => dataset$, ...port } as unknown as SpatialDataPort,
      ctx,
    );
    return { facade, controls: facade.controls };
  }

  it('passes the port’s gene heatmap through when it serves all of it', async () => {
    const tile = jest.fn(async () => new Float32Array([1]));
    const { facade, controls } = controlsFor({
      getGeneHeatmap: jest.fn(async () => ({ column: 'cluster' }) as never),
      getGeneHeatmapMeans: jest.fn(),
      getGeneHeatmapOrder: jest.fn(),
      getGeneHeatmapTile: tile,
    });
    expect(controls.geneHeatmap).toBeDefined();
    expect(await controls.geneHeatmap!.tile('cluster', 1, 2, 3, 4, 'gene')).toEqual(new Float32Array([1]));
    expect(tile).toHaveBeenCalledWith('cluster', 1, 2, 3, 4, 'gene');
    facade.dispose();
  });

  it('offers none when the port serves only part of it', () => {
    const { facade, controls } = controlsFor({ getGeneHeatmap: jest.fn() });
    expect(controls.geneHeatmap).toBeUndefined();
    facade.dispose();
  });
});
