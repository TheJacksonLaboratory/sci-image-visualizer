import { Subject } from 'rxjs';

import { PlotType } from '../contracts/plot-type';
import {
  PlotModeContext,
  PlotModeSession,
  PlotTypeContribution,
} from '../contracts/plot-type-contribution.contract';
import {
  ActivePlotMode,
  PlotModeController,
  PlotModeControllerHooks,
  normalizeContributions,
} from './plot-mode-controller';

/**
 * The contributed-plot-mode lifecycle, without a visualizer around it: one live
 * session at a time, `deactivate()` exactly once per session whatever races it,
 * and nothing a contribution throws or rejects escaping.
 */

function contribution(id: string, over: Partial<PlotTypeContribution> = {}): PlotTypeContribution {
  return {
    descriptor: { type: id, label: id, productionLabel: id, dimensions: '2d', baseType: PlotType.IMAGE },
    activate: jest.fn(() => ({ deactivate: jest.fn() })),
    ...over,
  };
}

function ctx(ready = true): PlotModeContext {
  return {
    visualizer: {} as any,
    viewport: {
      getOverlayContainer: () => null,
      dataToClient: (x, y) => ({ x, y }),
      clientToData: (x, y) => ({ x, y }),
      dataLengthToScreen: (l) => l,
      isReady: jest.fn(() => ready),
      frame$: new Subject(),
      settled$: new Subject(),
    },
    imageInfo$: new Subject(),
  };
}

function hooks(): jest.Mocked<PlotModeControllerHooks> {
  return { onActivated: jest.fn(), onDeactivating: jest.fn(), onFailed: jest.fn() };
}

const quietLog = () => ({ warn: jest.fn(), error: jest.fn() });

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('normalizeContributions', () => {
  it('keeps valid contributions in registration order', () => {
    const a = contribution('a');
    const b = contribution('b');
    expect(normalizeContributions([a, b], quietLog())).toEqual([a, b]);
  });

  it('treats null (no providers) as empty', () => {
    expect(normalizeContributions(null, quietLog())).toEqual([]);
    expect(normalizeContributions(undefined, quietLog())).toEqual([]);
  });

  it('flattens an array provided as one multi value', () => {
    const a = contribution('a');
    const b = contribution('b');
    expect(normalizeContributions([[a, b]], quietLog())).toEqual([a, b]);
  });

  it('drops a clash with a built-in type, a duplicate id, an unsupported base and a malformed entry', () => {
    const log = quietLog();
    const ok = contribution('dianne');
    const out = normalizeContributions([
      contribution(PlotType.HEATMAP),
      ok,
      contribution('dianne'),
      contribution('volume-thing', {
        descriptor: { type: 'volume-thing', label: 'x', dimensions: '2d', baseType: PlotType.NAPARI_VOLUME },
      }),
      { descriptor: { type: 'no-activate' } },
      null,
    ], log);
    expect(out).toEqual([ok]);
    expect(log.warn).toHaveBeenCalledTimes(5);
  });
});

