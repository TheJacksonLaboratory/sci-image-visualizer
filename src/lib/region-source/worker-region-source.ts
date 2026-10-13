/**
 * A {@link RegionSource} over a GeoJSON string, parsed and tiled in the region-source Web Worker.
 *
 * One worker serves every open source. Where no worker can start (jsdom, SSR, a blocked worker
 * URL) the same tables run on the main thread; if the worker dies, each source re-opens itself
 * there from its text (which the host holds anyway: it handed it over) and carries on.
 */
import { RegionSource, RegionTileCache, SourceFeature, abortable } from './region-source';
import {
  RegionSourceMessage,
  RegionSourceReply,
  RegionSourceRequest,
  RegionSourceResults,
  RegionSourceTables,
} from './region-source-ops';
import type {
  RegionIndexPage,
  RegionIndexQuery,
  RegionSourceInfo,
  RegionTile,
  RegionTileKey,
} from './region-tiles';

/** Makes the worker; may be async, as the default one is (it imports the factory on demand). */
export type RegionSourceWorkerFactory = () => Worker | Promise<Worker>;

/** The worker died under a call; the caller re-opens on the main thread. */
class WorkerLostError extends Error {
  constructor() {
    super('The region-source worker stopped.');
    this.name = 'WorkerLostError';
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Owns the region-source worker and the calls in flight on it. */
export class RegionSourceWorkerClient {
  private worker: Worker | null = null;
  private starting: Promise<Worker | null> | null = null;
  private unavailable = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  /** The main-thread tables, once anything runs here. */
  private local: RegionSourceTables | null = null;

  /**
   * `factory` is optional: without one the real worker module is imported on demand —
   * dynamically, because it holds an `import.meta.url` that ts-jest's CommonJS compile
   * rejects.
   */
  constructor(private readonly factory?: RegionSourceWorkerFactory) {}

  /** Whether calls now run on the main thread. */
  get inThread(): boolean {
    return this.unavailable;
  }

  /** Run `request` in the worker, or here when there is none. */
  async call<R extends RegionSourceRequest>(request: R): Promise<RegionSourceResults[R['op']]> {
    const worker = await this.ensureWorker();
    if (!worker) return (this.local ??= new RegionSourceTables()).run(request);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...request, id } as RegionSourceMessage);
    });
  }

  /** Terminate the worker; calls in flight reject. */
  dispose(): void {
    this.lose();
  }

  private ensureWorker(): Promise<Worker | null> {
    if (this.worker) return Promise.resolve(this.worker);
    if (this.unavailable || (!this.factory && typeof Worker === 'undefined')) {
      this.unavailable = true;
      return Promise.resolve(null);
    }
    if (!this.starting) {
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
        : import('./region-source-worker').then((m) => m.createRegionSourceWorker());
      const worker = made instanceof Promise ? await made : made;
      worker.onmessage = (event: MessageEvent<RegionSourceReply>) => this.onReply(event.data);
      worker.onerror = (event: Event) => {
        event.preventDefault?.();
        if (worker === this.worker) {
          console.warn('[region-source] worker failed; tiling on the main thread');
          this.lose();
        }
      };
      this.worker = worker;
      return worker;
    } catch (err) {
      console.warn('[region-source] worker unavailable; tiling on the main thread', err);
      this.unavailable = true;
      return null;
    }
  }

  private onReply(reply: RegionSourceReply): void {
    const call = this.pending.get(reply.id);
    if (!call) return;
    this.pending.delete(reply.id);
    if (reply.ok) call.resolve(reply.result);
    else call.reject(new Error(reply.error));
  }

  /** Stop the worker for good: every later call runs here, every call in flight is lost. */
  private lose(): void {
    this.unavailable = true;
    this.worker?.terminate();
    this.worker = null;
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) call.reject(new WorkerLostError());
  }
}

let shared: RegionSourceWorkerClient | null = null;

/** The worker client every GeoJSON source shares. */
export function sharedRegionSourceClient(): RegionSourceWorkerClient {
  return (shared ??= new RegionSourceWorkerClient());
}

/**
 * Open a GeoJSON FeatureCollection string as a tiled region source. Rejects on invalid JSON or
 * a collection without `features`.
 */
export async function openGeoJsonRegionSource(
  text: string,
  client: RegionSourceWorkerClient = sharedRegionSourceClient(),
): Promise<RegionSource> {
  const { handle, info } = await client.call({ op: 'open', text });
  return new WorkerRegionSource(client, text, handle, info);
}

class WorkerRegionSource implements RegionSource {
  private readonly cache = new RegionTileCache();
  private disposed = false;
  /** The main-thread re-open after the worker died, shared by the calls it interrupted. */
  private reopening: Promise<number> | null = null;

  constructor(
    private readonly client: RegionSourceWorkerClient,
    private readonly text: string,
    private handle: number,
    readonly info: RegionSourceInfo,
  ) {}

  getTile(z: number, key: RegionTileKey, signal?: AbortSignal): Promise<RegionTile> {
    const tile = this.cache.get(z, key, () =>
      this.call((handle) => ({ op: 'tile', handle, z, level: key.level, gx: key.gx, gy: key.gy })),
    );
    return abortable(tile, signal);
  }

  getFeatures(ids: readonly string[]): Promise<SourceFeature[]> {
    return this.call((handle) => ({ op: 'features', handle, ids }));
  }

  getIndex(z: number, query: RegionIndexQuery): Promise<RegionIndexPage> {
    return this.call((handle) => ({ op: 'index', handle, z, query }));
  }

  exportGeoJson(exclude: readonly string[], extra: readonly object[]): Promise<string> {
    return this.call((handle) => ({ op: 'export', handle, exclude, extra }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
    void this.client.call({ op: 'close', handle: this.handle }).catch(() => undefined);
  }

  /** Run a request on this source's table; when the worker died, re-open here and retry. */
  private async call<R extends RegionSourceRequest>(
    make: (handle: number) => R,
  ): Promise<RegionSourceResults[R['op']]> {
    const lost = this.handle;
    try {
      return await this.client.call(make(lost));
    } catch (err) {
      if (!(err instanceof WorkerLostError)) throw err;
      if (this.handle === lost) {
        this.reopening ??= this.client.call({ op: 'open', text: this.text }).then(({ handle }) => {
          this.handle = handle;
          this.reopening = null;
          return handle;
        });
        await this.reopening;
      }
      return this.client.call(make(this.handle));
    }
  }
}
