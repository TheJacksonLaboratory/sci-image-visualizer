import { WandTool, WandToolHost, CachedImageData } from './wand-tool.service';
import { WandService } from './wand.service';
import { Region, Polygon } from '../../models/region';
import { RegionStore } from '../../store/region-store.service';
import { VisualizerStore } from '../../store/visualizer-store.service';

/** Uniform grayscale matrix (data[y][x]); a flood fill from any interior point
 *  fills the whole patch, so the wand reliably produces a region. */
function uniformGray(w: number, h: number, val = 100): number[][] {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => val));
}

function cached(w = 20, h = 20): CachedImageData {
  return {
    frames: [uniformGray(w, h)],
    width: w,
    height: h,
    ratios: [1],
    isGrayscale: true,
    originX: 0,
    originY: 0,
  };
}

/** Test host: identity client→data transform, an in-memory uniform image, and a
 *  mutable region list captured via setRegions. */
function makeHost(opts: { regions?: Region[]; cached?: CachedImageData | null } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const state = { regions: opts.regions ?? ([] as Region[]) };
  const img: CachedImageData | null = opts.cached !== undefined ? opts.cached : cached();
  const setRegions = jest.fn((r: Region[]) => {
    state.regions = r;
  });
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

describe('WandTool', () => {
  let tool: WandTool;

  beforeEach(() => {
    tool = new WandTool(new WandService());
  });

  afterEach(() => {
    tool.deactivate();
    document.body.innerHTML = '';
  });

  it('creates an overlay canvas on activation and removes it on deactivation', () => {
    const { host, container } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });
    expect(container.querySelector('canvas')).not.toBeNull();

    tool.deactivate();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('a left click grows a region from the clicked pixel and commits it', () => {
    const { host, container, state, setRegions } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });

    cv(container).dispatchEvent(mouse('pointerdown', 10, 10));

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].bounds).toBeInstanceOf(Polygon);
    expect(state.regions[0].color).toBe('#ffffff');
    expect(state.regions[0].label).toBe('Region'); // default class label
  });

  it('a drag (mousedown → mousemove) keeps extending the same region', () => {
    const { host, container, state } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 6, 6));
    canvas.dispatchEvent(mouse('pointermove', 12, 12));
    canvas.dispatchEvent(mouse('pointerup', 12, 12));

    // Still a single region (the stroke extended, not a second region).
    expect(state.regions).toHaveLength(1);
  });

  it('mousemove without a held button ends the drag (no further growth)', () => {
    const { host, container, setRegions } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    const callsAfterDown = setRegions.mock.calls.length;
    canvas.dispatchEvent(mouse('pointermove', 12, 12, { buttons: 0 })); // button released
    expect(setRegions.mock.calls.length).toBe(callsAfterDown);
  });

  it('a second click well outside the first stroke starts a new region', () => {
    const { host, container, state } = makeHost({ cached: cached(60, 60) });
    tool.activate(host, { patchSize: 5, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 8, 8));
    canvas.dispatchEvent(mouse('pointerup', 8, 8));
    canvas.dispatchEvent(mouse('pointerdown', 50, 50)); // far away → fresh region
    expect(state.regions).toHaveLength(2);
  });

  it('ignores non-left buttons', () => {
    const { host, container, setRegions } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('pointerdown', 10, 10, { button: 2 }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('shift-clicking empty space is a no-op (no region created just to erase)', () => {
    const { host, container, setRegions } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('pointerdown', 10, 10, { shiftKey: true }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when there is no cached image data', () => {
    const { host, container, setRegions } = makeHost({ cached: null });
    tool.activate(host, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('pointerdown', 10, 10));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when the click is outside the image bounds', () => {
    const { host, container, setRegions } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('pointerdown', 999, 999)); // outside 20×20
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing while the coordinate transform is not ready', () => {
    const { host, container, setRegions } = makeHost();
    (host.getCoordinateTransform as any) = () => ({
      isReady: () => false,
      clientToData: () => ({ x: 0, y: 0 }),
      dataLengthToScreen: () => 1,
    });
    tool.activate(host, { patchSize: 9, simpleMode: true });
    cv(container).dispatchEvent(mouse('pointerdown', 10, 10));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('clearActiveRegion resets the in-progress stroke', () => {
    const { host, container, state } = makeHost({ cached: cached(60, 60) });
    tool.activate(host, { patchSize: 5, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 8, 8));
    expect(state.regions).toHaveLength(1);
    tool.reset();
    canvas.dispatchEvent(mouse('pointerdown', 50, 50)); // empty space → a fresh region
    expect(state.regions).toHaveLength(2);
  });

  it('setOptions merges live option updates without throwing', () => {
    const { host } = makeHost();
    tool.activate(host, { patchSize: 9, simpleMode: true });
    expect(() => tool.setOptions({ sensitivity: 3 })).not.toThrow();
  });

  it('a click inside an existing closed polygon adopts and replaces it (same id)', () => {
    const existing = boxRegion(4, 4, 16, 16, 42);
    const { host, container, state, setRegions } = makeHost({ regions: [existing] });
    tool.activate(host, { patchSize: 9, simpleMode: true });

    cv(container).dispatchEvent(mouse('pointerdown', 10, 10)); // inside the box

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1); // adopted, not added
    expect(state.regions[0].id).toBe(42); // kept the adopted id
  });
});

/** Bounding box of a region's polygon (image coords). */
function bbox(r: Region): { x0: number; y0: number; x1: number; y1: number } {
  const p = r.bounds as Polygon;
  return {
    x0: Math.min(...p.xpoints),
    y0: Math.min(...p.ypoints),
    x1: Math.max(...p.xpoints),
    y1: Math.max(...p.ypoints),
  };
}

/**
 * The stroke accumulator survives mouseup by design, so it must notice when its
 * region changed underneath it (undo/redo, Region Editor delete, segmentation
 * replace, vertex eraser) — otherwise the next click re-commits the whole old
 * stroke and brings the undone/deleted region back (review RT-2).
 */
describe('WandTool — a stale stroke never resurrects a region (RT-2)', () => {
  let tool: WandTool;

  beforeEach(() => {
    tool = new WandTool(new WandService());
  });

  afterEach(() => {
    tool.deactivate();
    document.body.innerHTML = '';
  });

  it('a click after the region was removed outside the tool starts a fresh region', () => {
    const { host, container, state } = makeHost({ cached: cached(40, 40) });
    tool.activate(host, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);
    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    canvas.dispatchEvent(mouse('pointerup', 10, 10));
    const first = bbox(state.regions[0]);

    state.regions = []; // undo of the wand click, or a Region Editor delete

    canvas.dispatchEvent(mouse('pointerdown', 11, 11));
    canvas.dispatchEvent(mouse('pointerup', 11, 11));
    expect(state.regions).toHaveLength(1);
    // Only the new click's patch — the removed stroke (one pixel further up-left) is gone.
    expect(bbox(state.regions[0]).x0).toBe(first.x0 + 1);
    expect(bbox(state.regions[0]).y0).toBe(first.y0 + 1);
  });

  it('a click after undo restored an earlier, smaller region does not re-commit the undone growth', () => {
    const { host, container, state } = makeHost({ cached: cached(40, 40) });
    tool.activate(host, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);
    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    canvas.dispatchEvent(mouse('pointerup', 10, 10));
    const small = bbox(state.regions[0]);
    canvas.dispatchEvent(mouse('pointerdown', 12, 12));
    canvas.dispatchEvent(mouse('pointermove', 20, 20));
    canvas.dispatchEvent(mouse('pointerup', 20, 20));
    expect(bbox(state.regions[0]).x1).toBeGreaterThan(small.x1 + 5);

    // Undo the drag: the store restores a CLONE of the earlier region.
    state.regions = [boxRegion(small.x0, small.y0, small.x1, small.y1, state.regions[0].id)];

    canvas.dispatchEvent(mouse('pointerdown', 11, 11));
    canvas.dispatchEvent(mouse('pointerup', 11, 11));
    expect(state.regions).toHaveLength(1);
    // The restored region plus this click's patch — not the undone drag.
    expect(bbox(state.regions[0]).x1).toBeLessThanOrEqual(small.x1 + 1);
  });

  it('a click after RegionStore.undo() of a wand click does not bring it back (real store)', () => {
    const store = new RegionStore(new VisualizerStore());
    const { host, container } = makeHost({ cached: cached(40, 40) });
    host.getRegions = () => store.getRegions();
    host.setRegions = (r: Region[]) => store.setRegions(r);
    tool.activate(host, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);
    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    canvas.dispatchEvent(mouse('pointerup', 10, 10));
    const first = bbox(store.getRegions()[0]);
    store.undo();
    expect(store.getRegions()).toHaveLength(0);

    canvas.dispatchEvent(mouse('pointerdown', 11, 11));
    canvas.dispatchEvent(mouse('pointerup', 11, 11));
    expect(store.getRegions()).toHaveLength(1);
    expect(bbox(store.getRegions()[0]).x0).toBe(first.x0 + 1);
    store.resetUndoHistory(); // clear the coalescing timer
  });

  it('keeps extending the same stroke while nothing changed underneath it', () => {
    const { host, container, state } = makeHost({ cached: cached(40, 40) });
    tool.activate(host, { patchSize: 9, simpleMode: true });
    const canvas = cv(container);
    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    canvas.dispatchEvent(mouse('pointerup', 10, 10));
    const first = bbox(state.regions[0]);
    canvas.dispatchEvent(mouse('pointerdown', 13, 13));
    canvas.dispatchEvent(mouse('pointerup', 13, 13));
    expect(state.regions).toHaveLength(1);
    expect(bbox(state.regions[0]).x0).toBe(first.x0);
    expect(bbox(state.regions[0]).x1).toBe(first.x1 + 3);
  });
});

/** A box region with a rectangular hole (image coords). */
function donutRegion(id: number): Region {
  const r = boxRegion(4, 4, 36, 36, id);
  (r.bounds as Polygon).holes = [
    [
      [15, 15],
      [25, 15],
      [25, 25],
      [15, 25],
    ],
  ];
  return r;
}

/** Host that mints ids like RegionStore.setRegions, so split pieces can be tracked. */
function mintingHost(regions: Region[]) {
  const h = makeHost({ regions, cached: cached(40, 40) });
  let nextId = 100;
  h.host.setRegions = (r: Region[]) => {
    for (const reg of r) if (reg.id == null) reg.id = nextId++;
    h.state.regions = r;
  };
  return h;
}

describe('WandTool — commits every traced piece with its holes (RT-3, RT-5)', () => {
  let tool: WandTool;

  beforeEach(() => {
    tool = new WandTool(new WandService());
  });

  afterEach(() => {
    tool.deactivate();
    document.body.innerHTML = '';
  });

  it('extending a donut keeps its hole', () => {
    const { host, container, state } = mintingHost([donutRegion(5)]);
    tool.activate(host, { patchSize: 5, simpleMode: true });

    cv(container).dispatchEvent(mouse('pointerdown', 8, 8)); // in the solid ring

    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].id).toBe(5);
    expect((state.regions[0].bounds as Polygon).holes?.length).toBe(1);
  });

  it('a Shift-erase that cuts a region in two keeps both pieces', () => {
    const { host, container, state } = mintingHost([boxRegion(4, 4, 36, 12, 5)]);
    tool.activate(host, { patchSize: 9, simpleMode: true });

    cv(container).dispatchEvent(mouse('pointerdown', 20, 8, { shiftKey: true }));

    expect(state.regions).toHaveLength(2);
    expect(state.regions.map((r) => r.id)).toContain(5);
    const xs = state.regions.map((r) => bbox(r));
    expect(Math.min(...xs.map((b) => b.x0))).toBe(4);
    expect(Math.max(...xs.map((b) => b.x1))).toBe(36);
  });

  it('editing a region keeps its metadata (colour override, source, file name)', () => {
    const existing = boxRegion(4, 4, 36, 36, 5);
    existing.color = '#123456';
    existing.colorOverridden = true;
    existing.source = 'yolo';
    existing.filename = 'a.tif';
    existing.label = 'Tumor';
    const { host, container, state } = mintingHost([existing]);
    tool.activate(host, { patchSize: 5, simpleMode: true });

    cv(container).dispatchEvent(mouse('pointerdown', 8, 8));

    const r = state.regions[0];
    expect(r.id).toBe(5);
    expect(r.color).toBe('#123456');
    expect(r.colorOverridden).toBe(true);
    expect(r.source).toBe('yolo');
    expect(r.filename).toBe('a.tif');
    expect(r.label).toBe('Tumor');
  });
});

describe('WandTool — one drag is one undo step (RT-12)', () => {
  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  it('a drag with a long pause undoes in one step, and the next click is its own step', () => {
    jest.useFakeTimers();
    const store = new RegionStore(new VisualizerStore());
    const tool = new WandTool(new WandService(), store);
    const { host, container } = makeHost({ cached: cached(40, 40) });
    host.getRegions = () => store.getRegions();
    host.setRegions = (r: Region[]) => store.setRegions(r);
    tool.activate(host, { patchSize: 5, simpleMode: true });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    jest.advanceTimersByTime(1000); // pause mid-drag
    canvas.dispatchEvent(mouse('pointermove', 13, 10));
    canvas.dispatchEvent(mouse('pointerup', 13, 10));
    canvas.dispatchEvent(mouse('pointerdown', 20, 30)); // a new region, right away
    canvas.dispatchEvent(mouse('pointerup', 20, 30));
    expect(store.getRegions()).toHaveLength(2);

    store.undo();
    expect(store.getRegions()).toHaveLength(1);
    store.undo();
    expect(store.getRegions()).toHaveLength(0);
    tool.deactivate();
    store.resetUndoHistory();
  });
});
