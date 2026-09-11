import { SpatialEmbedding, SpatialEmbeddingMeta } from '../contracts/spatial-dataset.contract';

/**
 * Run a t-SNE in a Web Worker and report progress.
 *
 * The panel offers this for a dataset that publishes no t-SNE — a dropped-in `.h5ad`
 * typically carries one UMAP and nothing else. The server reduces to PCA (it needs the
 * whole expression matrix, which the browser should not download); this takes those
 * scores and embeds them here, where the GPU is.
 *
 * A thin wrapper on purpose: no Angular, no store. It owns one worker and one run, so a
 * component can hold it, show a progress bar, and cancel — and so the whole thing can be
 * tested by substituting a worker.
 */

export interface ComputeProgress {
  /** 0..1, or null before the first report — a run starts with kNN and P, not iterations. */
  fraction: number | null;
  /** 'webgpu', 'wasm' or 'cpu' once known: it changes what a long wait means. */
  backend: string | null;
  message: string | null;
}

export interface ComputeRequest {
  /** PCA scores, row-major `nObs x nDims`. */
  scores: Float32Array;
  nObs: number;
  nDims: number;
  dims: 2 | 3;
  perplexity?: number;
  iterations?: number;
  seed?: number;
}

/** Factory, so a test can supply a worker without a bundler. */
export type WorkerFactory = () => Worker;

export class EmbeddingComputeRun {
  private worker: Worker | null = null;

  private settled = false;

  /**
   * Settles a run that is still waiting, set for as long as one is.
   *
   * `terminate()` is called from outside — a dataset switch, a component being destroyed —
   * and killing the worker on its own leaves the promise `run()` returned pending FOR
   * EVER, because the settlement it was waiting for arrives as a worker message. The
   * awaiting closure, and everything it captured, is retained with it. So termination
   * settles the run itself.
   */
  private abandon: (() => void) | null = null;

  /**
   * `factory` is optional: without one the real worker module is imported on demand.
   *
   * Dynamically, and that is not laziness for its own sake — the module holds an
   * `import.meta.url`, which ts-jest's CommonJS compile rejects outright, so a static
   * import here would break every spec that touches this file.
   */
  constructor(private readonly factory?: WorkerFactory) {}

  /**
   * Start a run. Resolves with the coordinates, or null if cancelled.
   *
   * Rejects only on a real failure. Cancellation is a NULL rather than a rejection: a user
   * pressing Cancel is not an error, and making callers tell the two apart in a catch
   * block is how a cancelled run ends up reported as a crash.
   */
  async run(
    request: ComputeRequest,
    meta: SpatialEmbeddingMeta,
    onProgress: (progress: ComputeProgress) => void,
  ): Promise<SpatialEmbedding | null> {
    if (this.worker) throw new Error('a computation is already running');
    const create = this.factory
      ?? (await import('./tsne-worker')).createTsneWorker;
    const worker = create();
    this.worker = worker;
    this.settled = false;

    const {
      scores, nObs, nDims, dims,
      perplexity = 30, iterations = 1000, seed = 0,
    } = request;
    let backend: string | null = null;

    return new Promise<SpatialEmbedding | null>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (this.settled) return;
        this.settled = true;
        // Cleared BEFORE terminating: `terminate()` calls it, and this is what keeps the
        // two from calling each other round in a circle.
        this.abandon = null;
        this.terminate();
        fn();
      };
      // An abandoned run resolves NULL, exactly as a cancelled one does. It is the same
      // event from the caller's side — the answer was no longer wanted — and rejecting
      // would make a routine dataset switch look like a failed computation.
      this.abandon = () => finish(() => resolve(null));

      worker.onmessage = (event: MessageEvent) => {
        const data = event.data ?? {};
        switch (data.type) {
          case 'backend':
            backend = data.backend;
            onProgress({ fraction: null, backend, message: null });
            break;
          case 'warning':
            onProgress({ fraction: null, backend, message: data.message });
            break;
          case 'progress':
            onProgress({ fraction: data.done / data.total, backend, message: null });
            break;
          case 'cancelled':
            finish(() => resolve(null));
            break;
          case 'done': {
            const flat = new Float32Array(data.embedding);
            // Struct of arrays, matching what the port serves, so the chart cannot tell a
            // locally-computed embedding from a fetched one.
            const planes: Float32Array[] = [];
            for (let d = 0; d < data.dims; d++) {
              const plane = new Float32Array(nObs);
              for (let i = 0; i < nObs; i++) plane[i] = flat[i * data.dims + d];
              planes.push(plane);
            }
            finish(() => resolve({
              meta: {
                ...meta,
                derived: true,
                params: `PCA(${nDims}) then t-SNE, perplexity ${data.perplexity}, `
                  + `${iterations} iterations, seed ${seed}`,
              },
              x: planes[0],
              y: planes[1],
              ...(planes[2] ? { z: planes[2] } : {}),
            }));
            break;
          }
          case 'error':
            finish(() => reject(new Error(data.message)));
            break;
          default:
            break;
        }
      };
      // A worker that dies takes the promise with it; without this the caller waits for
      // ever on a progress bar that has stopped moving.
      worker.onerror = (event) => finish(
        () => reject(new Error(`embedding worker failed: ${event.message ?? 'unknown'}`)),
      );

      // Copied, then transferred: the caller keeps its scores, and the worker gets the
      // buffer without a structured clone.
      const payload = scores.slice();
      worker.postMessage(
        {
          type: 'start',
          scores: payload.buffer,
          nObs,
          nDims,
          dims,
          perplexity,
          iterations,
          seed,
        },
        [payload.buffer],
      );
    });
  }

  /** Ask the run to stop. It resolves with null shortly after. */
  cancel(): void {
    this.worker?.postMessage({ type: 'cancel' });
  }

  /**
   * Stop immediately, abandoning any result. Safe to call twice.
   *
   * Unlike {@link cancel}, this does not wait for the worker to acknowledge — the run is
   * settled here, with null, because nothing is left to deliver the answer.
   */
  terminate(): void {
    const abandon = this.abandon;
    this.abandon = null;
    this.worker?.terminate();
    this.worker = null;
    abandon?.();
  }

  get running(): boolean {
    return this.worker !== null && !this.settled;
  }
}
