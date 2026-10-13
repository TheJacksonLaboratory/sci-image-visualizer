import type { SpatialObservations } from '../contracts/spatial-dataset.contract';
import type { DensityGrid, DensityOptions } from '../spatial/spatial-density';
import type {
  ExpressionField,
  ExpressionFieldOptions,
  ExpressionVolumeField,
  ExpressionVolumeOptions,
} from '../spatial/spatial-expression';
import type { HeatmapGene, HeatmapGroups, HeatmapMatrix, HeatmapMatrixOptions } from '../spatial/spatial-heatmap';
import {
  SpatialMathMessage,
  SpatialMathReply,
  SpatialMathRequest,
  SpatialMathResults,
  runSpatialMath,
  slimObservations,
} from './spatial-math-ops';

/**
 * Async, off-main-thread versions of the pure spatial field and density math
 * (`expressionField`, `expressionVolume`, `rasterizeDensity`, `heatmapMatrix`).
 *
 * Each call runs in `spatial-math.worker` when it is big enough to be worth posting, and
 * on the main thread otherwise — below {@link SPATIAL_MATH_WORKER_MIN_OBSERVATIONS}, where
 * Web Workers do not exist (jsdom, SSR), or when the worker fails to start. Same
 * function, same answer either way; only where it runs changes.
 *
 * Inputs are copied to the worker, never transferred: they are the dataset's own arrays,
 * which the caller keeps using. Results are transferred back.
 *
 * An `AbortSignal` (a `Supersede` task's, typically) rejects the call with an
 * `AbortError` as soon as it fires. When that leaves the worker with nothing else to do,
 * the worker is terminated so the abandoned computation stops using the CPU; the next
 * call starts a fresh one.
 */

/**
 * Below this many observations (genes × observations for a heatmap) a call runs on the
 * main thread: copying the inputs to a worker would cost about what it saves.
 */
export const SPATIAL_MATH_WORKER_MIN_OBSERVATIONS = 50_000;

/** Per-call options of the async spatial math. */
export interface SpatialMathCallOptions {
  /** Abandon the call: it rejects with an `AbortError` and its result is dropped. */
  signal?: AbortSignal;
  /** Override {@link SPATIAL_MATH_WORKER_MIN_OBSERVATIONS} for this call (0 forces the worker). */
  minObservations?: number;
}

/** Makes the worker; may be async, as the default one is (it imports the factory on demand). */
export type SpatialMathWorkerFactory = () => Worker | Promise<Worker>;

