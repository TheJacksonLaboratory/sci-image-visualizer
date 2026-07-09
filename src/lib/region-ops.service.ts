import { Injectable } from '@angular/core';

import { Region, Rectangle, Polygon, MultiPolygon } from './models/region';
import { BBoxMask, unionMasks, simplifyRing } from './models/geometry';
import { WandService } from './toolbar/wand/wand.service';

/**
 * Pure (DOM-free) region set-operations — merge / inverse / ungroup (jit-ui#85).
 *
 * Raster-based, reusing the wand/brush mask pipeline
 * ({@link WandService.rasterizePolygon} → {@link WandService.maskToPolygons}),
 * so "select + merge" yields the same geometry as brushing regions together:
 * one engine, one set of behaviours, holes + multi-part results for free.
 *
 * Every method takes the current regions plus the image dimensions and returns
 * new {@link Region}(s); it never mutates the store. Callers commit the result
 * through the normal region-write path (so undo/redo applies). Coordinates are
 * image pixels throughout.
 */
@Injectable({ providedIn: 'root' })
export class RegionOpsService {
  /**
   * Largest raster (in pixels) a region set-op will allocate on the main thread.
   * Selections whose clipped bbox exceeds this are rasterized at a proportional
   * downscale (then the traced geometry is scaled back), so merge/inverse stay
   * responsive on gigapixel slides. ~16 MP keeps the synchronous contour trace
   * well under a second; the downscale only affects boundary fidelity of very
   * large-extent selections (small selections keep full resolution).
   */
  private static readonly MAX_OP_PIXELS = 16_000_000;

  constructor(private wand: WandService) {}

  /**
   * Geometric union of `regions` into a single region: a {@link Polygon} when
   * the union is one connected piece, a {@link MultiPolygon} when it stays
   * disjoint, with holes preserved. Returns null when nothing rasterises (e.g.
   * only open polylines were selected).
   */
  merge(regions: Region[], imageWidth: number, imageHeight: number): Region | null {
    // The raster is bounded by the selection's bbox, not the image — but on a
    // whole-slide image a large-extent selection still spans billions of pixels,
    // which freezes (or overflows the typed-array limit) on the main thread.
    // Rasterize at a capped resolution and scale the traced polygons back up.
    const scale = this.opRasterScale(regions, imageWidth, imageHeight);
    const mask = this.unionMask(regions, imageWidth, imageHeight, scale);
    if (!mask) return null;
    const sw = Math.max(1, Math.round(imageWidth * scale));
    const sh = Math.max(1, Math.round(imageHeight * scale));
    let polys = this.wand.maskToPolygons(mask.mask, mask.bw, mask.bh, sw, sh, mask.bx, mask.by, 1, 1);
    if (scale !== 1) polys = polys.map((p) => this.scalePolygon(p, 1 / scale));
    return this.regionFromParts(polys, regions[0]);
  }

  /** Downscale factor (≤ 1) keeping the selection's clipped bbox within
   *  {@link MAX_OP_PIXELS}; 1 when it already fits. */
  private opRasterScale(regions: Region[], W: number, H: number): number {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const scan = (xs: number[], ys: number[]) => {
      for (const x of xs) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
      for (const y of ys) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    };
    for (const r of regions || []) {
      const b = r?.bounds;
      if (b instanceof Rectangle) scan([b.x, b.x + b.width], [b.y, b.y + b.height]);
      else if (b instanceof Polygon) scan(b.xpoints, b.ypoints);
      else if (b instanceof MultiPolygon) for (const p of b.polygons) scan(p.xpoints, p.ypoints);
    }
    if (!Number.isFinite(minX)) return 1;
    const bw = Math.min(W, maxX) - Math.max(0, minX);
    const bh = Math.min(H, maxY) - Math.max(0, minY);
    const area = bw * bh;
    if (!(area > RegionOpsService.MAX_OP_PIXELS)) return 1;
    return Math.sqrt(RegionOpsService.MAX_OP_PIXELS / area);
  }

  /** A copy of `p` with every coordinate (and hole coordinate) multiplied by `s`. */
  private scalePolygon(p: Polygon, s: number): Polygon {
    const poly = new Polygon();
    poly.xpoints = p.xpoints.map((x) => x * s);
    poly.ypoints = p.ypoints.map((y) => y * s);
    poly.npoints = poly.xpoints.length;
    poly.closed = p.closed;
    poly.coordinates = poly.xpoints.map((x, i) => [x, poly.ypoints[i]]);
    if (p.holes) poly.holes = p.holes.map((ring) => ring.map(([x, y]) => [x * s, y * s]));
    return poly;
  }

