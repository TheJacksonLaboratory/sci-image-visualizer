import { Injectable } from '@angular/core';

import { WandToolHost } from '../wand/wand-tool.service';
import { isSamModelReady } from './sam-model-registry';
import { SamSessionService } from './sam-session.service';
import { ISamSession, SamPrompt } from '../../contracts/sam.contract';
import { Region, Polygon } from '../../models/region';
import { makePolygon, replaceBounds } from '../../models/polygon-factory';
import { maskToPolygons } from '../../geometry/contour';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { AsyncToolStatus } from '../tool-kit/async-tool-status';

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
 * tests).
 */
@Injectable({ providedIn: 'root' })
export class SamPointToolService {
  private host!: WandToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private readonly state = new AsyncToolStatus();

  /** Accumulated point prompts, in image (matrix) coords. */
  private points: { x: number; y: number; label: 0 | 1 }[] = [];
  /** Id of the in-progress (preview) region being refined, if committed to store. */
  private regionId: number | null = null;

  readonly status$ = this.state.status$;
  readonly busy$ = this.state.busy$;
  /** Encoder-download progress (0..1) on the first click; -1 when not downloading. */
  readonly progress$ = this.state.progress$;

  private readonly boundMouseDown: (e: MouseEvent) => void;

  constructor(private readonly sessions: SamSessionService = new SamSessionService()) {
    this.boundMouseDown = (e) => { void this.onMouseDown(e); };
  }

  bindHost(host: WandToolHost): void { this.host = host; }

  /** Choose the registered model to use (shared with the box tool). */
  setModel(id: string): void {
    this.sessions.setModel(id);
  }

  /** Test seam: inject a fake/alternate session. */
  useSession(session: ISamSession): void { this.sessions.useSession(session); }

  setMode(active: boolean): void {
    if (active) {
      this.createOverlay();
      // Warm up the model in the background as soon as the tool is armed, so the
      // first click doesn't pay the (download +) session-build cost on its path.
      this.preload();
    } else {
      this.destroyOverlay();
    }
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
    if (this.regionId != null) {
      const regions = this.host.getRegions().filter((r) => r.id !== this.regionId);
      this.host.setRegions(regions);
    }
    this.points = [];
    this.regionId = null;
    this.status$.next('');
  }

  // ── overlay lifecycle (mirrors the wand/brush tools) ────────────────────

  private createOverlay(): void {
    const plotEl = this.host?.getOverlayContainer();
    if (!plotEl || this.overlay) return;
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
      cursor: 'crosshair', zIndex: '100',
    });
    canvas.width = plotEl.offsetWidth;
    canvas.height = plotEl.offsetHeight;
    plotEl.appendChild(canvas);
    this.overlay = canvas;
    canvas.addEventListener('mousedown', this.boundMouseDown);
  }

  private destroyOverlay(): void {
    if (!this.overlay) return;
    this.overlay.removeEventListener('mousedown', this.boundMouseDown);
    this.overlay.remove();
    this.overlay = null;
    this.points = [];
    this.regionId = null;
  }

  // ── per-click refinement ────────────────────────────────────────────────

  private async onMouseDown(e: MouseEvent): Promise<void> {
    if (e.button !== 0 || !this.overlay) return;
    // Re-entrancy guard: ignore clicks while a previous prompt is still
    // downloading the model / encoding / decoding. Without it, clicking again
    // during the slow first run (e.g. a ~172 MB ViT-B encode on WebGPU) launches
    // concurrent downloads + GPU encodes that can overwhelm the GPU and freeze
    // the tab. Each click is fast once the embedding is cached, so this only
    // drops clicks made while genuinely busy.
    if (this.state.busy) return;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) return;
    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;

    const frame = MatrixFrame.from(cached);
    const frameIdx = this.host.getActiveFrameIndex();
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
        const session = await this.sessions.ensureSession((f) => this.progress$.next(f));
        const key = [this.host.getFileName() ?? '', frameIdx, `${cached.width}x${cached.height}`, frame.sig]
          .join('|');
        const embedding = await this.sessions.embed(session, cached, frameIdx, key,
          () => this.status$.next('Encoding image…'));
        this.status$.next('Segmenting…');
        const prompt: SamPrompt = { points: this.points.slice() };
        const res = await session.decode(embedding, prompt);
        const poly = maskToPolygons(res.mask, res.width, res.height, 0, 0)[0];
        if (!poly) { this.status$.next('No mask for these points.'); return; }
        this.upsertPreview(poly, frame);
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
  private upsertPreview(poly: Polygon, frame: MatrixFrame): void {
    if (poly.xpoints.length < 3) return;
    const ring = frame.ringToData(poly.xpoints, poly.ypoints);
    const regions = this.host.getRegions();
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
      region.color = this.host.getShapeColor();
      region.label = 'sam';
      regions.push(region);
    }
    this.host.setRegions(regions);
    this.regionId = region.id ?? this.regionId;
  }
}
