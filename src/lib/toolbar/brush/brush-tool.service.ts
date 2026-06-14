import { Injectable } from '@angular/core';

import { WandService } from '../wand/wand.service';
import { CachedImageData, WandToolHost } from '../wand/wand-tool.service';
import { BBoxMask, masksOverlap, unionMasks } from '../../models/geometry';
import { Region, Polygon } from '../../models/region';

/** Brush parameters. `size` is the brush *diameter* in matrix (image) pixels. */
export interface BrushOptions {
  size?: number;
}

/** Default brush diameter (matrix pixels) if none is supplied. */
const DEFAULT_BRUSH_SIZE = 40;

/**
 * The brush host is identical to the wand's — both need the cached-image
 * coordinate frame, the overlay container, the coordinate transform, and
 * read/write access to the shared region list. The brush ignores the wand's
 * pixel values (it paints a geometric disc rather than flood-filling by colour),
 * so reusing {@link WandToolHost} lets each backend bind the same host object.
 */
export type BrushToolHost = WandToolHost;

/**
 * QuPath-style brush tool. Painting a stroke unions a disc of the configured
 * size into the active region as the cursor drags; holding <kbd>Shift</kbd>
 * subtracts instead (eraser brush), matching the wand's modifier. The stroke is
 * accumulated as a bbox-relative mask (exactly like {@link WandToolService}) so
 * the brush inherits the wand's adopt-existing-region and merge-on-touch
 * behaviour, then the union boundary is traced back into a polygon Region.
 *
 * No pixel sampling and no cursor indicator: the painted stroke itself shows the
 * brush size. The overlay canvas only captures the pointer.
 *
 * Lifecycle mirrors the wand: a backend binds its host once, then toggles the
 * tool with `setMode(true | false, options)`.
 *
 * Known limitation — no holes/donuts: brushing a ring that encloses an unpainted
 * area yields a filled disc, not a donut. The boundary tracer
 * ({@link WandService.maskToPolygons} via `mooreBoundary`) returns only each
 * component's *outer* contour, and the neutral {@link Polygon} region model is a
 * single ring with no interior rings — so an enclosed hole can't be represented
 * and is filled in. Supporting donuts would require interior-ring support across
 * the model, both renderers (even-odd fill), GeoJSON I/O, and hit-testing.
 */
@Injectable({ providedIn: 'root' })
export class BrushToolService {
  private host!: BrushToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private active = false;

  /**
   * Accumulated brush region (bbox-relative mask). Persists across mouseup so a
   * subsequent stroke extends the *same* region until the user switches tool —
   * matching QuPath, and the wand.
   */
  private stroke: BBoxMask | null = null;
  /** Id of the region this stroke is editing (null = a fresh region). For an
   *  erase that splits the region, this tracks the largest resulting piece. */
  private strokeRegionId: number | null = null;
  /** Ids of the extra regions produced when an erase stroke splits a region
   *  into disconnected pieces — reused across drag ticks so the split pieces
   *  keep stable identities instead of being recreated each tick. */
  private strokeExtraIds: number[] = [];
  /** Previous cursor position (matrix coords) within the current drag, so fast
   *  drags paint a continuous stroke rather than disconnected dabs. */
  private lastMatrix: { x: number; y: number } | null = null;
  private dragging = false;
  private size = DEFAULT_BRUSH_SIZE;

  private readonly boundMouseDown: (e: MouseEvent) => void;
  private readonly boundMouseMove: (e: MouseEvent) => void;
  private readonly boundMouseUp: (e: MouseEvent) => void;

  constructor(private wandService: WandService) {
    this.boundMouseDown = (e) => this.onMouseDown(e);
    this.boundMouseMove = (e) => this.onMouseMove(e);
    this.boundMouseUp = (e) => this.onMouseUp(e);
  }

