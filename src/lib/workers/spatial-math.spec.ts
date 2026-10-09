import { SpatialObservations } from '../contracts/spatial-dataset.contract';
import { rasterizeDensity } from '../spatial/spatial-density';
import { expressionField, expressionVolume } from '../spatial/spatial-expression';
import { heatmapMatrix } from '../spatial/spatial-heatmap';
import { Supersede } from '../util/supersede';
import {
  SpatialMathMessage, SpatialMathReply, resultTransferables, runSpatialMath, slimObservations,
} from './spatial-math-ops';
import {
  SpatialMathClient, computeExpressionFieldAsync, computeExpressionVolumeAsync,
  computeHeatmapMatrixAsync, rasterizeDensityAsync,
} from './spatial-math';

const pts: [number, number, number][] = [[1, 1, 0], [1, 2, 0], [5, 5, 1], [6, 5, 1], [2, 6, 2]];
const obs: SpatialObservations = {
  count: pts.length,
  x: Float32Array.from(pts, (p) => p[0]),
  y: Float32Array.from(pts, (p) => p[1]),
  z: Float32Array.from(pts, (p) => p[2]),
  ids: pts.map((_, i) => `cell-${i}`),
} as SpatialObservations;
const values = Float32Array.from([1, 2, 3, 4, 5]);
const grid = { width: 8, height: 8, depth: 3, voxelSize: [1, 1, 1] as [number, number, number] };
const fieldOpts = { width: 8, height: 8, step: 1, sigma: 0.5, values };

/**
 * A stand-in Web Worker that runs the real dispatcher, asynchronously, like the bundled
 * `spatial-math.worker` does — so the client's protocol is exercised end to end.
 */
