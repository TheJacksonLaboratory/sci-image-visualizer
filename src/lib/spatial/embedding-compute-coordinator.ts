import { BehaviorSubject } from 'rxjs';

import type { SpatialEmbedding, SpatialEmbeddingMeta } from '../contracts/spatial-dataset.contract';
import { ComputeProgress, EmbeddingComputeRun } from './embedding-compute';
import { Supersede } from '../util/supersede';

/** Where a browser-side embedding computation stands, for the progress bar and messages. */
export interface EmbeddingComputeState {
  /** True while a run is going. */
  running: boolean;
  /** 0..1 while running, or null before the first report. */
  fraction: number | null;
  /** Which backend the worker got — 'webgpu', 'wasm' or 'cpu'. */
  backend: string | null;
  message: string | null;
  error: string | null;
}

/** Where the PCA scores come from: a port that serves embeddings by name. */
export type EmbeddingSource = (name: string) => Promise<SpatialEmbedding>;

const IDLE: EmbeddingComputeState = { running: false, fraction: null, backend: null, message: null, error: null };

/**
 * Largest dataset a t-SNE is offered for in the browser.
 *
 * t-SNE is O(N²) per iteration — vectorised on the GPU, but not approximated — so the cost
 * is quadratic in observations. Measured end to end in Firefox on WebGPU: 2,688 points took
 * 95 s. That scales to roughly five and a half minutes at this threshold, and to about 76
 * minutes at seqFISH's 19,416, which was also measured offline.
 *
 * Past this the option is WITHDRAWN rather than offered with a warning. An hour-long job
 * started from a button is not a choice a reader can meaningfully consent to in a dialog,
 * and a t-SNE that large belongs in the offline pipeline, where it can run once and be
 * served to everyone.
 */
export const BROWSER_TSNE_MAX_OBSERVATIONS = 5000;

/** Measured anchor for the estimate: seconds for 2,688 points on WebGPU. */
const TSNE_SECONDS_AT = { seconds: 95, observations: 2688 };

/**
 * A t-SNE the dataset does not publish, offered so it can be computed here.
 *
 * A dropped-in `.h5ad` typically carries one UMAP and a PCA, and no t-SNE — the two views
 * answer different questions, so having only one is a real gap. Computing it needs no
 * expression data: t-SNE runs on the PCA scores, which is why this can happen in the
 * browser at all while PCA cannot.
 */
export const COMPUTABLE_EMBEDDINGS: readonly SpatialEmbeddingMeta[] = [
  { name: 'local:tsne', label: 't-SNE (compute)', dims: 2, derived: true },
  { name: 'local:tsne3d', label: 't-SNE 3D (compute)', dims: 3, derived: true },
];

/** The menu suffix that says a click will start work; not part of the name. */
const COMPUTE_SUFFIX = ' (compute)';

/** Roughly how long a t-SNE of `n` observations takes, in seconds, from the measured anchor. */
export function tsneEstimateSeconds(n: number): number {
  const { seconds, observations } = TSNE_SECONDS_AT;
  return Math.max(1, Math.round(seconds * (n / observations) ** 2));
}

/** A duration as something to put on a button: `~42s`, `~6 min`. */
export function estimateLabel(seconds: number): string {
  if (seconds < 90) return `~${seconds}s`;
  return `~${Math.round(seconds / 60)} min`;
}

/**
 * The browser-side embedding computation behind the charts' Embedding tab: which
 * embeddings to offer for a dataset, the t-SNE run itself (PCA scores from the port, then a
 * worker), its progress, and the results computed this session.
 *
 * A run is several awaits long — the PCA scores arrive over HTTP, then the worker takes a
 * minute or more — and the dataset can change at any of them, including before the run
 * exists to be terminated. Every await is checked against a {@link Supersede} that a
 * dataset switch ({@link setDataset}) or teardown ({@link abandon}) cancels, so the scores
 * fetched for one dataset are never embedded and drawn over another's observations.
 *
 * Plain class: the owner renders {@link state} (or {@link state$}).
 */
