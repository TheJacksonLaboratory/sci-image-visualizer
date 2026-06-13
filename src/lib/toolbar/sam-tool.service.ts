import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { WandService } from './wand.service';
import { WandToolHost } from './wand-tool.service';
import { frameToRgba } from './sam-prompt';
import { getSamModel, isSamModelReady } from './sam-model-registry';
import { ISamSession, SamEmbedding, SamModelDef } from '../contracts/sam.contract';
import { Region, Polygon, Rectangle } from '../models/region';

/** The SAM tool binds to the same host the wand/brush use, so each backend
 *  reuses its existing pixel readback + coordinate transform + region store. */
export type SamToolHost = WandToolHost;

/**
 * Box-prompted SAM segmentation tool (jit-ui#90, P0). On `segmentBoxes()` it
 * reads every rectangle region, runs the (cached) encoder once for the image,
 * then runs the decoder per box, traces each mask to a polygon (reusing
 * WandService.maskToPolygons) and commits them as regions.
 *
 * Inference is abstracted behind {@link ISamSession}: production uses the
 * onnxruntime-web session (lazy-imported so ORT never loads in unit tests);
 * tests inject a fake via {@link useSession}.
 */
@Injectable({ providedIn: 'root' })
export class SamToolService {
  private host!: SamToolHost;
  private session: ISamSession | null = null;
  private model: SamModelDef = getSamModel();

  /** Cached encoder embedding + the key (image identity) it was computed for. */
  private embedding: SamEmbedding | null = null;
  private embeddingKey: string | null = null;

  /** Status text + busy flag for a spinner / toast in the host. */
  readonly status$ = new BehaviorSubject<string>('');
  readonly busy$ = new BehaviorSubject<boolean>(false);
  /** Encoder-download progress: -1 = not downloading, 0..1 = downloading. */
  readonly progress$ = new BehaviorSubject<number>(-1);

  constructor(private wandService: WandService) {}

  /** Bind to the active backend's host (called by the backend, like the wand). */
  bindHost(host: SamToolHost): void {
    this.host = host;
  }

  /** Choose the registered model to use; invalidates any cached embedding. */
  setModel(id: string): void {
    const next = getSamModel(id);
    if (next.id === this.model.id) return;
    this.model = next;
    this.invalidateEmbedding();
    // Drop the loaded session so the next run reloads the newly-picked model's
    // ONNX pair — ensureSession() returns the cached session as-is, so without
    // this a model switch would keep running the previous model.
    this.session?.dispose();
    this.session = null;
  }

  /** Drop the cached embedding (e.g. after the image/slice changes). */
  invalidateEmbedding(): void {
    this.embedding = null;
    this.embeddingKey = null;
  }

  /** Test seam: inject a fake/alternate inference session. */
  useSession(session: ISamSession): void {
    this.session = session;
  }

  /**
   * Segment every rectangle region with a box prompt and append the resulting
   * masks as new polygon regions. Returns how many regions were added.
   */
  async segmentBoxes(): Promise<number> {
    if (!this.host) return 0;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) {
      this.status$.next('No image loaded.');
      return 0;
    }

    const regions = this.host.getRegions();
    const rects = regions.filter((r) => r.bounds instanceof Rectangle);
    if (rects.length === 0) {
      this.status$.next('Draw one or more rectangles, then press Segment.');
      return 0;
    }

    const rx = cached.ratios[0] || 1;
    const ry = cached.ratios[0] || 1;
    const ox = cached.originX ?? 0;
    const oy = cached.originY ?? 0;

    let session: ISamSession;
    try {
      session = await this.ensureSession();
    } catch (err) {
      this.busy$.next(false);
      this.status$.next(err instanceof Error ? err.message : 'SAM model unavailable.');
      return 0;
    }

    this.busy$.next(true);
    try {
      // Encode once per image; reuse the embedding across all boxes.
      const key = [
        this.host.getFileName() ?? '',
        this.host.getActiveFrameIndex(),
        `${cached.width}x${cached.height}`,
        `${ox},${oy},${rx}`,
        this.model.id,
      ].join('|');
      if (!this.embedding || this.embeddingKey !== key) {
        this.status$.next('Encoding image…');
        const rgba = frameToRgba(cached, this.host.getActiveFrameIndex());
        this.embedding = await session.embed({ data: rgba, width: cached.width, height: cached.height });
        this.embeddingKey = key;
      }

      const masks: Region[] = [];
      const consumed = new Set<Region>(); // prompt rectangles that produced a mask
      let added = 0;
      for (let i = 0; i < rects.length; i++) {
        this.status$.next(`Segmenting ${i + 1}/${rects.length}…`);
        const b = rects[i].bounds as Rectangle;
        // Rectangle is in data coords → convert to image (matrix) coords.
        const box = {
          x0: (b.x - ox) / rx,
          y0: (b.y - oy) / ry,
          x1: (b.x + b.width - ox) / rx,
          y1: (b.y + b.height - oy) / ry,
        };
        const res = await session.decode(this.embedding, { box });
        const polys = this.wandService.maskToPolygons(
          res.mask, res.width, res.height, cached.width, cached.height, 0, 0,
        );
        if (polys.length === 0) continue;
        // Keep the largest connected piece (maskToPolygons returns largest-first).
        const poly = polys[0];
        masks.push(this.makeRegion(
          poly.xpoints.map((x) => ox + x * rx),
          poly.ypoints.map((y) => oy + y * ry),
          rects[i].color, // inherit the prompt rectangle's color
        ));
        consumed.add(rects[i]); // this rectangle is now represented by its mask
        added++;
      }

      // Replace each segmented prompt rectangle with its mask region; keep any
      // rectangle that produced no mask (so it can be retried) + other regions.
      const out = regions.filter((r) => !consumed.has(r)).concat(masks);
      this.host.setRegions(out);
      this.status$.next(added > 0 ? `Added ${added} region(s).` : 'No masks found.');
      return added;
    } catch (err) {
      this.status$.next(err instanceof Error ? err.message : 'Segmentation failed.');
      return 0;
    } finally {
      this.busy$.next(false);
      this.progress$.next(-1);
    }
  }

  private makeRegion(xData: number[], yData: number[], color?: string): Region {
    const poly = new Polygon();
    poly.npoints = xData.length;
    poly.xpoints = xData;
    poly.ypoints = yData;
    poly.coordinates = xData.map((x, i) => [x, yData[i]]);
    poly.closed = true;

    const region = new Region();
    region.bounds = poly;
    // Inherit the source prompt rectangle's color; fall back to the host default.
    region.color = color || this.host.getShapeColor();
    // Default class/annotation name, matching the wand/brush + overlay-drawn regions.
    region.label = 'sam';
    return region;
  }

  private async ensureSession(): Promise<ISamSession> {
    if (this.session) return this.session;
    if (!isSamModelReady(this.model)) {
      throw new Error(
        `SAM model "${this.model.id}" is not configured yet (no ONNX URLs). ` +
        'Host it and call setSamModelUrls(), then retry.',
      );
    }
    // Lazy-import so onnxruntime-web is never pulled into unit tests / the
    // initial bundle — only when segmentation actually runs.
    const { OnnxSamSession } = await import('./onnx-sam-session');
    const session = new OnnxSamSession();
    this.progress$.next(0);
    await session.loadModel(this.model, (f) => this.progress$.next(f));
    this.session = session;
    return session;
  }
}
