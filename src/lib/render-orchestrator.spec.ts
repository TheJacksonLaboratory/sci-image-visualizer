import { RenderOrchestrator, SliceScrubber, TwoPassRenderHost } from './render-orchestrator';

/**
 * Unit tests for the render sequencing extracted from VisualizerComponent
 * (refactoring plan, Step 7) — the five completion paths and the large-tier
 * retry, previously untestable inside the component's subscription closure.
 */
describe('RenderOrchestrator', () => {
  const INFO: any = { fileName: 'img.tif', urls: ['u'] };
  const SMALL: any = { fileName: 'img.tif', urls: ['s'] };

  let host: jest.Mocked<TwoPassRenderHost>;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    const track = (name: string, impl?: (...a: any[]) => any) =>
      jest.fn((...a: any[]) => { calls.push(name); return impl?.(...a); });
    host = {
      renderPhase: track('renderPhase', () => Promise.resolve(true)) as any,
      smallShown: track('smallShown') as any,
      sharpenSettled: track('sharpenSettled') as any,
      finished: jest.fn((viaSmall: boolean, tag: string) => { calls.push(`finished(${viaSmall})`); void tag; }) as any,
      sharpenFailed: track('sharpenFailed') as any,
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('single-pass success: one phase, full finalize', async () => {
    await new RenderOrchestrator(host, 0).render(INFO, null);
    expect(host.renderPhase).toHaveBeenCalledTimes(1);
    expect(host.renderPhase).toHaveBeenCalledWith(INFO, false);
    expect(host.finished).toHaveBeenCalledWith(false, 'finished plotting');
    expect(host.smallShown).not.toHaveBeenCalled();
  });

  it('single-pass failure still finalizes (overlay must never get stuck)', async () => {
    host.renderPhase.mockRejectedValueOnce(new Error('503'));
    await new RenderOrchestrator(host, 0).render(INFO, null);
    expect(host.finished).toHaveBeenCalledWith(false, 'plotting aborted');
  });

  it('two-pass happy path: small shown → large in place → finished(viaSmall)', async () => {
    await new RenderOrchestrator(host, 0).render(INFO, SMALL);
    expect(host.renderPhase).toHaveBeenNthCalledWith(1, SMALL, false);
    expect(host.renderPhase).toHaveBeenNthCalledWith(2, INFO, true);
    expect(calls).toEqual(['renderPhase', 'smallShown', 'renderPhase', 'sharpenSettled', 'finished(true)']);
  });

  it('small-tier failure falls back to large with the overlay kept up', async () => {
    host.renderPhase
      .mockRejectedValueOnce(new Error('no tiers'))
      .mockResolvedValue(true as any);
    await new RenderOrchestrator(host, 0).render(INFO, SMALL);
    expect(host.smallShown).not.toHaveBeenCalled();
    expect(host.finished).toHaveBeenCalledWith(false, 'finished plotting (large only after small fallback)');
  });

  it('large tier retries once after the delay and succeeds', async () => {
    jest.useFakeTimers();
    host.renderPhase
      .mockResolvedValueOnce(true as any)            // small
      .mockRejectedValueOnce(new Error('503'))       // large, attempt 1
      .mockResolvedValueOnce(true as any);           // large, attempt 2
    const done = new RenderOrchestrator(host, 1000).render(INFO, SMALL);
    await jest.advanceTimersByTimeAsync(999);
    expect(host.renderPhase).toHaveBeenCalledTimes(2); // retry not fired yet
    await jest.advanceTimersByTimeAsync(1);
    await done;
    expect(host.renderPhase).toHaveBeenCalledTimes(3);
    expect(host.finished).toHaveBeenCalledWith(true, expect.any(String));
    expect(host.sharpenFailed).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('both large attempts failing reports sharpenFailed (small stays as fallback)', async () => {
    host.renderPhase
      .mockResolvedValueOnce(true as any)            // small
      .mockRejectedValue(new Error('503'));          // large, both attempts
    await new RenderOrchestrator(host, 0).render(INFO, SMALL);
    expect(host.sharpenSettled).toHaveBeenCalled();  // spinner always released
    expect(host.sharpenFailed).toHaveBeenCalled();
    expect(host.finished).not.toHaveBeenCalled();
  });
});

describe('SliceScrubber', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('coalesces rapid scrubs into one application of the last value', () => {
    const apply = jest.fn();
    const s = new SliceScrubber(apply, 120);
    s.scrub(1); s.scrub(2); s.scrub(3);
    expect(apply).not.toHaveBeenCalled();
    jest.advanceTimersByTime(120);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(3);
  });

  it('commit applies immediately and drops a pending scrub', () => {
    const apply = jest.fn();
    const s = new SliceScrubber(apply, 120);
    s.scrub(1);
    s.commit(7);
    expect(apply).toHaveBeenCalledWith(7);
    jest.advanceTimersByTime(500);
    expect(apply).toHaveBeenCalledTimes(1); // pending scrub was cancelled
  });

  it('cancel drops a pending scrub without applying', () => {
    const apply = jest.fn();
    const s = new SliceScrubber(apply, 120);
    s.scrub(1);
    s.cancel();
    jest.advanceTimersByTime(500);
    expect(apply).not.toHaveBeenCalled();
  });
});
