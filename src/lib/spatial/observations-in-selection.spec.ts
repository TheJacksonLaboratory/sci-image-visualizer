import { BehaviorSubject, Subject, filter, firstValueFrom } from 'rxjs';

import { DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { PlotType } from '../contracts/plot-type';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { Rectangle, Region } from '../models/region';
import { RegionStore } from '../store/region-store.service';
import { SpatialSelectionStore } from '../store/spatial-selection.service';
import { VisualizerStore } from '../store/visualizer-store.service';
import { describeObservations } from './observations-in-selection';
import { SpatialControlsContext, SpatialControlsFacade } from './spatial-controls.facade';
import { selectByIndices } from './spatial-selection';

/**
 * Three cells on two planes (z 0 and 10): cell 0 at (10, 10, z 0) of type T, cell 1 at (100, 10,
 * z 7) of T, cell 2 at (40, 100, z 0) of U; their areas 10, 20 and 30 µm², their clusters k1, k2, k1.
 */
const dataset = {
  id: 'ileum',
  observations: {
    count: 3,
    x: Float32Array.of(10, 100, 40),
    y: Float32Array.of(10, 10, 100),
    z: Float32Array.of(0, 7, 0),
    ids: ['c-a', 'c-b', 'c-c'],
  },
  columns: [
    { kind: 'categorical', name: 'cell_type', categories: ['T', 'U'], colors: ['#ff0000', '#0000ff'] },
    { kind: 'categorical', name: 'cluster', categories: ['k1', 'k2'], colors: ['#00ff00', '#ffff00'] },
    { kind: 'continuous', name: 'area', unit: 'µm²' },
  ],
} as unknown as SpatialDataset;

const COLUMNS: Record<string, unknown> = {
  cell_type: { meta: dataset.columns[0], codes: Uint16Array.of(0, 0, 1) },
  cluster: { meta: dataset.columns[1], codes: Uint16Array.of(0, 1, 0) },
  area: { meta: dataset.columns[2], values: Float32Array.of(10, 20, 30) },
};

function fakePort() {
  return {
    getDataset$: () => new BehaviorSubject<SpatialDataset | null>(dataset),
    getColumn: jest.fn(async (name: string) => COLUMNS[name] as never),
  };
}

function rect(id: number, x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  r.id = id;
  r.bounds = Object.assign(new Rectangle(), { x, y, width: w, height: h });
  return r;
}

describe('describeObservations', () => {
  const view = { ...DEFAULT_SPATIAL_VIEW, cellTypeColumn: 'cell_type' };

  it('counts the selection by the cell types, in their colours, and averages the measurements', async () => {
    const d = await describeObservations(fakePort(), dataset, view, Uint8Array.of(1, 1, 1));
    expect(d.total).toBe(3);
    expect(d.groupColumn).toBe('cell_type');
    expect(d.groups).toEqual([
      { name: 'T', count: 2, color: '#ff0000' },
      { name: 'U', count: 1, color: '#0000ff' },
    ]);
    expect(d.measures).toEqual([{ name: 'area', value: 20, unit: 'µm²', mean: true }]);
    expect(d.cellId).toBeUndefined();
  });

  it('counts by the grouping the observations are coloured by', async () => {
    const d = await describeObservations(
      fakePort(),
      dataset,
      { ...view, colorBy: { kind: 'column', name: 'cluster' } },
      Uint8Array.of(1, 1, 1),
    );
    expect(d.groupColumn).toBe('cluster');
    expect(d.groups.map((g) => [g.name, g.count])).toEqual([
      ['k1', 2],
      ['k2', 1],
    ]);
  });

  it('describes one cell: its id, its other groupings and its own values', async () => {
    const d = await describeObservations(fakePort(), dataset, view, Uint8Array.of(0, 1, 0));
    expect(d.cellId).toBe('c-b');
    expect(d.groups).toEqual([{ name: 'T', count: 1, color: '#ff0000' }]);
    expect(d.measures).toEqual([
      { name: 'cluster', value: 'k2', mean: false },
      { name: 'area', value: 20, unit: 'µm²', mean: false },
    ]);
  });

  it('is empty for an empty selection', async () => {
    const d = await describeObservations(fakePort(), dataset, view, new Uint8Array(3));
    expect(d).toEqual({ total: 0, groupColumn: null, groups: [], measures: [] });
  });
});

describe('SpatialControlsFacade observations in selection', () => {
  let plotType: PlotType;
  let z: number;
  let regions: Region[];
  let picked$: BehaviorSubject<readonly string[]>;
  let selectedShapes$: BehaviorSubject<number[]>;
  let selection: SpatialSelectionStore;

  function facade(): SpatialControlsFacade {
    const store = new VisualizerStore();
    store.setSpatialView({ cellTypeColumn: 'cell_type' });
    const ctx: SpatialControlsContext = {
      store,
      regionStore: {
        getRegions: () => regions,
        getPickedClasses: () => picked$.value,
        getPickedClasses$: () => picked$,
        getSelectedShapeIndices: () => selectedShapes$.value,
        getSelectedShapeIndices$: () => selectedShapes$,
        getRegionUpdateEvent: () => new Subject(),
      } as unknown as RegionStore,
      selectionStore: selection,
      napari: {} as never,
      plotType: () => plotType,
      zIndex: () => z,
      slicePlanes: () => [0, 10],
      viewChanged$: new Subject<void>(),
    };
    return new SpatialControlsFacade(fakePort() as unknown as SpatialDataPort, ctx);
  }

  const settled = (f: SpatialControlsFacade) =>
    firstValueFrom(f.controls.getObservationsInSelection$!().pipe(filter((s) => s.state !== 'loading')));

  beforeEach(() => {
    plotType = PlotType.SPATIAL_OMICS_3D;
    z = 0;
    regions = [];
    picked$ = new BehaviorSubject<readonly string[]>([]);
    selectedShapes$ = new BehaviorSubject<number[]>([]);
    selection = new SpatialSelectionStore();
  });

  it('asks for a selection while there is none', async () => {
    const list = await settled(facade());
    expect(list).toMatchObject({ state: 'empty' });
    expect(list.message).toMatch(/list the observations/);
  });

  it('in 3D, describes the cell clicked', async () => {
    const f = facade();
    selection.set(selectByIndices([0], 3));
    expect(await settled(f)).toMatchObject({
      state: 'ready',
      scope: 'cells',
      label: 'Cell c-a',
      plane: null,
      total: 1,
      cellId: 'c-a',
      groups: [{ name: 'T', count: 1 }],
    });
  });

  it('in 3D, lists the cells of the picked cell type through the volume', async () => {
    picked$.next(['T']);
    const list = await settled(facade());
    expect(list).toMatchObject({ scope: 'types', label: 'Cell type: T', total: 2 });
    expect(list.measures).toEqual([{ name: 'area', value: 15, unit: 'µm²', mean: true }]);
  });

  it('in 2D, lists those of the selected region on the plane shown', async () => {
    plotType = PlotType.SPATIAL_OMICS;
    regions = [rect(1, 90, 0, 20, 20)]; // around cell 1, which lies on plane 1 (z 7)
    selectedShapes$.next([0]);
    z = 0;
    expect(await settled(facade())).toMatchObject({ scope: 'regions', plane: { index: 0 }, total: 0 });
    z = 1;
    expect(await settled(facade())).toMatchObject({
      scope: 'regions',
      label: '1 selected region',
      plane: { index: 1, count: 2 },
      total: 1,
      groups: [{ name: 'T', count: 1 }],
    });
  });

  it('in 2D, keeps the selected cells on the plane shown', async () => {
    plotType = PlotType.SPATIAL_OMICS;
    const f = facade();
    selection.set(selectByIndices([0, 1, 2], 3));
    z = 1;
    expect(await settled(f)).toMatchObject({ total: 1, groups: [{ name: 'T', count: 1 }] });
  });
});
