import { VertexEraserToolService } from './vertex-eraser-tool.service';
import { WandService } from '../wand/wand.service';
import { Region, Polygon } from '../../models/region';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';

/**
 * The eraser is decoupled from any backend's shape format: it reads/writes the
 * neutral Region model through its host. These tests mock the host with an
 * identity coordinate transform (client px == image coords) and verify the tool
 * produces Region objects, not Plotly dicts.
 */
function squareRegion(): Region {
  const r = new Region();
  r.id = 1;
  const p = new Polygon();
  p.npoints = 4;
  p.xpoints = [0, 10, 10, 0];
  p.ypoints = [0, 0, 10, 10];
  p.coordinates = [[0, 0], [10, 0], [10, 10], [0, 10]];
  p.closed = true;
  r.bounds = p;
  return r;
}

const identityTransform: ICoordinateTransform = {
  clientToData: (x, y) => ({ x, y }),
  dataLengthToScreen: (l) => l,
  isReady: () => true,
};

describe('VertexEraserToolService (neutral Region)', () => {
  let tool: VertexEraserToolService;
  let regions: Region[];
  let committed: Region[] | null;
  let container: HTMLDivElement;
  let invalidated: number;

  beforeEach(() => {
    tool = new VertexEraserToolService();
    regions = [squareRegion()];
    committed = null;
    invalidated = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    tool.bindHost({
      getOverlayContainer: () => container,
      getCoordinateTransform: () => identityTransform,
      getRegions: () => regions.slice(),
      setRegions: (rs) => { committed = rs; },
      invalidateWandRegion: () => { invalidated++; },
      getCachedImageRatio: () => 1,
    });
    tool.setMode(true);
    tool.setRadius(2);
  });

  afterEach(() => {
    tool.setMode(false);
    container.remove();
  });

  it('removes the clicked vertex and commits neutral Region objects', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 0, button: 0 }));

    expect(committed).not.toBeNull();
    expect(committed!.length).toBe(1);
    const bounds = committed![0].bounds;
    expect(bounds).toBeInstanceOf(Polygon); // neutral model, not a Plotly dict
    expect((bounds as Polygon).xpoints.length).toBe(3); // the (10,0) vertex was dropped
    expect(committed![0].id).toBe(1); // identity preserved
    expect(invalidated).toBe(1); // wand stroke invalidated after the edit
  });

  /** A 0–40 square exterior with a hole ring (defaults to a 10–20 square). */
  function donutRegion(hole: number[][] = [[10, 10], [20, 10], [20, 20], [10, 20]]): Region {
    const r = new Region();
    r.id = 2;
    const p = new Polygon();
    p.xpoints = [0, 40, 40, 0];
    p.ypoints = [0, 0, 40, 40];
    p.npoints = 4;
    p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]);
    p.closed = true;
    p.holes = [hole];
    r.bounds = p;
    return r;
  }

  it('erases a vertex on the inner ring (donut), leaving the exterior intact', () => {
    regions = [donutRegion()];
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 0 }));

    const poly = committed![0].bounds as Polygon;
    expect(poly.xpoints.length).toBe(4);   // exterior untouched
    expect(poly.holes!.length).toBe(1);
    expect(poly.holes![0].length).toBe(3); // one hole vertex removed
  });

  it('keeps the hole when erasing an exterior vertex (no donut fill)', () => {
    regions = [donutRegion()];
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0, button: 0 }));

    const poly = committed![0].bounds as Polygon;
    expect(poly.xpoints.length).toBe(3);   // exterior vertex removed
    expect(poly.holes!.length).toBe(1);    // hole preserved
  });

  it('drops a hole that erasing reduces below a triangle', () => {
    regions = [donutRegion([[10, 10], [12, 10], [11, 12]])]; // 3-vertex hole, all near (11,11)
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 11, clientY: 11, button: 0 }));

    const poly = committed![0].bounds as Polygon;
    expect(poly.xpoints.length).toBe(4);   // exterior intact
    expect(poly.holes).toBeUndefined();    // collapsed hole removed
  });

  it('does not commit when the click misses every vertex', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 }));
    expect(committed).toBeNull();
  });

  it('ignores non-left mouse buttons', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 0, button: 2 }));
    expect(committed).toBeNull();
  });

  it('erases while dragging (mousedown then mousemove with the button held)', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 })); // miss
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0, buttons: 1 })); // hits (10,0)
    expect(committed).not.toBeNull();
    expect((committed![0].bounds as Polygon).xpoints.length).toBe(3);
  });

  it('a bare hover (no button) just redraws the cursor and commits nothing', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(() => canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0, buttons: 0 })))
      .not.toThrow();
    expect(committed).toBeNull();
  });

  it('removes a region outright once it drops below three vertices', () => {
    tool.setRadius(50); // large enough to catch every corner of the 10×10 square
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 }));
    expect(committed).not.toBeNull();
    expect(committed!.length).toBe(0); // degenerate → region removed
  });

  it('setRadius ignores non-positive / non-finite values', () => {
    tool.setRadius(0);
    tool.setRadius(NaN);
    tool.setRadius(-3);
    // Still erases a single nearby vertex with the prior valid radius (2).
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 0, button: 0 }));
    expect((committed![0].bounds as Polygon).xpoints.length).toBe(3);
  });
});

describe('VertexEraserToolService — keeps what it does not edit (RT-5)', () => {
  let tool: VertexEraserToolService;
  let committed: Region[] | null;
  let container: HTMLDivElement;

  function bind(regions: Region[]) {
    tool.bindHost({
      getOverlayContainer: () => container,
      getCoordinateTransform: () => identityTransform,
      getRegions: () => regions.slice(),
      setRegions: (rs) => { committed = rs; },
      invalidateWandRegion: () => undefined,
      getCachedImageRatio: () => 1,
    });
    tool.setMode(true);
    tool.setRadius(2);
  }

  beforeEach(() => {
    tool = new VertexEraserToolService();
    committed = null;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    tool.setMode(false);
    container.remove();
  });

  const click = (x: number, y: number) => (container.querySelector('canvas') as HTMLCanvasElement)
    .dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0 }));

  it('never edits an intensity-profile line', () => {
    const line = new Region();
    line.id = 2;
    line.kind = 'profile';
    const p = new Polygon();
    p.xpoints = [10, 20, 30];
    p.ypoints = [0, 0, 0];
    p.npoints = 3;
    p.coordinates = [[10, 0], [20, 0], [30, 0]];
    p.closed = false;
    line.bounds = p;
    bind([line]);

    click(20, 0);

    expect(committed).toBeNull();
  });

  it('keeps the edited region\'s metadata', () => {
    const r = squareRegion();
    r.label = 'Tumor';
    r.color = '#123456';
    r.colorOverridden = true;
    r.source = 'yolo';
    r.filename = 'a.tif';
    bind([r]);

    click(10, 0);

    const out = committed![0];
    expect((out.bounds as Polygon).xpoints.length).toBe(3);
    expect(out.colorOverridden).toBe(true);
    expect(out.source).toBe('yolo');
    expect(out.filename).toBe('a.tif');
    expect(out.label).toBe('Tumor');
  });
});
