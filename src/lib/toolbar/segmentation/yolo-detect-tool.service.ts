import { Inject, Injectable, Optional } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { Region, Polygon, Rectangle } from '../../models/region';
import { TILE_ACCESS_PORT, type TileAccessPort } from '../../contracts/ports/tile-access.port';
import type { IVisualizer } from '../../contracts/visualizer.contract';
import type { IInstanceSegmenter, InstanceSegmentOptions } from '../../contracts/instance-segmenter.contract';

/**
 * YOLO object detection over the current view.
 *
 * The complement to {@link CellSegmentToolService}: cellpose auto-segments cells
 * inside a box you draw, whereas a detector is meant to find objects across a
 * field. So this takes no prompt — it runs on whatever is on screen and turns
 * every detection into a region.
 *
 * Detections come back in the displayed image's pixels; they are mapped onto
 * the full-resolution image through the viewer's own source rect, so the regions
 * land where the objects actually are rather than at view-local coordinates.
 *
 * Exposes the same `status$` / `busy$` / `progress$` surface as the cellpose
 * tool so the host's shared segmentation toast drives it unchanged.
 */
@Injectable({ providedIn: 'root' })
export class YoloDetectToolService {
  readonly status$ = new BehaviorSubject<string>('');
  readonly busy$ = new BehaviorSubject<boolean>(false);
  readonly progress$ = new BehaviorSubject<number>(-1);

  constructor(
    /** Server-side crop, so detection can run at the model's scale rather than
     *  the viewer's. Optional: without it the tool falls back to the displayed
     *  pixels, which is correct but scale-dependent. */
    @Optional() @Inject(TILE_ACCESS_PORT) private tileAccess: TileAccessPort | null = null,
  ) {}

  /**
   * Detect in the current view and append the results as regions.
   *
   * @returns the number of regions added.
   */
  async detectInView(
    viz: IVisualizer,
    segmenter: IInstanceSegmenter,
    opts: InstanceSegmentOptions = {},
  ): Promise<number> {
    const pixels = viz.getDisplayedPixelData?.();
    if (!pixels || pixels.width === 0 || pixels.height === 0) {
      this.status$.next('No image on screen to detect in.');
      return 0;
    }

    this.busy$.next(true);
    this.progress$.next(-1);
    try {
      const rect = viz.getDisplayedSourceRect?.() ?? null;
      const target = Number(opts.downsamplingFactor ?? 0) || 0;
      const viewFactor = rect && pixels.width > 0 ? rect.width / pixels.width : 1;

      // Re-crop at the model's scale when the view is coarser than it wants.
      // The image is tile-backed, so that detail exists server-side even though
      // the displayed pixels have discarded it.
      let source = { data: pixels.data, width: pixels.width, height: pixels.height };
      if (rect && target > 0 && target < viewFactor * 0.98) {
        this.status$.next('Fetching image at model resolution…');
        const hi = await this.fetchCropAtScale(rect, target);
        if (hi) source = hi;
      }

      const result = await segmenter.segmentInstances(source, opts, {
        onProgress: (f) => this.progress$.next(f),
        onStatus: (s) => this.status$.next(s),
      });

      // View pixels -> full-resolution image pixels. Without this every region
      // would sit at view-local coordinates, i.e. the wrong place on the slide
      // for any zoomed or panned view.
      const offsetX = rect ? rect.x : 0;
      const offsetY = rect ? rect.y : 0;
      // Against the pixels actually inferred on, which may be the re-crop.
      const ratioX = rect && source.width > 0 ? rect.width / source.width : 1;
      const ratioY = rect && source.height > 0 ? rect.height / source.height : 1;

      const added: Region[] = [];
      for (const det of result.detections) {
        if (det.polygons.length > 0) {
          for (const poly of det.polygons) {
            if (poly.exterior.length < 3) continue;
            added.push(
              this.makeRegion(
                poly.exterior.map(([x]) => Math.round(offsetX + x * ratioX)),
                poly.exterior.map(([, y]) => Math.round(offsetY + y * ratioY)),
                det.className,
              ),
            );
          }
          continue;
        }
        // Detection mode yields no outline; the box is still the result, and
        // matches what the server writes as a "detection" feature.
        const [x1, y1, x2, y2] = det.box;
        if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
        added.push(
          this.makeRegion(
            [x1, x2, x2, x1].map((x) => Math.round(offsetX + x * ratioX)),
            [y1, y1, y2, y2].map((y) => Math.round(offsetY + y * ratioY)),
            det.className,
          ),
        );
      }

      if (added.length === 0) {
        this.status$.next('No objects detected.');
        return 0;
      }

      // Append. A detection run must not discard annotations drawn by hand or
      // produced by another tool.
      viz.setRegions([...(viz.getRegions() ?? []), ...added]);
      this.status$.next(`Added ${added.length} region(s).`);
      return added.length;
    } catch (err) {
      this.status$.next(err instanceof Error ? err.message : 'YOLO detection failed.');
      return 0;
    } finally {
      this.busy$.next(false);
      this.progress$.next(-1);
    }
  }

  /**
   * Re-crop `rect` at `1/target` of full resolution. Returns null on any
   * failure, so the caller falls back to the displayed pixels — a coarser crop
   * beats a failed run.
   */
  private async fetchCropAtScale(
    rect: { x: number; y: number; width: number; height: number },
    target: number,
  ): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
    if (!this.tileAccess) return null;
    let w = Math.round(rect.width / target);
    let h = Math.round(rect.height / target);

    // A factor of 1 over a whole-slide ROI would ask for hundreds of megapixels.
    const MAX_PIXELS = 16_777_216; // 4096²
    const pixels = w * h;
    if (pixels > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / pixels);
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    if (w < 64 || h < 64) return null;

    try {
      const roi = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } as Rectangle;
      const screen = { x: 0, y: 0, width: w, height: h } as Rectangle;
      const bytes = await firstValueFrom(this.tileAccess.zoomOnRegion(roi, screen, 0));
      if (!bytes || bytes.byteLength === 0) return null;

      const bitmap = await createImageBitmap(new Blob([bytes]));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      const out = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close?.();
      return { data: out.data, width: bitmap.width, height: bitmap.height };
    } catch {
      return null;
    }
  }

  private makeRegion(xs: number[], ys: number[], className: string): Region {
    const poly = new Polygon();
    poly.npoints = xs.length;
    poly.xpoints = xs;
    poly.ypoints = ys;
    poly.coordinates = xs.map((x, i) => [x, ys[i]]);
    poly.closed = true;

    const region = new Region();
    region.bounds = poly;
    // The class name drives preset colour resolution; leaving `color` unset lets
    // an existing preset for this class win.
    region.label = className;
    return region;
  }
}
