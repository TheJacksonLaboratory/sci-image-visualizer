import { EmbeddingComputeRun } from './embedding-compute';
import { SpatialEmbeddingMeta } from '../contracts/spatial-dataset.contract';

/**
 * The compute plumbing, driven through a fake worker.
 *
 * jsdom has no Worker and no GPU, and the algorithm is covered by `tsne.spec.ts`, so what
 * is worth testing here is the protocol: progress reaching the caller, cancellation
 * resolving rather than throwing, a dead worker not stranding the promise, and the result
 * arriving in the same shape the port serves.
 */

const META: SpatialEmbeddingMeta = { name: 'local:tsne', label: 't-SNE', dims: 2 };

/** A Worker stand-in whose messages the test drives by hand. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;

  onerror: ((e: { message?: string }) => void) | null = null;

  posted: unknown[] = [];

  terminated = false;

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Push a message as the worker would. */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function request(nObs = 4, nDims = 2) {
  return {
    scores: Float32Array.from({ length: nObs * nDims }, (_, i) => i),
    nObs,
    nDims,
    dims: 2 as const,
  };
}

/** A finished run's payload, laid out row-major as the worker sends it. */
function donePayload(nObs: number, dims: number) {
  const flat = new Float32Array(nObs * dims);
  for (let i = 0; i < flat.length; i++) flat[i] = i + 1;
  return { type: 'done', embedding: flat.buffer, dims, perplexity: 30, neighbours: 90 };
}

describe('EmbeddingComputeRun', () => {
  let fake: FakeWorker;
  let run: EmbeddingComputeRun;

  beforeEach(() => {
    fake = new FakeWorker();
    run = new EmbeddingComputeRun(() => fake as unknown as Worker);
  });

  it('sends the scores and the parameters to the worker', async () => {
    const promise = run.run(request(), META, () => undefined);
    await Promise.resolve();
    const sent = fake.posted[0] as Record<string, unknown>;
    expect(sent.type).toBe('start');
    expect(sent.nObs).toBe(4);
    expect(sent.dims).toBe(2);
    // Defaults have to travel: the worker cannot invent a perplexity that matches what
    // the caption will later claim.
    expect(sent.perplexity).toBe(30);
    expect(sent.iterations).toBe(1000);
    fake.emit(donePayload(4, 2));
    await promise;
  });

  it('reports progress, and the backend once it is known', async () => {
    const seen: Array<{ fraction: number | null; backend: string | null }> = [];
    const promise = run.run(request(), META, (p) => seen.push({ ...p }));
    await Promise.resolve();
    fake.emit({ type: 'backend', backend: 'webgpu' });
    fake.emit({ type: 'progress', done: 250, total: 1000 });
    fake.emit(donePayload(4, 2));
    await promise;
    expect(seen[0]).toEqual({ fraction: null, backend: 'webgpu', message: null });
    expect(seen[1].fraction).toBeCloseTo(0.25);
    // The backend persists across later reports; a progress bar that forgot it would
    // flicker between "on webgpu" and nothing.
    expect(seen[1].backend).toBe('webgpu');
  });

  it('returns planes, not the row-major buffer the worker sent', async () => {
    // The port serves struct-of-arrays, so a locally computed embedding has to match or
    // everything downstream needs to know where it came from.
    const promise = run.run(request(3), META, () => undefined);
    await Promise.resolve();
    fake.emit(donePayload(3, 2));
    const result = await promise;
    expect(Array.from(result!.x)).toEqual([1, 3, 5]);
    expect(Array.from(result!.y)).toEqual([2, 4, 6]);
    expect(result!.z).toBeUndefined();
    expect(result!.meta.derived).toBe(true);
    // The parameters travel with it: a derived embedding that cannot say how it was made
    // cannot be compared with anything.
    expect(result!.meta.params).toContain('perplexity 30');
  });

  it('carries a third plane for a 3-D run', async () => {
    const promise = run.run({ ...request(2), dims: 2 }, { ...META, dims: 3 }, () => undefined);
    await Promise.resolve();
    fake.emit(donePayload(2, 3));
    const result = await promise;
    expect(Array.from(result!.x)).toEqual([1, 4]);
    expect(Array.from(result!.z!)).toEqual([3, 6]);
  });

  it('resolves with null when cancelled, rather than rejecting', async () => {
    // A user pressing Cancel is not an error. Making callers separate the two in a catch
    // is how a cancelled run gets reported as a crash.
    const promise = run.run(request(), META, () => undefined);
    await Promise.resolve();
    run.cancel();
    expect(fake.posted[1]).toEqual({ type: 'cancel' });
    fake.emit({ type: 'cancelled' });
    await expect(promise).resolves.toBeNull();
  });

  it('rejects when the worker reports a failure', async () => {
    const promise = run.run(request(), META, () => undefined);
    await Promise.resolve();
    fake.emit({ type: 'error', message: 'no adapter' });
    await expect(promise).rejects.toThrow('no adapter');
  });

  it('rejects when the worker dies, instead of hanging', async () => {
    // Without an onerror the promise never settles and the progress bar sits still for
    // ever, which is indistinguishable from a slow run.
    const promise = run.run(request(), META, () => undefined);
    await Promise.resolve();
    fake.onerror?.({ message: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('terminates the worker once settled, and reports it is no longer running', async () => {
    const promise = run.run(request(), META, () => undefined);
    await Promise.resolve();
    expect(run.running).toBe(true);
    fake.emit(donePayload(4, 2));
    await promise;
    expect(fake.terminated).toBe(true);
    expect(run.running).toBe(false);
  });

  it('refuses a second run while one is going', async () => {
    const promise = run.run(request(), META, () => undefined);
    await Promise.resolve();
    await expect(run.run(request(), META, () => undefined)).rejects.toThrow(/already running/);
    fake.emit(donePayload(4, 2));
    await promise;
  });

  it('ignores messages arriving after it has settled', async () => {
    // A worker can post between `done` and `terminate`; a second resolve would be
    // harmless but a second reject would surface as an unhandled rejection.
    const promise = run.run(request(), META, () => undefined);
    await Promise.resolve();
    fake.emit(donePayload(4, 2));
    await promise;
    expect(() => fake.emit({ type: 'error', message: 'late' })).not.toThrow();
  });
});
