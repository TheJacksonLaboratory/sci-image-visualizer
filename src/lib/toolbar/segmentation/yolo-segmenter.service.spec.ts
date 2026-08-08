import { YoloSegmenterService } from './yolo-segmenter.service';

const mockFromPretrained = jest.fn();
const mockConfigureOrt = jest.fn();

jest.mock(
  'yolo-segdetect-js',
  () => ({
    YoloSegmenter: { fromPretrained: (...args: unknown[]) => mockFromPretrained(...args) },
    configureOrt: (...args: unknown[]) => mockConfigureOrt(...args),
  }),
  { virtual: true },
);

const MODEL = 'yolov8x-seg-opticnerve';
const OTHER = 'yolov8x-seg-retina';

/** A fake segmenter whose load can be released on demand, so a test can act mid-flight. */
function deferredLoad() {
  const dispose = jest.fn().mockResolvedValue(undefined);
  const segmenter = { dispose };
  let release!: () => void;
  const gate = new Promise((resolve) => {
    release = () => resolve(segmenter);
  });
  mockFromPretrained.mockReturnValueOnce(gate);
  return { segmenter, dispose, release };
}

describe('YoloSegmenterService', () => {
  let service: YoloSegmenterService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new YoloSegmenterService();
  });

  it('caches per model id and dedupes concurrent callers', async () => {
    const a = deferredLoad();
    const first = service.getModel(MODEL);
    const second = service.getModel(MODEL);
    a.release();

    expect(await first).toBe(await second);
    // One load, not two — the second caller joined the in-flight promise.
    expect(mockFromPretrained).toHaveBeenCalledTimes(1);
    expect(service.isLoaded(MODEL)).toBe(true);
  });

  it('keeps separate instances for separate checkpoints', async () => {
    const a = deferredLoad();
    const p1 = service.getModel(MODEL);
    a.release();
    await p1;

    const b = deferredLoad();
    const p2 = service.getModel(OTHER);
    b.release();
    await p2;

    expect(await p1).not.toBe(await p2);
    expect(mockFromPretrained).toHaveBeenCalledTimes(2);
  });

  it('releases a warm model', async () => {
    const a = deferredLoad();
    const p = service.getModel(MODEL);
    a.release();
    await p;

    await service.dispose(MODEL);

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(service.isLoaded(MODEL)).toBe(false);
  });

  // The case the PR review caught: dispose() enumerated only loaded instances,
  // so a load still in flight was skipped entirely. It then resolved, re-added
  // itself to the cache, and left a live worker + ORT session behind — after
  // dispose() had already reported success.
  it('tears down a load that is still in flight when dispose() is called', async () => {
    const a = deferredLoad();
    const loading = service.getModel(MODEL);

    const disposal = service.dispose(); // mid-load, no id
    a.release();
    await loading;
    await disposal;

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(service.isLoaded(MODEL)).toBe(false);
  });

  it('tears down an in-flight load addressed by id', async () => {
    const a = deferredLoad();
    const loading = service.getModel(MODEL);

    const disposal = service.dispose(MODEL);
    a.release();
    await loading;
    await disposal;

    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(service.isLoaded(MODEL)).toBe(false);
  });

  it('does not evict a newer load started while disposal was awaiting the old one', async () => {
    const first = deferredLoad();
    const loading = service.getModel(MODEL);
    const disposal = service.dispose(MODEL);

    // A caller re-requests the model before the old disposal settles.
    const second = deferredLoad();
    const reloaded = service.getModel(MODEL);

    first.release();
    second.release();
    await Promise.all([loading, disposal, reloaded]);

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    // The replacement survives — disposal must not clear an entry it does not own.
    expect(service.isLoaded(MODEL)).toBe(true);
    expect(await reloaded).toBe(second.segmenter);
  });

  it('survives a rejected in-flight load without leaking the pending entry', async () => {
    mockFromPretrained.mockRejectedValueOnce(new Error('network down'));
    const loading = service.getModel(MODEL);

    await expect(loading).rejects.toThrow('network down');
    await expect(service.dispose()).resolves.toBeUndefined();
    expect(service.isLoaded(MODEL)).toBe(false);
  });

  it('is a no-op for a model that was never loaded', async () => {
    await expect(service.dispose(MODEL)).resolves.toBeUndefined();
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  it('refuses an unknown model id rather than loading something wrong', () => {
    // Note the asymmetry: getModel validates before entering its async body, so
    // it throws synchronously, whereas segmentInstances (an async method) turns
    // the same failure into a rejection.
    expect(() => service.getModel('nope')).toThrow(/Unknown YOLO model id/);
    expect(mockFromPretrained).not.toHaveBeenCalled();
  });
});
