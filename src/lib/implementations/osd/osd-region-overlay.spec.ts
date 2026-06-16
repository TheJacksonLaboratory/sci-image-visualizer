import { OsdRegionOverlay } from './osd-region-overlay';
import { RegionStore } from '../../store/region-store.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { Region, Rectangle, Polygon, MultiPolygon } from '../../models/region';

/**
 * Mock OpenSeadragon with an *identity* viewport (image coords == element
 * coords) and a MouseTracker that records its handler options so the tests can
 * drive press/drag/release/click directly. The last-created tracker's options
 * are stashed on `global.__trackerOpts`.
 */
jest.mock('openseadragon', () => ({
  __esModule: true,
  MouseTracker: class {
    constructor(opts: any) { (global as any).__trackerOpts = opts; }
    setTracking() { /* noop */ }
    destroy() { /* noop */ }
  },
  Point: class { constructor(public x: number, public y: number) {} },
}));

function fakeViewer() {
  const canvas = document.createElement('div');
  return {
    canvas,
    viewport: {
      imageToViewerElementCoordinates: (p: any) => ({ x: p.x, y: p.y }),
      viewerElementToImageCoordinates: (pos: any) => ({ x: pos.x, y: pos.y }),
    },
    setMouseNavEnabled: () => { /* noop */ },
    addHandler: () => { /* noop */ },
    removeHandler: () => { /* noop */ },
  };
}

/** The captured MouseTracker handlers (press/drag/release/click/move). */
function handlers(): any {
  return (global as any).__trackerOpts;
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
  rect.x = 0; rect.y = 0; rect.width = 10; rect.height = 10;
  r.bounds = rect;
  return r;
}

function rectRegionAt(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const rect = new Rectangle();
  rect.x = x; rect.y = y; rect.width = w; rect.height = h;
  r.bounds = rect;
  return r;
}

