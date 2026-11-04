import { BehaviorSubject, Subject, filter, firstValueFrom } from 'rxjs';

import { TranscriptsInSelection } from '../contracts/display-types';
import { PlotType } from '../contracts/plot-type';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { NO_OBSERVATION, SpatialDataset, SpatialTranscriptTile } from '../contracts/spatial-dataset.contract';
import { Rectangle, Region } from '../models/region';
import { RegionStore } from '../store/region-store.service';
import { SpatialSelectionStore } from '../store/spatial-selection.service';
import { VisualizerStore } from '../store/visualizer-store.service';
import { SpatialControlsContext, SpatialControlsFacade } from './spatial-controls.facade';
import { selectByIndices } from './spatial-selection';
import {
  cellsOfCategories,
  countTranscripts,
  tileBudget,
  tilesAroundCells,
  tilesUnderShapes,
  TRANSCRIPT_LIST_MAX_TILES,
} from './transcripts-in-selection';
import { regionShapes } from './spatial-selection';

/** One molecule: where, which gene (code), which cell (observation index, or none). */
type Molecule = [x: number, y: number, z: number, gene: number, cell: number];

/**
 * Three cells on a 128 × 128 section, its transcripts tiled 64 units across, on two planes (z 0
 * and 10): cell 0 at (10, 10) of type T, cell 1 at (100, 10) of type T, cell 2 at (40, 100) of U.
 */
const MOLECULES: Molecule[] = [
  [10, 10, 0, 0, 0],
  [12, 11, 0, 0, 0],
  [11, 9, 10, 1, 0], // cell 0, plane 1
  [100, 10, 0, 1, 1],
  [101, 12, 10, 1, 1],
  [40, 100, 0, 2, 2],
  [42, 101, 10, 2, 2],
  [60, 60, 0, 0, NO_OBSERVATION], // in no cell
];
const GENES = ['Actb', 'Lgr5', 'Muc2'];
const TILE = 64;

function tileOf(gx: number, gy: number): SpatialTranscriptTile {
  const in_ = MOLECULES.filter(([x, y]) => Math.floor(x / TILE) === gx && Math.floor(y / TILE) === gy);
  return {
    count: in_.length,
    aggregated: false,
    x: Float32Array.from(in_.map((m) => m[0])),
    y: Float32Array.from(in_.map((m) => m[1])),
    z: Float32Array.from(in_.map((m) => m[2])),
    weight: Uint32Array.from(in_.map(() => 1)),
    observation: Uint32Array.from(in_.map((m) => m[4])),
    gene: Uint16Array.from(in_.map((m) => m[3])),
  };
}

const dataset = {
  id: 'ileum',
  observations: {
    count: 3,
    x: Float32Array.of(10, 100, 40),
    y: Float32Array.of(10, 10, 100),
    z: Float32Array.of(0, 5, 0),
    ids: ['c-a', 'c-b', 'c-c'],
  },
  columns: [{ kind: 'categorical', name: 'cell_type', categories: ['T', 'U'] }],
  micronsPerUnit: 1,
  transcriptTiles: {
    bounds: [0, 0, 127, 127],
    geneCount: 3,
    genes: GENES,
    hasZ: true,
    levels: [{ tileSize: TILE, aggregated: false }],
  },
} as unknown as SpatialDataset;

function rect(id: number, x: number, y: number, w: number, h: number, label?: string): Region {
  const r = new Region();
  r.id = id;
  r.label = label;
  r.bounds = Object.assign(new Rectangle(), { x, y, width: w, height: h });
  return r;
}

function fakePort() {
  return {
    getDataset$: () => new BehaviorSubject<SpatialDataset | null>(dataset),
    getColumn: jest.fn(async () => ({
      kind: 'categorical',
      name: 'cell_type',
      meta: { kind: 'categorical', name: 'cell_type', categories: ['T', 'U'] },
      codes: Uint16Array.of(0, 0, 1),
    })),
    getTranscriptTile: jest.fn(async (_level: number, gx: number, gy: number, _query?: unknown) => tileOf(gx, gy)),
  };
}

