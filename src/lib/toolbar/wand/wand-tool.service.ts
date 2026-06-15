import { Injectable } from '@angular/core';

import { WandImage, WandOptions, WandService } from './wand.service';
import { BBoxMask, masksOverlap, unionMasks } from '../../models/geometry';
import { IViewportHost, IRegionDataHost } from '../../contracts/coordinate-transform.contract';
import { Region, Polygon } from '../../models/region';

/**
 * The pixel data and frame state PlotlyService caches for sampling. Returned
 * by `WandToolHost.getCachedImageData()`.
 */
export interface CachedImageData {
  /** 2-D matrices, one per stack frame (length 1 for non-stack images). */
  frames: any[];
  /** Image-pixel width of each frame matrix. */
  width: number;
  /** Image-pixel height of each frame matrix. */
  height: number;
  /**
   * Plot-data-coords-per-image-pixel along x (and y — they're the same
   * for heatmap and image traces).
   */
  ratios: number[];
  /** Whether each frame is a 2-D scalar matrix (true) or 3-channel RGB (false). */
  isGrayscale: boolean;
  /**
   * Data-coords of matrix pixel (0,0). Lets the matrix be a *crop* of the data
   * space rather than starting at the origin — e.g. the OSD backend samples the
   * currently rendered viewport, so when zoomed in the matrix covers only the
   * visible sub-region at screen resolution. Defaults to 0 (full-frame matrix,
   * as Plotly provides). matrixIndex = (data - origin) / ratio.
   */
  originX?: number;
  originY?: number;
}

/**
 * The collaboration interface the wand tool needs from PlotlyService.
 *
 * Keeping it explicit makes the dependency one-way: WandToolService never
 * imports PlotlyService directly. PlotlyService satisfies this interface
 * structurally and binds itself via `bindHost(this)`.
 */
export interface WandToolHost extends IViewportHost, IRegionDataHost {
  /** Pixel data for sampling. null when no image is loaded yet. */
  getCachedImageData(): CachedImageData | null;
  /** Index of the currently visible frame in a stack (0 for non-stack). */
  getActiveFrameIndex(): number;

  /** Current image's filename — stamped onto new shapes for filtering. */
  getFileName(): string | undefined;
  /** Default stroke colour for new shapes. */
  getShapeColor(): string;
}

/**
 * The wand drawing tool. Owns its own canvas overlay, mouse handlers, and
 * stroke accumulator. Reads/writes the shape list via the WandToolHost
 * interface so it stays decoupled from PlotlyService internals.
 *
 * Lifecycle: PlotlyService injects this service, calls `bindHost(this)` once
 * during its own construction, then calls `setMode(true | false, options)` to
 * activate/deactivate the tool.
 */
@Injectable({ providedIn: 'root' })
export class WandToolService {
  // ── Tool state ──────────────────────────────────────────────────────

  private host!: WandToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private active = false;
  /**
   * Accumulated wand region. Every per-tick patch mask is OR'd into `mask`
   * over a bbox that grows with the stroke, so the region keeps expanding
   * as the user drags. The accumulator persists across mouseup/mousedown so
   * that subsequent strokes extend the *same* region — matching QuPath's
   * brush behaviour where the active annotation stays editable until the
   * user switches tool.
   */
  private stroke: BBoxMask | null = null;
  /** Id of the region this wand stroke is editing (null = a fresh region). */
  private strokeRegionId: number | null = null;
  private dragging = false;
  private options: WandOptions = {};

  private readonly boundMouseDown: (e: MouseEvent) => void;
  private readonly boundMouseMove: (e: MouseEvent) => void;
  private readonly boundMouseUp: (e: MouseEvent) => void;

  constructor(private wandService: WandService) {
    this.boundMouseDown = (e) => this.onMouseDown(e);
    this.boundMouseMove = (e) => this.onMouseMove(e);
    this.boundMouseUp = (e) => this.onMouseUp(e);
  }

