import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { Region } from '../models/region';
import { maskScaleFor, regionToParts, scaleParts } from './mask-raster';

/** Mask type: one foreground value, or a distinct id per region. */
export type MaskMode = 'binary' | 'multiclass';

/** What to rasterize, at the full image size. */
export interface MaskExportRequest {
  regions: Region[];
  imageSize: { width: number; height: number };
  mode: MaskMode;
  /** Recorded in the PNG metadata. */
  sourceName?: string;
}

/** Progress of one mask export, in order: planned → progress* → encoding → done. */
export type MaskExportEvent =
  /** The mask size; `scale` < 1 when the image exceeds the pixel budget. */
  | { type: 'planned'; width: number; height: number; scale: number }
  /** 0–100 rasterization progress. */
  | { type: 'progress'; percent: number }
  /** Rasterizing finished; the PNG is being encoded. */
  | { type: 'encoding' }
  | { type: 'done'; blob: Blob };

/**
 * Rasterizes regions to a label-mask PNG in a Web Worker (jit-ui#95), so the
 * full-resolution rasterize and PNG encode never freeze the UI and the job can
 * be cancelled. Component-agnostic: {@link export} returns a cold Observable —
 * subscribing starts a worker, unsubscribing terminates it (cancel), and a
 * worker failure is an error carrying a user-facing message. Whole-slide
 * images are capped to a safe pixel budget (the geometry is scaled to match).
 */
@Injectable({ providedIn: 'root' })
export class MaskExportService {
  export(request: MaskExportRequest): Observable<MaskExportEvent> {
    return new Observable<MaskExportEvent>((subscriber) => {
      const { imageSize: size } = request;
      const scale = maskScaleFor(size.width, size.height);
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      subscriber.next({ type: 'planned', width, height, scale });

      const payload = {
        width,
        height,
        originalWidth: size.width,
        originalHeight: size.height,
        scale,
        mode: request.mode,
        sourceName: request.sourceName,
        regions: request.regions.map((r) => scaleParts(regionToParts(r), scale)),
      };

      let worker: Worker | undefined;
      let closed = false;
      const stop = () => {
        worker?.terminate();
        worker = undefined;
      };
      const fail = (message: string) => {
        stop();
        subscriber.error(new Error(message));
      };

      // The worker is created asynchronously; a cancel while it loads
      // terminates it as soon as it resolves, before it is sent any work.
      this.createWorker()
        .then((w) => {
          if (closed) {
            w.terminate();
            return;
          }
          worker = w;
          w.onmessage = ({ data }: MessageEvent) => {
            switch (data?.type) {
              case 'progress':
                subscriber.next({
                  type: 'progress',
                  percent: data.total ? Math.round((data.done / data.total) * 100) : 0,
                });
                break;
              case 'encoding':
                subscriber.next({ type: 'encoding' });
                break;
              case 'done':
                stop();
                subscriber.next({ type: 'done', blob: new Blob([data.png], { type: 'image/png' }) });
                subscriber.complete();
                break;
              case 'error':
                fail(data.error || 'The mask could not be generated.');
                break;
            }
          };
          w.onerror = () => fail('The mask worker failed.');
          w.postMessage(payload);
        })
        .catch(() => {
          if (!closed) fail('The mask worker failed to start.');
        });

      return () => {
        closed = true;
        stop();
      };
    });
  }

  /** Worker factory: a dynamic import, so the worker module (and its
   *  `import.meta.url`, which the CommonJS test compile rejects) loads lazily.
   *  Overridable in tests. */
  protected async createWorker(): Promise<Worker> {
    const { createMaskWorker } = await import('./mask-worker');
    return createMaskWorker();
  }
}
