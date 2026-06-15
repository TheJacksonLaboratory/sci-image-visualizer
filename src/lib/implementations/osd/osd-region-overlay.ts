import * as OpenSeadragon from 'openseadragon';
import { Subscription } from 'rxjs';

import { Region, Rectangle, Polygon, MultiPolygon } from '../../models/region';
import { resolveHandles } from '../../models/bezier';
import { IRegionStore } from '../../contracts/visualizer.contract';
import { IRegionEditApi } from '../../contracts/region-store.contract';
import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { elementToImage, imageToElement } from './osd-coords';

/**
 * The shared region store as the overlay needs it: the cross-backend
 * {@link IRegionStore} (read regions, selection, colours) plus the Region-native
 * {@link IRegionEditApi} (add/move/resize/vertex edits). The shared RegionStore
 * satisfies both. The overlay edits through these typed operations on the
 * neutral Region model — it never touches a backend's own shape representation
 * (e.g. Plotly's `x0/y0/x1/y1` / `M…L…Z` dicts).
 */
export type RegionEditStore = IRegionStore & IRegionEditApi;

const SVGNS = 'http://www.w3.org/2000/svg';

/** Move/resize zones on the selected rectangle. */
type EditZone = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const ZONE_CURSOR: Record<EditZone, string> = {
  move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};
/** Screen-pixel tolerance for grabbing an edge/corner handle. */
const EDIT_TOL = 8;

/**
 * OpenSeadragon implementation of {@link IRegionOverlay}.
 *
 * - Renders the store's regions (rect/polygon) in image-pixel space, kept
 *   aligned on every pan/zoom via the OSD viewport API.
 * - Draws new rectangle and polygon regions (committed to the shared store).
 * - Click-to-select in 'select' mode.
 *
 * Reads/writes the shared {@link IRegionStore}, so regions stay in sync with the
 * Region Editor and the Plotly backend. The wand, vertex-eraser and zoom-to-box
 * tools are NOT handled here — they're owned by OpenSeadragonVisualizerService
 * (which binds them to OSD via the shared coordinate transform + viewport pixel
 * readback), the same singleton tool services the Plotly backend uses.
 */
export class OsdRegionOverlay implements IRegionOverlay {

  private readonly svg: SVGSVGElement;
  private readonly subs = new Subscription();
  private readonly osd: any = OpenSeadragon as any;

  private selected: number[] = [];
  private mode: RegionToolMode = 'none';

  private tracker: any;
  private rectStart: { x: number; y: number } | null = null; // image coords
  private rectCurrent: { x: number; y: number } | null = null;
  private polyPoints: { x: number; y: number }[] = [];        // image coords
  /** True while dragging a freehand path (freeform / polyline). */
  private freehandDragging = false;
  /** True while placing a click-to-add polygon ('drawpolygon' mode). */
  private drawingPolygon = false;
  /** Last element-pixel point appended, to thin the freehand path. */
  private lastFreehandPx: { x: number; y: number } | null = null;
  /**
   * In-progress edit of the selected region:
   *  - kind 'bounds' — rectangle resize/move or whole-region move (uses `zone`);
   *  - kind 'vertex' — dragging a single polygon vertex (uses `vertexIndex`).
   */
  private edit: {
    kind: 'bounds' | 'vertex' | 'handle';
    zone: EditZone;
    vertexIndex: number;
    /** Which ring the dragged vertex belongs to: -1 = exterior, else a hole
     *  index into `Polygon.holes` (jit-ui#85). */
    ring: number;
    handleSide: 'in' | 'out';
    id: number;
    startImg: { x: number; y: number };
    orig: any;
  } | null = null;
  private editDragged = false;
  /** Rubber-band (marquee) multi-select in 'select' mode: press on empty space
   *  and drag to select every region the band intersects. Image coords. */
  private bandStart: { x: number; y: number } | null = null;
  private bandCurrent: { x: number; y: number } | null = null;
  private bandDragged = false;

  private readonly redrawHandler = () => this.redraw();

  constructor(private viewer: any, private store: RegionEditStore) {
    this.svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    Object.assign(this.svg.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none', // OSD handles navigation unless we're drawing
    });
    this.viewer.canvas.appendChild(this.svg);

    this.viewer.addHandler('update-viewport', this.redrawHandler);
    this.viewer.addHandler('animation', this.redrawHandler);
    this.viewer.addHandler('resize', this.redrawHandler);
    this.viewer.addHandler('rotate', this.redrawHandler);

    this.tracker = new this.osd.MouseTracker({
      element: this.viewer.canvas,
      pressHandler: (e: any) => this.onPress(e),
      dragHandler: (e: any) => this.onDrag(e),
      releaseHandler: (e: any) => this.onRelease(e),
      clickHandler: (e: any) => this.onClick(e),
      moveHandler: (e: any) => this.onMove(e),
    });
    this.tracker.setTracking(false);

    this.subs.add(this.store.getRegionUpdateEvent().subscribe(this.redrawHandler));
    this.subs.add(this.store.getSelectedShapeIndices$().subscribe(idx => {
      this.selected = idx || [];
      this.redraw();
    }));