  /** Wire the tool to its host. Must be called once before `setMode(true)`. */
  bindHost(host: WandToolHost) {
    this.host = host;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Toggle the wand on/off. */
  setMode(active: boolean, options: WandOptions = {}) {
    this.active = active;
    this.options = options;
    if (active) {
      this.createOverlay();
    } else {
      this.destroyOverlay();
    }
  }

  /** Merge new options (e.g. live sensitivity slider updates). */
  setOptions(options: WandOptions) {
    this.options = { ...this.options, ...options };
  }

  /** Drop the active wand region so the next click starts a new one. */
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
    // Stop accumulating from this drag, but keep the region alive so the
    // next mousedown extends it instead of starting fresh.
    this.dragging = false;
  }

  private resetStroke() {
    this.stroke = null;
    this.strokeRegionId = null;
    this.dragging = false;
  }

  // ── Per-tick stroke logic ───────────────────────────────────────────

  /**
   * Sample the cached image at the click location, OR (or AND-NOT) the
   * wand's per-tick patch mask into the active region's bbox-relative mask,
   * re-trace the boundary, and update the in-progress shape — matching
   * QuPath's additive brush/wand behaviour. Shift = erase. Cmd/Ctrl =
   * exact-match flood fill.
   */
  private applyAtClient(e: MouseEvent, isStart = false) {
    if (!this.overlay) return;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) return;

    // The current regions (neutral model). Mutated locally across this tick and
    // committed once via host.setRegions().
    const regions = this.host.getRegions();

    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;

    // Plot heatmap/image traces use ratios[0] for both dx and dy.
    const rx = cached.ratios[0] || 1;
    const ry = cached.ratios[0] || 1;
    const ox = cached.originX ?? 0;
    const oy = cached.originY ?? 0;
    const matrixX = (dataX - ox) / rx;
    const matrixY = (dataY - oy) / ry;
    if (matrixX < 0 || matrixX >= cached.width) return;
    if (matrixY < 0 || matrixY >= cached.height) return;

    const frameIdx = this.host.getActiveFrameIndex();
    const frame = cached.frames[frameIdx] ?? cached.frames[0];

    const wandImage: WandImage = {
      data: frame,
      width: cached.width,
      height: cached.height,
      isGrayscale: cached.isGrayscale,
    };
    // Shift = erase (subtract pixels from an existing region).
    // Cmd/Ctrl alone = simple flood fill (no smoothing/threshold).
    const erase = e.shiftKey;
    const opts: WandOptions = {
      ...this.options,
      simpleMode: this.options.simpleMode || ((e.metaKey || e.ctrlKey) && !erase),
    };

    // If this is the first tick of a new drag and the click is NOT inside the
    // current accumulator and NOT inside any existing path-shape, drop the old
    // stroke so a brand-new region starts here. Without this, the accumulator
    // bbox grows to span both areas and `maskToPolygon` keeps only the largest
    // connected blob — making the new click appear to do nothing.
    if (isStart && !erase && this.stroke && !this.pointInStroke(matrixX, matrixY)) {
      // Will fall through to tryAdoptShapeAt below; if that also misses, a
      // fresh stroke is created from the patch.
      this.stroke = null;
      this.strokeRegionId = null;
    }

    const patch = this.wandService.computePatchMask(wandImage, matrixX, matrixY, opts);
    if (!patch) return;

    const W = patch.size;
    const half = (W - 1) / 2;
    const px0 = Math.round(matrixX) - half;
    const py0 = Math.round(matrixY) - half;
    const px1 = px0 + W;
    const py1 = py0 + W;

    // If there's no active wand region, see if the click landed on an
    // existing path-shape — adopt it so this stroke extends (or erases
    // from) it instead of creating a new region.
    if (!this.stroke) {
      this.tryAdoptShapeAt(regions, matrixX, matrixY, rx, ry, cached);
    }

