import { Subscription } from 'rxjs';

import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';
import { Region, Rectangle, Polygon } from '../../models/region';
import { RegionStore } from '../../store/region-store.service';

import {
  hitHandle, nearestEdge, nearestVertex, regionContains, regionsInRect,
} from '../../region-overlay/region-geometry';

import { DragBox, NapariRegionSvgRenderer } from './region-overlay/region-svg-renderer';
import { OverlayProjection } from './region-overlay/overlay-projection';
import { RegionEdit, applyRegionEdit } from './region-overlay/region-edit';

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * Min drag before a freehand path records another point, in SCREEN pixels.
 *
 * Screen rather than world, which is what "2 image px" always meant in practice: at 100%
 * zoom over an image the two are the same thing. Taken as world units it breaks on any
 * dataset whose world is small — seqFISH's sample spans about 5 units, so a 2-unit
 * threshold records a point every 40% of the way across and a freehand ROI comes out as a
 * triangle. Against the screen it also does the right thing under zoom: drawing zoomed in
 * records a finer path, because that is exactly when the extra detail is visible.
 */
const FREEHAND_STEP_PX = 2;
/**
 * Smallest committed rectangle, in SCREEN pixels on each side.
 *
 * Its job is to throw away a click that was not a drag. Held in world units — which it was
 * — it instead throws away real drags on any dataset whose world is small: in seqFISH's
 * ~5 x 7 unit sample a rectangle had to cover 40% of the width to commit at all, and
 * anything smaller vanished with no feedback. That was the direct cause of ROIs being
 * impossible to create there.
 */
const MIN_RECT_DRAG_PX = 2;
/**
 * A rubber band smaller than this on both sides, in SCREEN pixels, is a click on empty space
 * (it clears the selection). Screen for the same reason as {@link MIN_RECT_DRAG_PX}: 3 world
 * units is over half of seqFISH's sample.
 */
const MIN_MARQUEE_PX = 3;
/** Click-distance (screen px) within which a polygon click snaps closed onto the first vertex. */
const CLOSE_SNAP_PX = 10;
/** Screen-px hit radius for grabbing a vertex / rectangle corner handle. */
const HANDLE_HIT_PX = 9;
/** Screen-px distance from an open polyline within which a click selects it (as OSD). */
const OPEN_PATH_HIT_PX = 6;

/**
 * The slice of the napari Viewer the overlay needs (coord transforms + control gating).
 *
 * COORDINATE SPACES: both transforms speak CLIENT pixels (viewport coordinates, as a pointer
 * event's `clientX/Y`), exactly as napari-js `Viewer.canvasToWorld`/`worldToCanvas` do. The
 * overlay subtracts its svg's client rect itself to get svg-local pixels. An implementation
 * that returned canvas-local pixels from `worldToCanvas` would draw everything offset by the
 * host's page position whenever the host is not at the page origin.
 *
 * Exported because the 3D spatial mode supplies a SCREEN-SPACE implementation of it: there the
 * drawn shape is a lasso in canvas pixels, not a rectangle in image space, so "world" is the
 * canvas itself and both transforms are the client↔canvas offset. That lets the 3D view reuse
 * this whole overlay — every tool, the handles, the store round-trip — with no 3D-specific
 * drawing code.
 */
export interface OverlayViewer {
  /** Client px → world. */
  canvasToWorld(clientX: number, clientY: number): [number, number];
  /** World → client px (NOT canvas-local px). */
  worldToCanvas(worldX: number, worldY: number): [number, number];
  setControlsEnabled(enabled: boolean): void;
  readonly camera: { readonly changed: { connect(listener: () => void): () => void } };
}