class FakeWorker {
  onmessage: ((e: MessageEvent<SpatialMathReply>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readonly posted: SpatialMathMessage[] = [];
  terminated = false;
  /** When set, the next message is held until {@link release} is called. */
  hold = false;
  private held: (() => void)[] = [];

  postMessage(msg: SpatialMathMessage): void {
    this.posted.push(msg);
    const answer = () => {
      if (this.terminated) return;
      let reply: SpatialMathReply;
      try {
        reply = { id: msg.id, ok: true, result: runSpatialMath(msg) };
      } catch (err) {
        reply = { id: msg.id, ok: false, error: (err as Error).message };
      }
      this.onmessage?.({ data: reply } as MessageEvent<SpatialMathReply>);
    };
    if (this.hold) this.held.push(answer);
    else setTimeout(answer, 0);
  }

  release(): void {
    for (const answer of this.held.splice(0)) answer();
  }

  crash(): void {
    this.onerror?.(new Event('error'));
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('spatial-math', () => {
  describe('runSpatialMath (what the worker runs)', () => {
    it('gives exactly what the synchronous functions give', () => {
      expect(runSpatialMath({ op: 'expressionField', obs, opts: fieldOpts }))
        .toEqual(expressionField(obs, fieldOpts));
      const volOpts = { sigma: [0.5, 0.5, 0.5] as [number, number, number], values, interpolate: true };
      expect(runSpatialMath({ op: 'expressionVolume', obs, grid, opts: volOpts }))
        .toEqual(expressionVolume(obs, grid, volOpts));
      const densOpts = { sigma: [0.5, 0.5, 0.5] as [number, number, number] };
      expect(runSpatialMath({ op: 'rasterizeDensity', obs, grid, opts: densOpts }))
        .toEqual(rasterizeDensity(obs, grid, densOpts));
      const genes = [{ name: 'A', values }];
      const groups = { codes: Uint16Array.from([0, 0, 1, 1, 1]), categories: ['g0', 'g1'] };
      expect(runSpatialMath({ op: 'heatmapMatrix', genes, groups, opts: { minCells: 1 } }))
        .toEqual(heatmapMatrix(genes, groups, { minCells: 1 }));
    });

    it('rejects an unknown op', () => {
      expect(() => runSpatialMath({ op: 'nope' } as never)).toThrow('unknown spatial-math op');
    });

    it('sends only the coordinates, never the per-observation ids', () => {
      const slim = slimObservations(obs);
      expect(Object.keys(slim).sort()).toEqual(['count', 'x', 'y', 'z']);
      expect(slim.x).toBe(obs.x);
    });

    it('lists each result buffer once for transfer', () => {
      const f = expressionField(obs, fieldOpts)!;
      expect(resultTransferables(f)).toEqual([f.mean.buffer, f.support.buffer]);
      const shared = new Float32Array(4);
      expect(resultTransferables({ a: shared, b: shared.subarray(1) })).toEqual([shared.buffer]);
      expect(resultTransferables(null)).toEqual([]);
    });
  });

  describe('without Web Workers (jsdom)', () => {
    it('computes on the main thread with the same answer', async () => {
      expect(typeof Worker).toBe('undefined');
      expect(await computeExpressionFieldAsync(obs, fieldOpts, { minObservations: 0 }))
        .toEqual(expressionField(obs, fieldOpts));
      const volOpts = { sigma: [0.5, 0.5, 0.5] as [number, number, number], values };
      expect(await computeExpressionVolumeAsync(obs, grid, volOpts, { minObservations: 0 }))
        .toEqual(expressionVolume(obs, grid, volOpts));
      expect(await rasterizeDensityAsync(obs, grid, { sigma: [1, 1, 1] }))
        .toEqual(rasterizeDensity(obs, grid, { sigma: [1, 1, 1] }));
      const groups = { codes: Uint16Array.from([0, 0, 1, 1, 1]), categories: ['g0', 'g1'] };
      expect(await computeHeatmapMatrixAsync([{ name: 'A', values }], groups, { minCells: 1 }))
        .toEqual(heatmapMatrix([{ name: 'A', values }], groups, { minCells: 1 }));
    });

    it('rejects a call whose signal has already fired', async () => {
      const load = new Supersede();
      const task = load.next();
      load.cancel();
      await expect(computeExpressionFieldAsync(obs, fieldOpts, { signal: task.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('SpatialMathClient with a worker', () => {
    let worker: FakeWorker;
    let client: SpatialMathClient;
    let factory: jest.Mock;

    beforeEach(() => {
      worker = new FakeWorker();
      factory = jest.fn(() => worker as unknown as Worker);
      client = new SpatialMathClient(factory);
    });

    it('runs a large call in the worker, sending slim observations', async () => {
      const result = await client.run(
        { op: 'expressionField', obs: slimObservations(obs), opts: fieldOpts }, 5, { minObservations: 1 },
      );
      expect(result).toEqual(expressionField(obs, fieldOpts));
      expect(worker.posted).toHaveLength(1);
      expect(worker.posted[0]).toMatchObject({ op: 'expressionField', id: 1 });
      expect((worker.posted[0] as { obs: object }).obs).not.toHaveProperty('ids');
    });

    it('keeps a call below the threshold on the main thread, without starting a worker', async () => {
      await client.run({ op: 'expressionField', obs, opts: fieldOpts }, 5, { minObservations: 6 });
      expect(factory).not.toHaveBeenCalled();
    });

    it('starts one worker and reuses it', async () => {
      const req = { op: 'expressionField' as const, obs, opts: fieldOpts };
      await Promise.all([client.run(req, 5, { minObservations: 0 }), client.run(req, 5, { minObservations: 0 })]);
      await client.run(req, 5, { minObservations: 0 });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(worker.posted.map((m) => m.id)).toEqual([1, 2, 3]);
    });

    it('rejects a failed computation with its message', async () => {
      await expect(client.run({ op: 'nope' } as never, 5, { minObservations: 0 }))
        .rejects.toThrow('unknown spatial-math op');
    });

    it('aborts a superseded call and stops the worker it alone was using', async () => {
      worker.hold = true;
      const load = new Supersede();
      const first = load.next();
      const call = client.run({ op: 'expressionField', obs, opts: fieldOpts }, 5,
        { minObservations: 0, signal: first.signal });
      await Promise.resolve(); await Promise.resolve();
      expect(worker.posted).toHaveLength(1);

      load.next(); // a newer request supersedes the first
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(worker.terminated).toBe(true);

      // The next call starts a fresh worker.
      const next = new FakeWorker();
      factory.mockReturnValueOnce(next as unknown as Worker);
      await expect(client.run({ op: 'expressionField', obs, opts: fieldOpts }, 5, { minObservations: 0 }))
        .resolves.toEqual(expressionField(obs, fieldOpts));
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('keeps the worker alive for other calls when one is aborted', async () => {
      worker.hold = true;
      const controller = new AbortController();
      const req = { op: 'expressionField' as const, obs, opts: fieldOpts };
      const aborted = client.run(req, 5, { minObservations: 0, signal: controller.signal });
      const kept = client.run(req, 5, { minObservations: 0 });
      await Promise.resolve(); await Promise.resolve();
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
      expect(worker.terminated).toBe(false);
      worker.release();
      await expect(kept).resolves.toEqual(expressionField(obs, fieldOpts));
    });

    it('answers in-flight and later calls on the main thread when the worker crashes', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      worker.hold = true;
      const req = { op: 'expressionField' as const, obs, opts: fieldOpts };
      const inFlight = client.run(req, 5, { minObservations: 0 });
      await Promise.resolve(); await Promise.resolve();
      worker.crash();
      await expect(inFlight).resolves.toEqual(expressionField(obs, fieldOpts));
      await expect(client.run(req, 5, { minObservations: 0 })).resolves.toEqual(expressionField(obs, fieldOpts));
      expect(factory).toHaveBeenCalledTimes(1);
      expect(worker.terminated).toBe(true);
    });

    it('falls back to the main thread when the worker cannot be created', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      factory.mockImplementationOnce(() => { throw new Error('no workers here'); });
      await expect(client.run({ op: 'expressionField', obs, opts: fieldOpts }, 5, { minObservations: 0 }))
        .resolves.toEqual(expressionField(obs, fieldOpts));
    });

    it('rejects calls in flight on dispose and terminates the worker', async () => {
      worker.hold = true;
      const call = client.run({ op: 'expressionField', obs, opts: fieldOpts }, 5, { minObservations: 0 });
      await Promise.resolve(); await Promise.resolve();
      client.dispose();
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(worker.terminated).toBe(true);
    });
  });
});