  /** Wire the tool to its host. Must be called once before `setMode(true)`. */
  bindHost(host: BrushToolHost) {
    this.host = host;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Toggle the brush on/off. */
  setMode(active: boolean, options: BrushOptions = {}) {
    this.active = active;
    if (options.size != null) this.setSize(options.size);
    if (active) {
      this.createOverlay();
    } else {
      this.destroyOverlay();
    }
  }

  /** Live-update the brush size (matrix-pixel diameter). */
  setSize(size: number) {
    if (!Number.isFinite(size) || size <= 0) return;
    this.size = size;
  }

  /** Drop the active brush region so the next stroke starts a new one. */
  clearActiveRegion() {
    this.resetStroke();
  }

  // ── Overlay lifecycle ───────────────────────────────────────────────

  private createOverlay() {
    const plotEl = this.host.getOverlayContainer();
    if (!plotEl || this.overlay) return;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.cursor = 'crosshair';
    canvas.style.zIndex = '100';
    canvas.width = plotEl.offsetWidth;
    canvas.height = plotEl.offsetHeight;

    plotEl.appendChild(canvas);
    this.overlay = canvas;

    canvas.addEventListener('mousedown', this.boundMouseDown);
    canvas.addEventListener('mousemove', this.boundMouseMove);
    canvas.addEventListener('mouseup', this.boundMouseUp);
    canvas.addEventListener('mouseleave', this.boundMouseUp);
  }

  private destroyOverlay() {
    if (!this.overlay) return;
    this.overlay.removeEventListener('mousedown', this.boundMouseDown);
    this.overlay.removeEventListener('mousemove', this.boundMouseMove);
    this.overlay.removeEventListener('mouseup', this.boundMouseUp);
    this.overlay.removeEventListener('mouseleave', this.boundMouseUp);
    this.overlay.remove();
    this.overlay = null;
    this.resetStroke();
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    this.dragging = true;
    this.lastMatrix = null; // first stamp of this drag is a single dab
    this.applyAtClient(e, true);
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.dragging) return;
    if ((e.buttons & 1) === 0) {
      this.dragging = false;
      return;
    }
    this.applyAtClient(e, false);
  }

  private onMouseUp(_: MouseEvent) {
    // Stop accumulating from this drag, but keep the region alive so the next
    // mousedown extends it. Clear lastMatrix so the next drag starts a dab.
    this.dragging = false;
    this.lastMatrix = null;
  }

  private resetStroke() {
    this.stroke = null;
    this.strokeRegionId = null;
    this.strokeExtraIds = [];
    this.lastMatrix = null;
    this.dragging = false;
  }

  // ── Per-tick stroke logic ───────────────────────────────────────────

  /**
   * Paint (or erase) a disc — or a swept line of discs since the previous
   * tick — into the active region's accumulator mask, re-trace the boundary,
   * and commit the updated Region. Shift = erase.
   */
  private applyAtClient(e: MouseEvent, isStart: boolean) {
    if (!this.overlay) return;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) return;

    const regions = this.host.getRegions();

    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;

    // Heatmap/image traces use ratios[0] for both dx and dy.
    const rx = cached.ratios[0] || 1;
    const ry = cached.ratios[0] || 1;
    const ox = cached.originX ?? 0;
    const oy = cached.originY ?? 0;
    const matrixX = (dataX - ox) / rx;
    const matrixY = (dataY - oy) / ry;
    if (matrixX < 0 || matrixX >= cached.width) return;
    if (matrixY < 0 || matrixY >= cached.height) return;

    const erase = e.shiftKey;
    const radius = Math.max(0.5, this.size / 2);

    // Start of a fresh drag that isn't inside the current accumulator: drop the
    // old stroke so a brand-new region starts here (mirrors the wand).
    if (isStart && !erase && this.stroke && !this.pointInStroke(matrixX, matrixY)) {
      this.stroke = null;
      this.strokeRegionId = null;
    }

    // If there's no active region, adopt an existing shape under the cursor so
    // the stroke extends (or erases from) it instead of creating a new region.
    if (!this.stroke) {
      this.tryAdoptShapeAt(regions, matrixX, matrixY, rx, ry, cached);
    }