describe('transcripts in selection: tiles and counts', () => {
  it('reads the tiles within reach of the selected cells only', () => {
    const { tiles, partial } = tilesAroundCells(
      dataset.observations,
      Uint8Array.of(1, 0, 0),
      20,
      dataset.transcriptTiles!.levels,
      dataset.transcriptTiles!.bounds,
    );
    expect(tiles).toEqual([{ level: 0, gx: 0, gy: 0 }]);
    expect(partial).toBe(false);
  });

  it('keeps the tiles holding the most selected cells when there are too many', () => {
    const obs = { count: 3, x: Float32Array.of(10, 12, 100), y: Float32Array.of(10, 12, 100) };
    const { tiles, partial } = tilesAroundCells(
      obs as never,
      Uint8Array.of(1, 1, 1),
      1,
      [{ tileSize: TILE }],
      null,
      1,
    );
    expect(tiles).toEqual([{ level: 0, gx: 0, gy: 0 }]);
    expect(partial).toBe(true);
    expect(TRANSCRIPT_LIST_MAX_TILES).toBeGreaterThan(100);
  });

  it('reads fewer tiles of a dense dataset', () => {
    const levels = [{ tileSize: 250 }];
    // Ileum-like: 819,665 transcripts over 23 × 38 tiles — read whole.
    expect(tileBudget({ bounds: [0, 0, 5721, 9392], count: 819_665, levels })).toBe(TRANSCRIPT_LIST_MAX_TILES);
    // 80 M over 40 × 40: some 50,000 a tile — about 400 of them.
    expect(tileBudget({ bounds: [0, 0, 9999, 9999], count: 80_000_000, levels })).toBe(400);
    expect(tileBudget({ bounds: [0, 0, 100, 100], levels })).toBe(TRANSCRIPT_LIST_MAX_TILES);
  });

  it('reads the tiles under the shapes, through the image ref', () => {
    // Image px are twice the observation units: a 20 px box at (180, 0) is (90..100, 0..10).
    const shapes = regionShapes(rect(1, 180, 0, 20, 20));
    const { tiles } = tilesUnderShapes(shapes, { scale: [2, 2] } as never, [{ tileSize: TILE }], [0, 0, 127, 127]);
    expect(tiles).toEqual([{ level: 0, gx: 1, gy: 0 }]);
  });

  it("counts a cell's transcripts by gene, through every plane or in one plane's band", async () => {
    const port = fakePort() as unknown as SpatialDataPort;
    const all = await countTranscripts({
      port,
      tiles: [{ level: 0, gx: 0, gy: 0 }],
      quality: 'high',
      filter: { kind: 'cells', mask: Uint8Array.of(1, 0, 0) },
      names: GENES,
    });
    expect(all).toEqual({
      total: 3,
      cells: 1,
      genes: [
        { name: 'Actb', count: 2 },
        { name: 'Lgr5', count: 1 },
      ],
      partial: false,
    });
    const plane1 = await countTranscripts({
      port,
      tiles: [{ level: 0, gx: 0, gy: 0 }],
      quality: 'high',
      filter: { kind: 'cells', mask: Uint8Array.of(1, 0, 0) },
      band: [5, Infinity],
      names: GENES,
    });
    expect(plane1?.genes).toEqual([{ name: 'Lgr5', count: 1 }]);
  });

  it('counts what lies inside shapes, whichever cell it is in (or none)', async () => {
    const port = fakePort() as unknown as SpatialDataPort;
    const shapes = regionShapes(rect(1, 50, 50, 20, 20));
    const count = await countTranscripts({
      port,
      tiles: [{ level: 0, gx: 0, gy: 0 }],
      quality: 'high',
      filter: { kind: 'shapes', shapes },
      names: GENES,
    });
    expect(count).toMatchObject({ total: 1, cells: 0, genes: [{ name: 'Actb', count: 1 }] });
  });

  it('says the count is partial when a tile fails, and fails when every tile does', async () => {
    const port = fakePort();
    port.getTranscriptTile.mockImplementationOnce(async () => {
      throw new Error('503');
    });
    const tiles = [
      { level: 0, gx: 0, gy: 0 },
      { level: 0, gx: 1, gy: 0 },
    ];
    const filter = { kind: 'cells' as const, mask: Uint8Array.of(1, 1, 1) };
    const some = await countTranscripts({ port: port as never, tiles, quality: 'high', filter });
    expect(some?.partial).toBe(true);
    port.getTranscriptTile.mockImplementation(async () => {
      throw new Error('503');
    });
    await expect(countTranscripts({ port: port as never, tiles, quality: 'high', filter })).rejects.toThrow();
  });

  it('turns category names into the cells of those categories', () => {
    expect(cellsOfCategories(Uint16Array.of(0, 1, 0, 2), ['T', 'U', 'V'], ['T', 'V'])).toEqual({
      mask: Uint8Array.of(1, 0, 1, 1),
      count: 3,
    });
  });
});

