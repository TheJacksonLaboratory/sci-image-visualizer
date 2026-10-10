import { Injectable } from '@angular/core';

import { isSamModelReady } from './sam-model-registry';
import { SamSessionService } from './sam-session.service';
import { ISamSession, SamPrompt } from '../../contracts/sam.contract';
import { Region, Polygon } from '../../models/region';
import { makePolygon, replaceBounds } from '../../models/polygon-factory';
import { maskToPolygons } from '../../geometry/contour';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { AsyncToolStatus } from '../tool-kit/async-tool-status';
import { ToolOverlayCanvas } from '../tool-kit/tool-overlay';
import { CanvasToolHost, ICanvasTool } from '../tool-kit/canvas-tool';

/**
 * The SAM point prompts of one viewer chain: the status feeds the toolbar shows
 * and the model session. Every backend's `CanvasToolManager` gets its own
 * {@link SamPointTool} from {@link createTool}, so in-progress points never
 * cross backends, while all of them report through these feeds and share one
 * busy guard and one {@link SamSessionService}.
 */
@Injectable({ providedIn: 'root' })
export class SamPointToolService {
  private readonly state = new AsyncToolStatus();

  readonly status$ = this.state.status$;
  readonly busy$ = this.state.busy$;
  /** Encoder-download progress (0..1) on the first click; -1 when not downloading. */
  readonly progress$ = this.state.progress$;

  constructor(private readonly sessions: SamSessionService = new SamSessionService()) {}

  /** Choose the registered model to use (shared with the box tool). */
  setModel(id: string): void {
    this.sessions.setModel(id);
  }

  /** Test seam: inject a fake/alternate session. */
  useSession(session: ISamSession): void { this.sessions.useSession(session); }

  /** A point tool for one backend, reporting through this service. */
  createTool(): SamPointTool {
    return new SamPointTool(this.state, this.sessions);
  }
}

/** Interactive SAM point-prompt tool (jit-ui#90, P1).
 *
 * Each plain (positive) click segments the clicked object as its OWN new region
 * — clicking a second fiber doesn't extend the first into it. Shift/Alt-click
 * adds a negative (exclude) point that refines the CURRENT object, re-running
 * the decoder against the (cached) image embedding and updating its live region.
 * `commit()` (Enter) finalises early; `clear()` (Esc) discards the current
 * prompt + its preview region. Mirrors the wand/brush on-canvas tool pattern and
 * reuses the contour tracer + the shared region store.
 *
 * Inference goes through the shared {@link SamSessionService} (one session and
 * embedding for both SAM tools; lazy onnxruntime-web in production, a fake in
 * tests). Created by {@link SamPointToolService.createTool}.
 */
export class SamPointTool implements ICanvasTool<void> {
  readonly id = 'samPoint';
  private host: CanvasToolHost | null = null;
  private readonly overlay = new ToolOverlayCanvas();

  /** Accumulated point prompts, in image (matrix) coords. */
  private points: { x: number; y: number; label: 0 | 1 }[] = [];
  /** Id of the in-progress (preview) region being refined, if committed to store. */
  private regionId: number | null = null;

  constructor(private readonly state: AsyncToolStatus, private readonly sessions: SamSessionService) {}

  private get status$() { return this.state.status$; }

  // ── ICanvasTool ─────────────────────────────────────────────────────────

  activate(host: CanvasToolHost): void {
    this.host = host;
    this.createOverlay();
    // Warm up the model in the background as soon as the tool is armed, so the
    // first click doesn't pay the (download +) session-build cost on its path.
    this.preload();
  }

  deactivate(): void {
    this.overlay.detach();
    this.reset();
  }

  /** Forget the current prompt (its preview region stays). */
  reset(): void {
    this.points = [];
    this.regionId = null;
  }

  /** Eagerly load the model in the background (fire-and-forget). Safe to call
   *  repeatedly — it dedupes against an in-flight load and an existing session. */
  preload(): void {
    if (this.sessions.hasSession() || !isSamModelReady(this.sessions.getModel())) return;
    void this.sessions.ensureSession().catch(() => undefined);
  }

  /** Finalise the current object: keep its region, start fresh next click. */
  commit(): void {
    this.points = [];
    this.regionId = null;
    this.status$.next('');
  }

