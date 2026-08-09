import { Injectable } from '@angular/core';

import { getOrtWasmBase } from './ort-runtime-config';
import {
  getDefaultRetinalModelId,
  getRetinalModel,
  type RetinalModelDef,
} from './retinal-model-registry';

import type {
  ISemanticSegmenter,
  SemanticRegion,
  SemanticSegmentation,
  SemanticSegmentOptions,
  SemanticSegmentProgress,
} from '../../contracts/semantic-segmenter.contract';
import type { RetinalSegmenter } from 'jax-ai-js';

/**
 * Default in-library {@link ISemanticSegmenter}, backed by jax-ai-js.
 *
 * `jax-ai-js` is a regular dependency but is **lazy-imported** on first use, so
 * apps that never segment retinal layers pay nothing for it — or for
 * onnxruntime-web — in their initial bundle. Mirrors
 * {@link YoloSegmenterService}, including its per-model-id cache.
 *
 * WEBGPU ONLY, AND A HOST MUST BE READY FOR THAT
 * Unlike the YOLO and Cellpose services, there is no WASM fallback to degrade
 * to: ORT-Web's WASM EP dies with `std::bad_alloc` on these graphs at 512², at
 * every precision. jax-ai-js throws `WebGpuRequiredError` rather than trying,
 * and it is re-thrown here unchanged so a host can show a real
 * unsupported-browser message instead of a generic failure.
 */
@Injectable({ providedIn: 'root' })
export class RetinalSegmenterService implements ISemanticSegmenter {
  private readonly instances = new Map<string, RetinalSegmenter>();
  private readonly loading = new Map<string, Promise<RetinalSegmenter>>();

