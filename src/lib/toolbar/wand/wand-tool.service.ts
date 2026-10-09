import { Injectable, Optional } from '@angular/core';

import { WandImage, WandOptions, WandService } from './wand.service';
import { BBoxMask } from '../../geometry/raster';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { MaskStrokeEditor } from '../tool-kit/mask-stroke-editor';
import { UndoGesture } from '../tool-kit/undo-gesture';
import { ToolOverlayCanvas } from '../tool-kit/tool-overlay';
import { RegionStore } from '../../store/region-store.service';
import { IViewportHost, IRegionDataHost } from '../../contracts/coordinate-transform.contract';
import { Region } from '../../models/region';

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
  private readonly overlay = new ToolOverlayCanvas();
  private active = false;
  /**
   * Accumulated wand region. Every per-tick patch mask is OR'd into the stroke
   * over a bbox that grows with the stroke, so the region keeps expanding as
   * the user drags. The accumulator persists across mouseup/mousedown so that
   * subsequent strokes extend the *same* region — matching QuPath's brush
   * behaviour where the active annotation stays editable until the user
   * switches tool.
   */
  private readonly editor = new MaskStrokeEditor();
  private dragging = false;
  private options: WandOptions = {};

  /** Makes each drag one undo step, however long the user pauses (RT-12). */
  private readonly gesture: UndoGesture;

  constructor(private wandService: WandService, @Optional() regionStore?: RegionStore) {
    this.gesture = new UndoGesture(regionStore);
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
    const container = this.host.getOverlayContainer();
    if (!container) return;
    this.overlay.attach(container, {
      down: (e) => this.onPointerDown(e),
      move: (e) => this.onPointerMove(e),
      up: () => this.onPointerUp(),
    });
  }

  private destroyOverlay() {
    if (!this.overlay.attached) return;
    this.overlay.detach();
    this.resetStroke();
  }

  private onPointerDown(e: PointerEvent) {
    this.dragging = true;
    this.gesture.begin();
    this.applyAtClient(e, true);
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.dragging) return;
    if ((e.buttons & 1) === 0) {
      this.dragging = false;
      this.gesture.end();
      return;
    }
    this.applyAtClient(e, false);
  }

  private onPointerUp() {
    // Stop accumulating from this drag, but keep the region alive so the
    // next mousedown extends it instead of starting fresh.
    this.dragging = false;
    this.gesture.end();
  }

  private resetStroke() {
    this.editor.reset();
    this.dragging = false;
    this.gesture.end();
  }

  // ── Per-tick stroke logic ───────────────────────────────────────────

  /**
   * Sample the cached image at the click location, OR (or AND-NOT) the
   * wand's per-tick patch mask into the active region's bbox-relative mask,
   * re-trace the boundary, and update the in-progress shape — matching
   * QuPath's additive brush/wand behaviour. Shift = erase. Cmd/Ctrl =
   * exact-match flood fill.
   */
  private applyAtClient(e: PointerEvent, isStart = false) {
    if (!this.overlay.attached) return;
    const cached = this.host.getCachedImageData();
    if (!cached || cached.frames.length === 0) return;

    // The current regions (neutral model). Mutated locally across this tick and
    // committed once via host.setRegions().
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

    const frameIdx = this.host.getActiveFrameIndex();
    const wandImage: WandImage = {
      data: cached.frames[frameIdx] ?? cached.frames[0],
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

    // A new drag that starts outside the current accumulator starts a new region
    // (or adopts the one under the cursor) instead of growing the old stroke's
    // bbox to span both areas.
    if (isStart && !erase && editor.stroke && !editor.contains(matrixX, matrixY)) {
      editor.reset();
    }

    const patch = this.wandService.computePatchMask(wandImage, matrixX, matrixY, opts);
    if (!patch) return;

    const W = patch.size;
    const half = (W - 1) / 2;
    const px0 = Math.round(matrixX) - half;
    const py0 = Math.round(matrixY) - half;

    // With no active region, a click on an existing region adopts it so this
    // stroke extends (or erases from) it.
    if (!editor.stroke) editor.adoptAt(regions, matrixX, matrixY, frame, cached);

    // Erasing requires an existing region. Shift-clicking empty space is a
    // no-op — we don't create a region only to immediately delete from it.
    if (erase && !editor.stroke) return;

    if (!editor.stroke) {
      // A fresh stroke starts at the patch, clipped to the readback.
      const ok = editor.ensureCovers(
        Math.max(0, px0), Math.max(0, py0),
        Math.min(cached.width, px0 + W), Math.min(cached.height, py0 + W),
      );
      if (!ok) return;
    } else if (!erase) {
      // Don't clamp a growing stroke to the viewport: an adopted region may extend
      // off-screen, and clamping would discard that part (jit-ui#102). Erasing never
      // grows the stroke.
      editor.ensureCovers(px0, py0, px0 + W, py0 + W);
    }

    // Apply the patch: OR (add) or AND-NOT (erase).
    const stroke = editor.stroke as BBoxMask;
    for (let py = 0; py < W; py++) {
      const my = py0 + py - stroke.by;
      if (my < 0 || my >= stroke.bh) continue;
      const srcRow = py * W;
      const dstRow = my * stroke.bw;
      for (let px = 0; px < W; px++) {
        if (!patch.mask[srcRow + px]) continue;
        const mx = px0 + px - stroke.bx;
        if (mx < 0 || mx >= stroke.bw) continue;
        stroke.mask[dstRow + mx] = erase ? 0 : 1;
      }
    }

    // Growing into other regions folds them in (QuPath's merge-on-touch).
    if (!erase) editor.mergeTouching(regions, frame, cached);

    editor.commit(regions, frame, this.host, {
      erase,
      defaultLabel: 'Region',
      newRegion: (bounds) => {
        const region = new Region();
        region.bounds = bounds;
        region.color = this.host.getShapeColor();
        // Default class/annotation name, matching the overlay-drawn regions and the
        // Region Editor's "Add" actions so a wand region isn't left unlabeled.
        region.label = 'Region';
        return region;
      },
    });
  }
}
