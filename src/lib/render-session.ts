import { IImageInfo } from './contracts/image.contract';
import { PlotType } from './contracts/plot-type';
import { SpatialDataset } from './contracts/spatial-dataset.contract';
import { IVisualizer } from './contracts/visualizer.contract';
import { RenderOrchestrator } from './render-orchestrator';
import { Supersede } from './util/supersede';

/** A user-facing message for a failure: an HttpErrorResponse's server message, an
 *  Error's message, or the status text, else the value itself. */
export function errorMessage(err: unknown): string {
  const e = err as { error?: { message?: string }; message?: string; statusText?: string } | null;
  return e?.error?.message || e?.message || e?.statusText || String(err);
}

/** The viewer a render session draws into, and what it tells the viewer. */
export interface RenderSessionHost {
  readonly plotDivName: string;
  readonly visualizer: IVisualizer;
  /** The slice to load, read when each phase starts. */
  zIndex(): number;
  plotType(): PlotType;
  /** A 2D view: only it renders the small tier first (the in-place sharpen pass does
   *  not rebuild a 3D scene, so it blanked one). */
  isHeatmap(): boolean;
  /** A server-side cache fill is in progress (keeps the full overlay up). */
  isCaching(): boolean;
  /** The view is about to be torn down: end what was bound to it (contributed sessions). */
  beforeReset(): void;
  /** Lay the new image out (stack flag, slice bounds, initial slice) once the old view is gone. */
  prepare(info: IImageInfo): void;
  /** Drop the loading overlay the render owns (once per render). */
  releaseOverlay(info: IImageInfo): void;
  /** The render landed, sharp or as a fallback: apply ROIs, start sessions. */
  landed(info: IImageInfo): void;
  setImageLoading(loading: boolean): void;
  alert(severity: 'warn' | 'error', summary: string, detail: string): void;
  detectChanges(): void;
}

/**
 * The viewer's render pipeline: one image (or image-less dataset) at a time, the newest
 * always winning.
 *
 * Every render takes a task from a {@link Supersede}: a newer render, a Cancel or
 * teardown makes the older one stale — its callbacks return early instead of painting,
 * releasing the newer render's overlay or applying its ROIs — and aborts the signal its
 * loads were given, so superseded network work stops at the source. Sequencing of the
 * small→large tiers lives in {@link RenderOrchestrator}; this owns the UI flags it
 * drives ({@link running}, {@link sharpening}).
 */
export class ImageRenderSession {
  /** A render is in flight. */
  running = false;
  /** The small tier is on screen and the large one is still loading. */
  sharpening = false;
  /** Set once the plot div exists; an image-less draw before then waits for it. */
  private viewReady = false;
  private pendingDraw: SpatialDataset | null = null;
  private readonly supersede = new Supersede();

  constructor(private readonly host: RenderSessionHost) {}

