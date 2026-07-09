import { WandToolService, WandToolHost, CachedImageData } from './wand-tool.service';
import { WandService } from './wand.service';
import { Region, Polygon } from '../../models/region';

/** Uniform grayscale matrix (data[y][x]); a flood fill from any interior point
 *  fills the whole patch, so the wand reliably produces a region. */
function uniformGray(w: number, h: number, val = 100): number[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => val));
}

function cached(w = 20, h = 20): CachedImageData {
  return {
    frames: [uniformGray(w, h)], width: w, height: h, ratios: [1], isGrayscale: true, originX: 0, originY: 0,
  };
}

/** Test host: identity client→data transform, an in-memory uniform image, and a
 *  mutable region list captured via setRegions. */
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

/** The overlay canvas the tool appended to `container`. */
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

describe('WandToolService', () => {
  let tool: WandToolService;

  beforeEach(() => {
    tool = new WandToolService(new WandService());
  });

  afterEach(() => {
    tool.setMode(false);
    document.body.innerHTML = '';
  });

  it('creates an overlay canvas on activation and removes it on deactivation', () => {
    const { host, container } = makeHost();
    tool.bindHost(host);

    tool.setMode(true, { patchSize: 9, simpleMode: true });
    expect(container.querySelector('canvas')).not.toBeNull();

    tool.setMode(false);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('a left click grows a region from the clicked pixel and commits it', () => {
    const { host, container, state, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });

    cv(container).dispatchEvent(mouse('mousedown', 10, 10));

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].bounds).toBeInstanceOf(Polygon);
    expect(state.regions[0].color).toBe('#ffffff');
    expect(state.regions[0].label).toBe('Region'); // default class label
  });

  it('a drag (mousedown → mousemove) keeps extending the same region', () => {
    const { host, container, state } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('mousedown', 6, 6));
    canvas.dispatchEvent(mouse('mousemove', 12, 12));
    canvas.dispatchEvent(mouse('mouseup', 12, 12));

    // Still a single region (the stroke extended, not a second region).
    expect(state.regions).toHaveLength(1);
  });

  it('mousemove without a held button ends the drag (no further growth)', () => {
    const { host, container, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('mousedown', 10, 10));
    const callsAfterDown = setRegions.mock.calls.length;
    canvas.dispatchEvent(mouse('mousemove', 12, 12, { buttons: 0 })); // button released
    expect(setRegions.mock.calls.length).toBe(callsAfterDown);
  });

  it('a second click well outside the first stroke starts a new region', () => {
    const { host, container, state } = makeHost({ cached: cached(60, 60) });
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 5, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('mousedown', 8, 8));
    canvas.dispatchEvent(mouse('mouseup', 8, 8));
    canvas.dispatchEvent(mouse('mousedown', 50, 50)); // far away → fresh region
    expect(state.regions).toHaveLength(2);
  });

  it('ignores non-left buttons', () => {
    const { host, container, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('mousedown', 10, 10, { button: 2 }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('shift-clicking empty space is a no-op (no region created just to erase)', () => {
    const { host, container, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('mousedown', 10, 10, { shiftKey: true }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when there is no cached image data', () => {
    const { host, container, setRegions } = makeHost({ cached: null });
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('mousedown', 10, 10));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when the click is outside the image bounds', () => {
    const { host, container, setRegions } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('mousedown', 999, 999)); // outside 20×20
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing while the coordinate transform is not ready', () => {
    const { host, container, setRegions } = makeHost();
    (host.getCoordinateTransform as any) = () =>
      ({ isReady: () => false, clientToData: () => ({ x: 0, y: 0 }), dataLengthToScreen: () => 1 });
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('mousedown', 10, 10));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('clearActiveRegion resets the in-progress stroke', () => {
    const { host, container, state } = makeHost({ cached: cached(60, 60) });
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 5, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('mousedown', 8, 8));
    expect(state.regions).toHaveLength(1);
    tool.clearActiveRegion();
    canvas.dispatchEvent(mouse('mousedown', 50, 50)); // empty space → a fresh region
    expect(state.regions).toHaveLength(2);
  });

  it('setOptions merges live option updates without throwing', () => {
    const { host } = makeHost();
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });
    expect(() => tool.setOptions({ sensitivity: 3 })).not.toThrow();
  });

  it('a click inside an existing closed polygon adopts and replaces it (same id)', () => {
    const existing = boxRegion(4, 4, 16, 16, 42);
    const { host, container, state, setRegions } = makeHost({ regions: [existing] });
    tool.bindHost(host);
    tool.setMode(true, { patchSize: 9, simpleMode: true });

    cv(container).dispatchEvent(mouse('mousedown', 10, 10)); // inside the box

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1);   // adopted, not added
    expect(state.regions[0].id).toBe(42);    // kept the adopted id
  });
});
