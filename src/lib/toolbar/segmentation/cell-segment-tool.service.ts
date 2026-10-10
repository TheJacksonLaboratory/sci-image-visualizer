import { Injectable } from '@angular/core';

import { CanvasToolHost } from '../tool-kit/canvas-tool';
import { cropImageRegion } from '../crop/slide-crop';
import { ICellSegmenter } from '../../contracts/cell-segmenter.contract';
import { Region, Rectangle } from '../../models/region';
import { makePolygon } from '../../models/polygon-factory';
import { labelsToPolygons } from '../../geometry/contour';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { AsyncToolStatus } from '../tool-kit/async-tool-status';
import { withoutRegions } from './segmentation-commit';

/** Yield to the event loop (a macrotask) so the toast can repaint the latest
 *  status / animate the spinner before the next main-thread-blocking step. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Automatic cell segmentation inside drawn boxes (jit-ui#90). For each rectangle
 * it client slide-crops the box from the loaded image, runs an automatic
 * segmenter (cellpose-SAM, supplied by the host via {@link ICellSegmenter}) on
 * the crop, and turns every cell instance into a region — offset back onto the
 * frame. The prompt rectangle is replaced by its cell regions.
 *
 * This is the complement to the promptable SAM tool: cellpose-SAM can't take a
 * box prompt, so the box just bounds the crop it segments automatically.
 */
@Injectable({ providedIn: 'root' })
export class CellSegmentToolService {
  private readonly state = new AsyncToolStatus();

  readonly status$ = this.state.status$;
  readonly busy$ = this.state.busy$;
  readonly progress$ = this.state.progress$;

  /**
   * Crop + cellpose-segment every rectangle of the backend behind `host`; append
   * the cell regions and drop the prompt rectangles that produced cells. Returns
   * the number of regions added; 0 (ignored) while a previous run is still going.
   * The host is passed per run, so no backend's host outlives its call.
   */
  async segmentBoxes(host: CanvasToolHost, segmenter: ICellSegmenter): Promise<number> {
    if (this.state.busy) return 0;
    const cached = host.getCachedImageData();
    if (!cached || cached.frames.length === 0) { this.status$.next('No image loaded.'); return 0; }

    const rects = host.getRegions().filter((r) => r.bounds instanceof Rectangle);
    if (rects.length === 0) {
      this.status$.next('Draw one or more rectangles, then run Cellpose.');
      return 0;
    }

    const frame = MatrixFrame.from(cached);
    const frameIdx = host.getActiveFrameIndex();

    const added = await this.state.run(async () => {
      try {
        const cells: Region[] = [];
        const consumed: Region[] = [];
        for (let i = 0; i < rects.length; i++) {
          const b = rects[i].bounds as Rectangle;
          // Prefix each phase with the box index when there's more than one.
          const prefix = rects.length > 1 ? `Box ${i + 1}/${rects.length}: ` : '';
          this.status$.next(`${prefix}Cropping…`);
          await tick(); // let the status paint before the (main-thread) crop
          const crop = cropImageRegion(
            cached, frameIdx, { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height },
          );
          if (!crop) continue;
          const seg = await segmenter.segmentCells(
            { data: crop.data, width: crop.width, height: crop.height },
            { onProgress: (f) => this.progress$.next(f), onStatus: (s) => this.status$.next(prefix + s) },
          );
          this.status$.next(`${prefix}Tracing cells…`);
          await tick(); // paint before the (main-thread) contour tracing
          // Crop-pixel → frame-matrix (offset by the crop origin) → data coords.
          const polys = labelsToPolygons(seg.labels, seg.width, seg.height, crop.matrixX0, crop.matrixY0);
          if (polys.length === 0) continue;
          for (const poly of polys) {
            const ring = frame.ringToData(poly.xpoints, poly.ypoints);
            const color = rects[i].color || host.getShapeColor();
            cells.push(makeCellRegion(ring.xs, ring.ys, frame.holesToData(poly.holes), color));
          }
          consumed.push(rects[i]);
        }
        // Commit against the regions as they are NOW (the run takes a while and
        // the user may have edited meanwhile): drop the consumed prompts by id.
        host.setRegions(withoutRegions(host.getRegions(), consumed).concat(cells));
        this.status$.next(cells.length > 0 ? `Added ${cells.length} cell region(s).` : 'No cells found.');
        return cells.length;
      } catch (err) {
        this.status$.next(err instanceof Error ? err.message : 'Cellpose segmentation failed.');
        return 0;
      }
    });
    return added ?? 0;
  }

}

function makeCellRegion(xData: number[], yData: number[], holes: number[][][] | undefined,
                        color: string): Region {
  const region = new Region();
  region.bounds = makePolygon(xData, yData, { holes });
  // The source box's color, else the host default.
  region.color = color;
  region.label = 'cell';
  return region;
}
