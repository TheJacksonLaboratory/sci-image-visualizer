import { Injectable } from '@angular/core';

import { WandToolHost } from '../wand/wand-tool.service';
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
  private host!: WandToolHost;
  private readonly state = new AsyncToolStatus();

  readonly status$ = this.state.status$;
  readonly busy$ = this.state.busy$;
  readonly progress$ = this.state.progress$;

  bindHost(host: WandToolHost): void { this.host = host; }

  /**
   * Crop + cellpose-segment every rectangle; append the cell regions and drop
   * the prompt rectangles that produced cells. Returns the number of regions
   * added; 0 (ignored) while a previous run is still going.
   */
  async segmentBoxes(segmenter: ICellSegmenter): Promise<number> {
    if (!this.host || this.state.busy) return 0;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) { this.status$.next('No image loaded.'); return 0; }

    const rects = this.host.getRegions().filter((r) => r.bounds instanceof Rectangle);
    if (rects.length === 0) {
      this.status$.next('Draw one or more rectangles, then run Cellpose.');
      return 0;
    }

    const frame = MatrixFrame.from(cached);
    const frameIdx = this.host.getActiveFrameIndex();

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
            cells.push(this.makeRegion(ring.xs, ring.ys, frame.holesToData(poly.holes), rects[i].color));
          }
          consumed.push(rects[i]);
        }
        // Commit against the regions as they are NOW (the run takes a while and
        // the user may have edited meanwhile): drop the consumed prompts by id.
        this.host.setRegions(withoutRegions(this.host.getRegions(), consumed).concat(cells));
        this.status$.next(cells.length > 0 ? `Added ${cells.length} cell region(s).` : 'No cells found.');
        return cells.length;
      } catch (err) {
        this.status$.next(err instanceof Error ? err.message : 'Cellpose segmentation failed.');
        return 0;
      }
    });
    return added ?? 0;
  }

  private makeRegion(xData: number[], yData: number[], holes: number[][][] | undefined,
                     color?: string): Region {
    const region = new Region();
    region.bounds = makePolygon(xData, yData, { holes });
    // Inherit the source box's color; fall back to the host default.
    region.color = color || this.host.getShapeColor();
    region.label = 'cell';
    return region;
  }
}