  /**
   * Replace `regions` with their inverse inside the image rectangle: the image
   * minus the selection's union (the former regions become holes). Returns null
   * for a degenerate image or an empty selection.
   *
   * Done *vectorially* so it scales to gigapixel images: the selection is
   * unioned first (raster, bounded by the ROIs' extent — never the whole image),
   * then the result is the image rectangle as the exterior with each union
   * component's outline punched out as a hole. A component's own hole (a donut)
   * becomes a solid island part. Only the image's corner coordinates are used —
   * no full-image buffer is ever allocated.
   */
  inverse(regions: Region[], imageWidth: number, imageHeight: number): Region | null {
    if (imageWidth <= 0 || imageHeight <= 0) return null;
    const merged = this.merge(regions, imageWidth, imageHeight);
    if (!merged) return null;
    const comps: Polygon[] = merged.bounds instanceof MultiPolygon
      ? merged.bounds.polygons
      : merged.bounds instanceof Polygon ? [merged.bounds] : [];
    if (comps.length === 0) return null;

    // Image rectangle exterior with every component outline as a hole.
    const rect = this.ringPolygon(
      [0, imageWidth, imageWidth, 0], [0, 0, imageHeight, imageHeight]);
    rect.holes = comps.map((c) => c.xpoints.map((x, i) => [x, c.ypoints[i]]));

    // Each component's own hole (donut interior) is *outside* the region, so it
    // stays solid in the inverse — emit it as its own island part.
    const parts: Polygon[] = [rect];
    for (const c of comps) {
      if (c.holes) {
        for (const ring of c.holes) {
          parts.push(this.ringPolygon(ring.map((p) => p[0]), ring.map((p) => p[1])));
        }
      }
    }
    const bounds = parts.length === 1 ? parts[0] : Object.assign(new MultiPolygon(), { polygons: parts });
    return this.makeRegion(bounds, regions[0]);
  }

  /** A closed straight-edged Polygon from parallel coord arrays. */
  private ringPolygon(xs: number[], ys: number[]): Polygon {
    const p = new Polygon();
    p.xpoints = xs.slice();
    p.ypoints = ys.slice();
    p.npoints = xs.length;
    p.coordinates = xs.map((x, i) => [x, ys[i]]);
    p.closed = true;
    return p;
  }

  /**
   * Split a region into its disjoint parts — one region per {@link MultiPolygon}
   * part. A single connected {@link Polygon}/{@link Rectangle} has nothing to
   * split and is returned unchanged (as a one-element list).
   */
  ungroup(region: Region): Region[] {
    const b = region.bounds;
    if (b instanceof MultiPolygon) {
      return b.polygons
        .filter((p) => p.xpoints.length >= 3)
        .map((p) => this.makeRegion(this.clonePolygon(p), region));
    }
    return [region];
  }

  /** True when ungrouping `region` would actually split it (≥2 parts). */
  canUngroup(region: Region): boolean {
    return region.bounds instanceof MultiPolygon && region.bounds.polygons.length > 1;
  }

  /**
   * Simplify a region's outline(s) with Douglas–Peucker — drop vertices within
   * `altitudePx` pixels of the line between their kept neighbours. Applies to
   * the exterior and every hole, of a polygon or each part of a MultiPolygon; a
   * ring that would degenerate below a triangle is left at its previous detail
   * (the part/hole is kept, not dropped). Rectangles and open polylines are
   * returned unchanged. Result is always a straight-edged polygon (any Bézier
   * smoothing is dropped, since the anchor set changes).
   */
  simplify(region: Region, altitudePx: number): Region {
    const b = region.bounds;
    if (!(altitudePx > 0)) return region;
    if (b instanceof Polygon && b.closed !== false) {
      return this.makeRegion(this.simplifyPolygon(b, altitudePx), region);
    }
    if (b instanceof MultiPolygon) {
      const mp = new MultiPolygon();
      mp.polygons = b.polygons.map((p) => this.simplifyPolygon(p, altitudePx));
      return this.makeRegion(mp, region);
    }
    return region;
  }

