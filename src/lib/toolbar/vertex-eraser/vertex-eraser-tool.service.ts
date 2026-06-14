import { Injectable } from '@angular/core';

import { WandService } from '../wand/wand.service';
import { IViewportHost, IRegionDataHost } from '../../contracts/coordinate-transform.contract';
import { Region, Polygon } from '../../models/region';

/**
 * Collaboration interface the vertex eraser needs from its host backend.
 *
 * Extends {@link IViewportHost} for coordinate conversion + overlay attachment,
 * so the eraser is backend-agnostic (Plotly and OpenSeadragon both satisfy it).
 */
export interface VertexEraserToolHost extends IViewportHost, IRegionDataHost {
  /**
   * Drop the wand's in-progress stroke. Called after the eraser modifies
   * regions — the wand's accumulator may now reference stale vertices.
   */
  invalidateWandRegion(): void;
  /**
   * Data-coords-per-image-pixel ratio (== cachedImageRatios[0] || 1). Used to
   * convert between matrix coordinates (the eraser's native space) and the
   * backend's data coordinates.
   */
  getCachedImageRatio(): number;
}

/**
 * Vertex eraser. A custom canvas overlay that, on click/drag, removes any
 * polygon vertex within `radius` matrix-pixels of the cursor from every
 * `type: 'path'` shape on the plot. Polygons that fall below 3 vertices
 * (or polylines below 2) are removed entirely.
 *
 * The cursor is rendered as a dashed-red circle on the overlay so the user
 * can see the active radius while moving.
 */
@Injectable({ providedIn: 'root' })
export class VertexEraserToolService {

  private host!: VertexEraserToolHost;
  private overlay: HTMLCanvasElement | null = null;
  private dragging = false;
  /** Eraser radius in image-pixel (matrix) coordinates. */
  private radius = 20;
  private cursor: { x: number; y: number } | null = null;

  private readonly boundMouseDown: (e: MouseEvent) => void;
  private readonly boundMouseMove: (e: MouseEvent) => void;
  private readonly boundMouseUp: (e: MouseEvent) => void;

  constructor(private wandService: WandService) {
    this.boundMouseDown = (e) => this.onMouseDown(e);
    this.boundMouseMove = (e) => this.onMouseMove(e);
    this.boundMouseUp = (e) => this.onMouseUp(e);
  }

  bindHost(host: VertexEraserToolHost) {
    this.host = host;
  }

  // ── Public API ──────────────────────────────────────────────────────

  setMode(active: boolean) {
    if (active) {
      this.createOverlay();
    } else {
      this.destroyOverlay();
    }
  }

  /** Set eraser radius in matrix-pixel (image pixel) coordinates. */
  setRadius(radius: number) {
    if (!Number.isFinite(radius) || radius <= 0) return;
    this.radius = radius;
    this.drawCursor();
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
    this.dragging = false;
    this.cursor = null;
  }

  // ── Mouse handlers ──────────────────────────────────────────────────

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    this.dragging = true;
    this.updateCursor(e);
    this.applyAtClient(e);
  }

  private onMouseMove(e: MouseEvent) {
    this.updateCursor(e);
    if (!this.dragging) {
      this.drawCursor();
      return;
    }
    if ((e.buttons & 1) === 0) {
      this.dragging = false;
      this.drawCursor();
      return;
    }
    this.applyAtClient(e);
    this.drawCursor();
  }

  private onMouseUp(_: MouseEvent) {
    this.dragging = false;
  }

  private updateCursor(e: MouseEvent) {
    if (!this.overlay) return;
    const rect = this.overlay.getBoundingClientRect();
    this.cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Draw the eraser radius circle at the current cursor position. */
  private drawCursor() {
    if (!this.overlay) return;
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.cursor) return;
    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    // Convert matrix-pixel radius to screen-pixel radius via the data scale.
    const rx = this.host.getCachedImageRatio();
    const screenRadius = transform.dataLengthToScreen(this.radius * rx);
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

  /**
   * Drop every vertex of every path-shape that lies within the eraser's
   * radius of the cursor. Polygons reduced below 3 vertices (or polylines
   * below 2) are removed entirely.
   */
  private applyAtClient(e: MouseEvent) {
    if (!this.overlay) return;
    const regions = this.host.getRegions();
    if (!regions || regions.length === 0) return;

    const transform = this.host.getCoordinateTransform();
    if (!transform.isReady()) return;
    const { x: dataX, y: dataY } = transform.clientToData(e.clientX, e.clientY);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) return;
    const rx = this.host.getCachedImageRatio();
    const cmx = dataX / rx;
    const cmy = dataY / rx;

    let anyChange = false;
    for (let i = regions.length - 1; i >= 0; i--) {
      const region = regions[i];
      const b = region?.bounds;
      if (!(b instanceof Polygon) || b.xpoints.length === 0) continue;
      const closed = b.closed !== false;
      const xs = b.xpoints.map(x => x / rx);
      const ys = b.ypoints.map(y => y / rx);

      const result = this.wandService.dropVerticesWithinRadius(xs, ys, cmx, cmy, this.radius);
      if (result.removed === 0) continue;

      anyChange = true;
      const minVerts = closed ? 3 : 2;
      if (result.xpoints.length < minVerts) {
        // Region became degenerate — remove it.
        regions.splice(i, 1);
        continue;
      }

      // Rebuild the polygon in image/data coords. Drop any stored bezier
      // handles (the anchor count changed) — they re-derive from the new anchors.
      const xPlot = result.xpoints.map(x => x * rx);
      const yPlot = result.ypoints.map(y => y * rx);
      const poly = new Polygon();
      poly.npoints = xPlot.length;
      poly.xpoints = xPlot;
      poly.ypoints = yPlot;
      poly.coordinates = xPlot.map((x, k) => [x, yPlot[k]]);
      poly.closed = closed;
      poly.bezier = b.bezier;

      const nr = new Region();
      nr.id = region.id;
      nr.name = region.name;
      nr.label = region.label;
      nr.color = region.color;
      nr.bounds = poly;
      regions[i] = nr;
    }

    if (!anyChange) return;
    // The wand's stroke mask becomes stale once we trim vertices off any
    // region — drop it so the next wand interaction re-adopts or restarts.
    this.host.invalidateWandRegion();
    this.host.setRegions(regions);
  }
}
