import { InjectionToken, inject } from '@angular/core';

import { CellposeSegmenterService } from '../toolbar/segmentation/cellpose-segmenter.service';

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
 * library calls this on a client slide-crop of a drawn box. By default the
 * {@link CELL_SEGMENTER} token resolves to the library's own cellpose-js-backed
 * {@link CellposeSegmenterService} (so the toolbar Cellpose tool works out of the
 * box), but a host can override the token to supply a different implementation
 * (e.g. a server-side segmenter) (jit-ui#90).
 */
/** Progress/status callbacks for a segmentation run (all optional). */
export interface CellSegmentProgress {
  /** Model-download progress, 0..1 (first run only). */
  onProgress?: (fraction: number) => void;
  /** Human-readable phase, e.g. 'Running inference (tile 3/8)…'. */
  onStatus?: (status: string) => void;
}

export interface ICellSegmenter {
  /** Segment all cells in an RGBA image into an instance label map. */
  segmentCells(
    image: { data: Uint8ClampedArray; width: number; height: number },
    progress?: CellSegmentProgress,
  ): Promise<CellSegmentation>;
}

/**
 * DI token for the automatic cell segmenter. Defaults to the in-library
 * {@link CellposeSegmenterService} (cellpose-js, lazy-loaded); override it in the
 * host to swap implementations.
 */
export const CELL_SEGMENTER = new InjectionToken<ICellSegmenter>('CELL_SEGMENTER', {
  providedIn: 'root',
  factory: () => inject(CellposeSegmenterService),
});
