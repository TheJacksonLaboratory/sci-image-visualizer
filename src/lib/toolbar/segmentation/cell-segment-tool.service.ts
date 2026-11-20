import { Injectable } from '@angular/core';

import { CanvasToolHost } from '../tool-kit/canvas-tool';
import { cropImageRegion } from '../crop/slide-crop';
import { ICellSegmenter } from '../../contracts/cell-segmenter.contract';
import type { IVisualizer } from '../../contracts/visualizer.contract';
import type { TileAccessPort } from '../../contracts/ports/tile-access.port';
import { Region, Rectangle } from '../../models/region';
import { regionBBox } from '../../region-overlay/region-geometry';
import { makePolygon } from '../../models/polygon-factory';
import { labelsToPolygons } from '../../geometry/contour';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { AsyncToolStatus } from '../tool-kit/async-tool-status';
import { withoutRegions } from './segmentation-commit';
import { ImageRect, ViewSource, sampleViewAtScale } from './view-at-scale';

/** Marks the regions Cellpose produced, so a re-run over the same area replaces them. */
export const CELLPOSE_REGION_SOURCE = 'cellpose';

/** The cell diameter, in pixels, cellpose-SAM segments best (its training median). */
export const CELLPOSE_TARGET_DIAMETER_PX = 30;

/** Options of a Cellpose run. */
export interface CellSegmentRunOptions {
  /**
   * Typical cell diameter in full-resolution image pixels. The view is sampled, and
   * each crop rescaled, so cells reach the segmenter at about
   * {@link CELLPOSE_TARGET_DIAMETER_PX}. Omitted or 0: the pixels as displayed.
   */
  diameterPx?: number | null;
  /**
   * Identity of what is being segmented — the image and slice on screen. Read at the
   * start of the run and again before its cells are committed: a different value
   * means the user moved to another image or slice meanwhile, and the result,
   * which belongs to the old one, is discarded rather than written into the new
   * one's regions.
   */
  context?: () => string;
}

/** Options of a whole-view Cellpose run. */
export interface CellSegmentViewOptions extends CellSegmentRunOptions {
  /** Server-side crop, so a zoomed-out view is segmented at the cells' scale. */
  tileAccess?: TileAccessPort | null;
  /** Slice of a stack the server crop is taken from: the one on screen. */
  zIndex?: number;
  /** Pixel cap of the segmented image. Default 2048². */
  maxPixels?: number;
}

/** What a whole-view run reads and writes: a backend's view pixels and its regions. */
export type CellViewTarget = ViewSource & Pick<IVisualizer, 'getRegions' | 'setRegions'>;

const STALE_STATUS = 'The image or slice changed during the run: nothing was added.';

