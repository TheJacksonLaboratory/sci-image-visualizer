import { Injectable, Optional } from '@angular/core';

import { WandService } from '../wand/wand.service';
import { CachedImageData, WandToolHost } from '../wand/wand-tool.service';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { MaskStrokeEditor } from '../tool-kit/mask-stroke-editor';
import { UndoGesture } from '../tool-kit/undo-gesture';
import { RegionStore } from '../../store/region-store.service';
import { Region } from '../../models/region';

/** Brush parameters. `size` is the brush *diameter* in matrix (image) pixels. */
export interface BrushOptions {
  size?: number;
  /**
   * Paint as one class. With `label` set, new regions take this label, and the
   * stroke only adopts or merges regions that already have it, so painting one
   * class never grows another class's region. `color` colours the painted
   * regions instead of the toolbar's shape colour. Leave both unset for the
   * plain toolbar brush.
   */
  label?: string;
  color?: string;
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
 * Holes / donuts (jit-ui#85): brushing a ring that encloses an unpainted area
 * keeps the enclosed hole — the contour tracer (`geometry/contour`) traces interior
 * rings into {@link Polygon.holes}, which adopt/merge preserve (the re-rasterize
 * punches the holes back out). The OpenSeadragon overlay renders them with
 * even-odd fill and GeoJSON round-trips them as extra Polygon rings. The Plotly
 * (Heatmap) backend currently renders the filled exterior only.
 */
@Injectable({ providedIn: 'root' })
export class BrushToolService {
  private host!: BrushToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private active = false;

  /**
   * Accumulated brush region (bbox-relative mask), shared logic with the wand.
   * Persists across mouseup so a subsequent stroke extends the *same* region
   * until the user switches tool — matching QuPath, and the wand.
   */
  private readonly editor = new MaskStrokeEditor();
  /** Previous cursor position (matrix coords) within the current drag, so fast
   *  drags paint a continuous stroke rather than disconnected dabs. */
  private lastMatrix: { x: number; y: number } | null = null;
  private dragging = false;
  private size = DEFAULT_BRUSH_SIZE;
  /** The class being painted ({@link BrushOptions.label} / `color`); null = plain brush. */
  private paintClass: { label?: string; color?: string } | null = null;

  private readonly boundMouseDown: (e: MouseEvent) => void;
  private readonly boundMouseMove: (e: MouseEvent) => void;
  private readonly boundMouseUp: (e: MouseEvent) => void;

  /** Makes each drag one undo step, however long the user pauses (RT-12). */
  private readonly gesture: UndoGesture;

  constructor(@Optional() regionStore?: RegionStore) {
    this.gesture = new UndoGesture(regionStore);
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
    // Size applies whether arming or not, as before brush classes: a host may set it
    // while the brush is off, and the next arm without options keeps it.
    if (options.size != null) this.setSize(options.size);
    if (active) {
      // Arming sets the class in full: no label/color means the plain brush.
      this.setOptions({ label: undefined, color: undefined, ...options });
      this.createOverlay();
    } else {
      this.destroyOverlay();
      this.paintClass = null;
    }
  }

  /**
   * Update size and/or class while armed. The class changes only when `label`
   * or `color` is passed (as a key, even `undefined`), so a size-only update
   * keeps it. Switching class drops the active region, so the next stroke
   * starts a region of the new class.
   */
  setOptions(options: BrushOptions = {}) {
    if (options.size != null) this.setSize(options.size);
    if (!('label' in options) && !('color' in options)) return;
    const next = options.label != null || options.color != null
      ? { label: options.label, color: options.color }
      : null;
    if (next?.label !== this.paintClass?.label || next?.color !== this.paintClass?.color) {
      this.resetStroke();
    }
    this.paintClass = next;
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
    this.gesture.begin();
    this.lastMatrix = null; // first stamp of this drag is a single dab
    this.applyAtClient(e, true);
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.dragging) return;
    if ((e.buttons & 1) === 0) {
      this.dragging = false;
      this.gesture.end();
      return;
    }
    this.applyAtClient(e, false);
  }

  private onMouseUp(_: MouseEvent) {
    // Stop accumulating from this drag, but keep the region alive so the next
    // mousedown extends it. Clear lastMatrix so the next drag starts a dab.
    this.dragging = false;
    this.gesture.end();
    this.lastMatrix = null;
  }

  private resetStroke() {
    this.editor.reset();
    this.lastMatrix = null;
    this.dragging = false;
    this.gesture.end();
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
    const editor = this.editor;
    editor.invalidateIfStale(regions);

    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;

    const frame = MatrixFrame.from(cached);
    editor.syncFrame(frame);
    const matrixX = frame.toMatrixX(dataX);
    const matrixY = frame.toMatrixY(dataY);
    if (matrixX < 0 || matrixX >= cached.width) return;
    if (matrixY < 0 || matrixY >= cached.height) return;

    const erase = e.shiftKey;
    const radius = Math.max(0.5, this.size / 2);

    // Start of a fresh drag that isn't inside the current accumulator: drop the
    // old stroke so a brand-new region starts here (mirrors the wand).
    if (isStart && !erase && editor.stroke && !editor.contains(matrixX, matrixY)) {
      editor.reset();
    }

    // If there's no active region, adopt an existing shape under the cursor so
    // the stroke extends (or erases from) it instead of creating a new region.
    const accept = (r: Region) => this.paintsInto(r);
    if (!editor.stroke) editor.adoptAt(regions, matrixX, matrixY, frame, cached, accept);

    // Erasing requires an existing region — shift on empty space is a no-op.
    if (erase && !editor.stroke) {
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

    if (!editor.stroke) return;

    // Growing into another shape folds it into this stroke (merge-on-touch).
    if (!erase) editor.mergeTouching(regions, frame, cached, accept);

    // Every connected piece is committed: an erase that cuts through the region
    // splits it in two and both survive (the larger keeps the region identity),
    // and enclosed unpainted areas stay holes (jit-ui#85).
    const paint = this.paintClass;
    editor.commit(regions, frame, this.host, {
      erase,
      defaultLabel: paint?.label ?? 'Region',
      // An explicit class colour must survive a preset (re)apply, like a colour
      // picked in the region editor (jit-ui#70).
      editPatch: paint?.color != null ? { color: paint.color, colorOverridden: true } : undefined,
      newRegion: (bounds) => {
        const region = new Region();
        region.bounds = bounds;
        region.color = paint?.color ?? this.host.getShapeColor();
        if (paint?.color != null) region.colorOverridden = true;
        // Default class/annotation name, matching the overlay-drawn regions and the
        // wand so a brush region isn't left unlabeled.
        region.label = paint?.label ?? 'Region';
        return region;
      },
    });
  }

  /**
   * OR (add) or AND-NOT (erase) a filled disc of `radius` matrix-pixels centred
   * at (cx, cy) into the accumulator, growing its bbox (clipped to the
   * readback) to fit when adding.
   */
  private stampDisc(cx: number, cy: number, radius: number, erase: boolean, cached: CachedImageData) {
    const px0 = Math.floor(cx - radius);
    const py0 = Math.floor(cy - radius);
    const px1 = Math.ceil(cx + radius) + 1;
    const py1 = Math.ceil(cy + radius) + 1;

    if (!erase) {
      const ok = this.editor.ensureCovers(
        Math.max(0, px0), Math.max(0, py0), Math.min(cached.width, px1), Math.min(cached.height, py1),
      );
      if (!ok) return;
    }
    const s = this.editor.stroke;
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

  /** Whether the stroke may adopt or merge `region`: always for the plain brush,
   *  otherwise only a region of the class being painted. */
  private paintsInto(region: Region): boolean {
    const label = this.paintClass?.label;
    return label == null || region?.label === label;
  }
}