  /** Discard the in-progress prompt + its preview region. */
  clear(): void {
    if (this.regionId != null && this.host) {
      const regions = this.host.getRegions().filter((r) => r.id !== this.regionId);
      this.host.setRegions(regions);
    }
    this.points = [];
    this.regionId = null;
    this.status$.next('');
  }

  // ── overlay lifecycle (shared with the wand/brush tools) ────────────────

  private createOverlay(): void {
    const container = this.host?.getOverlayContainer();
    if (!container) return;
    this.overlay.attach(container, { down: (e) => { void this.onPointerDown(e); } });
  }

  // ── per-click refinement ────────────────────────────────────────────────

  /** Primary button only (the overlay filters the others). */
  private async onPointerDown(e: PointerEvent): Promise<void> {
    if (!this.overlay.attached) return;
    // Re-entrancy guard: ignore clicks while a previous prompt is still
    // downloading the model / encoding / decoding. Without it, clicking again
    // during the slow first run (e.g. a ~172 MB ViT-B encode on WebGPU) launches
    // concurrent downloads + GPU encodes that can overwhelm the GPU and freeze
    // the tab. Each click is fast once the embedding is cached, so this only
    // drops clicks made while genuinely busy.
    if (this.state.busy) return;
    const host = this.host;
    if (!host) return;
    const cached = host.getCachedImageData();
    if (!cached || cached.frames.length === 0) return;
    const transform = host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;

    const frame = MatrixFrame.from(cached);
    const frameIdx = host.getActiveFrameIndex();
    // Shift or Alt = negative (exclude) point.
    const label: 0 | 1 = e.shiftKey || e.altKey ? 0 : 1;
    // A plain positive click starts a NEW object: clicking another fiber must
    // segment that fiber on its own, not accumulate with earlier points and
    // grow the in-progress mask into the adjacent object (which would also
    // overwrite a previously-segmented region). Only Shift/Alt (exclude) points
    // refine the current object. This also clears any stale prompt left after a
    // region was deleted, so the next click segments fresh instead of redrawing
    // the old merged mask.
    if (label === 1) {
      this.points = [];
      this.regionId = null;
    }
    this.points.push({ x: frame.toMatrixX(dataX), y: frame.toMatrixY(dataY), label });

    // Busy from here on — including the model download (~14–172 MB on the
    // first click), the longest wait — so the UI shows the run at once.
    await this.state.run(async () => {
      try {
        this.status$.next('Loading SAM model…');
        const session = await this.sessions.ensureSession((f) => this.state.progress$.next(f));
        const key = [host.getFileName() ?? '', frameIdx, `${cached.width}x${cached.height}`, frame.sig]
          .join('|');
        const embedding = await this.sessions.embed(session, cached, frameIdx, key,
          () => this.status$.next('Encoding image…'));
        this.status$.next('Segmenting…');
        const prompt: SamPrompt = { points: this.points.slice() };
        const res = await session.decode(embedding, prompt);
        const poly = maskToPolygons(res.mask, res.width, res.height, 0, 0)[0];
        if (!poly) { this.status$.next('No mask for these points.'); return; }
        this.upsertPreview(host, poly, frame);
        this.status$.next(
          'Segmented — click another fiber for a new region, Shift-click to refine, Esc to undo.',
        );
      } catch (err) {
        this.status$.next(err instanceof Error ? err.message : 'SAM model unavailable.');
      }
    });
  }

  /** Replace (or insert) the in-progress preview region in the shared store,
   *  against the regions as they are now (the run may have taken a while). */
  private upsertPreview(host: CanvasToolHost, poly: Polygon, frame: MatrixFrame): void {
    if (poly.xpoints.length < 3) return;
    const ring = frame.ringToData(poly.xpoints, poly.ypoints);
    const regions = host.getRegions();
    const bounds = makePolygon(ring.xs, ring.ys, { holes: frame.holesToData(poly.holes) });
    const idx = this.regionId != null ? regions.findIndex((r) => r.id === this.regionId) : -1;
    let region: Region;
    if (idx >= 0) {
      // Refining: keep the preview's identity and anything the user changed on it.
      region = replaceBounds(regions[idx], bounds);
      regions[idx] = region;
    } else {
      region = new Region();
      region.bounds = bounds;
      region.color = host.getShapeColor();
      region.label = 'sam';
      regions.push(region);
    }
    host.setRegions(regions);
    this.regionId = region.id ?? this.regionId;
  }
}