/** Yield to the event loop (a macrotask) so the toast can repaint the latest
 *  status / animate the spinner before the next main-thread-blocking step. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Automatic cell segmentation inside drawn boxes (jit-ui#90), or over the whole view
 * ({@link CellSegmentToolService.segmentView}). For each rectangle
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
  async segmentBoxes(
    host: CanvasToolHost,
    segmenter: ICellSegmenter,
    opts: CellSegmentRunOptions = {},
  ): Promise<number> {
    if (this.state.busy) return 0;
    const cached = host.getCachedImageData();
    if (!cached || cached.frames.length === 0) {
      this.status$.next('No image loaded.');
      return 0;
    }

    const rects = host.getRegions().filter((r) => r.bounds instanceof Rectangle);
    if (rects.length === 0) {
      this.status$.next(
        'Draw one or more rectangles, then run Cellpose — or run it with none to segment the view.',
      );
      return 0;
    }

    const frame = MatrixFrame.from(cached);
    const frameIdx = host.getActiveFrameIndex();
    const startContext = opts.context?.();
    // The crop is in readback pixels, `frame.rx` image pixels each: the diameter in them.
    const diameter = opts.diameterPx && opts.diameterPx > 0 ? opts.diameterPx / frame.rx : undefined;

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
          const crop = cropImageRegion(cached, frameIdx, {
            x0: b.x,
            y0: b.y,
            x1: b.x + b.width,
            y1: b.y + b.height,
          });
          if (!crop) continue;
          const seg = await segmenter.segmentCells(
            { data: crop.data, width: crop.width, height: crop.height },
            { onProgress: (f) => this.progress$.next(f), onStatus: (s) => this.status$.next(prefix + s) },
            { diameter },
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
        if (opts.context && opts.context() !== startContext) {
          this.status$.next(STALE_STATUS);
          return 0;
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
  /**
   * Segment every cell in the current view (sci-image-visualizer#97), at the scale the
   * model wants rather than the viewer's (#98): the view's extent, clipped to the
   * image, sampled so cells are about {@link CELLPOSE_TARGET_DIAMETER_PX} across —
   * re-cropped on the server when the view is zoomed out, averaged down when zoomed
   * in. The viewer's zoom does not change.
   *
   * Cells from an earlier run whose centre lies in the segmented area are replaced,
   * so re-running over the same area does not stack duplicates; cells elsewhere stay.
   * Returns the number of regions added; 0 (ignored) while a run is going.
   */
  async segmentView(
    viz: CellViewTarget,
    segmenter: ICellSegmenter,
    opts: CellSegmentViewOptions = {},
  ): Promise<number> {
    if (this.state.busy) return 0;
    if (!viz.getDisplayedPixelData?.()) {
      this.status$.next('No image on screen to segment.');
      return 0;
    }
    const startContext = opts.context?.();
    const added = await this.state.run(async () => {
      try {
        const diameterPx = opts.diameterPx && opts.diameterPx > 0 ? opts.diameterPx : null;
        // Cells this many image pixels across land at the target size. Never finer than
        // full resolution: smaller cells are upscaled by the segmenter instead.
        const targetFactor = diameterPx ? Math.max(1, diameterPx / CELLPOSE_TARGET_DIAMETER_PX) : undefined;
        this.status$.next('Reading the view…');
        await tick();
        const sample = await sampleViewAtScale(viz, {
          targetFactor,
          maxPixels: opts.maxPixels,
          tileAccess: opts.tileAccess,
          zIndex: opts.zIndex,
          onStatus: (s) => this.status$.next(s),
        });
        if (!sample) {
          this.status$.next('The view does not overlap the image.');
          return 0;
        }
        const seg = await segmenter.segmentCells(
          { data: sample.data, width: sample.width, height: sample.height },
          { onProgress: (f) => this.progress$.next(f), onStatus: (s) => this.status$.next(s) },
          { diameter: diameterPx ? diameterPx / sample.factorX : undefined },
        );
        this.status$.next('Tracing cells…');
        await tick();
        // Sample pixel -> full-resolution image pixel.
        const frame = MatrixFrame.from({
          ratios: [
            seg.width ? sample.rect.width / seg.width : sample.factorX,
            seg.height ? sample.rect.height / seg.height : sample.factorY,
          ],
          originX: sample.rect.x,
          originY: sample.rect.y,
        });
        const cells: Region[] = [];
        for (const poly of labelsToPolygons(seg.labels, seg.width, seg.height, 0, 0)) {
          const ring = frame.ringToData(poly.xpoints, poly.ypoints);
          cells.push(makeCellRegion(ring.xs, ring.ys, frame.holesToData(poly.holes)));
        }
        const hint = sample.coarse
          ? " Zoom in for finer detail: the view was segmented below the cells' best scale."
          : '';
        if (cells.length === 0) {
          this.status$.next('No cells found.' + hint);
          return 0;
        }
        if (opts.context && opts.context() !== startContext) {
          this.status$.next(STALE_STATUS);
          return 0;
        }
        // Commit against the regions as they are NOW: the run takes a while.
        const kept = (viz.getRegions() ?? []).filter((r) => !isCellposeRegionIn(r, sample.rect));
        viz.setRegions([...kept, ...cells]);
        this.status$.next(`Added ${cells.length} cell region(s).` + hint);
        return cells.length;
      } catch (err) {
        this.status$.next(err instanceof Error ? err.message : 'Cellpose segmentation failed.');
        return 0;
      }
    });
    return added ?? 0;
  }
}

/** An earlier Cellpose cell whose bounding-box centre lies in `rect`. */
function isCellposeRegionIn(r: Region, rect: ImageRect): boolean {
  if (r.source !== CELLPOSE_REGION_SOURCE) return false;
  const b = regionBBox(r);
  if (!b) return false;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height;
}

function makeCellRegion(
  xData: number[],
  yData: number[],
  holes: number[][][] | undefined,
  color?: string,
): Region {
  const region = new Region();
  region.bounds = makePolygon(xData, yData, { holes });
  // The source box's color, else the host default (box mode). A whole-view run leaves it
  // unset, so a preset for the 'cell' class decides.
  if (color) region.color = color;
  region.label = 'cell';
  region.source = CELLPOSE_REGION_SOURCE;
  return region;
}
