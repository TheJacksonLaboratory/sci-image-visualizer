import { Subscription } from 'rxjs';

import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { Region, Rectangle, Polygon } from '../../models/region';
import { RegionStore } from '../../store/region-store.service';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Min drag (image px) before a freehand path records another point. */
const FREEHAND_STEP = 2;
/** Click-distance (screen px) within which a polygon click snaps closed onto the first vertex. */
const CLOSE_SNAP_PX = 10;

/** The slice of the napari Viewer the overlay needs (coord transforms + control gating). */
interface OverlayViewer {
  canvasToWorld(clientX: number, clientY: number): [number, number];
  worldToCanvas(worldX: number, worldY: number): [number, number];
  setControlsEnabled(enabled: boolean): void;
  readonly camera: { readonly changed: { connect(listener: () => void): () => void } };
}

/**
 * SVG region overlay for the napari-js WebGPU image view (jit-ui#102), mirroring the OSD backend's
 * {@link OsdRegionOverlay} but driven by napari's `canvasToWorld`/`worldToCanvas` transforms.
 * Vector shapes are drawn in an absolutely-positioned `<svg>` over the canvas (no need to push
 * them through WebGPU). It writes completed shapes to the shared {@link RegionStore} (so save /
 * undo / export work identically to OSD) and re-renders from the store on every camera move,
 * region change, and selection change.
 *
 * 5a scope (jit-ui#102): rectangle / polygon / freehand path drawing, click-select, and pan/zoom
 * gating via `setControlsEnabled`. Vertex move/add/delete, body move, and bezier come next (5b).
 */
export class NapariRegionOverlay implements IRegionOverlay {
  private readonly svg: SVGSVGElement;
  private readonly subs = new Subscription();
  private readonly disconnectCamera: () => void;

  private mode: RegionToolMode = 'none';
  private selected: number[] = [];

  /** In-progress drawing state (image-space). */
  private draftRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private draftPath: Array<[number, number]> | null = null; // freehand or click polygon
  private drawing = false; // pointer is down for rect / freehand

