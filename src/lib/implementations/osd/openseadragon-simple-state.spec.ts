import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { OpenSeadragonVisualizerService } from './openseadragon-visualizer.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { PlotType } from '../../contracts/plot-type';
import { IImageInfo } from '../../contracts/image.contract';
import { VisualizerStore } from '../../store/visualizer-store.service';

/**
 * Mounted-image lifecycle against a fake viewer (review OSD-PLOTLY-1, -4, -5, -6).
 *
 * Simple-mode state must not outlive the simple image (OSD-PLOTLY-1).
 *
 * `simpleMultichannel` used to be written only by loadSimple(), so after a
 * serverless multichannel image a later TILED image kept the flag: every
 * channel-state emission re-opened the tiled viewer with the previous image's
 * composite and skipped the tile invalidation.
 *
 * `./osd-lib` is mocked so plot() can construct a viewer without a canvas: the
 * factory hands back a recording fake (the viewer never fires 'open', which is
 * fine — the bug is in the store subscription, not the open handler).
 */
interface FakeViewer {
  open: jest.Mock;
  destroy: jest.Mock;
  addHandler: jest.Mock;
  addOnceHandler: jest.Mock;
  removeHandler: jest.Mock;
  world: { requestInvalidate: jest.Mock; getItemAt: () => null };
}
const viewers: FakeViewer[] = [];

jest.mock('./osd-lib', () => {
  const factory = jest.fn(() => {
    const v: FakeViewer = {
      open: jest.fn(),
      destroy: jest.fn(),
      addHandler: jest.fn(),
      addOnceHandler: jest.fn(),
      removeHandler: jest.fn(),
      world: { requestInvalidate: jest.fn(), getItemAt: () => null },
    };
    viewers.push(v);
    return v;
  });
  Object.assign(factory, {
    TileSource: function TileSource(this: object, spec: object) { Object.assign(this, spec); },
    Point: function Point(this: { x: number; y: number }, x: number, y: number) { this.x = x; this.y = y; },
  });
  return { OSD: factory };
});

