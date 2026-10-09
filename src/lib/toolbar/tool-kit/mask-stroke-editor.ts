import { BBoxMask, MAX_RASTER_PIXELS, masksOverlap, rasterizePolygon, unionMasks } from '../../geometry/raster';
import { pointInPolygonWithHoles, ringBounds } from '../../geometry/ring';
import { maskToPolygons } from '../../geometry/contour';
import { IRegionDataHost } from '../../contracts/coordinate-transform.contract';
import { Polygon, Region } from '../../models/region';
import { makePolygon, replaceBounds } from '../../models/polygon-factory';
import { MatrixFrame } from './matrix-frame';

/** The readback size the stroke is painted against (the rasterizer's clip window). */
export interface StrokeImage {
  width: number;
  height: number;
}

/** How a commit turns traced pieces into regions. */
export interface StrokeCommitOptions {
  /** The tick erased (Shift): a stroke erased to nothing removes its regions. */
  erase: boolean;
  /** A brand-new region for a piece no existing region owns. */
  newRegion(bounds: Polygon): Region;
  /** Fields applied on top of an edited region (e.g. a painted class colour). */
  editPatch?: Partial<Region>;
  /** Class label given to an edited region that has none, so tool output is never unlabeled. */
  defaultLabel: string;
}

/**
 * The bbox-relative mask accumulator shared by the wand and the brush: adopt a
 * region under the cursor, grow the mask, fold touching regions in, then trace
 * every connected piece (with holes) and commit them.
 *
 * The accumulator survives mouseup so the next stroke extends the same region
 * (QuPath behaviour). It is dropped when the view changes (its matrix coords
 * are tied to the readback frame, jit-ui#102) and when its regions changed
 * outside the tool (undo, Region Editor, segmentation, eraser — RT-2).
 *
 * Commits never mutate a store instance and never drop metadata: an edited
 * region is a copy of the original with new bounds (RT-5). An erase that cuts a
 * region in two keeps both pieces and a donut keeps its holes (RT-3).
 */
export class MaskStrokeEditor {
  /** The accumulated mask, in matrix coords of {@link frameSig}'s frame. */
  stroke: BBoxMask | null = null;
  /** Id of the region the stroke edits (null = a fresh region); for a split,
   *  the largest piece. */
  regionId: number | null = null;
  /** Ids of the extra pieces an erase split off, reused across ticks so they
   *  keep stable identities. */
  private extraIds: number[] = [];
  /** The bounds objects the stroke last committed or adopted, one per region it
   *  owns. Once any of them is no longer held by a region, the stroke is stale. */
  private lastCommitted: Array<Region['bounds']> = [];
  /** The region the stroke adopted (or first merged in): its metadata carries
   *  over to the committed pieces even after a merge removed it from the list. */
  private template: Region | null = null;
  private frameSig: string | null = null;

  /** Drop the stroke and everything tied to it. */
  reset(): void {
    this.stroke = null;
    this.regionId = null;
    this.extraIds = [];
    this.lastCommitted = [];
    this.template = null;
  }

  /** Drop a stroke whose regions were undone, deleted or replaced outside the
   *  tool: re-committing it would bring the old shapes back (RT-2). */
  invalidateIfStale(regions: Region[]): void {
    if (this.stroke && this.lastCommitted.some((b) => !regions.some((r) => r.bounds === b))) {
      this.reset();
    }
  }

  /** Drop a stroke built at a different view (zoom/pan): re-committing it would
   *  rescale the region by the zoom factor (jit-ui#102). */
  syncFrame(frame: MatrixFrame): void {
    if (this.stroke && this.frameSig !== frame.sig) this.reset();
    this.frameSig = frame.sig;
  }

  /** True if matrix point (mx, my) is painted in the stroke. */
  contains(mx: number, my: number): boolean {
    const s = this.stroke;
    if (!s) return false;
    const x = Math.floor(mx) - s.bx;
    const y = Math.floor(my) - s.by;
    if (x < 0 || y < 0 || x >= s.bw || y >= s.bh) return false;
    return s.mask[y * s.bw + x] === 1;
  }

