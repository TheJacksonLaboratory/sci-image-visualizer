import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { SamSessionService } from './sam-session.service';
import { SamToolService } from './sam-tool.service';
import { SamPointToolService } from './sam-point-tool.service';
import { provideVisualization } from '../../provide-visualization';
import { setSamModelUrls } from './sam-model-registry';
import { ISamSession, SamEmbedding, SamModelDef } from '../../contracts/sam.contract';
import { CachedImageData } from '../wand/wand-tool.service';

/** A fake session whose loadModel waits for `finish()` (or `fail()`). */
function slowSession() {
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const loaded = new Promise<void>((res, rej) => {
    finish = res;
    fail = rej;
  });
  const progress: Array<(f: number) => void> = [];
  const session: ISamSession & { model?: SamModelDef } = {
    loadModel: jest.fn(async (model: SamModelDef, onProgress?: (f: number) => void) => {
      session.model = model;
      if (onProgress) progress.push(onProgress);
      await loaded;
    }),
    isLoaded: () => true,
    dispose: jest.fn(),
    embed: jest.fn(async (): Promise<SamEmbedding> => ({
      data: new Float32Array(1),
      dims: [1],
      scale: 1,
      imageWidth: 2,
      imageHeight: 2,
    })),
    decode: jest.fn(),
  };
  return { session, finish, fail, progress };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SamSessionService', () => {
  let svc: SamSessionService;

  beforeEach(() => {
    setSamModelUrls('microsam-vit-t-lm', 'enc-t', 'dec-t');
    setSamModelUrls('microsam-vit-b-lm', 'enc-b', 'dec-b');
    svc = new SamSessionService();
    svc.setModel('microsam-vit-t-lm');
  });

  it('loads one session for concurrent callers and fans progress out to both (RT-10)', async () => {
    const s = slowSession();
    const factory = jest.fn(async () => s.session);
    svc.useSessionFactory(factory);
    const seen: number[][] = [[], []];
    const a = svc.ensureSession((f) => seen[0].push(f));
    const b = svc.ensureSession((f) => seen[1].push(f));
    await flush();
    s.progress[0](0.5);
    s.finish();
    expect(await a).toBe(s.session);
    expect(await b).toBe(s.session);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      [0, 0.5],
      [0, 0.5],
    ]); // 0 when the wait starts
  });

  it('disposes a session whose load failed, and the next call retries (RT-7)', async () => {
    const bad = slowSession();
    const good = slowSession();
    const factory = jest.fn().mockResolvedValueOnce(bad.session).mockResolvedValueOnce(good.session);
    svc.useSessionFactory(factory);
    const first = svc.ensureSession();
    await flush();
    bad.fail(new Error('404'));
    await expect(first).rejects.toThrow('404');
    expect(bad.session.dispose).toHaveBeenCalled();

    const second = svc.ensureSession();
    await flush();
    good.finish();
    expect(await second).toBe(good.session);
  });

  it('a model switch during a load disposes the stale session and loads the new model (RT-9)', async () => {
    const t = slowSession();
    const b = slowSession();
    svc.useSessionFactory(jest.fn().mockResolvedValueOnce(t.session).mockResolvedValueOnce(b.session));
    const pending = svc.ensureSession();
    await flush();
    svc.setModel('microsam-vit-b-lm');
    t.finish();
    await flush();
    b.finish();
    const session = await pending;
    expect(session).toBe(b.session);
    expect(t.session.dispose).toHaveBeenCalled();
    expect((b.session as { model?: SamModelDef }).model?.id).toBe('microsam-vit-b-lm');
    expect(await svc.ensureSession()).toBe(b.session);
  });

  it('caches one embedding per image key and model', async () => {
    const s = slowSession();
    s.finish();
    svc.useSessionFactory(async () => s.session);
    const session = await svc.ensureSession();
    const cached: CachedImageData = {
      frames: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
      width: 2,
      height: 2,
      ratios: [1],
      isGrayscale: true,
    };
    await svc.embed(session, cached, 0, 'img|0');
    await svc.embed(session, cached, 0, 'img|0');
    expect(session.embed).toHaveBeenCalledTimes(1);
    await svc.embed(session, cached, 0, 'img|1');
    expect(session.embed).toHaveBeenCalledTimes(2);
  });

  it('rejects with a clear message when the model has no ONNX URLs', async () => {
    setSamModelUrls('microsam-vit-t-lm', '', '');
    await expect(svc.ensureSession()).rejects.toThrow(/not configured/);
  });
});

describe('SamSessionService scope (one session per app, disposable per viewer)', () => {
  it('is shared by the SAM tools of every viewer chain, so a second viewer loads no second model', () => {
    const root = TestBed.inject(EnvironmentInjector);
    const chainA = createEnvironmentInjector(provideVisualization(), root);
    const chainB = createEnvironmentInjector(provideVisualization(), root);
    const sessionsOf = (i: EnvironmentInjector, t: typeof SamToolService | typeof SamPointToolService) =>
      (i.get(t) as unknown as { sessions: SamSessionService }).sessions;

    // Each chain has its own tool feeds…
    expect(chainA.get(SamPointToolService)).not.toBe(chainB.get(SamPointToolService));
    // …over the one root session.
    const shared = TestBed.inject(SamSessionService);
    for (const chain of [chainA, chainB]) {
      expect(sessionsOf(chain, SamToolService)).toBe(shared);
      expect(sessionsOf(chain, SamPointToolService)).toBe(shared);
    }
    chainA.destroy();
    chainB.destroy();
  });

  it('disposes its session when the injector that provides it is destroyed', async () => {
    setSamModelUrls('microsam-vit-t-lm', 'enc-t', 'dec-t');
    const viewer = createEnvironmentInjector([SamSessionService], TestBed.inject(EnvironmentInjector));
    const svc = viewer.get(SamSessionService);
    svc.setModel('microsam-vit-t-lm');
    const s = slowSession();
    svc.useSessionFactory(async () => s.session);
    const loading = svc.ensureSession();
    s.finish();
    await loading;

    viewer.destroy();

    expect(s.session.dispose).toHaveBeenCalledTimes(1);
    expect(svc.hasSession()).toBe(false);
    await expect(svc.ensureSession()).rejects.toThrow(/disposed/);
  });

  it('discards a load still in flight when destroyed', async () => {
    setSamModelUrls('microsam-vit-t-lm', 'enc-t', 'dec-t');
    const svc = new SamSessionService();
    svc.setModel('microsam-vit-t-lm');
    const s = slowSession();
    svc.useSessionFactory(async () => s.session);
    const loading = svc.ensureSession();
    await flush();

    svc.ngOnDestroy();
    s.finish();

    await expect(loading).rejects.toThrow(/disposed/);
    expect(s.session.dispose).toHaveBeenCalledTimes(1);
    expect(svc.hasSession()).toBe(false);
  });
});