export class EmbeddingComputeCoordinator {
  readonly state$ = new BehaviorSubject<EmbeddingComputeState>(IDLE);

  /** True when a t-SNE is missing but the dataset is too big to embed here. */
  tooLarge = false;
  /** Observations in the live dataset, kept for the cost estimate. */
  observationCount = 0;

  /** Coordinates computed in this browser, by name. Not persisted: a reload recomputes. */
  private readonly computed = new Map<string, SpatialEmbedding>();
  /** The live run, when one is going. */
  private run: EmbeddingComputeRun | null = null;
  private readonly load = new Supersede();

  get state(): EmbeddingComputeState {
    return this.state$.value;
  }

  get running(): boolean {
    return !!this.run?.running;
  }

  /**
   * A new dataset: drop everything computed or computing for the previous one, and return
   * the embeddings to offer — the published ones, plus a t-SNE to compute where the dataset
   * has a PCA to embed, no t-SNE of its own, and is small enough. Otherwise the menu would
   * advertise work that cannot start, or duplicate what is already served.
   */
  setDataset(published: readonly SpatialEmbeddingMeta[], observationCount: number): SpatialEmbeddingMeta[] {
    this.computed.clear();
    this.abandon();
    const hasPca = published.some((e) => /pca/i.test(e.label ?? e.name));
    const hasTsne = published.some((e) => /tsne|t-sne/i.test(e.label ?? e.name));
    this.observationCount = observationCount;
    this.tooLarge = hasPca && !hasTsne && observationCount > BROWSER_TSNE_MAX_OBSERVATIONS;
    return hasPca && !hasTsne && !this.tooLarge ? [...published, ...COMPUTABLE_EMBEDDINGS] : [...published];
  }

  /** Whether `meta` is one this browser would have to compute. */
  isComputable(meta: SpatialEmbeddingMeta | null): boolean {
    return !!meta && meta.name.startsWith('local:');
  }

  /** Whether `meta` has already been computed this session. */
  isComputed(meta: SpatialEmbeddingMeta | null): boolean {
    return !!meta && this.computed.has(meta.name);
  }

  /** The coordinates computed for `name`, if any. */
  result(name: string): SpatialEmbedding | undefined {
    return this.computed.get(name);
  }

  /** Roughly how long a run would take here, in seconds. Shown before the click: a progress
   *  bar tells you a job is going; only an estimate tells you whether to start it. */
  get estimateSeconds(): number {
    return tsneEstimateSeconds(this.observationCount);
  }

  /** {@link estimateSeconds} as something to put on a button. */
  get estimateLabel(): string {
    return estimateLabel(this.estimateSeconds);
  }

  /** Why the option is absent, when a dataset is past the threshold. */
  get tooLargeNote(): string {
    return `t-SNE is not offered here for ${this.observationCount.toLocaleString()} observations — it is `
      + `quadratic, so it would take roughly ${this.estimateLabel} in the browser. `
      + 'Compute it offline and serve it with the dataset.';
  }