interface PendingCall {
  request: SpatialMathRequest;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('The computation was aborted.', 'AbortError');
  const err = new Error('The computation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Owns one spatial-math worker and the calls in flight on it. The module-level functions
 * share one instance; a test, or a caller that wants its own worker, makes another.
 */
export class SpatialMathClient {
  private worker: Worker | null = null;
  private starting: Promise<Worker | null> | null = null;
  /** Set once the worker failed to start or crashed: every later call runs here. */
  private unavailable = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  /**
   * `factory` is optional: without one the real worker module is imported on demand —
   * dynamically, because it holds an `import.meta.url` that ts-jest's CommonJS compile
   * rejects, so a static import would break every spec that reaches this file.
   */
  constructor(private readonly factory?: SpatialMathWorkerFactory) {}

  /** Run `request`, in the worker when `size` reaches the threshold and a worker can run. */
  async run<R extends SpatialMathRequest>(
    request: R,
    size: number,
    options: SpatialMathCallOptions = {},
  ): Promise<SpatialMathResults[R['op']]> {
    const { signal } = options;
    if (signal?.aborted) throw abortError();
    const threshold = options.minObservations ?? SPATIAL_MATH_WORKER_MIN_OBSERVATIONS;
    const worker = size >= threshold ? await this.ensureWorker() : null;
    if (signal?.aborted) throw abortError();
    if (!worker) return runSpatialMath(request);
    return this.post(worker, request, signal) as Promise<SpatialMathResults[R['op']]>;
  }

  /** Terminate the worker; calls still in flight reject with an `AbortError`. */
  dispose(): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    this.stopWorker();
    for (const call of calls) {
      call.detach();
      call.reject(abortError());
    }
  }

  private post(worker: Worker, request: SpatialMathRequest, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        reject(abortError());
        // Nothing else waits on the worker: stop the abandoned computation outright.
        if (this.pending.size === 0) this.stopWorker();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        request,
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      });
      worker.postMessage({ ...request, id } as SpatialMathMessage);
    });
  }

  private ensureWorker(): Promise<Worker | null> {
    if (this.worker) return Promise.resolve(this.worker);
    if (this.unavailable || (!this.factory && typeof Worker === 'undefined')) return Promise.resolve(null);
    if (!this.starting) {
      // Shared by the calls that arrive while the worker is being made, and cleared once it
      // settles (never by the start itself: a synchronous factory settles it at once).
      const starting = this.startWorker();
      this.starting = starting;
      void starting.then(() => {
        if (this.starting === starting) this.starting = null;
      });
    }
    return this.starting;
  }

  private async startWorker(): Promise<Worker | null> {
    try {
      const made = this.factory
        ? this.factory()
        : import('./spatial-math-worker').then((m) => m.createSpatialMathWorker());
      const worker = made instanceof Promise ? await made : made;
      worker.onmessage = (event: MessageEvent<SpatialMathReply>) => this.onReply(event.data);
      worker.onerror = (event: Event) => {
        event.preventDefault?.();
        this.onCrash(worker);
      };
      this.worker = worker;
      return worker;
    } catch (err) {
      console.warn('[spatial-math] worker unavailable; computing on the main thread', err);
      this.unavailable = true;
      return null;
    }
  }

  private onReply(reply: SpatialMathReply): void {
    const call = this.pending.get(reply.id);
    if (!call) return; // aborted while it ran
    this.pending.delete(reply.id);
    call.detach();
    if (reply.ok) call.resolve(reply.result);
    else call.reject(new Error(reply.error));
  }

  /** The worker died (failed to load, or threw outside a request): answer every call here. */
  private onCrash(worker: Worker): void {
    if (worker !== this.worker) return;
    console.warn('[spatial-math] worker failed; computing on the main thread');
    this.unavailable = true;
    this.stopWorker();
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      call.detach();
      try {
        call.resolve(runSpatialMath(call.request));
      } catch (err) {
        call.reject(err);
      }
    }
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

let shared: SpatialMathClient | null = null;
function sharedClient(): SpatialMathClient {
  return (shared ??= new SpatialMathClient());
}

/** Observations a computation covers: its `indices`, or every observation. */
function covered(indices: Uint32Array | undefined, count: number): number {
  return indices ? indices.length : count;
}

/** {@link expressionField}, off the main thread when it is big enough to matter. */
export function computeExpressionFieldAsync(
  obs: SpatialObservations,
  opts: ExpressionFieldOptions,
  options?: SpatialMathCallOptions,
): Promise<ExpressionField | null> {
  return sharedClient().run(
    { op: 'expressionField', obs: slimObservations(obs), opts },
    covered(opts.indices, obs.count),
    options,
  );
}

/** {@link expressionVolume}, off the main thread when it is big enough to matter. */
export function computeExpressionVolumeAsync(
  obs: SpatialObservations,
  grid: DensityGrid,
  opts: ExpressionVolumeOptions,
  options?: SpatialMathCallOptions,
): Promise<ExpressionVolumeField | null> {
  return sharedClient().run(
    { op: 'expressionVolume', obs: slimObservations(obs), grid, opts },
    covered(opts.indices, obs.count),
    options,
  );
}

/** {@link rasterizeDensity}, off the main thread when it is big enough to matter. */
export function rasterizeDensityAsync(
  obs: SpatialObservations,
  grid: DensityGrid,
  opts: DensityOptions,
  options?: SpatialMathCallOptions,
): Promise<Uint8Array | null> {
  return sharedClient().run(
    { op: 'rasterizeDensity', obs: slimObservations(obs), grid, opts },
    covered(opts.indices, obs.count),
    options,
  );
}

/** {@link heatmapMatrix}, off the main thread when it is big enough to matter. */
export function computeHeatmapMatrixAsync(
  genes: readonly HeatmapGene[],
  groups: HeatmapGroups,
  opts: HeatmapMatrixOptions = {},
  options?: SpatialMathCallOptions,
): Promise<HeatmapMatrix | null> {
  return sharedClient().run(
    { op: 'heatmapMatrix', genes, groups, opts },
    covered(opts.indices, groups.codes.length) * Math.max(1, genes.length),
    options,
  );
}
