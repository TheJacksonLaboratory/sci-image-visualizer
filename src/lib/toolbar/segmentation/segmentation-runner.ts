import { Observable, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MessageService } from 'primeng/api';

/** A segmentation tool's live feeds: status line and encoder-download progress (0..1, <0 = none).
 *  Observables, not subjects, so a contributed tool need not expose its internals. */
export interface SegmentationProgress {
  status$: Observable<string>;
  progress$: Observable<number>;
}

/**
 * One viewer's segmentation runs and their sticky progress toast (jit-ui#90): the
 * box-prompt SAM and Cellpose tools, contributed whole-view tools, and the
 * interactive SAM point tool whose feeds it bridges.
 *
 * The toast is keyed per viewer (`toastKey`), so a run in a pipeline preview does not
 * show in the main view; results and failures go to the viewer's `resultKey` outlet,
 * which the sticky toast's teardown does not clear. The toast template binds
 * {@link status}, {@link progress}, {@link downloading} and {@link busy}.
 */
export class SegmentationRunner {
  status = '';
  /** Encoder download, 0..100. */
  progress = 0;
  downloading = false;
  /** Any segmentation work in flight (the indeterminate spinner). */
  busy = false;
  /** Whether the sticky toast is up — re-adding it would stack one per point click. */
  private shown = false;

  constructor(
    private readonly messages: Pick<MessageService, 'add' | 'clear'>,
    readonly toastKey: string,
    readonly resultKey: string,
    /** Re-render the toast (its feeds may fire outside the zone). */
    private readonly changed: () => void,
  ) {}

  /** Surface the interactive SAM point tool's status and download progress, which runs
   *  inside the renderer on each click (the first click pulls the encoder). */
  bindPointTool(tool: SegmentationProgress & { busy$: Observable<boolean> }, until$: Observable<unknown>): void {
    tool.progress$.pipe(takeUntil(until$)).subscribe((f) => this.onProgress(f));
    tool.status$.pipe(takeUntil(until$)).subscribe((m) => {
      this.status = m;
      this.changed();
    });
    tool.busy$.pipe(takeUntil(until$)).subscribe((busy) => {
      this.busy = busy;
      if (busy) this.show('SAM point segmentation');
      this.changed();
    });
  }

  /**
   * Run `op` with the tool's status and download progress in the sticky toast, then
   * report the outcome: the region count (or the tool's last status line) on success,
   * the error on failure. The toast stays until the run settles.
   */
  async run(label: string, tool: SegmentationProgress, op: () => Promise<number>): Promise<void> {
    this.status = 'Starting…';
    this.progress = 0;
    this.downloading = false;
    this.busy = true;
    // The last non-empty status is what the result reports: `tool` is only an
    // Observable pair, so there is no `.value` to sample once the run settles.
    let lastStatus = '';
    const subs = new Subscription();
    subs.add(tool.progress$.subscribe((f) => this.onProgress(f)));
    subs.add(
      tool.status$.subscribe((m) => {
        if (!m) return;
        lastStatus = m;
        this.status = m;
        this.changed();
      }),
    );
    this.show(label);
    try {
      const n = await op();
      this.messages.add({
        key: this.resultKey,
        severity: n > 0 ? 'success' : 'warn',
        summary: label,
        detail: lastStatus || (n > 0 ? `Added ${n} region(s).` : 'No regions added.'),
      });
    } catch (e) {
      this.messages.add({ key: this.resultKey, severity: 'error', summary: `${label} failed`, detail: String(e) });
    } finally {
      subs.unsubscribe();
      this.hide();
    }
  }

  /** Show the sticky toast once (idempotent). */
  show(summary: string): void {
    if (this.shown) return;
    this.shown = true;
    this.messages.add({ key: this.toastKey, sticky: true, severity: 'info', summary });
  }

  /** Dismiss the sticky toast and reset its progress/spinner state. */
  hide(): void {
    this.shown = false;
    this.busy = false;
    this.downloading = false;
    this.progress = 0;
    this.messages.clear(this.toastKey);
    this.changed();
  }

  private onProgress(f: number): void {
    this.downloading = f >= 0 && f < 1;
    if (f >= 0) this.progress = Math.min(100, Math.round(f * 100));
    this.changed();
  }
}
