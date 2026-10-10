import { BehaviorSubject } from 'rxjs';

/**
 * Status, busy flag and progress of a long-running (download / inference) tool,
 * plus the re-entrancy guard that goes with them.
 */
export class AsyncToolStatus {
  /** Status text for a toast / spinner label. */
  readonly status$ = new BehaviorSubject<string>('');
  /** True from the start of a run until it settles. */
  readonly busy$ = new BehaviorSubject<boolean>(false);
  /** Download progress: -1 = not downloading, 0..1 = downloading. */
  readonly progress$ = new BehaviorSubject<number>(-1);

  get busy(): boolean {
    return this.busy$.value;
  }

  /**
   * Run `job` unless a run is already in flight (then resolve `undefined` at
   * once). Busy is set *before* the first await — a model download is exactly
   * the window a second press must not start another run in — and busy and
   * progress are reset however the job ends.
   */
  async run<T>(job: () => Promise<T>): Promise<T | undefined> {
    if (this.busy$.value) return undefined;
    this.busy$.next(true);
    try {
      return await job();
    } finally {
      this.busy$.next(false);
      this.progress$.next(-1);
    }
  }
}
