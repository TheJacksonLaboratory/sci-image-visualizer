import { Subscription } from 'rxjs';

import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { Region, Rectangle, Polygon } from '../../models/region';
import { RegionStore } from '../../store/region-store.service';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Min drag (image px) before a freehand path records another point. */
const FREEHAND_STEP = 2;
/** Click-distance (screen px) within which a polygon click snaps closed onto the first vertex. */
const CLOSE_SNAP_PX = 10;
/** Screen-px hit radius for grabbing a vertex / rectangle corner handle. */
const HANDLE_HIT_PX = 9;
/** Rendered handle size (screen px). */
const HANDLE_SIZE = 7;

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
 * Supports (jit-ui#102): rectangle / polygon / freehand path drawing, click-select and rubber-band
 * marquee select, pan/zoom gating via `setControlsEnabled`, body move, vertex move/add/delete,
 * bezier handle editing, and donut holes (including hole vertex + hole-bezier-handle editing) —
 * full parity with {@link OsdRegionOverlay}.
 */
export class NapariRegionOverlay implements IRegionOverlay {
  private readonly svg: SVGSVGElement;
  private readonly subs = new Subscription();
  private readonly disconnectCamera: () => void;

  private mode: RegionToolMode = 'none';
  private selected: number[] = [];

  /** In-progress drawing state (image-space). */
  private draftRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** In-progress rubber-band selection marquee (select mode), image-space. */
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Dedicated marquee rect element, updated directly during the drag (no full region redraw). */
  private marqueeEl: SVGRectElement | null = null;
  private draftPath: Array<[number, number]> | null = null; // freehand or click polygon
  private drawing = false; // pointer is down for rect / freehand

  /** In-progress manipulation (select/move modes): dragging a body, a polygon vertex, or a
   *  rectangle corner. `anchor` is the fixed opposite corner for a rectangle resize. */
  private edit: {
    kind: 'body' | 'vertex' | 'corner' | 'bezier' | 'holevertex' | 'holebezier';
    id: number;
    vertexIndex?: number;
    holeIndex?: number;
    side?: 'in' | 'out';
    anchor?: [number, number];
    last: [number, number];
  } | null = null;

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
    this.marquee = null;
    this.clearMarqueeEl();
    this.drawing = false;
    // The overlay owns pointer/navigation gating: while a tool is active it captures the pointer
    // and the napari camera controls are disabled; 'none' hands the pointer back for pan/zoom.
    const active = mode !== 'none';
    this.viewer.setControlsEnabled(!active);
    this.svg.style.pointerEvents = active ? 'auto' : 'none';
    this.svg.style.cursor = active ? 'crosshair' : 'default';
    this.redraw();
  }

  setSelectedBezier(bezier: boolean): void {
    const sel = this.selectedRegion();
    if (sel?.id != null) this.store.setBezier(sel.id, bezier);
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
    } else if (this.mode === 'select' || this.mode === 'move') {
      this.beginManipulation(ix, iy, e);
    } else if (this.mode === 'addpoint') {
      this.handleAddPoint(ix, iy);
    } else if (this.mode === 'deletepoint') {
      this.handleDeletePoint(ix, iy);
    }
    this.redraw();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const [ix, iy] = this.toImage(e.clientX, e.clientY);
    if (this.marquee) {
      this.marquee.x1 = ix;
      this.marquee.y1 = iy;
      this.updateMarqueeEl(); // update just the marquee rect — NOT a full region redraw
      return;
    }
    if (this.edit) {
      this.applyManipulation(ix, iy);
      this.redraw();
      return;
    }
    if (!this.drawing) return;
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
    if (this.marquee) {
      const m = this.marquee;
      this.marquee = null;
      this.clearMarqueeEl();
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      this.finishMarquee(m); // setSelectedShapeIndices → one redraw via the selection subscription
      return;
    }
    if (this.edit) {
      this.store.endBatch();
      this.edit = null;
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      this.redraw();
      return;
    }
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

  /** The currently-selected region (single selection), or null. */
  private selectedRegion(): Region | null {
    const regions = this.store.getRegions();
    const i = this.selected[0];
    return i != null && i >= 0 && i < regions.length ? regions[i] : null;
  }

  /** Screen distance (px) between a client point and an image coord. */
  private screenDist(clientX: number, clientY: number, imgX: number, imgY: number): number {
    const [lx, ly] = this.toLocal(imgX, imgY);
    const r = this.svg.getBoundingClientRect();
    return Math.hypot(clientX - r.left - lx, clientY - r.top - ly);
  }

  /**
   * Start a select/move interaction: grab a handle (rectangle corner) or vertex of the already-
   * selected region first; otherwise select the topmost region under the cursor and drag its body.
   */
  private beginManipulation(ix: number, iy: number, e: PointerEvent): void {
    const sel = this.selectedRegion();
    if (sel?.bounds) {
      const grab = this.hitHandle(sel, e.clientX, e.clientY);
      if (grab) {
        this.store.beginBatch();
        this.edit = { ...grab, id: sel.id, last: [ix, iy] };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
    }
    // Hit-test bodies, topmost first (last drawn renders on top).
    const regions = this.store.getRegions();
    for (let i = regions.length - 1; i >= 0; i--) {
      if (this.hitTest(regions[i], ix, iy)) {
        this.store.selectRegion(regions[i]);
        this.store.beginBatch();
        this.edit = { kind: 'body', id: regions[i].id, last: [ix, iy] };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
    }
    // Empty space: in select mode start a rubber-band marquee (selects the regions it covers on
    // release); in move mode just clear the selection.
    if (this.mode === 'select') {
      this.marquee = { x0: ix, y0: iy, x1: ix, y1: iy };
      this.updateMarqueeEl();
      this.svg.setPointerCapture(e.pointerId);
    } else {
      this.store.setSelectedShapeIndices([]);
    }
  }

  /** Create/update the marquee rect element directly (avoids a full region redraw per move). */
  private updateMarqueeEl(): void {
    if (!this.marquee) return;
    if (!this.marqueeEl || !this.marqueeEl.parentNode) {
      this.marqueeEl = document.createElementNS(SVG_NS, 'rect');
      this.marqueeEl.setAttribute('stroke', '#4da3ff');
      this.marqueeEl.setAttribute('stroke-width', '1');
      this.marqueeEl.setAttribute('stroke-dasharray', '4 3');
      this.marqueeEl.setAttribute('fill', '#4da3ff');
      this.marqueeEl.setAttribute('fill-opacity', '0.12');
      this.marqueeEl.setAttribute('vector-effect', 'non-scaling-stroke');
      this.svg.appendChild(this.marqueeEl);
    }
    const { x0, y0, x1, y1 } = this.marquee;
    const [lx, ly] = this.toLocal(Math.min(x0, x1), Math.min(y0, y1));
    const [rx, ry] = this.toLocal(Math.max(x0, x1), Math.max(y0, y1));
    this.marqueeEl.setAttribute('x', `${lx}`);
    this.marqueeEl.setAttribute('y', `${ly}`);
    this.marqueeEl.setAttribute('width', `${Math.abs(rx - lx)}`);
    this.marqueeEl.setAttribute('height', `${Math.abs(ry - ly)}`);
  }

  /** Remove the marquee element from the SVG. */
  private clearMarqueeEl(): void {
    if (this.marqueeEl?.parentNode) this.marqueeEl.parentNode.removeChild(this.marqueeEl);
    this.marqueeEl = null;
  }

  /** Test whether a client point grabs a rectangle corner or a polygon vertex of `region`. */
  private hitHandle(
    region: Region,
    clientX: number,
    clientY: number,
  ):
    | { kind: 'corner'; anchor: [number, number] }
    | { kind: 'vertex'; vertexIndex: number }
    | { kind: 'bezier'; vertexIndex: number; side: 'in' | 'out' }
    | { kind: 'holevertex'; holeIndex: number; vertexIndex: number }
    | { kind: 'holebezier'; holeIndex: number; vertexIndex: number; side: 'in' | 'out' }
    | null {
    const b = region.bounds;
    if (!b) return null;
    if ('width' in b && 'x' in b) {
      const r = b as Rectangle;
      const corners: Array<[number, number, [number, number]]> = [
        [r.x, r.y, [r.x + r.width, r.y + r.height]],
        [r.x + r.width, r.y, [r.x, r.y + r.height]],
        [r.x, r.y + r.height, [r.x + r.width, r.y]],
        [r.x + r.width, r.y + r.height, [r.x, r.y]],
      ];
      for (const [cx, cy, anchor] of corners) {
        if (this.screenDist(clientX, clientY, cx, cy) <= HANDLE_HIT_PX) return { kind: 'corner', anchor };
      }
    } else if ('npoints' in b) {
      const p = b as Polygon;
      // Bezier control points first (they sit off the anchors), so they're grabbable.
      if (p.bezier && p.handlesIn?.length === p.npoints && p.handlesOut?.length === p.npoints) {
        for (let i = 0; i < p.npoints; i++) {
          const out = p.handlesOut[i];
          const inn = p.handlesIn[i];
          if (this.screenDist(clientX, clientY, p.xpoints[i] + out[0], p.ypoints[i] + out[1]) <= HANDLE_HIT_PX) {
            return { kind: 'bezier', vertexIndex: i, side: 'out' };
          }
          if (this.screenDist(clientX, clientY, p.xpoints[i] + inn[0], p.ypoints[i] + inn[1]) <= HANDLE_HIT_PX) {
            return { kind: 'bezier', vertexIndex: i, side: 'in' };
          }
        }
      }
      for (let i = 0; i < p.npoints; i++) {
        if (this.screenDist(clientX, clientY, p.xpoints[i], p.ypoints[i]) <= HANDLE_HIT_PX) {
          return { kind: 'vertex', vertexIndex: i };
        }
      }
      // Hole (donut) ring: bezier control points first, then the vertices.
      const holes = p.holes ?? [];
      const holeBezier = !!(p.bezier && p.holeHandlesIn && p.holeHandlesOut);
      for (let hi = 0; hi < holes.length; hi++) {
        const ring = holes[hi];
        if (holeBezier && p.holeHandlesIn![hi] && p.holeHandlesOut![hi]) {
          for (let vi = 0; vi < ring.length; vi++) {
            const out = p.holeHandlesOut![hi][vi] ?? [0, 0];
            const inn = p.holeHandlesIn![hi][vi] ?? [0, 0];
            if (this.screenDist(clientX, clientY, ring[vi][0] + out[0], ring[vi][1] + out[1]) <= HANDLE_HIT_PX) {
              return { kind: 'holebezier', holeIndex: hi, vertexIndex: vi, side: 'out' };
            }
            if (this.screenDist(clientX, clientY, ring[vi][0] + inn[0], ring[vi][1] + inn[1]) <= HANDLE_HIT_PX) {
              return { kind: 'holebezier', holeIndex: hi, vertexIndex: vi, side: 'in' };
            }
          }
        }
        for (let vi = 0; vi < ring.length; vi++) {
          if (this.screenDist(clientX, clientY, ring[vi][0], ring[vi][1]) <= HANDLE_HIT_PX) {
            return { kind: 'holevertex', holeIndex: hi, vertexIndex: vi };
          }
        }
      }
    }
    return null;
  }

  /** Apply the live drag for the active manipulation (image coords `ix,iy`). */
  private applyManipulation(ix: number, iy: number): void {
    if (!this.edit) return;
    if (this.edit.kind === 'body') {
      const [lx, ly] = this.edit.last;
      this.store.moveRegion(this.edit.id, ix - lx, iy - ly);
      this.edit.last = [ix, iy];
    } else if (this.edit.kind === 'vertex' && this.edit.vertexIndex != null) {
      this.store.moveVertex(this.edit.id, this.edit.vertexIndex, ix, iy);
    } else if (this.edit.kind === 'corner' && this.edit.anchor) {
      const [ax, ay] = this.edit.anchor;
      const rect = new Rectangle();
      rect.x = Math.min(ax, ix);
      rect.y = Math.min(ay, iy);
      rect.width = Math.abs(ix - ax);
      rect.height = Math.abs(iy - ay);
      this.store.updateBounds(this.edit.id, rect);
    } else if (this.edit.kind === 'bezier' && this.edit.vertexIndex != null && this.edit.side) {
      this.store.moveBezierHandle(this.edit.id, this.edit.vertexIndex, this.edit.side, ix, iy);
    } else if (
      this.edit.kind === 'holevertex' &&
      this.edit.holeIndex != null &&
      this.edit.vertexIndex != null
    ) {
      this.store.moveHoleVertex(this.edit.id, this.edit.holeIndex, this.edit.vertexIndex, ix, iy);
    } else if (
      this.edit.kind === 'holebezier' &&
      this.edit.holeIndex != null &&
      this.edit.vertexIndex != null &&
      this.edit.side
    ) {
      this.store.moveHoleBezierHandle(
        this.edit.id,
        this.edit.holeIndex,
        this.edit.vertexIndex,
        this.edit.side,
        ix,
        iy,
      );
    }
  }

  /** addpoint mode: insert a vertex on the selected polygon's nearest edge at the click. */
  private handleAddPoint(ix: number, iy: number): void {
    const sel = this.selectedRegion();
    const b = sel?.bounds;
    if (!sel || !b || !('npoints' in b)) return;
    const p = b as Polygon;
    let bestSeg = 0;
    let bestD = Infinity;
    const segs = p.closed === false ? p.npoints - 1 : p.npoints;
    for (let s = 0; s < segs; s++) {
      const j = (s + 1) % p.npoints;
      const d = this.pointSegDist(ix, iy, p.xpoints[s], p.ypoints[s], p.xpoints[j], p.ypoints[j]);
      if (d < bestD) {
        bestD = d;
        bestSeg = s;
      }
    }
    this.store.addVertex(sel.id, bestSeg, ix, iy);
  }

  /** deletepoint mode: remove the selected polygon's vertex nearest the click. */
  private handleDeletePoint(ix: number, iy: number): void {
    const sel = this.selectedRegion();
    const b = sel?.bounds;
    if (!sel || !b || !('npoints' in b)) return;
    const p = b as Polygon;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < p.npoints; i++) {
      const d = Math.hypot(p.xpoints[i] - ix, p.ypoints[i] - iy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) this.store.deleteVertex(sel.id, best);
  }

  /** Distance from point (px,py) to segment (ax,ay)-(bx,by), in image units. */
  private pointSegDist(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /** Finalize a rubber-band marquee: select every region whose bounding box it overlaps (a tiny
   *  marquee is treated as a click on empty space → clear the selection). */
  private finishMarquee(m: { x0: number; y0: number; x1: number; y1: number }): void {
    const x0 = Math.min(m.x0, m.x1);
    const x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1);
    const y1 = Math.max(m.y0, m.y1);
    if (x1 - x0 < 3 && y1 - y0 < 3) {
      this.store.setSelectedShapeIndices([]);
      return;
    }
    const indices: number[] = [];
    this.store.getRegions().forEach((r, i) => {
      if (r.isProfile?.()) return;
      const bb = this.regionBBox(r);
      if (bb && bb.x0 <= x1 && bb.x1 >= x0 && bb.y0 <= y1 && bb.y1 >= y0) indices.push(i);
    });
    this.store.setSelectedShapeIndices(indices);
  }

  /** A region's bounding box in image coords (rectangle, polygon, or multipolygon), or null. */
  private regionBBox(
    region: Region,
  ): { x0: number; y0: number; x1: number; y1: number } | null {
    const b = region.bounds;
    if (!b) return null;
    if ('width' in b && 'x' in b) {
      const r = b as Rectangle;
      return { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
    }
    const acc = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const addRing = (xs: number[], ys: number[]): void => {
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] < acc.x0) acc.x0 = xs[i];
        if (xs[i] > acc.x1) acc.x1 = xs[i];
        if (ys[i] < acc.y0) acc.y0 = ys[i];
        if (ys[i] > acc.y1) acc.y1 = ys[i];
      }
    };
    if ('npoints' in b) {
      const p = b as Polygon;
      addRing(p.xpoints, p.ypoints);
    } else if ('polygons' in b) {
      for (const p of (b as { polygons: Polygon[] }).polygons) addRing(p.xpoints, p.ypoints);
    } else {
      return null;
    }
    return isFinite(acc.x0) ? acc : null;
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
      const isSel = this.selected.includes(i);
      const el = this.buildRegionEl(region, isSel);
      if (el) this.svg.appendChild(el);
      this.drawLabel(region);
      if (isSel) this.drawHandles(region);
    });
    this.drawDraft();
  }

  /** Draw a region's classification label at its top-left, when labels are enabled (matches OSD). */
  private drawLabel(region: Region): void {
    if (!this.store.getShowShapeLabel() || region.isProfile?.()) return;
    const label = region.label;
    const b = region.bounds;
    if (!label || !b) return;
    let ix: number;
    let iy: number;
    if ('width' in b && 'x' in b) {
      ix = (b as Rectangle).x;
      iy = (b as Rectangle).y;
    } else if ('npoints' in b) {
      const p = b as Polygon;
      ix = p.xpoints.reduce((m, x) => Math.min(m, x), Infinity);
      iy = p.ypoints.reduce((m, y) => Math.min(m, y), Infinity);
    } else {
      return;
    }
    const [lx, ly] = this.toLocal(ix, iy);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', `${lx}`);
    text.setAttribute('y', `${ly - 4}`);
    text.setAttribute('fill', '#fff');
    text.setAttribute('stroke', '#000');
    text.setAttribute('stroke-width', '3');
    text.setAttribute('paint-order', 'stroke');
    text.setAttribute('font', '12px sans-serif');
    text.setAttribute('pointer-events', 'none');
    text.textContent = label;
    this.svg.appendChild(text);
  }

  /** Draw grab handles for the selected region: rectangle corners or polygon vertices. */
  private drawHandles(region: Region): void {
    const b = region.bounds;
    if (!b) return;
    const stroke = region.color || this.store.getShapeColor() || '#00ffff';
    const handle = (imgX: number, imgY: number): void => {
      const [lx, ly] = this.toLocal(imgX, imgY);
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', `${lx - HANDLE_SIZE / 2}`);
      el.setAttribute('y', `${ly - HANDLE_SIZE / 2}`);
      el.setAttribute('width', `${HANDLE_SIZE}`);
      el.setAttribute('height', `${HANDLE_SIZE}`);
      el.setAttribute('fill', '#fff');
      el.setAttribute('stroke', stroke);
      el.setAttribute('stroke-width', '1.5');
      this.svg.appendChild(el);
    };
    if ('width' in b && 'x' in b) {
      const r = b as Rectangle;
      handle(r.x, r.y);
      handle(r.x + r.width, r.y);
      handle(r.x, r.y + r.height);
      handle(r.x + r.width, r.y + r.height);
    } else if ('npoints' in b) {
      const p = b as Polygon;
      const isBezier = p.bezier && p.handlesIn?.length === p.npoints && p.handlesOut?.length === p.npoints;
      for (let i = 0; i < p.npoints; i++) handle(p.xpoints[i], p.ypoints[i]);
      for (const ring of p.holes ?? []) for (const [hx, hy] of ring) handle(hx, hy);
      // Bezier regions also expose their tangent control points (circles) joined to the anchor
      // by a thin line, matching the OSD overlay's editable bezier handles.
      if (isBezier) {
        const hIn = p.handlesIn as number[][];
        const hOut = p.handlesOut as number[][];
        for (let i = 0; i < p.npoints; i++) {
          this.drawBezierHandle(p.xpoints[i], p.ypoints[i], hOut[i], stroke);
          this.drawBezierHandle(p.xpoints[i], p.ypoints[i], hIn[i], stroke);
        }
      }
      // Donut hole bezier control handles.
      if (p.bezier && p.holeHandlesIn && p.holeHandlesOut) {
        (p.holes ?? []).forEach((ring, hi) => {
          const hIn = p.holeHandlesIn![hi];
          const hOut = p.holeHandlesOut![hi];
          if (!hIn || !hOut) return;
          ring.forEach(([hx, hy], vi) => {
            this.drawBezierHandle(hx, hy, hOut[vi], stroke);
            this.drawBezierHandle(hx, hy, hIn[vi], stroke);
          });
        });
      }
    }
  }

  /** Draw one bezier control point (anchor + handle offset) as a small circle connected to its
   *  anchor by a tangent line. `handle` is the [dx,dy] offset from the anchor in image space. */
  private drawBezierHandle(ax: number, ay: number, handle: number[], stroke: string): void {
    if (!handle || (handle[0] === 0 && handle[1] === 0)) return;
    const [alx, aly] = this.toLocal(ax, ay);
    const [hlx, hly] = this.toLocal(ax + handle[0], ay + handle[1]);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', `${alx}`);
    line.setAttribute('y1', `${aly}`);
    line.setAttribute('x2', `${hlx}`);
    line.setAttribute('y2', `${hly}`);
    line.setAttribute('stroke', stroke);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-opacity', '0.7');
    this.svg.appendChild(line);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', `${hlx}`);
    dot.setAttribute('cy', `${hly}`);
    dot.setAttribute('r', `${HANDLE_SIZE / 2}`);
    dot.setAttribute('fill', stroke);
    dot.setAttribute('stroke', '#fff');
    dot.setAttribute('stroke-width', '1');
    this.svg.appendChild(dot);
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
      const isBezier =
        !!p.bezier && p.handlesIn?.length === p.npoints && p.handlesOut?.length === p.npoints;
      const hasHoles = !!(p.holes && p.holes.length);
      // Bezier or donut (holes) → a single <path>; holes use even-odd fill so they punch through.
      if (isBezier || hasHoles) {
        const el = document.createElementNS(SVG_NS, 'path');
        el.setAttribute('d', this.polygonPathData(p, isBezier));
        if (hasHoles) el.setAttribute('fill-rule', 'evenodd');
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

  /** Path data for a polygon: the exterior ring (bezier or straight) plus any holes (bezier when
   *  the donut carries hole handles, else straight) as sub-paths — even-odd fill cuts them out. */
  private polygonPathData(p: Polygon, isBezier: boolean): string {
    let d = isBezier
      ? this.ringBezierPath(p.xpoints, p.ypoints, p.handlesIn!, p.handlesOut!, p.closed !== false)
      : this.straightPath(p.xpoints, p.ypoints, p.closed !== false);
    const holeBezier = !!(p.bezier && p.holeHandlesIn && p.holeHandlesOut);
    (p.holes ?? []).forEach((ring, hi) => {
      if (ring.length < 3) return;
      const xs = ring.map((pt) => pt[0]);
      const ys = ring.map((pt) => pt[1]);
      if (holeBezier && p.holeHandlesIn![hi] && p.holeHandlesOut![hi]) {
        d += ' ' + this.ringBezierPath(xs, ys, p.holeHandlesIn![hi], p.holeHandlesOut![hi], true);
      } else {
        d += ' ' + this.straightPath(xs, ys, true);
      }
    });
    return d;
  }

  /** SVG path data for a straight ring/polyline in image coords (closed appends `Z`). */
  private straightPath(xs: number[], ys: number[], closed: boolean): string {
    let d = '';
    for (let i = 0; i < xs.length; i++) {
      const [lx, ly] = this.toLocal(xs[i], ys[i]);
      d += (i === 0 ? 'M' : ' L') + ` ${lx},${ly}`;
    }
    return closed ? d + ' Z' : d;
  }

  /** SVG cubic-bezier path data for any ring (exterior or hole): anchors joined by cubic segments
   *  whose control points are `anchor + handleOut` (leaving) and `nextAnchor + handleIn` (arriving),
   *  in image space. Used for both the exterior and (donut) hole rings. */
  private ringBezierPath(
    xs: number[],
    ys: number[],
    hIn: number[][],
    hOut: number[][],
    closed: boolean,
  ): string {
    const n = xs.length;
    const anchor = (i: number): [number, number] => this.toLocal(xs[i], ys[i]);
    const ctrlOut = (i: number): [number, number] =>
      this.toLocal(xs[i] + (hOut[i]?.[0] ?? 0), ys[i] + (hOut[i]?.[1] ?? 0));
    const ctrlIn = (i: number): [number, number] =>
      this.toLocal(xs[i] + (hIn[i]?.[0] ?? 0), ys[i] + (hIn[i]?.[1] ?? 0));
    const [sx, sy] = anchor(0);
    let d = `M ${sx},${sy}`;
    const segments = closed ? n : n - 1;
    for (let s = 0; s < segments; s++) {
      const i = s;
      const j = (s + 1) % n;
      const [c1x, c1y] = ctrlOut(i);
      const [c2x, c2y] = ctrlIn(j);
      const [ex, ey] = anchor(j);
      d += ` C ${c1x},${c1y} ${c2x},${c2y} ${ex},${ey}`;
    }
    if (closed) d += ' Z';
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
