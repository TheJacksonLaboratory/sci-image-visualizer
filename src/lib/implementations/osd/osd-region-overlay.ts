import { OSD } from './osd-lib';
import { Subscription } from 'rxjs';

import { Region, Rectangle, Polygon, MultiPolygon } from '../../models/region';
import { IRegionStore } from '../../contracts/visualizer.contract';
import { IRegionEditApi } from '../../contracts/region-store.contract';
import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { elementToImage, imageToElement } from './osd-coords';
import { OSD_ZOOM_PER_SCROLL } from './osd-zoom';
import { parseCssColor } from '../../contracts/color';
import { translateBounds } from '../../models/polygon-edit';
import {
  OPEN_PATH_TOL_PX, ToScreen, hitHandle, nearestEdge, regionBBox, regionContains, regionsInRect, ringHandles,
  ringOf, topmostRegionAt,
} from '../../region-overlay/region-geometry';
import {
  ScreenLayer, SvgRegionRenderer, affineFromProjection, svgEl,
} from '../../region-overlay/svg-region-renderer';

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
/** A region's geometry at the start of a move/resize (see `snapshot`): a rectangle's
 *  box for a resize, or the polygon/multi-polygon bounds themselves for a move — the
 *  store is copy-on-write, so the gesture-start instance never changes under the drag. */
