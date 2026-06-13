import { OsdRegionOverlay } from './osd-region-overlay';
import { RegionStore } from '../../region-store.service';
import { VisualizerStore } from '../../visualizer-store.service';
import { Region, Rectangle, Polygon } from '../../models/region';

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
});