/**
 * SVG region overlay for the napari-js WebGPU image view (jit-ui#102), mirroring the OSD backend's
 * {@link OsdRegionOverlay} but driven by napari's `canvasToWorld`/`worldToCanvas` transforms
 * (see {@link OverlayViewer} for their coordinate spaces).
 * Vector shapes are drawn in an absolutely-positioned `<svg>` over the canvas (no need to push
 * them through WebGPU) by {@link NapariRegionSvgRenderer} over the shared `SvgRegionRenderer`:
 * in world coordinates inside one transformed group, rebuilt on a region or selection change,
 * while a camera move only rewrites the transform (derived from `worldToCanvas`, i.e.
 * napari-js's camera centre/zoom) and the few screen-space handles and labels. This class is
 * the gesture controller: pointer handlers, the tool mode, and the edit/draft/marquee state.
 * It writes completed shapes to the shared {@link RegionStore} (so save / undo / export work
 * identically to OSD).
 *
 * Supports (jit-ui#102): rectangle / polygon / freehand path drawing, click-select and rubber-band
 * marquee select, pan/zoom gating via `setControlsEnabled`, body move, vertex move/add/delete,
 * bezier handle editing, and donut holes (including hole vertex + hole-bezier-handle editing).
 * Hit-testing shares `region-overlay/region-geometry` with the OSD overlay, so both follow
 * the same rules (multi-part regions, holes, open polylines, handle-less bezier curves).
 */
export class NapariRegionOverlay implements IRegionOverlay {
  private readonly svg: SVGSVGElement;
  private readonly renderer: NapariRegionSvgRenderer;
  /** Client ↔ svg-local ↔ world conversions, with the svg origin read once per gesture/redraw. */
  private readonly projection: OverlayProjection;
  private readonly subs = new Subscription();
  private readonly disconnectCamera: () => void;

  private mode: RegionToolMode = 'none';
  private selected: number[] = [];

  /** In-progress drawing state (image-space). */
  private draftRect: DragBox | null = null;
  /** In-progress rubber-band selection marquee (select mode), image-space. */
  private marquee: DragBox | null = null;
  private draftPath: Array<[number, number]> | null = null; // freehand or click polygon
  private drawing = false; // pointer is down for rect / freehand
  private regionsVisible = true;

