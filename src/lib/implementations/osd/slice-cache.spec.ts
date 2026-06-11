import { SliceCache, SliceCacheHost } from './slice-cache';

/**
 * Unit tests for the slice cache (refactoring plan, Step 3) — the logic that
 * was previously untestable inside the visualizer service: LRU eviction,
 * load-token cancellation, rapid-scrub dedupe, background-loader gating, and
 * channel-group reveal.
 */

interface FakeItem {
  z: number;
  fullyLoaded: boolean;
  setOpacity: jest.Mock;
  getFullyLoaded: () => boolean;
}

function makeItem(z: number, fullyLoaded = true): FakeItem {
  const it: any = {
    z,
    fullyLoaded,
    setOpacity: jest.fn(),
  };
  it.getFullyLoaded = () => it.fullyLoaded;
  return it;
}

/** Fake viewer: records addTiledImage calls; success is fired manually so the
 *  tests control async ordering exactly like OSD's real callback timing. */
function makeViewer() {
  const items: any[] = [];
  const pending: Array<{ opts: any }> = [];
  return {
    items,
    pending,
    world: {
      getIndexOfItem: (it: any) => items.indexOf(it),
      removeItem: jest.fn((it: any) => {
        const i = items.indexOf(it);
        if (i >= 0) items.splice(i, 1);
      }),
    },
    addTiledImage: jest.fn((opts: any) => pending.push({ opts })),
    /** Resolve the oldest pending add with a fake item. */
    succeedNext(z: number, fullyLoaded = true): FakeItem {
      const p = pending.shift()!;
      const item = makeItem(z, fullyLoaded);
      items.push(item);
      p.opts.success({ item });
      return item;
    },
  };
}

