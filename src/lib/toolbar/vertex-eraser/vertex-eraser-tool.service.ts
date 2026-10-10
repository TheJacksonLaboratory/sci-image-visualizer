import { IVertexEraserOptions } from '../../contracts/display-types';
import { Polygon } from '../../models/region';
import { makePolygon, replaceBounds } from '../../models/polygon-factory';
import { dropVerticesWithinRadius } from '../../geometry/ring';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { UndoGesture, UndoGestureTarget } from '../tool-kit/undo-gesture';
import { ToolOverlayCanvas } from '../tool-kit/tool-overlay';
import { CanvasToolHost, ICanvasTool } from '../tool-kit/canvas-tool';

/**
 * @deprecated One host serves every canvas tool: use {@link CanvasToolHost}.
 * The eraser converts with its readback's per-axis ratios
 * (`getCachedImageData().ratios`, RT-14); `getCachedImageRatio()` is gone.
 */
export type VertexEraserToolHost = CanvasToolHost;

/**
 * Vertex eraser. A custom canvas overlay that, on click/drag, removes any
 * polygon vertex within `radius` matrix-pixels of the cursor from every
 * annotation polygon/polyline (never an intensity-profile line). Polygons that
 * fall below 3 vertices (or polylines below 2) are removed entirely.
 *
 * The cursor is rendered as a dashed-red circle on the overlay so the user
 * can see the active radius while moving.
 */
export class VertexEraserTool implements ICanvasTool<IVertexEraserOptions> {
  readonly id = 'eraseVertex';
  private host!: CanvasToolHost;
  private readonly overlay = new ToolOverlayCanvas();
  private dragging = false;
  /** Eraser radius in image-pixel (matrix) coordinates. */
  private radius = 20;
  private cursor: { x: number; y: number } | null = null;

  /** Makes each drag one undo step, however long the user pauses (RT-12). */
  private readonly gesture: UndoGesture;

  /** @param gestureTarget the region store, so each drag is one undo step. */
  constructor(gestureTarget?: UndoGestureTarget | null) {
    this.gesture = new UndoGesture(gestureTarget);
  }

  // ── ICanvasTool ─────────────────────────────────────────────────────

  /** Arm the eraser on `host`, optionally with a new radius. */
  activate(host: CanvasToolHost, options: IVertexEraserOptions = {}) {
    this.host = host;
    if (options.radius != null) this.setRadius(options.radius);
    this.createOverlay();
  }

  /** Disarm: remove the overlay and its cursor. */
  deactivate() {
    this.overlay.detach();
    this.dragging = false;
    this.gesture.end();
    this.cursor = null;
  }

  setOptions(options: IVertexEraserOptions) {
    if (options.radius != null) this.setRadius(options.radius);
  }

  /** Set eraser radius in matrix-pixel (image pixel) coordinates. */
  setRadius(radius: number) {
    if (!Number.isFinite(radius) || radius <= 0) return;
    this.radius = radius;
    this.drawCursor();
  }

  // ── Overlay lifecycle ───────────────────────────────────────────────

  private createOverlay() {
    const container = this.host.getOverlayContainer();
    if (!container) return;
    this.overlay.attach(container, {
      down: (e) => this.onPointerDown(e),
      move: (e) => this.onPointerMove(e),
      up: () => this.onPointerUp(),
      resize: () => this.drawCursor(), // a resize clears the canvas
    });
  }

  // ── Pointer handlers ────────────────────────────────────────────────

  private onPointerDown(e: PointerEvent) {
    this.dragging = true;
    this.gesture.begin();
    this.updateCursor(e);
    this.applyAtClient(e);
  }

  private onPointerMove(e: PointerEvent) {
    this.updateCursor(e);
    if (!this.dragging) {
      this.drawCursor();
      return;
    }
    if ((e.buttons & 1) === 0) {
      this.dragging = false;
      this.gesture.end();
      this.drawCursor();
      return;
    }
    this.applyAtClient(e);
    this.drawCursor();
  }

  private onPointerUp() {
    this.dragging = false;
    this.gesture.end();
  }

