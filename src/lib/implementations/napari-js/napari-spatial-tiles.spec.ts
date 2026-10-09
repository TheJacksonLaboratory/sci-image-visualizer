import type { Viewer } from 'napari-js';
import { DEFAULT_SPATIAL_VIEW } from '../../contracts/display-types';
import type { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import {
  NO_OBSERVATION, SpatialDataset, SpatialDensityRaster, SpatialPolygonTile, SpatialTranscriptTile,
} from '../../contracts/spatial-dataset.contract';
import { emptySelection } from '../../spatial/spatial-selection';
import {
  NapariSpatialTileLayers, SpatialTileHost, clusterMarkers, mergePolygonTiles, mergeTranscriptTiles, pickNearest,
} from './napari-spatial-tiles';

/** A minimal valid continuous LUT: napari-js's colormapFromLut rejects fewer than two rows. */
const LUT: [number, number, number][] = [[0, 0, 0], [255, 255, 255]];

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
      continuousLut: () => LUT,
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
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 4; j++) await Promise.resolve();
      jest.advanceTimersByTime(ms / 40);
    }
    for (let i = 0; i < 40; i++) await Promise.resolve();
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
      canvasSize: () => [400, 400], continuousLut: () => LUT, polygonsShownChanged: () => undefined,
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

describe('NapariSpatialTileLayers: per-gene counts in view', () => {
  it('counts each gene\'s transcripts inside the view, weighting aggregates', () => {
    const tiles = new NapariSpatialTileLayers({} as SpatialDataPort, {
      latest: () => null, canvasSize: () => [0, 0], continuousLut: () => LUT,
      polygonsShownChanged: () => undefined,
    });
    expect(tiles.geneCountsIn({ x0: 0, y0: 0, x1: 10, y1: 10 })).toBeNull();
    (tiles as unknown as { countSource: unknown }).countSource = {
      genes: ['CD163', 'MRC1', 'CHIT1'],
      merged: {
        count: 4, aggregated: true,
        x: new Float32Array([1, 2, 50, 3]), y: new Float32Array([1, 2, 50, 3]), z: new Float32Array(4),
        weight: new Uint32Array([5, 1, 9, 2]), observation: new Uint32Array(4),
        gene: new Uint16Array([0, 1, 0, 0]),
      },
    };
    // The third entry is outside the view; CHIT1 has none in view.
    expect(tiles.geneCountsIn({ x0: 0, y0: 0, x1: 10, y1: 10 })).toEqual({ CD163: 7, MRC1: 1, CHIT1: 0 });
  });
});

