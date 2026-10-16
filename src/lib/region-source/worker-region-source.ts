/**
 * A {@link RegionSource} over a GeoJSON string, parsed and tiled in the region-source Web Worker.
 *
 * One worker serves every open source. Where no worker can start (jsdom, SSR, a blocked worker
 * URL) the same tables run on the main thread; if the worker dies, each source re-opens itself
 * there from its text (which the host holds anyway: it handed it over) and carries on — whether
 * it had a call in flight then or not (see {@link RegionSourceWorkerClient.generation}).
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
  ClassOutlines,
  RegionIndexPage,
  RegionIndexQuery,
  RegionSourceInfo,
  RegionTile,
  RegionTileKey,
} from './region-tiles';
import type { ReconstructOptions, SliceOutlines } from '../geometry/reconstruct';
import type { Mesh } from 'napari-js/geometry';

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
  private tables = 0;

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

  /**
   * Which table set calls run on: bumped when the worker is lost. A handle opened under another
   * names a table that is gone (or, here, another source's), so its source must open again.
   */
  get generation(): number {
    return this.tables;
  }

  /** Run `request` in the worker, or here when there is none. */
  async call<R extends RegionSourceRequest>(request: R): Promise<RegionSourceResults[R['op']]> {
    return (await this.run(request)).result;
  }

  /** {@link call}, with the {@link generation} the request ran on. */
  async run<R extends RegionSourceRequest>(
    request: R,
  ): Promise<{ result: RegionSourceResults[R['op']]; generation: number }> {
    const started = await this.ensureWorker();
    // The worker may have been lost while this waited for it.
    const worker = started === this.worker ? started : null;
    const generation = this.tables;
    if (!worker) return { result: (this.local ??= new RegionSourceTables()).run(request), generation };
    const id = this.nextId++;
    const result = await new Promise<RegionSourceResults[R['op']]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...request, id } as RegionSourceMessage);
    });
    return { result, generation };
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
    if (this.worker) this.tables++;
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
  // The worker lost under the open: open on the main thread instead.
  const opened = await client
    .run({ op: 'open', text })
    .catch((err) => (err instanceof WorkerLostError ? client.run({ op: 'open', text }) : Promise.reject(err)));
  const { handle, info } = opened.result;
  return new WorkerRegionSource(client, text, handle, opened.generation, info);
}

/**
 * The 3D reconstruction of a region from its outlines on a stack (see `geometry/reconstruct`),
 * meshed in the region-source worker (on the main thread where there is none).
 */
export function reconstructInWorker(
  slices: readonly SliceOutlines[],
  options?: ReconstructOptions,
  client: RegionSourceWorkerClient = sharedRegionSourceClient(),
): Promise<Mesh> {
  return client.call({ op: 'mesh', slices, options });
}

class WorkerRegionSource implements RegionSource {
  private readonly cache = new RegionTileCache();
  private disposed = false;
  /** The main-thread re-open after the worker died, shared by every call that finds it so. */
  private reopening: Promise<void> | null = null;

  constructor(
    private readonly client: RegionSourceWorkerClient,
    private readonly text: string,
    private handle: number,
    /** The client's {@link RegionSourceWorkerClient.generation} {@link handle} was opened under. */
    private generation: number,
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

  getClassOutlines(
    classes: readonly string[] | null,
    level: number,
    exclude?: readonly string[],
  ): Promise<ClassOutlines[]> {
    return this.call((handle) => ({ op: 'outlines', handle, classes, level, exclude }));
  }

  getClassCounts(z: number | null, exclude?: readonly string[]): Promise<Record<string, number>> {
    return this.call((handle) => ({ op: 'classes', handle, z, exclude }));
  }

  exportGeoJson(exclude: readonly string[], extra: readonly object[]): Promise<string> {
    return this.call((handle) => ({ op: 'export', handle, exclude, extra }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache.clear();
    // A handle from a lost worker's tables names nothing here, or another source's table.
    if (this.generation !== this.client.generation) return;
    void this.client.call({ op: 'close', handle: this.handle }).catch(() => undefined);
  }

  /**
   * Run a request on this source's table; when the worker died (under this call or before it),
   * re-open here and run it there.
   */
  private async call<R extends RegionSourceRequest>(
    make: (handle: number) => R,
  ): Promise<RegionSourceResults[R['op']]> {
    for (let attempt = 0; ; attempt++) {
      if (this.generation !== this.client.generation) await this.reopen();
      try {
        return await this.client.call(make(this.handle));
      } catch (err) {
        if (!(err instanceof WorkerLostError) || attempt > 0) throw err;
      }
    }
  }

  /** Open this source's text again on the client's current tables, once for every call waiting. */
  private reopen(): Promise<void> {
    this.reopening ??= this.client
      .run({ op: 'open', text: this.text })
      .then(({ result, generation }) => {
        this.handle = result.handle;
        this.generation = generation;
      })
      .finally(() => (this.reopening = null));
    return this.reopening;
  }
}
