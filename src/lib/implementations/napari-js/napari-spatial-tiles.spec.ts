import { Viewer } from 'napari-js';
import { DEFAULT_SPATIAL_VIEW } from '../../contracts/display-types';
import type { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import {
  SpatialDataset, SpatialPolygonTile, SpatialTranscriptTile,
} from '../../contracts/spatial-dataset.contract';
import { emptySelection } from '../../spatial/spatial-selection';
import { NapariSpatialTileLayers, SpatialTileHost, pickNearest } from './napari-spatial-tiles';

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

  it('keeps a density grid that is still in use when the cache is full (LRU, not FIFO)', async () => {
    const { tiles } = setup(4, 100_000);
    const getDensity = jest.fn(async () => ({}));
    (tiles as unknown as { port: unknown }).port = { getDensity };
    const densityFor = (gene: string) =>
      (tiles as unknown as { densityFor(d: string, g: string[], b: number): Promise<unknown> })
        .densityFor('d', [gene], 8);
    await densityFor('first');
    for (let i = 0; i < 300; i++) {
      await densityFor(`g${i}`);
      await densityFor('first'); // in view the whole time
    }
    expect(getDensity.mock.calls.filter((c) => (c as unknown[])[0]?.toString() === 'first')).toHaveLength(1);
    tiles.detach();
  });

  it('asks again for a density grid whose request failed', async () => {
    const { tiles } = setup(4, 100_000);
    const getDensity = jest.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue({});
    (tiles as unknown as { port: unknown }).port = { getDensity };
    const densityFor = () =>
      (tiles as unknown as { densityFor(d: string, g: string[], b: number): Promise<unknown> })
        .densityFor('d', ['A'], 8);
    await expect(densityFor()).rejects.toThrow('HTTP 503');
    await densityFor();
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

/**
 * A column, feature-vector or density request that fails must not escape `plan()`: it was an
 * unhandled rejection that also skipped the bounded retry, so one transient error left the
 * cells stale until the camera moved (review NAPARI-BOUNDARY-8).
 */
describe('NapariSpatialTileLayers: a column request that fails', () => {
  const ring = (): SpatialPolygonTile => ({
    count: 1, coords: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
    offsets: new Uint32Array([0, 4]), observation: new Uint32Array([0]),
  });
  const meta = { kind: 'categorical', name: 'cluster', categories: ['A'] };

  function setup() {
    let columnCalls = 0;
    const getColumn = jest.fn(async () => {
      if (++columnCalls === 1) throw new Error('HTTP 503');
      return { meta, codes: new Uint16Array(1) };
    });
    const port = { getPolygonTile: jest.fn(async () => ring()), getColumn } as unknown as SpatialDataPort;
    const dataset = {
      id: 'd', name: 'd', columns: [meta],
      observations: { count: 1, x: new Float32Array([5]), y: new Float32Array([5]), radius: 5 },
      polygonTiles: {
        bounds: [0, 0, 100, 100], sets: [{ name: 'cell', label: 'Cell' }], defaultSet: 'cell',
        levels: [{ tileSize: 200 }],
      },
    } as unknown as SpatialDataset;
    const geneCounts = jest.fn();
    const host: SpatialTileHost = {
      latest: () => [dataset, DEFAULT_SPATIAL_VIEW, emptySelection(1)],
      canvasSize: () => [400, 400], continuousLut: () => LUT, polygonsShownChanged: () => undefined,
      geneCountsChanged: geneCounts,
    };
    const viewer = new Viewer({ canvas: document.createElement('canvas') });
    viewer.camera.set([50, 50], 4);
    const tiles = new NapariSpatialTileLayers(port, host);
    tiles.attach(viewer);
    return { tiles, viewer, getColumn, geneCounts };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves the plan, still reports the counts, and retries the view', async () => {
    const { tiles, viewer, getColumn, geneCounts } = setup();
    await expect((tiles as unknown as { plan(): Promise<void> }).plan()).resolves.toBeUndefined();
    expect(getColumn).toHaveBeenCalledTimes(1);
    expect(geneCounts).toHaveBeenCalled();
    // The bounded retry runs and draws the cells this time.
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 4; j++) await Promise.resolve();
      jest.advanceTimersByTime(50);
    }
    expect(getColumn).toHaveBeenCalledTimes(2);
    expect(viewer.layers.items.some((l) => tiles.owns(l))).toBe(true);
    tiles.detach();
  });
});

