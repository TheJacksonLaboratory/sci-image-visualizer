import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { WandService } from './wand.service';
import { WandToolHost } from './wand-tool.service';
import { frameToRgba } from './sam-prompt';
import { getSamModel, isSamModelReady } from './sam-model-registry';
import { ISamSession, SamEmbedding, SamModelDef, SamPrompt } from '../contracts/sam.contract';
import { Region, Polygon } from '../models/region';

/** Interactive SAM point-prompt tool (jit-ui#90, P1).
 *
 * Click to add a positive point, Shift/Alt-click to add a negative point; after
 * each click the decoder re-runs against the (cached) image embedding and the
 * in-progress mask is shown as a live region. `commit()` finalises it; `clear()`
 * (or Esc) discards the prompt. Mirrors the wand/brush on-canvas tool pattern
 * and reuses WandService.maskToPolygons + the shared region store.
 *
 * Inference is behind {@link ISamSession} (lazy onnxruntime-web in production,
 * a fake in tests).
 */
@Injectable({ providedIn: 'root' })
export class SamPointToolService {
  private host!: WandToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private session: ISamSession | null = null;
  private model: SamModelDef = getSamModel();

  private embedding: SamEmbedding | null = null;
  private embeddingKey: string | null = null;

  /** Accumulated point prompts, in image (matrix) coords. */
  private points: { x: number; y: number; label: 0 | 1 }[] = [];
  /** Id of the in-progress (preview) region being refined, if committed to store. */
  private regionId: number | null = null;

  readonly status$ = new BehaviorSubject<string>('');
  readonly busy$ = new BehaviorSubject<boolean>(false);

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
  }

  /** Test seam: inject a fake/alternate session. */
  useSession(session: ISamSession): void { this.session = session; }

  setMode(active: boolean): void {
    if (active) this.createOverlay();
    else this.destroyOverlay();
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
    this.points.push({ x: (dataX - ox) / rx, y: (dataY - oy) / ry, label });

    let session: ISamSession;
    try {
      session = await this.ensureSession();
    } catch (err) {
      this.status$.next(err instanceof Error ? err.message : 'SAM model unavailable.');
      return;
    }

    this.busy$.next(true);
    try {
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
      this.status$.next(`${this.points.length} point(s) — Enter to commit, Esc to clear.`);
    } catch (err) {
      this.status$.next(err instanceof Error ? err.message : 'Segmentation failed.');
    } finally {
      this.busy$.next(false);
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

  private async ensureSession(): Promise<ISamSession> {
    if (this.session) return this.session;
    if (!isSamModelReady(this.model)) {
      throw new Error(
        `SAM model "${this.model.id}" is not configured yet (no ONNX URLs). ` +
        'Host it and call setSamModelUrls(), then retry.',
      );
    }
    const { OnnxSamSession } = await import('./onnx-sam-session');
    const session = new OnnxSamSession();
    await session.loadModel(this.model);
    this.session = session;
    return session;
  }
}
