import { BehaviorSubject } from 'rxjs';

import {
  CELLPOSE_MAX_NETWORK_PIXELS,
  CELLPOSE_REGION_SOURCE,
  CellSegmentToolService,
  planViewTiles,
} from './cell-segment-tool.service';
import { CachedImageData, CanvasToolHost } from '../tool-kit/canvas-tool';
import { ICellSegmenter, CellSegmentation } from '../../contracts/cell-segmenter.contract';
import { Region, Rectangle, Polygon } from '../../models/region';

const W = 40,
  H = 40;

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
    frames: [frame],
    width: W,
    height: H,
    ratios: [1],
    isGrayscale: true,
    originX: 0,
    originY: 0,
  };
  const host: CanvasToolHost = {
    getOverlayContainer: () => document.createElement('div'),
    getCachedImageData: () => cached,
    getCoordinateTransform: () => ({
      isReady: () => true,
      clientToData: (x, y) => ({ x, y }),
      dataLengthToScreen: (n) => n,
    }),
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
  beforeEach(() => {
    tool = new CellSegmentToolService();
  });

  it('crops each rectangle, cellpose-segments it, and adds a region per cell', async () => {
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    const added = await tool.segmentBoxes(host, fakeSegmenter());
    expect(added).toBe(2); // two cells in the crop
    const regs = get();
    expect(regs).toHaveLength(2); // prompt rectangle replaced by 2 cell regions
    expect(regs.every((r) => r.bounds instanceof Polygon)).toBe(true);
    expect(regs.every((r) => r.label === 'cell')).toBe(true);
  });

  it('inherits the source box color for every cell region', async () => {
    const rect = rectRegion(8, 8, 24, 24);
    rect.color = '#00bcd4'; // distinct, non-default
    const { host, get } = makeHost([rect]);
    await tool.segmentBoxes(host, fakeSegmenter());
    expect(get().every((r) => r.color === '#00bcd4')).toBe(true);
  });

  it("surfaces the segmenter's phase status (so the toast is meaningful)", async () => {
    const statuses: string[] = [];
    tool.status$.subscribe((s) => {
      if (s) statuses.push(s);
    });
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
        labels: new Uint32Array(img.width * img.height),
        width: img.width,
        height: img.height,
        count: 0,
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
  beforeEach(() => {
    tool = new CellSegmentToolService();
  });

  /** A segmenter that waits for `release()` before answering. */
  function gatedSegmenter() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = fakeSegmenter();
    const segmenter: ICellSegmenter = {
      segmentCells: async (img, p) => {
        await gate;
        return inner.segmentCells(img, p);
      },
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

describe('CellSegmentToolService — box diameter (#98)', () => {
  it('hands the segmenter the cell diameter in crop pixels', async () => {
    const tool = new CellSegmentToolService();
    const seen: (number | undefined)[] = [];
    const inner = fakeSegmenter();
    const seg: ICellSegmenter = {
      segmentCells: (img, p, o) => {
        seen.push(o?.diameter);
        return inner.segmentCells(img, p);
      },
    };
    const { host } = makeHost([rectRegion(8, 8, 24, 24)]);
    host.getCachedImageData()!.ratios = [4]; // each readback pixel is 4 image pixels
    await tool.segmentBoxes(host, seg, { diameterPx: 40 });
    expect(seen).toEqual([10]);
  });
});

describe('CellSegmentToolService.segmentView (#97)', () => {
  /** A viewer showing image px 100..140 x 200..240 as 40×40 screen pixels. */
  function makeViz(regions: Region[] = []) {
    let regs = regions;
    const data = new Uint8ClampedArray(40 * 40 * 4).fill(120);
    const viz = {
      getDisplayedPixelData: () => ({ width: 40, height: 40, channels: 4, data }),
      getDisplayedSourceRect: () => ({ x: 100, y: 200, width: 40, height: 40 }),
      getTrueImageSize: () => ({ width: 1000, height: 1000 }),
      getImageMeta: () => new BehaviorSubject([{ z: 1 }]),
      getRegions: () => regs,
      setRegions: (r: Region[]) => {
        regs = r;
      },
    };
    return { viz: viz as any, get: () => regs };
  }

  it('segments the whole view with no rectangle and maps cells onto the image', async () => {
    const tool = new CellSegmentToolService();
    const { viz, get } = makeViz();
    expect(await tool.segmentView(viz, fakeSegmenter())).toBe(2);
    const regs = get();
    expect(regs.every((r) => r.label === 'cell' && r.source === CELLPOSE_REGION_SOURCE)).toBe(true);
    const xs = regs.flatMap((r) => (r.bounds as Polygon).xpoints);
    const ys = regs.flatMap((r) => (r.bounds as Polygon).ypoints);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(100);
    expect(Math.max(...xs)).toBeLessThanOrEqual(140);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...ys)).toBeLessThanOrEqual(240);
  });

  it('replaces its earlier cells in the area and keeps everything else', async () => {
    const tool = new CellSegmentToolService();
    const old = rectRegion(110, 210, 4, 4);
    old.source = CELLPOSE_REGION_SOURCE;
    const elsewhere = rectRegion(500, 500, 4, 4);
    elsewhere.source = CELLPOSE_REGION_SOURCE;
    const drawn = rectRegion(115, 215, 4, 4); // hand-drawn: no source
    const { viz, get } = makeViz([old, elsewhere, drawn]);
    await tool.segmentView(viz, fakeSegmenter());
    expect(get()).not.toContain(old);
    expect(get()).toContain(elsewhere);
    expect(get()).toContain(drawn);
    expect(get()).toHaveLength(4);
  });

  it('samples at the diameter scale and passes the diameter in sample pixels', async () => {
    const tool = new CellSegmentToolService();
    const sizes: [number, number, number | undefined][] = [];
    const inner = fakeSegmenter();
    const seg: ICellSegmenter = {
      segmentCells: (img, p, o) => {
        sizes.push([img.width, img.height, o?.diameter]);
        return inner.segmentCells(img, p);
      },
    };
    const { viz } = makeViz();
    // Read at full resolution (the 40-px view stays 40 px); the segmenter is told the cells
    // are 60 px and rescales them itself, returning masks at full resolution.
    await tool.segmentView(viz, seg, { diameterPx: 60 });
    expect(sizes).toEqual([[40, 40, 60]]);
  });
});

describe('CellSegmentToolService — image or slice changed mid-run (#105 review)', () => {
  it('discards a whole-view result when the slice changed during inference', async () => {
    const tool = new CellSegmentToolService();
    let slice = 0;
    let regs: Region[] = [];
    const data = new Uint8ClampedArray(40 * 40 * 4).fill(120);
    const viz = {
      getDisplayedPixelData: () => ({ width: 40, height: 40, channels: 4, data }),
      getDisplayedSourceRect: () => ({ x: 0, y: 0, width: 40, height: 40 }),
      getTrueImageSize: () => ({ width: 40, height: 40 }),
      getRegions: () => regs,
      setRegions: (r: Region[]) => {
        regs = r;
      },
    };
    const inner = fakeSegmenter();
    const seg: ICellSegmenter = {
      segmentCells: async (img, p) => {
        slice = 1; // the user moves to the next slice while the model runs
        return inner.segmentCells(img, p);
      },
    };
    const slice1Cell = rectRegion(10, 10, 4, 4);
    slice1Cell.source = CELLPOSE_REGION_SOURCE;
    regs = [slice1Cell];

    expect(await tool.segmentView(viz as any, seg, { context: () => `img|${slice}` })).toBe(0);
    expect(regs).toEqual([slice1Cell]); // slice 1's cells are untouched
    expect(tool.status$.value).toMatch(/changed during the run/);
  });

  it('discards a rectangle result when the slice changed during inference', async () => {
    const tool = new CellSegmentToolService();
    let slice = 0;
    const inner = fakeSegmenter();
    const seg: ICellSegmenter = {
      segmentCells: async (img, p) => {
        slice = 1;
        return inner.segmentCells(img, p);
      },
    };
    const { host, get } = makeHost([rectRegion(8, 8, 24, 24)]);
    const before = get();
    expect(await tool.segmentBoxes(host, seg, { context: () => `img|${slice}` })).toBe(0);
    expect(get()).toBe(before);
  });
});

describe('planViewTiles', () => {
  it('reads a small view at full resolution in one tile', () => {
    const plan = planViewTiles({ x: 0, y: 0, width: 1000, height: 800 }, 500, 40);
    expect(plan).toMatchObject({ factor: 1, shrink: 1, coarse: false });
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0].rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('splits a large view into overlapping tiles whose cores cover it exactly', () => {
    const view = { x: 100, y: 200, width: 6000, height: 3000 };
    const plan = planViewTiles(view, 1500, 40);
    expect(plan.factor).toBe(1);
    expect(plan.tiles.length).toBeGreaterThan(4);
    const coreArea = plan.tiles.reduce((a, t) => a + t.core.width * t.core.height, 0);
    expect(coreArea).toBeCloseTo(view.width * view.height);
    for (const t of plan.tiles) {
      // Each tile reaches past its core (inside the view), and fits the rescale limit.
      expect(t.rect.x).toBeLessThanOrEqual(t.core.x);
      expect(t.rect.x + t.rect.width).toBeGreaterThanOrEqual(t.core.x + t.core.width);
      expect(t.rect.x).toBeGreaterThanOrEqual(view.x);
      expect(Math.max(t.rect.width, t.rect.height)).toBeLessThanOrEqual(2048);
    }
  });

  it('reads a view past the area budget coarser, and says so', () => {
    const plan = planViewTiles({ x: 0, y: 0, width: 12000, height: 12000 }, 1500, 40);
    expect(plan.factor).toBeCloseTo(2);
    expect(plan.coarse).toBe(true);
  });

  it('gives the network smaller cells past its budget', () => {
    // 6000² of 10-px cells: the network would need 9× the area.
    const plan = planViewTiles({ x: 0, y: 0, width: 6000, height: 6000 }, 1500, 10);
    expect(plan.shrink).toBeCloseTo(Math.sqrt((36e6 * 9) / CELLPOSE_MAX_NETWORK_PIXELS));
    expect(plan.coarse).toBe(true);
  });

  it('keeps the screen scale without a diameter', () => {
    const plan = planViewTiles({ x: 0, y: 0, width: 4000, height: 2000 }, 1000, null);
    expect(plan).toMatchObject({ factor: 4, diameterPx: null, coarse: false });
    expect(plan.tiles).toHaveLength(1);
  });
});

describe('CellSegmentToolService.segmentView — tiles (A+B+C)', () => {
  /** A 3000×1000 view shown 1:1 (two tiles at a 30-px diameter). */
  function wideViz() {
    let regs: Region[] = [];
    const data = new Uint8ClampedArray(3000 * 1000 * 4).fill(120);
    const viz = {
      getDisplayedPixelData: () => ({ width: 3000, height: 1000, channels: 4, data }),
      getDisplayedSourceRect: () => ({ x: 0, y: 0, width: 3000, height: 1000 }),
      getTrueImageSize: () => ({ width: 3000, height: 1000 }),
      getRegions: () => regs,
      setRegions: (r: Region[]) => {
        regs = r;
      },
    };
    return { viz: viz as any, get: () => regs };
  }

  it('keeps a cell on a tile seam once', async () => {
    const tool = new CellSegmentToolService();
    const rects: number[] = [];
    let call = 0;
    // One 20-px cell at image x 1490..1510, the seam between the two tiles' cores. Each
    // tile sees it (the tiles overlap), at its own pixel offset.
    const seg: ICellSegmenter = {
      segmentCells: async (img) => {
        rects.push(img.width);
        // Tiles run left to right: the second starts where the view's width minus its own.
        const offset = call++ === 0 ? 0 : 3000 - img.width;
        const labels = new Uint32Array(img.width * img.height);
        for (let y = 490; y < 510; y++)
          for (let x = 1490 - offset; x < 1510 - offset; x++) labels[y * img.width + x] = 1;
        return { labels, width: img.width, height: img.height, count: 1 };
      },
    };
    const { viz, get } = wideViz();
    expect(await tool.segmentView(viz, seg, { diameterPx: 30 })).toBe(1);
    expect(rects).toHaveLength(2);
    const xs = (get()[0].bounds as Polygon).xpoints;
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1490);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1510);
  });

  it('smooths the traced outline off the pixel grid', async () => {
    const tool = new CellSegmentToolService();
    let regs: Region[] = [];
    const data = new Uint8ClampedArray(40 * 40 * 4).fill(120);
    const viz = {
      getDisplayedPixelData: () => ({ width: 40, height: 40, channels: 4, data }),
      getDisplayedSourceRect: () => ({ x: 0, y: 0, width: 40, height: 40 }),
      getTrueImageSize: () => ({ width: 40, height: 40 }),
      getRegions: () => regs,
      setRegions: (r: Region[]) => {
        regs = r;
      },
    };
    const get = () => regs;
    await tool.segmentView(viz as any, fakeSegmenter());
    const poly = get()[0].bounds as Polygon;
    // A traced outline has only whole-pixel corners; a smoothed one cuts them.
    expect(poly.xpoints.some((x) => !Number.isInteger(x))).toBe(true);
  });
});
