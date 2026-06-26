import { NapariRegionOverlay } from './napari-region-overlay';
import { RegionStore } from '../../store/region-store.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { Region, Rectangle, Polygon } from '../../models/region';

/**
 * Tests for the napari-js SVG region overlay (jit-ui#102), mirroring
 * {@link OsdRegionOverlay}'s spec but driving the overlay through the real
 * pointer/dblclick listeners it attaches to its `<svg>`.
 *
 * The fake napari Viewer uses an *identity* transform: image coords == client
 * coords == SVG-local px (the svg's getBoundingClientRect is the jsdom default
 * {left:0, top:0}), so a press at client (5,5) is image pixel (5,5). The camera's
 * `changed.connect` records the listener and returns a disconnect fn so teardown
 * can be asserted. `setControlsEnabled` is tracked.
 *
 * jsdom lacks PointerEvent and Element.setPointerCapture/releasePointerCapture;
 * we stub the capture methods on SVGElement.prototype and dispatch pointer
 * gestures as MouseEvents typed `pointerdown`/`pointermove`/`pointerup` (jsdom
 * routes events by type string), carrying a `pointerId`.
 */

beforeAll(() => {
  // The overlay calls svg.setPointerCapture(...) unguarded; jsdom has neither.
  (SVGElement.prototype as any).setPointerCapture = function () {
    /* noop */
  };
  (SVGElement.prototype as any).releasePointerCapture = function () {
    /* noop */
  };
});

interface FakeViewer {
  canvasToWorld: (clientX: number, clientY: number) => [number, number];
  worldToCanvas: (worldX: number, worldY: number) => [number, number];
  setControlsEnabled: (enabled: boolean) => void;
  camera: { changed: { connect(listener: () => void): () => void } };
  cameraListeners: Array<() => void>;
  controlsEnabledLog: boolean[];
}

function fakeViewer(): FakeViewer {
  const cameraListeners: Array<() => void> = [];
  const controlsEnabledLog: boolean[] = [];
  return {
    canvasToWorld: (clientX: number, clientY: number) => [clientX, clientY],
    worldToCanvas: (worldX: number, worldY: number) => [worldX, worldY],
    setControlsEnabled: (enabled: boolean) => {
      controlsEnabledLog.push(enabled);
    },
    camera: {
      changed: {
        connect(listener: () => void) {
          cameraListeners.push(listener);
          return () => {
            const i = cameraListeners.indexOf(listener);
            if (i >= 0) cameraListeners.splice(i, 1);
          };
        },
      },
    },
    cameraListeners,
    controlsEnabledLog,
  };
}

function svgOf(overlay: NapariRegionOverlay): SVGSVGElement {
  return (overlay as any).svg as SVGSVGElement;
}

/** Dispatch a typed pointer gesture event on the overlay's svg. */
function ptr(
  overlay: NapariRegionOverlay,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  (ev as any).pointerId = 1;
  svgOf(overlay).dispatchEvent(ev);
}

function dbl(overlay: NapariRegionOverlay, x: number, y: number): void {
  const ev = new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true, cancelable: true });
  svgOf(overlay).dispatchEvent(ev);
}

function triRegion(): Region {
  const r = new Region();
  const p = new Polygon();
  p.npoints = 3;
  p.xpoints = [0, 10, 5];
  p.ypoints = [0, 0, 10];
  p.coordinates = [[0, 0], [10, 0], [5, 10]];
  p.closed = true;
  r.bounds = p;
  return r;
}

function rectRegion(): Region {
  const r = new Region();
  const rect = new Rectangle();
  rect.x = 0;
  rect.y = 0;
  rect.width = 10;
  rect.height = 10;
  r.bounds = rect;
  return r;
}

function rectRegionAt(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const rect = new Rectangle();
  rect.x = x;
  rect.y = y;
  rect.width = w;
  rect.height = h;
  r.bounds = rect;
  return r;
}

/** A 0–20 square exterior with a 7–13 square hole — a donut. */
function donutRegion(): Region {
  const r = new Region();
  const p = new Polygon();
  p.xpoints = [0, 20, 20, 0];
  p.ypoints = [0, 0, 20, 20];
  p.npoints = 4;
  p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]);
  p.closed = true;
  p.holes = [[[7, 7], [13, 7], [13, 13], [7, 13]]];
  r.bounds = p;
  return r;
}

