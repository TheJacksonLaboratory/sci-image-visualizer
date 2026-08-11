import { InjectionToken } from '@angular/core';


/**
 * Port for a **semantic** segmenter — one that assigns every pixel a class from
 * a fixed set, with no notion of separate objects.
 *
 * The third sibling of {@link ICellSegmenter} and {@link IInstanceSegmenter},
 * and genuinely a different shape from both. Cellpose separates touching
 * instances of one class; YOLO returns overlapping classified objects; this
 * returns *layers* — regions that tile the image, never overlap, and where two
 * disconnected patches of the same class are the same finding rather than two
 * objects. There is no confidence per object and no NMS, because there are no
 * objects.
 *
 * Results are delivered as polygon rings in **image pixels**, so a caller can
 * build {@link Region}s directly — the same currency the other two ports use.
 */

/** A closed ring; the last point is NOT a repeat of the first. */
export type SemanticRing = Array<[number, number]>;

/** One connected component of one class, with any interior voids. */
export interface SemanticRegion {
  exterior: SemanticRing;
  holes: SemanticRing[];
  classId: number;
  className: string;
  /** Area in pixels, holes already subtracted. */
  area: number;
}

export interface SemanticSegmentation {
  regions: SemanticRegion[];
  /** Total pixels assigned to each class, indexed by class id. */
  classAreas: number[];
  /** Class names indexed by class id, from the model's own metadata. */
  classNames: string[];
  width: number;
  height: number;
  /**
   * Fraction of pixels that met no class's threshold.
   *
   * Worth surfacing rather than discarding: these models are thresholded per
   * class rather than argmaxed, so a high value means the model was unsure
   * everywhere — which is the signature of wrong preprocessing (wrong input
   * scale, wrong greyscale) long before the polygons look obviously wrong.
   */
  unassignedFraction: number;
}

export interface SemanticSegmentOptions {
  /** Which registered model to run. Defaults to the registry's default. */
  modelId?: string;
  /**
   * Scale to run at, as a divisor of full resolution — the same meaning the
   * server gives it.
   *
   * Matters as much here as for a detector: these checkpoints were trained on
   * 40x or 20x patches, and a layer imaged at the wrong scale does not look
   * like the layer the model learned.
   */
  downsamplingFactor?: number;
  /**
   * Minimum probability for a pixel to be assigned to a class, default 0.5.
   *
   * Not a plain argmax. The reference worker thresholds each class channel
   * independently at 0.5; because the model's last layer is a softmax at most
   * one class can clear that, so this is argmax *plus a confidence floor* —
   * pixels where the winner is weak are left unassigned rather than forced into
   * the best of a bad set. Lowering it toward 0.25 approaches a true argmax and
   * visibly fattens every layer.
   */
  classThreshold?: number;
  /** Keep only these class ids; omit for everything except background. */
  classFilter?: number[];
  /** Douglas-Peucker tolerance in pixels for outline simplification; 0 disables. */
  simplifyTolerance?: number;
  /** Drop regions whose area is below this, in square pixels. */
  minArea?: number;
  /**
   * Cooperative cancellation, checked at patch boundaries — so it takes effect
   * within roughly one patch rather than instantly.
   */
  signal?: AbortSignal;
}

/** Progress/status callbacks (all optional). Mirrors {@link InstanceSegmentProgress}. */
export interface SemanticSegmentProgress {
  /** Model-download progress, 0..1 (first run only). */
  onProgress?: (fraction: number) => void;
  /**
   * Raw download byte counts, for hosts that render a size rather than a bare
   * percentage. `total` is null when the response carried no Content-Length.
   */
  onBytes?: (loaded: number, total: number | null) => void;
  /** Human-readable phase, e.g. 'Segmenting patch 3/8…'. */
  onStatus?: (status: string) => void;
}

export interface ISemanticSegmenter {
  /** Assign every pixel a class and return the resulting regions. */
  segmentSemantic(
    image: { data: Uint8ClampedArray; width: number; height: number },
    opts?: SemanticSegmentOptions,
    progress?: SemanticSegmentProgress,
  ): Promise<SemanticSegmentation>;
}

/**
 * DI token for the semantic segmenter.
 *
 * **No default.** It used to fall back to an in-library jax-ai-js service, and
 * that factory was what pulled `jax-ai-js` into every bundle of this package —
 * which is not shippable while the checkpoints are closed. A host provides an
 * implementation (see `@jax-data-science/sci-image-visualizer-jax-tools`), or
 * nothing does and no tool needing it is registered.
 */
export const SEMANTIC_SEGMENTER = new InjectionToken<ISemanticSegmenter>('SEMANTIC_SEGMENTER');
