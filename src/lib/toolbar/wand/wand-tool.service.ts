import { WandImage, WandOptions, WandService } from './wand.service';
import { BBoxMask } from '../../geometry/raster';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { MaskStrokeEditor } from '../tool-kit/mask-stroke-editor';
import { UndoGesture, UndoGestureTarget } from '../tool-kit/undo-gesture';
import { ToolOverlayCanvas } from '../tool-kit/tool-overlay';
import { CanvasToolHost, ICanvasTool } from '../tool-kit/canvas-tool';
import { Region } from '../../models/region';

// The readback type lives with the tool contract now; re-exported for the
// modules that import it from here.
export type { CachedImageData } from '../tool-kit/canvas-tool';

/** @deprecated One host serves every canvas tool: use {@link CanvasToolHost}. */
export type WandToolHost = CanvasToolHost;

/**
 * The wand drawing tool. Owns its pointer overlay and stroke accumulator
 * (shared with the brush, see {@link MaskStrokeEditor}). Reads/writes regions
 * via its {@link CanvasToolHost} so it stays decoupled from the backends.
 *
 * A plain class: each backend's `CanvasToolManager` owns one instance and arms
 * it with `activate(host, options)` / `deactivate()`.
 */
export class WandTool implements ICanvasTool<WandOptions> {
  readonly id = 'wand';

  // ── Tool state ──────────────────────────────────────────────────────

  private host!: CanvasToolHost;
  private readonly overlay = new ToolOverlayCanvas();
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

  /** @param gestureTarget the region store, so each drag is one undo step. */
  constructor(
    private readonly wandService: WandService,
    gestureTarget?: UndoGestureTarget | null,
  ) {
    this.gesture = new UndoGesture(gestureTarget);
  }

  // ── ICanvasTool ─────────────────────────────────────────────────────

  /** Arm the wand on `host` with `options` (replacing the previous options). */
  activate(host: CanvasToolHost, options: WandOptions = {}) {
    this.host = host;
    this.options = options;
    this.createOverlay();
  }

  /** Disarm: remove the overlay and drop the active region. */
  deactivate() {
    this.overlay.detach();
    this.resetStroke();
  }

  /** Merge new options (e.g. live sensitivity slider updates). */
  setOptions(options: WandOptions) {
    this.options = { ...this.options, ...options };
  }

  /** Drop the active wand region so the next click starts a new one. */
  reset() {
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
        Math.max(0, px0),
        Math.max(0, py0),
        Math.min(cached.width, px0 + W),
        Math.min(cached.height, py0 + W),
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
