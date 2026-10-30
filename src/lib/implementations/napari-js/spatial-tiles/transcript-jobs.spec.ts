import { DEFAULT_SPATIAL_VIEW } from '../../../contracts/display-types';
import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialDataset, SpatialTranscriptTile } from '../../../contracts/spatial-dataset.contract';
import { LoadTracker, PlanContext } from './plan-context';
import { TranscriptJobPlanner } from './transcript-jobs';

describe('TranscriptJobPlanner', () => {
  const tile = (n: number): SpatialTranscriptTile => ({
    count: n,
    aggregated: false,
    x: new Float32Array(n).fill(5),
    y: new Float32Array(n).fill(5),
    z: new Float32Array(n),
    weight: new Uint32Array(n).fill(1),
    observation: new Uint32Array(n),
    gene: new Uint16Array(n),
  });
  const dataset = (total: number) =>
    ({
      id: 'd',
      name: 'd',
      columns: [],
      transcriptTiles: { bounds: [0, 0, 100, 100], count: total, levels: [{ tileSize: 200 }] },
      transcriptBins: {
        bounds: [0, 0, 100, 100],
        origin: [0, 0],
        count: total,
        levels: [{ binSize: 25, tileSize: 200 }],
      },
    }) as unknown as SpatialDataset;
  const port = {
    getTranscriptTile: jest.fn(async () => tile(3)),
    getTranscriptBins: jest.fn(async () => ({ ...tile(2), aggregated: true })),
  } as unknown as SpatialDataPort;
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const view = { ...DEFAULT_SPATIAL_VIEW, transcriptMode: 'circles' as const, transcriptGenes: ['A'] };
  const ctx = () => new PlanContext(() => false, new LoadTracker(() => undefined));

  it('plans nothing unless transcripts are drawn as markers the port can serve', () => {
    const jobs = new TranscriptJobPlanner(port);
    expect(jobs.jobFor(dataset(10), { ...view, transcriptMode: 'off' }, rect, 4)).toBeNull();
    expect(jobs.jobFor(dataset(10), { ...view, transcriptMode: 'density' }, rect, 4)).toBeNull();
    expect(new TranscriptJobPlanner({} as SpatialDataPort).jobFor(dataset(10), view, rect, 4)).toBeNull();
    expect(jobs.jobFor(dataset(10), { ...view, transcriptGenes: [] }, rect, 4)).toBeNull(); // nothing chosen
  });

  it('draws every gene individually while the view fits the budget, else as bins', async () => {
    const jobs = new TranscriptJobPlanner(port);
    const all = { ...view, transcriptAllGenes: true, transcriptBudget: 1000 };
    const sparse = jobs.jobFor(dataset(10), all, rect, 4)!;
    expect(sparse.kind).toBe('individual');
    expect((await sparse.load(ctx())).merged.count).toBe(3);
    const dense = jobs.jobFor(dataset(1e9), all, rect, 4)!;
    expect(dense.kind).toBe('bins');
    expect(dense.bin).toEqual({ size: 25, origin: [0, 0] });
    expect((await dense.load(ctx())).merged.aggregated).toBe(true);
  });

  it('plans nothing while "All genes" is switched off whole with the root eye', () => {
    const jobs = new TranscriptJobPlanner(port);
    const all = { ...view, transcriptAllGenes: true, transcriptBudget: 1000 };
    expect(jobs.jobFor(dataset(10), { ...all, transcriptAllGenesHidden: ['*'] }, rect, 4)).toBeNull();
    expect(jobs.jobFor(dataset(10), { ...all, transcriptAllGenesHidden: ['A'] }, rect, 4)).not.toBeNull();
    expect(jobs.jobFor(dataset(10), { ...all, transcriptAllGenesHidden: ['*', 'A'] }, rect, 4)).not.toBeNull();
  });

  it('keys a gene selection so a small pan is a no-op and a new gene is not', () => {
    const jobs = new TranscriptJobPlanner(port);
    const key = (r: typeof rect, v = view) => jobs.jobFor(dataset(10), v, r, 4)!.key;
    expect(key({ x0: 1, y0: 1, x1: 101, y1: 101 })).toBe(key(rect));
    expect(key(rect, { ...view, transcriptGenes: ['A', 'B'] })).not.toBe(key(rect));
  });

  describe('a gene selection zoomed out', () => {
    // Pans of a quarter view re-clip; smaller ones keep the job's key.
    const panned = (d: number) => ({ x0: d, y0: d, x1: 100 + d, y1: 100 + d });

    it('reads the per-gene pyramid levels, keyed by the clip window', async () => {
      const getTranscriptGeneBins = jest.fn(async () => tile(2));
      const jobs = new TranscriptJobPlanner({ ...port, getTranscriptGeneBins } as unknown as SpatialDataPort);
      const ds = {
        ...dataset(10),
        transcriptGeneBins: { origin: [0, 0], levels: [{ binSize: 25, tileSize: 200 }] },
      } as SpatialDataset;
      // 0.1 px per unit: zoomed out to the pyramid's bins.
      const job = (r: typeof rect) => jobs.jobFor(ds, view, r, 0.1)!;
      expect(job(rect).key).toMatch(/^gene-bins\|/);
      expect(job(panned(1)).key).toBe(job(rect).key);
      expect(job(panned(30)).key).not.toBe(job(rect).key);
      // The clip window reaches a quarter view past each edge: four 200-unit tiles of two each.
      expect((await job(rect).load(ctx())).merged.count).toBe(8);
      expect(getTranscriptGeneBins).toHaveBeenCalledTimes(4);
    });

    it('draws one marker per cluster per bin from the density grids, inside the clip window', async () => {
      // Grid cells of 20 units: one inside the view, one 90 units past its far edge.
      const values = new Float32Array(100);
      values[0] = 3;
      values[9] = 5;
      const getDensity = jest.fn(async () => ({
        meta: { gridSize: [20, 20], origin: [0, 0], rows: 10, cols: 10 },
        genes: ['A'],
        values,
      }));
      const jobs = new TranscriptJobPlanner({ ...port, getDensity } as unknown as SpatialDataPort);
      const ds = {
        ...dataset(10),
        density: { gridSize: [20, 20], origin: [0, 0], rows: 10, cols: 10 },
      } as SpatialDataset;
      // 0.1 px per unit: the 25-unit bins are as wide as the grid, so the grids serve.
      const job = (r: typeof rect) => jobs.jobFor(ds, view, r, 0.1)!;
      expect(job(rect).key).toMatch(/^clusters\|/);
      expect(job(panned(1)).key).toBe(job(rect).key);
      expect(job(panned(30)).key).not.toBe(job(rect).key);
      const loaded = await job(rect).load(ctx());
      expect(getDensity).toHaveBeenCalledWith(['A'], 20);
      expect(loaded.merged.count).toBe(1);
      expect(Array.from(loaded.merged.weight)).toEqual([3]);
      expect(loaded.clustered).toMatchObject({ names: ['A'], genes: [['A']], bin: 40 });
    });
  });
});
