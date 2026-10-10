import { ToolOverlayCanvas } from '../tool-kit/tool-overlay';
import { CanvasToolHost, ICanvasTool } from '../tool-kit/canvas-tool';

/** A drag shorter than this (CSS px) on either axis is an accidental click. */
const MIN_DRAG_PX = 5;

/**
 * @deprecated One host serves every canvas tool: use {@link CanvasToolHost}.
 * The overlay now attaches to `getOverlayContainer()` (formerly the element
 * with id `getPlotDiv()`), and `pixelToData` / `applyZoomToBox` are its
 * optional zoom-to-box members.
 */
export type ZoomToBoxToolHost = CanvasToolHost;

/**
 * Custom canvas overlay for click-and-drag rectangular zoom. Plotly's
 * built-in `dragmode: 'zoom'` works on heatmap/image traces too, but it
 * doesn't drive the high-def zoom pipeline — this overlay does, by handing
 * the selected coordinates back to the host.
 */
export class ZoomToBoxTool implements ICanvasTool<void> {
  readonly id = 'zoomToBox';
  private host!: CanvasToolHost;
  private readonly overlay = new ToolOverlayCanvas();
  private startPx: { x: number; y: number } | null = null;

  // ── ICanvasTool ─────────────────────────────────────────────────────

  /** Lay the selection overlay over `host`'s plot. */
  activate(host: CanvasToolHost) {
    this.host = host;
    const plotEl = host.getOverlayContainer();
    if (!plotEl) return;
    this.overlay.attach(plotEl, {
      down: (e) => this.onPointerDown(e),
      move: (e) => this.onPointerMove(e),
      up: (e) => this.onPointerUp(e),
    });
  }

  /** Remove the overlay and any half-drawn box. */
  deactivate() {
    this.overlay.detach();
    this.startPx = null;
  }

  // ── Pointer handlers ────────────────────────────────────────────────

  /** Primary button only (the overlay filters the others). */
  private onPointerDown(e: PointerEvent) {
    this.startPx = this.overlay.toLocal(e);
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.startPx) return;
    const p = this.overlay.toLocal(e);
    this.drawSelection(this.startPx.x, this.startPx.y, p.x, p.y);
  }

  private onPointerUp(e: PointerEvent) {
    const start = this.startPx;
    if (!start) return;
    this.startPx = null;
    this.overlay.clear();
    const end = this.overlay.toLocal(e);

    // Ignore tiny drags (accidental clicks).
    if (Math.abs(end.x - start.x) < MIN_DRAG_PX || Math.abs(end.y - start.y) < MIN_DRAG_PX) return;

    // Convert overlay-pixel → data coordinates via the active backend's host.
    const host = this.host;
    if (!host.pixelToData || !host.applyZoomToBox) return;
    const d0 = host.pixelToData(start.x, start.y);
    const d1 = host.pixelToData(end.x, end.y);
    host.applyZoomToBox([Math.min(d0.x, d1.x), Math.max(d0.x, d1.x), Math.max(d0.y, d1.y), Math.min(d0.y, d1.y)]);
  }

  // ── Selection rectangle drawing ─────────────────────────────────────

  private drawSelection(x0: number, y0: number, x1: number, y1: number) {
    const ctx = this.overlay.context();
    if (!ctx) return;
    const cw = this.overlay.cssWidth;
    const ch = this.overlay.cssHeight;

    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);

    ctx.clearRect(0, 0, cw, ch);

    // Semi-transparent overlay covering everything outside the selection.
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    // Outer rectangle (full canvas).
    ctx.rect(0, 0, cw, ch);
    // Inner rectangle (selection cutout) — wound counter-clockwise to create a hole.
    ctx.moveTo(left, top);
    ctx.lineTo(left, top + h);
    ctx.lineTo(left + w, top + h);
    ctx.lineTo(left + w, top);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();

    // Corner notches.
    const notchLen = Math.min(16, w / 4, h / 4);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Top-left.
    ctx.moveTo(left, top + notchLen);
    ctx.lineTo(left, top);
    ctx.lineTo(left + notchLen, top);
    // Top-right.
    ctx.moveTo(left + w - notchLen, top);
    ctx.lineTo(left + w, top);
    ctx.lineTo(left + w, top + notchLen);
    // Bottom-right.
    ctx.moveTo(left + w, top + h - notchLen);
    ctx.lineTo(left + w, top + h);
    ctx.lineTo(left + w - notchLen, top + h);
    // Bottom-left.
    ctx.moveTo(left + notchLen, top + h);
    ctx.lineTo(left, top + h);
    ctx.lineTo(left, top + h - notchLen);
    ctx.stroke();
    ctx.restore();
  }
}
