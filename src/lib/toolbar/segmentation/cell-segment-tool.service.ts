import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { WandService } from '../wand/wand.service';
import { WandToolHost } from '../wand/wand-tool.service';
import { cropImageRegion } from '../crop/slide-crop';
import { ICellSegmenter } from '../../contracts/cell-segmenter.contract';
import { Region, Polygon, Rectangle } from '../../models/region';

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

  readonly status$ = new BehaviorSubject<string>('');
  readonly busy$ = new BehaviorSubject<boolean>(false);
  readonly progress$ = new BehaviorSubject<number>(-1);

  constructor(private wandService: WandService) {}

  bindHost(host: WandToolHost): void { this.host = host; }

  /**
   * Crop + cellpose-segment every rectangle; append the cell regions and drop
   * the prompt rectangles that produced cells. Returns the number of regions added.
   */
  async segmentBoxes(segmenter: ICellSegmenter): Promise<number> {
    if (!this.host) return 0;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) { this.status$.next('No image loaded.'); return 0; }

    const regions = this.host.getRegions();
    const rects = regions.filter((r) => r.bounds instanceof Rectangle);
    if (rects.length === 0) {
      this.status$.next('Draw one or more rectangles, then run Cellpose.');
      return 0;
    }

    const rx = cached.ratios[0] || 1;
    const ry = cached.ratios[0] || 1;
    const ox = cached.originX ?? 0;
    const oy = cached.originY ?? 0;
    const frameIdx = this.host.getActiveFrameIndex();

    this.busy$.next(true);
    try {
      const masks: Region[] = [];
      const consumed = new Set<Region>();
      let added = 0;
      for (let i = 0; i < rects.length; i++) {
        const b = rects[i].bounds as Rectangle;
        this.status$.next(`Cellpose ${i + 1}/${rects.length}…`);
        const crop = cropImageRegion(
          cached, frameIdx, { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height },
        );
        if (!crop) continue;
        const seg = await segmenter.segmentCells(
          { data: crop.data, width: crop.width, height: crop.height },
          (f) => this.progress$.next(f),
        );
        const polys = this.wandService.labelsToPolygons(
          seg.labels, seg.width, seg.height, seg.width, seg.height, 0, 0,
        );
        if (polys.length === 0) continue;
        for (const poly of polys) {
          // crop-pixel → frame-matrix (offset by crop origin) → data coords.
          const xData = poly.xpoints.map((x) => ox + (crop.matrixX0 + x) * rx);
          const yData = poly.ypoints.map((y) => oy + (crop.matrixY0 + y) * ry);
          masks.push(this.makeRegion(xData, yData, rects[i].color)); // inherit the box's color
          added++;
        }
        consumed.add(rects[i]);
      }
      this.host.setRegions(regions.filter((r) => !consumed.has(r)).concat(masks));
      this.status$.next(added > 0 ? `Added ${added} cell region(s).` : 'No cells found.');
      return added;
    } catch (err) {
      this.status$.next(err instanceof Error ? err.message : 'Cellpose segmentation failed.');
      return 0;
    } finally {
      this.busy$.next(false);
      this.progress$.next(-1);
    }
  }

  private makeRegion(xData: number[], yData: number[], color?: string): Region {
    const poly = new Polygon();
    poly.npoints = xData.length;
    poly.xpoints = xData;
    poly.ypoints = yData;
    poly.coordinates = xData.map((x, i) => [x, yData[i]]);
    poly.closed = true;
    const region = new Region();
    region.bounds = poly;
    // Inherit the source box's color; fall back to the host default.
    region.color = color || this.host.getShapeColor();
    region.label = 'cell';
    return region;
  }
}