describe('NapariSpatialTileLayers: a gene selection follows the zoom', () => {
  function setup(zoom: number, mode: 'circles' | 'glyphs' = 'circles', clusters = 1, budget = 100_000) {
    const n = 400;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) { x[i] = (i % 20) * 0.5; y[i] = Math.floor(i / 20) * 0.5; }
    // With several clusters, transcript i belongs to gene i % clusters, each gene its own cluster.
    const gene = Uint16Array.from({ length: n }, (_v, i) => i % clusters);
    const tile: SpatialTranscriptTile = {
      count: n, aggregated: false, x, y, z: new Float32Array(n),
      weight: new Uint32Array(n).fill(1), observation: new Uint32Array(n), gene,
    };
    const port = { getTranscriptTile: jest.fn(async () => tile) } as unknown as SpatialDataPort;
    const dataset = {
      id: 'd', name: 'd', columns: [],
      observations: { count: 1, x: new Float32Array([5]), y: new Float32Array([5]) },
      transcriptTiles: { bounds: [0, 0, 100, 100], count: n, levels: [{ tileSize: 200 }] },
      transcriptBins: {
        bounds: [0, 0, 100, 100], origin: [0, 0], count: n,
        levels: [1, 2, 4, 8].map((k) => ({ binSize: k, tileSize: 200 })),
      },
    } as unknown as SpatialDataset;
    const view = {
      ...DEFAULT_SPATIAL_VIEW, transcriptMode: mode,
      transcriptGenes: Array.from({ length: clusters }, (_v, i) => `G${i}`),
      transcriptGeneGroups: Array.from({ length: clusters }, (_v, i) => ({ name: `Cluster ${i}`, genes: [`G${i}`] })),
      transcriptBudget: budget,
    };
    const items: unknown[] = [];
    const viewer = {
      camera: { center: [5, 5], zoom, changed: { connect: () => () => undefined } },
      layers: { items, add: (l: unknown) => items.push(l), remove: () => undefined },
      addPoints: jest.fn(() => { const l = {}; items.push(l); return l; }),
      addShapes: jest.fn(() => ({})), addImage: jest.fn(() => ({})), requestRender: () => undefined,
    } as unknown as Viewer;
    const tiles = new NapariSpatialTileLayers(port, {
      latest: () => [dataset, view, emptySelection(1)],
      canvasSize: () => [400, 400], continuousLut: () => LUT, polygonsShownChanged: () => undefined,
    });
    tiles.attach(viewer);
    return tiles;
  }
  const drawn = (t: NapariSpatialTileLayers) =>
    (t as unknown as { drawn: { kind: string; bin?: { size: number }; merged: SpatialTranscriptTile } }).drawn;

  it('groups each gene into the pyramid bin the zoom calls for', async () => {
    const tiles = setup(2); // 2 px per unit: the 8-unit bin is the first 14 px apart
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect(drawn(tiles).kind).toBe('genes');
    expect(drawn(tiles).bin?.size).toBe(8);
    expect(drawn(tiles).merged.count).toBeLessThan(400);
    expect(drawn(tiles).merged.aggregated).toBe(true);
    tiles.detach();
  });

  it('groups the same way when transcripts are drawn as icons', async () => {
    const tiles = setup(2, 'glyphs');
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect(drawn(tiles).bin?.size).toBe(8);
    expect(drawn(tiles).merged.count).toBeLessThan(400);
    tiles.detach();
  });

  it('keeps to the max: over it, one larger marker per cluster per area, named for the hover', async () => {
    // Zoomed in (individual transcripts would do), but 400 transcripts against a max of 50.
    const tiles = setup(20, 'glyphs', 4, 50);
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    const d = drawn(tiles) as unknown as {
      bin?: { size: number }; merged: SpatialTranscriptTile; entryGroup: Int32Array; groupNames: string[];
    };
    expect(d.bin).toBeDefined();
    expect(d.merged.count).toBeLessThanOrEqual(50);
    expect(new Set(d.entryGroup).size).toBe(4);
    expect(d.groupNames[d.entryGroup[0]]).toMatch(/^Cluster /);
    expect(Array.from(d.merged.weight).reduce((a, b) => a + b, 0)).toBe(400); // nothing dropped
    tiles.detach();
  });

  it('draws every transcript once the finest bin is wide on screen', async () => {
    const tiles = setup(20); // the 1-unit bin is 20 px
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect(drawn(tiles).bin).toBeUndefined();
    expect(drawn(tiles).merged.count).toBe(400);
    tiles.detach();
  });
});

describe('clusterMarkers (a zoomed-out selection, from density grids)', () => {
  it('sums each cluster\'s grid cells per square, at their count-weighted centre', () => {
    const raster = (values: number[]): SpatialDensityRaster => ({
      meta: { gridSize: [10, 10], origin: [0, 0], rows: 2, cols: 2 }, genes: [], values: Float32Array.from(values),
    });
    // One 20-unit square holds all four cells. Cluster 0 is mostly in the top-left cell.
    const { tile, group } = clusterMarkers([raster([3, 1, 0, 0]), raster([0, 0, 0, 2])], [5, 7], 20,
      { x0: 0, y0: 0, x1: 20, y1: 20 });
    expect(tile.count).toBe(2);
    expect(Array.from(group)).toEqual([0, 1]);
    expect(Array.from(tile.weight)).toEqual([4, 2]);
    expect(tile.x[0]).toBeCloseTo((3 * 5 + 1 * 15) / 4); // pulled toward the busier cell
    expect(tile.x[1]).toBeCloseTo(15);
    expect(Array.from(tile.gene)).toEqual([5, 7]); // each cluster's icon gene
    expect(tile.observation[0]).toBe(NO_OBSERVATION);
  });
});