describe('NapariRegionOverlay', () => {
  let store: RegionStore;
  let viewer: FakeViewer;
  let overlay: NapariRegionOverlay;
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    store = new RegionStore(new VisualizerStore());
    viewer = fakeViewer();
    overlay = new NapariRegionOverlay(host, viewer as any, store);
  });

  afterEach(() => {
    overlay.destroy();
    host.remove();
  });

  // ── construction / lifecycle ──────────────────────────────────────────

  it('mounts an svg into the host and wires the camera + store', () => {
    expect(svgOf(overlay).parentNode).toBe(host);
    expect(viewer.cameraListeners).toHaveLength(1);
  });

  it('promotes a statically-positioned host to relative so the svg can anchor', () => {
    const staticHost = document.createElement('div');
    staticHost.style.position = 'static';
    document.body.appendChild(staticHost);
    const o = new NapariRegionOverlay(staticHost, viewer as any, store);
    expect(staticHost.style.position).toBe('relative');
    o.destroy();
    staticHost.remove();
  });

  it('setMode toggles control gating and svg pointer-events', () => {
    overlay.setMode('drawrect');
    expect(viewer.controlsEnabledLog.at(-1)).toBe(false); // disabled while drawing
    expect(svgOf(overlay).style.pointerEvents).toBe('auto');
    overlay.setMode('none');
    expect(viewer.controlsEnabledLog.at(-1)).toBe(true); // handed back for pan/zoom
    expect(svgOf(overlay).style.pointerEvents).toBe('none');
  });

  it('camera change triggers a redraw without throwing', () => {
    store.addRegion(rectRegion());
    expect(() => viewer.cameraListeners[0]()).not.toThrow();
    expect(svgOf(overlay).querySelector('rect')).toBeTruthy();
  });

  // ── drawing ───────────────────────────────────────────────────────────

  it('drawrect: press-drag-release commits a rectangle to the store', () => {
    overlay.setMode('drawrect');
    ptr(overlay, 'pointerdown', 2, 3);
    ptr(overlay, 'pointermove', 12, 13);
    ptr(overlay, 'pointerup', 12, 13);
    const regions = store.getRegions();
    expect(regions).toHaveLength(1);
    const b = regions[0].bounds as Rectangle;
    expect(b.x).toBe(2);
    expect(b.y).toBe(3);
    expect(b.width).toBe(10);
    expect(b.height).toBe(10);
  });

  it('drawrect: a degenerate (sub-2px) drag commits nothing', () => {
    overlay.setMode('drawrect');
    ptr(overlay, 'pointerdown', 5, 5);
    ptr(overlay, 'pointermove', 6, 6);
    ptr(overlay, 'pointerup', 6, 6);
    expect(store.getRegions()).toHaveLength(0);
  });

  it('drawclosedpath: freehand drag commits a closed polygon', () => {
    overlay.setMode('drawclosedpath');
    ptr(overlay, 'pointerdown', 0, 0);
    ptr(overlay, 'pointermove', 10, 0);
    ptr(overlay, 'pointermove', 10, 10);
    ptr(overlay, 'pointermove', 0, 10);
    ptr(overlay, 'pointerup', 0, 10);
    const regions = store.getRegions();
    expect(regions).toHaveLength(1);
    const p = regions[0].bounds as Polygon;
    expect(p.closed).toBe(true);
    expect(p.npoints).toBeGreaterThanOrEqual(3);
  });

  it('drawopenpath: freehand drag commits an open polyline', () => {
    overlay.setMode('drawopenpath');
    ptr(overlay, 'pointerdown', 0, 0);
    ptr(overlay, 'pointermove', 20, 20);
    ptr(overlay, 'pointerup', 20, 20);
    const p = store.getRegions()[0].bounds as Polygon;
    expect(p.closed).toBe(false);
  });

  it('drawpolygon: clicks place vertices, clicking near the first closes it', () => {
    overlay.setMode('drawpolygon');
    ptr(overlay, 'pointerdown', 0, 0); // start
    ptr(overlay, 'pointerdown', 20, 0); // v2
    ptr(overlay, 'pointerdown', 10, 20); // v3
    ptr(overlay, 'pointerdown', 1, 1); // within CLOSE_SNAP_PX of first → close
    const regions = store.getRegions();
    expect(regions).toHaveLength(1);
    const p = regions[0].bounds as Polygon;
    expect(p.closed).toBe(true);
    expect(p.xpoints).toEqual([0, 20, 10]);
  });

  it('drawpolygon: a double-click finishes an open chain of vertices', () => {
    overlay.setMode('drawpolygon');
    ptr(overlay, 'pointerdown', 0, 0);
    ptr(overlay, 'pointerdown', 30, 0);
    ptr(overlay, 'pointerdown', 15, 30);
    dbl(overlay, 15, 30);
    const regions = store.getRegions();
    expect(regions).toHaveLength(1);
    expect((regions[0].bounds as Polygon).npoints).toBe(3);
  });

  // ── select / move ──────────────────────────────────────────────────────

  it('select: clicking a region body selects it', () => {
    store.addRegion(rectRegionAt(0, 0, 10, 10)); // index 0
    store.addRegion(rectRegionAt(100, 100, 10, 10)); // index 1 (selected by add)
    overlay.setMode('select');
    ptr(overlay, 'pointerdown', 5, 5); // inside region 0
    ptr(overlay, 'pointerup', 5, 5);
    expect(store.getSelectedShapeIndices()).toEqual([0]);
  });

  it('move: dragging the body translates the whole region', () => {
    // A large rect so the press point sits clear of every corner handle.
    const id = store.addRegion(rectRegionAt(0, 0, 100, 100));
    overlay.setMode('move');
    ptr(overlay, 'pointerdown', 50, 50); // well inside the rect, far from corners
    ptr(overlay, 'pointermove', 53, 54); // delta (3,4)
    ptr(overlay, 'pointerup', 53, 54);
    const b = store.getRegions().find((r) => r.id === id)!.bounds as Rectangle;
    expect(b.x).toBe(3);
    expect(b.y).toBe(4);
  });

  it('move: clicking empty space clears the selection', () => {
    store.addRegion(rectRegion()); // selected
    overlay.setMode('move');
    ptr(overlay, 'pointerdown', 500, 500); // empty
    ptr(overlay, 'pointerup', 500, 500);
    expect(store.getSelectedShapeIndices()).toEqual([]);
  });

  it('select: dragging a polygon vertex moves just that vertex', () => {
    const id = store.addRegion(triRegion()); // selected; vertex 0 at (0,0)
    overlay.setMode('select');
    ptr(overlay, 'pointerdown', 0, 0); // grab vertex 0
    ptr(overlay, 'pointermove', 3, 4);
    ptr(overlay, 'pointerup', 3, 4);
    const p = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    expect(p.xpoints[0]).toBe(3);
    expect(p.ypoints[0]).toBe(4);
    expect(p.xpoints[1]).toBe(10); // sibling untouched
  });

  it('select: dragging a rectangle corner resizes it from the opposite anchor', () => {
    const id = store.addRegion(rectRegionAt(0, 0, 10, 10)); // selected
    overlay.setMode('select');
    ptr(overlay, 'pointerdown', 10, 10); // grab bottom-right corner (anchor 0,0)
    ptr(overlay, 'pointermove', 20, 30);
    ptr(overlay, 'pointerup', 20, 30);
    const b = store.getRegions().find((r) => r.id === id)!.bounds as Rectangle;
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.width).toBe(20);
    expect(b.height).toBe(30);
  });

  it('edit gestures coalesce into a single store emit on release', () => {
    const id = store.addRegion(triRegion());
    overlay.setMode('select');
    let emits = 0;
    store.getRegionUpdateEvent().subscribe(() => emits++);
    ptr(overlay, 'pointerdown', 0, 0);
    ptr(overlay, 'pointermove', 1, 1);
    ptr(overlay, 'pointermove', 2, 2);
    ptr(overlay, 'pointermove', 3, 3);
    expect(emits).toBe(0); // batched while dragging
    ptr(overlay, 'pointerup', 3, 3);
    expect(emits).toBe(1); // one emit on release
    const p = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    expect(p.xpoints[0]).toBe(3);
  });

  // ── vertex add / delete ────────────────────────────────────────────────

  it('addpoint: clicking an edge inserts a vertex after that segment', () => {
    const id = store.addRegion(triRegion());
    overlay.setMode('addpoint');
    ptr(overlay, 'pointerdown', 5, 0); // midpoint of edge 0
    ptr(overlay, 'pointerup', 5, 0);
    const p = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    expect(p.npoints).toBe(4);
    expect(p.xpoints).toEqual([0, 5, 10, 5]);
  });

  it('deletepoint: clicking a vertex removes it', () => {
    const r = triRegion();
    (r.bounds as Polygon).xpoints = [0, 10, 10, 0];
    (r.bounds as Polygon).ypoints = [0, 0, 10, 10];
    (r.bounds as Polygon).npoints = 4;
    const id = store.addRegion(r);
    overlay.setMode('deletepoint');
    ptr(overlay, 'pointerdown', 10, 0); // vertex 1
    ptr(overlay, 'pointerup', 10, 0);
    const p = store.getRegions().find((r2) => r2.id === id)!.bounds as Polygon;
    expect(p.xpoints.length).toBe(3);
    expect(p.xpoints).toEqual([0, 10, 0]);
  });

  // ── marquee ──────────────────────────────────────────────────────────

  it('select: a rubber-band marquee selects every region it intersects', () => {
    store.addRegion(rectRegionAt(0, 0, 10, 10)); // index 0
    store.addRegion(rectRegionAt(100, 100, 10, 10)); // index 1 (selected)
    overlay.setMode('select');
    ptr(overlay, 'pointerdown', 50, 50); // press empty space
    ptr(overlay, 'pointermove', 30, 30); // a band over region 0 (its 0..10 box)
    ptr(overlay, 'pointermove', -1, -1);
    ptr(overlay, 'pointerup', -1, -1);
    expect(store.getSelectedShapeIndices()).toEqual([0]);
  });

  it('select: a tiny marquee (a click on empty space) clears the selection', () => {
    store.addRegion(rectRegion()); // selected
    overlay.setMode('select');
    ptr(overlay, 'pointerdown', 500, 500); // empty
    ptr(overlay, 'pointermove', 501, 501); // barely moved → treated as a click
    ptr(overlay, 'pointerup', 501, 501);
    expect(store.getSelectedShapeIndices()).toEqual([]);
  });

  // ── bezier ─────────────────────────────────────────────────────────────

  it('setSelectedBezier toggles the bezier flag on the selected region', () => {
    const id = store.addRegion(triRegion());
    overlay.setSelectedBezier(true);
    expect((store.getRegions().find((r) => r.id === id)!.bounds as Polygon).bezier).toBe(true);
    overlay.setSelectedBezier(false);
    expect((store.getRegions().find((r) => r.id === id)!.bounds as Polygon).bezier).toBe(false);
  });

  it('renders a bezier region as a single <path> with editable control handles', () => {
    store.addRegion(triRegion()); // selected
    overlay.setSelectedBezier(true); // seeds handles
    overlay.setMode('select'); // draws handles
    const svg = svgOf(overlay);
    expect(svg.querySelector('path')).toBeTruthy(); // bezier exterior is a path
    // anchor handles (rects) + bezier control dots (circles) + tangent lines.
    expect(svg.querySelectorAll('circle').length).toBeGreaterThanOrEqual(1);
    expect(svg.querySelectorAll('line').length).toBeGreaterThanOrEqual(1);
  });

  it('lets a bezier control handle be dragged', () => {
    const id = store.addRegion(triRegion()); // anchor 0 at (0,0)
    overlay.setSelectedBezier(true);
    overlay.setMode('select');
    const poly = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    const out = poly.handlesOut![0];
    const absX = poly.xpoints[0] + out[0];
    const absY = poly.ypoints[0] + out[1];
    ptr(overlay, 'pointerdown', absX, absY); // grab vertex 0's out-handle
    ptr(overlay, 'pointermove', 20, 5);
    ptr(overlay, 'pointerup', 20, 5);
    const after = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    expect(after.handlesOut![0]).toEqual([20, 5]); // offset = handle - anchor(0,0)
  });

  // ── holes / donuts ───────────────────────────────────────────────────

  it('renders a donut as one even-odd <path>', () => {
    store.addRegion(donutRegion());
    const path = svgOf(overlay).querySelector('path');
    expect(path).toBeTruthy();
    expect(path!.getAttribute('fill-rule')).toBe('evenodd');
  });

  it('shows hole vertex handles (not just the exterior) when a donut is selected', () => {
    store.addRegion(donutRegion()); // selected
    overlay.setMode('select');
    // 4 exterior + 4 hole vertex handles = 8 rect markers.
    const handles = Array.from(svgOf(overlay).querySelectorAll('rect')).filter(
      (el) => el.getAttribute('fill') === '#fff',
    );
    expect(handles.length).toBe(8);
  });

  it('select: dragging a hole vertex moves just that vertex', () => {
    const id = store.addRegion(donutRegion()); // hole [[7,7],...]
    overlay.setMode('select');
    ptr(overlay, 'pointerdown', 7, 7); // grab hole vertex 0
    ptr(overlay, 'pointermove', 9, 8);
    ptr(overlay, 'pointerup', 9, 8);
    const p = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    expect(p.holes![0][0]).toEqual([9, 8]);
    expect(p.holes![0][1]).toEqual([13, 7]); // sibling untouched
    expect(p.xpoints).toEqual([0, 20, 20, 0]); // exterior untouched
  });

  it('select: dragging a donut hole bezier handle moves it', () => {
    const id = store.addRegion(donutRegion());
    overlay.setSelectedBezier(true); // seeds exterior + hole handles
    overlay.setMode('select');
    const poly = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    const ring = poly.holes![0];
    const out = poly.holeHandlesOut![0][0];
    const absX = ring[0][0] + out[0];
    const absY = ring[0][1] + out[1];
    ptr(overlay, 'pointerdown', absX, absY); // grab hole vertex 0 out-handle
    ptr(overlay, 'pointermove', 5, 6);
    ptr(overlay, 'pointerup', 5, 6);
    const after = store.getRegions().find((r) => r.id === id)!.bounds as Polygon;
    expect(after.holeHandlesOut![0][0]).toEqual([5 - ring[0][0], 6 - ring[0][1]]);
  });

  // ── labels ─────────────────────────────────────────────────────────────

  it('draws a region label when labels are enabled', () => {
    store.setShowShapeLabel(true);
    const r = rectRegion();
    r.label = 'tumour';
    store.addRegion(r);
    overlay.redraw();
    const text = svgOf(overlay).querySelector('text');
    expect(text).toBeTruthy();
    expect(text!.textContent).toBe('tumour');
  });

  it('omits labels when label display is off', () => {
    store.setShowShapeLabel(false);
    const r = rectRegion();
    r.label = 'tumour';
    store.addRegion(r);
    overlay.redraw();
    expect(svgOf(overlay).querySelector('text')).toBeNull();
  });

  it('skips profile ROIs in render and selection handles', () => {
    const r = rectRegion();
    r.kind = 'profile';
    store.addRegion(r);
    overlay.setMode('select');
    overlay.redraw();
    expect(svgOf(overlay).querySelector('rect')).toBeNull(); // not drawn
  });

  // ── teardown ───────────────────────────────────────────────────────────

  it('destroy removes the svg and disconnects the camera', () => {
    const o = new NapariRegionOverlay(host, viewer as any, store);
    const svg = svgOf(o);
    const before = viewer.cameraListeners.length;
    o.destroy();
    expect(svg.parentNode).toBeNull();
    expect(viewer.cameraListeners.length).toBe(before - 1);
  });

  it('ignores pointer activity while no tool is active', () => {
    overlay.setMode('none');
    ptr(overlay, 'pointerdown', 5, 5);
    ptr(overlay, 'pointerup', 5, 5);
    expect(store.getRegions()).toHaveLength(0);
  });
});
