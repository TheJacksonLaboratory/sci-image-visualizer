import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Bounded undo/redo history of immutable snapshots (review RT-13, RegionStore
 * split "RegionHistory").
 *
 * Holds snapshots by reference. That is only sound because the store never
 * changes a snapshot after recording it — `RegionStore` is copy-on-write: each
 * edit replaces the edited region (and the array) rather than mutating them —
 * so a snapshot costs one array of pointers, not a deep clone of every vertex.
 *
 * Recording: call {@link record} with the state just BEFORE a change. Commits
 * coalesce into one step:
 *  - between {@link beginGesture} and {@link endGesture} every commit folds into
 *    the step its first commit opened, however long the pauses, and a gesture
 *    never merges with a commit before or after it (RT-12);
 *  - outside a gesture, each commit within `coalesceMs` of the previous one
 *    folds into the same step.
 * A fresh step drops the redo future. Up to `limit` steps are kept each way.
 */
export class RegionHistory<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  /** True while a coalescing burst is open (further commits fold into it). */
  private burstOpen = false;
  /** Open gestures (nested begin/end); while > 0 the burst stays open with no timer. */
  private gestureDepth = 0;
  private burstTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a snapshot is being restored, so the restore records nothing. */
  private restoring = false;
  private readonly canUndoSubject = new BehaviorSubject<boolean>(false);
  private readonly canRedoSubject = new BehaviorSubject<boolean>(false);

  constructor(private readonly limit = 10, private readonly coalesceMs = 250) {}

  /** Whether an undo step is available (drives the toolbar's Undo button). */
  readonly canUndo$: Observable<boolean> = this.canUndoSubject.asObservable();
  /** Whether a redo step is available. */
  readonly canRedo$: Observable<boolean> = this.canRedoSubject.asObservable();

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Record `before` — the state just before a change — unless the change
   * folds into the step already open, or a restore is in progress.
   */
  record(before: T): void {
    if (this.restoring) return;
    const startsBurst = !this.burstOpen;
    if (this.gestureDepth > 0) this.burstOpen = true; // closed by endGesture()
    else this.armBurst();
    if (!startsBurst) return;
    this.push(this.undoStack, before);
    this.redoStack = [];
    this.emit();
  }

  /**
   * Step back: returns the state to restore (and keeps `current` for redo), or
   * undefined when there is nothing to undo. Restore it inside {@link restore}.
   */
  undo(current: T): T | undefined {
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) return undefined;
    this.push(this.redoStack, current);
    this.closeBurst();
    this.emit();
    return snapshot;
  }

  /** Step forward again: the mirror of {@link undo}. */
  redo(current: T): T | undefined {
    const snapshot = this.redoStack.pop();
    if (snapshot === undefined) return undefined;
    this.push(this.undoStack, current);
    this.closeBurst();
    this.emit();
    return snapshot;
  }

  /** Run `fn` (applying an undo/redo snapshot) without recording anything it triggers. */
  restore(fn: () => void): void {
    this.restoring = true;
    try {
      fn();
    } finally {
      this.restoring = false;
    }
  }

  /** Forget every step (an image load/switch: history never crosses images). */
  reset(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.closeBurst();
    this.emit();
  }

  /** Start one user gesture: every commit until the matching {@link endGesture} is one step. Nests. */
  beginGesture(): void {
    if (this.gestureDepth++ === 0) this.closeBurst();
  }

  /** End the gesture opened by {@link beginGesture}; the next commit starts a new step. */
  endGesture(): void {
    if (this.gestureDepth === 0) return;
    if (--this.gestureDepth === 0) this.closeBurst();
  }

  private push(stack: T[], state: T): void {
    stack.push(state);
    if (stack.length > this.limit) stack.shift();
  }

  /** (Re)arm the idle timer that closes the current coalescing burst. */
  private armBurst(): void {
    this.burstOpen = true;
    if (this.burstTimer) clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => {
      this.burstOpen = false;
      this.burstTimer = null;
    }, this.coalesceMs);
  }

  private closeBurst(): void {
    this.burstOpen = false;
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
  }

  private emit(): void {
    const canUndo = this.canUndo(), canRedo = this.canRedo();
    if (this.canUndoSubject.value !== canUndo) this.canUndoSubject.next(canUndo);
    if (this.canRedoSubject.value !== canRedo) this.canRedoSubject.next(canRedo);
  }
}
