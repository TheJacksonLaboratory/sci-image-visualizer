import { Injectable } from '@angular/core';
import { Polygon } from '../../models/region';
import { BBoxMask, rasterizePolygon } from '../../geometry/raster';
import { dropVerticesWithinRadius, pointInPolygonWithHoles, pointInRing } from '../../geometry/ring';
import { labelsToPolygons, maskToPolygons } from '../../geometry/contour';
import {
  WandImage, WandOptions, WandPatchMask, computeWandPatchMask, computeWandRegion,
} from './wand-region-grow';

// The wand option/type/image shapes live with the pure pipeline (the option
// shapes canonically in contracts/display-types); re-exported here so existing
// internal imports keep working.
export type { WandImage, WandOptions, WandPatchMask, WandType } from './wand-region-grow';

/**
 * Thin DI façade over the wand's pure modules, kept for one release so the
 * injected consumers (the canvas tools, the backends) keep compiling.
 *
 * - region grow: `toolbar/wand/wand-region-grow`
 * - rasterizer: `geometry/raster`; ring tests: `geometry/ring`
 * - contour tracing: `geometry/contour`
 *
 * @deprecated Import the pure functions instead; this service will be removed.
 */
@Injectable({ providedIn: 'root' })
export class WandService {

  /** See {@link computeWandRegion} in `toolbar/wand/wand-region-grow`. */
  computeRegion(image: WandImage, cx: number, cy: number, options: WandOptions = {}): Polygon | null {
    return computeWandRegion(image, cx, cy, options);
  }

  /** See {@link computeWandPatchMask} in `toolbar/wand/wand-region-grow`. */
  public computePatchMask(image: WandImage, cx: number, cy: number,
                          options: WandOptions = {}): WandPatchMask | null {
    return computeWandPatchMask(image, cx, cy, options);
  }

  /** Ray-cast point-in-ring test; see {@link pointInRing}. */
  public pointInPolygon(px: number, py: number, xpoints: number[], ypoints: number[]): boolean {
    return pointInRing(px, py, xpoints, ypoints);
  }

  /** See {@link dropVerticesWithinRadius} in `geometry/ring`. */
  public dropVerticesWithinRadius(xpoints: number[], ypoints: number[],
                                  cx: number, cy: number, radius: number)
    : { xpoints: number[]; ypoints: number[]; removed: number } {
    return dropVerticesWithinRadius(xpoints, ypoints, cx, cy, radius);
  }

  /** See {@link rasterizePolygon} in `geometry/raster`. */
  public rasterizePolygon(xpoints: number[], ypoints: number[],
                          imageWidth: number, imageHeight: number,
                          holes?: number[][][]): BBoxMask | null {
    return rasterizePolygon(xpoints, ypoints, imageWidth, imageHeight, holes);
  }

  /** See {@link pointInPolygonWithHoles} in `geometry/ring`. */
  public pointInPolygonWithHoles(px: number, py: number, xpoints: number[], ypoints: number[],
                                 holes?: number[][][]): boolean {
    return pointInPolygonWithHoles(px, py, xpoints, ypoints, holes);
  }

  /** See {@link maskToPolygons} in `geometry/contour`. */
  public maskToPolygons(mask: Uint8Array, w: number, h: number,
                        originX: number, originY: number, minSize = 4,
                        minHoleSize = minSize): Polygon[] {
    return maskToPolygons(mask, w, h, originX, originY, minSize, minHoleSize);
  }

  /** See {@link labelsToPolygons} in `geometry/contour`. */
  public labelsToPolygons(labels: Uint32Array, w: number, h: number,
                          originX: number, originY: number, minSize = 10): Polygon[] {
    return labelsToPolygons(labels, w, h, originX, originY, minSize);
  }
}
