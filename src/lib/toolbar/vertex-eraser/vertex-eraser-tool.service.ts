import { Injectable, Optional } from '@angular/core';

import { IViewportHost, IRegionDataHost } from '../../contracts/coordinate-transform.contract';
import { Region, Polygon } from '../../models/region';
import { makePolygon, replaceBounds } from '../../models/polygon-factory';
import { dropVerticesWithinRadius } from '../../geometry/ring';
import type { CachedImageData } from '../wand/wand-tool.service';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { UndoGesture } from '../tool-kit/undo-gesture';
import { ToolOverlayCanvas } from '../tool-kit/tool-overlay';
import { RegionStore } from '../../store/region-store.service';

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
   * backend's data coordinates when {@link getCachedImageData} isn't provided.
   */
  getCachedImageRatio(): number;
  /**
   * The readback the wand samples, if the host exposes it to the eraser. Its
   * per-axis ratios keep the eraser circle round in image pixels on an
   * anisotropic readback; without it `getCachedImageRatio()` is used for both
   * axes.
   */
  getCachedImageData?(): CachedImageData | null;
}

/**
 * Vertex eraser. A custom canvas overlay that, on click/drag, removes any
 * polygon vertex within `radius` matrix-pixels of the cursor from every
 * annotation polygon/polyline (never an intensity-profile line). Polygons that
 * fall below 3 vertices (or polylines below 2) are removed entirely.
 *
 * The cursor is rendered as a dashed-red circle on the overlay so the user
 * can see the active radius while moving.
 */
@Injectable({ providedIn: 'root' })
export class VertexEraserToolService {

  private host!: VertexEraserToolHost;
  private readonly overlay = new ToolOverlayCanvas();
  private dragging = false;
  /** Eraser radius in image-pixel (matrix) coordinates. */
  private radius = 20;
  private cursor: { x: number; y: number } | null = null;

  /** Makes each drag one undo step, however long the user pauses (RT-12). */
  private readonly gesture: UndoGesture;

  constructor(@Optional() regionStore?: RegionStore) {
    this.gesture = new UndoGesture(regionStore);
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
    const container = this.host.getOverlayContainer();
    if (!container) return;
    this.overlay.attach(container, {
      down: (e) => this.onPointerDown(e),
      move: (e) => this.onPointerMove(e),
      up: () => this.onPointerUp(),
      resize: () => this.drawCursor(), // a resize clears the canvas
    });
  }

  private destroyOverlay() {
    if (!this.overlay.attached) return;
    this.overlay.detach();
    this.dragging = false;
    this.gesture.end();
    this.cursor = null;
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

  /** The data↔matrix frame: the host's readback when exposed, else its single ratio. */
  private frame(): MatrixFrame {
    const cached = this.host.getCachedImageData?.();
    return MatrixFrame.from(cached ?? { ratios: [this.host.getCachedImageRatio()] });
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
            hole.map((p) => frame.toMatrixX(p[0])), hole.map((p) => frame.toMatrixY(p[1])),
            cmx, cmy, this.radius);
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
      regions[i] = replaceBounds(region, makePolygon(data.xs, data.ys, {
        closed, bezier: b.bezier, holes: newHoles,
      }));
    }

    if (!anyChange) return;
    // The wand's stroke mask becomes stale once we trim vertices off any
    // region — drop it so the next wand interaction re-adopts or restarts.
    this.host.invalidateWandRegion();
    this.host.setRegions(regions);
  }
}
