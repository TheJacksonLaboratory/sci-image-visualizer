/**
 * One task of a {@link Supersede}: the check a load makes after each await, and the
 * signal it hands to whatever it awaits so that work can stop too, not just its result.
 *
 * Callable for compatibility with the first version of this helper, whose `next()`
 * returned the bare check: `task()` is `task.isCurrent()`.
 */
export interface SupersedeTask {
  (): boolean;
  /** True until a newer task starts or the owner {@link Supersede.cancel cancels}. */
  isCurrent(): boolean;
  /**
   * Aborted at the moment this task stops being current. Pass it to `fetch`, a worker
   * call or `IDataRenderer.load()` so superseded work is dropped at the source.
   */
  readonly signal: AbortSignal;
}

/**
 * "Latest wins" sequencing for one async concern.
 *
 * Every load that can be overtaken — a fetch the user changes their mind about before it
 * lands — takes a task from {@link next} before its first await and checks it after each
 * one. A newer task, or {@link cancel}, makes every older one stale and aborts its
 * {@link SupersedeTask.signal}, so a slow response cannot paint over what the user has
 * moved on to, and work that honours the signal stops instead of finishing for nobody.
 *
 * One instance per concern, never shared: two unrelated loads on one instance cancel each
 * other, which is how a redraw used to drop a pending colour-source load. A dataset switch
 * cancels all of them together.
 */
export class Supersede {
  private generation = 0;
  private controller = new AbortController();

  /**
   * Start a task, superseding (and aborting) every earlier one.
   *
   * @returns the new task; it stays current until a newer task starts or
   *   {@link cancel} runs.
   */
  next(): SupersedeTask {
    this.advance();
    return this.current();
  }

  /**
   * The task of the current generation, WITHOUT starting a new one: a snapshot that goes
   * stale (and aborts) on the next {@link next} or {@link cancel}. For work that belongs
   * to whatever is current rather than competing with it — a cache fill that must not
   * outlive the dataset it was started for, say.
   */
  current(): SupersedeTask {
    const mine = this.generation;
    const { signal } = this.controller;
    const isCurrent = () => mine === this.generation;
    return Object.assign(() => isCurrent(), { isCurrent, signal });
  }

  /** Make every task started so far stale and abort its signal, without starting one. */
  cancel(): void {
    this.advance();
  }

  /** @deprecated Use {@link cancel}; kept for one release. */
  invalidate(): void {
    this.cancel();
  }

  private advance(): void {
    this.generation++;
    const old = this.controller;
    this.controller = new AbortController();
    old.abort();
  }
}
