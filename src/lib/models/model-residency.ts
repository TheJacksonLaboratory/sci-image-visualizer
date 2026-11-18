import { InjectionToken } from '@angular/core';

/**
 * One loaded in-browser model, as the residency registry sees it.
 *
 * The owner (the service that built the model) registers it once it is ready,
 * and implements {@link release} by dropping its own reference and disposing
 * the session/worker — so the next use rebuilds it. Rebuilding reads the model
 * bytes from the IndexedDB download cache; releasing never forces a re-download.
 */
export interface ResidentModel {
  /**
   * Stable, namespaced id — one per loaded checkpoint, e.g.
   * `'yolo:yolo-opticnerve'`, `'retinal:vnet-2d-retinal'`, `'sam:microsam-vit-b-lm'`.
   */
  readonly id: string;
  /**
   * Estimated loaded size in MB: tab RAM **plus** GPU memory once the model is
   * built — not the download size. See {@link estimateLoadedSizeMb}.
   */
  readonly loadedSizeMb: number;
  /** Free the model. Called only when no use of it is in flight. */
  release(): Promise<void> | void;
}

/** Default threshold: a model this large (or larger) is released when another model is used. */
export const DEFAULT_MODEL_RESIDENCY_THRESHOLD_MB = 1024;

/**
 * Keeps at most one *large* in-browser model loaded per tab.
 *
 * THE RULE (sci-image-visualizer#101)
 * - A model stays warm while it is the one being used: running it again does
 *   not rebuild it.
 * - Before a **different** model is used — any other id, including another
 *   checkpoint of the same tool — every other resident model whose
 *   {@link ResidentModel.loadedSizeMb} is at or above the threshold (1 GB by
 *   default) is released. This happens *before* the new model loads, so the
 *   tab never holds both.
 * - A use of the old model that is still running finishes first; it is never
 *   cancelled.
 * - Models below the threshold may stay warm alongside others.
 *
 * WHY
 * Loaded models dominate a tab's memory: measured in jit-ui, the retinal VNet
 * holds ~3.2 GB of tab RAM + ~2.8 GB of GPU memory, each YOLO checkpoint
 * ~0.7 GB + ~0.6 GB — against ~0.4 GB for the viewer itself. Before this, every
 * model stayed loaded for the life of the app.
 *
 * HOW OWNERS PARTICIPATE
 * - Wrap each use (load + run) in {@link use}: it releases the others first
 *   and records the use as in flight, so a later switch waits for it.
 * - Call {@link register} once the model is built, and {@link unregister} when
 *   the owner disposes it for its own reasons (model URL changed, teardown).
 * - Do not nest a `use()` of one model inside a `use()` of another: the inner
 *   switch would wait for the outer use and never finish.
 *
 * One instance per page ({@link modelResidency}), shared by every package
 * (SIV, jit-extensions, the host app) through {@link MODEL_RESIDENCY}.
 */
export class ModelResidency {
  private thresholdMb = DEFAULT_MODEL_RESIDENCY_THRESHOLD_MB;
  private readonly resident = new Map<string, ResidentModel>();
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>();
  /** Switches are serialised, so two concurrent activations cannot interleave releases. */
  private switching: Promise<void> = Promise.resolve();

  /** Change the size at or above which a model is released when another is used. */
  setThresholdMb(mb: number): void {
    if (!Number.isFinite(mb) || mb < 0) throw new Error(`Invalid residency threshold: ${mb}`);
    this.thresholdMb = mb;
  }

  getThresholdMb(): number {
    return this.thresholdMb;
  }

  /** Record a built model. Re-registering an id replaces the previous entry. */
  register(model: ResidentModel): void {
    this.resident.set(model.id, model);
  }

  /** Forget a model its owner disposed on its own. Safe for unknown ids. */
  unregister(id: string): void {
    this.resident.delete(id);
  }

  isResident(id: string): boolean {
    return this.resident.has(id);
  }

