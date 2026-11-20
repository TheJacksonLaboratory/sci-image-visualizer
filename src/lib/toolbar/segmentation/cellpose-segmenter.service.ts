import { Inject, Injectable, Optional } from '@angular/core';
import { getOrtWasmBase } from './ort-runtime-config';
import {
  MODEL_RESIDENCY,
  ModelResidency,
  estimateLoadedSizeMb,
  modelResidency,
} from '../../models/model-residency';

import type {
  ICellSegmenter,
  CellSegmentation,
  CellSegmentOptions,
  CellSegmentProgress,
} from '../../contracts/cell-segmenter.contract';
import type { Cellpose } from 'cellpose-js';

/** cellpose-js refuses to resize an image past 4096² pixels. */
const CELLPOSE_MAX_RESIZED_PIXELS = 4096 * 4096;

/**
 * The `diameter` to hand cellpose-js: undefined (no rescale) when none is given or it
 * is already ~30 px, else raised just enough that the upscaled image stays under
 * cellpose-js's 4096² limit — small cells in a large crop would otherwise throw.
 */
export function cellposeDiameter(diameter: number | undefined, width: number, height: number): number | undefined {
  if (!diameter || !(diameter > 0)) return undefined;
  const minDiameter = 30 * Math.sqrt((width * height) / CELLPOSE_MAX_RESIZED_PIXELS);
  const d = Math.max(diameter, minDiameter);
  return Math.abs(30 / d - 1) < 0.05 ? undefined : d;
}

/** Hosted cellpose-SAM ONNX (CPSAM, fp16). Override via {@link setModelUrl}. */
const DEFAULT_MODEL_URL = 'https://huggingface.co/jax-image-tools/cellpose-sam-onnx/resolve/main/cpsam_fp16.onnx';

/**
 * Loaded size (tab RAM + GPU) of the ~588 MB CPSAM graph. Estimated, not yet
 * measured: well above the 1 GB residency threshold either way, so Cellpose is
 * released when another model is used and rebuilt (from the IndexedDB cache)
 * on its next run.
 */
const CELLPOSE_LOADED_SIZE_MB = estimateLoadedSizeMb(588);

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
 *
 * Takes part in {@link ModelResidency}: the model stays warm across Cellpose
 * runs, and is released when a different model is used. A host that runs the
 * instance from {@link getModel} itself should wrap that run in
 * `residency.use(svc.residencyId(), …)` so a switch waits for it.
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
  private readonly residency: ModelResidency;

  constructor(@Optional() @Inject(MODEL_RESIDENCY) residency: ModelResidency | null = null) {
    this.residency = residency ?? modelResidency;
  }

  /** This model's id in the {@link ModelResidency} registry. */
  residencyId(): string {
    return `cellpose:${this.modelUrl}`;
  }

  /**
   * Point the segmenter at a different hosted CPSAM ONNX. Changing the URL after
   * the model loaded (or while it loads) disposes it, so the next run loads the
   * new model instead of silently keeping the old one.
   */
  setModelUrl(url: string): void {
    if (url === this.modelUrl) return;
    this.residency.unregister(this.residencyId());
    this.modelUrl = url;
    this.generation++;
    this.loading = null;
    const old = this.instance;
    this.instance = null;
    old?.dispose().catch((err) => console.warn('Cellpose: disposing the previous model failed', err));
  }

  segmentCells(
    image: { data: Uint8ClampedArray; width: number; height: number },
    progress?: CellSegmentProgress,
    options?: CellSegmentOptions,
  ): Promise<CellSegmentation> {
    return this.residency.use(this.residencyId(), () => this.runSegmentCells(image, progress, options));
  }

  private async runSegmentCells(
    image: { data: Uint8ClampedArray; width: number; height: number },
    progress?: CellSegmentProgress,
    options?: CellSegmentOptions,
  ): Promise<CellSegmentation> {
    let announcedDownload = false;
    // Already inside this model's use(): load directly rather than through
    // getModel(), which would open a second use of the same model.
    const cp = await this.loadModel(
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
        // cellpose-js rescales the image so cells are ~30 px, the size CPSAM was trained on.
        diameter: cellposeDiameter(options?.diameter, image.width, image.height),
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
   *
   * Using the model releases any other large model first, and the load is a
   * tracked use ({@link ModelResidency}): a switch to another model waits for
   * it, so two large models never load side by side. A caller that then runs
   * the returned instance should wrap that run in
   * `residency.use(svc.residencyId(), …)` too — calling `getModel()` from
   * inside that use is fine.
   */
  getModel(
    onProgress?: (loaded: number, total: number | null) => void,
    onStatus?: (status: string) => void,
  ): Promise<Cellpose> {
    return this.residency.use(this.residencyId(), () => this.loadModel(onProgress, onStatus));
  }

  private loadModel(
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
          return this.loadModel();
        }
        this.instance = cp;
        const id = `cellpose:${url}`;
        this.residency.register({
          id,
          loadedSizeMb: CELLPOSE_LOADED_SIZE_MB,
          release: () => this.release(cp),
        });
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

  /** Residency release: drop the instance so the next run rebuilds it. */
  private async release(cp: Cellpose): Promise<void> {
    if (this.instance !== cp) return; // already replaced (URL change)
    this.instance = null;
    await cp.dispose();
  }
}
