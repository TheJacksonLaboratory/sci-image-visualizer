import type * as OpenSeadragon from 'openseadragon';
import { OSD } from './osd-lib';
import { Subscription } from 'rxjs';

import { Region, Rectangle, Polygon, MultiPolygon } from '../../models/region';
import { IRegionStore } from '../../contracts/visualizer.contract';
import { IRegionEditApi } from '../../contracts/region-store.contract';
import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { elementToImage, imageToElement } from './osd-coords';
import { OsdViewerLike } from './osd-viewer-like';
import { OSD_ZOOM_PER_SCROLL } from './osd-zoom';
import { translateBounds } from '../../models/polygon-edit';
import { makePolygon } from '../../models/polygon-factory';
import {
  OPEN_PATH_TOL_PX, ToScreen, hitHandle, nearestEdge, regionContains, regionsInRect, topmostRegionAt,
} from '../../region-overlay/region-geometry';
import { SvgRegionRenderer, affineFromProjection } from '../../region-overlay/svg-region-renderer';
import {
  drawDraftPath, drawDraftRect, drawRegionLabel, drawSelectionBand, drawSelectionHandles, styleRegionShape,
  vertexMarker,
} from './osd-region-overlay-draw';
import { EDIT_TOL_PX, EditZone, ZONE_CURSOR, rectZone, resizeRect } from '../../region-overlay/region-hit-test';

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

/** A region's geometry at the start of a move/resize (see `snapshot`): a rectangle's
 *  box for a resize, or the polygon/multi-polygon bounds themselves for a move — the
 *  store is copy-on-write, so the gesture-start instance never changes under the drag. */
type EditSnapshot =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'shape'; bounds: Polygon | MultiPolygon };

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
  private selected: number[] = [];
  private mode: RegionToolMode = 'none';

  private tracker: OpenSeadragon.MouseTracker;
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

  constructor(private viewer: OsdViewerLike, private store: RegionEditStore) {
    this.svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    Object.assign(this.svg.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none', // OSD handles navigation unless we're drawing
    });
    this.viewer.canvas.appendChild(this.svg);
    this.renderer = new SvgRegionRenderer(this.svg, {
      rectElement: 'polygon',
      styleShape: (el, region, selected) => styleRegionShape(el, region, selected, this.store.getShapeColor()),
      // The class label, when the Region Editor's "show labels" is on.
      decorate: (region, _i, _selected, layer) => {
        if (this.store.getShowShapeLabel()) drawRegionLabel(layer, region, this.store.getShapeColor());
      },
    });
    this.viewer.canvas.addEventListener('pointercancel', this.pointerCancelHandler);

    // 'update-viewport' fires on every redrawn frame, animated ones included —
    // also listening to 'animation' rebuilt the whole SVG twice per frame.
    this.viewer.addHandler('update-viewport', this.cameraHandler);
    this.viewer.addHandler('resize', this.cameraHandler);
    this.viewer.addHandler('rotate', this.cameraHandler);
    // Keep wheel-zoom alive while a tool has mouse-nav disabled (see handler).
    this.viewer.element
      ?.addEventListener('wheel', this.wheelZoomHandler, { passive: false });

    this.tracker = new OSD.MouseTracker({
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
    const el = this.viewer?.element;
    // Nav on → no tool active → let OSD handle scroll-zoom natively.
    if (!vp || !el || e.deltaY === 0 || this.viewer.isMouseNavEnabled()) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const refPoint = vp.pointFromPixel(new OSD.Point(e.clientX - rect.left, e.clientY - rect.top));
    vp.zoomBy(e.deltaY < 0 ? OSD_ZOOM_PER_SCROLL : 1 / OSD_ZOOM_PER_SCROLL, refPoint);
    vp.applyConstraints();
  };

  /** Cursor feedback per mode (crosshair while drawing; pointer over a region
   *  in select mode). */
  private updateCursor(overRegion: boolean): void {
    const canvas = this.viewer.canvas;
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
    this.viewer.canvas.removeEventListener('pointercancel', this.pointerCancelHandler);
    this.subs.unsubscribe();
    this.viewer.element
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
    const shapeColor = this.store.getShapeColor();
    this.renderer.renderOverlay((layer) => {
      // Handles on the selected region, so the user can grab/insert/delete
      // vertices — in the region's own colour, so they match the shape.
      const sel = this.showsSelectedVertices ? this.selectedRegionInfo() : null;
      if (sel) drawSelectionHandles(layer, sel.region, sel.region.color || shapeColor);
      // Rubber-band (marquee) selection preview.
      if (this.mode === 'select' && this.bandStart && this.bandCurrent) {
        drawSelectionBand(layer, this.bandStart, this.bandCurrent);
      }
      // In-progress drawing preview.
      if (this.mode === 'drawrect' && this.rectStart && this.rectCurrent) {
        drawDraftRect(layer, this.rectStart, this.rectCurrent, shapeColor);
      }
      if ((this.mode === 'drawclosedpath' || this.mode === 'drawopenpath') && this.polyPoints.length) {
        drawDraftPath(layer, this.polyPoints, shapeColor);
      }
      // Click-to-place polygon preview: the polyline so far + a marker on the
      // first vertex (click it to close).
      if (this.mode === 'drawpolygon' && this.polyPoints.length) {
        drawDraftPath(layer, this.polyPoints, shapeColor);
        vertexMarker(layer, this.polyPoints[0].x, this.polyPoints[0].y, true, shapeColor);
      }
    });
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
    const onFirst = Math.hypot(e.position.x - first.x, e.position.y - first.y) <= EDIT_TOL_PX;
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
      this.viewer.canvas.style.cursor = 'pointer';
      return;
    }
    const ez = this.editZoneAt(e.position);
    if (ez) {
      this.viewer.canvas.style.cursor = ZONE_CURSOR[ez.zone];
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
      const zone = rectZone(position.x, position.y,
        { x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) });
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
    const hit = hitHandle(sel.region, position.x, position.y, this.toScreen, EDIT_TOL_PX, { bezier });
    if (!hit || hit.kind === 'corner') return null;
    return { kind: hit.kind, ring: hit.ring, index: hit.index, side: hit.kind === 'bezier' ? hit.side : 'out' };
  }

  /** The edge of `region`'s polygon nearest the cursor (within tolerance), with
   *  the clicked point in image coords as the insertion position, or null. */
  private hitEdge(position: { x: number; y: number }, region: Region):
    { ring: number; segIndex: number; x: number; y: number } | null {
    const edge = nearestEdge(region, position.x, position.y, this.toScreen);
    if (!edge || edge.dist > EDIT_TOL_PX) return null;
    const img = this.toImage(position);
    return { ring: edge.ring, segIndex: edge.segIndex, x: img.x, y: img.y };
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
      const box = resizeRect({ x: o.x, y: o.y, width: o.w, height: o.h }, this.edit.zone, dx, dy);
      this.store.updateBounds(this.edit.id, Object.assign(new Rectangle(), box));
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
    region.bounds = makePolygon(this.polyPoints.map(p => p.x), this.polyPoints.map(p => p.y), { closed });
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