describe('OsdRegionOverlay — vertex tools', () => {
  let store: RegionStore;
  let overlay: OsdRegionOverlay;

  beforeEach(() => {
    store = new RegionStore(new VisualizerStore());
    overlay = new OsdRegionOverlay(fakeViewer(), store);
  });

  afterEach(() => overlay.destroy());

  it('drawpolygon: clicks place vertices and clicking the first vertex closes it', () => {
    overlay.setMode('drawpolygon');
    const h = handlers();
    h.clickHandler({ position: { x: 0, y: 0 } });   // start
    h.clickHandler({ position: { x: 10, y: 0 } });  // vertex 2
    h.clickHandler({ position: { x: 5, y: 10 } });  // vertex 3
    h.clickHandler({ position: { x: 0, y: 0 } });   // click first -> close

    const regions = store.getRegions();
    expect(regions.length).toBe(1);
    const poly = regions[0].bounds as Polygon;
    expect(poly.closed).toBe(true);
    expect(poly.xpoints).toEqual([0, 10, 5]);
  });

  it('select: dragging a vertex moves just that vertex', () => {
    const id = store.addRegion(triRegion()); // addRegion selects it
    overlay.setMode('select');
    const h = handlers();
    h.pressHandler({ position: { x: 0, y: 0 } });   // grab vertex 0
    h.dragHandler({ position: { x: 3, y: 4 } });
    h.releaseHandler({ position: { x: 3, y: 4 } });

    const poly = store.getRegions().find(r => r.id === id)!.bounds as Polygon;
    expect(poly.xpoints[0]).toBe(3);
    expect(poly.ypoints[0]).toBe(4);
    expect(poly.xpoints[1]).toBe(10); // others untouched
  });

  it('addpoint: clicking an edge inserts a vertex after that segment', () => {
    const id = store.addRegion(triRegion());
    overlay.setMode('addpoint');
    handlers().clickHandler({ position: { x: 5, y: 0 } }); // midpoint of edge 0

    const poly = store.getRegions().find(r => r.id === id)!.bounds as Polygon;
    expect(poly.xpoints).toEqual([0, 5, 10, 5]);
    expect(poly.npoints).toBe(4);
  });

  it('deletepoint: clicking a vertex removes it', () => {
    const r = triRegion();
    (r.bounds as Polygon).xpoints = [0, 10, 10, 0];
    (r.bounds as Polygon).ypoints = [0, 0, 10, 10];
    (r.bounds as Polygon).npoints = 4;
    const id = store.addRegion(r);
    overlay.setMode('deletepoint');
    handlers().clickHandler({ position: { x: 10, y: 0 } }); // vertex 1

    const poly = store.getRegions().find(r2 => r2.id === id)!.bounds as Polygon;
    expect(poly.xpoints.length).toBe(3);
    expect(poly.xpoints).toEqual([0, 10, 0]);
  });

  it('move: dragging the body translates the whole region', () => {
    const id = store.addRegion(rectRegion());
    overlay.setMode('move');
    const h = handlers();
    h.pressHandler({ position: { x: 5, y: 5 } }); // inside the rect
    h.dragHandler({ position: { x: 8, y: 9 } });  // delta (3, 4)
    h.releaseHandler({ position: { x: 8, y: 9 } });

    const b = store.getRegions().find(r => r.id === id)!.bounds as Rectangle;
    expect(b.x).toBe(3);
    expect(b.y).toBe(4);
    expect(b.width).toBe(10);
    expect(b.height).toBe(10);
  });

  it('draws the selected region\'s vertex handles in its own colour', () => {
    const r = triRegion();
    r.color = '#ff8800';
    store.addRegion(r); // selects it
    overlay.setMode('select'); // vertex-edit mode → handles drawn
    const svg = (overlay as any).svg as SVGSVGElement;
    const markers = Array.from(svg.querySelectorAll('circle'))
      .filter(c => c.getAttribute('stroke') === '#ff8800');
    expect(markers.length).toBeGreaterThanOrEqual(3); // the three anchor handles
  });

  it('shows the selected polygon\'s vertices in none (display) mode too', () => {
    const r = triRegion();
    r.color = '#00bcd4';
    store.addRegion(r);          // selects it
    overlay.setMode('none');     // no tool active — selection should still reveal vertices
    const svg = (overlay as any).svg as SVGSVGElement;
    const markers = Array.from(svg.querySelectorAll('circle'))
      .filter(c => c.getAttribute('stroke') === '#00bcd4');
    expect(markers.length).toBeGreaterThanOrEqual(3);
  });

  it('shows a selected rectangle\'s four corner handles', () => {
    const r = rectRegion();
    r.color = '#00bcd4';
    store.addRegion(r);          // selects it
    overlay.setMode('none');
    const svg = (overlay as any).svg as SVGSVGElement;
    const markers = Array.from(svg.querySelectorAll('circle'))
      .filter(c => c.getAttribute('stroke') === '#00bcd4');
    expect(markers.length).toBe(4);
  });

  it('hides vertices while drawing a brand-new shape', () => {
    const r = triRegion();
    r.color = '#00bcd4';
    store.addRegion(r);
    overlay.setMode('drawrect'); // mid-draw → no stray handles
    const svg = (overlay as any).svg as SVGSVGElement;
    const markers = Array.from(svg.querySelectorAll('circle'))
      .filter(c => c.getAttribute('stroke') === '#00bcd4');
    expect(markers.length).toBe(0);
  });

  it('plain click selects a single region (replacing the selection)', () => {
    store.addRegion(rectRegionAt(0, 0, 10, 10));       // index 0
    store.addRegion(rectRegionAt(100, 100, 10, 10));   // index 1 (selected)
    overlay.setMode('select');
    handlers().clickHandler({ position: { x: 5, y: 5 } }); // click region 0, no modifier
    expect(store.getSelectedShapeIndices()).toEqual([0]);
  });

  it('shift-click adds another region to the selection (multi-select)', () => {
    store.addRegion(rectRegionAt(0, 0, 10, 10));       // index 0
    store.addRegion(rectRegionAt(100, 100, 10, 10));   // index 1 (selected)
    overlay.setMode('select');
    handlers().clickHandler({ position: { x: 5, y: 5 }, originalEvent: { shiftKey: true } });
    expect(store.getSelectedShapeIndices().slice().sort()).toEqual([0, 1]);
  });

  it('shift-click again toggles a region back out of the selection', () => {
    store.addRegion(rectRegionAt(0, 0, 10, 10));       // index 0 (selected)
    overlay.setMode('select');
    const h = handlers();
    h.clickHandler({ position: { x: 105, y: 105 }, originalEvent: { shiftKey: true } }); // empty → no-op
    h.clickHandler({ position: { x: 5, y: 5 }, originalEvent: { shiftKey: true } });     // toggle 0 off
    expect(store.getSelectedShapeIndices()).toEqual([]);
  });

  it('rubber-band drag selects every region it intersects', () => {
    store.addRegion(rectRegionAt(0, 0, 10, 10));       // index 0
    store.addRegion(rectRegionAt(100, 100, 10, 10));   // index 1 (selected)
    overlay.setMode('select');
    const h = handlers();
    h.pressHandler({ position: { x: 50, y: 50 } });    // press empty space
    h.dragHandler({ position: { x: -1, y: -1 } });     // drag a band over region 0 only
    h.releaseHandler({ position: { x: -1, y: -1 } });
    expect(store.getSelectedShapeIndices()).toEqual([0]);
  });

  it('setSelectedBezier toggles the bezier flag on the selected region', () => {
    const id = store.addRegion(triRegion()); // addRegion selects it
    overlay.setSelectedBezier(true);
    expect((store.getRegions().find(r => r.id === id)!.bounds as Polygon).bezier).toBe(true);
    overlay.setSelectedBezier(false);
    expect((store.getRegions().find(r => r.id === id)!.bounds as Polygon).bezier).toBe(false);
  });

  it('lets a bezier control handle be dragged', () => {
    const id = store.addRegion(triRegion()); // anchor 0 is (0,0)
    overlay.setSelectedBezier(true); // seeds smooth handles
    overlay.setMode('select');
    const poly = store.getRegions().find(r => r.id === id)!.bounds as Polygon;
    const outAbs = { x: poly.xpoints[0] + poly.handlesOut![0][0], y: poly.ypoints[0] + poly.handlesOut![0][1] };
    const h = handlers();
    h.pressHandler({ position: outAbs });                 // grab vertex 0's out-handle
    h.dragHandler({ position: { x: 20, y: 5 } });
    h.releaseHandler({ position: { x: 20, y: 5 } });
    const after = store.getRegions().find(r => r.id === id)!.bounds as Polygon;
    expect(after.handlesOut![0]).toEqual([20, 5]);        // offset = handle - anchor(0,0)
  });

  it('edit gestures coalesce into a single store emit on release', () => {
    const id = store.addRegion(triRegion());
    overlay.setMode('select');
    let emits = 0;
    store.getRegionUpdateEvent().subscribe(() => emits++);
    const h = handlers();
    h.pressHandler({ position: { x: 0, y: 0 } });
    h.dragHandler({ position: { x: 1, y: 1 } });
    h.dragHandler({ position: { x: 2, y: 2 } });
    h.dragHandler({ position: { x: 3, y: 3 } });
    expect(emits).toBe(0); // batched while dragging
    h.releaseHandler({ position: { x: 3, y: 3 } });
    expect(emits).toBe(1); // one emit on release

    const poly = store.getRegions().find(r => r.id === id)!.bounds as Polygon;
    expect(poly.xpoints[0]).toBe(3); // last drag position wins
  });

  // ── Holes / donuts (jit-ui#85) ────────────────────────────────────────

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

  it('move mode translates the hole with the exterior (no donut fill)', () => {
    const id = store.addRegion(donutRegion()); // addRegion selects it
    overlay.setMode('move');
    const h = handlers();
    h.pressHandler({ position: { x: 2, y: 2 } });   // press in the solid ring
    h.dragHandler({ position: { x: 102, y: 2 } });  // +100 in x
    h.releaseHandler({ position: { x: 102, y: 2 } });

    const poly = store.getRegions().find(r => r.id === id)!.bounds as Polygon;
    expect(poly.holes?.length).toBe(1);
    expect(poly.holes![0]).toEqual([[107, 7], [113, 7], [113, 13], [107, 13]]);
  });

  /** Two disjoint 10×10 squares: part A at x0–10, part B at x20–30. */
  function multiRegion(): Region {
    const part = (x0: number) => {
      const p = new Polygon();
      p.xpoints = [x0, x0 + 10, x0 + 10, x0];
      p.ypoints = [0, 0, 10, 10];
      p.npoints = 4;
      p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]);
      p.closed = true;
      return p;
    };
    const r = new Region();
    const mp = new MultiPolygon();
    mp.polygons = [part(0), part(20)];
    r.bounds = mp;
    return r;
  }

  it('renders a multi-part region as one even-odd path with a subpath per part', () => {
    const viewer = fakeViewer();
    const o = new OsdRegionOverlay(viewer, store);
    try {
      store.addRegion(multiRegion());
      const paths = (viewer.canvas as HTMLElement).querySelectorAll('path');
      expect(paths.length).toBe(1);
      expect(paths[0].getAttribute('fill-rule')).toBe('evenodd');
      expect((paths[0].getAttribute('d')!.match(/M/g) || []).length).toBe(2); // one per part
    } finally {
      o.destroy();
    }
  });

  it('selects either part of a multi-part region but not the gap between them', () => {
    store.addRegion(multiRegion());
    store.setSelectedShapeIndices([]);
    overlay.setMode('select');
    const h = handlers();
    h.clickHandler({ position: { x: 5, y: 5 } });   // inside part A
    expect(store.getSelectedShapeIndices()).toEqual([0]);
    store.setSelectedShapeIndices([]);
    h.clickHandler({ position: { x: 15, y: 5 } });  // in the gap → nothing
    expect(store.getSelectedShapeIndices()).toEqual([]);
    h.clickHandler({ position: { x: 25, y: 5 } });  // inside part B
    expect(store.getSelectedShapeIndices()).toEqual([0]);
  });

  it('shows the hole vertices (not just the exterior) when a donut is selected', () => {
    const viewer = fakeViewer();
    const o = new OsdRegionOverlay(viewer, store);
    try {
      o.setMode('select');
      store.addRegion(donutRegion()); // addRegion selects it
      // 4 exterior vertices + 4 hole vertices = 8 markers.
      const circles = (viewer.canvas as HTMLElement).querySelectorAll('circle');
      expect(circles.length).toBe(8);
    } finally {
      o.destroy();
    }
  });

  it('select: dragging a hole vertex moves just that vertex', () => {
    const id = store.addRegion(donutRegion()); // hole [[7,7],[13,7],[13,13],[7,13]]
    overlay.setMode('select');
    const h = handlers();
    h.pressHandler({ position: { x: 7, y: 7 } });   // grab hole vertex 0
    h.dragHandler({ position: { x: 9, y: 8 } });
    h.releaseHandler({ position: { x: 9, y: 8 } });

    const poly = store.getRegions().find(r => r.id === id)!.bounds as Polygon;
    expect(poly.holes![0][0]).toEqual([9, 8]);
    expect(poly.holes![0][1]).toEqual([13, 7]);     // sibling hole vertex untouched
    expect(poly.xpoints).toEqual([0, 20, 20, 0]);   // exterior untouched
  });

  it('addpoint: clicking a hole edge inserts a vertex on that ring', () => {
    const id = store.addRegion(donutRegion()); // hole [[7,7],[13,7],[13,13],[7,13]]
    overlay.setMode('addpoint');
    handlers().clickHandler({ position: { x: 10, y: 7 } }); // midpoint of hole edge 0

    const ring = (store.getRegions().find(r => r.id === id)!.bounds as Polygon).holes![0];
    expect(ring.length).toBe(5);
    expect(ring[1]).toEqual([10, 7]);
    // Exterior unchanged.
    expect((store.getRegions().find(r => r.id === id)!.bounds as Polygon).xpoints.length).toBe(4);
  });

  it('deletepoint: clicking a hole vertex removes it from that ring', () => {
    const r = donutRegion();
    (r.bounds as Polygon).holes = [[[7, 7], [13, 7], [13, 13], [7, 13], [9, 9]]]; // 5-vertex hole
    const id = store.addRegion(r);
    overlay.setMode('deletepoint');
    handlers().clickHandler({ position: { x: 7, y: 7 } }); // hole vertex 0

    const ring = (store.getRegions().find(r2 => r2.id === id)!.bounds as Polygon).holes![0];
    expect(ring.length).toBe(4);
    expect(ring[0]).toEqual([13, 7]);
  });

  it('clicking inside the hole does not select the donut; the solid ring does', () => {
    store.addRegion(donutRegion());
    store.setSelectedShapeIndices([]); // start unselected
    overlay.setMode('select');
    const h = handlers();
    h.clickHandler({ position: { x: 10, y: 10 } }); // dead centre = in the hole
    expect(store.getSelectedShapeIndices()).toEqual([]);
    h.clickHandler({ position: { x: 2, y: 2 } });   // solid ring
    expect(store.getSelectedShapeIndices()).toEqual([0]);
  });
});