describe('OpenSeadragonVisualizerService — image lifecycle and simple-mode state', () => {
  let service: OpenSeadragonVisualizerService;
  let http: HttpTestingController;
  let store: VisualizerStore;

  const descriptor = {
    width: 64, height: 64, tileSize: 64, z: 1, channels: 1, realLevels: 1,
    levels: [{ res: 0, width: 64, height: 64 }],
  };
  const simpleInfo = {
    fileName: 'hyper.tif', tiled: false, isGrayscale: false,
    urls: ['blob:z0'],
    channelUrls: [['blob:z0c0', 'blob:z0c1']],
    trueImageSize: [8, 8],
    imageMeta: [{ rgbChannels: 1, channelCount: 2, x: 8, y: 8, z: 1 }],
  } as unknown as IImageInfo;
  const tiledInfo = {
    fileName: 'slide.tif', isGrayscale: true, urls: ['/api/preview?info=INFO64'],
    trueImageSize: [64, 64],
    imageMeta: [{ rgbChannels: 1, channelCount: 1, x: 64, y: 64, z: 1 }],
  } as unknown as IImageInfo;

  type Internals = {
    loadSimpleChannelPlanes(urls: string[]): Promise<unknown[]>;
    compositeSimpleMultichannel(): Promise<string | undefined>;
    simpleMultichannel: boolean;
    simpleChannelUrls: string[][];
    scheduleInvalidate(): void;
    simpleChannelPlanes: unknown[];
  };
  const internals = () => service as unknown as Internals;

  beforeEach(() => {
    viewers.length = 0;
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        OpenSeadragonVisualizerService,
        ...VIZ_PORT_STUBS,
        {
          provide: TILE_ACCESS_PORT,
          useValue: {
            getSelectedInfoB64: () => 'INFO64',
            getAuthHeaders: () => Promise.resolve({}),
            zoomOnRegion: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }),
            selectDiagramDisplay: () => undefined,
          },
        },
      ],
    });
    service = TestBed.inject(OpenSeadragonVisualizerService);
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(VisualizerStore);
    document.body.innerHTML = '<div id="plotdiv"></div>';
    // jsdom can't decode <img>: stand in two decoded channel planes and a composite.
    jest.spyOn(internals(), 'loadSimpleChannelPlanes').mockImplementation(async () => [
      { data: new Uint8ClampedArray(4), width: 1, height: 1 },
      { data: new Uint8ClampedArray(4), width: 1, height: 1 },
    ]);
    jest.spyOn(internals(), 'compositeSimpleMultichannel').mockResolvedValue('blob:composite');
    // ...and can't decode a single-image slice either (toFullResUrl then keeps the URL).
    jest.spyOn(service as unknown as { loadImageEl(u: string): Promise<unknown> }, 'loadImageEl')
      .mockRejectedValue(new Error('no <img> decode in jsdom'));
  });

  afterEach(() => {
    service.unsubscribe();
    http.match(() => true);
    jest.restoreAllMocks();
  });

  async function loadTiled() {
    const pending = service.load(tiledInfo, 0);
    // getAuthHeaders resolves first, then /tiles/info is polled.
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne((r) => r.url.includes('tiles/info')).flush(descriptor);
    return pending;
  }

  it('a tiled image after a serverless multichannel one recolors via invalidation, not re-open (OSD-PLOTLY-1)', async () => {
    const simpleLoaded = await service.load(simpleInfo, 0);
    void service.plot('plotdiv', simpleLoaded, simpleInfo, 500, PlotType.IMAGE);
    expect(viewers.length).toBe(1);

    const tiledLoaded = await loadTiled();
    expect(tiledLoaded.descriptor).toBeTruthy();
    void service.plot('plotdiv', tiledLoaded, tiledInfo, 500, PlotType.IMAGE);
    expect(viewers.length).toBe(2);
    const tiledViewer = viewers[1];
    tiledViewer.open.mockClear();

    const invalidate = jest.spyOn(internals(), 'scheduleInvalidate');
    store.setChannelStates([{ index: 0, name: 'Intensity', color: '#ffffff', min: 5, max: 200,
      gamma: 1, visible: true }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(tiledViewer.open).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
    expect(internals().simpleChannelPlanes).toEqual([]);
  });
  it('plot() starts the tiled histogram sampling after clearing the sampler (OSD-PLOTLY-4)', async () => {
    // sampler.clear() supersedes every run in flight, so a run started before it
    // (as plot() used to do) would be dropped and the image would never auto-window.
    const sampler = (service as unknown as { sampler: { clear(): void; computeImageWindow(): Promise<void> } })
      .sampler;
    const order: string[] = [];
    jest.spyOn(sampler, 'clear').mockImplementation(() => { order.push('clear'); });
    jest.spyOn(sampler, 'computeImageWindow').mockImplementation(async () => { order.push('sample'); });
    const tiledLoaded = await loadTiled();
    void service.plot('plotdiv', tiledLoaded, tiledInfo, 500, PlotType.IMAGE);
    expect(order).toEqual(['clear', 'sample']);
  });
  // ── load() must not touch the mounted image (OSD-PLOTLY-5) ────────────
  // /tiles/info can poll for minutes; until plot() mounts the new image, the
  // previous one stays on screen and must keep its own descriptor and state.

  it('a pending tiled load() leaves the mounted image\'s descriptor alone', async () => {
    const first = await loadTiled();
    void service.plot('plotdiv', first, tiledInfo, 500, PlotType.IMAGE);
    expect(service.getTrueImageSize()).toEqual({ width: 64, height: 64 });

    const pending = service.load({ ...tiledInfo, fileName: 'other.tif' } as IImageInfo, 0);
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne((r) => r.url.includes('tiles/info')).flush({ ...descriptor, width: 999, height: 777 });
    await pending;
    expect(service.getTrueImageSize()).toEqual({ width: 64, height: 64 });
  });

  it('loading another image leaves the mounted serverless multichannel image\'s state alone', async () => {
    const simpleLoaded = await service.load(simpleInfo, 0);
    void service.plot('plotdiv', simpleLoaded, simpleInfo, 500, PlotType.IMAGE);
    expect(internals().simpleMultichannel).toBe(true);
    expect(internals().simpleChannelUrls).toEqual(simpleInfo.channelUrls);

    await loadTiled(); // not plotted (yet)
    expect(internals().simpleMultichannel).toBe(true);
    expect(internals().simpleChannelUrls).toEqual(simpleInfo.channelUrls);

    await service.load({ ...simpleInfo, fileName: 'single.png', channelUrls: undefined } as IImageInfo, 0);
    expect(internals().simpleMultichannel).toBe(true);
    expect(internals().simpleChannelPlanes).toHaveLength(2);
  });
  // ── serverless-multichannel scrub / recomposite races (OSD-PLOTLY-6) ──

  const plane = (v: number) => ({ data: new Uint8ClampedArray([v, v, v, 255]), width: 1, height: 1 });
  const nextFrame = () => new Promise((r) => setTimeout(r, 40));
  const stackInfo = {
    ...simpleInfo,
    channelUrls: [['z0c0', 'z0c1'], ['z1c0', 'z1c1'], ['z2c0', 'z2c1']],
  } as unknown as IImageInfo;

  async function mountStack() {
    const loaded = await service.load(stackInfo, 0);
    void service.plot('plotdiv', loaded, stackInfo, 500, PlotType.IMAGE);
    return viewers[viewers.length - 1];
  }

  it('a slow scrub that resolves after a newer one does not overwrite its planes', async () => {
    await mountStack();
    const releases: Record<string, () => void> = {};
    (internals().loadSimpleChannelPlanes as unknown as jest.Mock).mockImplementation(
      (urls: string[]) => new Promise((resolve) => {
        const z = Number(urls[0][1]);
        releases[urls[0]] = () => resolve([plane(z), plane(z)]);
      }),
    );
    service.setZIndex(1);
    service.setZIndex(2);
    releases['z2c0']();
    await nextFrame();
    releases['z1c0'](); // z=1 lands last
    await nextFrame();
    expect((internals().simpleChannelPlanes as Array<{ data: Uint8ClampedArray }>)[0].data[0]).toBe(2);
  });

  it('coalesces a burst of channel changes into one recomposite', async () => {
    await mountStack();
    const composite = internals().compositeSimpleMultichannel as unknown as jest.Mock;
    composite.mockClear();
    for (let i = 0; i < 10; i++) {
      store.setChannelState(0, { min: i, max: 200 });
    }
    await nextFrame();
    expect(composite).toHaveBeenCalledTimes(1);
  });

  it('revokes the displayed composite only once the next one has opened', async () => {
    // Distinct URLs: earlier tests' torn-down services may still revoke theirs.
    const composite = internals().compositeSimpleMultichannel as unknown as jest.Mock;
    composite.mockResolvedValue('blob:mounted');
    const viewer = await mountStack();
    await nextFrame(); // let the mount's own (histogram-nudge) recomposite settle
    composite.mockResolvedValue('blob:next');
    const revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    store.setChannelState(0, { min: 1, max: 200 });
    await nextFrame();
    expect(viewer.open).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'blob:next' }));
    expect(revoke).not.toHaveBeenCalledWith('blob:mounted');
    const onOpen = viewer.addHandler.mock.calls.filter(([name]) => name === 'open').map(([, h]) => h);
    onOpen.forEach((h) => h());
    expect(revoke).toHaveBeenCalledWith('blob:mounted');
    expect(revoke).not.toHaveBeenCalledWith('blob:next');
  });
});