  constructor(
    private readonly host: HTMLElement,
    private readonly viewer: OverlayViewer,
    private readonly store: RegionStore,
  ) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.svg = document.createElementNS(SVG_NS, 'svg');
    Object.assign(this.svg.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '20',
      pointerEvents: 'none', // until a tool activates
      touchAction: 'none',
    } as Partial<CSSStyleDeclaration>);
    this.host.appendChild(this.svg);

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('dblclick', this.onDblClick);

    this.subs.add(this.store.getRegionUpdateEvent().subscribe(() => this.redraw()));
    this.subs.add(
      this.store.getSelectedShapeIndices$().subscribe((idx) => {
        this.selected = idx ?? [];
        this.redraw();
      }),
    );
    this.disconnectCamera = this.viewer.camera.changed.connect(() => this.redraw());
    this.redraw();
  }

  // ── IRegionOverlay ────────────────────────────────────────────────────────
  setMode(mode: RegionToolMode): void {
    this.mode = mode;
    this.draftRect = null;
    this.draftPath = null;
    this.drawing = false;
    // The overlay owns pointer/navigation gating: while a tool is active it captures the pointer
    // and the napari camera controls are disabled; 'none' hands the pointer back for pan/zoom.
    const active = mode !== 'none';
    this.viewer.setControlsEnabled(!active);
    this.svg.style.pointerEvents = active ? 'auto' : 'none';
    this.svg.style.cursor = active ? 'crosshair' : 'default';
    this.redraw();
  }

  setSelectedBezier(_bezier: boolean): void {
    // 5b: bezier conversion of the selected polygon.
  }

  destroy(): void {
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    this.svg.removeEventListener('pointermove', this.onPointerMove);
    this.svg.removeEventListener('pointerup', this.onPointerUp);
    this.svg.removeEventListener('dblclick', this.onDblClick);
    this.disconnectCamera();
    this.subs.unsubscribe();
    if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
  }

  // ── coordinate transforms ─────────────────────────────────────────────────
  /** Pointer client coords → rounded image coords. */
  private toImage(clientX: number, clientY: number): [number, number] {
    const [wx, wy] = this.viewer.canvasToWorld(clientX, clientY);
    return [Math.round(wx), Math.round(wy)];
  }

  /** Image coords → SVG-local px (the svg overlays the canvas at the same client rect). */
  private toLocal(imgX: number, imgY: number): [number, number] {
    const [cx, cy] = this.viewer.worldToCanvas(imgX, imgY);
    const r = this.svg.getBoundingClientRect();
    return [cx - r.left, cy - r.top];
  }

  // ── pointer handlers ──────────────────────────────────────────────────────
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.mode === 'none') return;
    e.preventDefault();
    const [ix, iy] = this.toImage(e.clientX, e.clientY);
    if (this.mode === 'drawrect') {
      this.draftRect = { x0: ix, y0: iy, x1: ix, y1: iy };
      this.drawing = true;
      this.svg.setPointerCapture(e.pointerId);
    } else if (this.mode === 'drawclosedpath' || this.mode === 'drawopenpath') {
      this.draftPath = [[ix, iy]];
      this.drawing = true;
      this.svg.setPointerCapture(e.pointerId);
    } else if (this.mode === 'drawpolygon') {
      this.handlePolygonClick(ix, iy, e.clientX, e.clientY);
    } else if (this.mode === 'select') {
      this.handleSelectClick(ix, iy);
    }
    this.redraw();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.drawing) return;
    const [ix, iy] = this.toImage(e.clientX, e.clientY);
    if (this.draftRect) {
      this.draftRect.x1 = ix;
      this.draftRect.y1 = iy;
    } else if (this.draftPath) {
      const last = this.draftPath[this.draftPath.length - 1];
      if (Math.abs(ix - last[0]) >= FREEHAND_STEP || Math.abs(iy - last[1]) >= FREEHAND_STEP) {
        this.draftPath.push([ix, iy]);
      }
    }
    this.redraw();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.drawing) return;
    this.drawing = false;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
    if (this.draftRect) {
      const { x0, y0, x1, y1 } = this.draftRect;
      const x = Math.min(x0, x1);
      const y = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y1 - y0);
      this.draftRect = null;
      if (w >= 2 && h >= 2) this.commitRectangle(x, y, w, h);
    } else if (this.draftPath) {
      const pts = this.draftPath;
      this.draftPath = null;
      const closed = this.mode === 'drawclosedpath';
      if (pts.length >= (closed ? 3 : 2)) this.commitPolygon(pts, closed);
    }
    this.redraw();
  };

  /** Click-to-place polygon: add a vertex, or close when clicking near the first one. */
  private handlePolygonClick(ix: number, iy: number, clientX: number, clientY: number): void {
    if (!this.draftPath) {
      this.draftPath = [[ix, iy]];
      return;
    }
    const [fx, fy] = this.toLocal(this.draftPath[0][0], this.draftPath[0][1]);
    const r = this.svg.getBoundingClientRect();
    const near =
      Math.hypot(clientX - r.left - fx, clientY - r.top - fy) <= CLOSE_SNAP_PX &&
      this.draftPath.length >= 3;
    if (near) {
      const pts = this.draftPath;
      this.draftPath = null;
      this.commitPolygon(pts, true);
    } else {
      this.draftPath.push([ix, iy]);
    }
  }

  private readonly onDblClick = (e: MouseEvent): void => {
    if (this.mode !== 'drawpolygon' || !this.draftPath) return;
    e.preventDefault();
    const pts = this.draftPath;
    this.draftPath = null;
    if (pts.length >= 3) this.commitPolygon(pts, true);
    this.redraw();
  };

  private handleSelectClick(ix: number, iy: number): void {
    const regions = this.store.getRegions();
    // Topmost first (last drawn renders on top).
    for (let i = regions.length - 1; i >= 0; i--) {
      if (this.hitTest(regions[i], ix, iy)) {
        this.store.selectRegion(regions[i]);
        return;
      }
    }
    this.store.setSelectedShapeIndices([]);
  }

  // ── shape commit ──────────────────────────────────────────────────────────
  private commitRectangle(x: number, y: number, width: number, height: number): void {
    const rect = new Rectangle();
    rect.x = x;
    rect.y = y;
    rect.width = width;
    rect.height = height;
    const region = new Region();
    region.bounds = rect;
    region.color = this.store.getShapeColor();
    this.store.addRegion(region);
  }

  private commitPolygon(points: Array<[number, number]>, closed: boolean): void {
    const poly = new Polygon();
    poly.npoints = points.length;
    poly.xpoints = points.map((p) => p[0]);
    poly.ypoints = points.map((p) => p[1]);
    poly.coordinates = points.map((p) => [p[0], p[1]]);
    poly.closed = closed;
    const region = new Region();
    region.bounds = poly;
    region.color = this.store.getShapeColor();
    region.label = 'legend';
    this.store.addRegion(region);
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  private hitTest(region: Region, x: number, y: number): boolean {
    const b = region.bounds;
    if (!b) return false;
    if ('width' in b && 'x' in b) {
      const r = b as Rectangle;
      return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    }
    if ('npoints' in b) {
      const p = b as Polygon;
      let inside = false;
      for (let i = 0, j = p.npoints - 1; i < p.npoints; j = i++) {
        const xi = p.xpoints[i];
        const yi = p.ypoints[i];
        const xj = p.xpoints[j];
        const yj = p.ypoints[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    return false;
  }

  redraw(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    const regions = this.store.getRegions();
    regions.forEach((region, i) => {
      if (region.isProfile?.()) return;
      const el = this.buildRegionEl(region, this.selected.includes(i));
      if (el) this.svg.appendChild(el);
    });
    this.drawDraft();
  }

  private buildRegionEl(region: Region, isSelected: boolean): SVGElement | null {
    const b = region.bounds;
    if (!b) return null;
    const stroke = region.color || this.store.getShapeColor() || '#00ffff';
    if ('width' in b && 'x' in b) {
      const r = b as Rectangle;
      const [lx, ly] = this.toLocal(r.x, r.y);
      const [rx, ry] = this.toLocal(r.x + r.width, r.y + r.height);
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', `${Math.min(lx, rx)}`);
      el.setAttribute('y', `${Math.min(ly, ry)}`);
      el.setAttribute('width', `${Math.abs(rx - lx)}`);
      el.setAttribute('height', `${Math.abs(ry - ly)}`);
      this.style(el, stroke, isSelected);
      return el;
    }
    if ('npoints' in b) {
      const p = b as Polygon;
      // Bezier polygons render as a smooth cubic path using their per-anchor handles.
      if (p.bezier && p.handlesIn?.length === p.npoints && p.handlesOut?.length === p.npoints) {
        const el = document.createElementNS(SVG_NS, 'path');
        el.setAttribute('d', this.bezierPath(p));
        this.style(el, stroke, isSelected);
        return el;
      }
      const pts = p.xpoints
        .map((_, i) => this.toLocal(p.xpoints[i], p.ypoints[i]).join(','))
        .join(' ');
      const el = document.createElementNS(SVG_NS, p.closed === false ? 'polyline' : 'polygon');
      el.setAttribute('points', pts);
      this.style(el, stroke, isSelected);
      return el;
    }
    return null;
  }

  /** SVG path data for a bezier polygon: anchors joined by cubic segments whose control points
   *  are `anchor + handleOut` (leaving) and `nextAnchor + handleIn` (arriving), in image space. */
  private bezierPath(p: Polygon): string {
    const hIn = p.handlesIn as number[][];
    const hOut = p.handlesOut as number[][];
    const n = p.npoints;
    const anchor = (i: number): [number, number] => this.toLocal(p.xpoints[i], p.ypoints[i]);
    const ctrlOut = (i: number): [number, number] =>
      this.toLocal(p.xpoints[i] + hOut[i][0], p.ypoints[i] + hOut[i][1]);
    const ctrlIn = (i: number): [number, number] =>
      this.toLocal(p.xpoints[i] + hIn[i][0], p.ypoints[i] + hIn[i][1]);
    const [sx, sy] = anchor(0);
    let d = `M ${sx},${sy}`;
    const segments = p.closed === false ? n - 1 : n;
    for (let s = 0; s < segments; s++) {
      const i = s;
      const j = (s + 1) % n;
      const [c1x, c1y] = ctrlOut(i);
      const [c2x, c2y] = ctrlIn(j);
      const [ex, ey] = anchor(j);
      d += ` C ${c1x},${c1y} ${c2x},${c2y} ${ex},${ey}`;
    }
    if (p.closed !== false) d += ' Z';
    return d;
  }

  private style(el: SVGElement, stroke: string, isSelected: boolean): void {
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', isSelected ? '3' : '2');
    el.setAttribute('fill', isSelected ? stroke : 'none');
    el.setAttribute('fill-opacity', isSelected ? '0.2' : '0');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
  }

  /** Draw the in-progress rectangle / path preview. */
  private drawDraft(): void {
    if (this.draftRect) {
      const { x0, y0, x1, y1 } = this.draftRect;
      const [lx, ly] = this.toLocal(Math.min(x0, x1), Math.min(y0, y1));
      const [rx, ry] = this.toLocal(Math.max(x0, x1), Math.max(y0, y1));
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', `${lx}`);
      el.setAttribute('y', `${ly}`);
      el.setAttribute('width', `${Math.abs(rx - lx)}`);
      el.setAttribute('height', `${Math.abs(ry - ly)}`);
      this.styleDraft(el);
      this.svg.appendChild(el);
    }
    if (this.draftPath && this.draftPath.length) {
      const pts = this.draftPath.map(([x, y]) => this.toLocal(x, y).join(',')).join(' ');
      const el = document.createElementNS(SVG_NS, 'polyline');
      el.setAttribute('points', pts);
      this.styleDraft(el);
      this.svg.appendChild(el);
    }
  }

  private styleDraft(el: SVGElement): void {
    el.setAttribute('stroke', this.store.getShapeColor() || '#00ffff');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('fill', 'none');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
  }
}
