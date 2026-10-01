import type { Viewer } from 'napari-js';
import { DEFAULT_SPATIAL_VIEW } from '../../contracts/display-types';
import type { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import { SpatialDataset, SpatialPolygonTile, SpatialTranscriptTile } from '../../contracts/spatial-dataset.contract';
import { emptySelection } from '../../spatial/spatial-selection';
import {
  NapariSpatialTileLayers, SpatialTileHost, mergePolygonTiles, mergeTranscriptTiles, pickNearest,
} from './napari-spatial-tiles';

const tile = (xs: number[], ys: number[], weight = 1): SpatialTranscriptTile => ({
  count: xs.length,
  aggregated: weight > 1,
  x: Float32Array.from(xs),
  y: Float32Array.from(ys),
  z: new Float32Array(xs.length),
  weight: new Uint32Array(xs.length).fill(weight),
  observation: Uint32Array.from(xs.map((_v, i) => i)),
  gene: new Uint16Array(xs.length),
});

describe('pickNearest (transcript hover)', () => {
  const drawn = (t: SpatialTranscriptTile, r: number) => ({
    merged: t, radius: new Float32Array(t.count).fill(r), grid: null,
  });

  it('finds the marker under the cursor, within its radius', () => {
    const d = drawn(tile([0, 10, 20], [0, 0, 0]), 2);
    expect(pickNearest(d, 10.5, 0.5, 0.1)).toBe(1);
    expect(pickNearest(d, 15, 0, 0.1)).toBe(-1); // between markers
  });

  it('uses the pointer tolerance for markers smaller than it', () => {
    const d = drawn(tile([0, 10], [0, 0]), 0.1);
    expect(pickNearest(d, 1, 0, 1.5)).toBe(0);
  });

  it('prefers the closest of overlapping markers', () => {
    const d = drawn(tile([0, 1.5], [0, 0]), 2);
    expect(pickNearest(d, 1.2, 0, 0.1)).toBe(1);
  });

  it('builds its grid once and reuses it', () => {
    const d = drawn(tile([0, 100, -100], [0, 50, -50]), 1);
    expect(pickNearest(d, 100, 50, 0.1)).toBe(1);
    const grid = d.grid;
    expect(grid).not.toBeNull();
    expect(pickNearest(d, -100, -50, 0.1)).toBe(2);
    expect(d.grid).toBe(grid);
  });
});

describe('tile merging', () => {
  it('concatenates transcript tiles and stops at the limit', () => {
    const m = mergeTranscriptTiles([tile([1, 2], [3, 4]), tile([5], [6])], 2);
    expect(m.count).toBe(2);
    expect(Array.from(m.x)).toEqual([1, 2]);
  });

  it('drops a ring listed by two tiles', () => {
    const t = (obs: number[]) => ({
      count: obs.length, observation: Uint32Array.from(obs),
      offsets: Uint32Array.from(obs.map((_o, i) => i * 3).concat(obs.length * 3)),
      coords: new Float32Array(obs.length * 6).map((_v, i) => i),
    });
    const m = mergePolygonTiles([t([7, 8]), t([8, 9])]);
    expect(Array.from(m.observation)).toEqual([7, 8, 9]);
    expect(m.offsets[m.count]).toBe(9);
  });
});

describe('NapariSpatialTileLayers: a tile that fails to load', () => {
  const ring = (): SpatialPolygonTile => ({
    count: 1, coords: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
    offsets: new Uint32Array([0, 4]), observation: new Uint32Array([0]),
  });

  function setup(failFirst: number) {
    let calls = 0;
    const getPolygonTile = jest.fn(() => {
      calls++;
      return calls <= failFirst ? Promise.reject(new Error('tile server hiccup')) : Promise.resolve(ring());
    });
    const port = { getPolygonTile } as unknown as SpatialDataPort;
    const dataset = {
      id: 'd', name: 'd', columns: [],
      observations: { count: 1, x: new Float32Array([5]), y: new Float32Array([5]), radius: 5 },
      polygonTiles: {
        bounds: [0, 0, 100, 100], sets: [{ name: 'cell', label: 'Cell' }], defaultSet: 'cell',
        levels: [{ tileSize: 200 }], // the whole view is one tile
      },
    } as unknown as SpatialDataset;
    const view = { ...DEFAULT_SPATIAL_VIEW, cellColorMode: 'single' as const };
    const host: SpatialTileHost = {
      latest: () => [dataset, view, emptySelection(1)],
      canvasSize: () => [400, 400],
      continuousLut: () => [],
      polygonsShownChanged: () => undefined,
    };
    const listeners: (() => void)[] = [];
    const items: unknown[] = [];
    const layer = () => { const l = { values: null }; return l; };
    const viewer = {
      camera: {
        center: [50, 50], zoom: 4,
        changed: { connect: (f: () => void) => { listeners.push(f); return () => undefined; } },
      },
      layers: {
        items,
        add: (l: unknown) => items.push(l),
        remove: (l: unknown) => items.splice(items.indexOf(l), 1),
      },
      addShapes: jest.fn(() => { const l = layer(); items.push(l); return l; }),
      addPoints: jest.fn(() => { const l = layer(); items.push(l); return l; }),
      addImage: jest.fn(() => { const l = layer(); items.push(l); return l; }),
      requestRender: () => undefined,
    } as unknown as Viewer;
    const tiles = new NapariSpatialTileLayers(port, host);
    tiles.attach(viewer);
    return { tiles, getPolygonTile, moveCamera: () => listeners.forEach((f) => f()) };
  }

  /** Let the debounce and every awaited fetch settle. */
  async function settle(ms: number) {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(ms / 20);
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined); // the failures are the point
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries the view instead of caching the hole', async () => {
    const { tiles, getPolygonTile, moveCamera } = setup(1);
    moveCamera();
    await settle(200);
    expect(getPolygonTile).toHaveBeenCalledTimes(1); // failed
    await settle(1200);                               // the retry
    expect(getPolygonTile).toHaveBeenCalledTimes(2);
    // Complete now: a pan over the same tiles is a no-op, and no further retries run.
    moveCamera();
    await settle(5000);
    expect(getPolygonTile).toHaveBeenCalledTimes(2);
    tiles.detach();
  });

  it('gives up after a bounded number of retries', async () => {
    const { tiles, getPolygonTile, moveCamera } = setup(100);
    moveCamera();
    await settle(20000);
    expect(getPolygonTile).toHaveBeenCalledTimes(4); // the first try and three retries
    tiles.detach();
  });
});