describe('NapariSpatialTileLayers: a gene selection from the per-gene pyramid levels', () => {
  function setup(zoom: number, budget: number, quality: 'high' | 'all' = 'high') {
    // Two genes, one cluster, spread over a 100 × 100 area; each level's tile holds its bins.
    const getTranscriptGeneBins = jest.fn(async (level: number) => {
      const bin = 2 ** level;
      const xs: number[] = [];
      const ys: number[] = [];
      const genes: number[] = [];
      for (let y = 0; y < 100; y += bin) {
        for (let x = 0; x < 100; x += bin) {
          for (const g of [0, 1]) { xs.push(x + bin / 2); ys.push(y + bin / 2); genes.push(g); }
        }
      }
      const n = xs.length;
      return {
        count: n, aggregated: true, x: Float32Array.from(xs), y: Float32Array.from(ys), z: new Float32Array(n),
        weight: new Uint32Array(n).fill(bin * bin), observation: new Uint32Array(n).fill(3),
        gene: Uint16Array.from(genes),
      } as SpatialTranscriptTile;
    });
    const getTranscriptTile = jest.fn(async () => ({
      count: 0, aggregated: false, x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0),
      weight: new Uint32Array(0), observation: new Uint32Array(0), gene: new Uint16Array(0),
    } as SpatialTranscriptTile));
    const port = { getTranscriptGeneBins, ...(quality === 'all' ? { getTranscriptTile } : {}) } as unknown as SpatialDataPort;
    const dataset = {
      id: 'd', name: 'd', columns: [],
      observations: { count: 1, x: new Float32Array([5]), y: new Float32Array([5]) },
      transcriptTiles: { bounds: [0, 0, 100, 100], count: 1, levels: [{ tileSize: 1000 }] },
      transcriptBins: { bounds: [0, 0, 100, 100], origin: [0, 0], count: 1,
        levels: [1, 2, 4, 8, 16].map((k) => ({ binSize: k, tileSize: 1000 })) },
      transcriptGeneBins: {
        origin: [0, 0], levels: [1, 2, 4, 8, 16].map((k) => ({ binSize: k, tileSize: 1000 })),
      },
    } as unknown as SpatialDataset;
    const view = {
      ...DEFAULT_SPATIAL_VIEW, transcriptMode: 'glyphs' as const, transcriptGenes: ['A', 'B'],
      transcriptGeneGroups: [{ name: 'Cluster 1', genes: ['A', 'B'] }], transcriptBudget: budget,
      transcriptQuality: quality,
    };
    const items: unknown[] = [];
    const viewer = {
      camera: { center: [50, 50], zoom, changed: { connect: () => () => undefined } },
      layers: { items, add: (l: unknown) => items.push(l), remove: () => undefined },
      addPoints: jest.fn(() => ({})), addShapes: jest.fn(() => ({})), addImage: jest.fn(() => ({})),
      requestRender: () => undefined,
    } as unknown as Viewer;
    const tiles = new NapariSpatialTileLayers(port, {
      latest: () => [dataset, view, emptySelection(1)],
      canvasSize: () => [400, 400], continuousLut: () => LUT, polygonsShownChanged: () => undefined,
    });
    tiles.attach(viewer);
    return { tiles, getTranscriptGeneBins, getTranscriptTile };
  }
  type Drawn = { bin?: { size: number }; merged: SpatialTranscriptTile; entryGroup: Int32Array };
  const drawn = (t: NapariSpatialTileLayers) => (t as unknown as { drawn: Drawn }).drawn;

  it('reads the level the zoom calls for, one marker per cluster per bin, cells kept', async () => {
    const { tiles, getTranscriptGeneBins } = setup(4, 100_000); // 4 px per unit: 4-unit bins
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect(getTranscriptGeneBins.mock.calls[0][0]).toBe(2); // level of the 4-unit bins
    expect(drawn(tiles).bin?.size).toBe(4);
    expect(drawn(tiles).merged.count).toBe(25 * 25); // the two genes merged per bin
    expect(drawn(tiles).merged.observation[0]).toBe(3);
    tiles.detach();
  });

  it('with low-quality calls included, reads the quality-aware tiles instead (the levels hold high only)', async () => {
    const { tiles, getTranscriptGeneBins, getTranscriptTile } = setup(4, 100_000, 'all');
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect(getTranscriptGeneBins).not.toHaveBeenCalled();
    expect(getTranscriptTile).toHaveBeenCalledWith(0, 0, 0, { genes: ['A', 'B'], quality: 'all' });
    tiles.detach();
  });

  it('keeps each dataset\'s density grids apart, though their genes and bins match', async () => {
    const { tiles } = setup(4, 100_000);
    const getDensity = jest.fn(async () => ({}));
    (tiles as unknown as { port: unknown }).port = { getDensity };
    const densityFor = (id: string) =>
      (tiles as unknown as { densityFor(d: string, g: string[], b: number): Promise<unknown> }).densityFor(id, ['A'], 8);
    await densityFor('one');
    await densityFor('two');
    await densityFor('one');
    expect(getDensity).toHaveBeenCalledTimes(2);
    tiles.detach();
  });

  it('steps to coarser levels until the markers fit the max', async () => {
    const { tiles, getTranscriptGeneBins } = setup(4, 50);
    await (tiles as unknown as { plan(): Promise<void> }).plan();
    expect([...new Set(getTranscriptGeneBins.mock.calls.map((c) => c[0]))]).toEqual([2, 3, 4]);
    expect(drawn(tiles).bin?.size).toBe(16);
    expect(drawn(tiles).merged.count).toBeLessThanOrEqual(50);
    tiles.detach();
  });
});

