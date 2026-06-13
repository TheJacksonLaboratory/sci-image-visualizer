import { InjectionToken } from '@angular/core';

/**
 * Result of an automatic cell segmenter: a per-pixel instance label map for the
 * input image (0 = background, 1..count = instances), row-major.
 */
export interface CellSegmentation {
  labels: Uint32Array;
  width: number;
  height: number;
  count: number;
}

/**
 * Port for an automatic (prompt-free) cell segmenter — e.g. cellpose-SAM. The
 * library calls this on a client slide-crop of a drawn box; the host (jit-ui)
 * implements it with cellpose-js. Kept as a DI port so the visualization library
 * stays free of any cellpose / onnx dependency (jit-ui#90).
 */
export interface ICellSegmenter {
  /** Segment all cells in an RGBA image into an instance label map. */
  segmentCells(
    image: { data: Uint8ClampedArray; width: number; height: number },
    onProgress?: (fraction: number) => void,
  ): Promise<CellSegmentation>;
}

export const CELL_SEGMENTER = new InjectionToken<ICellSegmenter>('CELL_SEGMENTER');
