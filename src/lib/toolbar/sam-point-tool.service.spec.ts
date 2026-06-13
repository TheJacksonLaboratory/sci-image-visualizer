import { SamPointToolService } from './sam-point-tool.service';
import { WandService } from './wand.service';
import { CachedImageData, WandToolHost } from './wand-tool.service';
import { ISamSession, SamEmbedding } from '../contracts/sam.contract';
import { Region } from '../models/region';

const W = 40, H = 40;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Fake session: decode fills a fixed box so maskToPolygons yields a polygon
 *  regardless of the (point) prompt — enough to exercise the orchestration. */
function fakeSession(): ISamSession {
  return {
    loadModel: async () => undefined,
    isLoaded: () => true,
    dispose: () => undefined,
    embed: async (): Promise<SamEmbedding> =>
      ({ data: new Float32Array(1), dims: [1, 1, 1, 1], scale: 1, imageWidth: W, imageHeight: H }),
    decode: async () => {
      const mask = new Uint8Array(W * H);
      for (let y = 8; y < 28; y++) for (let x = 8; x < 28; x++) mask[y * W + x] = 1;
      return { mask, width: W, height: H, iou: 0.9 };
    },
  };
}

function makeHost(): { host: WandToolHost; get: () => Region[]; container: HTMLElement } {
  let regs: Region[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const frame = Array.from({ length: H }, () => new Array(W).fill(0));
  const cached: CachedImageData = {
    frames: [frame], width: W, height: H, ratios: [1], isGrayscale: true, originX: 0, originY: 0,
  };
  const host: WandToolHost = {
    getOverlayContainer: () => container,
    getCachedImageData: () => cached,
    getCoordinateTransform: () =>
      ({ isReady: () => true, clientToData: (x, y) => ({ x, y }), dataLengthToScreen: (n) => n }),
    getActiveFrameIndex: () => 0,
    getRegions: () => regs,
    // Mirror RegionStore.setRegions: mint ids so refine/clear can track the
    // in-progress region by identity.
    setRegions: (r: Region[]) => {
      let next = 1 + Math.max(0, ...r.map((x) => x.id ?? 0));
      for (const reg of r) if (reg.id == null) reg.id = next++;
      regs = r;
    },
    getFileName: () => 'test.tif',
    getShapeColor: () => '#ffffff',
  };
  return { host, get: () => regs, container };
}

function cv(c: HTMLElement): HTMLCanvasElement {
  return c.querySelector('canvas') as HTMLCanvasElement;
}
function click(x: number, y: number, shift = false): MouseEvent {
  return new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, shiftKey: shift });
}

describe('SamPointToolService', () => {
  let tool: SamPointToolService;

  beforeEach(() => {
    tool = new SamPointToolService(new WandService());
    tool.useSession(fakeSession());
  });
  afterEach(() => { tool.setMode(false); document.body.innerHTML = ''; });

  it('creates/removes the overlay on setMode', () => {
    const { host, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    expect(cv(container)).not.toBeNull();
    tool.setMode(false);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('a click produces a labelled preview region', async () => {
    const { host, get, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    cv(container).dispatchEvent(click(18, 18));
    await flush();
    expect(get()).toHaveLength(1);
    expect(get()[0].label).toBe('sam');
  });

  it('signals busy + a status while a click is being segmented', async () => {
    const { host, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    const busy: boolean[] = [];
    tool.busy$.subscribe((b) => busy.push(b));
    const statuses: string[] = [];
    tool.status$.subscribe((s) => { if (s) statuses.push(s); });

    cv(container).dispatchEvent(click(18, 18));
    await flush();

    expect(busy).toContain(true);             // went busy during the run…
    expect(tool.busy$.value).toBe(false);     // …and settled when finished
    expect(statuses.some((s) => /point|segment|encod|loading/i.test(s))).toBe(true);
  });

  it('each positive click segments a NEW region (does not extend the previous one)', async () => {
    const { host, get, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    cv(container).dispatchEvent(click(12, 12));       // fiber 1
    await flush();
    expect(get()).toHaveLength(1);
    cv(container).dispatchEvent(click(24, 24));       // adjacent fiber 2 (positive)
    await flush();
    expect(get()).toHaveLength(2);                    // a new region, not a grown one
    expect((tool as any).points).toHaveLength(1);     // prompt reset to the latest click only
  });

  it('clicking after the region is deleted starts fresh (no stale merged prompt)', async () => {
    const { host, get, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    cv(container).dispatchEvent(click(12, 12));
    await flush();
    host.setRegions([]);                              // user deletes the segmented region
    cv(container).dispatchEvent(click(24, 24));       // click another fiber
    await flush();
    expect(get()).toHaveLength(1);                    // one fresh region…
    expect((tool as any).points).toHaveLength(1);     // …from a single fresh point
  });

  it('a Shift/Alt click refines the current object (not a new region)', async () => {
    const { host, get, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    cv(container).dispatchEvent(click(18, 18));
    await flush();
    cv(container).dispatchEvent(click(20, 20, true)); // negative refine
    await flush();
    expect(get()).toHaveLength(1);
  });

  it('commit() keeps the region; the next click starts a new object', async () => {
    const { host, get, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    cv(container).dispatchEvent(click(18, 18));
    await flush();
    tool.commit();
    cv(container).dispatchEvent(click(18, 18));
    await flush();
    expect(get()).toHaveLength(2);
  });

  it('clear() removes the in-progress preview region', async () => {
    const { host, get, container } = makeHost();
    tool.bindHost(host);
    tool.setMode(true);
    cv(container).dispatchEvent(click(18, 18));
    await flush();
    expect(get()).toHaveLength(1);
    tool.clear();
    expect(get()).toHaveLength(0);
  });
});
