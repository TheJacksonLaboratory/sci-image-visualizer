import { Injectable } from '@angular/core';

import { ToolOverlayCanvas } from '../tool-kit/tool-overlay';

/** A drag shorter than this (CSS px) on either axis is an accidental click. */
const MIN_DRAG_PX = 5;

/**
 * Collaboration interface the zoom-to-box tool needs from its host backend
 * (Plotly, OpenSeadragon or napari-js).
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
  private readonly overlay = new ToolOverlayCanvas();
  private startPx: { x: number; y: number } | null = null;

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
    if (!plotEl) return;
    this.overlay.attach(plotEl, {
      down: (e) => this.onPointerDown(e),
      move: (e) => this.onPointerMove(e),
      up: (e) => this.onPointerUp(e),
    });
  }

  private destroyOverlay() {
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
    const d0 = this.host.pixelToData(start.x, start.y);
    const d1 = this.host.pixelToData(end.x, end.y);
    this.host.applyZoomToBox([
      Math.min(d0.x, d1.x), Math.max(d0.x, d1.x),
      Math.max(d0.y, d1.y), Math.min(d0.y, d1.y),
    ]);
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