type EditSnapshot =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'shape'; bounds: Polygon | MultiPolygon };

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
  private readonly osd: any = OSD;

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
    /** Gesture-start geometry; set for 'bounds' edits only. */
    orig: EditSnapshot | null;
  } | null = null;
  private editDragged = false;
  /** Rubber-band (marquee) multi-select in 'select' mode: press on empty space
   *  and drag to select every region the band intersects. Image coords. */
  private bandStart: { x: number; y: number } | null = null;
  private bandCurrent: { x: number; y: number } | null = null;
  private bandDragged = false;

  private readonly redrawHandler = () => this.redraw();
  /** A camera move ('update-viewport', raised on every redrawn frame, animated ones
   *  included; 'resize'; 'rotate'). The regions are drawn in image coordinates, so
   *  only the renderer's transform and its few screen-space elements follow; nothing
   *  is rebuilt (OSD-PLOTLY-11). A tile-only frame (loading, recolor) leaves the
   *  projection, and so the DOM, untouched. */
  private readonly cameraHandler = () => this.updateCamera();
  private readonly renderer: SvgRegionRenderer;
  /** OSD's MouseTracker drops a cancelled pointer (touch interrupted, pointer
   *  capture lost to the browser) without calling releaseHandler, so the
   *  gesture is ended here instead. */
  private readonly pointerCancelHandler = () => {
    this.endGesture();
    this.redraw();
  };

  constructor(private viewer: any, private store: RegionEditStore) {
    this.svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    Object.assign(this.svg.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none', // OSD handles navigation unless we're drawing
    });
    this.viewer.canvas.appendChild(this.svg);
    this.renderer = new SvgRegionRenderer(this.svg, {
      rectElement: 'polygon',
      styleShape: (el, region, selected) => this.styleRegion(el, region, selected),
      decorate: (region, _i, _selected, layer) => this.drawLabel(region, layer),
    });
    (this.viewer.canvas as HTMLElement).addEventListener('pointercancel', this.pointerCancelHandler);

    // 'update-viewport' fires on every redrawn frame, animated ones included —
    // also listening to 'animation' rebuilt the whole SVG twice per frame.
    this.viewer.addHandler('update-viewport', this.cameraHandler);
    this.viewer.addHandler('resize', this.cameraHandler);
    this.viewer.addHandler('rotate', this.cameraHandler);
    // Keep wheel-zoom alive while a tool has mouse-nav disabled (see handler).
    (this.viewer.element as HTMLElement | undefined)
      ?.addEventListener('wheel', this.wheelZoomHandler, { passive: false });

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
    this.renderOverlay();
  }

  /** Drive OSD zoom from the wheel while any tool owns the pointer.
   *
   * OSD's native scroll-zoom is part of mouse-nav, so `setMouseNavEnabled(false)`
   * (used by every region tool and by the wand/brush/eraser/SAM tools) disables
   * it. The covering-canvas tools also sit above the OSD canvas and swallow the
   * wheel outright. This listener is bound once to the viewer element — an
   * ancestor of both the OSD canvas and the tool overlays — and forwards the
   * wheel to a cursor-centred zoom whenever mouse-nav is off. When nav is on (no
   * tool active) it does nothing and OSD zooms natively. (jit-ui#94) */
  private readonly wheelZoomHandler = (e: WheelEvent) => {
    const vp = this.viewer?.viewport;
    const el = this.viewer?.element as HTMLElement | undefined;
    // Nav on → no tool active → let OSD handle scroll-zoom natively.
    if (!vp || !el || e.deltaY === 0 || this.viewer.isMouseNavEnabled()) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const refPoint = vp.pointFromPixel(new this.osd.Point(e.clientX - rect.left, e.clientY - rect.top));
    vp.zoomBy(e.deltaY < 0 ? OSD_ZOOM_PER_SCROLL : 1 / OSD_ZOOM_PER_SCROLL, refPoint);
    vp.applyConstraints();
  };

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
    // Close a gesture in flight first: a drag's open store batch would
    // otherwise suppress every later region-update emission app-wide.
    this.endGesture();
    (this.viewer.canvas as HTMLElement).removeEventListener('pointercancel', this.pointerCancelHandler);
    this.subs.unsubscribe();
    (this.viewer.element as HTMLElement | undefined)
      ?.removeEventListener('wheel', this.wheelZoomHandler);
    this.viewer.removeHandler('update-viewport', this.cameraHandler);
    this.viewer.removeHandler('resize', this.cameraHandler);
    this.viewer.removeHandler('rotate', this.cameraHandler);
    if (this.tracker) this.tracker.destroy();
    if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
  }

  // ── coordinate helpers ───────────────────────────────────────────────
  /** Image-pixel point -> element pixel point. */
  private toPx(imgX: number, imgY: number): { x: number; y: number } {
    return imageToElement(this.viewer, imgX, imgY);
  }
  /** Element pixel point (from a MouseTracker event) -> image-pixel point, rounded
   *  to whole pixels (where a drawn vertex lands). */
  private toImage(pos: any): { x: number; y: number } {
    const p = elementToImage(this.viewer, pos.x, pos.y);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }
  /** Element pixel point -> exact image point, for hit tests. */
  private toWorld(pos: { x: number; y: number }): { x: number; y: number } {
    return elementToImage(this.viewer, pos.x, pos.y);
  }
  /** Image point -> element px, as the shared region geometry wants it. */
  private readonly toScreen: ToScreen = (x, y) => {
    const q = this.toPx(x, y);
    return [q.x, q.y];
  };

  // ── rendering ────────────────────────────────────────────────────────
  /** Follow the current image→element projection: the renderer rewrites one transform
   *  and re-positions its screen-space elements, or does nothing when it did not move. */
  private updateCamera(): void {
    this.renderer.setCamera(affineFromProjection(this.toScreen));
  }

  /** Rebuild everything: the regions (in image coordinates), their labels and the overlay. */
  redraw(): void {
    this.updateCamera();
    this.renderer.render(this.store.getRegions(), this.selected);
    this.renderOverlay();
  }

  /**
   * Rebuild the screen-space overlay only: the selected region's handles, the rubber band
   * and any in-progress drawing. Drawing and marquee drags call this rather than
   * {@link redraw}, so the regions are not rebuilt per pointer move.
   */
  private renderOverlay(): void {
    this.renderer.renderOverlay((layer) => {
      // Handles on the selected polygon, so the user can grab/insert/delete
      // vertices. Bezier regions also get their cubic control handles (tangent
      // lines + control points), mirroring paper.js's fullySelected rendering.
      if (this.showsSelectedVertices) {
        const sel = this.selectedRegionInfo();
        const b = sel?.region.bounds;
        // Handles/vertices take the region's own colour (not the global shape
        // colour) so they match the shape they belong to.
        const color = sel ? sel.region.color || this.store.getShapeColor() : '';
        if (b instanceof Polygon) {
          if (b.bezier) {
            this.drawBezierHandles(layer, b, color);
          } else {
            // The exterior, then each interior ring (hole), so a donut's inner outline
            // shows its vertices when selected (jit-ui#85).
            for (let ring = -1; ring < (b.holes?.length ?? 0); ring++) {
              const { xs, ys } = ringOf(b, ring);
              for (let i = 0; i < xs.length; i++) this.vertexMarker(layer, xs[i], ys[i], false, color);
            }
          }
        } else if (b instanceof Rectangle) {
          // The four corners as grab/resize handles.
          const corners: [number, number][] = [
            [b.x, b.y], [b.x + b.width, b.y],
            [b.x + b.width, b.y + b.height], [b.x, b.y + b.height],
          ];
          for (const [cx, cy] of corners) this.vertexMarker(layer, cx, cy, false, color);
        }
      }

      // Rubber-band (marquee) selection preview.
      if (this.mode === 'select' && this.bandStart && this.bandCurrent) {
        this.selectionBand(layer, this.bandStart, this.bandCurrent);
      }

      // In-progress drawing preview.
      if (this.mode === 'drawrect' && this.rectStart && this.rectCurrent) {
        this.rectPreview(layer, this.rectStart, this.rectCurrent);
      }
      if ((this.mode === 'drawclosedpath' || this.mode === 'drawopenpath') && this.polyPoints.length) {
        this.polyPreview(layer, this.polyPoints);
      }
      // Click-to-place polygon preview: the polyline so far + a marker on the
      // first vertex (click it to close).
      if (this.mode === 'drawpolygon' && this.polyPoints.length) {
        this.polyPreview(layer, this.polyPoints);
        this.vertexMarker(layer, this.polyPoints[0].x, this.polyPoints[0].y, true);
      }
    });
  }

  /** A small vertex handle (filled for an emphasised marker, hollow otherwise) at an
   *  image point. Colour defaults to the global shape colour (used by the in-progress
   *  draw preview); selected-region handles pass the region's own colour. */
  private vertexMarker(layer: ScreenLayer, x: number, y: number, emphasised: boolean,
                       color: string = this.store.getShapeColor()): void {
    const c = svgEl('circle');
    c.setAttribute('r', emphasised ? '5' : '4');
    c.setAttribute('fill', emphasised ? color : '#ffffff');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', '2');
    layer.at(c, x, y, { x: 'cx', y: 'cy' });
  }

  /** Stroke/fill for a region shape (drawn in image coordinates by the renderer). */
  private styleRegion(el: SVGElement, region: Region, selected: boolean): void {
    const color = region.color || this.store.getShapeColor();
    el.setAttribute('fill', selected ? this.rgba(color, 0.35) : 'none');
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', selected ? '4' : '2');
  }

  /**
   * The class label (legend), shown when the Region Editor's "show labels" is on —
   * mirrors Plotly's per-shape label (top-left, drawn in the region's colour).
   * region.label is restored from the shape's legend in getRegion().
   */
  private drawLabel(region: Region, layer: ScreenLayer): void {
    const label = region.label;
    if (!this.store.getShowShapeLabel() || label == null || `${label}`.length === 0) return;
    // The loop-based bbox, not Math.min(...spread): spreading a large imported
    // annotation's vertices as arguments throws RangeError (OSD-PLOTLY-34).
    const bb = regionBBox(region);
    if (!bb) return;
    const text = svgEl('text');
    text.setAttribute('fill', region.color || this.store.getShapeColor());
    text.setAttribute('font-size', '13');
    text.setAttribute('font-family', 'sans-serif');
    // Dark halo so the label stays legible over both bright and dark tiles.
    text.setAttribute('paint-order', 'stroke');
    text.setAttribute('stroke', 'rgba(0,0,0,0.65)');
    text.setAttribute('stroke-width', '2');
    text.textContent = `${label}`;
    layer.at(text, bb.x0, bb.y0, { dy: -4 }); // just above the top-left corner
  }

  /** Marquee rectangle for rubber-band multi-select (dashed outline + faint fill). */
  private selectionBand(layer: ScreenLayer, a: { x: number; y: number }, b: { x: number; y: number }): void {
    const el = layer.poly('polygon', [
      { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y },
    ]);
    el.setAttribute('fill', 'rgba(120,170,255,0.15)');
    el.setAttribute('stroke', '#4a90e2');
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('stroke-width', '1');
  }

  private rectPreview(layer: ScreenLayer, a: { x: number; y: number }, b: { x: number; y: number }): void {
    const el = layer.poly('polygon', [
      { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y },
    ]);
    this.styleDraft(el);
  }

  private polyPreview(layer: ScreenLayer, pts: { x: number; y: number }[]): void {
    this.styleDraft(layer.poly('polyline', pts.slice()));
  }

  private styleDraft(el: SVGElement): void {
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', this.store.getShapeColor());
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('stroke-width', '2');
  }

  /**
   * Draw the bezier editing handles for the selected region, paper.js-style:
   * each anchor as a small square, with tangent lines out to its two control
   * points (drawn as small circles).
   */
  private drawBezierHandles(layer: ScreenLayer, poly: Polygon, color: string): void {
    // The exterior, then each donut hole ring (jit-ui#102): stored handles, or the
    // Catmull-Rom default the curve is drawn with — the ones hitHandle grabs.
    for (let ring = -1; ring < (poly.holes?.length ?? 0); ring++) {
      const { xs, ys } = ringOf(poly, ring);
      const h = ringHandles(poly, ring);
      for (let i = 0; i < xs.length; i++) {
        if (h[i].hasIn) this.drawHandle(layer, xs[i], ys[i], h[i].in, color);
        if (h[i].hasOut) this.drawHandle(layer, xs[i], ys[i], h[i].out, color);
        this.anchorSquare(layer, xs[i], ys[i], color);
      }
    }
  }

  /** A tangent line from an anchor to a control point, with a circle at the end. */
  private drawHandle(layer: ScreenLayer, ax: number, ay: number, ctrl: [number, number], color: string): void {
    const line = layer.line(ax, ay, ctrl[0], ctrl[1]);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1');
    const c = svgEl('circle');
    c.setAttribute('r', '3');
    c.setAttribute('fill', color);
    layer.at(c, ctrl[0], ctrl[1], { x: 'cx', y: 'cy' });
  }

  /** A filled-white anchor square (the editable vertex). */
  private anchorSquare(layer: ScreenLayer, x: number, y: number, color: string): void {
    const r = 3.5;
    const rect = svgEl('rect');
    rect.setAttribute('width', `${2 * r}`); rect.setAttribute('height', `${2 * r}`);
    rect.setAttribute('fill', '#ffffff');
    rect.setAttribute('stroke', color);
    rect.setAttribute('stroke-width', '2');
    layer.at(rect, x, y, { dx: -r, dy: -r });
  }

  private rgba(color: string, alpha: number): string {
    // A parseable colour gets the alpha; anything else (a named colour) is used as-is.
    const rgb = parseCssColor(color);
    return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : color;
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
      if (sel && this.containsPoint(sel.region, e.position)) {
        this.startEdit('bounds', 'move', -1, sel.region, this.toImage(e.position));
      }
      return;
    }
    if (this.mode === 'select') {
      // A bezier control handle takes top priority (it sits off the anchor), then
      // dragging a single polygon vertex (over body-move/resize).
      const hit = this.hitPolygonHandle(e.position);
      if (hit) {
        const region = this.store.getRegions()[this.selected[this.selected.length - 1]];
        if (hit.kind === 'bezier') {
          this.startEdit('handle', 'move', hit.index, region, this.toImage(e.position), hit.side, hit.ring);
        } else {
          this.startEdit('vertex', 'move', hit.index, region, this.toImage(e.position), 'out', hit.ring);
        }
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
      this.renderOverlay();
      return;
    }
    if (this.freehandDragging && this.isFreehand) {
      // Thin the path: only sample once the cursor has moved a few screen px.
      const last = this.lastFreehandPx;
      if (!last || Math.hypot(e.position.x - last.x, e.position.y - last.y) >= 4) {
        this.polyPoints.push(this.toImage(e.position));
        this.lastFreehandPx = { x: e.position.x, y: e.position.y };
        this.renderOverlay();
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
      this.renderOverlay();
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
        this.store.setSelectedShapeIndices(regionsInRect(this.store.getRegions(), x0, y0, x1, y1));
      }
      this.renderOverlay();
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
      this.selectAt(this.toWorld(e.position), additive);
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
      const sel = this.selectedRegionInfo();
      const vh = this.hitPolygonHandle(e.position, false);
      if (sel && vh) {
        if (vh.ring < 0) this.store.deleteVertex(sel.region.id, vh.index);
        else this.store.deleteHoleVertex(sel.region.id, vh.ring, vh.index);
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
      this.renderOverlay();
      return;
    }
    const first = this.toPx(this.polyPoints[0].x, this.polyPoints[0].y);
    const onFirst = Math.hypot(e.position.x - first.x, e.position.y - first.y) <= EDIT_TOL;
    if (onFirst && this.polyPoints.length >= 3) {
      this.commitPolygon(true); // closes + resets in-progress (incl. drawingPolygon)
      return;
    }
    this.polyPoints.push(pt);
    this.renderOverlay();
  }

  /**
   * Hover feedback in select mode: move/resize cursors over the selected
   * region's body/edges/corners, a pointer over any other region.
   */
  private onMove(e: any): void {
    if (this.mode !== 'select') return;
    // A grabbable bezier control handle or vertex of the selected polygon takes
    // priority.
    if (this.hitPolygonHandle(e.position)) {
      (this.viewer.canvas as HTMLElement).style.cursor = 'pointer';
      return;
    }
    const ez = this.editZoneAt(e.position);
    if (ez) {
      (this.viewer.canvas as HTMLElement).style.cursor = ZONE_CURSOR[ez.zone];
      return;
    }
    this.updateCursor(this.regionIndexAt(this.toWorld(e.position)) >= 0);
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
      return this.containsPoint(region, position) ? { zone: 'move', index } : null;
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

  /** The bezier control handle (when `bezier`) or vertex of the selected polygon
   *  under the cursor (screen-pixel tolerance), or null. Rectangles have no
   *  editable vertices (their corners are resize zones, see {@link rectZone}). */
  private hitPolygonHandle(position: { x: number; y: number }, bezier = true):
    { kind: 'vertex' | 'bezier'; ring: number; index: number; side: 'in' | 'out' } | null {
    const sel = this.selectedRegionInfo();
    if (!sel || !(sel.region.bounds instanceof Polygon)) return null;
    const hit = hitHandle(sel.region, position.x, position.y, this.toScreen, EDIT_TOL, { bezier });
    if (!hit || hit.kind === 'corner') return null;
    return { kind: hit.kind, ring: hit.ring, index: hit.index, side: hit.kind === 'bezier' ? hit.side : 'out' };
  }

  /** The edge of `region`'s polygon nearest the cursor (within tolerance), with
   *  the clicked point in image coords as the insertion position, or null. */
  private hitEdge(position: { x: number; y: number }, region: Region):
    { ring: number; segIndex: number; x: number; y: number } | null {
    const edge = nearestEdge(region, position.x, position.y, this.toScreen);
    if (!edge || edge.dist > EDIT_TOL) return null;
    const img = this.toImage(position);
    return { ring: edge.ring, segIndex: edge.segIndex, x: img.x, y: img.y };
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
  private snapshot(region: Region): EditSnapshot {
    const b = region.bounds;
    if (b instanceof Polygon || b instanceof MultiPolygon) return { kind: 'shape', bounds: b };
    if (b instanceof Rectangle) return { kind: 'rect', x: b.x, y: b.y, w: b.width, h: b.height };
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
      // Drag a bezier control handle to the cursor — exterior (ring -1) or a donut hole ring.
      if (this.edit.ring < 0) {
        this.store.moveBezierHandle(this.edit.id, this.edit.vertexIndex, this.edit.handleSide, curImg.x, curImg.y);
      } else {
        this.store.moveHoleBezierHandle(
          this.edit.id, this.edit.ring, this.edit.vertexIndex, this.edit.handleSide, curImg.x, curImg.y,
        );
      }
      this.redraw();
      return;
    }

    const dx = curImg.x - this.edit.startImg.x;
    const dy = curImg.y - this.edit.startImg.y;

    const o = this.edit.orig;
    if (!o) return;
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
    } else {
      // Polygon / multi-part region: translate every vertex, hole and part, rounded to
      // whole pixels. Bezier handle offsets are relative, so they carry over unchanged.
      this.store.updateBounds(this.edit.id, translateBounds(o.bounds, dx, dy, Math.round));
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

  /** Index of the topmost region under an image point, or -1. */
  private regionIndexAt(pt: { x: number; y: number }): number {
    const opts = { toScreen: this.toScreen, tolPx: OPEN_PATH_TOL_PX };
    return topmostRegionAt(this.store.getRegions(), pt.x, pt.y, opts);
  }

  /** Whether the element-pixel `position` lands on `region` (see `regionContains`). */
  private containsPoint(region: Region, position: { x: number; y: number }): boolean {
    const pt = this.toWorld(position);
    return regionContains(region, pt.x, pt.y, { toScreen: this.toScreen, tolPx: OPEN_PATH_TOL_PX });
  }

  /** Abandon whatever pointer gesture is in progress (drawing, edit drag,
   *  rubber band) and close its store batch. */
  private endGesture(): void {
    this.resetInProgress();
    this.bandStart = this.bandCurrent = null;
    this.bandDragged = false;
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
    if (region.label == null) region.label = 'Region';
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