  /** Currently loaded models — for diagnostics and tests. */
  residentModels(): Array<{ id: string; loadedSizeMb: number }> {
    return [...this.resident.values()].map(({ id, loadedSizeMb }) => ({ id, loadedSizeMb }));
  }

  /**
   * Use model `id`: release every other large resident model (after their
   * in-flight uses finish), then run `fn` — which loads the model if needed
   * and runs it. The returned promise is `fn`'s.
   */
  async use<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    // The use is recorded INSIDE the serialised switch, so the next switch is
    // guaranteed to see it — even before this model has registered.
    await this.serialise(async () => {
      await this.releaseOthers(id);
      this.addInFlight(id, done);
    });
    try {
      return await fn();
    } finally {
      finish();
      this.removeInFlight(id, done);
    }
  }

  /**
   * Release every other large resident model, without recording a use. For
   * owners whose entry point loads a model that the caller then runs itself
   * (e.g. a `getModel()` handed to a pipeline engine) — prefer {@link use}.
   */
  activate(id: string): Promise<void> {
    return this.serialise(() => this.releaseOthers(id));
  }

  private serialise(step: () => Promise<void>): Promise<void> {
    const run = this.switching.then(step);
    this.switching = run.catch(() => undefined);
    return run;
  }

  private async releaseOthers(id: string): Promise<void> {
    // A model still being used but not yet registered has an unknown size:
    // wait for that use, then judge it once it has (or has not) registered.
    for (const [otherId, uses] of [...this.inFlight]) {
      if (otherId === id || this.resident.has(otherId)) continue;
      await Promise.allSettled([...uses]);
    }
    for (const [otherId, model] of [...this.resident]) {
      if (otherId === id || model.loadedSizeMb < this.thresholdMb) continue;
      // Let a running use of the old model finish; never cancel it.
      await Promise.allSettled([...(this.inFlight.get(otherId) ?? [])]);
      // Its owner may have disposed or replaced it while we waited.
      if (this.resident.get(otherId) !== model) continue;
      this.resident.delete(otherId);
      try {
        await model.release();
      } catch (err) {
        console.warn(`[model-residency] releasing ${otherId} failed`, err);
      }
    }
  }

  private addInFlight(id: string, use: Promise<void>): void {
    const uses = this.inFlight.get(id) ?? new Set<Promise<unknown>>();
    uses.add(use);
    this.inFlight.set(id, uses);
  }

  private removeInFlight(id: string, use: Promise<void>): void {
    const uses = this.inFlight.get(id);
    if (!uses) return;
    uses.delete(use);
    if (uses.size === 0) this.inFlight.delete(id);
  }
}

/** The page-wide registry. Plain code (tests, non-DI classes) can import it directly. */
export const modelResidency = new ModelResidency();

/** DI handle for {@link modelResidency}; override only in tests. */
export const MODEL_RESIDENCY = new InjectionToken<ModelResidency>('MODEL_RESIDENCY', {
  providedIn: 'root',
  factory: () => modelResidency,
});

/** Set the residency threshold for this page (default {@link DEFAULT_MODEL_RESIDENCY_THRESHOLD_MB}). */
export function setModelResidencyThresholdMb(mb: number): void {
  modelResidency.setThresholdMb(mb);
}

/**
 * Rough loaded size (tab RAM + GPU) from the download size, for models nobody
 * has measured yet.
 *
 * Calibrated on two measured models, both "fp16w" (fp16 weights, fp32 compute):
 * the 590 MB retinal VNet loads to ~6 GB and a 144 MB YOLO to ~1.3 GB — about
 * 9-10x, because ORT constant-folds the fp16 weights to fp32 and the bytes sit
 * in the WASM heap, the parsed graph and the GPU at once. Plain fp32/fp16
 * graphs skip the fold, so their factor is taken as 4x. Replace the estimate
 * with a measured `loadedSizeMb` wherever one exists.
 */
export function estimateLoadedSizeMb(downloadMb: number, opts: { fp16Weights?: boolean } = {}): number {
  return Math.round(downloadMb * (opts.fp16Weights ? 9 : 4));
}
