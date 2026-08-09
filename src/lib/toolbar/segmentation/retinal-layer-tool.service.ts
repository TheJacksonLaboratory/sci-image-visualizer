import { Inject, Injectable, Optional } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { Region, Polygon, Rectangle } from '../../models/region';
import { TILE_ACCESS_PORT, type TileAccessPort } from '../../contracts/ports/tile-access.port';
import type { IVisualizer } from '../../contracts/visualizer.contract';
import type {
  ISemanticSegmenter,
  SemanticSegmentOptions,
} from '../../contracts/semantic-segmenter.contract';

/** Marks regions this tool produced, so a re-run can replace only its own. */
export const RETINAL_REGION_SOURCE = 'retinal-layer';

/**
 * Retinal-layer segmentation over the current view.
 *
 * Sibling of {@link YoloDetectToolService}, and structured the same way: run on
 * whatever is on screen, map the results onto full-image coordinates through
 * the viewer's source rect, and commit them as regions. The difference is what
 * comes back — layers that tile the field rather than discrete objects, so
 * every region is one connected component of one layer and there is no
 * per-object confidence to filter on.
 *
 * Exposes the same `status$` / `busy$` / `progress$` surface as the cellpose and
 * YOLO tools so the host's shared segmentation toast drives it unchanged.
 */
@Injectable({ providedIn: 'root' })
export class RetinalLayerToolService {
  readonly status$ = new BehaviorSubject<string>('');
  readonly busy$ = new BehaviorSubject<boolean>(false);
  readonly progress$ = new BehaviorSubject<number>(-1);

  constructor(
    /** Server-side crop, so segmentation can run at the model's scale rather
     *  than the viewer's. Optional: without it the tool falls back to the
     *  displayed pixels, which is correct but scale-dependent. */
    @Optional() @Inject(TILE_ACCESS_PORT) private tileAccess: TileAccessPort | null = null,
  ) {}

  /**
   * Segment the current view and commit the layers as regions.
   *
   * @returns the number of regions added.
   */
  async segmentInView(
    viz: IVisualizer,
    segmenter: ISemanticSegmenter,
    opts: SemanticSegmentOptions = {},
  ): Promise<number> {
    const pixels = viz.getDisplayedPixelData?.();
    if (!pixels || pixels.width === 0 || pixels.height === 0) {
      this.status$.next('No image on screen to segment.');
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

      const result = await segmenter.segmentSemantic(source, opts, {
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

      // View pixels -> image pixels, for any ring.
      const mapRing = (ring: Array<[number, number]>): number[][] =>
        ring.map(([x, y]) => [Math.round(offsetX + x * ratioX), Math.round(offsetY + y * ratioY)]);

      const added: Region[] = [];
      for (const r of result.regions) {
        if (r.exterior.length < 3) continue;
        const exterior = mapRing(r.exterior);
        added.push(
          this.makeRegion(
            exterior.map(([x]) => x),
            exterior.map(([, y]) => y),
            r.className,
            // Holes are real findings here, not noise: a layer with a void
            // through it is a donut, and dropping the interior rings fills it
            // in silently. Rings that survive simplification to fewer than 3
            // points cannot bound anything, so they are skipped rather than
            // emitted as degenerate geometry.
            r.holes.filter((h) => h.length >= 3).map(mapRing),
          ),
        );
      }

      if (added.length === 0) {
        // Distinguish "found nothing" from "was unsure everywhere". The second
        // is the signature of wrong preprocessing or the wrong magnification,
        // and reads as a silent no-op unless it is said out loud.
        this.status$.next(
          result.unassignedFraction > 0.9
            ? 'No layers found — the model was unsure across the whole view. ' +
                'Check the magnification matches the model.'
            : 'No layers found.',
        );
        return 0;
      }

      // Replace this tool's own previous output, keep everything else.
      // Hand-drawn regions and other tools' output carry a different `source`
      // (or none) and are untouched.
      const kept = (viz.getRegions() ?? []).filter((x) => x.source !== RETINAL_REGION_SOURCE);
      viz.setRegions([...kept, ...added]);
      this.status$.next(`Added ${added.length} region(s).`);
      return added.length;
    } catch (err) {
      this.status$.next(err instanceof Error ? err.message : 'Retinal layer segmentation failed.');
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
      // Read the dimensions BEFORE close(): closing an ImageBitmap zeroes its
      // width/height, so returning them afterwards yields a 0x0 image with a
      // full pixel buffer — inference then runs on nothing and finds nothing.
      const width = bitmap.width;
      const height = bitmap.height;
      const out = ctx.getImageData(0, 0, width, height);
      bitmap.close?.();
      return { data: out.data, width, height };
    } catch {
      return null;
    }
  }

  private makeRegion(xs: number[], ys: number[], className: string, holes: number[][][] = []): Region {
    const poly = new Polygon();
    poly.npoints = xs.length;
    poly.xpoints = xs;
    poly.ypoints = ys;
    poly.coordinates = xs.map((x, i) => [x, ys[i]]);
    poly.closed = true;
    // Same closed-ring convention as the exterior: no repeated closing point.
    // Left unset when empty so a solid region does not carry an empty array
    // through export and round-tripping.
    if (holes.length) poly.holes = holes;

    const region = new Region();
    region.bounds = poly;
    region.source = RETINAL_REGION_SOURCE;
    // The class name drives preset colour resolution; leaving `color` unset lets
    // an existing preset for this layer win.
    region.label = className;
    return region;
  }
}
