import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { WandService } from '../wand/wand.service';
import { WandToolHost } from '../wand/wand-tool.service';
import { frameToRgba } from './sam-prompt';
import { getSamModel, isSamModelReady } from './sam-model-registry';
import { ISamSession, SamEmbedding, SamModelDef, SamPrompt } from '../../contracts/sam.contract';
import { Region, Polygon } from '../../models/region';

/** Interactive SAM point-prompt tool (jit-ui#90, P1).
 *
 * Each plain (positive) click segments the clicked object as its OWN new region
 * — clicking a second fiber doesn't extend the first into it. Shift/Alt-click
 * adds a negative (exclude) point that refines the CURRENT object, re-running
 * the decoder against the (cached) image embedding and updating its live region.
 * `commit()` (Enter) finalises early; `clear()` (Esc) discards the current
 * prompt + its preview region. Mirrors the wand/brush on-canvas tool pattern and
 * reuses WandService.maskToPolygons + the shared region store.
 *
 * Inference is behind {@link ISamSession} (lazy onnxruntime-web in production,
 * a fake in tests).
 */
@Injectable({ providedIn: 'root' })
export class SamPointToolService {
  private host!: WandToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private session: ISamSession | null = null;
  /** In-flight session load — dedupes a warm-up preload against the first click. */
  private sessionLoad: Promise<ISamSession> | null = null;
  private model: SamModelDef = getSamModel();

  private embedding: SamEmbedding | null = null;
  private embeddingKey: string | null = null;

  /** Accumulated point prompts, in image (matrix) coords. */
  private points: { x: number; y: number; label: 0 | 1 }[] = [];
  /** Id of the in-progress (preview) region being refined, if committed to store. */
  private regionId: number | null = null;

  readonly status$ = new BehaviorSubject<string>('');
  readonly busy$ = new BehaviorSubject<boolean>(false);
  /** Encoder-download progress (0..1) on the first click; -1 when not downloading. */
  readonly progress$ = new BehaviorSubject<number>(-1);

  private readonly boundMouseDown: (e: MouseEvent) => void;

  constructor(private wandService: WandService) {
    this.boundMouseDown = (e) => { void this.onMouseDown(e); };
  }

  bindHost(host: WandToolHost): void { this.host = host; }

  setModel(id: string): void {
    const next = getSamModel(id);
    if (next.id === this.model.id) return;
    this.model = next;
    this.embedding = null;
    this.embeddingKey = null;
    // Drop the loaded session so the next run reloads the newly-picked model
    // (ensureSession() returns the cached session as-is otherwise).
    this.session?.dispose();
    this.session = null;
    this.sessionLoad = null;
  }

  /** Test seam: inject a fake/alternate session. */
  useSession(session: ISamSession): void { this.session = session; }

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
    if (this.session || !isSamModelReady(this.model)) return;
    void this.ensureSession().catch(() => undefined);
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
    if (this.busy$.value) return;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) return;
    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;

    const rx = cached.ratios[0] || 1;
    const ry = cached.ratios[0] || 1;
    const ox = cached.originX ?? 0;
    const oy = cached.originY ?? 0;
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
    this.points.push({ x: (dataX - ox) / rx, y: (dataY - oy) / ry, label });

    // Mark busy BEFORE ensureSession: the first click downloads the encoder
    // (~14–172 MB) and builds the session, which is the longest wait — without
    // this the UI showed nothing running until that finished.
    this.busy$.next(true);
    try {
      this.status$.next('Loading SAM model…');
      const session = await this.ensureSession();
      const key = [
        this.host.getFileName() ?? '', this.host.getActiveFrameIndex(),
        `${cached.width}x${cached.height}`, `${ox},${oy},${rx}`, this.model.id,
      ].join('|');
      if (!this.embedding || this.embeddingKey !== key) {
        this.status$.next('Encoding image…');
        const rgba = frameToRgba(cached, this.host.getActiveFrameIndex());
        this.embedding = await session.embed({ data: rgba, width: cached.width, height: cached.height });
        this.embeddingKey = key;
      }
      this.status$.next('Segmenting…');
      const prompt: SamPrompt = { points: this.points.slice() };
      const res = await session.decode(this.embedding, prompt);
      const polys = this.wandService.maskToPolygons(
        res.mask, res.width, res.height, cached.width, cached.height, 0, 0,
      );
      if (polys.length === 0) { this.status$.next('No mask for these points.'); return; }
      const poly = polys[0];
      this.upsertPreview(
        poly.xpoints.map((x) => ox + x * rx),
        poly.ypoints.map((y) => oy + y * ry),
      );
      this.status$.next(
        'Segmented — click another fiber for a new region, Shift-click to refine, Esc to undo.',
      );
    } catch (err) {
      this.status$.next(err instanceof Error ? err.message : 'SAM model unavailable.');
    } finally {
      this.busy$.next(false);
      this.progress$.next(-1);
    }
  }

  /** Replace (or insert) the in-progress preview region in the shared store. */
  private upsertPreview(xData: number[], yData: number[]): void {
    if (xData.length < 3) return;
    const poly = new Polygon();
    poly.npoints = xData.length;
    poly.xpoints = xData;
    poly.ypoints = yData;
    poly.coordinates = xData.map((x, i) => [x, yData[i]]);
    poly.closed = true;

    const regions = this.host.getRegions();
    const existing = this.regionId != null ? regions.find((r) => r.id === this.regionId) : null;
    const region = new Region();
    region.bounds = poly;
    region.color = this.host.getShapeColor();
    region.label = 'sam';
    if (existing) {
      region.id = existing.id;
      region.name = existing.name;
      const idx = regions.findIndex((r) => r.id === this.regionId);
      if (idx >= 0) regions[idx] = region; else regions.push(region);
    } else {
      regions.push(region);
    }
    this.host.setRegions(regions);
    this.regionId = region.id ?? this.regionId;
  }

  private ensureSession(): Promise<ISamSession> {
    if (this.session) return Promise.resolve(this.session);
    if (this.sessionLoad) return this.sessionLoad;
    if (!isSamModelReady(this.model)) {
      return Promise.reject(new Error(
        `SAM model "${this.model.id}" is not configured yet (no ONNX URLs). ` +
        'Host it and call setSamModelUrls(), then retry.',
      ));
    }
    this.sessionLoad = (async () => {
      try {
        const { OnnxSamSession } = await import('./onnx-sam-session');
        const session = new OnnxSamSession();
        this.progress$.next(0);
        await session.loadModel(this.model, (f) => this.progress$.next(f));
        this.session = session;
        return session;
      } finally {
        this.sessionLoad = null;
      }
    })();
    return this.sessionLoad;
  }
}
