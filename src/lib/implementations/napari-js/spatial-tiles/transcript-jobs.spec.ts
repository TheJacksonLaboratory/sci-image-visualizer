import { DEFAULT_SPATIAL_VIEW } from '../../../contracts/display-types';
import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialDataset, SpatialTranscriptTile } from '../../../contracts/spatial-dataset.contract';
import { LoadTracker, PlanContext } from './plan-context';
import { TranscriptJobPlanner } from './transcript-jobs';

describe('TranscriptJobPlanner', () => {
  const tile = (n: number): SpatialTranscriptTile => ({
    count: n, aggregated: false, x: new Float32Array(n).fill(5), y: new Float32Array(n).fill(5),
    z: new Float32Array(n), weight: new Uint32Array(n).fill(1), observation: new Uint32Array(n),
    gene: new Uint16Array(n),
  });
  const dataset = (total: number) => ({
    id: 'd', name: 'd', columns: [],
    transcriptTiles: { bounds: [0, 0, 100, 100], count: total, levels: [{ tileSize: 200 }] },
    transcriptBins: {
      bounds: [0, 0, 100, 100], origin: [0, 0], count: total, levels: [{ binSize: 25, tileSize: 200 }],
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

  it('keys a gene selection so a small pan is a no-op and a new gene is not', () => {
    const jobs = new TranscriptJobPlanner(port);
    const key = (r: typeof rect, v = view) => jobs.jobFor(dataset(10), v, r, 4)!.key;
    expect(key({ x0: 1, y0: 1, x1: 101, y1: 101 })).toBe(key(rect));
    expect(key(rect, { ...view, transcriptGenes: ['A', 'B'] })).not.toBe(key(rect));
  });
});