  /** Douglas–Peucker the exterior + each hole of one polygon. A ring that
   *  collapses below 3 vertices keeps its original points (never degenerates). */
  private simplifyPolygon(p: Polygon, eps: number): Polygon {
    const keepOrSrc = (xs: number[], ys: number[]): { xs: number[]; ys: number[] } => {
      const s = simplifyRing(xs, ys, eps);
      return s.xs.length >= 3 ? s : { xs: xs.slice(), ys: ys.slice() };
    };
    const ext = keepOrSrc(p.xpoints, p.ypoints);
    const poly = new Polygon();
    poly.npoints = ext.xs.length;
    poly.xpoints = ext.xs;
    poly.ypoints = ext.ys;
    poly.coordinates = ext.xs.map((x, i) => [x, ext.ys[i]]);
    poly.closed = true;
    if (p.holes) {
      const holes = p.holes.map((ring) => {
        const s = keepOrSrc(ring.map((q) => q[0]), ring.map((q) => q[1]));
        return s.xs.map((x, i) => [x, s.ys[i]]);
      });
      if (holes.length) poly.holes = holes;
    }
    return poly;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Union of every region's filled mask (exterior minus holes), or null.
   *  `scale` (≤ 1) downscales the raster for large selections; coordinates and
   *  the clip bounds are scaled to match. */
  private unionMask(regions: Region[], W: number, H: number, scale = 1): BBoxMask | null {
    let acc: BBoxMask | null = null;
    for (const region of regions || []) {
      const m = this.rasterizeRegion(region, W, H, scale);
      if (!m) continue;
      acc = acc ? unionMasks(acc, m) : m;
    }
    return acc;
  }

  /** Rasterise any region (rect / closed polygon / multi-polygon, holes punched
   *  out) into a bbox mask. Null for open polylines or degenerate geometry.
   *  `scale` (≤ 1) shrinks the coordinates and clip bounds for a downscaled raster. */
  private rasterizeRegion(region: Region, W: number, H: number, scale = 1): BBoxMask | null {
    const sw = scale === 1 ? W : Math.max(1, Math.round(W * scale));
    const sh = scale === 1 ? H : Math.max(1, Math.round(H * scale));
    const sc = (arr: number[]) => (scale === 1 ? arr : arr.map((v) => v * scale));
    const scHoles = (holes?: number[][][]) =>
      !holes || scale === 1 ? holes : holes.map((ring) => ring.map(([x, y]) => [x * scale, y * scale]));
    const b = region?.bounds;
    if (b instanceof Rectangle) {
      const xs = [b.x, b.x + b.width, b.x + b.width, b.x];
      const ys = [b.y, b.y, b.y + b.height, b.y + b.height];
      return this.wand.rasterizePolygon(sc(xs), sc(ys), sw, sh);
    }
    if (b instanceof Polygon) {
      if (b.closed === false || b.xpoints.length < 3) return null;
      return this.wand.rasterizePolygon(sc(b.xpoints), sc(b.ypoints), sw, sh, scHoles(b.holes));
    }
    if (b instanceof MultiPolygon) {
      let acc: BBoxMask | null = null;
      for (const part of b.polygons) {
        if (part.xpoints.length < 3) continue;
        const m = this.wand.rasterizePolygon(sc(part.xpoints), sc(part.ypoints), sw, sh, scHoles(part.holes));
        if (m) acc = acc ? unionMasks(acc, m) : m;
      }
      return acc;
    }
    return null;
  }

  /** Wrap traced parts as one region (Polygon if single, else MultiPolygon),
   *  inheriting colour/label from `proto`. Null when there are no parts. */
  private regionFromParts(polys: Polygon[], proto: Region | undefined): Region | null {
    if (!polys || polys.length === 0) return null;
    if (polys.length === 1) return this.makeRegion(polys[0], proto);
    const mp = new MultiPolygon();
    mp.polygons = polys;
    return this.makeRegion(mp, proto);
  }

  private makeRegion(bounds: Polygon | MultiPolygon, proto: Region | undefined): Region {
    const r = new Region();
    r.bounds = bounds;
    r.color = proto?.color;
    r.label = proto?.label ?? 'Region';
    return r;
  }

  private clonePolygon(p: Polygon): Polygon {
    const poly = new Polygon();
    poly.npoints = p.npoints;
    poly.xpoints = p.xpoints.slice();
    poly.ypoints = p.ypoints.slice();
    poly.coordinates = p.coordinates.map((c) => c.slice());
    poly.closed = p.closed;
    poly.bezier = p.bezier;
    if (p.holes) poly.holes = p.holes.map((ring) => ring.map((pt) => pt.slice()));
    return poly;
  }
}