    // Erasing requires an existing region. Shift-clicking empty space is a
    // no-op — we don't create a region only to immediately delete from it.
    if (erase && !this.stroke) return;

    // Grow the region's accumulated mask only when adding. Erasing never
    // expands the region beyond its current bbox.
    if (!this.stroke) {
      const bx = Math.max(0, px0);
      const by = Math.max(0, py0);
      const bx1 = Math.min(cached.width, px1);
      const by1 = Math.min(cached.height, py1);
      const bw = Math.max(0, bx1 - bx);
      const bh = Math.max(0, by1 - by);
      if (bw === 0 || bh === 0) return;
      this.stroke = { bx, by, bw, bh, mask: new Uint8Array(bw * bh) };
    } else if (!erase) {
      const bx = Math.max(0, Math.min(this.stroke.bx, px0));
      const by = Math.max(0, Math.min(this.stroke.by, py0));
      const bx1 = Math.min(cached.width, Math.max(this.stroke.bx + this.stroke.bw, px1));
      const by1 = Math.min(cached.height, Math.max(this.stroke.by + this.stroke.bh, py1));
      const bw = bx1 - bx;
      const bh = by1 - by;
      if (bw !== this.stroke.bw || bh !== this.stroke.bh || bx !== this.stroke.bx || by !== this.stroke.by) {
        // Reallocate the larger mask and copy the previous mask into it.
        const next = new Uint8Array(bw * bh);
        const dx = this.stroke.bx - bx;
        const dy = this.stroke.by - by;
        for (let row = 0; row < this.stroke.bh; row++) {
          const srcOff = row * this.stroke.bw;
          const dstOff = (row + dy) * bw + dx;
          next.set(this.stroke.mask.subarray(srcOff, srcOff + this.stroke.bw), dstOff);
        }
        this.stroke = { bx, by, bw, bh, mask: next };
      }
    }

    // Apply the patch: OR (add) or AND-NOT (erase).
    const stroke = this.stroke;
    for (let py = 0; py < W; py++) {
      const iy = py0 + py;
      const my = iy - stroke.by;
      if (my < 0 || my >= stroke.bh) continue;
      const srcRow = py * W;
      const dstRow = my * stroke.bw;
      for (let px = 0; px < W; px++) {
        if (!patch.mask[srcRow + px]) continue;
        const ix = px0 + px;
        const mx = ix - stroke.bx;
        if (mx < 0 || mx >= stroke.bw) continue;
        if (erase) stroke.mask[dstRow + mx] = 0;
        else stroke.mask[dstRow + mx] = 1;
      }
    }

    if (!erase) {
      // If the grown stroke now overlaps another path-shape, fold those
      // shapes into this one and drop them — matching QuPath's
      // merge-on-touch behaviour.
      this.mergeOverlappingShapes(regions, rx, ry, cached);
    }

    // Trace the union boundary in image-pixel coords.
    const stroke2 = this.stroke!;
    const poly = this.wandService.maskToPolygon(
      stroke2.mask,
      stroke2.bw,
      stroke2.bh,
      cached.width,
      cached.height,
      stroke2.bx,
      stroke2.by,
    );

    if (!poly) {
      // Erased to nothing — remove the shape entirely.
      if (erase) this.dropActiveShape(regions);
      return;
    }

    // Convert from matrix coords back to plot data coords.
    const xPlot = poly.xpoints.map((x) => ox + x * rx);
    const yPlot = poly.ypoints.map((y) => oy + y * ry);

    this.commitStroke(regions, xPlot, yPlot);
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
   * Remove the region referenced by `strokeRegionId` from the region list and
   * reset the active stroke — used when an erase stroke deletes every pixel.
   */
  private dropActiveShape(regions: Region[]) {
    if (this.strokeRegionId != null) {
      const idx = regions.findIndex((r) => r.id === this.strokeRegionId);
      if (idx >= 0) {
        regions.splice(idx, 1);
        this.host.setRegions(regions);
      }
    }
    this.stroke = null;
    this.strokeRegionId = null;
  }