describe('SpatialControlsFacade transcripts in selection', () => {
  let plotType: PlotType;
  let z: number;
  let regions: Region[];
  let picked$: BehaviorSubject<readonly string[]>;
  let selectedShapes$: BehaviorSubject<number[]>;
  let selection: SpatialSelectionStore;
  let viewChanged$: Subject<void>;
  let port: ReturnType<typeof fakePort>;

  function facade(): SpatialControlsFacade {
    const ctx: SpatialControlsContext = {
      store: new VisualizerStore(),
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
      viewChanged$,
    };
    return new SpatialControlsFacade(port as unknown as SpatialDataPort, ctx);
  }

  /** The next list that is not loading. */
  const settled = (f: SpatialControlsFacade) =>
    firstValueFrom(f.controls.getTranscriptsInSelection$!().pipe(filter((s) => s.state !== 'loading')));

  beforeEach(() => {
    plotType = PlotType.SPATIAL_OMICS_3D;
    z = 0;
    regions = [];
    picked$ = new BehaviorSubject<readonly string[]>([]);
    selectedShapes$ = new BehaviorSubject<number[]>([]);
    selection = new SpatialSelectionStore();
    selection.set(selectByIndices([], 3));
    viewChanged$ = new Subject<void>();
    port = fakePort();
  });

  it('asks for a selection while there is none', async () => {
    const list = await settled(facade());
    expect(list.state).toBe('empty');
    expect(list.message).toMatch(/Select a cell/);
  });

  it("in 3D, lists the selected cell's transcripts through the whole volume", async () => {
    const f = facade(); // (a new dataset clears the selection)
    selection.set(selectByIndices([0], 3));
    const list = await settled(f);
    expect(list).toMatchObject<Partial<TranscriptsInSelection>>({
      state: 'ready',
      scope: 'cells',
      label: 'Cell c-a',
      plane: null,
      total: 3,
      cells: 1,
    });
    // Only the tile around the cell was read.
    expect(port.getTranscriptTile).toHaveBeenCalledTimes(1);
    expect(port.getTranscriptTile.mock.calls[0][3]).toEqual({ genes: ['*'], quality: 'high' });
  });

  it('in 3D, lists the transcripts of the cells of the picked cell type', async () => {
    picked$.next(['T']);
    const list = await settled(facade());
    expect(list).toMatchObject({ state: 'ready', scope: 'types', label: 'Cell type: T', total: 5, cells: 2 });
    expect(list.genes).toEqual([
      { name: 'Lgr5', count: 3 },
      { name: 'Actb', count: 2 },
    ]);
  });

  it('the latest selection wins, and clearing it goes back to the one before', async () => {
    const f = facade();
    picked$.next(['T']);
    selection.set(selectByIndices([2], 3));
    expect(await settled(f)).toMatchObject({ scope: 'cells', label: 'Cell c-c', total: 2 });
    selection.clear();
    expect(await settled(f)).toMatchObject({ scope: 'types', total: 5 });
  });

  it('in 2D, counts only the transcripts on the plane shown', async () => {
    plotType = PlotType.SPATIAL_OMICS;
    const f = facade();
    selection.set(selectByIndices([0], 3));
    z = 1;
    const list = await settled(f);
    expect(list).toMatchObject({ state: 'ready', plane: { index: 1, count: 2 }, total: 1 });
    expect(list.genes).toEqual([{ name: 'Lgr5', count: 1 }]);
  });

  it('in 2D, counts what lies inside the selected regions on the plane, and is told of a new plane', async () => {
    plotType = PlotType.SPATIAL_OMICS;
    regions = [rect(1, 0, 0, 20, 20), rect(2, 90, 0, 20, 20)];
    selectedShapes$.next([1]);
    const f = facade();
    const lists: TranscriptsInSelection[] = [];
    const sub = f.controls.getTranscriptsInSelection$!().subscribe((s) => lists.push(s));
    await waitFor(() => lists.some((l) => l.state === 'ready'));
    expect(lists.find((l) => l.state === 'ready')).toMatchObject({
      scope: 'regions',
      label: '1 selected region',
      plane: { index: 0, count: 2 },
      total: 1,
    });
    z = 1;
    viewChanged$.next();
    await waitFor(() => lists.filter((l) => l.state === 'ready').length > 1);
    expect(lists.filter((l) => l.state === 'ready').at(-1)).toMatchObject({ plane: { index: 1 }, total: 1 });
    sub.unsubscribe();
  });

  it('in 3D, a drawn region is not a selection of the volume', async () => {
    regions = [rect(1, 0, 0, 20, 20)];
    selectedShapes$.next([0]);
    expect((await settled(facade())).state).toBe('empty');
  });
});

async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!ok()) throw new Error('timed out');
}