  /**
   * Compute `meta` here, in a worker, from the dataset's PCA among `embeddings`.
   *
   * The PCA scores come from the port as an ordinary embedding — the server derives them,
   * because PCA needs the whole expression matrix (185 MB for a Visium dataset) while
   * t-SNE needs only the scores (0.51 MB). Sending the matrix to the browser to save a few
   * seconds of arithmetic would be a far slower answer.
   *
   * @returns the coordinates, to draw — or null when there is nothing to draw: cancelled,
   *   abandoned, failed (see {@link state}), or already running.
   */
  async start(
    meta: SpatialEmbeddingMeta, embeddings: readonly SpatialEmbeddingMeta[], getEmbedding: EmbeddingSource,
  ): Promise<SpatialEmbedding | null> {
    if (this.running) return null;
    this.patch({ ...IDLE });

    // Every early return and every await below is checked against this. `run` is held
    // locally as well as on the instance: after an await `this.run` may already be a
    // newer run's, and clearing or terminating that one is how a fresh computation gets
    // killed by the tail of the one it replaced.
    const current = this.load.next();
    const superseded = () => !current();
    let run: EmbeddingComputeRun | null = null;

    try {
      // Prefer the 3-D scores: they carry a third component for free, and t-SNE on more
      // components than it needs is not better — the PCA basis is the input either way.
      const source = await loadPcaScores(embeddings, getEmbedding);
      if (superseded()) return null;
      if (!source) {
        this.patch({ error: 'This dataset serves no PCA to embed.' });
        return null;
      }
      run = new EmbeddingComputeRun();
      this.run = run;
      this.patch({ running: true });
      const result = await run.run(
        { scores: source.scores, nObs: source.nObs, nDims: source.nDims, dims: meta.dims },
        { ...meta, label: (meta.label ?? meta.name).replace(COMPUTE_SUFFIX, '') },
        (progress: ComputeProgress) => {
          // Progress from a superseded run must not drive the bar a newer one is using.
          if (superseded()) return;
          this.patch({
            fraction: progress.fraction,
            backend: progress.backend ?? this.state.backend,
            ...(progress.message ? { message: progress.message } : {}),
          });
        },
      );
      // A terminated run resolves null, so this covers abandonment as well as Cancel — but
      // the token is still checked, because the dataset can change between the worker's
      // `done` and this line.
      if (!result || superseded()) return null;
      this.computed.set(meta.name, result);
      return result;
    } catch (err) {
      if (!superseded()) this.patch({ error: (err as Error)?.message ?? String(err) });
      return null;
    } finally {
      run?.terminate();
      // Only if it is still ours: a dataset switch has already terminated this run and may
      // have started another, and clearing here would orphan it — leaving a worker nothing
      // can cancel and a Cancel button that does nothing.
      if (this.run === run) {
        this.run = null;
        this.patch({ running: false, fraction: null });
      }
    }
  }

  /** The user's Cancel: ask the worker to stop. The run settles shortly after, with nothing. */
  cancel(): void {
    this.run?.cancel();
  }

  /**
   * Drop any computation in progress, because what it is computing no longer applies.
   *
   * Distinct from {@link cancel}: this does not wait — the run is settled and the worker
   * killed, so a dataset switch or a teardown cannot leave a t-SNE grinding on in the
   * background over observations nothing is showing any more.
   */
  abandon(): void {
    this.load.cancel();
    this.run?.terminate();
    this.run = null;
    this.patch({ running: false, fraction: null, backend: null, message: null });
  }

  private patch(p: Partial<EmbeddingComputeState>): void {
    this.state$.next({ ...this.state$.value, ...p });
  }
}

/**
 * The dataset's PCA, as row-major scores.
 *
 * Assembled from whichever PCA the source offers, widest first — a 3-D one gives t-SNE
 * three components instead of two for the same request.
 */
export async function loadPcaScores(
  embeddings: readonly SpatialEmbeddingMeta[], getEmbedding: EmbeddingSource,
): Promise<{ scores: Float32Array; nObs: number; nDims: number } | null> {
  const candidates = embeddings
    .filter((e) => /pca/i.test(e.label ?? e.name) && !e.name.startsWith('local:'))
    .sort((a, b) => b.dims - a.dims);
  for (const candidate of candidates) {
    try {
      const pca = await getEmbedding(candidate.name);
      const planes = [pca.x, pca.y, ...(pca.z ? [pca.z] : [])];
      const nObs = pca.x.length;
      const nDims = planes.length;
      const scores = new Float32Array(nObs * nDims);
      for (let i = 0; i < nObs; i++) {
        for (let d = 0; d < nDims; d++) scores[i * nDims + d] = planes[d][i];
      }
      return { scores, nObs, nDims };
    } catch {
      // Try the next; a source may advertise one it cannot actually serve.
    }
  }
  return null;
}
