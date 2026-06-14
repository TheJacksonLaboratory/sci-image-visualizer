import { Injectable } from '@angular/core';

import type { ICellSegmenter, CellSegmentation } from '../../contracts/cell-segmenter.contract';
import type { Cellpose } from 'cellpose-js';

/** Hosted cellpose-SAM ONNX (CPSAM, fp16). Override via {@link setModelUrl}. */
const DEFAULT_MODEL_URL =
  'https://huggingface.co/ballon999/cellpose-sam-onnx/resolve/main/cpsam_fp16.onnx';

/**
 * Default in-library {@link ICellSegmenter} backed by cellpose-js (WebGPU/WASM
 * ONNX) — so the toolbar's automatic **Cellpose** tool works out of the box in
 * any app, with no host wiring (jit-ui#90). `cellpose-js` is a peer dependency
 * and is **lazy-imported** on first use, so apps that never run Cellpose pay
 * nothing for it. A host can still override the {@link CELL_SEGMENTER} token to
 * supply a different implementation.
 *
 * Owns a single shared {@link Cellpose} instance (one model load, one WebGPU
 * session, one worker). {@link getModel} exposes that instance so a host's
 * processing pipeline can reuse it instead of loading the ~588 MB model twice.
 */
@Injectable({ providedIn: 'root' })
export class CellposeSegmenterService implements ICellSegmenter {
  private instance: Cellpose | null = null;
  private loading: Promise<Cellpose> | null = null;
  private modelUrl = DEFAULT_MODEL_URL;

  /** Point the segmenter at a different hosted CPSAM ONNX (before first use). */
  setModelUrl(url: string): void {
    this.modelUrl = url;
  }

  async segmentCells(
    image: { data: Uint8ClampedArray; width: number; height: number },
    onProgress?: (fraction: number) => void,
  ): Promise<CellSegmentation> {
    const cp = await this.getModel((loaded, total) => { if (total) onProgress?.(loaded / total); });
    const out = await cp.segment({
      data: image.data, width: image.width, height: image.height, channels: 4,
    });
    return { labels: out.masks, width: out.width, height: out.height, count: out.count };
  }

  /**
   * The shared Cellpose instance, lazily created on first use and reused
   * thereafter (deduped across concurrent callers). Exposed so a host pipeline
   * engine can run richer `segment()` options on the same instance. The progress
   * callback reports raw downloaded/total bytes (`total` is null when unknown).
   */
  getModel(onProgress?: (loaded: number, total: number | null) => void): Promise<Cellpose> {
    if (this.instance) return Promise.resolve(this.instance);
    if (!this.loading) {
      this.loading = (async () => {
        // Lazy: keep cellpose-js + its ORT runtime out of the initial bundle.
        const { Cellpose, configureOrt } = await import('cellpose-js');
        configureOrt({ wasmPaths: '/assets/ort/' });
        const cp = await Cellpose.fromPretrained(this.modelUrl, {
          preload: true,
          onProgress: ({ loaded, total }) => onProgress?.(loaded, total),
        });
        this.instance = cp;
        return cp;
      })();
    }
    return this.loading;
  }

  /** Whether the shared model is already loaded (warm). */
  isLoaded(): boolean {
    return this.instance !== null;
  }
}