describe('NapariSpatialTileLayers: colouring transcripts by cluster', () => {
  const tile = (genes: number[]): SpatialTranscriptTile => {
    const n = genes.length;
    return {
      count: n, aggregated: false, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
      weight: new Uint32Array(n).fill(1), observation: new Uint32Array(n), gene: Uint16Array.from(genes),
    };
  };
  type Colors = (d: unknown, v: unknown, t: SpatialTranscriptTile, c?: (i: number) => string | null) =>
    Promise<{ rgba: number[][] }>;

  it('gives a cluster one colour, the colour of the cell group of the same name', async () => {
    const meta = { kind: 'categorical', name: 'graphclust', categories: ['Cluster 1', 'Cluster 2'],
      colors: ['#ff0000', '#00ff00'] };
    const port = {
      getColumn: async () => ({ meta, codes: new Uint16Array(1) }),
    } as unknown as SpatialDataPort;
    const tiles = new NapariSpatialTileLayers(port, {
      latest: () => null, canvasSize: () => [0, 0], continuousLut: () => LUT,
      polygonsShownChanged: () => undefined,
    });
    const dataset = { id: 'd', columns: [meta] } as unknown as SpatialDataset;
    const view = { ...DEFAULT_SPATIAL_VIEW, transcriptColorBy: 'cluster' as const, cellTypeColumn: 'graphclust' };
    const clusters = ['Cluster 2', 'Cluster 2', 'Cluster 1', 'Mine'];
    const colors = (tiles as unknown as { transcriptColors: Colors }).transcriptColors.bind(tiles);
    const { rgba } = await colors(dataset, view, tile([0, 1, 2, 3]), (i) => clusters[i]);
    expect(rgba[0]).toEqual(rgba[1]);           // genes 0 and 1: one cluster, one colour
    expect(rgba[0]).toEqual([0, 1, 0, 1]);      // Cluster 2's cells are green
    expect(rgba[2]).toEqual([1, 0, 0, 1]);      // Cluster 1's are red
    expect(rgba[3]).not.toEqual(rgba[0]);       // a cluster no cell group names: a palette colour
  });
});

describe('NapariSpatialTileLayers: reporting loads for the canvas badge', () => {
  it('reports "Transcripts" while a selection loads, and nothing once it is drawn', async () => {
    const reports: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const tile: SpatialTranscriptTile = {
      count: 1, aggregated: false, x: Float32Array.of(5), y: Float32Array.of(5), z: new Float32Array(1),
      weight: Uint32Array.of(1), observation: new Uint32Array(1), gene: new Uint16Array(1),
    };
    const port = { getTranscriptTile: async () => { await gate; return tile; } } as unknown as SpatialDataPort;
    const dataset = {
      id: 'd', name: 'd', columns: [], observations: { count: 1, x: Float32Array.of(5), y: Float32Array.of(5) },
      transcriptTiles: { bounds: [0, 0, 100, 100], count: 1, levels: [{ tileSize: 200 }] },
    } as unknown as SpatialDataset;
    const view = { ...DEFAULT_SPATIAL_VIEW, transcriptMode: 'circles' as const, transcriptGenes: ['A'] };
    const viewer = {
      camera: { center: [50, 50], zoom: 40, changed: { connect: () => () => undefined } },
      layers: { items: [] as unknown[], add: () => undefined, remove: () => undefined },
      addPoints: jest.fn(() => ({})), addShapes: jest.fn(() => ({})), addImage: jest.fn(() => ({})),
      requestRender: () => undefined,
    } as unknown as Viewer;
    const tiles = new NapariSpatialTileLayers(port, {
      latest: () => [dataset, view, emptySelection(1)], canvasSize: () => [400, 400], continuousLut: () => LUT,
      polygonsShownChanged: () => undefined, loadingChanged: (l) => reports.push(l),
    });
    tiles.attach(viewer);
    const planned = (tiles as unknown as { plan(): Promise<void> }).plan();
    await Promise.resolve();
    expect(reports.at(-1)).toEqual(['Transcripts']);
    release();
    await planned;
    expect(reports.at(-1)).toEqual([]);
    tiles.detach();
  });
});