  /**
   * Make the stroke's bbox cover [x0,x1)×[y0,y1) (matrix px), creating an empty
   * stroke or growing (and copying) the existing one. False for an empty box.
   */
  ensureCovers(x0: number, y0: number, x1: number, y1: number): boolean {
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return false;
    const s = this.stroke;
    if (!s) {
      this.stroke = { bx: x0, by: y0, bw: x1 - x0, bh: y1 - y0, mask: new Uint8Array((x1 - x0) * (y1 - y0)) };
      return true;
    }
    const bx = Math.min(s.bx, x0);
    const by = Math.min(s.by, y0);
    const bw = Math.max(s.bx + s.bw, x1) - bx;
    const bh = Math.max(s.by + s.bh, y1) - by;
    if (bw === s.bw && bh === s.bh && bx === s.bx && by === s.by) return true;
    const next = new Uint8Array(bw * bh);
    const dx = s.bx - bx;
    const dy = s.by - by;
    for (let row = 0; row < s.bh; row++) {
      const src = row * s.bw;
      next.set(s.mask.subarray(src, src + s.bw), (row + dy) * bw + dx);
    }
    this.stroke = { bx, by, bw, bh, mask: next };
    return true;
  }

  /**
   * If matrix point (mx, my) lies inside a region `accept`s (topmost first, not
   * in a hole), rasterize it into the stroke so this stroke extends it.
   */
  adoptAt(regions: Region[], mx: number, my: number, frame: MatrixFrame, image: StrokeImage,
          accept: (r: Region) => boolean = () => true): boolean {
    for (let i = regions.length - 1; i >= 0; i--) {
      const region = regions[i];
      if (!accept(region)) continue;
      const m = this.editableRing(region, frame);
      if (!m) continue;
      // Clicking inside a hole must NOT adopt the donut (it's empty there).
      if (!pointInPolygonWithHoles(mx, my, m.xs, m.ys, m.holes)) continue;
      const raster = rasterizePolygon(m.xs, m.ys, image.width, image.height, m.holes);
      if (!raster) continue;
      this.stroke = raster;
      this.regionId = region.id ?? null;
      this.template = region;
      this.extraIds = [];
      this.lastCommitted = [region.bounds];
      return true;
    }
    return false;
  }

  /**
   * Fold every region `accept`s whose raster overlaps the stroke into it and
   * remove it from `regions` (merge-on-touch). Repeats until nothing changes so
   * chained merges resolve. With no region yet, the first merged region's
   * identity and metadata are adopted.
   */
  mergeTouching(regions: Region[], frame: MatrixFrame, image: StrokeImage,
                accept: (r: Region) => boolean = () => true): void {
    let merged = true;
    while (merged && this.stroke) {
      merged = false;
      for (let i = regions.length - 1; i >= 0; i--) {
        const region = regions[i];
        if (region.id != null && region.id === this.regionId) continue;
        if (!accept(region)) continue;
        const m = this.editableRing(region, frame);
        if (!m) continue;
        // Quick bbox reject before rasterizing.
        const b = ringBounds(m.xs, m.ys);
        const s = this.stroke;
        if (b.maxX < s.bx || b.minX > s.bx + s.bw || b.maxY < s.by || b.minY > s.by + s.bh) continue;
        const raster = rasterizePolygon(m.xs, m.ys, image.width, image.height, m.holes);
        if (!raster || !masksOverlap(s, raster)) continue;

        this.stroke = unionMasks(s, raster);
        if (this.regionId == null) {
          this.regionId = region.id ?? null;
          this.template = region;
        }
        regions.splice(i, 1);
        merged = true;
        break;
      }
    }
  }

