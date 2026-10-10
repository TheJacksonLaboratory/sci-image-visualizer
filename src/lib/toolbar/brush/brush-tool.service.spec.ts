import { BrushTool } from './brush-tool.service';
import { CachedImageData, WandToolHost } from '../wand/wand-tool.service';
import { Region, Polygon } from '../../models/region';

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
  // Mirror RegionStore.setRegions: mint an id for any region that lacks one, so
  // the brush can read minted ids back and keep split pieces stable across ticks.
  let nextId = 1 + Math.max(0, ...state.regions.map((r) => r.id ?? 0));
  const setRegions = jest.fn((r: Region[]) => {
    for (const reg of r) if (reg.id == null) reg.id = nextId++;
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

describe('BrushTool', () => {
  let tool: BrushTool;

  beforeEach(() => {
    tool = new BrushTool();
  });

  afterEach(() => {
    tool.deactivate();
    document.body.innerHTML = '';
  });

  it('creates an overlay canvas on activation and removes it on deactivation', () => {
    const { host, container } = makeHost();
    tool.activate(host, { size: 12 });
    expect(container.querySelector('canvas')).not.toBeNull();

    tool.deactivate();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('a left click paints a disc region and commits it', () => {
    const { host, container, state, setRegions } = makeHost();
    tool.activate(host, { size: 12 });

    cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].bounds).toBeInstanceOf(Polygon);
    expect(state.regions[0].color).toBe('#ffffff');
    expect(state.regions[0].label).toBe('Region'); // default class label
  });

  it('the painted disc spans roughly the brush diameter', () => {
    const { host, container, state } = makeHost();
    tool.activate(host, { size: 20 });

    cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

    const b = state.regions[0].bounds as Polygon;
    const w = Math.max(...b.xpoints) - Math.min(...b.xpoints);
    // ~20px diameter; allow generous slack for tracing/rounding.
    expect(w).toBeGreaterThan(12);
    expect(w).toBeLessThan(28);
  });

  it('a drag keeps extending the same region', () => {
    const { host, container, state } = makeHost();
    tool.activate(host, { size: 12 });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    canvas.dispatchEvent(mouse('pointermove', 20, 20));
    canvas.dispatchEvent(mouse('pointermove', 30, 30));
    canvas.dispatchEvent(mouse('pointerup', 30, 30));

    expect(state.regions).toHaveLength(1);
  });

  it('a second click far from the first stroke starts a new region', () => {
    const { host, container, state } = makeHost();
    tool.activate(host, { size: 8 });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    canvas.dispatchEvent(mouse('pointerup', 10, 10));
    canvas.dispatchEvent(mouse('pointerdown', 50, 50));
    expect(state.regions).toHaveLength(2);
  });

  it('shift-painting erases a disc from an existing region', () => {
    const existing = boxRegion(5, 5, 55, 55, 7);
    const { host, container, state, setRegions } = makeHost({ regions: [existing] });
    tool.activate(host, { size: 16 });

    // Shift-paint near a corner so the box loses area but isn't destroyed.
    cv(container).dispatchEvent(mouse('pointerdown', 6, 6, { shiftKey: true }));

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].id).toBe(7); // same region, edited in place
  });

  it('shift-erasing the centre of a region leaves a hole (donut) — jit-ui#85', () => {
    // Erase a disc well inside a solid box: the box keeps its exterior but gains
    // an interior ring (the committed region must carry holes, not fill them).
    const existing = boxRegion(5, 5, 55, 55, 7);
    const { host, container, state } = makeHost({ regions: [existing] });
    tool.activate(host, { size: 16 });

    cv(container).dispatchEvent(mouse('pointerdown', 30, 30, { shiftKey: true })); // dead centre

    expect(state.regions).toHaveLength(1);
    expect(state.regions[0].id).toBe(7);
    const b = state.regions[0].bounds as Polygon;
    expect(b.holes?.length).toBe(1);
    expect(b.holes![0].length).toBeGreaterThanOrEqual(4);
  });

  it('shift-painting a strip through a region splits it into two regions', () => {
    // A wide, short bar; erasing a full-height disc at its centre cuts it in two.
    const existing = boxRegion(5, 20, 55, 40, 7);
    const { host, container, state } = makeHost({ regions: [existing] });
    tool.activate(host, { size: 24 });

    cv(container).dispatchEvent(mouse('pointerdown', 30, 30, { shiftKey: true }));

    expect(state.regions).toHaveLength(2);
    // The larger piece keeps the original id; the other gets a fresh one.
    const ids = state.regions.map((r) => r.id).sort();
    expect(ids).toContain(7);
    expect(state.regions.every((r) => r.label === 'Region')).toBe(true);
  });

  it('a split holds stable across drag ticks (no duplicate regions per tick)', () => {
    const existing = boxRegion(5, 20, 55, 40, 7);
    const { host, container, state } = makeHost({ regions: [existing] });
    tool.activate(host, { size: 24 });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 30, 20, { shiftKey: true }));
    canvas.dispatchEvent(mouse('pointermove', 30, 30, { shiftKey: true }));
    canvas.dispatchEvent(mouse('pointermove', 30, 40, { shiftKey: true }));
    canvas.dispatchEvent(mouse('pointerup', 30, 40, { shiftKey: true }));

    expect(state.regions).toHaveLength(2); // still two, not one-per-tick
  });

  it('shift-painting empty space is a no-op (no region created just to erase)', () => {
    const { host, container, setRegions } = makeHost();
    tool.activate(host, { size: 12 });
    cv(container).dispatchEvent(mouse('pointerdown', 30, 30, { shiftKey: true }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('a click inside an existing closed polygon adopts and replaces it (same id)', () => {
    const existing = boxRegion(10, 10, 50, 50, 42);
    const { host, container, state, setRegions } = makeHost({ regions: [existing] });
    tool.activate(host, { size: 10 });

    cv(container).dispatchEvent(mouse('pointerdown', 30, 30)); // inside the box

    expect(setRegions).toHaveBeenCalled();
    expect(state.regions).toHaveLength(1); // adopted, not added
    expect(state.regions[0].id).toBe(42); // kept the adopted id
  });

  it('ignores non-left buttons', () => {
    const { host, container, setRegions } = makeHost();
    tool.activate(host, { size: 12 });
    cv(container).dispatchEvent(mouse('pointerdown', 30, 30, { button: 2 }));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when there is no cached image data', () => {
    const { host, container, setRegions } = makeHost({ cached: null });
    tool.activate(host, { size: 12 });
    cv(container).dispatchEvent(mouse('pointerdown', 30, 30));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing when the click is outside the image bounds', () => {
    const { host, container, setRegions } = makeHost();
    tool.activate(host, { size: 12 });
    cv(container).dispatchEvent(mouse('pointerdown', 999, 999)); // outside 60×60
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('does nothing while the coordinate transform is not ready', () => {
    const { host, container, setRegions } = makeHost();
    (host.getCoordinateTransform as any) = () => ({
      isReady: () => false,
      clientToData: () => ({ x: 0, y: 0 }),
      dataLengthToScreen: () => 1,
    });
    tool.activate(host, { size: 12 });
    cv(container).dispatchEvent(mouse('pointerdown', 30, 30));
    expect(setRegions).not.toHaveBeenCalled();
  });

  it('clearActiveRegion resets the in-progress stroke', () => {
    const { host, container, state } = makeHost();
    tool.activate(host, { size: 8 });
    const canvas = cv(container);

    canvas.dispatchEvent(mouse('pointerdown', 10, 10));
    expect(state.regions).toHaveLength(1);
    tool.reset();
    canvas.dispatchEvent(mouse('pointerdown', 50, 50)); // fresh region
    expect(state.regions).toHaveLength(2);
  });

  it('setSize updates the brush without throwing', () => {
    const { host } = makeHost();
    tool.activate(host, { size: 12 });
    expect(() => tool.setSize(40)).not.toThrow();
  });

  describe('painting a class (label / color)', () => {
    function labelled(r: Region, label: string): Region {
      r.label = label;
      return r;
    }

    it('new regions take the class label and colour, kept against preset re-apply', () => {
      const { host, container, state } = makeHost();
      tool.activate(host, { size: 12, label: 'pos', color: '#1E88E5' });

      cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

      expect(state.regions).toHaveLength(1);
      expect(state.regions[0].label).toBe('pos');
      expect(state.regions[0].color).toBe('#1E88E5');
      expect(state.regions[0].colorOverridden).toBe(true);
    });

    it('does not adopt a region of another class under the cursor', () => {
      const other = labelled(boxRegion(20, 20, 40, 40, 7), 'neg');
      const { host, container, state } = makeHost({ regions: [other] });
      tool.activate(host, { size: 6, label: 'pos', color: '#00f' });

      cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

      expect(state.regions).toHaveLength(2);
      expect(state.regions.find((r) => r.id === 7)?.label).toBe('neg');
      expect(state.regions.find((r) => r.id !== 7)?.label).toBe('pos');
    });

    it('does not merge a region of another class it paints across', () => {
      const other = labelled(boxRegion(28, 5, 34, 55, 7), 'neg');
      const { host, container, state } = makeHost({ regions: [other] });
      tool.activate(host, { size: 6, label: 'pos' });
      const canvas = cv(container);

      canvas.dispatchEvent(mouse('pointerdown', 10, 30));
      canvas.dispatchEvent(mouse('pointermove', 50, 30));

      expect(state.regions.map((r) => r.label).sort()).toEqual(['neg', 'pos']);
      expect(state.regions.find((r) => r.id === 7)?.bounds).toBe(other.bounds);
    });

    it('adopts and extends a region of the same class', () => {
      const same = labelled(boxRegion(20, 20, 40, 40, 7), 'pos');
      const { host, container, state } = makeHost({ regions: [same] });
      tool.activate(host, { size: 6, label: 'pos' });

      cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

      expect(state.regions).toHaveLength(1);
      expect(state.regions[0].id).toBe(7);
      expect(state.regions[0].label).toBe('pos');
    });

    it('switching class drops the active region, so the next stroke starts a new one', () => {
      const { host, container, state } = makeHost();
      tool.activate(host, { size: 12, label: 'pos' });
      const canvas = cv(container);
      canvas.dispatchEvent(mouse('pointerdown', 30, 30));
      canvas.dispatchEvent(mouse('pointerup', 30, 30));

      tool.setOptions({ label: 'neg', color: '#f00' });
      canvas.dispatchEvent(mouse('pointerdown', 30, 30));

      expect(state.regions.map((r) => r.label).sort()).toEqual(['neg', 'pos']);
    });

    it('a size-only update keeps the class', () => {
      const { host, container, state } = makeHost();
      tool.activate(host, { size: 12, label: 'pos', color: '#00f' });
      tool.setOptions({ size: 20 });

      cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

      expect(state.regions[0].label).toBe('pos');
      expect(state.regions[0].color).toBe('#00f');
    });

    it('re-arming without a class is the plain brush again', () => {
      const { host, container, state } = makeHost();
      tool.activate(host, { size: 12, label: 'pos', color: '#00f' });
      tool.deactivate();
      tool.activate(host, { size: 12 });

      cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

      expect(state.regions[0].label).toBe('Region');
      expect(state.regions[0].color).toBe('#ffffff');
      expect(state.regions[0].colorOverridden).toBeUndefined();
    });

    it('a size set while disarmed still applies to the next arm', () => {
      const { host, container, state } = makeHost();
      tool.activate(host, { size: 4 });
      tool.deactivate();
      tool.setOptions({ size: 20 });
      tool.activate(host);

      cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

      const b = state.regions[0].bounds as Polygon;
      expect(Math.max(...b.xpoints) - Math.min(...b.xpoints)).toBeGreaterThan(12);
    });

    it('the plain brush still adopts a labelled region', () => {
      const same = labelled(boxRegion(20, 20, 40, 40, 7), 'pos');
      const { host, container, state } = makeHost({ regions: [same] });
      tool.activate(host, { size: 6 });

      cv(container).dispatchEvent(mouse('pointerdown', 30, 30));

      expect(state.regions).toHaveLength(1);
      expect(state.regions[0].id).toBe(7);
      expect(state.regions[0].label).toBe('pos');
    });
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

/** The brush twin of the wand's RT-2 specs: a stroke kept across mouseup must not
 *  re-commit a region that was undone, deleted or replaced outside the tool. */
describe('BrushTool — a stale stroke never resurrects a region (RT-2)', () => {
  let tool: BrushTool;

  beforeEach(() => {
    tool = new BrushTool();
  });

  afterEach(() => {
    tool.deactivate();
    document.body.innerHTML = '';
  });

  it('a dab after the region was removed outside the tool starts a fresh region', () => {
    const { host, container, state } = makeHost();
    tool.activate(host, { size: 12 });
    const canvas = cv(container);
    canvas.dispatchEvent(mouse('pointerdown', 20, 20));
    canvas.dispatchEvent(mouse('pointerup', 20, 20));
    const first = bbox(state.regions[0]);

    state.regions = []; // undo of the dab, or a Region Editor delete

    canvas.dispatchEvent(mouse('pointerdown', 23, 23));
    canvas.dispatchEvent(mouse('pointerup', 23, 23));
    expect(state.regions).toHaveLength(1);
    expect(bbox(state.regions[0]).x0).toBe(first.x0 + 3); // just the new disc
  });

  it("a dab after the region's bounds were replaced (vertex eraser, undo) does not re-commit the old stroke", () => {
    const { host, container, state } = makeHost();
    tool.activate(host, { size: 12 });
    const canvas = cv(container);
    canvas.dispatchEvent(mouse('pointerdown', 20, 20));
    canvas.dispatchEvent(mouse('pointermove', 40, 20));
    canvas.dispatchEvent(mouse('pointerup', 40, 20));
    const painted = bbox(state.regions[0]);

    // Something outside the tool cut the region back to its left end.
    state.regions = [boxRegion(painted.x0, painted.y0, painted.x0 + 10, painted.y1, state.regions[0].id)];

    canvas.dispatchEvent(mouse('pointerdown', 22, 20));
    canvas.dispatchEvent(mouse('pointerup', 22, 20));
    expect(state.regions).toHaveLength(1);
    expect(bbox(state.regions[0]).x1).toBeLessThan(painted.x1 - 5); // the cut part stays cut
  });
});

describe('BrushTool — edits keep region metadata and frame (RT-5, RT-14)', () => {
  let tool: BrushTool;

  beforeEach(() => {
    tool = new BrushTool();
  });

  afterEach(() => {
    tool.deactivate();
    document.body.innerHTML = '';
  });

  it('the plain brush keeps a user-picked colour and the region metadata', () => {
    const existing = boxRegion(10, 10, 50, 50, 7);
    existing.color = '#123456';
    existing.colorOverridden = true;
    existing.source = 'yolo';
    existing.label = 'Tumor';
    const { host, container, state } = makeHost({ regions: [existing] });
    tool.activate(host, { size: 8 });

    cv(container).dispatchEvent(mouse('pointerdown', 48, 30));

    const r = state.regions[0];
    expect(r.id).toBe(7);
    expect(r.color).toBe('#123456');
    expect(r.colorOverridden).toBe(true);
    expect(r.source).toBe('yolo');
    expect(r.label).toBe('Tumor');
  });

  it('uses the Y ratio for rows (anisotropic readback)', () => {
    const img = cached(60, 60);
    img.ratios = [1, 2]; // 1 data unit per column, 2 per row
    const { host, container, state } = makeHost({ cached: img });
    tool.activate(host, { size: 10 });

    cv(container).dispatchEvent(mouse('pointerdown', 20, 40));

    const p = state.regions[0].bounds as Polygon;
    const w = Math.max(...p.xpoints) - Math.min(...p.xpoints);
    const h = Math.max(...p.ypoints) - Math.min(...p.ypoints);
    // A round dab in matrix pixels is twice as tall in data units.
    expect(h).toBeGreaterThan(w * 1.6);
  });

  it('starting a new stroke elsewhere keeps the pieces of an earlier split', () => {
    const existing = boxRegion(5, 20, 55, 40, 7);
    const { host, container, state } = makeHost({ regions: [existing] });
    tool.activate(host, { size: 24 });
    const canvas = cv(container);
    canvas.dispatchEvent(mouse('pointerdown', 30, 30, { shiftKey: true }));
    canvas.dispatchEvent(mouse('pointerup', 30, 30, { shiftKey: true }));
    expect(state.regions).toHaveLength(2);

    canvas.dispatchEvent(mouse('pointerdown', 30, 54));
    canvas.dispatchEvent(mouse('pointerup', 30, 52));

    expect(state.regions).toHaveLength(3);
  });
});
