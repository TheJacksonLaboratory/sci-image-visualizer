import { IImageInfo } from './contracts/image.contract';

/**
 * Two-pass (small→large) render sequencing, extracted from
 * VisualizationComponent (refactoring plan, Step 7 — a pure move of the
 * orchestration; the component keeps the UI flags and supplies them through
 * the host callbacks).
 *
 * When the file has small-tier URLs we render the small tier first for a fast
 * blurry preview, release the loading overlay (keeping a translucent
 * "sharpening" spinner), then sharpen by re-rendering the canonical large tier
 * in place. Without a small tier it's the original single pass. The large pass
 * retries once after a short delay — the preview endpoint can hit a transient
 * 503 or a lock-contention window, and the second attempt usually lands on
 * fresh pre-gen-cached PNGs.
 */
export interface TwoPassRenderHost {
  /** Load + plot one phase (the component owns div/screen/plot-type/z and the
   *  newer-click filename guard). `inPlace` updates the existing render so the
   *  canvas doesn't blank during the small→large swap. */
  renderPhase(info: IImageInfo, inPlace: boolean): Promise<unknown>;
  /** The small tier is on screen — drop the full loading overlay so the user
   *  sees the blurry preview, and show the sharpening spinner. */
  smallShown(): void;
  /** The large render settled (either way) — sharpening spinner off. */
  sharpenSettled(): void;
  /** Rendering finished. `viaSmall` = the overlay was already released by the
   *  small tier (so only release the running guard + apply the ROI); otherwise
   *  do the full finalize (overlay + running + ROI). */
  finished(viaSmall: boolean, logTag: string): void;
  /** Both large-tier attempts failed; the small tier stays on screen as the
   *  fallback. Surface it to the user and release the running guard + ROI. */
  sharpenFailed(err: unknown): void;
}

export class RenderOrchestrator {
  constructor(
    private host: TwoPassRenderHost,
    private retryDelayMs = 1000,
  ) {}

  /** Run the render: single-pass when `smallInfo` is null, two-pass otherwise. */
  async render(info: IImageInfo, smallInfo: IImageInfo | null): Promise<void> {
    if (!smallInfo) {
      try {
        await this.host.renderPhase(info, false);
        this.host.finished(false, 'finished plotting');
      } catch (err) {
        console.error('Preview failed', err);
        this.host.finished(false, 'plotting aborted');
      }
      return;
    }

    let smallReleasedOverlay = false;
    try {
      await this.host.renderPhase(smallInfo, false);
      this.host.smallShown();
      smallReleasedOverlay = true;
      console.log('multi-tier: small tier rendered, starting large');
    } catch (err) {
      // Small-tier render failed (older backend without tier support, transient
      // error, …). Continue with large only; the overlay stays up until it lands.
      console.warn('Small-tier preview failed, falling back to large', err);
    }

    try {
      await this.renderLargeWithRetry(info);
      this.host.sharpenSettled();
      if (smallReleasedOverlay) {
        this.host.finished(true, 'multi-tier: large tier rendered, sharpening complete');
      } else {
        this.host.finished(false, 'finished plotting (large only after small fallback)');
      }
    } catch (err) {
      this.host.sharpenSettled();
      console.error('Large-tier preview failed after retry', err);
      this.host.sharpenFailed(err);
    }
  }

  /** One retry after a brief delay before giving up on the large tier. */
  private renderLargeWithRetry(info: IImageInfo): Promise<unknown> {
    return this.host.renderPhase(info, true).catch((err) => {
      console.warn('Large-tier preview failed on first try, retrying in 1s', err);
      return new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs)).then(() =>
        this.host.renderPhase(info, true),
      );
    });
  }
}

/**
 * Debounced z-slice scrubbing (extracted with the orchestrator): coalesce the
 * rapid changes a slider drag fires so a slice swap doesn't run on every
 * pixel; the final value lands immediately via {@link commit} (onSlideEnd).
 */
export class SliceScrubber {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private apply: (z: number) => void,
    private delayMs = 120,
  ) {}

  /** Debounced application of z while dragging. */
  scrub(z: number): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.apply(z);
    }, this.delayMs);
  }

  /** Apply z immediately (slide end / keyboard step), dropping any pending scrub. */
  commit(z: number): void {
    this.cancel();
    this.apply(z);
  }

  /** Drop a pending scrub without applying (teardown). */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