  /**
   * Trace every connected piece of the stroke (holes included) and commit them:
   * the largest keeps the stroke's region, further pieces (from an erase that
   * split it) become their own regions with stable ids across ticks. An erase
   * that leaves nothing removes the stroke's regions.
   */
  commit(regions: Region[], frame: MatrixFrame, host: IRegionDataHost, opts: StrokeCommitOptions): void {
    const s = this.stroke;
    if (!s) return;
    const pieces = maskToPolygons(s.mask, s.bw, s.bh, s.bx, s.by)
      .filter((p) => p.xpoints.length >= 3)
      .map((p) => {
        const ring = frame.ringToData(p.xpoints, p.ypoints);
        return makePolygon(ring.xs, ring.ys, { holes: frame.holesToData(p.holes) });
      });
    if (pieces.length === 0) {
      if (opts.erase) this.dropActive(regions, host);
      return;
    }

    // Drop previously tracked extras that no longer have a matching piece (the
    // piece count shrank, e.g. an add stroke bridged the gap).
    const prevExtras = this.extraIds;
    for (let k = pieces.length - 1; k < prevExtras.length; k++) {
      const idx = regions.findIndex((r) => r.id === prevExtras[k]);
      if (idx >= 0) regions.splice(idx, 1);
    }

    const owner = this.owner(regions, this.regionId);
    const primary = this.upsert(regions, owner, pieces[0], opts);
    const extras: Region[] = [];
    for (let i = 1; i < pieces.length; i++) {
      const prev = this.owner(regions, prevExtras[i - 1] ?? null);
      // A new split piece inherits the edited region's class and metadata.
      extras.push(prev
        ? this.upsert(regions, prev, pieces[i], opts)
        : this.insert(regions, owner
          ? replaceBounds(owner, pieces[i], { ...this.patchFor(owner, opts), id: undefined, name: undefined })
          : opts.newRegion(pieces[i])));
    }

    host.setRegions(regions);
    // Ids are minted during setRegions — read them back for the next tick.
    this.regionId = primary.id ?? this.regionId;
    this.template = primary;
    this.extraIds = extras.map((r) => r.id).filter((id): id is number => id != null);
    this.lastCommitted = [primary, ...extras].map((r) => r.bounds);
  }

  /** Remove the stroke's region(s) and reset — an erase deleted every pixel. */
  dropActive(regions: Region[], host: IRegionDataHost): void {
    const ids = [this.regionId, ...this.extraIds].filter((id): id is number => id != null);
    let changed = false;
    for (const id of ids) {
      const idx = regions.findIndex((r) => r.id === id);
      if (idx >= 0) { regions.splice(idx, 1); changed = true; }
    }
    if (changed) host.setRegions(regions);
    this.reset();
  }

  // ── internals ────────────────────────────────────────────────────────

  /** The region with `id` in `regions`, or the adopted/merged template when a
   *  merge already removed it from the list. */
  private owner(regions: Region[], id: number | null): Region | null {
    if (id == null) return null;
    return regions.find((r) => r.id === id) ?? (this.template?.id === id ? this.template : null);
  }

  /** Replace `existing` in place (or append it if a merge removed it). */
  private upsert(regions: Region[], existing: Region | null, bounds: Polygon,
                 opts: StrokeCommitOptions): Region {
    if (!existing) return this.insert(regions, opts.newRegion(bounds));
    const region = replaceBounds(existing, bounds, this.patchFor(existing, opts));
    const idx = regions.findIndex((r) => r.id === existing.id);
    if (idx >= 0) regions[idx] = region;
    else regions.push(region);
    return region;
  }

  /** The fields an edit sets on `existing`: the tool's patch, plus a default label. */
  private patchFor(existing: Region, opts: StrokeCommitOptions): Partial<Region> {
    return existing.label == null ? { label: opts.defaultLabel, ...opts.editPatch } : { ...opts.editPatch };
  }

  private insert(regions: Region[], region: Region): Region {
    regions.push(region);
    return region;
  }

  /**
   * A region's closed ring and holes in matrix coords, or null when it can't be
   * edited as a mask: not a closed polygon (rectangles, polylines,
   * multi-polygons), or too large to rasterize faithfully at this zoom — editing
   * would clip or down-quantize it and bring it back rescaled (jit-ui#102).
   */
  private editableRing(region: Region, frame: MatrixFrame)
    : { xs: number[]; ys: number[]; holes?: number[][][] } | null {
    const b = region?.bounds;
    if (!(b instanceof Polygon) || b.closed === false || b.xpoints.length < 3) return null;
    const ring = frame.ringToMatrix(b.xpoints, b.ypoints);
    const r = ringBounds(ring.xs, ring.ys);
    const w = r.maxX - r.minX, h = r.maxY - r.minY;
    if (!(w > 0 && h > 0 && w * h <= MAX_RASTER_PIXELS)) return null;
    return { xs: ring.xs, ys: ring.ys, holes: frame.holesToMatrix(b.holes) };
  }
}
