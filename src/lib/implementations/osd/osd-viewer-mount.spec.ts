import type * as OpenSeadragon from 'openseadragon';

import { OSD_OPEN_TIMEOUT_MS, openViewer } from './osd-viewer-mount';

/** A viewer whose once-handlers the test fires by name. */
function fakeViewer() {
  const once: Record<string, (e?: unknown) => void> = {};
  const viewer = {
    addOnceHandler: (name: string, fn: (e?: unknown) => void) => {
      once[name] = fn;
    },
    open: jest.fn(),
  };
  const fire = (name: string, e?: unknown) => once[name]?.(e);
  return { viewer: viewer as unknown as OpenSeadragon.Viewer, fire, raw: viewer };
}

describe('openViewer', () => {
  afterEach(() => jest.useRealTimers());

  it('opens the source and resolves true after the open wiring ran', async () => {
    const { viewer, fire, raw } = fakeViewer();
    const onOpen = jest.fn();
    const opened = openViewer(viewer, { type: 'image', url: 'blob:x' }, onOpen);
    expect(raw.open).toHaveBeenCalledWith({ type: 'image', url: 'blob:x' });
    fire('open');
    await expect(opened).resolves.toBe(true);
    expect(onOpen).toHaveBeenCalledWith(viewer);
  });

  it('resolves false on open-failed, and ignores a late open', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer, fire } = fakeViewer();
    const onOpen = jest.fn();
    const opened = openViewer(viewer, {}, onOpen);
    fire('open-failed', { message: 'bad source' });
    fire('open');
    await expect(opened).resolves.toBe(false);
    warn.mockRestore();
  });

  it('always settles: false when OSD never answers', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewer } = fakeViewer();
    const opened = openViewer(viewer, {}, jest.fn());
    jest.advanceTimersByTime(OSD_OPEN_TIMEOUT_MS);
    await expect(opened).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[OSD] viewer open timed out');
    warn.mockRestore();
  });
});