  async segmentSemantic(
    image: { data: Uint8ClampedArray; width: number; height: number },
    opts: SemanticSegmentOptions = {},
    progress?: SemanticSegmentProgress,
  ): Promise<SemanticSegmentation> {
    const modelId = opts.modelId ?? getDefaultRetinalModelId();
    const def = this.requireModel(modelId);

    let announcedDownload = false;
    const seg = await this.getModel(
      modelId,
      (loaded, total) => {
        if (total) progress?.onProgress?.(loaded / total);
        progress?.onBytes?.(loaded, total);
        if (loaded > 0 && !announcedDownload) {
          announcedDownload = true;
          // The size is in the message because it is ~590 MB — a user who
          // clicked a button deserves to know that before it finishes.
          progress?.onStatus?.(`Downloading ${def.label} model (~${def.sizeMb} MB)…`);
        }
      },
      (status) => progress?.onStatus?.(status),
      // A run cancelled mid-download should stop the download, not just the
      // inference queued behind it.
      opts.signal,
    );

    progress?.onStatus?.('Running inference…');
    const result = await seg.segment(
      { data: image.data, width: image.width, height: image.height },
      {
        ...(opts.classThreshold !== undefined ? { classThreshold: opts.classThreshold } : {}),
        ...(opts.classFilter ? { classFilter: opts.classFilter } : {}),
        ...(opts.simplifyTolerance !== undefined ? { simplifyTolerance: opts.simplifyTolerance } : {}),
        ...(opts.minArea !== undefined ? { minArea: opts.minArea } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        // The library narrates its own phases (per patch, then tracing) because
        // only it knows which one it is in.
        onStatus: (s) => progress?.onStatus?.(s),
      },
    );

    const regions: SemanticRegion[] = result.regions.map((r) => ({
      exterior: r.exterior.map(([x, y]): [number, number] => [x, y]),
      holes: r.holes.map((h) => h.map(([x, y]): [number, number] => [x, y])),
      classId: r.classId,
      className: r.className,
      area: r.area,
    }));

    return {
      regions,
      classAreas: result.classAreas,
      classNames: [...result.classNames],
      width: result.width,
      height: result.height,
      unassignedFraction: result.unassignedFraction,
    };
  }

  /**
   * The shared segmenter for a model id, created on first use and reused
   * thereafter (deduped across concurrent callers). Exposed so a host's
   * processing pipeline can run on the same loaded session rather than paying
   * the ~590 MB load twice.
   */
  getModel(
    modelId: string = getDefaultRetinalModelId(),
    onProgress?: (loaded: number, total: number | null) => void,
    onStatus?: (status: string) => void,
    /**
     * Abort the load. This model is ~590 MB, so a cancel has to reach the
     * *download* — aborting only the inference that follows leaves the transfer
     * running and the UI stuck in "Cancelling" until it completes.
     *
     * Deliberately not applied to a load already in flight: that promise may be
     * shared with another caller (the toolbar tool and the pipeline both use
     * this service), and one caller's cancel must not tear the model out from
     * under the other. A second caller joining an in-flight load simply waits.
     */
    signal?: AbortSignal,
  ): Promise<RetinalSegmenter> {
    const existing = this.instances.get(modelId);
    if (existing) return Promise.resolve(existing);

    const inFlight = this.loading.get(modelId);
    if (inFlight) return inFlight;

    const def = this.requireModel(modelId);
    const load = (async () => {
      // Lazy: keep jax-ai-js + its ORT runtime out of the initial bundle.
      const { RetinalSegmenter, configureOrt } = await import('jax-ai-js');
      configureOrt({ wasmPaths: getOrtWasmBase() });
      const seg = await RetinalSegmenter.fromPretrained({
        modelUrl: def.modelUrl,
        ...(def.metaUrl ? { metaUrl: def.metaUrl } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (loaded, total) => onProgress?.(loaded, total),
        onStatus: (s) => onStatus?.(s),
      });
      this.instances.set(modelId, seg);
      return seg;
    })();

    this.loading.set(modelId, load);
    // A failed load must not poison the cache — the next caller should retry
    // rather than inherit the rejected promise forever.
    load.catch(() => this.loading.delete(modelId));
    return load;
  }

  /** Whether a model is already loaded (warm). */
  isLoaded(modelId: string = getDefaultRetinalModelId()): boolean {
    return this.instances.has(modelId);
  }

  /**
   * Release one model, or all of them. Safe to call on a model never loaded.
   *
   * In-flight loads are torn down too: dropping a pending promise and returning
   * would let the load finish afterwards, re-populate {@link instances}, and
   * strand a live ORT session that nothing owns — disposal would report success
   * while leaking. At 590 MB that leak is not survivable.
   */
  async dispose(modelId?: string): Promise<void> {
    const ids = modelId
      ? [modelId]
      : [...new Set([...this.instances.keys(), ...this.loading.keys()])];
    await Promise.all(ids.map((id) => this.disposeOne(id)));
  }

  private async disposeOne(id: string): Promise<void> {
    const pending = this.loading.get(id);
    const loaded = this.instances.get(id);
    this.instances.delete(id);
    this.loading.delete(id);

    if (loaded) await loaded.dispose();
    if (!pending) return;

    // A pending load assigns instances[id] before its promise resolves, so by
    // the time this await returns the entry is back. Clear it only if it still
    // points at what *this* load produced — a newer load started meanwhile owns
    // its own entry and must not be evicted.
    const seg = await pending.catch(() => null);
    if (!seg || seg === loaded) return;
    if (this.instances.get(id) === seg) this.instances.delete(id);
    await seg.dispose();
  }

  private requireModel(modelId: string): RetinalModelDef {
    const def = getRetinalModel(modelId);
    if (!def) throw new Error(`Unknown retinal model id "${modelId}".`);
    if (!def.modelUrl.trim()) {
      // Prefer the registry's specific explanation over "not configured" — the
      // ResUNet-a entries are disabled for a documented accuracy reason, and a
      // user who picked one deserves to be told which.
      throw new Error(def.unavailableReason ?? `Retinal model "${modelId}" has no modelUrl configured.`);
    }
    return def;
  }
}
