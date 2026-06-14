import { Injectable } from '@angular/core';

/**
 * Collaboration interface the zoom-to-box tool needs from PlotlyService.
 */
export interface ZoomToBoxToolHost {
  /** DOM id of the plot element the overlay canvas attaches to. */
  getPlotDiv(): string;
  /**
   * Convert an overlay-pixel point (relative to the plot element's top-left)
   * into the backend's data coordinates — Plotly axis data for Plotly,
   * image-pixel coords for OpenSeadragon. Keeps the tool backend-agnostic.
   */
  pixelToData(px: number, py: number): { x: number; y: number };
  /**
   * Apply the user-selected zoom rectangle, ordered `[xMin, xMax, yMax, yMin]`.
   * The host decides what that means: Plotly does a high-def re-fetch / axis
   * relayout, OpenSeadragon fits the viewport to the image rectangle.
   */
  applyZoomToBox(coordinates: number[]): void;
}

/**
 * Custom canvas overlay for click-and-drag rectangular zoom. Plotly's
 * built-in `dragmode: 'zoom'` works on heatmap/image traces too, but it
 * doesn't drive the high-def zoom pipeline — this overlay does, by handing
 * the selected coordinates back to the host.
 */
@Injectable({ providedIn: 'root' })
export class ZoomToBoxToolService {

  private host!: ZoomToBoxToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private startPx: { x: number; y: number } | null = null;

  private readonly boundMouseDown: (e: MouseEvent) => void;
  private readonly boundMouseMove: (e: MouseEvent) => void;
  private readonly boundMouseUp: (e: MouseEvent) => void;

  constructor() {
    this.boundMouseDown = (e) => this.onMouseDown(e);
    this.boundMouseMove = (e) => this.onMouseMove(e);
    this.boundMouseUp = (e) => this.onMouseUp(e);
  }

  bindHost(host: ZoomToBoxToolHost) {
    this.host = host;
  }

  setMode(active: boolean) {
    if (active) {
      this.createOverlay();
    } else {
      this.destroyOverlay();
    }
  }

  // ── Overlay lifecycle ───────────────────────────────────────────────

  private createOverlay() {
    const plotEl = document.getElementById(this.host.getPlotDiv());
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
    this.startPx = null;
  }

  // ── Mouse handlers ──────────────────────────────────────────────────

  private onMouseDown(e: MouseEvent) {
    const rect = this.overlay!.getBoundingClientRect();
    this.startPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.startPx || !this.overlay) return;
    const rect = this.overlay.getBoundingClientRect();
    this.drawSelection(
      this.startPx.x, this.startPx.y,
      e.clientX - rect.left, e.clientY - rect.top
    );
  }

  private onMouseUp(e: MouseEvent) {
    if (!this.startPx || !this.overlay) return;
    const rect = this.overlay.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;

    // Ignore tiny drags (accidental clicks).
    if (Math.abs(endX - this.startPx.x) < 5 || Math.abs(endY - this.startPx.y) < 5) {
      this.startPx = null;
      this.clearCanvas();
      return;
    }

    // Convert overlay-pixel → data coordinates via the active backend's host.
    const d0 = this.host.pixelToData(this.startPx.x, this.startPx.y);
    const d1 = this.host.pixelToData(endX, endY);

    const coordinates = [
      Math.min(d0.x, d1.x), Math.max(d0.x, d1.x),
      Math.max(d0.y, d1.y), Math.min(d0.y, d1.y),
    ];

    this.startPx = null;
    this.clearCanvas();

    this.host.applyZoomToBox(coordinates);
  }

  // ── Selection rectangle drawing ─────────────────────────────────────

  private drawSelection(x0: number, y0: number, x1: number, y1: number) {
    const canvas = this.overlay!;
    const ctx = canvas.getContext('2d')!;

    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Semi-transparent overlay covering everything outside the selection.
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    // Outer rectangle (full canvas).
    ctx.rect(0, 0, canvas.width, canvas.height);
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

  private clearCanvas() {
    if (!this.overlay) return;
    const ctx = this.overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}