  private updateCursor(e: PointerEvent) {
    if (!this.overlay.attached) return;
    this.cursor = this.overlay.toLocal(e);
  }

  /** Draw the eraser radius circle at the current cursor position. */
  private drawCursor() {
    const ctx = this.overlay.context();
    if (!ctx) return;
    ctx.clearRect(0, 0, this.overlay.cssWidth, this.overlay.cssHeight);
    if (!this.cursor) return;
    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    // Convert matrix-pixel radius to screen-pixel radius via the data scale.
    const screenRadius = transform.dataLengthToScreen(this.radius * this.frame().rx);
    if (!Number.isFinite(screenRadius) || screenRadius <= 0) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(this.cursor.x, this.cursor.y, screenRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ── Per-tick erase logic ────────────────────────────────────────────

  /** The data↔matrix frame of the host's readback (identity without one). */
  private frame(): MatrixFrame {
    return MatrixFrame.from(this.host.getCachedImageData() ?? { ratios: [1] });
  }

  /**
   * Drop every vertex of every annotation polygon/polyline that lies within the
   * eraser's radius of the cursor. Polygons reduced below 3 vertices (or
   * polylines below 2) are removed entirely. Edited regions keep their metadata.
   */
  private applyAtClient(e: PointerEvent) {
    if (!this.overlay.attached) return;
    const regions = this.host.getRegions();
    if (!regions || regions.length === 0) return;

    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;
    const frame = this.frame();
    const cmx = frame.toMatrixX(dataX);
    const cmy = frame.toMatrixY(dataY);

    let anyChange = false;
    for (let i = regions.length - 1; i >= 0; i--) {
      const region = regions[i];
      // Intensity-profile lines belong to the intensity tool, not the annotation set.
      if (region?.kind === 'profile') continue;
      const b = region?.bounds;
      if (!(b instanceof Polygon) || b.xpoints.length === 0) continue;
      const closed = b.closed !== false;
      const ring = frame.ringToMatrix(b.xpoints, b.ypoints);
      const result = dropVerticesWithinRadius(ring.xs, ring.ys, cmx, cmy, this.radius);

      // Erase vertices on interior rings (a donut's inner outline) too, and drop
      // a hole that degenerates below a triangle (jit-ui#85).
      let holesChanged = false;
      let newHoles: number[][][] | undefined;
      if (b.holes) {
        newHoles = [];
        for (const hole of b.holes) {
          const hr = dropVerticesWithinRadius(
            hole.map((p) => frame.toMatrixX(p[0])),
            hole.map((p) => frame.toMatrixY(p[1])),
            cmx,
            cmy,
            this.radius,
          );
          if (hr.removed === 0) {
            newHoles.push(hole); // untouched — keep as-is
          } else {
            holesChanged = true;
            if (hr.xpoints.length >= 3) {
              newHoles.push(hr.xpoints.map((x, k) => [frame.toDataX(x), frame.toDataY(hr.ypoints[k])]));
            } // else: hole collapsed — drop it
          }
        }
        if (newHoles.length === 0) newHoles = undefined;
      }

      if (result.removed === 0 && !holesChanged) continue;

      anyChange = true;
      if (result.xpoints.length < (closed ? 3 : 2)) {
        // Region became degenerate — remove it.
        regions.splice(i, 1);
        continue;
      }

      // Rebuild the polygon in data coords, keeping the region's metadata. Drop
      // any stored bezier handles (the anchor count changed) — they re-derive
      // from the new anchors.
      const data = frame.ringToData(result.xpoints, result.ypoints);
      regions[i] = replaceBounds(
        region,
        makePolygon(data.xs, data.ys, {
          closed,
          bezier: b.bezier,
          holes: newHoles,
        }),
      );
    }

    if (!anyChange) return;
    // A wand/brush stroke over a region edited here is dropped when that tool
    // next runs: it was disarmed (and reset) when the eraser was armed, and its
    // stroke editor discards a stroke whose regions changed (RT-2).
    this.host.setRegions(regions);
  }
}
