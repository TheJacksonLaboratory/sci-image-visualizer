import { Injectable } from '@angular/core';
import { getOrtWasmBase } from './ort-runtime-config';

import type {
  ICellSegmenter,
  CellSegmentation,
  CellSegmentProgress,
} from '../../contracts/cell-segmenter.contract';
import type { Cellpose } from 'cellpose-js';

/** Hosted cellpose-SAM ONNX (CPSAM, fp16). Override via {@link setModelUrl}. */
const DEFAULT_MODEL_URL = 'https://huggingface.co/jax-image-tools/cellpose-sam-onnx/resolve/main/cpsam_fp16.onnx';

/**
 * Default in-library {@link ICellSegmenter} backed by cellpose-js (WebGPU/WASM
 * ONNX) — so the toolbar's automatic **Cellpose** tool works out of the box in
 * any app, with no host wiring (jit-ui#90). `cellpose-js` is a regular
 * dependency — installed automatically, like `napari-js` — but it is
 * **lazy-imported** on first use, so apps that never run Cellpose pay nothing
 * for it in the bundle. A host can still override the {@link CELL_SEGMENTER}
 * token to supply a different implementation.
 *
 * Owns a single shared {@link Cellpose} instance (one model load, one WebGPU
 * session, one worker). {@link getModel} exposes that instance so a host's
 * processing pipeline can reuse it instead of loading the ~588 MB model twice.
 */
@Injectable({ providedIn: 'root' })
export class CellposeSegmenterService implements ICellSegmenter {
  private instance: Cellpose | null = null;
  private loading: Promise<Cellpose> | null = null;
  /** Bumped by {@link setModelUrl}, so a load of the previous URL is discarded. */
  private generation = 0;
  private modelUrl = DEFAULT_MODEL_URL;
  /** Every in-flight caller's callbacks: one shared load reports to all of them. */
  private readonly progressListeners = new Set<(loaded: number, total: number | null) => void>();
  private readonly statusListeners = new Set<(status: string) => void>();

  /**
   * Point the segmenter at a different hosted CPSAM ONNX. Changing the URL after
   * the model loaded (or while it loads) disposes it, so the next run loads the
   * new model instead of silently keeping the old one.
   */
  setModelUrl(url: string): void {
    if (url === this.modelUrl) return;
    this.modelUrl = url;
    this.generation++;
    this.loading = null;
    const old = this.instance;
    this.instance = null;
    old?.dispose().catch((err) => console.warn('Cellpose: disposing the previous model failed', err));
  }

  async segmentCells(
    image: { data: Uint8ClampedArray; width: number; height: number },
    progress?: CellSegmentProgress,
  ): Promise<CellSegmentation> {
    let announcedDownload = false;
    const cp = await this.getModel(
      (loaded, total) => {
        if (total) progress?.onProgress?.(loaded / total);
        if (loaded > 0 && !announcedDownload) {
          announcedDownload = true;
          progress?.onStatus?.('Downloading Cellpose-SAM model…');
        }
      },
      (status) => progress?.onStatus?.(status),
    );
    progress?.onStatus?.('Preprocessing image…');
    const out = await cp.segment(
      { data: image.data, width: image.width, height: image.height, channels: 4 },
      {
        // cellpose-js runs inference in its worker (these fire between tiles) and
        // averaging/dynamics on the main thread; surface both so the toast shows
        // real progress instead of looking stuck.
        onTileProgress: (done, total) =>
          progress?.onStatus?.(
            done < total ? `Running inference (tile ${done}/${total})…` : 'Computing flow dynamics…',
          ),
      },
    );
    return { labels: out.masks, width: out.width, height: out.height, count: out.count };
  }

  /**
   * The shared Cellpose instance, lazily created on first use and reused
   * thereafter (deduped across concurrent callers, each of which receives the
   * load's progress). A failed load is retried on the next call. Exposed so a host pipeline
   * engine can run richer `segment()` options on the same instance. `onProgress`
   * reports raw downloaded/total bytes (`total` is null when unknown); `onStatus`
   * reports worker-init phase strings.
   */
  getModel(
    onProgress?: (loaded: number, total: number | null) => void,
    onStatus?: (status: string) => void,
  ): Promise<Cellpose> {
    if (this.instance) return Promise.resolve(this.instance);
    if (onProgress) this.progressListeners.add(onProgress);
    if (onStatus) this.statusListeners.add(onStatus);
    if (!this.loading) {
      const generation = this.generation;
      const url = this.modelUrl;
      const load = (async () => {
        // Lazy: keep cellpose-js + its ORT runtime out of the initial bundle.
        const { Cellpose, configureOrt } = await import('cellpose-js');
        configureOrt({ wasmPaths: getOrtWasmBase() });
        const cp = await Cellpose.fromPretrained(url, {
          preload: true,
          onProgress: ({ loaded, total }) => this.progressListeners.forEach((l) => l(loaded, total)),
          onStatus: (s) => this.statusListeners.forEach((l) => l(s)),
        });
        if (generation !== this.generation) {
          // The URL changed while this loaded: drop it and load the current one.
          cp.dispose().catch(() => undefined);
          return this.getModel();
        }
        this.instance = cp;
        return cp;
      })();
      this.loading = load;
      // A failed load is not cached: the next call retries (a network blip or a
      // WebGPU init failure must not need a page reload).
      load
        .catch(() => undefined)
        .finally(() => {
          if (this.loading === load) this.loading = null;
        });
    }
    return this.loading.finally(() => {
      if (onProgress) this.progressListeners.delete(onProgress);
      if (onStatus) this.statusListeners.delete(onStatus);
    });
  }

  /** Whether the shared model is already loaded (warm). */
  isLoaded(): boolean {
    return this.instance !== null;
  }
}