    // Erasing requires an existing region — shift on empty space is a no-op.
    if (erase && !this.stroke) {
      this.lastMatrix = { x: matrixX, y: matrixY };
      return;
    }

    // Stamp the disc, sweeping from the previous point for a continuous stroke.
    if (isStart || !this.lastMatrix) {
      this.stampDisc(matrixX, matrixY, radius, erase, cached);
    } else {
      const dx = matrixX - this.lastMatrix.x;
      const dy = matrixY - this.lastMatrix.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, radius / 2);
      const n = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        this.stampDisc(this.lastMatrix.x + dx * t, this.lastMatrix.y + dy * t, radius, erase, cached);
      }
    }
    this.lastMatrix = { x: matrixX, y: matrixY };

    if (!this.stroke) return;

    if (!erase) {
      // Growing into another shape folds it into this stroke (merge-on-touch).
      this.mergeOverlappingShapes(regions, rx, ry, cached);
    }

    const stroke = this.stroke;
    // Trace every connected piece: an erase that cuts through the region splits
    // it into two, and both must survive (the larger keeps the region identity).
    const polys = this.wandService.maskToPolygons(
      stroke.mask, stroke.bw, stroke.bh, cached.width, cached.height, stroke.bx, stroke.by,
    );
    if (polys.length === 0) {
      // Erased to nothing — remove the shape(s) entirely.
      if (erase) this.dropActiveShape(regions);
      return;
    }

    const components = polys.map((poly) => ({
      xPlot: poly.xpoints.map((x) => ox + x * rx),
      yPlot: poly.ypoints.map((y) => oy + y * ry),
    }));
    this.commitComponents(regions, components);
  }

  /**
   * OR (add) or AND-NOT (erase) a filled disc of `radius` matrix-pixels centred
   * at (cx, cy) into the accumulator, growing its bbox to fit when adding.
   */
  private stampDisc(cx: number, cy: number, radius: number, erase: boolean, cached: CachedImageData) {
    const px0 = Math.floor(cx - radius);
    const py0 = Math.floor(cy - radius);
    const px1 = Math.ceil(cx + radius) + 1;
    const py1 = Math.ceil(cy + radius) + 1;

    if (!erase) {
      if (!this.ensureStrokeCovers(px0, py0, px1, py1, cached)) return;
    }
    const s = this.stroke;
    if (!s) return; // erasing with no active region

    const r2 = radius * radius;
    const iy0 = Math.max(s.by, py0);
    const iy1 = Math.min(s.by + s.bh, py1);
    const ix0 = Math.max(s.bx, px0);
    const ix1 = Math.min(s.bx + s.bw, px1);
    for (let iy = iy0; iy < iy1; iy++) {
      const dy = iy + 0.5 - cy;
      const row = (iy - s.by) * s.bw;
      for (let ix = ix0; ix < ix1; ix++) {
        const dx = ix + 0.5 - cx;
        if (dx * dx + dy * dy > r2) continue;
        s.mask[row + (ix - s.bx)] = erase ? 0 : 1;
      }
    }
  }

  /**
   * Ensure the accumulator's bbox covers [px0,py0,px1,py1) (clamped to the
   * image), allocating/copying a larger mask when it must grow. Returns false if
   * the requested box is empty after clamping.
   */
  private ensureStrokeCovers(
    px0: number, py0: number, px1: number, py1: number, cached: CachedImageData,
  ): boolean {
    const bx = Math.max(0, px0);
    const by = Math.max(0, py0);
    const bx1 = Math.min(cached.width, px1);
    const by1 = Math.min(cached.height, py1);
    const bw = bx1 - bx;
    const bh = by1 - by;
    if (bw <= 0 || bh <= 0) return false;

    if (!this.stroke) {
      this.stroke = { bx, by, bw, bh, mask: new Uint8Array(bw * bh) };
      return true;
    }
    const s = this.stroke;
    const nbx = Math.min(s.bx, bx);
    const nby = Math.min(s.by, by);
    const nbx1 = Math.max(s.bx + s.bw, bx1);
    const nby1 = Math.max(s.by + s.bh, by1);
    const nbw = nbx1 - nbx;
    const nbh = nby1 - nby;
    if (nbw === s.bw && nbh === s.bh && nbx === s.bx && nby === s.by) return true;

    const next = new Uint8Array(nbw * nbh);
    const dx = s.bx - nbx;
    const dy = s.by - nby;
    for (let row = 0; row < s.bh; row++) {
      const srcOff = row * s.bw;
      const dstOff = (row + dy) * nbw + dx;
      next.set(s.mask.subarray(srcOff, srcOff + s.bw), dstOff);
    }
    this.stroke = { bx: nbx, by: nby, bw: nbw, bh: nbh, mask: next };
    return true;
  }

  /** True if (matrixX, matrixY) lies inside the current stroke accumulator. */
  private pointInStroke(matrixX: number, matrixY: number): boolean {
    const s = this.stroke;
    if (!s) return false;
    const mx = Math.floor(matrixX) - s.bx;
    const my = Math.floor(matrixY) - s.by;
    if (mx < 0 || my < 0 || mx >= s.bw || my >= s.bh) return false;
    return s.mask[my * s.bw + mx] === 1;
  }

  /**
   * Remove the region(s) referenced by the stroke and reset it — used when an
   * erase stroke deletes every pixel.
   */
  private dropActiveShape(regions: Region[]) {
    const ids = [this.strokeRegionId, ...this.strokeExtraIds].filter((id): id is number => id != null);
    let changed = false;
    for (const id of ids) {
      const idx = regions.findIndex((r) => r.id === id);
      if (idx >= 0) { regions.splice(idx, 1); changed = true; }
    }
    if (changed) this.host.setRegions(regions);
    this.stroke = null;
    this.strokeRegionId = null;
    this.strokeExtraIds = [];
  }

  /** A region's closed-polygon vertices (image/data coords), or null when it
   *  isn't a fillable closed polygon (rectangles, open polylines). */
  private regionVerts(region: Region): { xpoints: number[]; ypoints: number[] } | null {
    const b = region?.bounds;
    if (b instanceof Polygon && b.closed !== false && b.xpoints.length >= 3) {
      return { xpoints: b.xpoints, ypoints: b.ypoints };
    }
    return null;
  }

  /**
   * If (matrixX, matrixY) falls inside an existing region, rasterize it into the
   * stroke accumulator so subsequent brush input extends it rather than starting
   * a new region.
   */
  private tryAdoptShapeAt(
    regions: Region[],
    matrixX: number,
    matrixY: number,
    rx: number,
    ry: number,
    cached: CachedImageData,
  ): boolean {
    if (!regions || regions.length === 0) return false;
    // Most-recently-added regions are on top — check them first.
    for (let i = regions.length - 1; i >= 0; i--) {
      const verts = this.regionVerts(regions[i]);
      if (!verts) continue;

      const ox = cached.originX ?? 0;
      const oy = cached.originY ?? 0;
      const xs = verts.xpoints.map((x) => (x - ox) / rx);
      const ys = verts.ypoints.map((y) => (y - oy) / ry);

      if (!this.wandService.pointInPolygon(matrixX, matrixY, xs, ys)) continue;

      const raster = this.wandService.rasterizePolygon(xs, ys, cached.width, cached.height);
      if (!raster) continue;

      this.stroke = raster;
      this.strokeRegionId = regions[i].id ?? null;
      return true;
    }
    return false;
  }

  /**
   * Fold every region whose rasterized mask overlaps the stroke mask into the
   * stroke and remove it from the list, so brushing across regions merges them.
   */
  private mergeOverlappingShapes(regions: Region[], rx: number, ry: number, cached: CachedImageData) {
    if (!this.stroke) return;
    let didMerge = true;
    while (didMerge) {
      didMerge = false;
      for (let i = regions.length - 1; i >= 0; i--) {
        const region = regions[i];
        if (region.id != null && region.id === this.strokeRegionId) continue;

        const verts = this.regionVerts(region);
        if (!verts) continue;

        const ox = cached.originX ?? 0;
        const oy = cached.originY ?? 0;
        const xs = verts.xpoints.map((x) => (x - ox) / rx);
        const ys = verts.ypoints.map((y) => (y - oy) / ry);

        // Quick bbox reject before rasterizing.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let k = 0; k < xs.length; k++) {
          if (xs[k] < minX) minX = xs[k];
          if (xs[k] > maxX) maxX = xs[k];
          if (ys[k] < minY) minY = ys[k];
          if (ys[k] > maxY) maxY = ys[k];
        }
        const wx0 = this.stroke.bx, wy0 = this.stroke.by;
        const wx1 = wx0 + this.stroke.bw, wy1 = wy0 + this.stroke.bh;
        if (maxX < wx0 || minX > wx1 || maxY < wy0 || minY > wy1) continue;

        const raster = this.wandService.rasterizePolygon(xs, ys, cached.width, cached.height);
        if (!raster) continue;
        if (!masksOverlap(this.stroke, raster)) continue;

        this.stroke = unionMasks(this.stroke, raster);
        if (this.strokeRegionId == null) {
          this.strokeRegionId = region.id ?? null;
        }
        regions.splice(i, 1);
        didMerge = true;
        break;
      }
    }
  }

  /**
   * Commit the stroke's connected pieces as regions — the largest keeps the
   * stroke's region identity, additional pieces (from an erase that split the
   * region) become their own regions tracked in `strokeExtraIds` so they keep
   * stable identities across drag ticks. The store mints ids on commit, which
   * we read back so subsequent ticks replace the same regions.
   */
  private commitComponents(regions: Region[], components: { xPlot: number[]; yPlot: number[] }[]) {
    const valid = components.filter((c) => c.xPlot.length >= 3);
    if (valid.length === 0) return;

    const prevExtraIds = this.strokeExtraIds;
    // Drop previously-tracked extras that no longer have a matching piece (the
    // component count shrank, e.g. an add stroke bridged a gap).
    const reuseCount = Math.max(0, valid.length - 1);
    for (let k = reuseCount; k < prevExtraIds.length; k++) {
      const idx = regions.findIndex((r) => r.id === prevExtraIds[k]);
      if (idx >= 0) regions.splice(idx, 1);
    }

    const primary = this.upsertComponent(regions, this.strokeRegionId, valid[0]);
    const extras: Region[] = [];
    for (let i = 1; i < valid.length; i++) {
      extras.push(this.upsertComponent(regions, prevExtraIds[i - 1] ?? null, valid[i]));
    }

    this.host.setRegions(regions);
    // Ids are minted during setRegions — read them back for the next tick.
    this.strokeRegionId = primary.id ?? this.strokeRegionId;
    this.strokeExtraIds = extras
      .map((r) => r.id)
      .filter((id): id is number => id != null);
  }

  /**
   * Build a Region for one component and insert it into `regions`: replace the
   * region with `id` in place if it exists, otherwise append a new one. Returns
   * the Region instance (its id is minted later by the store when new).
   */
  private upsertComponent(
    regions: Region[], id: number | null, c: { xPlot: number[]; yPlot: number[] },
  ): Region {
    const existing = id != null ? regions.find((r) => r.id === id) : null;

    const poly = new Polygon();
    poly.npoints = c.xPlot.length;
    poly.xpoints = c.xPlot;
    poly.ypoints = c.yPlot;
    poly.coordinates = c.xPlot.map((x, i) => [x, c.yPlot[i]]);
    poly.closed = true;

    const region = new Region();
    region.bounds = poly;
    region.color = this.host.getShapeColor();
    if (existing) {
      region.id = existing.id;
      region.name = existing.name;
    }
    // Default class/annotation name, matching the overlay-drawn regions and the
    // wand so a brush region isn't left unlabeled.
    region.label = existing?.label ?? 'legend';

    if (existing) {
      const idx = regions.findIndex((r) => r.id === id);
      if (idx >= 0) regions[idx] = region;
      else regions.push(region);
    } else {
      regions.push(region);
    }
    return region;
  }
}