describe('SliceCache', () => {
  let viewer: ReturnType<typeof makeViewer>;
  let host: SliceCacheHost & { state: any };
  let cache: SliceCache;
  let onAdded: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    viewer = makeViewer();
    onAdded = jest.fn();
    const state = {
      currentZ: 0,
      sliceCount: 5,
      isMultiChannel: false,
      channelCount: 2,
      visible: [true, true],
    };
    host = {
      state,
      viewer: () => viewer,
      hasImage: () => true,
      sliceCount: () => state.sliceCount,
      currentZ: () => state.currentZ,
      isMultiChannel: () => state.isMultiChannel,
      channelCount: () => state.channelCount,
      channelVisible: (c: number) => state.visible[c] !== false,
      buildTileSource: (z: number, channel?: number) => ({ z, channel }),
      onCompositeSliceAdded: onAdded,
    };
    cache = new SliceCache(host);
    cache.configure(state.sliceCount, 10); // 5-deep stack, prefetch allowed
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── composite slices ──────────────────────────────────────────────────
  it('adds an uncached slice hidden+preloaded, then reveals it when it lands on the current z', () => {
    host.state.currentZ = 1;
    cache.showSlice(1);
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(1);
    const opts = viewer.addTiledImage.mock.calls[0][0];
    expect(opts.opacity).toBe(0);
    expect(opts.preload).toBe(true);

    const item = viewer.succeedNext(1);
    expect(onAdded).toHaveBeenCalledWith(1); // window sampling triggered
    expect(item.setOpacity).toHaveBeenCalledWith(1); // revealed (still current)
  });

  it('caches but does NOT reveal a slice the user has scrubbed away from', () => {
    host.state.currentZ = 1;
    cache.showSlice(1);
    host.state.currentZ = 3; // user moved on before tiles landed
    const item = viewer.succeedNext(1);
    expect(item.setOpacity).not.toHaveBeenCalledWith(1);
  });

  it('revisiting a cached slice is an opacity toggle — no new add', () => {
    host.state.currentZ = 1;
    cache.showSlice(1);
    const item1 = viewer.succeedNext(1);
    host.state.currentZ = 2;
    cache.showSlice(2);
    viewer.succeedNext(2);

    viewer.addTiledImage.mockClear();
    host.state.currentZ = 1;
    cache.showSlice(1);
    expect(viewer.addTiledImage).not.toHaveBeenCalled();
    expect(item1.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it('dedupes rapid scrubbing — a slice already being added is not added twice', () => {
    cache.showSlice(2);
    cache.showSlice(2);
    cache.showSlice(2);
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(1);
  });

  // ── load-token cancellation ───────────────────────────────────────────
  it('drops a stale add when the image was switched mid-flight (token bump)', () => {
    cache.showSlice(2);
    cache.cancelBackgroundLoad(); // image switch: bumps the token
    const item = viewer.succeedNext(2); // old callback fires late
    expect(viewer.world.removeItem).toHaveBeenCalledWith(item); // orphan dropped
    // …and the slice is NOT cached: showing it again must re-add.
    viewer.addTiledImage.mockClear();
    cache.showSlice(2);
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(1);
  });

  // ── LRU eviction ──────────────────────────────────────────────────────
  it('evicts the least-recently-used slice beyond the cap, never the current one', () => {
    cache.configure(2, 10); // cap = 2 resident slices
    host.state.currentZ = 0;
    cache.showSlice(0);
    const i0 = viewer.succeedNext(0);
    host.state.currentZ = 1;
    cache.showSlice(1);
    viewer.succeedNext(1);
    host.state.currentZ = 2;
    cache.showSlice(2);
    viewer.succeedNext(2);

    // Cap 2 with three slices resident → slice 0 (least recent, not current) goes.
    expect(viewer.world.removeItem).toHaveBeenCalledWith(i0);
    viewer.addTiledImage.mockClear();
    host.state.currentZ = 0;
    cache.showSlice(0); // re-show → must re-add (was evicted)
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(1);
  });

  // ── background loader ─────────────────────────────────────────────────
  it('prefetch adds the nearest uncached slice once the current slice is idle', () => {
    host.state.currentZ = 2;
    cache.showSlice(2);
    viewer.succeedNext(2, true); // fully loaded → loader may proceed
    viewer.addTiledImage.mockClear();

    cache.schedulePrefetch();
    jest.advanceTimersByTime(250);
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(1);
    // Nearest-first: distance 1 below the current slice is tried first.
    expect(viewer.addTiledImage.mock.calls[0][0].tileSource.z).toBe(1);
  });

  it('prefetch yields while the visible slice is still streaming tiles', () => {
    host.state.currentZ = 2;
    cache.showSlice(2);
    viewer.succeedNext(2, false); // tiles still streaming
    viewer.addTiledImage.mockClear();

    cache.schedulePrefetch();
    jest.advanceTimersByTime(250);
    expect(viewer.addTiledImage).not.toHaveBeenCalled(); // yielded, rescheduled
  });

  it('gates on the in-flight background slice until its tiles finish (then advances)', () => {
    host.state.currentZ = 2;
    cache.showSlice(2);
    viewer.succeedNext(2, true);
    viewer.addTiledImage.mockClear();

    cache.schedulePrefetch();
    jest.advanceTimersByTime(250); // loader starts slice 1…
    const bgItem = viewer.succeedNext(1, false); // …added, tiles still streaming
    jest.advanceTimersByTime(250); // poll: still streaming → no new add
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(1);

    bgItem.fullyLoaded = true; // tiles land
    jest.advanceTimersByTime(250); // poll: advance to the next slice
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(2);
    expect(viewer.addTiledImage.mock.calls[1][0].tileSource.z).toBe(3);
  });

  it('skips prefetch entirely for stacks over the fit-tile budget', () => {
    cache.configure(5, 10_000); // way over MAX_PREFETCH_FIT_TILES
    cache.schedulePrefetch();
    jest.advanceTimersByTime(500);
    expect(viewer.addTiledImage).not.toHaveBeenCalled();
  });

  // ── multichannel groups ───────────────────────────────────────────────
  it('adds one TiledImage per channel (lighter compositing) and reveals per visibility', () => {
    host.state.isMultiChannel = true;
    host.state.currentZ = 0;
    host.state.visible = [true, false];
    cache.showSlice(0);
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(2);
    expect(viewer.addTiledImage.mock.calls[0][0].compositeOperation).toBe('lighter');

    const c0 = viewer.succeedNext(0);
    const c1 = viewer.succeedNext(0);
    expect(c0.setOpacity).toHaveBeenLastCalledWith(1); // visible channel
    expect(c1.setOpacity).toHaveBeenLastCalledWith(0); // hidden channel
  });

  it('re-tints a stale multichannel slice when revealed after a display change', () => {
    host.state.isMultiChannel = true;
    host.state.currentZ = 0;
    cache.showSlice(0);
    const a0 = viewer.succeedNext(0);
    const a1 = viewer.succeedNext(0);
    (a0 as any).requestInvalidate = jest.fn();
    (a1 as any).requestInvalidate = jest.fn();
    host.state.currentZ = 1;
    cache.showSlice(1);
    viewer.succeedNext(1);
    viewer.succeedNext(1);

    cache.invalidateChannelDisplay(1); // display change while 0 is hidden → 0 marked stale

    host.state.currentZ = 0;
    cache.showSlice(0); // revisit → stale tint re-applied
    expect((a0 as any).requestInvalidate).toHaveBeenCalled();
    expect((a1 as any).requestInvalidate).toHaveBeenCalled();
  });

  // ── reset / teardown ──────────────────────────────────────────────────
  it('reset() empties the cache so every slice re-adds', () => {
    cache.showSlice(0);
    viewer.succeedNext(0);
    cache.reset();
    viewer.addTiledImage.mockClear();
    cache.showSlice(0);
    expect(viewer.addTiledImage).toHaveBeenCalledTimes(1);
  });
});
