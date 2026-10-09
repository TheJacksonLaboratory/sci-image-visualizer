/**
 * "Latest wins" sequencing for one async concern.
 *
 * Every load that can be overtaken — a fetch the user changes their mind about before it
 * lands — takes a ticket from {@link next} before its first await and checks it after
 * each one. A newer ticket, or {@link invalidate}, makes every older one stale, so a slow
 * response cannot paint over what the user has moved on to.
 *
 * One instance per concern, never shared: two unrelated loads on one counter cancel each
 * other, which is how a redraw used to drop a pending colour-source load. A dataset switch
 * invalidates all of them together.
 */
export class Supersede {
  private generation = 0;

  /**
   * Start a task, superseding every earlier one.
   *
   * @returns a check that stays true until a newer task starts or {@link invalidate} runs.
   */
  next(): () => boolean {
    const mine = ++this.generation;
    return () => mine === this.generation;
  }

  /** Make every task started so far stale, without starting a new one. */
  invalidate(): void {
    this.generation++;
  }
}