  /** In-progress manipulation (select/move modes): dragging a body, a polygon vertex, or a
   *  rectangle corner. `anchor` is the fixed opposite corner for a rectangle resize. */
  private edit: RegionEdit | null = null;

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
    this.renderer = new NapariRegionSvgRenderer(this.svg, this.store);
    this.projection = new OverlayProjection(this.svg, this.viewer);

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerCancel);
    this.svg.addEventListener('lostpointercapture', this.onPointerCancel);
    this.svg.addEventListener('dblclick', this.onDblClick);

    this.subs.add(this.store.getRegionUpdateEvent().subscribe(() => this.redraw()));
    this.subs.add(
      this.store.getSelectedShapeIndices$().subscribe((idx) => {
        this.selected = idx ?? [];
        this.redraw();
      }),
    );
    // A camera move rewrites the renderer's transform and its few screen-space elements;
    // the regions are drawn in world coordinates and are not rebuilt (NAPARI-BOUNDARY-10).
    this.disconnectCamera = this.viewer.camera.changed.connect(() => this.updateCamera());
    this.redraw();
  }

  // ── IRegionOverlay ────────────────────────────────────────────────────────
  /**
   * Whether a region tool currently owns the pointer.
   *
   * Exposed so the spatial views can tell a bare click on the cloud (select the
   * class under the cursor) from a click that belongs to a drawing gesture —
   * placing a polygon vertex is also a click that does not move, and it must not
   * change the selection behind the shape being drawn.
   */
  get toolActive(): boolean {
    return this.mode !== 'none';
  }

  setMode(mode: RegionToolMode): void {
    this.endGesture();
    this.mode = mode;
    this.draftRect = null;
    this.draftPath = null;
    // The overlay owns pointer/navigation gating: while a tool is active it captures the pointer
    // and the napari camera controls are disabled; 'none' hands the pointer back for pan/zoom.
    const active = mode !== 'none';
    this.viewer.setControlsEnabled(!active);
    this.svg.style.pointerEvents = active ? 'auto' : 'none';
    this.svg.style.cursor = active ? 'crosshair' : 'default';
    this.renderOverlay();
  }

  setSelectedBezier(bezier: boolean): void {
    const sel = this.selectedRegion();
    if (sel?.id != null) this.store.setBezier(sel.id, bezier);
  }

  /**
   * How finely a drawn vertex may be placed, in world units: one (an image's pixels) by
   * default, finer for a dataset whose coordinates are not pixels (see OverlayProjection).
   */
  setWorldQuantum(quantum: number): void {
    this.projection.setWorldQuantum(quantum);
  }

  destroy(): void {
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    this.svg.removeEventListener('pointermove', this.onPointerMove);
    this.svg.removeEventListener('pointerup', this.onPointerUp);
    this.svg.removeEventListener('pointercancel', this.onPointerCancel);
    this.svg.removeEventListener('lostpointercapture', this.onPointerCancel);
    this.svg.removeEventListener('dblclick', this.onDblClick);
    this.disconnectCamera();
    this.subs.unsubscribe();
    // A drag torn down mid-gesture (a backend switch) must still close its store batch.
    this.endGesture();
    if (this.svg.parentNode) this.svg.parentNode.removeChild(this.svg);
  }

  // ── pointer handlers ──────────────────────────────────────────────────────
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.mode === 'none') return;
    e.preventDefault();
    this.projection.withOrigin(() => this.pointerDown(e));
  };

  private pointerDown(e: PointerEvent): void {
    const [ix, iy] = this.projection.toImage(e.clientX, e.clientY);
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
      this.handleAddPoint(ix, iy, e.clientX, e.clientY);
    } else if (this.mode === 'deletepoint') {
      this.handleDeletePoint(ix, iy);
    }
    this.redraw();
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const [ix, iy] = this.projection.toImage(e.clientX, e.clientY);
    if (this.marquee) {
      this.marquee.x1 = ix;
      this.marquee.y1 = iy;
      this.updateMarqueeEl(); // update just the marquee rect — NOT a full region redraw
      return;
    }
    if (this.edit) {
      applyRegionEdit(this.store, this.edit, ix, iy);
      this.redraw();
      return;
    }
    if (!this.drawing) return;
    if (this.draftRect) {
      this.draftRect.x1 = ix;
      this.draftRect.y1 = iy;
    } else if (this.draftPath) {
      const step = FREEHAND_STEP_PX * this.projection.worldPerCanvasPixel();
      const last = this.draftPath[this.draftPath.length - 1];
      if (Math.abs(ix - last[0]) >= step || Math.abs(iy - last[1]) >= step) {
        this.draftPath.push([ix, iy]);
      }
    }
    this.renderOverlay();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.marquee) {
      const m = this.marquee;
      this.marquee = null;
      this.renderer.clearMarquee();
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
      const min = MIN_RECT_DRAG_PX * this.projection.worldPerCanvasPixel();
      if (w >= min && h >= min) this.commitRectangle(x, y, w, h);
    } else if (this.draftPath) {
      const pts = this.draftPath;
      this.draftPath = null;
      const closed = this.mode === 'drawclosedpath';
      if (pts.length >= (closed ? 3 : 2)) this.commitPolygon(pts, closed);
    }
    this.redraw();
  };

  /**
   * The pointer gesture ended without a pointerup (the browser cancelled it, or capture was
   * lost): end it without committing. Also fires after every normal release, when nothing
   * is live any more.
   */
  private readonly onPointerCancel = (): void => {
    if (!this.edit && !this.drawing && !this.marquee) return;
    this.endGesture();
    this.redraw();
  };

  /**
   * End whatever pointer gesture is live without committing it: close the store batch a drag
   * opened (so later edits are emitted again) and forget the drag (so a bare hover no longer
   * moves the region), and drop the marquee and a rectangle/freehand draft. A click-placed
   * polygon is not a pointer gesture and survives.
   */
  private endGesture(): void {
    if (this.edit) this.store.endBatch();
    this.edit = null;
    if (this.drawing) {
      this.draftRect = null;
      this.draftPath = null;
    }
    this.drawing = false;
    this.marquee = null;
    this.renderer.clearMarquee();
  }

  /** Click-to-place polygon: add a vertex, or close when clicking near the first one. */
  private handlePolygonClick(ix: number, iy: number, clientX: number, clientY: number): void {
    if (!this.draftPath) {
      this.draftPath = [[ix, iy]];
      return;
    }
    const near =
      this.projection.screenDist(clientX, clientY, this.draftPath[0][0], this.draftPath[0][1]) <= CLOSE_SNAP_PX &&
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

  /**
   * Start a select/move interaction: grab a handle (rectangle corner) or vertex of the already-
   * selected region first; otherwise select the topmost region under the cursor and drag its body.
   */
  private beginManipulation(ix: number, iy: number, e: PointerEvent): void {
    const sel = this.selectedRegion();
    if (sel?.bounds) {
      const [lx, ly] = this.projection.clientToLocal(e.clientX, e.clientY);
      const grab = hitHandle(sel, lx, ly, this.projection.toScreen, HANDLE_HIT_PX);
      if (grab) {
        this.store.beginBatch();
        this.edit = { ...grab, id: sel.id, last: [ix, iy] };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
    }
    // Hit-test bodies, topmost first (last drawn renders on top), at the exact pointer
    // position — snapping is for placing vertices, not for picking.
    const regions = this.store.getRegions();
    const [wx, wy] = this.projection.toWorld(e.clientX, e.clientY);
    for (let i = regions.length - 1; i >= 0; i--) {
      if (regionContains(regions[i], wx, wy, { toScreen: this.projection.toScreen, tolPx: OPEN_PATH_HIT_PX })) {
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

  /** Show the marquee where it is now (only the marquee element: no full region redraw). */
  private updateMarqueeEl(): void {
    if (!this.marquee) return;
    const { x0, y0, x1, y1 } = this.marquee;
    const [[lx, ly], [rx, ry]] = this.projection.withOrigin(() => [
      this.projection.toLocal(Math.min(x0, x1), Math.min(y0, y1)),
      this.projection.toLocal(Math.max(x0, x1), Math.max(y0, y1)),
    ]);
    this.renderer.showMarquee(lx, ly, rx, ry);
  }

  /** addpoint mode: insert a vertex at the click on the selected polygon's nearest edge
   *  (exterior or a hole ring). */
  private handleAddPoint(ix: number, iy: number, clientX: number, clientY: number): void {
    const sel = this.selectedRegion();
    if (!sel) return;
    const [lx, ly] = this.projection.clientToLocal(clientX, clientY);
    const edge = nearestEdge(sel, lx, ly, this.projection.toScreen);
    if (!edge) return;
    if (edge.ring < 0) this.store.addVertex(sel.id, edge.segIndex, ix, iy);
    else this.store.addHoleVertex(sel.id, edge.ring, edge.segIndex, ix, iy);
  }

  /** deletepoint mode: remove the selected polygon's vertex nearest the click (exterior or a
   *  hole ring). */
  private handleDeletePoint(ix: number, iy: number): void {
    const sel = this.selectedRegion();
    if (!sel) return;
    const v = nearestVertex(sel, ix, iy);
    if (!v) return;
    if (v.ring < 0) this.store.deleteVertex(sel.id, v.index);
    else this.store.deleteHoleVertex(sel.id, v.ring, v.index);
  }

  /** Finalize a rubber-band marquee: select every region whose bounding box it overlaps (a
   *  marquee under {@link MIN_MARQUEE_PX} is a click on empty space → clear the selection). */
  private finishMarquee(m: DragBox): void {
    const x0 = Math.min(m.x0, m.x1);
    const x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1);
    const y1 = Math.max(m.y0, m.y1);
    const min = MIN_MARQUEE_PX * this.projection.worldPerCanvasPixel();
    if (x1 - x0 < min && y1 - y0 < min) {
      this.store.setSelectedShapeIndices([]);
      return;
    }
    const regions = this.store.getRegions();
    this.store.setSelectedShapeIndices(regionsInRect(regions, x0, y0, x1, y1, { skipProfiles: true }));
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
    region.label = 'Region';
    this.store.addRegion(region);
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  /** Show or hide the drawn regions. A region being drawn stays visible either way. */
  setRegionsVisible(visible: boolean): void {
    if (visible === this.regionsVisible) return;
    this.regionsVisible = visible;
    this.redraw();
  }

  /** Follow a camera move: one transform attribute plus the screen-space elements. */
  private updateCamera(): void {
    this.renderer.setCamera(this.projection.affine());
  }

  /**
   * Rebuild every element from the store: the regions in world coordinates (one transformed
   * group), their labels, and the overlay. The svg's origin is read once.
   */
  redraw(): void {
    this.projection.withOrigin(() => {
      this.renderer.setCamera(this.projection.affine());
      this.renderer.render(this.regionsVisible ? this.store.getRegions() : [], this.selected);
      this.renderOverlay();
    });
  }

  /** Rebuild the screen-space overlay only: the selected regions' handles and the draft. */
  private renderOverlay(): void {
    this.renderer.renderOverlay(
      this.regionsVisible ? this.store.getRegions() : [], this.selected,
      { rect: this.draftRect, path: this.draftPath },
    );
  }
}
