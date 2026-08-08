import { Injectable } from '@angular/core';
import { getOrtWasmBase } from './ort-runtime-config';
import {
  getDefaultYoloModelId,
  getYoloModel,
  type YoloModelDef,
} from './yolo-model-registry';

import type {
  IInstanceSegmenter,
  InstanceDetection,
  InstanceSegmentation,
  InstanceSegmentOptions,
  InstanceSegmentProgress,
} from '../../contracts/instance-segmenter.contract';
import type { YoloSegmenter } from 'yolo-segdetect-js';

/**
 * Default in-library {@link IInstanceSegmenter}, backed by yolo-segdetect-js
 * (YOLOv8-seg on WebGPU, falling back to WASM).
 *
 * `yolo-segdetect-js` is a regular dependency but is **lazy-imported** on first
 * use, so apps that never run YOLO pay nothing for it — or for onnxruntime-web —
 * in their initial bundle. This mirrors {@link CellposeSegmenterService}.
 *
 * The one structural difference from the Cellpose service: there are four YOLO
 * checkpoints, not one, so instances are cached **per model id** rather than as
 * a single singleton. Each entry owns its own worker and ORT session, so a host
 * that switches models pays a second load but keeps the first one warm. Nothing
 * evicts automatically — these are ~144 MB each, so a host that cycles through
 * all four should call {@link dispose} for the ones it is done with.
 */
@Injectable({ providedIn: 'root' })
export class YoloSegmenterService implements IInstanceSegmenter {
  private readonly instances = new Map<string, YoloSegmenter>();
  private readonly loading = new Map<string, Promise<YoloSegmenter>>();

  async segmentInstances(
    image: { data: Uint8ClampedArray; width: number; height: number },
    opts: InstanceSegmentOptions = {},
    progress?: InstanceSegmentProgress,
  ): Promise<InstanceSegmentation> {
    const modelId = opts.modelId ?? getDefaultYoloModelId();
    const def = this.requireModel(modelId);

    let announcedDownload = false;
    const seg = await this.getModel(
      modelId,
      (loaded, total) => {
        if (total) progress?.onProgress?.(loaded / total);
        if (loaded > 0 && !announcedDownload) {
          announcedDownload = true;
          progress?.onStatus?.(`Downloading ${def.label} model…`);
        }
      },
      (status) => progress?.onStatus?.(status),
    );

    progress?.onStatus?.('Running inference…');
    const result = await seg.segment(
      { data: image.data, width: image.width, height: image.height },
      {
        confThreshold: opts.confidence ?? def.defaults.confidence,
        iouThreshold: opts.iouThreshold ?? def.defaults.iouThreshold,
        threshold: opts.mergeThreshold ?? def.defaults.mergeThreshold,
        overlapX: opts.overlapX ?? def.defaults.overlapX,
        overlapY: opts.overlapY ?? def.defaults.overlapY,
        ...(opts.maskThreshold !== undefined ? { maskThreshold: opts.maskThreshold } : {}),
        ...(opts.maxDetections !== undefined ? { maxDetections: opts.maxDetections } : {}),
        ...(opts.classFilter ? { classFilter: opts.classFilter } : {}),
        tracePolygons: true,
        traceOptions: {
          ...(opts.simplifyTolerance !== undefined
            ? { simplifyTolerance: opts.simplifyTolerance }
            : {}),
          ...(opts.minArea !== undefined ? { minArea: opts.minArea } : {}),
        },
        onTileProgress: (done, total) =>
          progress?.onStatus?.(
            done < total ? `Running inference (tile ${done}/${total})…` : 'Tracing outlines…',
          ),
      },
    );

    // Detections without geometry are dropped rather than surfaced as empty
    // regions — a detection whose mask vanished under thresholding has nothing
    // meaningful to draw or edit.
    const detections: InstanceDetection[] = [];
    for (const d of result.detections) {
      if (!d.polygons || d.polygons.length === 0) continue;
      detections.push({
        polygons: d.polygons.map((p) => ({
          exterior: p.exterior.map(([x, y]): [number, number] => [x, y]),
          holes: p.holes.map((h) => h.map(([x, y]): [number, number] => [x, y])),
        })),
        box: [d.box[0], d.box[1], d.box[2], d.box[3]],
        score: d.score,
        classId: d.classId,
        className: d.className ?? `class${d.classId}`,
      });
    }

    return {
      detections,
      width: result.width,
      height: result.height,
      classNames: result.classNames,
    };
  }

  /**
   * The shared segmenter for a model id, created on first use and reused
   * thereafter (deduped across concurrent callers). Exposed so a host's
   * processing pipeline can drive richer `segment()` options on the same loaded
   * session instead of loading the model twice.
   */
  getModel(
    modelId: string = getDefaultYoloModelId(),
    onProgress?: (loaded: number, total: number | null) => void,
    onStatus?: (status: string) => void,
  ): Promise<YoloSegmenter> {
    const existing = this.instances.get(modelId);
    if (existing) return Promise.resolve(existing);

    const inFlight = this.loading.get(modelId);
    if (inFlight) return inFlight;

    const def = this.requireModel(modelId);
    const load = (async () => {
      // Lazy: keep yolo-segdetect-js + its ORT runtime out of the initial bundle.
      const { YoloSegmenter, configureOrt } = await import('yolo-segdetect-js');
      configureOrt({ wasmPaths: getOrtWasmBase() });
      const seg = await YoloSegmenter.fromPretrained(def.modelUrl, {
        preload: true,
        ...(def.metaUrl ? { metaUrl: def.metaUrl } : {}),
        onProgress: ({ loaded, total }) => onProgress?.(loaded, total),
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
  isLoaded(modelId: string = getDefaultYoloModelId()): boolean {
    return this.instances.has(modelId);
  }

  /** Release one model, or all of them. Safe to call on a model never loaded. */
  async dispose(modelId?: string): Promise<void> {
    const ids = modelId ? [modelId] : [...this.instances.keys()];
    for (const id of ids) {
      const seg = this.instances.get(id);
      this.instances.delete(id);
      this.loading.delete(id);
      if (seg) await seg.dispose();
    }
  }

  private requireModel(modelId: string): YoloModelDef {
    const def = getYoloModel(modelId);
    if (!def) throw new Error(`Unknown YOLO model id "${modelId}".`);
    if (!def.modelUrl.trim()) {
      throw new Error(`YOLO model "${modelId}" is not configured — its modelUrl is empty.`);
    }
    return def;
  }
}