  /** A region's closed-polygon vertices (image/data coords), or null when it
   *  isn't a fillable closed polygon (rectangles, open polylines). */
  private regionVerts(
    region: Region,
  ): { xpoints: number[]; ypoints: number[]; holes?: number[][][] } | null {
    const b = region?.bounds;
    if (b instanceof Polygon && b.closed !== false && b.xpoints.length >= 3) {
      return { xpoints: b.xpoints, ypoints: b.ypoints, holes: b.holes };
    }
    return null;
  }

  /** Convert a region's hole rings from image/data coords into matrix coords so
   *  they line up with the stroke accumulator (jit-ui#85). */
  private holesToMatrix(
    holes: number[][][] | undefined, ox: number, oy: number, rx: number, ry: number,
  ): number[][][] | undefined {
    return holes?.map((ring) => ring.map(([x, y]) => [(x - ox) / rx, (y - oy) / ry]));
  }

  /**
   * If (matrixX, matrixY) falls inside an existing region, rasterize it into
   * the wand stroke accumulator so subsequent wand input extends it rather than
   * starting a new region.
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
      const holes = this.holesToMatrix(verts.holes, ox, oy, rx, ry);

      // Clicking inside a hole must NOT adopt the donut (it's empty there).
      if (!this.wandService.pointInPolygonWithHoles(matrixX, matrixY, xs, ys, holes)) continue;

      const raster = this.wandService.rasterizePolygon(xs, ys, cached.width, cached.height, holes);
      if (!raster) continue;

      this.stroke = raster;
      this.strokeRegionId = regions[i].id ?? null;
      return true;
    }
    return false;
  }

  /**
   * Iterate every region; if its rasterized mask overlaps the wand stroke mask
   * by at least one pixel, OR it into the stroke and remove it from the list.
   * Called every tick so chained merges resolve. If the wand has no region id
   * yet, the merged region's id is adopted so the merged region replaces it.
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

        const holes = this.holesToMatrix(verts.holes, ox, oy, rx, ry);
        const raster = this.wandService.rasterizePolygon(xs, ys, cached.width, cached.height, holes);
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
   * Commit the in-progress polygon as a region — a new region on the first tick
   * of a stroke, or an in-place replacement of the active region on later ticks
   * — then ask the host to render. The store mints an id on the first commit,
   * which we adopt so subsequent ticks replace the same region.
   */
  private commitStroke(regions: Region[], xPlot: number[], yPlot: number[]) {
    if (xPlot.length < 3) return;

    const existing = this.strokeRegionId != null
      ? regions.find((r) => r.id === this.strokeRegionId) : null;

    const poly = new Polygon();
    poly.npoints = xPlot.length;
    poly.xpoints = xPlot;
    poly.ypoints = yPlot;
    poly.coordinates = xPlot.map((x, i) => [x, yPlot[i]]);
    poly.closed = true;

    const region = new Region();
    region.bounds = poly;
    region.color = this.host.getShapeColor();
    if (existing) {
      // Preserve identity + class label across the stroke's drag ticks.
      region.id = existing.id;
      region.name = existing.name;
    }
    // Default class/annotation name, matching the overlay-drawn regions and the
    // Region Editor's "Add" actions so a wand region isn't left unlabeled.
    region.label = existing?.label ?? 'legend';

    if (this.strokeRegionId == null) {
      regions.push(region);
    } else {
      const idx = regions.findIndex((r) => r.id === this.strokeRegionId);
      if (idx >= 0) regions[idx] = region;
      else regions.push(region);
    }

    this.host.setRegions(regions);
    // The store assigns an id on the first commit — adopt it.
    this.strokeRegionId = region.id ?? this.strokeRegionId;
  }
}
