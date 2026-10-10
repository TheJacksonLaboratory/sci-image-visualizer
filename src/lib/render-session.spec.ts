import { ImageRenderSession, RenderSessionHost } from './render-session';
import { IImageInfo } from './contracts/image.contract';
import { PlotType } from './contracts/plot-type';

/** The session is pinned end-to-end through VisualizerComponent (render preemption #5,
 *  CORE-11, image-less datasets); these cover it on its own. */
describe('ImageRenderSession', () => {
  const info = (fileName: string, over: Partial<IImageInfo> = {}): IImageInfo => ({
    fileName,
    urls: ['/0'],
    isStack: false,
    showStack: false,
    isGrayscale: true,
    trueImageSize: [1, 1],
    imageMeta: [],
    scaleRatio: true,
    ...over,
  });

  function setup(over: Partial<RenderSessionHost> = {}) {
    const visualizer = {
      load: jest.fn(
        (i: IImageInfo, _z?: number, _signal?: AbortSignal): Promise<{ filename: string | undefined }> =>
          Promise.resolve({ filename: i.fileName }),
      ),
      plot: jest.fn().mockResolvedValue(true),
      reset: jest.fn(),
      cancelLoading: jest.fn(),
    };
    const host: RenderSessionHost = {
      plotDivName: 'viz-plot-x',
      visualizer: visualizer as never,
      zIndex: () => 0,
      plotType: () => PlotType.IMAGE,
      isHeatmap: () => true,
      isCaching: () => false,
      beforeReset: jest.fn(),
      prepare: jest.fn(),
      releaseOverlay: jest.fn(),
      landed: jest.fn(),
      setImageLoading: jest.fn(),
      alert: jest.fn(),
      detectChanges: jest.fn(),
      ...over,
    };
    return { session: new ImageRenderSession(host), host, visualizer };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('ends the old view, resets, lays the image out, then lands it once', async () => {
    const { session, host, visualizer } = setup();
    session.render(info('a'));
    expect(session.running).toBe(true);
    expect((host.beforeReset as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      visualizer.reset.mock.invocationCallOrder[0],
    );
    expect(host.prepare).toHaveBeenCalled();
    await settle();
    expect(host.releaseOverlay).toHaveBeenCalledTimes(1);
    expect(host.landed).toHaveBeenCalledTimes(1);
    expect(session.running).toBe(false);
  });

  it("a newer render aborts the older one's load and makes its result inert", async () => {
    let resolveA!: (v: { filename: string | undefined }) => void;
    const { session, host, visualizer } = setup();
    visualizer.load.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveA = r;
        }),
    );
    session.render(info('a'));
    const signalA = visualizer.load.mock.calls[0][2] as AbortSignal;
    session.render(info('b'));
    expect(signalA.aborted).toBe(true);
    expect(visualizer.cancelLoading).toHaveBeenCalled();
    resolveA({ filename: 'a' });
    await settle();
    expect(visualizer.plot).toHaveBeenCalledTimes(1); // only b
    expect(host.landed).toHaveBeenCalledTimes(1);
  });

  it('cancel makes the render in flight inert', async () => {
    const { session, host, visualizer } = setup();
    visualizer.load.mockImplementationOnce(
      (_i, _z, signal) =>
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    session.render(info('a'));
    session.cancel();
    await settle();
    expect(session.running).toBe(false);
    expect(host.alert).not.toHaveBeenCalled();
    expect(host.landed).not.toHaveBeenCalled();
  });

  it('renders the small tier first only in a 2D view', () => {
    const tiers = { urls: ['/big'], smallUrls: ['/small'] };
    const flat = setup();
    flat.session.render(info('a', tiers));
    expect(flat.visualizer.load.mock.calls[0][0].urls).toEqual(['/small']);
    const scene = setup({ isHeatmap: () => false });
    scene.session.render(info('a', tiers));
    expect(scene.visualizer.load.mock.calls[0][0].urls).toEqual(['/big']);
  });

  it('holds an image-less draw until the view is ready, and drops it for an image', async () => {
    const dataset = { id: 'd', name: 'D' } as never;
    const waiting = setup();
    await waiting.session.plotWithoutImage(dataset);
    expect(waiting.visualizer.plot).not.toHaveBeenCalled();
    waiting.session.viewIsReady(dataset, false);
    await settle();
    expect(waiting.visualizer.plot.mock.calls[0][2].fileName).toBe('spatial:d');

    const dropped = setup();
    await dropped.session.plotWithoutImage(dataset);
    dropped.session.viewIsReady(dataset, true);
    expect(dropped.visualizer.plot).not.toHaveBeenCalled();
  });
});
