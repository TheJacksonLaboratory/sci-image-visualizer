import { SamToolService } from './sam-tool.service';
import { WandService } from './wand.service';
import { CachedImageData, WandToolHost } from './wand-tool.service';
import { ISamSession, SamEmbedding, SamPrompt } from '../contracts/sam.contract';
import { Region, Rectangle, Polygon } from '../models/region';
import { setSamModelUrls, getSamModel, DEFAULT_SAM_MODEL_ID } from './sam-model-registry';

const W = 40, H = 40;

function rectRegion(x: number, y: number, w: number, h: number): Region {
  const rect = Object.assign(new Rectangle(), { x, y, width: w, height: h });
  const r = new Region();
  r.bounds = rect;
  return r;
}

/** Fake SAM session: `decode` fills the prompt box into a full-frame mask, so
 *  WandService.maskToPolygons traces it back to a polygon region. */
function fakeSession(): ISamSession {
  return {
    loadModel: async () => undefined,
    isLoaded: () => true,
    dispose: () => undefined,
    embed: async (): Promise<SamEmbedding> =>
      ({ data: new Float32Array(1), dims: [1, 1, 1, 1], scale: 1, imageWidth: W, imageHeight: H }),
    decode: async (_e, prompt: SamPrompt) => {
      const mask = new Uint8Array(W * H);
      const b = prompt.box!;
      const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(W, Math.ceil(b.x1));
      const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(H, Math.ceil(b.y1));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = 1;
      return { mask, width: W, height: H, iou: 0.9 };
    },
  };
}

function makeHost(regions: Region[]): { host: WandToolHost; get: () => Region[] } {
  let regs = regions;
  const frame = Array.from({ length: H }, () => new Array(W).fill(0));
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
    setRegions: (r: Region[]) => { regs = r; },
    getFileName: () => 'test.tif',
    getShapeColor: () => '#ffffff',
  };
  return { host, get: () => regs };
}

describe('SamToolService', () => {
  let tool: SamToolService;

  beforeEach(() => {
    tool = new SamToolService(new WandService());
    tool.useSession(fakeSession());
  });

  it('segments each rectangle into a labelled polygon region', async () => {
    const { host, get } = makeHost([rectRegion(10, 10, 20, 20)]);
    tool.bindHost(host);

    const added = await tool.segmentBoxes();

    expect(added).toBe(1);
    const regs = get();
    expect(regs).toHaveLength(2);                 // original rect + new mask region
    const mask = regs[1];
    expect(mask.bounds).toBeInstanceOf(Polygon);
    expect(mask.label).toBe('sam');
    expect(mask.color).toBe('#ffffff');
  });

  it('segments multiple rectangles in one pass', async () => {
    const { host, get } = makeHost([rectRegion(2, 2, 12, 12), rectRegion(22, 22, 14, 14)]);
    tool.bindHost(host);
    const added = await tool.segmentBoxes();
    expect(added).toBe(2);
    expect(get()).toHaveLength(4);
  });

  it('is a no-op with a clear status when no rectangles are drawn', async () => {
    const { host } = makeHost([]);
    tool.bindHost(host);
    const added = await tool.segmentBoxes();
    expect(added).toBe(0);
    expect(tool.status$.value).toMatch(/rectangle/i);
  });

  it('reuses one embedding across boxes (encoder runs once)', async () => {
    const session = fakeSession();
    const embedSpy = jest.spyOn(session, 'embed');
    tool.useSession(session);
    const { host } = makeHost([rectRegion(2, 2, 10, 10), rectRegion(20, 20, 10, 10)]);
    tool.bindHost(host);
    await tool.segmentBoxes();
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });

  it('fails gracefully when the model has no ONNX URLs configured', async () => {
    setSamModelUrls(DEFAULT_SAM_MODEL_ID, '', ''); // ensure unconfigured
    const fresh = new SamToolService(new WandService()); // no session injected
    const { host, get } = makeHost([rectRegion(10, 10, 20, 20)]);
    fresh.bindHost(host);
    const added = await fresh.segmentBoxes();
    expect(added).toBe(0);
    expect(tool['model'] && getSamModel(DEFAULT_SAM_MODEL_ID).encoderUrl).toBe('');
    expect(fresh.status$.value).toMatch(/not configured/i);
    expect(get()).toHaveLength(1); // nothing added
  });
});
