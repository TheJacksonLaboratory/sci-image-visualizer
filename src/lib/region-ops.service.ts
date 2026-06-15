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
  /** Inverse rasterises the whole image rectangle; cap the mask so a gigapixel
   *  slide can't allocate an absurd buffer. ~64 MB at 1 byte/px. */
  private static readonly MAX_INVERSE_PIXELS = 64_000_000;

  constructor(private wand: WandService) {}

  /**
   * Geometric union of `regions` into a single region: a {@link Polygon} when
   * the union is one connected piece, a {@link MultiPolygon} when it stays
   * disjoint, with holes preserved. Returns null when nothing rasterises (e.g.
   * only open polylines were selected).
   */
  merge(regions: Region[], imageWidth: number, imageHeight: number): Region | null {
    const mask = this.unionMask(regions, imageWidth, imageHeight);
    if (!mask) return null;
    const polys = this.wand.maskToPolygons(
      mask.mask, mask.bw, mask.bh, imageWidth, imageHeight, mask.bx, mask.by, 1, 1);
    return this.regionFromParts(polys, regions[0]);
  }

  /**
   * Replace `regions` with their inverse inside the image rectangle: the image
   * minus the selection's union (the former regions become holes). Returns null
   * for a degenerate / oversized image (see {@link MAX_INVERSE_PIXELS}).
   */
  inverse(regions: Region[], imageWidth: number, imageHeight: number): Region | null {
    if (imageWidth <= 0 || imageHeight <= 0) return null;
    if (imageWidth * imageHeight > RegionOpsService.MAX_INVERSE_PIXELS) return null;
    const full = new Uint8Array(imageWidth * imageHeight).fill(1);
    const mask = this.unionMask(regions, imageWidth, imageHeight);
    if (mask) {
      for (let y = 0; y < mask.bh; y++) {
        const gy = mask.by + y;
        if (gy < 0 || gy >= imageHeight) continue;
        for (let x = 0; x < mask.bw; x++) {
          if (!mask.mask[y * mask.bw + x]) continue;
          const gx = mask.bx + x;
          if (gx >= 0 && gx < imageWidth) full[gy * imageWidth + gx] = 0;
        }
      }
    }
    const polys = this.wand.maskToPolygons(
      full, imageWidth, imageHeight, imageWidth, imageHeight, 0, 0, 1, 1);
    return this.regionFromParts(polys, regions[0]);
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

  /** Union of every region's filled mask (exterior minus holes), or null. */
  private unionMask(regions: Region[], W: number, H: number): BBoxMask | null {
    let acc: BBoxMask | null = null;
    for (const region of regions || []) {
      const m = this.rasterizeRegion(region, W, H);
      if (!m) continue;
      acc = acc ? unionMasks(acc, m) : m;
    }
    return acc;
  }

  /** Rasterise any region (rect / closed polygon / multi-polygon, holes punched
   *  out) into a bbox mask. Null for open polylines or degenerate geometry. */
  private rasterizeRegion(region: Region, W: number, H: number): BBoxMask | null {
    const b = region?.bounds;
    if (b instanceof Rectangle) {
      const xs = [b.x, b.x + b.width, b.x + b.width, b.x];
      const ys = [b.y, b.y, b.y + b.height, b.y + b.height];
      return this.wand.rasterizePolygon(xs, ys, W, H);
    }
    if (b instanceof Polygon) {
      if (b.closed === false || b.xpoints.length < 3) return null;
      return this.wand.rasterizePolygon(b.xpoints, b.ypoints, W, H, b.holes);
    }
    if (b instanceof MultiPolygon) {
      let acc: BBoxMask | null = null;
      for (const part of b.polygons) {
        if (part.xpoints.length < 3) continue;
        const m = this.wand.rasterizePolygon(part.xpoints, part.ypoints, W, H, part.holes);
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
    r.label = proto?.label ?? 'legend';
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