/**
 * Whether a plan is complete belongs to that plan: a tile of a superseded plan that fails
 * while a newer plan runs must not stop the newer one caching its (complete) tiles, nor
 * schedule a retry of it (review NAPARI-BOUNDARY-9).
 */
describe('NapariSpatialTileLayers: overlapping plans', () => {
  const ring = (): SpatialPolygonTile => ({
    count: 1, coords: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
    offsets: new Uint32Array([0, 4]), observation: new Uint32Array([0]),
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a stale plan\'s failed tile does not mark the current plan incomplete', async () => {
    const pending: { resolve(t: SpatialPolygonTile): void; reject(e: Error): void }[] = [];
    const getPolygonTile = jest.fn(() => new Promise<SpatialPolygonTile>((resolve, reject) => {
      pending.push({ resolve, reject });
    }));
    const dataset = {
      id: 'd', name: 'd', columns: [],
      observations: { count: 1, x: new Float32Array([5]), y: new Float32Array([5]), radius: 5 },
      polygonTiles: {
        bounds: [0, 0, 100, 100], sets: [{ name: 'cell', label: 'Cell' }], defaultSet: 'cell',
        levels: [{ tileSize: 200 }],
      },
    } as unknown as SpatialDataset;
    const view = { ...DEFAULT_SPATIAL_VIEW, cellColorMode: 'single' as const };
    const tiles = new NapariSpatialTileLayers({ getPolygonTile } as unknown as SpatialDataPort, {
      latest: () => [dataset, view, emptySelection(1)],
      canvasSize: () => [400, 400], continuousLut: () => LUT, polygonsShownChanged: () => undefined,
    });
    const viewer = new Viewer({ canvas: document.createElement('canvas') });
    viewer.camera.set([50, 50], 4);
    tiles.attach(viewer);
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const plan = () => (tiles as unknown as { plan(): Promise<void> }).plan();

    const stale = plan();
    await flush();
    const current = plan(); // supersedes the first
    await flush();
    expect(pending).toHaveLength(2);
    pending[0].reject(new Error('tile server hiccup')); // the stale plan's tile fails…
    await stale;
    pending[1].resolve(ring()); // …and the current plan's tile arrives
    await current;

    jest.advanceTimersByTime(10_000); // no retry is scheduled…
    await flush();
    expect(getPolygonTile).toHaveBeenCalledTimes(2);
    // …because it was cached as complete.
    expect((tiles as unknown as { cellGeometryKey: string | null }).cellGeometryKey).not.toBeNull();
    tiles.detach();
  });
});

/**
 * napari-js 0.14's LayerList cannot move a layer, so order is restored by remove + re-add,
 * and every removal disposes the layer's GPU visual (re-uploaded on the next frame). A plan
 * that replaces several groups restores the order ONCE, instead of re-adding the groups above
 * each replaced one every time (review NAPARI-BOUNDARY-11).
 */
describe('NapariSpatialTileLayers: layer order', () => {
  const ring = (): SpatialPolygonTile => ({
    count: 1, coords: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
    offsets: new Uint32Array([0, 4]), observation: new Uint32Array([0]),
  });
  const transcripts: SpatialTranscriptTile = {
    count: 1, aggregated: false, x: Float32Array.of(5), y: Float32Array.of(5), z: new Float32Array(1),
    weight: Uint32Array.of(1), observation: new Uint32Array(1), gene: new Uint16Array(1),
  };

  function setup() {
    const port = {
      getPolygonTile: jest.fn(async () => ring()),
      getTranscriptTile: jest.fn(async () => transcripts),
    } as unknown as SpatialDataPort;
    const dataset = {
      id: 'd', name: 'd', columns: [],
      observations: { count: 1, x: Float32Array.of(5), y: Float32Array.of(5), radius: 5 },
      polygonTiles: {
        bounds: [0, 0, 100, 100], sets: [{ name: 'cell', label: 'Cell' }, { name: 'nucleus', label: 'Nucleus' }],
        defaultSet: 'cell', levels: [{ tileSize: 200 }],
      },
      transcriptTiles: { bounds: [0, 0, 100, 100], count: 1, levels: [{ tileSize: 200 }] },
    } as unknown as SpatialDataset;
    let view = {
      ...DEFAULT_SPATIAL_VIEW, cellColorMode: 'single' as const, cellDraw: 'both' as const,
      cellSet: 'cell', transcriptMode: 'circles' as const, transcriptGenes: ['A'],
    };
    const tiles = new NapariSpatialTileLayers(port, {
      latest: () => [dataset, view, emptySelection(1)],
      canvasSize: () => [400, 400], continuousLut: () => LUT, polygonsShownChanged: () => undefined,
    });
    const viewer = new Viewer({ canvas: document.createElement('canvas') });
    viewer.camera.set([50, 50], 40);
    tiles.attach(viewer);
    const plan = () => (tiles as unknown as { plan(): Promise<void> }).plan();
    const setView = (patch: Partial<typeof view>) => { view = { ...view, ...patch }; };
    return { tiles, viewer, plan, setView };
  }
  const names = (viewer: Viewer) => viewer.layers.items.map((l) => l.name);

  it('re-adds the transcripts once when the cells are rebuilt under them', async () => {
    const { tiles, viewer, plan, setView } = setup();
    await plan();
    expect(names(viewer)).toEqual(['cells', 'cell outlines', 'transcripts']);
    const transcriptLayer = viewer.layers.items[2];
    const removals: unknown[] = [];
    viewer.layers.removed.connect((l) => removals.push(l));

    setView({ cellSet: 'nucleus' }); // new cell geometry; the transcripts are unchanged
    await plan();

    expect(names(viewer)).toEqual(['cells', 'cell outlines', 'transcripts']);
    expect(viewer.layers.items[2]).toBe(transcriptLayer);
    expect(removals.filter((l) => l === transcriptLayer)).toHaveLength(1);
    tiles.detach();
  });

  it('puts every overlay back above re-added markers, and leaves a correct order alone', async () => {
    const { tiles, viewer, plan } = setup();
    await plan();
    const before = [...viewer.layers.items];
    const removals: unknown[] = [];
    viewer.layers.removed.connect((l) => removals.push(l));
    tiles.afterObservations(); // nothing was added since: already in order
    expect(removals).toHaveLength(0);
    viewer.addPoints(new Float32Array(2), { name: 'markers' });
    tiles.afterObservations();
    expect(names(viewer)).toEqual(['markers', 'cells', 'cell outlines', 'transcripts']);
    expect(viewer.layers.items.slice(1)).toEqual(before);
    tiles.detach();
  });
});

/**
 * What hovering a transcript marker says, for each kind of marker the plan can draw: an
 * individual transcript of "all genes", an all-gene bin, a selected gene's transcript (alone
 * or aggregated), and a gene selection grouped by cluster. The server's details arrive once
 * the pointer rests on a marker, and are cached.
 */
describe('NapariSpatialTileLayers: hovering a transcript', () => {
  const meta = { kind: 'categorical', name: 'cluster', categories: ['T cell', 'B cell'] };
  const entries = (o: { x: number[]; weight?: number; gene?: number[]; aggregated?: boolean }) => {
    const n = o.x.length;
    return {
      count: n, aggregated: !!o.aggregated, x: Float32Array.from(o.x), y: new Float32Array(n).fill(5),
      z: new Float32Array(n), weight: new Uint32Array(n).fill(o.weight ?? 1),
      observation: Uint32Array.from({ length: n }, (_v, i) => i),
      gene: o.gene ? Uint16Array.from(o.gene) : new Uint16Array(n),
    } as SpatialTranscriptTile;
  };

  function setup(o: {
    view: Partial<typeof DEFAULT_SPATIAL_VIEW>; zoom: number; tile: SpatialTranscriptTile;
    bins?: SpatialTranscriptTile; allGenes?: boolean; summary?: boolean;
  }) {
    const getTranscriptSummary = jest.fn(async () => ({
      transcripts: 4, genes: 3, cells: 1, unassigned: 0,
      topGenes: [{ name: 'CD3E', count: 2 }, { name: 'MS4A1', count: 1 }],
      cellIds: { 0: 'cell-0' },
    }));
    const port = {
      getTranscriptTile: jest.fn(async () => o.tile),
      ...(o.bins ? { getTranscriptBins: jest.fn(async () => o.bins) } : {}),
      getColumn: jest.fn(async () => ({ meta, codes: Uint16Array.of(0, 1, 0, 1) })),
      ...(o.summary === false ? {} : { getTranscriptSummary }),
    } as unknown as SpatialDataPort;
    const dataset = {
      id: 'd', name: 'd', columns: [meta],
      observations: { count: 4, x: new Float32Array(4), y: new Float32Array(4) },
      transcriptTiles: { bounds: [0, 0, 100, 100], count: 10, levels: [{ tileSize: 200 }] },
      transcriptBins: {
        bounds: [0, 0, 100, 100], origin: [0, 0], count: 10,
        levels: (o.allGenes ? [25] : [1, 2, 4, 8]).map((k) => ({ binSize: k, tileSize: 200 })),
      },
    } as unknown as SpatialDataset;
    const view = { ...DEFAULT_SPATIAL_VIEW, transcriptMode: 'circles' as const, ...o.view };
    const items: unknown[] = [];
    const viewer = {
      camera: { center: [5, 5], zoom: o.zoom, changed: { connect: () => () => undefined } },
      layers: {
        items, add: (l: unknown) => items.push(l), remove: (l: unknown) => items.splice(items.indexOf(l), 1),
      },
      addPoints: jest.fn(() => { const l = {}; items.push(l); return l; }),
      addShapes: jest.fn(() => { const l = {}; items.push(l); return l; }),
      addImage: jest.fn(() => { const l = {}; items.push(l); return l; }),
      requestRender: () => undefined,
    } as unknown as Viewer;
    const tiles = new NapariSpatialTileLayers(port, {
      latest: () => [dataset, view, emptySelection(4)],
      canvasSize: () => [400, 400], continuousLut: () => LUT, polygonsShownChanged: () => undefined,
    });
    tiles.attach(viewer);
    const plan = () => (tiles as unknown as { plan(): Promise<void> }).plan();
    return { tiles, plan, getTranscriptSummary, items };
  }

  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('says nothing before anything is drawn, or away from every marker', async () => {
    const { tiles, plan } = setup({ view: { transcriptGenes: ['G0'] }, zoom: 20, tile: entries({ x: [5, 7] }) });
    expect(tiles.hoverAt(5, 5, 0.1, () => undefined)).toBeNull();
    await plan();
    expect(tiles.hoverAt(50, 50, 0.1, () => undefined)).toBeNull();
    tiles.detach();
  });

  it('names an individual transcript of every gene, then its gene and cell from the server', async () => {
    const { tiles, plan, getTranscriptSummary } = setup({
      view: { transcriptAllGenes: true, transcriptBudget: 1000 }, zoom: 4, allGenes: true,
      tile: entries({ x: [5, 7] }),
    });
    await plan();
    const details = jest.fn();
    expect(tiles.hoverAt(5, 5, 0.1, details)).toEqual(['Transcript', 'in cell #0 · T cell', 'loading details…']);
    jest.advanceTimersByTime(150);
    await flush();
    expect(getTranscriptSummary).toHaveBeenCalledWith({ box: [4.98, 4.98, 5.02, 5.02], cells: [0] });
    expect(details).toHaveBeenCalledWith(['CD3E transcript', 'in cell cell-0 · T cell']);
    // Cached: the next hover of the same marker answers at once.
    expect(tiles.hoverAt(5, 5, 0.1, details)).toEqual(['CD3E transcript', 'in cell cell-0 · T cell']);
    tiles.detach();
  });

  it('describes an all-gene bin by its count and area, then its genes and cells', async () => {
    const { tiles, plan, getTranscriptSummary } = setup({
      view: { transcriptAllGenes: true, transcriptBudget: 1000 }, zoom: 4, allGenes: true,
      tile: entries({ x: Array.from({ length: 5000 }, () => 5) }),
      bins: entries({ x: [5, 30], weight: 4, aggregated: true }),
    });
    await plan();
    const details = jest.fn();
    expect(tiles.hoverAt(5, 5, 0.1, details)).toEqual([
      '4 transcripts · all genes', '25.0 × 25.0 µm area', 'mostly cell #0 · T cell', 'loading details…',
    ]);
    jest.advanceTimersByTime(150);
    await flush();
    expect(getTranscriptSummary).toHaveBeenCalledWith({ box: [0, 0, 25, 25], cells: [0] });
    expect(details).toHaveBeenCalledWith([
      '4 transcripts · all genes', '25.0 × 25.0 µm area', '3 distinct genes · 1 cell',
      'top genes: CD3E 2, MS4A1 1', 'mostly cell cell-0 · T cell',
    ]);
    tiles.detach();
  });

  it('names a selected gene\'s transcript, alone or aggregated (the server adds only the cell id)', async () => {
    const one = setup({ view: { transcriptGenes: ['G0'] }, zoom: 20, tile: entries({ x: [5, 7] }) });
    await one.plan();
    expect(one.tiles.hoverAt(7, 5, 0.1, () => undefined)).toEqual(['G0 transcript', 'in cell #1 · B cell']);
    jest.advanceTimersByTime(150);
    await flush();
    expect(one.getTranscriptSummary).toHaveBeenCalledWith({ cells: [1] });
    one.tiles.detach();

    const many = setup({
      view: { transcriptGenes: ['G0'] }, zoom: 20, tile: entries({ x: [5, 7], weight: 3, aggregated: true }),
      summary: false,
    });
    await many.plan();
    expect(many.tiles.hoverAt(5, 5, 0.1, () => undefined))
      .toEqual(['G0 · 3 transcripts', 'grouped: zoom in to split', 'near cell #0 · T cell']);
    many.tiles.detach();
  });

  it('names a grouped selection marker by its cluster, area and dominant gene', async () => {
    // Zoomed out (2 px per unit): one marker per cluster per 8-unit bin.
    const { tiles, plan } = setup({
      view: { transcriptGenes: ['G0'], transcriptGeneGroups: [{ name: 'Cluster 0', genes: ['G0'] }] },
      zoom: 2, tile: entries({ x: [5, 6, 7] }), summary: false,
    });
    await plan();
    expect(tiles.hoverAt(6, 5, 0.1, () => undefined)).toEqual([
      'Cluster 0 · 3 transcripts', 'mostly G0', '8.0 × 8.0 µm area · zoom in to split', 'mostly cell #0 · T cell',
    ]);
    tiles.detach();
  });

  it('says nothing once the transcript layer is gone from the viewer', async () => {
    const { tiles, plan, items } = setup({ view: { transcriptGenes: ['G0'] }, zoom: 20, tile: entries({ x: [5] }) });
    await plan();
    expect(tiles.hoverAt(5, 5, 0.1, () => undefined)).not.toBeNull();
    items.length = 0;
    expect(tiles.hoverAt(5, 5, 0.1, () => undefined)).toBeNull();
    tiles.detach();
  });
});
