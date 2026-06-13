import { CellSegmentToolService } from './cell-segment-tool.service';
import { WandService } from './wand.service';
import { CachedImageData, WandToolHost } from './wand-tool.service';
import { ICellSegmenter, CellSegmentation } from '../contracts/cell-segmenter.contract';
import { Region, Rectangle, Polygon } from '../models/region';

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

function makeHost(regions: Region[]): { host: WandToolHost; get: () => Region[] } {
  let regs = regions;
  const frame = Array.from({ length: H }, () => new Array(W).fill(120));
  const cached: CachedImageData = {
    frames: [frame], width: W, height: H, ratios: [1], isGrayscale: true, originX: 0, originY: 0,
  };
  const host: WandToolHost = {
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
  beforeEach(() => { tool = new CellSegmentToolService(new WandService()); });

  it('crops each rectangle, cellpose-segments it, and adds a region per cell', async () => {
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    tool.bindHost(host);
    const added = await tool.segmentBoxes(fakeSegmenter());
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
    tool.bindHost(host);
    await tool.segmentBoxes(fakeSegmenter());
    expect(get().every((r) => r.color === '#00bcd4')).toBe(true);
  });

  it('no-ops with a status when no rectangles are drawn', async () => {
    const { host } = makeHost([]);
    tool.bindHost(host);
    expect(await tool.segmentBoxes(fakeSegmenter())).toBe(0);
    expect(tool.status$.value).toMatch(/rectangle/i);
  });

  it('keeps a rectangle whose crop yields no cells', async () => {
    const empty: ICellSegmenter = {
      segmentCells: async (img) => ({
        labels: new Uint32Array(img.width * img.height), width: img.width, height: img.height, count: 0,
      }),
    };
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    tool.bindHost(host);
    expect(await tool.segmentBoxes(empty)).toBe(0);
    expect(get()).toHaveLength(1);
    expect(get()[0].bounds).toBeInstanceOf(Rectangle); // untouched
  });
});
