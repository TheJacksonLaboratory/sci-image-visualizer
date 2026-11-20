import { Injectable } from '@angular/core';

import { CanvasToolHost } from '../tool-kit/canvas-tool';
import { cropImageRegion } from '../crop/slide-crop';
import { ICellSegmenter } from '../../contracts/cell-segmenter.contract';
import type { IVisualizer } from '../../contracts/visualizer.contract';
import type { TileAccessPort } from '../../contracts/ports/tile-access.port';
import { Polygon, Region, Rectangle } from '../../models/region';
import { regionBBox } from '../../region-overlay/region-geometry';
import { makePolygon } from '../../models/polygon-factory';
import { labelsToPolygons } from '../../geometry/contour';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { AsyncToolStatus } from '../tool-kit/async-tool-status';
import { withoutRegions } from './segmentation-commit';
import { ImageRect, ViewSource, captureView, sampleCaptureRect } from './view-at-scale';
import { smoothPixelRing } from '../../geometry/smooth-ring';

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
  /**
   * Largest view area, in full-resolution image pixels, segmented at full resolution.
   * A larger view is read coarser. Default {@link CELLPOSE_MAX_VIEW_PIXELS}.
   */
  maxPixels?: number;
}

/** Full-resolution view area (36 MP, e.g. 6000²) segmented at full resolution. */
export const CELLPOSE_MAX_VIEW_PIXELS = 36_000_000;

/**
 * Pixels the network sees in one whole-view run, once cells are brought to
 * {@link CELLPOSE_TARGET_DIAMETER_PX} (about 600 of its 256² tiles). A view whose cells
 * would need more is segmented with smaller cells than the network's best size.
 */
export const CELLPOSE_MAX_NETWORK_PIXELS = 40_000_000;

