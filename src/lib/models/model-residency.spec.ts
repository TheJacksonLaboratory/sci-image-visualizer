import { ModelResidency, estimateLoadedSizeMb } from './model-residency';

/** A resident model whose release is observable. */
function model(id: string, loadedSizeMb: number, log: string[]) {
  return { id, loadedSizeMb, release: jest.fn(async () => void log.push(`release ${id}`)) };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ModelResidency', () => {
  let r: ModelResidency;
  let log: string[];

  beforeEach(() => {
    r = new ModelResidency();
    log = [];
  });

  it('keeps a model warm across repeated uses of it', async () => {
    const yolo = model('yolo:a', 1300, log);
    r.register(yolo);

    await r.use('yolo:a', async () => 'run 1');
    await r.use('yolo:a', async () => 'run 2');

    expect(yolo.release).not.toHaveBeenCalled();
    expect(r.isResident('yolo:a')).toBe(true);
  });

  it('releases a large model before a different model is used', async () => {
    const yolo = model('yolo:a', 1300, log);
    r.register(yolo);

    await r.use('retinal:vnet', async () => {
      log.push('load retinal');
      r.register(model('retinal:vnet', 6000, log));
    });

    // Released BEFORE the new model loads, so the tab never holds both.
    expect(log).toEqual(['release yolo:a', 'load retinal']);
    expect(r.isResident('yolo:a')).toBe(false);
    expect(r.isResident('retinal:vnet')).toBe(true);
  });

  it('treats another checkpoint of the same tool as another model', async () => {
    r.register(model('yolo:opticnerve', 1300, log));
    await r.use('yolo:retina', async () => undefined);
    expect(log).toEqual(['release yolo:opticnerve']);
  });

  it('leaves models below the threshold warm', async () => {
    const stain = model('stain:gr2rgb-20x', 900, log);
    r.register(stain);

    await r.use('retinal:vnet', async () => undefined);

    expect(stain.release).not.toHaveBeenCalled();
  });

  it('releases a model exactly at the threshold', async () => {
    r.register(model('x', 1024, log));
    await r.use('y', async () => undefined);
    expect(log).toEqual(['release x']);
  });

  it('honours a changed threshold', async () => {
    r.setThresholdMb(2000);
    r.register(model('yolo:a', 1300, log));
    await r.use('retinal:vnet', async () => undefined);
    expect(log).toEqual([]);
  });

  it('lets a running use of the old model finish before releasing it', async () => {
    r.register(model('yolo:a', 1300, log));
    const gate = deferred();
    const yoloRun = r.use('yolo:a', async () => {
      await gate.promise;
      log.push('yolo run done');
    });

    const switching = r.use('retinal:vnet', async () => void log.push('retinal starts'));
    await Promise.resolve();
    expect(log).toEqual([]); // still waiting on the YOLO run

    gate.resolve();
    await Promise.all([yoloRun, switching]);
    expect(log).toEqual(['yolo run done', 'release yolo:a', 'retinal starts']);
  });

  it('does not release a model its owner already replaced while it waited', async () => {
    const old = model('yolo:a', 1300, log);
    r.register(old);
    const gate = deferred();
    const run = r.use('yolo:a', () => gate.promise);
    const switching = r.use('retinal:vnet', async () => undefined);

    r.unregister('yolo:a');
    gate.resolve();
    await Promise.all([run, switching]);

    expect(old.release).not.toHaveBeenCalled();
  });

  it('never leaves two large models loaded when two start at once', async () => {
    r.register(model('a', 2000, log));
    const loadB = deferred();
    await Promise.all([
      // b registers only after an async load, i.e. after c's switch has begun.
      r.use('b', async () => {
        await loadB.promise;
        r.register(model('b', 2000, log));
      }),
      r.use('c', async () => void r.register(model('c', 2000, log))),
      Promise.resolve().then(() => loadB.resolve()),
    ]);
    // c's switch waited for b's use (size unknown until it registered), then released it.
    expect(log).toEqual(['release a', 'release b']);
    expect(r.residentModels().map((m) => m.id)).toEqual(['c']);
  });

  it('does not wait for a running use of a small registered model', async () => {
    r.register(model('sam:vit-t', 200, log));
    const gate = deferred();
    const samRun = r.use('sam:vit-t', () => gate.promise);

    await r.use('retinal:vnet', async () => void log.push('retinal starts'));

    expect(log).toEqual(['retinal starts']);
    gate.resolve();
    await samRun;
  });

  it('keeps going when one release fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    r.register({ id: 'bad', loadedSizeMb: 2000, release: () => Promise.reject(new Error('boom')) });
    r.register(model('good', 2000, log));

    await r.use('next', async () => undefined);

    expect(log).toEqual(['release good']);
    expect(r.isResident('bad')).toBe(false);
    warn.mockRestore();
  });

  it('returns the use result and propagates its failure', async () => {
    await expect(r.use('a', async () => 42)).resolves.toBe(42);
    await expect(r.use('a', () => Promise.reject(new Error('run failed')))).rejects.toThrow('run failed');
  });

  it('rejects a nonsensical threshold', () => {
    expect(() => r.setThresholdMb(-1)).toThrow();
    expect(() => r.setThresholdMb(Number.NaN)).toThrow();
  });
});

describe('estimateLoadedSizeMb', () => {
  it('scales fp16-weight models by the measured ~9x', () => {
    // 144 MB YOLO measured at ~1.3 GB loaded.
    expect(estimateLoadedSizeMb(144, { fp16Weights: true })).toBe(1296);
  });

  it('uses a smaller factor for graphs without the fp16->fp32 fold', () => {
    expect(estimateLoadedSizeMb(100)).toBe(400);
  });
});
