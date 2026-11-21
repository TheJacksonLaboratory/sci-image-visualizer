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
  /** Free the model. Called only when no use of it is in flight. */
  release(): Promise<void> | void;
}

/**
 * Keeps one in-browser model loaded per tab.
 *
 * THE RULE
 * - A model stays warm while it is the one being used: running it again does
 *   not rebuild it.
 * - Before a **different** model is used — any other id, including another
 *   checkpoint of the same tool — every other loaded model is released. This
 *   happens *before* the new model loads, so the tab never holds both.
 * - A use of the old model that is still running finishes first; it is never
 *   cancelled.
 * - Releasing frees memory only: the downloaded file stays in the IndexedDB
 *   cache, so using the model again rebuilds it from disk without a download.
 *
 * WHY
 * Loaded models dominate a tab's memory: measured in jit-ui, the retinal VNet
 * holds ~3.2 GB of tab RAM + ~2.8 GB of GPU memory, each YOLO checkpoint
 * ~0.7 GB + ~0.6 GB — against ~0.4 GB for the viewer itself.
 *
 * HOW OWNERS PARTICIPATE
 * - Wrap each use — loading as well as running — in {@link use} (or hold a
 *   {@link begin} lease across several steps): it releases the others first
 *   and records the use as in flight, so a later switch waits for it.
 * - Call {@link register} once the model is built, and {@link unregister} when
 *   the owner disposes it for its own reasons (model URL changed, teardown).
 * - A use of a model that is already in use joins it directly, without
 *   queueing behind a pending switch — so an owner's `getModel()` can be called
 *   from inside that owner's own `use()` without deadlocking.
 * - Do not nest a use of one model inside a use of a *different* model: the
 *   inner switch would wait for the outer use and never finish.
 *
 * One instance per page ({@link modelResidency}), shared by every package
 * (SIV, jit-extensions, the host app) through {@link MODEL_RESIDENCY}.
 */
export class ModelResidency {
  private readonly resident = new Map<string, ResidentModel>();
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>();
  /** Switches are serialised, so two concurrent activations cannot interleave releases. */
  private switching: Promise<void> = Promise.resolve();

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

  /** Ids of the loaded models — for diagnostics and tests. */
  residentIds(): string[] {
    return [...this.resident.keys()];
  }

  /**
   * Use model `id`: release every other loaded model (after their in-flight
   * uses finish), then run `fn` — which loads the model if needed and runs it.
   * The returned promise is `fn`'s.
   */
  async use<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const end = await this.begin(id);
    try {
      return await fn();
    } finally {
      end();
    }
  }

  /**
   * Start a use of model `id` that spans several steps (e.g. acquire a session,
   * encode, then decode repeatedly); call the returned function once, when the
   * last step is done. Same switch semantics as {@link use}.
   */
  async begin(id: string): Promise<() => void> {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    if (this.inFlight.has(id)) {
      // Already in use, so the switch to it has happened: join directly. A
      // pending switch away from it drains every use (this one included)
      // before releasing it.
      this.addInFlight(id, done);
    } else {
      // Recorded INSIDE the serialised switch, so the next switch is
      // guaranteed to see it — even before this model has registered.
      await this.serialise(async () => {
        await this.releaseOthers(id);
        this.addInFlight(id, done);
      });
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      finish();
      this.removeInFlight(id, done);
    };
  }

  private serialise(step: () => Promise<void>): Promise<void> {
    const run = this.switching.then(step);
    this.switching = run.catch(() => undefined);
    return run;
  }

  private async releaseOthers(id: string): Promise<void> {
    // Let every running use of another model finish — including one still
    // loading (not yet registered), and uses that join while we wait; never
    // cancel them. Then release every other model that registered.
    for (const otherId of [...this.inFlight.keys()]) {
      if (otherId !== id) await this.drain(otherId);
    }
    for (const [otherId, model] of [...this.resident]) {
      if (otherId === id) continue;
      await this.drain(otherId);
      // Its owner may have disposed or replaced it while we waited. From here
      // to the delete there is no await, so no use can slip in between.
      if (this.resident.get(otherId) !== model) continue;
      this.resident.delete(otherId);
      try {
        await model.release();
      } catch (err) {
        console.warn(`[model-residency] releasing ${otherId} failed`, err);
      }
    }
  }

  /** Wait until model `id` has no use in flight. */
  private async drain(id: string): Promise<void> {
    for (let uses = this.inFlight.get(id); uses?.size; uses = this.inFlight.get(id)) {
      await Promise.allSettled([...uses]);
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