/** Tile side in sample pixels: the largest that cellpose-js may rescale (4096² limit). */
const MAX_TILE_SIDE = 2048;
const MIN_TILE_SIDE = 512;

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
            const smooth = smoothPolygon(poly);
            const ring = frame.ringToData(smooth.xs, smooth.ys);
            const color = rects[i].color || host.getShapeColor();
            cells.push(makeCellRegion(ring.xs, ring.ys, frame.holesToData(smooth.holes), color));
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
   * Segment every cell in the current view (sci-image-visualizer#97) at the cells'
   * scale rather than the zoom's (#98). The viewer's zoom does not change.
   *
   * - **Full-resolution masks.** The view (clipped to the image) is read at full
   *   resolution — re-cropped on the server when zoomed out, averaged down when zoomed
   *   in — and the segmenter is told the cell diameter, so it runs its network at the
   *   cells' best size but returns masks at full resolution. A view larger than
   *   `maxPixels` is read coarser.
   * - **Tiles.** The view is segmented in overlapping tiles (each as large as the
   *   segmenter can rescale); a cell belongs to the tile whose core holds its centre,
   *   so cells on a seam are kept once, whole.
   * - **Smooth outlines.** Each mask outline is smoothed off its pixel staircase.
   *
   * When the view's cells would need more than {@link CELLPOSE_MAX_NETWORK_PIXELS}, or
   * the view could not be read at its scale, the result says to zoom in.
   *
   * Cells from an earlier run whose centre lies in the view are replaced, so re-running
   * does not stack duplicates; cells elsewhere stay. Returns the number of regions
   * added; 0 (ignored) while a run is going.
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
    const stale = () => !!opts.context && opts.context() !== startContext;
    const added = await this.state.run(async () => {
      try {
        this.status$.next('Reading the view…');
        await tick();
        const capture = captureView(viz);
        if (!capture) {
          this.status$.next('The view does not overlap the image.');
          return 0;
        }
        const plan = planViewTiles(capture.rect, capture.width, opts.diameterPx ?? null, opts.maxPixels);
        let coarse = plan.coarse;
        const cells: Region[] = [];
        for (let i = 0; i < plan.tiles.length; i++) {
          const tile = plan.tiles[i];
          const prefix = plan.tiles.length > 1 ? `Tile ${i + 1}/${plan.tiles.length}: ` : '';
          const sample = await sampleCaptureRect(capture, tile.rect, plan.factor, {
            tileAccess: opts.tileAccess,
            zIndex: opts.zIndex,
            onStatus: (s) => this.status$.next(prefix + s),
          });
          coarse ||= sample.coarse;
          const seg = await segmenter.segmentCells(
            { data: sample.data, width: sample.width, height: sample.height },
            { onProgress: (f) => this.progress$.next(f), onStatus: (s) => this.status$.next(prefix + s) },
            // In this sample's pixels (a failed server crop leaves coarser screen pixels).
            { diameter: plan.diameterPx ? (plan.diameterPx * plan.shrink) / sample.factorX : undefined },
          );
          if (stale()) break;
          this.status$.next(`${prefix}Tracing cells…`);
          await tick();
          // Sample pixel -> full-resolution image pixel.
          const frame = MatrixFrame.from({
            ratios: [sample.rect.width / seg.width, sample.rect.height / seg.height],
            originX: sample.rect.x,
            originY: sample.rect.y,
          });
          for (const poly of labelsToPolygons(seg.labels, seg.width, seg.height, 0, 0)) {
            const smooth = smoothPolygon(poly);
            const ring = frame.ringToData(smooth.xs, smooth.ys);
            const cell = makeCellRegion(ring.xs, ring.ys, frame.holesToData(smooth.holes));
            if (centreIn(cell, tile.core, tile.lastX, tile.lastY)) cells.push(cell);
          }
        }
        if (stale()) {
          this.status$.next(STALE_STATUS);
          return 0;
        }
        const hint = coarse
          ? " Zoom in for finer detail: the view was segmented below the cells' best scale."
          : '';
        if (cells.length === 0) {
          this.status$.next('No cells found.' + hint);
          return 0;
        }
        // Commit against the regions as they are NOW: the run takes a while.
        const kept = (viz.getRegions() ?? []).filter((r) => !isCellposeRegionIn(r, capture.rect));
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

/** One tile of a whole-view run: the area segmented, and the core whose cells it keeps. */
export interface ViewTile {
  rect: ImageRect;
  core: ImageRect;
  /** The core is the last in its row / column: its far edge is inclusive. */
  lastX: boolean;
  lastY: boolean;
}

/** How a whole-view run reads and splits the view. */
export interface ViewTilePlan {
  /** Image pixels per sample pixel (1 = full resolution). */
  factor: number;
  /** Cell diameter in full-resolution pixels, or null to segment as displayed. */
  diameterPx: number | null;
  /** ≥ 1: the diameter handed to the segmenter is scaled up by this, so its network sees
   *  smaller cells (fewer pixels) when the view's cells would exceed the network budget. */
  shrink: number;
  tiles: ViewTile[];
  /** The view is read below the cells' best scale. */
  coarse: boolean;
}

/**
 * Plan a whole-view run over `rect` (full-resolution image pixels; `screenWidth` screen
 * pixels across). With a diameter: full resolution up to `maxPixels` of area, then
 * coarser; overlapping tiles sized so the segmenter's rescale of each stays within
 * 4096², with a margin of 1.5 cell diameters. Without one: the screen's own scale.
 */
export function planViewTiles(
  rect: ImageRect,
  screenWidth: number,
  diameterPx: number | null,
  maxPixels = CELLPOSE_MAX_VIEW_PIXELS,
): ViewTilePlan {
  const d = diameterPx && diameterPx > 0 ? diameterPx : null;
  const area = rect.width * rect.height;
  let factor: number;
  let shrink = 1;
  let coarse = false;
  if (d) {
    factor = Math.max(1, Math.sqrt(area / maxPixels));
    const network = area * (CELLPOSE_TARGET_DIAMETER_PX / d) ** 2;
    if (network > CELLPOSE_MAX_NETWORK_PIXELS) shrink = Math.sqrt(network / CELLPOSE_MAX_NETWORK_PIXELS);
    // Below the cells' scale when the sample is coarser than the network needs, or the
    // network gets smaller cells than its best size.
    coarse = factor > Math.max(1, d / CELLPOSE_TARGET_DIAMETER_PX) * 1.02 || shrink > 1.02;
  } else {
    factor = rect.width / screenWidth;
  }
  // The diameter the segmenter gets, in sample pixels; it rescales by 30 / that.
  const passed = d ? (d * shrink) / factor : CELLPOSE_TARGET_DIAMETER_PX;
  const side = Math.round(
    Math.min(MAX_TILE_SIDE, Math.max(MIN_TILE_SIDE, 4096 * Math.min(1, passed / CELLPOSE_TARGET_DIAMETER_PX))),
  );
  const margin = Math.ceil(Math.max(32, 1.5 * passed)) * factor;
  const sideImg = side * factor;
  const coreSide = Math.max(sideImg - 2 * margin, sideImg / 2);
  const nx = Math.max(1, Math.ceil(rect.width / coreSide));
  const ny = Math.max(1, Math.ceil(rect.height / coreSide));
  const cw = rect.width / nx;
  const ch = rect.height / ny;
  const tiles: ViewTile[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const core = { x: rect.x + i * cw, y: rect.y + j * ch, width: cw, height: ch };
      const x0 = Math.max(rect.x, core.x - margin);
      const y0 = Math.max(rect.y, core.y - margin);
      const x1 = Math.min(rect.x + rect.width, core.x + cw + margin);
      const y1 = Math.min(rect.y + rect.height, core.y + ch + margin);
      tiles.push({
        rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        core,
        lastX: i === nx - 1,
        lastY: j === ny - 1,
      });
    }
  }
  return { factor, diameterPx: d, shrink, tiles, coarse };
}

/** A cell's bounding-box centre lies in a tile core (half-open, closed on the view's far edges). */
function centreIn(r: Region, core: ImageRect, lastX: boolean, lastY: boolean): boolean {
  const b = regionBBox(r);
  if (!b) return false;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const inX = cx >= core.x && (lastX ? cx <= core.x + core.width : cx < core.x + core.width);
  const inY = cy >= core.y && (lastY ? cy <= core.y + core.height : cy < core.y + core.height);
  return inX && inY;
}

/** A traced polygon (pixel-edge rings) with its outer ring and holes smoothed. */
function smoothPolygon(poly: Polygon): { xs: number[]; ys: number[]; holes: number[][][] | undefined } {
  const outer = smoothPixelRing(poly.xpoints, poly.ypoints);
  const holes = poly.holes?.map((h) => {
    const r = smoothPixelRing(
      h.map((p) => p[0]),
      h.map((p) => p[1]),
    );
    return r.xs.map((x, k) => [x, r.ys[k]]);
  });
  return { xs: outer.xs, ys: outer.ys, holes };
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
