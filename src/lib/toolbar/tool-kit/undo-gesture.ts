/** The part of RegionStore a tool needs to make one drag one undo step. */
export interface UndoGestureTarget {
  beginGesture(): void;
  endGesture(): void;
}

/**
 * Brackets one pointer drag as a single undo step on the region store (RT-12):
 * `begin()` on pointer-down, `end()` on pointer-up/leave or deactivation.
 * Idempotent, so every exit path can call `end()`. A no-op without a target.
 */
export class UndoGesture {
  private open = false;

  constructor(private readonly target: UndoGestureTarget | null | undefined) {}

  begin(): void {
    if (this.open || !this.target) return;
    this.open = true;
    this.target.beginGesture();
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    this.target?.endGesture();
  }
}