describe('NapariSpatialTileLayers: every gene at once', () => {
  const tile = (n: number): SpatialTranscriptTile => ({
    count: n, aggregated: false,
    x: new Float32Array(n).fill(5), y: new Float32Array(n).fill(5), z: new Float32Array(n),
    weight: new Uint32Array(n).fill(1), observation: new Uint32Array(n), gene: new Uint16Array(n),
  });

  function setup(individualCount: number, colorBy: 'cellType' | 'gene') {
    const getTranscriptTile = jest.fn(() => Promise.resolve(tile(individualCount)));
    const getTranscriptBins = jest.fn(() => Promise.resolve({ ...tile(4), aggregated: true }));
    const port = { getTranscriptTile, getTranscriptBins } as unknown as SpatialDataPort;
    // Sparse on average (10 transcripts over the bounds), so the plan starts individual.
    const dataset = {
      id: 'd', name: 'd', columns: [],
      observations: { count: 1, x: new Float32Array([5]), y: new Float32Array([5]) },
      transcriptTiles: { bounds: [0, 0, 100, 100], count: 10, levels: [{ tileSize: 200 }] },
      transcriptBins: {
        bounds: [0, 0, 100, 100], origin: [0, 0], count: 10, levels: [{ binSize: 25, tileSize: 200 }],
      },
    } as unknown as SpatialDataset;
    const view = {
      ...DEFAULT_SPATIAL_VIEW, transcriptMode: 'circles' as const, transcriptAllGenes: true,
      transcriptGenes: [], transcriptBudget: 1000, transcriptColorBy: colorBy,
    };
    const host: SpatialTileHost = {
      latest: () => [dataset, view, emptySelection(1)],
      canvasSize: () => [400, 400], continuousLut: () => [], polygonsShownChanged: () => undefined,
    };
    const items: unknown[] = [];
    const viewer = {
      camera: { center: [50, 50], zoom: 4, changed: { connect: () => () => undefined } },
      layers: {
        items,
        add: (l: unknown) => items.push(l),
        remove: (l: unknown) => items.splice(items.indexOf(l), 1),
      },
      addPoints: jest.fn(() => { const l = {}; items.push(l); return l; }),
      addShapes: jest.fn(() => { const l = {}; items.push(l); return l; }),
      addImage: jest.fn(() => { const l = {}; items.push(l); return l; }),
      requestRender: () => undefined,
    } as unknown as Viewer;
    const tiles = new NapariSpatialTileLayers(port, host);
    tiles.attach(viewer);
    type WithColors = { transcriptColors: (...a: unknown[]) => unknown };
    const colors = jest.spyOn(tiles as unknown as WithColors, 'transcriptColors');
    return { tiles, getTranscriptTile, getTranscriptBins, colors };
  }

  it('shows every transcript when the view really is under budget', async () => {
    const { tiles, getTranscriptBins } = setup(100, 'cellType');
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect(getTranscriptBins).not.toHaveBeenCalled();
    expect((tiles as unknown as { drawn: { kind: string } }).drawn.kind).toBe('individual');
    tiles.detach();
  });

  it('groups a view denser than the estimate instead of cutting transcripts off', async () => {
    const { tiles, getTranscriptBins } = setup(5000, 'cellType'); // over 1.5 × the budget
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect(getTranscriptBins).toHaveBeenCalled();
    expect((tiles as unknown as { drawn: { kind: string } }).drawn.kind).toBe('bins');
    tiles.detach();
  });

  it('colours mixed-gene bins by cell type even when gene colouring is chosen', async () => {
    const { tiles, colors } = setup(5000, 'gene');
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect((colors.mock.calls[0][1] as { transcriptColorBy: string }).transcriptColorBy).toBe('cellType');
    tiles.detach();
  });

  it('keeps gene colouring for individual transcripts, which carry their gene', async () => {
    const { tiles, colors } = setup(100, 'gene');
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect((colors.mock.calls[0][1] as { transcriptColorBy: string }).transcriptColorBy).toBe('gene');
    tiles.detach();
  });
});
