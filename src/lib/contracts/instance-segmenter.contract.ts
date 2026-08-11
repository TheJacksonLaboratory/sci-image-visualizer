import { InjectionToken } from '@angular/core';


/**
 * Port for an automatic **instance** segmenter — one that returns discrete,
 * classified objects rather than a per-pixel label map.
 *
 * This is a sibling of {@link ICellSegmenter}, not a replacement. Cellpose-style
 * segmenters produce one exclusive label per pixel, which is exactly right for
 * densely packed cells; a detector like YOLO produces overlapping instances,
 * each with its own class and confidence, and flattening those into a label map
 * would silently discard both the overlap and the classification. The two
 * outputs are genuinely different shapes, so they get different ports.
 *
 * Geometry is returned as polygon rings in **image pixels**, ready to become
 * {@link Region}s without a second conversion step.
 */

/** A closed ring; the last point is NOT a repeat of the first. */
export type InstanceRing = Array<[number, number]>;

/** One polygon with optional interior rings (donut holes). */
export interface InstancePolygon {
  exterior: InstanceRing;
  holes: InstanceRing[];
}

/** One detected object. */
export interface InstanceDetection {
  /**
   * Outline(s) of this instance. Usually one, but a mask that splits under
   * thresholding yields several — they all belong to the same detection.
   */
  polygons: InstancePolygon[];
  /** `[x1, y1, x2, y2]` in image pixels. */
  box: [number, number, number, number];
  /** Model confidence, 0..1. */
  score: number;
  classId: number;
  className: string;
}

export interface InstanceSegmentation {
  detections: InstanceDetection[];
  width: number;
  height: number;
  /** Class names indexed by class id, from the model's own metadata. */
  classNames: string[];
}

/**
 * Tunables for one run.
 *
 * Three separate thresholds are in play and they are easy to conflate:
 * `confidence` and `iouThreshold` act per tile, while `mergeThreshold` governs
 * the cross-tile reconciliation. They come from different stages of the
 * pipeline and are not interchangeable.
 */
export interface InstanceSegmentOptions {
  /** Which registered model to run. Defaults to the registry's default. */
  modelId?: string;
  /**
   * Scale to run at, as a divisor of full resolution — the same meaning the
   * server gives it.
   *
   * This is what puts objects at the size the checkpoint was trained on, and it
   * matters more than any threshold: run a detector at the wrong object scale
   * and it finds nothing. A caller that can re-crop the source (a tile-backed
   * viewer) should honour it rather than accepting whatever the display happens
   * to show.
   */
  downsamplingFactor?: number;
  /** Minimum detection confidence, per tile. */
  confidence?: number;
  /** NMS IoU within a single tile. */
  iouThreshold?: number;
  /** Intersection-over-smaller threshold for merging across tile seams. */
  mergeThreshold?: number;
  /** Tile overlap, percent. */
  overlapX?: number;
  overlapY?: number;
  /** Probability at which a mask pixel counts as inside. */
  maskThreshold?: number;
  /** Cap on detections per tile. */
  maxDetections?: number;
  /** Keep only these class ids; omit for all classes the model declares. */
  classFilter?: number[];
  /** Douglas-Peucker tolerance in pixels for outline simplification; 0 disables. */
  simplifyTolerance?: number;
  /** Drop instances whose outline area is below this, in square pixels. */
  minArea?: number;
  /**
   * Set false to detect boxes without assembling masks — substantially faster,
   * since mask assembly dominates the cost of a run. Detections then carry a
   * box and class but no outline, so nothing can be committed as a region.
   */
  withMasks?: boolean;
  /**
   * Abort an in-progress run.
   *
   * Cancellation is cooperative and checked at tile boundaries, so it takes
   * effect within roughly one tile rather than instantly — a `session.run()`
   * already in flight cannot be interrupted.
   */
  signal?: AbortSignal;
}

/**
 * Progress/status callbacks (all optional).
 *
 * Deliberately mirrors {@link CellSegmentProgress} in shape rather than importing
 * it — the two contracts stay independently versionable.
 */
export interface InstanceSegmentProgress {
  /** Model-download progress, 0..1 (first run only). */
  onProgress?: (fraction: number) => void;
  /**
   * Raw download byte counts, for hosts that render a size ("142 / 287 MB")
   * rather than a bare percentage. `total` is null when the response carried no
   * Content-Length.
   *
   * A fraction alone cannot be turned back into bytes, so a host given only
   * {@link onProgress} has to invent the numbers — which reads as "0 MB / 0 MB"
   * the moment it does.
   */
  onBytes?: (loaded: number, total: number | null) => void;
  /** Human-readable phase, e.g. 'Running inference (tile 3/8)…'. */
  onStatus?: (status: string) => void;
}

export interface IInstanceSegmenter {
  /** Detect and outline all instances in an RGBA image. */
  segmentInstances(
    image: { data: Uint8ClampedArray; width: number; height: number },
    opts?: InstanceSegmentOptions,
    progress?: InstanceSegmentProgress,
  ): Promise<InstanceSegmentation>;
}

/**
 * DI token for the automatic instance segmenter.
 *
 * **No default.** It used to fall back to an in-library YOLO service, and that
 * factory was what pulled `yolo-segdetect-js` into every bundle of this package
 * — which is not shippable while the checkpoints are closed. A host provides an
 * implementation (see `@jax-data-science/sci-image-visualizer-jax-tools`), or
 * nothing does and no tool needing it is registered.
 */
export const INSTANCE_SEGMENTER = new InjectionToken<IInstanceSegmenter>('INSTANCE_SEGMENTER');