  /**
   * Render `info` (which has urls), preempting whatever is in flight. A newer image
   * ALWAYS preempts: dropping it while the old one finished reported image B as loaded
   * while image A stayed on screen, and a cold image held the slot for its whole
   * server-side cache fill.
   */
  render(info: IImageInfo): void {
    const host = this.host;
    const viz = host.visualizer;
    const urls = info.urls;
    const task = this.supersede.next();
    if (this.running) {
      // Stop the previous render's frame streaming (napari volume/surface preload keeps
      // fetching otherwise) and clear its sharpen flag. Its callbacks are already inert.
      viz.cancelLoading?.();
      this.sharpening = false;
    }
    // Measure the plot div directly so the toolbar height is excluded.
    const screenHeight = document.getElementById(host.plotDivName)?.offsetHeight || 500;
    host.beforeReset();
    viz.reset();
    host.prepare(info);
    this.running = true;
    const smallCount = info.smallUrls?.length ?? 0;
    const small = host.isHeatmap() && smallCount > 0 && smallCount === urls.length
      ? { ...info, urls: info.smallUrls as string[] } : null;
    let overlayReleased = false;
    const releaseOverlay = () => {
      if (overlayReleased) return;
      overlayReleased = true;
      host.releaseOverlay(info);
    };
    const settle = () => {
      this.running = false;
      host.landed(info);
    };

    new RenderOrchestrator({
      // inPlace=true updates the existing render instead of rebuilding it, so the
      // canvas doesn't blank during the small→large swap.
      renderPhase: (phaseInfo, inPlace) => {
        // Superseded BEFORE this phase started — don't even issue the load (the
        // orchestrator calls this per tier and retries the sharpen pass).
        if (!task.isCurrent()) return Promise.resolve(null);
        return viz.load(phaseInfo, host.zIndex(), task.signal).then((loaded) => {
          if (!task.isCurrent()) return null;
          // Guard against a newer click reaching us mid-render.
          if (phaseInfo.fileName !== loaded.filename) return null;
          return viz.plot(host.plotDivName, loaded, phaseInfo, screenHeight, host.plotType(), inPlace)
            .then((drawn) => {
              // A backend that cannot draw (no plot target, no WebGPU, no tile descriptor)
              // resolves false: a failed phase, so the retry/failure paths run.
              if (drawn === false && task.isCurrent()) throw new Error('the renderer could not draw the image');
              return drawn;
            });
        });
      },
      smallShown: () => {
        if (!task.isCurrent()) return;
        // Still caching server-side: keep the full cache-progress overlay up rather than
        // a translucent spinner over a blank canvas; finished() releases it.
        if (host.isCaching()) return;
        // Small tier on screen: drop the full overlay, keep a translucent spinner so the
        // blurry render isn't mistaken for the final image.
        releaseOverlay();
        this.sharpening = true;
      },
      sharpenSettled: () => {
        if (task.isCurrent()) this.sharpening = false;
      },
      finished: () => {
        if (!task.isCurrent()) return;
        releaseOverlay(); // idempotent: now if smallShown deferred it or was skipped
        settle();
      },
      sharpenFailed: (err: unknown) => {
        if (!task.isCurrent()) return;
        // The small tier stays on screen as the fallback.
        host.alert('warn', 'Preview not sharpened', `The full-resolution preview did not load (${errorMessage(err)}). `
          + 'The low-resolution preview is still shown. Try clicking the image again.');
        settle();
      },
      renderFailed: (err: unknown) => {
        if (!task.isCurrent()) return;
        host.alert('error', 'Could not draw the image',
          `${info.fileName ?? 'The image'}: ${errorMessage(err)}. Try opening it again.`);
      },
    }).render(info, small);
  }

  /**
   * Draw a spatial mode with no image behind it: the observations alone, framed on their
   * own extent. The image info is a placeholder naming the dataset, so regions drawn here
   * are kept per dataset like any image's. Supersedes (and is superseded by) image renders.
   */
  async plotWithoutImage(dataset: SpatialDataset): Promise<void> {
    if (!this.viewReady) {
      // A host that creates the viewer AFTER publishing the dataset has it replayed before
      // the plot div exists; drawing now finds no target. Draw once the view is ready.
      this.pendingDraw = dataset;
      return;
    }
    const host = this.host;
    const task = this.supersede.next();
    const info: IImageInfo = {
      isGrayscale: false, trueImageSize: [0, 0], urls: [], isStack: false, showStack: false,
      scaleRatio: true, fileName: `spatial:${dataset.id}`, imageMeta: [],
    };
    const height = document.getElementById(host.plotDivName)?.offsetHeight || 500;
    let failure: unknown = null;
    try {
      // A backend that cannot draw (no WebGPU, no plot target) resolves false rather than throwing.
      if (!(await host.visualizer.plot(host.plotDivName, null, info, height, host.plotType()))) {
        failure = 'the renderer could not start';
      }
    } catch (err) {
      failure = err;
    }
    // Superseded: a newer render owns the loading state now.
    if (!task.isCurrent()) return;
    if (failure) {
      console.warn('[visualizer] could not draw the spatial dataset', failure);
      const e = failure as { message?: string };
      // An image-less dataset has no tissue image to fall back on, so say so rather than
      // leave an empty canvas that looks finished.
      host.alert('error', 'Could not draw the dataset', `${dataset.name ?? dataset.id}: ${e?.message ?? String(failure)}.`);
    }
    host.setImageLoading(false);
    host.detectChanges();
  }

  /**
   * The plot div exists now: run an image-less draw that arrived before it did — only if
   * its dataset is still the one on offer (by id: the port may re-emit the same dataset
   * as a new object, and the current object is the one to draw) and no image has arrived.
   */
  viewIsReady(current: SpatialDataset | null, hasImage: boolean): void {
    this.viewReady = true;
    const pending = this.pendingDraw;
    this.pendingDraw = null;
    if (pending && current && current.id === pending.id && !hasImage) void this.plotWithoutImage(current);
  }

  /** Cancel the render in flight: abort its loads and make its callbacks inert. */
  cancel(): void {
    this.supersede.cancel();
    this.running = false;
  }
}