describe('PlotModeController', () => {
  let h: jest.Mocked<PlotModeControllerHooks>;
  let log: ReturnType<typeof quietLog>;

  beforeEach(() => {
    h = hooks();
    log = quietLog();
  });

  it('resolves a contributed id to its base type, a built-in to itself, and a stale id to IMAGE', () => {
    const c = new PlotModeController([contribution('dianne')], h, log);
    expect(c.baseTypeOf('dianne')).toBe(PlotType.IMAGE);
    expect(c.baseTypeOf(PlotType.CONTOUR)).toBe(PlotType.CONTOUR);
    expect(c.baseTypeOf('gone')).toBe(PlotType.IMAGE);
    expect(c.find('dianne')?.descriptor.type).toBe('dianne');
    expect(c.find(PlotType.IMAGE)).toBeUndefined();
  });

  it('activates a synchronous session and deactivates it exactly once', async () => {
    const session: PlotModeSession = { deactivate: jest.fn() };
    const mode = contribution('dianne', { activate: jest.fn(() => session) });
    const c = new PlotModeController([mode], h, log);
    const context = ctx();

    await c.activate(mode, context);
    expect(mode.activate).toHaveBeenCalledWith(context);
    expect(c.current?.session).toBe(session);
    expect(h.onActivated).toHaveBeenCalledTimes(1);

    c.deactivate();
    c.deactivate();
    expect(session.deactivate).toHaveBeenCalledTimes(1);
    expect(h.onDeactivating).toHaveBeenCalledTimes(1);
    expect(c.current).toBeNull();
  });

  it('activates an async session', async () => {
    const session: PlotModeSession = { deactivate: jest.fn() };
    const mode = contribution('dianne', { activate: jest.fn(async () => session) });
    const c = new PlotModeController([mode], h, log);
    await c.activate(mode, ctx());
    expect(c.current?.session).toBe(session);
  });

  it('ends the live session before starting the next one', async () => {
    const first: PlotModeSession = { deactivate: jest.fn() };
    const second: PlotModeSession = { deactivate: jest.fn() };
    const mode = contribution('dianne', {
      activate: jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    });
    const c = new PlotModeController([mode], h, log);
    await c.activate(mode, ctx());
    await c.activate(mode, ctx());
    expect(first.deactivate).toHaveBeenCalledTimes(1);
    expect(second.deactivate).not.toHaveBeenCalled();
    expect(c.current?.session).toBe(second);
  });

  it('deactivates a session that arrives after the user already left — once', async () => {
    const d = deferred<PlotModeSession>();
    const session: PlotModeSession = { deactivate: jest.fn() };
    const mode = contribution('dianne', { activate: jest.fn(() => d.promise) });
    const c = new PlotModeController([mode], h, log);

    const done = c.activate(mode, ctx());
    expect(c.pending).toBe(true);
    c.deactivate(); // user left while activate() was in flight
    d.resolve(session);
    await done;

    expect(session.deactivate).toHaveBeenCalledTimes(1);
    expect(c.current).toBeNull();
    expect(h.onActivated).not.toHaveBeenCalled();
    c.deactivate();
    expect(session.deactivate).toHaveBeenCalledTimes(1);
  });

  describe('isolation', () => {
    it('catches a throwing activate() and reports the failure', async () => {
      const mode = contribution('dianne', { activate: jest.fn(() => { throw new Error('boom'); }) });
      const c = new PlotModeController([mode], h, log);
      await expect(c.activate(mode, ctx())).resolves.toBeUndefined();
      expect(h.onFailed).toHaveBeenCalledWith(mode, expect.any(Error));
      expect(log.error).toHaveBeenCalled();
      expect(c.current).toBeNull();
    });

    it('catches a rejected activate()', async () => {
      const mode = contribution('dianne', { activate: jest.fn(() => Promise.reject(new Error('no'))) });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      expect(h.onFailed).toHaveBeenCalledTimes(1);
      expect(c.current).toBeNull();
    });

    it('does not report a rejection of an activation that was already superseded', async () => {
      const d = deferred<PlotModeSession>();
      const mode = contribution('dianne', { activate: jest.fn(() => d.promise) });
      const c = new PlotModeController([mode], h, log);
      const done = c.activate(mode, ctx());
      c.deactivate();
      d.reject(new Error('late'));
      await done;
      expect(h.onFailed).not.toHaveBeenCalled();
    });

    it('treats a non-session result as a failure', async () => {
      const mode = contribution('dianne', { activate: jest.fn(() => undefined as any) });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      expect(h.onFailed).toHaveBeenCalledTimes(1);
    });

    it('swallows a throwing deactivate()', async () => {
      const session = { deactivate: jest.fn(() => { throw new Error('bad teardown'); }) };
      const mode = contribution('dianne', { activate: () => session });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      expect(() => c.deactivate()).not.toThrow();
      expect(session.deactivate).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalled();
    });

    it('logs a rejected async deactivate() instead of leaving it unhandled', async () => {
      const d = deferred<void>();
      const session = { deactivate: jest.fn(() => d.promise) } as unknown as PlotModeSession;
      const mode = contribution('dianne', { activate: () => session });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      c.deactivate();
      d.reject(new Error('async teardown'));
      await Promise.resolve(); await Promise.resolve();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('deactivate() failed'), expect.any(Error));
      expect(h.onFailed).not.toHaveBeenCalled(); // the user left: only logged
    });

    it('a failed cleanup during a re-render falls back instead of re-activating the mode', async () => {
      const first = { deactivate: jest.fn(() => { throw new Error('bad teardown'); }) };
      const activate = jest.fn().mockReturnValueOnce(first).mockReturnValue({ deactivate: jest.fn() });
      const mode = contribution('dianne', { activate });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      c.deactivate(); // base view re-rendering underneath
      await c.activate(mode, ctx()); // …and the still-selected mode would come back
      expect(activate).toHaveBeenCalledTimes(1);
      expect(h.onFailed).toHaveBeenCalledTimes(1);
      expect(c.current).toBeNull();
    });

    it('an async cleanup rejection that lands after the mode came back ends it and falls back', async () => {
      const d = deferred<void>();
      const second = { deactivate: jest.fn() };
      const activate = jest.fn()
        .mockReturnValueOnce({ deactivate: () => d.promise })
        .mockReturnValue(second);
      const mode = contribution('dianne', { activate: activate as any });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      await c.activate(mode, ctx()); // re-render: old session ends (pending), new one starts
      expect(c.current?.session).toBe(second);
      d.reject(new Error('late'));
      await Promise.resolve(); await Promise.resolve();
      expect(second.deactivate).toHaveBeenCalledTimes(1);
      expect(h.onFailed).toHaveBeenCalledTimes(1);
      expect(c.current).toBeNull();
    });

    it('an explicit re-selection retries a mode whose cleanup failed', async () => {
      const activate = jest.fn()
        .mockReturnValueOnce({ deactivate: () => { throw new Error('bad'); } })
        .mockReturnValue({ deactivate: jest.fn() });
      const mode = contribution('dianne', { activate });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      c.deactivate();
      c.clearCleanupFailures(); // the user picked it in the dropdown
      await c.activate(mode, ctx());
      expect(activate).toHaveBeenCalledTimes(2);
      expect(h.onFailed).not.toHaveBeenCalled();
      expect(c.current).not.toBeNull();
    });

    it('a rejecting deactivate() of a superseded session is only logged', async () => {
      const d = deferred<PlotModeSession>();
      const mode = contribution('dianne', { activate: () => d.promise });
      const c = new PlotModeController([mode], h, log);
      const p = c.activate(mode, ctx());
      c.deactivate(); // user left before activate resolved
      d.resolve({ deactivate: () => Promise.reject(new Error('stale')) } as unknown as PlotModeSession);
      await p; await Promise.resolve(); await Promise.resolve();
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('superseded session rejected'), expect.any(Error));
      expect(h.onFailed).not.toHaveBeenCalled();
    });

    it('swallows a throwing hook', async () => {
      h.onFailed.mockImplementation(() => { throw new Error('host broke'); });
      const mode = contribution('dianne', { activate: () => { throw new Error('boom'); } });
      const c = new PlotModeController([mode], h, log);
      await expect(c.activate(mode, ctx())).resolves.toBeUndefined();
    });
  });

  describe('mount panels', () => {
    it('mounts into a host after activate, and tears down before deactivate, then removes the host', async () => {
      const order: string[] = [];
      let seenHost: HTMLElement | null = null;
      const session: PlotModeSession = { deactivate: jest.fn(() => order.push('deactivate')) };
      const mode = contribution('dianne', {
        activate: jest.fn(() => { order.push('activate'); return session; }),
        panel: {
          title: 'DIANNE',
          mount: jest.fn((host: HTMLElement, c: PlotModeContext, s: PlotModeSession) => {
            order.push('mount');
            seenHost = host;
            expect(s).toBe(session);
            expect(c).toBeTruthy();
            host.textContent = 'panel';
            return () => order.push('teardown');
          }),
        },
      });
      h.onActivated.mockImplementation((a: ActivePlotMode) => document.body.appendChild(a.panelHost!));
      h.onDeactivating.mockImplementation(() => order.push('panel-removed'));
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());

      expect(c.current?.panelHost).toBe(seenHost);
      expect(document.body.contains(seenHost)).toBe(true);
      c.deactivate();
      c.deactivate();
      expect(order).toEqual(['activate', 'mount', 'panel-removed', 'teardown', 'deactivate']);
      expect(document.body.contains(seenHost)).toBe(false);
    });

    it('a throwing mount deactivates the session and reports a failure', async () => {
      const session: PlotModeSession = { deactivate: jest.fn() };
      const mode = contribution('dianne', {
        activate: () => session,
        panel: { title: 'x', mount: () => { throw new Error('mount failed'); } },
      });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      expect(session.deactivate).toHaveBeenCalledTimes(1);
      expect(h.onFailed).toHaveBeenCalledTimes(1);
      expect(c.current).toBeNull();
    });

    it('a throwing teardown still lets deactivate() run', async () => {
      const session: PlotModeSession = { deactivate: jest.fn() };
      const mode = contribution('dianne', {
        activate: () => session,
        panel: { title: 'x', mount: () => () => { throw new Error('teardown failed'); } },
      });
      const c = new PlotModeController([mode], h, log);
      await c.activate(mode, ctx());
      c.deactivate();
      expect(session.deactivate).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('viewport readiness', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('waits for the viewport before calling activate()', async () => {
      const mode = contribution('dianne');
      const c = new PlotModeController([mode], h, log);
      const context = ctx(false);
      const done = c.activate(mode, context);
      jest.advanceTimersByTime(50);
      expect(mode.activate).not.toHaveBeenCalled();
      (context.viewport.isReady as jest.Mock).mockReturnValue(true);
      jest.advanceTimersByTime(50);
      await done;
      expect(mode.activate).toHaveBeenCalledTimes(1);
    });

    it('gives up and falls back when the viewport never becomes ready', async () => {
      const mode = contribution('dianne');
      const c = new PlotModeController([mode], h, log);
      const done = c.activate(mode, ctx(false));
      jest.advanceTimersByTime(10_000);
      await done;
      expect(mode.activate).not.toHaveBeenCalled();
      expect(h.onFailed).toHaveBeenCalledTimes(1);
    });

    it('a deactivate while waiting cancels the activation', async () => {
      const mode = contribution('dianne');
      const c = new PlotModeController([mode], h, log);
      const done = c.activate(mode, ctx(false));
      c.deactivate();
      await done;
      jest.advanceTimersByTime(10_000);
      expect(mode.activate).not.toHaveBeenCalled();
      expect(h.onFailed).not.toHaveBeenCalled();
    });
  });
});