    this.redraw();
  }

  /** Switch drawing/selection mode; toggles OSD navigation accordingly. */
  setMode(mode: RegionToolMode): void {
    this.mode = mode;
    this.resetInProgress();
    // Any active region tool takes over the pointer — OSD pan/zoom is disabled
    // so dragging draws (and clicks select) instead of panning. With no tool,
    // OSD navigates normally.
    this.viewer.setMouseNavEnabled(mode === 'none');
    this.tracker.setTracking(mode !== 'none');
    this.updateCursor(false);
    this.redraw();
  }

  /** Cursor feedback per mode (crosshair while drawing; pointer over a region
   *  in select mode). */
  private updateCursor(overRegion: boolean): void {
    const canvas = this.viewer.canvas as HTMLElement;
    if (this.mode === 'drawrect' || this.mode === 'drawclosedpath' || this.mode === 'drawopenpath'
        || this.mode === 'drawpolygon' || this.mode === 'addpoint' || this.mode === 'deletepoint') {
      canvas.style.cursor = 'crosshair';
    } else if (this.mode === 'move') {
      canvas.style.cursor = 'move';
    } else if (this.mode === 'select') {
      canvas.style.cursor = overRegion ? 'pointer' : 'default';
    } else {
      canvas.style.cursor = ''; // OSD default (grab)
    }
  }

  /** Whether the selected region's vertices/handles should be drawn. Shown
   *  whenever a region is selected — including `none` (display) mode and while
   *  another tool (wand, brush, SAM…) is active — so a selection always reveals
   *  its vertices. Suppressed only while actively drawing a brand-new shape,
   *  where stray handles would be noise. */
  private get showsSelectedVertices(): boolean {
    return this.mode !== 'drawrect' && this.mode !== 'drawpolygon'
      && this.mode !== 'drawclosedpath' && this.mode !== 'drawopenpath';
  }

  destroy(): void {
    this.subs.unsubscribe();
    this.viewer.removeHandler('update-viewport', this.redrawHandler);
    this.viewer.removeHandler('animation', this.redrawHandler);
    this.viewer.removeHandler('resize', this.redrawHandler);
    this.viewer.removeHandler('rotate', this.redrawHandler);
    if (this.tracker) this.tracker.destroy();
    if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
  }

  // ── coordinate helpers ───────────────────────────────────────────────
  /** Image-pixel point -> element pixel point. */
  private toPx(imgX: number, imgY: number): { x: number; y: number } {
    return imageToElement(this.viewer, imgX, imgY);
  }
  /** Element pixel point (from a MouseTracker event) -> image-pixel point. */
  private toImage(pos: any): { x: number; y: number } {
    const p = elementToImage(this.viewer, pos.x, pos.y);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  // ── rendering ────────────────────────────────────────────────────────
  redraw(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    const regions = this.store.getRegions();
    regions.forEach((r, i) => {
      const el = this.buildRegionEl(r, this.selected.includes(i));
      if (el) this.svg.appendChild(el);
    });

    // Handles on the selected polygon, so the user can grab/insert/delete
    // vertices. Bezier regions also get their cubic
    // control handles (tangent lines + control points), mirroring paper.js's
    // fullySelected rendering.
    if (this.showsSelectedVertices) {
      const sel = this.selectedRegionInfo();
      const b = sel?.region.bounds;
      // Handles/vertices take the region's own colour (not the global shape
      // colour) so they match the shape they belong to.
      const color = sel ? sel.region.color || this.store.getShapeColor() : '';
      if (b instanceof Polygon) {
        if (b.bezier) {
          this.drawBezierHandles(b, color);
        } else {
          for (let i = 0; i < b.xpoints.length; i++) {
            const q = this.toPx(b.xpoints[i], b.ypoints[i]);
            this.svg.appendChild(this.vertexMarker(q.x, q.y, false, color));
          }
          // Interior-ring (hole) vertices too, so a donut's inner outline shows
          // its vertices when selected (jit-ui#85).
          if (b.holes) {
            for (const ring of b.holes) {
              for (const [hx, hy] of ring) {
                const q = this.toPx(hx, hy);
                this.svg.appendChild(this.vertexMarker(q.x, q.y, false, color));
              }
            }
          }
        }
      } else if (b instanceof Rectangle) {
        // The four corners as grab/resize handles.
        const corners: [number, number][] = [
          [b.x, b.y], [b.x + b.width, b.y],
          [b.x + b.width, b.y + b.height], [b.x, b.y + b.height],
        ];
        for (const [cx, cy] of corners) {
          const q = this.toPx(cx, cy);
          this.svg.appendChild(this.vertexMarker(q.x, q.y, false, color));
        }
      }
    }

    // Rubber-band (marquee) selection preview.
    if (this.mode === 'select' && this.bandStart && this.bandCurrent) {
      this.svg.appendChild(this.selectionBand(this.bandStart, this.bandCurrent));
    }

    // In-progress drawing preview.
    if (this.mode === 'drawrect' && this.rectStart && this.rectCurrent) {
      this.svg.appendChild(this.rectPreview(this.rectStart, this.rectCurrent));
    }
    if ((this.mode === 'drawclosedpath' || this.mode === 'drawopenpath') && this.polyPoints.length) {
      this.svg.appendChild(this.polyPreview(this.polyPoints));
    }
    // Click-to-place polygon preview: the polyline so far + a marker on the
    // first vertex (click it to close).
    if (this.mode === 'drawpolygon' && this.polyPoints.length) {
      this.svg.appendChild(this.polyPreview(this.polyPoints));
      const f = this.toPx(this.polyPoints[0].x, this.polyPoints[0].y);
      this.svg.appendChild(this.vertexMarker(f.x, f.y, true));
    }
  }

  /** A small vertex handle (filled for an emphasised marker, hollow otherwise).
   *  Colour defaults to the global shape colour (used by the in-progress draw
   *  preview); selected-region handles pass the region's own colour. */
  private vertexMarker(x: number, y: number, emphasised: boolean,
                       color: string = this.store.getShapeColor()): SVGElement {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', `${x}`);
    c.setAttribute('cy', `${y}`);
    c.setAttribute('r', emphasised ? '5' : '4');
    c.setAttribute('fill', emphasised ? color : '#ffffff');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', '2');
    return c;
  }

  private buildRegionEl(region: Region, selected: boolean): SVGElement | null {
    const color = region.color || this.store.getShapeColor();
    const bounds = region.bounds;
    let pts: { x: number; y: number }[] | null = null;
    let closed = true;
    let el: SVGElement | null = null;

    if (bounds instanceof MultiPolygon) {
      // Multi-part region (jit-ui#85): one even-odd <path> with every part's
      // exterior plus its holes. All parts' vertices drive the label bbox.
      const parts = bounds.polygons.filter((p) => (p.xpoints?.length ?? 0) >= 3);
      if (parts.length === 0) return null;
      pts = [];
      let d = '';
      for (const part of parts) {
        const ext = part.xpoints.map((x, i) => ({ x, y: part.ypoints[i] }));
        pts.push(...ext);
        d += (d ? ' ' : '') + this.straightPathD(ext, true);
        if (part.holes) {
          for (const ring of part.holes) {
            d += ' ' + this.straightPathD(ring.map(([x, y]) => ({ x, y })), true);
          }
        }
      }
      el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('fill-rule', 'evenodd');
    } else if (bounds instanceof Rectangle) {
      pts = [
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        { x: bounds.x, y: bounds.y + bounds.height },
      ];
    } else if (bounds instanceof Polygon) {
      closed = bounds.closed !== false;
      // The anchors drive the label bbox and (for non-bezier) the rendered shape.
      pts = bounds.xpoints.map((x, i) => ({ x, y: bounds.ypoints[i] }));
    }
    if (!pts || pts.length === 0) return null;

    if (!el) {
      // Bezier regions render as a true cubic-bezier path through the anchors
      // (paper.js-equivalent smooth curve); everything else as a straight
      // polygon/polyline.
      const isBezier = bounds instanceof Polygon && bounds.bezier && pts.length >= 2;
      // Interior rings (holes) — punch through with even-odd fill (jit-ui#85).
      const holes = (closed && bounds instanceof Polygon && bounds.holes?.length)
        ? bounds.holes : null;
      if (isBezier || holes) {
        el = document.createElementNS(SVGNS, 'path');
        // Exterior subpath (smooth for bezier, straight otherwise) followed by a
        // straight subpath per hole.
        let d = isBezier ? this.bezierPathD(bounds as Polygon) : this.straightPathD(pts, closed);
        if (holes) {
          for (const ring of holes) {
            d += ' ' + this.straightPathD(ring.map(([x, y]) => ({ x, y })), true);
          }
          el.setAttribute('fill-rule', 'evenodd');
        }
        el.setAttribute('d', d);
      } else {
        el = document.createElementNS(SVGNS, closed ? 'polygon' : 'polyline');
        el.setAttribute('points', pts.map(p => { const q = this.toPx(p.x, p.y); return `${q.x},${q.y}`; }).join(' '));
      }
    }
    el.setAttribute('fill', selected ? this.rgba(color, 0.2) : 'none');
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', selected ? '3' : '2');

    // The class label (legend), shown when the Region Editor's "show labels" is
    // on — mirrors Plotly's per-shape label (top-left, drawn in the region's
    // colour). Without this OSD showed regions with no label even though Plotly
    // did. region.label is restored from the shape's legend in getRegion().
    const label = region.label;
    if (this.store.getShowShapeLabel() && label != null && `${label}`.length > 0) {
      const g = document.createElementNS(SVGNS, 'g');
      g.appendChild(el);
      const minX = Math.min(...pts.map(p => p.x));
      const minY = Math.min(...pts.map(p => p.y));
      const q = this.toPx(minX, minY);
      const text = document.createElementNS(SVGNS, 'text');
      text.setAttribute('x', `${q.x}`);
      text.setAttribute('y', `${q.y - 4}`); // just above the top-left corner
      text.setAttribute('fill', color);
      text.setAttribute('font-size', '13');
      text.setAttribute('font-family', 'sans-serif');
      // Dark halo so the label stays legible over both bright and dark tiles.
      text.setAttribute('paint-order', 'stroke');
      text.setAttribute('stroke', 'rgba(0,0,0,0.65)');
      text.setAttribute('stroke-width', '2');
      text.textContent = `${label}`;
      g.appendChild(text);
      return g;
    }
    return el;
  }

  /** Marquee rectangle for rubber-band multi-select (dashed outline + faint fill). */
  private selectionBand(a: { x: number; y: number }, b: { x: number; y: number }): SVGElement {
    const corners = [
      { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y },
    ];
    const el = document.createElementNS(SVGNS, 'polygon');
    el.setAttribute('points', corners.map(p => { const q = this.toPx(p.x, p.y); return `${q.x},${q.y}`; }).join(' '));
    el.setAttribute('fill', 'rgba(120,170,255,0.15)');
    el.setAttribute('stroke', '#4a90e2');
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('stroke-width', '1');
    return el;
  }

  private rectPreview(a: { x: number; y: number }, b: { x: number; y: number }): SVGElement {
    const corners = [
      { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y },
    ];
    const el = document.createElementNS(SVGNS, 'polygon');
    el.setAttribute('points', corners.map(p => { const q = this.toPx(p.x, p.y); return `${q.x},${q.y}`; }).join(' '));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', this.store.getShapeColor());
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('stroke-width', '2');
    return el;
  }

  private polyPreview(pts: { x: number; y: number }[]): SVGElement {
    const el = document.createElementNS(SVGNS, 'polyline');
    el.setAttribute('points', pts.map(p => { const q = this.toPx(p.x, p.y); return `${q.x},${q.y}`; }).join(' '));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', this.store.getShapeColor());
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('stroke-width', '2');
    return el;
  }

  /** SVG path `d` (element-pixel coords) for a straight-edged ring/polyline. */
  private straightPathD(pts: { x: number; y: number }[], closed: boolean): string {
    if (pts.length < 2) return '';
    let d = '';
    pts.forEach((p, i) => {
      const q = this.toPx(p.x, p.y);
      d += (i === 0 ? 'M ' : ' L ') + `${q.x},${q.y}`;
    });
    if (closed) d += ' Z';
    return d;
  }

  /** SVG path `d` (element-pixel coords) for the smooth cubic bezier through a
   *  polygon's anchors — the paper.js-equivalent curve. */
  private bezierPathD(poly: Polygon): string {
    const xs = poly.xpoints;
    const ys = poly.ypoints;
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return '';
    const closed = poly.closed !== false;
    const h = resolveHandles(xs, ys, closed, poly.handlesIn, poly.handlesOut);
    const px = (x: number, y: number) => { const q = this.toPx(x, y); return `${q.x},${q.y}`; };
    let d = `M ${px(xs[0], ys[0])}`;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const c1 = h[i].out;
      const c2 = h[j].in;
      d += ` C ${px(c1[0], c1[1])} ${px(c2[0], c2[1])} ${px(xs[j], ys[j])}`;
    }
    if (closed) d += ' Z';
    return d;
  }

  /**
   * Draw the bezier editing handles for the selected region, paper.js-style:
   * each anchor as a small square, with tangent lines out to its two control
   * points (drawn as small circles).
   */
  private drawBezierHandles(poly: Polygon, color: string): void {
    const xs = poly.xpoints;
    const ys = poly.ypoints;
    const h = resolveHandles(xs, ys, poly.closed !== false, poly.handlesIn, poly.handlesOut);
    for (let i = 0; i < xs.length; i++) {
      const a = this.toPx(xs[i], ys[i]);
      if (h[i].hasIn) this.drawHandle(a, this.toPx(h[i].in[0], h[i].in[1]), color);
      if (h[i].hasOut) this.drawHandle(a, this.toPx(h[i].out[0], h[i].out[1]), color);
      this.svg.appendChild(this.anchorSquare(a.x, a.y, color));
    }
  }

  /** A tangent line from an anchor to a control point, with a circle at the end. */
  private drawHandle(anchor: { x: number; y: number }, ctrl: { x: number; y: number }, color: string): void {
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', `${anchor.x}`); line.setAttribute('y1', `${anchor.y}`);
    line.setAttribute('x2', `${ctrl.x}`); line.setAttribute('y2', `${ctrl.y}`);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1');
    this.svg.appendChild(line);
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', `${ctrl.x}`); c.setAttribute('cy', `${ctrl.y}`);
    c.setAttribute('r', '3');
    c.setAttribute('fill', color);
    this.svg.appendChild(c);
  }

  /** A filled-white anchor square (the editable vertex). */
  private anchorSquare(x: number, y: number, color: string): SVGElement {
    const r = 3.5;
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', `${x - r}`); rect.setAttribute('y', `${y - r}`);
    rect.setAttribute('width', `${2 * r}`); rect.setAttribute('height', `${2 * r}`);
    rect.setAttribute('fill', '#ffffff');
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', '2');
    return rect;
  }

  private rgba(color: string, alpha: number): string {
    // Accept #rrggbb; fall back to the color as-is for named/rgb values.
    if (/^#([0-9a-f]{6})$/i.test(color)) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
  }

  // ── interaction ──────────────────────────────────────────────────────
  private get isFreehand(): boolean {
    return this.mode === 'drawclosedpath' || this.mode === 'drawopenpath';
  }

  private onPress(e: any): void {
    if (this.mode === 'drawrect') {
      this.rectStart = this.toImage(e.position);
      this.rectCurrent = this.rectStart;
      return;
    }
    if (this.isFreehand) {
      // Freehand draw (matches Plotly drawclosedpath/drawopenpath): press to
      // start, drag to trace, release to commit.
      this.freehandDragging = true;
      this.polyPoints = [this.toImage(e.position)];
      this.lastFreehandPx = { x: e.position.x, y: e.position.y };
      return;
    }
    if (this.mode === 'move') {
      // Whole-region drag ('move' mode): press inside the selected region
      // to translate it, ignoring vertices/edges.
      const sel = this.selectedRegionInfo();
      if (sel && this.containsPoint(sel.region, this.toImage(e.position))) {
        this.startEdit('bounds', 'move', -1, sel.region, this.toImage(e.position));
      }
      return;
    }
    if (this.mode === 'select') {
      // A bezier control handle takes top priority (it sits off the anchor).
      const hh = this.hitBezierHandle(e.position);
      if (hh) {
        const region = this.store.getRegions()[this.selected[this.selected.length - 1]];
        this.startEdit('handle', 'move', hh.index, region, this.toImage(e.position), hh.side);
        return;
      }
      // Then dragging a single polygon vertex (over body-move/resize) —
      // 'select' grabs the nearest segment first.
      const vh = this.hitVertex(e.position);
      if (vh) {
        const region = this.store.getRegions()[this.selected[this.selected.length - 1]];
        this.startEdit('vertex', 'move', vh.index, region, this.toImage(e.position), 'out', vh.ring);
        return;
      }
      // Otherwise start a move/resize when pressing the selected region's
      // body/handles.
      const ez = this.editZoneAt(e.position);
      if (ez) {
        this.startEdit('bounds', ez.zone, -1, this.store.getRegions()[ez.index], this.toImage(e.position));
        return;
      }
      // Press on empty space / a non-selected region: begin a rubber-band
      // multi-select. A plain click (no drag) falls through to onClick, which
      // single-selects or clears.
      this.bandStart = this.toImage(e.position);
      this.bandCurrent = this.bandStart;
      this.bandDragged = false;
    }
  }

  /** Begin an edit gesture (move/resize or single-vertex drag) and open a store
   *  batch so the live drag emits once on release. */
  private startEdit(kind: 'bounds' | 'vertex' | 'handle', zone: EditZone, vertexIndex: number,
                    region: Region, startImg: { x: number; y: number },
                    handleSide: 'in' | 'out' = 'out', ring = -1): void {
    this.edit = {
      kind, zone, vertexIndex, ring, handleSide, id: region.id,
      startImg, orig: kind === 'bounds' ? this.snapshot(region) : null,
    };
    this.editDragged = false;
    this.store.beginBatch();
  }

  private onDrag(e: any): void {
    if (this.mode === 'drawrect' && this.rectStart) {
      this.rectCurrent = this.toImage(e.position);
      this.redraw();
      return;
    }
    if (this.freehandDragging && this.isFreehand) {
      // Thin the path: only sample once the cursor has moved a few screen px.
      const last = this.lastFreehandPx;
      if (!last || Math.hypot(e.position.x - last.x, e.position.y - last.y) >= 4) {
        this.polyPoints.push(this.toImage(e.position));
        this.lastFreehandPx = { x: e.position.x, y: e.position.y };
        this.redraw();
      }
      return;
    }
    if (this.edit) {
      this.editDragged = true;
      this.applyEdit(this.toImage(e.position));
      return;
    }
    if (this.bandStart) {
      this.bandCurrent = this.toImage(e.position);
      this.bandDragged = true;
      this.redraw();
    }
  }

  private onRelease(e: any): void {
    if (this.mode === 'drawrect' && this.rectStart) {
      const end = this.toImage(e.position);
      const x = Math.min(this.rectStart.x, end.x);
      const y = Math.min(this.rectStart.y, end.y);
      const w = Math.abs(end.x - this.rectStart.x);
      const h = Math.abs(end.y - this.rectStart.y);
      this.rectStart = this.rectCurrent = null;
      if (w > 2 && h > 2) this.commitRectangle(x, y, w, h);
      return;
    }
    if (this.freehandDragging) {
      this.freehandDragging = false;
      this.lastFreehandPx = null;
      // Closed = freeform (drawclosedpath); open = polyline (drawopenpath).
      this.commitPolygon(this.mode === 'drawclosedpath');
      return;
    }
    // Move/resize already applied live; flush the coalesced edits + end the
    // gesture (keep selection).
    if (this.edit) {
      this.store.endBatch();
      this.edit = null;
      return;
    }
    // Finish a rubber-band selection: select every region the band intersects.
    if (this.bandStart) {
      const start = this.bandStart;
      const end = this.bandCurrent ?? start;
      this.bandStart = this.bandCurrent = null;
      const x0 = Math.min(start.x, end.x), y0 = Math.min(start.y, end.y);
      const x1 = Math.max(start.x, end.x), y1 = Math.max(start.y, end.y);
      // Only a real drag selects; a click-sized band falls through to onClick.
      if (this.bandDragged && (x1 - x0 > 2 || y1 - y0 > 2)) {
        this.store.setSelectedShapeIndices(this.regionsInRect(x0, y0, x1, y1));
      }
      this.redraw();
    }
  }

  private onClick(e: any): void {
    if (this.mode === 'select') {
      // A move/resize/vertex drag or a rubber-band drag also ends with a click
      // event — don't treat it as a re-selection.
      if (this.editDragged) { this.editDragged = false; return; }
      if (this.bandDragged) { this.bandDragged = false; return; }
      // Shift (or Cmd/Ctrl) toggles the clicked region in/out of the current
      // selection; a plain click replaces it.
      const oe = e.originalEvent;
      const additive = !!oe && (oe.shiftKey || oe.metaKey || oe.ctrlKey);
      this.selectAt(this.toImage(e.position), additive);
      return;
    }
    if (this.mode === 'drawpolygon') {
      this.onDrawPolygonClick(e);
      return;
    }
    if (this.mode === 'addpoint') {
      // Insert a vertex on the clicked edge — exterior or an interior ring.
      const sel = this.selectedRegionInfo();
      const edge = sel ? this.hitEdge(e.position, sel.region) : null;
      if (sel && edge) {
        if (edge.ring < 0) this.store.addVertex(sel.region.id, edge.segIndex, edge.x, edge.y);
        else this.store.addHoleVertex(sel.region.id, edge.ring, edge.segIndex, edge.x, edge.y);
      }
      return;
    }
    if (this.mode === 'deletepoint') {
      // Remove the clicked vertex — exterior or an interior ring (jit-ui#85).
      const vh = this.hitVertex(e.position);
      if (vh) {
        if (vh.ring < 0) this.store.deleteVertex(vh.id, vh.index);
        else this.store.deleteHoleVertex(vh.id, vh.ring, vh.index);
      }
      return;
    }
  }

  /**
   * Click-to-place polygon ('drawpolygon'): the first click starts the
   * polygon, each subsequent click adds a vertex, and clicking near the first
   * vertex (with at least 3 placed) closes and commits it.
   */
  private onDrawPolygonClick(e: any): void {
    const pt = this.toImage(e.position);
    if (!this.drawingPolygon) {
      this.polyPoints = [pt];
      this.drawingPolygon = true;
      this.redraw();
      return;
    }
    const first = this.toPx(this.polyPoints[0].x, this.polyPoints[0].y);
    const onFirst = Math.hypot(e.position.x - first.x, e.position.y - first.y) <= EDIT_TOL;
    if (onFirst && this.polyPoints.length >= 3) {
      this.commitPolygon(true); // closes + resets in-progress (incl. drawingPolygon)
      return;
    }
    this.polyPoints.push(pt);
    this.redraw();
  }

  /**
   * Hover feedback in select mode: move/resize cursors over the selected
   * region's body/edges/corners, a pointer over any other region.
   */
  private onMove(e: any): void {
    if (this.mode !== 'select') return;
    // A grabbable bezier control handle or vertex of the selected polygon takes
    // priority.
    if (this.hitBezierHandle(e.position) || this.hitVertex(e.position)) {
      (this.viewer.canvas as HTMLElement).style.cursor = 'pointer';
      return;
    }
    const ez = this.editZoneAt(e.position);
    if (ez) {
      (this.viewer.canvas as HTMLElement).style.cursor = ZONE_CURSOR[ez.zone];
      return;
    }
    this.updateCursor(this.regionIndexAt(this.toImage(e.position)) >= 0);
  }

  /**
   * The move/resize zone under the cursor for the currently-selected region
   * (rectangles get edge/corner handles + body; polygons get body-move only),
   * or null if the cursor isn't over the selected region.
   */
  private editZoneAt(position: { x: number; y: number }): { zone: EditZone; index: number } | null {
    if (this.selected.length === 0) return null;
    const index = this.selected[this.selected.length - 1];
    const region = this.store.getRegions()[index];
    if (!region) return null;
    const b = region.bounds;
    if (b instanceof Rectangle) {
      const a = this.toPx(b.x, b.y);
      const c = this.toPx(b.x + b.width, b.y + b.height);
      const zone = this.rectZone(position.x, position.y,
        Math.min(a.x, c.x), Math.min(a.y, c.y), Math.max(a.x, c.x), Math.max(a.y, c.y));
      return zone ? { zone, index } : null;
    }
    if (b instanceof Polygon || b instanceof MultiPolygon) {
      // Polygons + multi-part regions support whole-region move (no resize zones).
      return this.containsPoint(region, this.toImage(position)) ? { zone: 'move', index } : null;
    }
    return null;
  }

  /** The currently-selected region (the last one selected), or null. */
  private selectedRegionInfo(): { region: Region; index: number } | null {
    if (this.selected.length === 0) return null;
    const index = this.selected[this.selected.length - 1];
    const region = this.store.getRegions()[index];
    return region ? { region, index } : null;
  }

  /** The vertex of the selected polygon under the cursor (screen-pixel
   *  tolerance), or null. Rectangles have no editable vertices. */
  private hitVertex(position: { x: number; y: number }): { id: number; ring: number; index: number } | null {
    const sel = this.selectedRegionInfo();
    if (!sel || !(sel.region.bounds instanceof Polygon)) return null;
    const b = sel.region.bounds;
    for (let i = 0; i < b.xpoints.length; i++) {
      const q = this.toPx(b.xpoints[i], b.ypoints[i]);
      if (Math.hypot(position.x - q.x, position.y - q.y) <= EDIT_TOL) {
        return { id: sel.region.id, ring: -1, index: i };
      }
    }
    // Interior-ring (hole) vertices are draggable too (jit-ui#85).
    if (b.holes) {
      for (let h = 0; h < b.holes.length; h++) {
        const ring = b.holes[h];
        for (let i = 0; i < ring.length; i++) {
          const q = this.toPx(ring[i][0], ring[i][1]);
          if (Math.hypot(position.x - q.x, position.y - q.y) <= EDIT_TOL) {
            return { id: sel.region.id, ring: h, index: i };
          }
        }
      }
    }
    return null;
  }

  /** The bezier control handle of the selected region under the cursor (which
   *  anchor, and whether the in- or out-handle), or null. */
  private hitBezierHandle(position: { x: number; y: number }): { id: number; index: number; side: 'in' | 'out' } | null {
    const sel = this.selectedRegionInfo();
    if (!sel || !(sel.region.bounds instanceof Polygon) || !sel.region.bounds.bezier) return null;
    const b = sel.region.bounds;
    const h = resolveHandles(b.xpoints, b.ypoints, b.closed !== false, b.handlesIn, b.handlesOut);
    for (let i = 0; i < h.length; i++) {
      if (h[i].hasOut) {
        const q = this.toPx(h[i].out[0], h[i].out[1]);
        if (Math.hypot(position.x - q.x, position.y - q.y) <= EDIT_TOL) {
          return { id: sel.region.id, index: i, side: 'out' };
        }
      }
      if (h[i].hasIn) {
        const q = this.toPx(h[i].in[0], h[i].in[1]);
        if (Math.hypot(position.x - q.x, position.y - q.y) <= EDIT_TOL) {
          return { id: sel.region.id, index: i, side: 'in' };
        }
      }
    }
    return null;
  }

  /** The edge of `region`'s polygon nearest the cursor (within tolerance), with
   *  the clicked point in image coords as the insertion position, or null. */
  private hitEdge(position: { x: number; y: number }, region: Region):
    { ring: number; segIndex: number; x: number; y: number } | null {
    if (!(region.bounds instanceof Polygon)) return null;
    const b = region.bounds;
    let best = -1, bestRing = -1, bestDist = Infinity;
    // Nearest edge across the exterior (ring -1) and every interior ring (hole).
    const scan = (xs: number[], ys: number[], ring: number, closed: boolean) => {
      const n = xs.length;
      const segCount = closed ? n : n - 1; // closed wraps the last->first edge
      for (let i = 0; i < segCount; i++) {
        const j = (i + 1) % n;
        const a = this.toPx(xs[i], ys[i]);
        const c = this.toPx(xs[j], ys[j]);
        const d = this.distToSegmentPx(position, a, c);
        if (d < bestDist) { bestDist = d; best = i; bestRing = ring; }
      }
    };
    scan(b.xpoints, b.ypoints, -1, b.closed !== false);
    if (b.holes) {
      b.holes.forEach((r, h) => scan(r.map(p => p[0]), r.map(p => p[1]), h, true));
    }
    if (best < 0 || bestDist > EDIT_TOL) return null;
    const img = this.toImage(position);
    return { ring: bestRing, segIndex: best, x: img.x, y: img.y };
  }

  /** Classify a screen point against a screen-space rectangle into a zone. */
  private rectZone(px: number, py: number, x0: number, y0: number, x1: number, y1: number): EditZone | null {
    const t = EDIT_TOL;
    if (px < x0 - t || px > x1 + t || py < y0 - t || py > y1 + t) return null;
    const left = Math.abs(px - x0) <= t, right = Math.abs(px - x1) <= t;
    const top = Math.abs(py - y0) <= t, bottom = Math.abs(py - y1) <= t;
    if (top && left) return 'nw';
    if (top && right) return 'ne';
    if (bottom && left) return 'sw';
    if (bottom && right) return 'se';
    if (left) return 'w';
    if (right) return 'e';
    if (top) return 'n';
    if (bottom) return 's';
    if (px > x0 && px < x1 && py > y0 && py < y1) return 'move';
    return null;
  }

  /** Snapshot the selected region's geometry at the start of an edit. */
  private snapshot(region: Region): any {
    const b = region.bounds;
    if (b instanceof Rectangle) return { kind: 'rect', x: b.x, y: b.y, w: b.width, h: b.height };
    if (b instanceof Polygon) {
      return {
        kind: 'poly', xs: b.xpoints.slice(), ys: b.ypoints.slice(), closed: b.closed !== false,
        bezier: b.bezier,
        inOff: b.handlesIn?.map(o => o.slice()),
        outOff: b.handlesOut?.map(o => o.slice()),
        holes: b.holes?.map(ring => ring.map(pt => pt.slice())),
      };
    }
    if (b instanceof MultiPolygon) {
      return {
        kind: 'multi',
        polygons: b.polygons.map((p) => ({
          xs: p.xpoints.slice(), ys: p.ypoints.slice(), closed: p.closed !== false,
          holes: p.holes?.map(ring => ring.map(pt => pt.slice())),
        })),
      };
    }
    return { kind: 'rect', x: 0, y: 0, w: 0, h: 0 };
  }

  /**
   * Apply the in-progress move/resize to the region, live, through the
   * Region-native edit API. Recomputed absolutely from the gesture-start
   * snapshot (`orig`) + the total delta, so each frame is idempotent.
   */
  private applyEdit(curImg: { x: number; y: number }): void {
    if (!this.edit) return;

    if (this.edit.kind === 'vertex') {
      // Drag a single vertex to the cursor (absolute — idempotent). Route to the
      // exterior or the matching interior ring (hole) — jit-ui#85.
      if (this.edit.ring < 0) {
        this.store.moveVertex(this.edit.id, this.edit.vertexIndex, curImg.x, curImg.y);
      } else {
        this.store.moveHoleVertex(this.edit.id, this.edit.ring, this.edit.vertexIndex, curImg.x, curImg.y);
      }
      this.redraw();
      return;
    }

    if (this.edit.kind === 'handle') {
      // Drag a bezier control handle to the cursor.
      this.store.moveBezierHandle(this.edit.id, this.edit.vertexIndex, this.edit.handleSide, curImg.x, curImg.y);
      this.redraw();
      return;
    }

    const dx = curImg.x - this.edit.startImg.x;
    const dy = curImg.y - this.edit.startImg.y;

    const o = this.edit.orig;
    if (o.kind === 'rect') {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      switch (this.edit.zone) {
        case 'move': x0 += dx; x1 += dx; y0 += dy; y1 += dy; break;
        case 'w': x0 += dx; break;
        case 'e': x1 += dx; break;
        case 'n': y0 += dy; break;
        case 's': y1 += dy; break;
        case 'nw': x0 += dx; y0 += dy; break;
        case 'ne': x1 += dx; y0 += dy; break;
        case 'sw': x0 += dx; y1 += dy; break;
        case 'se': x1 += dx; y1 += dy; break;
      }
      const rect = new Rectangle();
      rect.x = Math.round(Math.min(x0, x1));
      rect.y = Math.round(Math.min(y0, y1));
      rect.width = Math.round(Math.abs(x1 - x0));
      rect.height = Math.round(Math.abs(y1 - y0));
      this.store.updateBounds(this.edit.id, rect);
    } else if (o.kind === 'multi') {
      // Multi-part region: translate every part (and its holes) by the delta.
      const mp = new MultiPolygon();
      mp.polygons = o.polygons.map((pp: any) => {
        const xs = pp.xs.map((x: number) => Math.round(x + dx));
        const ys = pp.ys.map((y: number) => Math.round(y + dy));
        const poly = new Polygon();
        poly.npoints = xs.length;
        poly.xpoints = xs;
        poly.ypoints = ys;
        poly.coordinates = xs.map((x: number, i: number) => [x, ys[i]]);
        poly.closed = pp.closed;
        if (pp.holes) {
          poly.holes = pp.holes.map((ring: number[][]) =>
            ring.map(([x, y]: number[]) => [Math.round(x + dx), Math.round(y + dy)]));
        }
        return poly;
      });
      this.store.updateBounds(this.edit.id, mp);
    } else {
      // Polygon: translate every vertex (the only polygon edit zone is 'move').
      // Bezier flag + handle offsets are relative, so they carry over unchanged.
      const xs = o.xs.map((x: number) => Math.round(x + dx));
      const ys = o.ys.map((y: number) => Math.round(y + dy));
      const poly = new Polygon();
      poly.npoints = xs.length;
      poly.xpoints = xs;
      poly.ypoints = ys;
      poly.coordinates = xs.map((x: number, i: number) => [x, ys[i]]);
      poly.closed = o.closed;
      poly.bezier = o.bezier;
      if (o.inOff) poly.handlesIn = o.inOff.map((off: number[]) => off.slice());
      if (o.outOff) poly.handlesOut = o.outOff.map((off: number[]) => off.slice());
      // Translate interior rings (holes) with the exterior (jit-ui#85).
      if (o.holes) {
        poly.holes = o.holes.map((ring: number[][]) =>
          ring.map(([x, y]: number[]) => [Math.round(x + dx), Math.round(y + dy)]));
      }
      this.store.updateBounds(this.edit.id, poly);
    }
    this.redraw();
  }

  private selectAt(pt: { x: number; y: number }, additive = false): void {
    const idx = this.regionIndexAt(pt);
    if (additive) {
      // Shift-click on empty space keeps the current selection.
      if (idx < 0) return;
      // `this.selected` mirrors the store's current selection (kept in sync via
      // the subscription), so it's the source of truth without a sync getter.
      const cur = this.selected.slice();
      const at = cur.indexOf(idx);
      if (at >= 0) cur.splice(at, 1); // toggle off
      else cur.push(idx);             // toggle on
      this.store.setSelectedShapeIndices(cur);
      return;
    }
    this.store.setSelectedShapeIndices(idx >= 0 ? [idx] : []);
  }

  /** Indices of every region whose bounding box intersects the image-space
   *  rectangle [x0,y0]–[x1,y1] (rubber-band multi-select). */
  private regionsInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [];
    this.store.getRegions().forEach((r, i) => {
      const bb = this.regionBBox(r);
      if (bb && bb.x0 <= x1 && bb.x1 >= x0 && bb.y0 <= y1 && bb.y1 >= y0) out.push(i);
    });
    return out;
  }

  /** Axis-aligned bounding box of a region in image coords, or null if empty. */
  private regionBBox(r: Region): { x0: number; y0: number; x1: number; y1: number } | null {
    const b = r.bounds;
    if (b instanceof Rectangle) {
      return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
    }
    if (b instanceof Polygon && b.xpoints.length) {
      return {
        x0: Math.min(...b.xpoints), y0: Math.min(...b.ypoints),
        x1: Math.max(...b.xpoints), y1: Math.max(...b.ypoints),
      };
    }
    if (b instanceof MultiPolygon) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of b.polygons) {
        for (let i = 0; i < p.xpoints.length; i++) {
          if (p.xpoints[i] < x0) x0 = p.xpoints[i];
          if (p.xpoints[i] > x1) x1 = p.xpoints[i];
          if (p.ypoints[i] < y0) y0 = p.ypoints[i];
          if (p.ypoints[i] > y1) y1 = p.ypoints[i];
        }
      }
      return x1 >= x0 ? { x0, y0, x1, y1 } : null;
    }
    return null;
  }

  /** Index of the topmost region under a point, or -1. */
  private regionIndexAt(pt: { x: number; y: number }): number {
    const regions = this.store.getRegions();
    for (let i = regions.length - 1; i >= 0; i--) {
      if (this.containsPoint(regions[i], pt)) return i;
    }
    return -1;
  }

  private containsPoint(region: Region, pt: { x: number; y: number }): boolean {
    const b = region.bounds;
    if (b instanceof Rectangle) {
      return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
    }
    // Multi-part region: inside any part (exterior minus that part's holes).
    if (b instanceof MultiPolygon) {
      return b.polygons.some((p) => this.closedPolygonContains(p, pt));
    }
    if (b instanceof Polygon) {
      if (b.closed !== false) return this.closedPolygonContains(b, pt);
      // Open polyline: no interior — select when the click lands near the line.
      // Tolerance is in screen pixels so it stays clickable at any zoom.
      const xs = b.xpoints, ys = b.ypoints, n = xs.length, tolPx = 6;
      const here = this.toPx(pt.x, pt.y);
      for (let i = 0; i + 1 < n; i++) {
        const a = this.toPx(xs[i], ys[i]);
        const c = this.toPx(xs[i + 1], ys[i + 1]);
        if (this.distToSegmentPx(here, a, c) <= tolPx) return true;
      }
      return false;
    }
    return false;
  }

  /** Point-in-closed-polygon (image coords) honouring interior rings (holes):
   *  inside the exterior AND outside every hole (even-odd). */
  private closedPolygonContains(b: Polygon, pt: { x: number; y: number }): boolean {
    const inRing = (rxs: number[], rys: number[]): boolean => {
      let hit = false;
      for (let i = 0, j = rxs.length - 1; i < rxs.length; j = i++) {
        const intersect = ((rys[i] > pt.y) !== (rys[j] > pt.y))
          && (pt.x < ((rxs[j] - rxs[i]) * (pt.y - rys[i])) / (rys[j] - rys[i]) + rxs[i]);
        if (intersect) hit = !hit;
      }
      return hit;
    };
    if (!inRing(b.xpoints, b.ypoints)) return false;
    if (b.holes) {
      for (const ring of b.holes) {
        if (inRing(ring.map(p => p[0]), ring.map(p => p[1]))) return false;
      }
    }
    return true;
  }

  /** Shortest distance from point p to segment a–b, all in screen pixels. */
  private distToSegmentPx(
    p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number },
  ): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  private resetInProgress(): void {
    this.rectStart = this.rectCurrent = null;
    this.polyPoints = [];
    this.freehandDragging = false;
    this.drawingPolygon = false;
    this.lastFreehandPx = null;
    // Close any open edit batch (e.g. a mode switch mid-drag) so the store's
    // emit coalescing doesn't get stuck.
    if (this.edit) {
      this.store.endBatch();
      this.edit = null;
    }
  }

  // ── commit to the store ──────────────────────────────────────────────
  private commitRectangle(x: number, y: number, w: number, h: number): void {
    const region = new Region();
    const rect = new Rectangle();
    rect.x = x; rect.y = y; rect.width = w; rect.height = h;
    region.bounds = rect;
    region.color = this.store.getShapeColor();
    this.commitRegion(region);
  }

  private commitPolygon(closed: boolean): void {
    if (this.polyPoints.length < (closed ? 3 : 2)) { this.resetInProgress(); return; }
    const region = new Region();
    const poly = new Polygon();
    poly.npoints = this.polyPoints.length;
    poly.xpoints = this.polyPoints.map(p => p.x);
    poly.ypoints = this.polyPoints.map(p => p.y);
    poly.coordinates = this.polyPoints.map(p => [p.x, p.y]);
    poly.closed = closed;
    region.bounds = poly;
    region.color = this.store.getShapeColor();
    this.resetInProgress();
    this.commitRegion(region);
  }

  /**
   * Add a freshly-drawn region to the shared store and redraw immediately. The
   * store mints the id, selects the new region (so it renders solid/highlighted
   * rather than as a dashed in-progress shape) and emits the full region list to
   * the Region Editor — we still redraw locally rather than relying solely on
   * the store's update event, which can be swallowed when Plotly isn't active.
   */
  private commitRegion(region: Region): void {
    // Default class/annotation name, matching the Plotly backend and the Region
    // Editor's "Add" actions so a freshly drawn region isn't unlabeled.
    if (region.label == null) region.label = 'legend';
    this.store.addRegion(region);
    this.redraw();
  }

  /**
   * Convert the selected region(s) to/from a bezier curve (toBezier = true /
   * toPolygon = false). One-shot; the anchors are unchanged,
   * only the smooth-curve rendering is toggled.
   */
  setSelectedBezier(bezier: boolean): void {
    const regions = this.store.getRegions();
    for (const idx of this.selected) {
      const region = regions[idx];
      if (region) this.store.setBezier(region.id, bezier);
    }
    this.redraw();
  }
}
