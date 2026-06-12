import { BrushToolService } from './brush-tool.service';
import { WandService } from './wand.service';
import { CachedImageData, WandToolHost } from './wand-tool.service';
import { Region, Polygon } from '../models/region';

/** A cached-image frame of the given size. The brush ignores pixel values, so a
 *  zero matrix is fine — only width/height/ratios/origin matter. */
function cached(w = 60, h = 60): CachedImageData {
  const frame = Array.from({ length: h }, () => new Array(w).fill(0));
  return { frames: [frame], width: w, height: h, ratios: [1], isGrayscale: true, originX: 0, originY: 0 };
}

/** Test host: identity client→data transform and a mutable region list. */
function makeHost(opts: { regions?: Region[]; cached?: CachedImageData | null } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const state = { regions: opts.regions ?? ([] as Region[]) };
  const img: CachedImageData | null = opts.cached !== undefined ? opts.cached : cached();
  const setRegions = jest.fn((r: Region[]) => { state.regions = r; });
  const host: WandToolHost = {
    getOverlayContainer: () => container,
    getCachedImageData: () => img,
    getCoordinateTransform: () => ({
      isReady: () => true,
      clientToData: (x: number, y: number) => ({ x, y }),
      dataLengthToScreen: (n: number) => n,
    }),
    getActiveFrameIndex: () => 0,
    getRegions: () => state.regions,
    setRegions: setRegions as any,
    getFileName: () => 'test.tif',
    getShapeColor: () => '#ffffff',
  };
  return { host, container, state, setRegions };
}

function cv(container: HTMLElement): HTMLCanvasElement {
  return container.querySelector('canvas') as HTMLCanvasElement;
}

/** A closed-polygon Region covering a known box (image coords). */
function boxRegion(x0: number, y0: number, x1: number, y1: number, id?: number): Region {
  const p = new Polygon();
  p.xpoints = [x0, x1, x1, x0];
  p.ypoints = [y0, y0, y1, y1];
  p.npoints = 4;
  p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]);
  p.closed = true;
  const r = new Region();
  r.bounds = p;
  if (id != null) r.id = id;
  return r;
}

function mouse(type: string, clientX: number, clientY: number, extra: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { button: 0, buttons: 1, clientX, clientY, ...extra });
}

describe('BrushToolService', () => {
  let tool: BrushToolService;

  beforeEach(() => {
    tool = new BrushToolService(new WandService());
  });

  afterEach(() => {
    tool.setMode(false);
    document.body.innerHTML = '';
  });

  it('creates an overlay canvas on activation and removes it on deactivation', () => {
    const { host, container } = makeHost();
    tool.bindHost(host);

    tool.setMode(true, { size: 12 });
    expect(container.querySelector('canvas')).not.toBeNull();

    tool.setMode(false);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('a left click paints a disc region and commits it', () => {
    const { host, container, state, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });

    cv(container).dispatchEvent(mouse('mousedown', 30, 30));

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].bounds).toBeInstanceOf(Polygon);
    expect(state.regions[0].color).toBe('#ffffff');
    expect(state.regions[0].label).toBe('legend'); // default class label
  });

  it('the painted disc spans roughly the brush diameter', () => {
    const { host, container, state } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 20 });

    cv(container).dispatchEvent(mouse('mousedown', 30, 30));

    const b = state.regions[0].bounds as Polygon;
    const w = Math.max(...b.xpoints) - Math.min(...b.xpoints);
    // ~20px diameter; allow generous slack for tracing/rounding.
    expect(w).toBeGreaterThan(12);
    expect(w).toBeLessThan(28);
  });

  it('a drag keeps extending the same region', () => {
    const { host, container, state } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('mousedown', 10, 10));
    canvas.dispatchEvent(mouse('mousemove', 20, 20));
    canvas.dispatchEvent(mouse('mousemove', 30, 30));
    canvas.dispatchEvent(mouse('mouseup', 30, 30));

    expect(state.regions).toHaveLength(1);
  });

  it('a second click far from the first stroke starts a new region', () => {
    const { host, container, state } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 8 });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('mousedown', 10, 10));
    canvas.dispatchEvent(mouse('mouseup', 10, 10));
    canvas.dispatchEvent(mouse('mousedown', 50, 50));
    expect(state.regions).toHaveLength(2);
  });

  it('shift-painting erases a disc from an existing region', () => {
    const existing = boxRegion(5, 5, 55, 55, 7);
    const { host, container, state, setRegions } = makeHost({ regions: [existing] });
    tool.bindHost(host);
    tool.setMode(true, { size: 16 });

    // Shift-paint near a corner so the box loses area but isn't destroyed.
    cv(container).dispatchEvent(mouse('mousedown', 6, 6, { shiftKey: true }));

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].id).toBe(7); // same region, edited in place
  });

  it('shift-painting empty space is a no-op (no region created just to erase)', () => {
    const { host, container, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });
    cv(container).dispatchEvent(mouse('mousedown', 30, 30, { shiftKey: true }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('a click inside an existing closed polygon adopts and replaces it (same id)', () => {
    const existing = boxRegion(10, 10, 50, 50, 42);
    const { host, container, state, setRegions } = makeHost({ regions: [existing] });
    tool.bindHost(host);
    tool.setMode(true, { size: 10 });

    cv(container).dispatchEvent(mouse('mousedown', 30, 30)); // inside the box

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1); // adopted, not added
    expect(state.regions[0].id).toBe(42);  // kept the adopted id
  });

  it('ignores non-left buttons', () => {
    const { host, container, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });
    cv(container).dispatchEvent(mouse('mousedown', 30, 30, { button: 2 }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when there is no cached image data', () => {
    const { host, container, setRegions } = makeHost({ cached: null });
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });
    cv(container).dispatchEvent(mouse('mousedown', 30, 30));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when the click is outside the image bounds', () => {
    const { host, container, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });
    cv(container).dispatchEvent(mouse('mousedown', 999, 999)); // outside 60×60
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing while the coordinate transform is not ready', () => {
    const { host, container, setRegions } = makeHost();
    (host.getCoordinateTransform as any) = () =>
      ({ isReady: () => false, clientToData: () => ({ x: 0, y: 0 }), dataLengthToScreen: () => 1 });
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });
    cv(container).dispatchEvent(mouse('mousedown', 30, 30));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('clearActiveRegion resets the in-progress stroke', () => {
    const { host, container, state } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 8 });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('mousedown', 10, 10));
    expect(state.regions).toHaveLength(1);
    tool.clearActiveRegion();
    canvas.dispatchEvent(mouse('mousedown', 50, 50)); // fresh region
    expect(state.regions).toHaveLength(2);
  });

  it('setSize updates the brush without throwing', () => {
    const { host } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { size: 12 });
    expect(() => tool.setSize(40)).not.toThrow();
  });
});
