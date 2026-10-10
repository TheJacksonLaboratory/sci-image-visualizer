import { CellSegmentToolService } from './cell-segment-tool.service';
import { CachedImageData, CanvasToolHost } from '../tool-kit/canvas-tool';
import { ICellSegmenter, CellSegmentation } from '../../contracts/cell-segmenter.contract';
import { Region, Rectangle, Polygon } from '../../models/region';

const W = 40, H = 40;

function rectRegion(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  r.bounds = Object.assign(new Rectangle(), { x, y, width: w, height: h });
  return r;
}

/** Fake cellpose: labels two cells (a left and a right blob) within the crop. */
function fakeSegmenter(): ICellSegmenter {
  return {
    segmentCells: async (img): Promise<CellSegmentation> => {
      const labels = new Uint32Array(img.width * img.height);
      const midx = Math.floor(img.width / 2);
      for (let y = 2; y < img.height - 2; y++) {
        for (let x = 2; x < img.width - 2; x++) labels[y * img.width + x] = x < midx ? 1 : 2;
      }
      return { labels, width: img.width, height: img.height, count: 2 };
    },
  };
}

function makeHost(regions: Region[]): { host: CanvasToolHost; get: () => Region[] } {
  let regs = regions;
  const frame = Array.from({ length: H }, () => new Array(W).fill(120));
  const cached: CachedImageData = {
    frames: [frame], width: W, height: H, ratios: [1], isGrayscale: true, originX: 0, originY: 0,
  };
  const host: CanvasToolHost = {
    getOverlayContainer: () => document.createElement('div'),
    getCachedImageData: () => cached,
    getCoordinateTransform: () =>
      ({ isReady: () => true, clientToData: (x, y) => ({ x, y }), dataLengthToScreen: (n) => n }),
    getActiveFrameIndex: () => 0,
    getRegions: () => regs,
    setRegions: (r: Region[]) => {
      let next = 1 + Math.max(0, ...r.map((x) => x.id ?? 0));
      for (const reg of r) if (reg.id == null) reg.id = next++;
      regs = r;
    },
    getFileName: () => 'test.tif',
    getShapeColor: () => '#ffffff',
  };
  return { host, get: () => regs };
}

describe('CellSegmentToolService', () => {
  let tool: CellSegmentToolService;
  beforeEach(() => { tool = new CellSegmentToolService(); });

  it('crops each rectangle, cellpose-segments it, and adds a region per cell', async () => {
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    const added = await tool.segmentBoxes(host, fakeSegmenter());
    expect(added).toBe(2);                       // two cells in the crop
    const regs = get();
    expect(regs).toHaveLength(2);                // prompt rectangle replaced by 2 cell regions
    expect(regs.every((r) => r.bounds instanceof Polygon)).toBe(true);
    expect(regs.every((r) => r.label === 'cell')).toBe(true);
  });

  it('inherits the source box color for every cell region', async () => {
    const rect = rectRegion(8, 8, 24, 24);
    rect.color = '#00bcd4';                          // distinct, non-default
    const { host, get } = makeHost([rect]);
    await tool.segmentBoxes(host, fakeSegmenter());
    expect(get().every((r) => r.color === '#00bcd4')).toBe(true);
  });

  it('surfaces the segmenter\'s phase status (so the toast is meaningful)', async () => {
    const statuses: string[] = [];
    tool.status$.subscribe((s) => { if (s) statuses.push(s); });
    const seg: ICellSegmenter = {
      segmentCells: async (img, progress) => {
        progress?.onStatus?.('Running inference (tile 1/2)…');
        progress?.onStatus?.('Computing flow dynamics…');
        return { labels: new Uint32Array(img.width * img.height), width: img.width, height: img.height, count: 0 };
      },
    };
    const { host } = makeHost([rectRegion(8, 8, 24, 24)]);
    await tool.segmentBoxes(host, seg);
    expect(statuses).toContain('Running inference (tile 1/2)…');
    expect(statuses).toContain('Computing flow dynamics…');
    expect(statuses.some((s) => /tracing/i.test(s))).toBe(true); // our own phase
  });

  it('no-ops with a status when no rectangles are drawn', async () => {
    const { host } = makeHost([]);
    expect(await tool.segmentBoxes(host, fakeSegmenter())).toBe(0);
    expect(tool.status$.value).toMatch(/rectangle/i);
  });

  it('keeps a rectangle whose crop yields no cells', async () => {
    const empty: ICellSegmenter = {
      segmentCells: async (img) => ({
        labels: new Uint32Array(img.width * img.height), width: img.width, height: img.height, count: 0,
      }),
    };
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    expect(await tool.segmentBoxes(host, empty)).toBe(0);
    expect(get()).toHaveLength(1);
    expect(get()[0].bounds).toBeInstanceOf(Rectangle); // untouched
  });
});

describe('CellSegmentToolService — async commit (RT-6, RT-14)', () => {
  let tool: CellSegmentToolService;
  beforeEach(() => { tool = new CellSegmentToolService(); });

  /** A segmenter that waits for `release()` before answering. */
  function gatedSegmenter() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = fakeSegmenter();
    const segmenter: ICellSegmenter = {
      segmentCells: async (img, p) => { await gate; return inner.segmentCells(img, p); },
    };
    return { segmenter, release };
  }

  it('keeps a region drawn while the segmenter was running', async () => {
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    const { segmenter, release } = gatedSegmenter();
    const run = tool.segmentBoxes(host, segmenter);
    await new Promise((r) => setTimeout(r, 5));
    host.setRegions([...get(), rectRegion(0, 0, 2, 2)].map((r) => r)); // the user draws meanwhile
    const drawn = get()[get().length - 1];
    release();
    await run;
    expect(get()).toContain(drawn);
    expect(get().filter((r) => r.bounds instanceof Rectangle)).toHaveLength(1); // the prompt was consumed
  });

  it('ignores a second run while one is in flight', async () => {
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    const { segmenter, release } = gatedSegmenter();
    const first = tool.segmentBoxes(host, segmenter);
    const second = tool.segmentBoxes(host, segmenter);
    release();
    expect(await second).toBe(0);
    expect(await first).toBe(2);
    expect(get()).toHaveLength(2);
  });

  it('maps rows with the Y ratio', async () => {
    const { host, get } = makeHost([rectRegion(8, 16, 24, 48)]);
    const cached = host.getCachedImageData()!;
    cached.ratios = [1, 2]; // rows are 2 data units tall
    await tool.segmentBoxes(host, fakeSegmenter());
    const ys = get().flatMap((r) => (r.bounds as Polygon).ypoints);
    // The cells stay inside the prompt box's data extent (16..64), not 8..32 or 32..128.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(16);
    expect(Math.max(...ys)).toBeLessThanOrEqual(64);
    expect(Math.max(...ys)).toBeGreaterThan(40);
  });
});
