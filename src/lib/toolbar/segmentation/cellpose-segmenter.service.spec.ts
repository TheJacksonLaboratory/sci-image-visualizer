const fromPretrained = jest.fn();
jest.mock(
  'cellpose-js',
  () => ({
    Cellpose: { fromPretrained: (...args: unknown[]) => fromPretrained(...args) },
    configureOrt: jest.fn(),
  }),
  { virtual: true },
); // the ESM-only package doesn't resolve under jest's CommonJS resolver

import { CellposeSegmenterService } from './cellpose-segmenter.service';

describe('CellposeSegmenterService.getModel', () => {
  beforeEach(() => fromPretrained.mockReset());

  it('retries after a failed load instead of caching the rejection (RT-11)', async () => {
    const model = { dispose: jest.fn(async () => undefined) };
    fromPretrained.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(model);
    const svc = new CellposeSegmenterService();
    await expect(svc.getModel()).rejects.toThrow('network');
    await expect(svc.getModel()).resolves.toBe(model);
    expect(svc.isLoaded()).toBe(true);
  });

  it('reports download progress to every concurrent caller', async () => {
    let finish!: (m: unknown) => void;
    fromPretrained.mockImplementation(
      (_url: string, opts: { onProgress: (p: unknown) => void }) =>
        new Promise((res) => {
          finish = (m) => {
            opts.onProgress({ loaded: 5, total: 10 });
            res(m);
          };
        }),
    );
    const svc = new CellposeSegmenterService();
    const a: number[] = [],
      b: number[] = [];
    const pa = svc.getModel((l) => a.push(l));
    const pb = svc.getModel((l) => b.push(l));
    await new Promise((r) => setTimeout(r, 0));
    finish({ dispose: async () => undefined });
    await Promise.all([pa, pb]);
    expect(a).toEqual([5]);
    expect(b).toEqual([5]);
    expect(fromPretrained).toHaveBeenCalledTimes(1);
  });

  it('setModelUrl after a load disposes the instance and reloads from the new URL', async () => {
    const first = { dispose: jest.fn(async () => undefined) };
    const second = { dispose: jest.fn(async () => undefined) };
    fromPretrained.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const svc = new CellposeSegmenterService();
    await svc.getModel();
    svc.setModelUrl('https://example.org/other.onnx');
    expect(first.dispose).toHaveBeenCalled();
    await expect(svc.getModel()).resolves.toBe(second);
    expect(fromPretrained.mock.calls[1][0]).toBe('https://example.org/other.onnx');
  });

  it("unsubscribes a caller's progress/status listeners once its load settles", async () => {
    // Each listener is removed in the load's finally (success or failure), so a
    // later load never reports to a caller that already returned.
    const progressOf =
      (calls: number) =>
      (_url: string, opts: { onProgress: (p: unknown) => void; onStatus: (s: string) => void }) => {
        opts.onProgress({ loaded: calls, total: 10 });
        opts.onStatus(`load ${calls}`);
      };
    fromPretrained
      .mockImplementationOnce(async (url: string, opts: never) => {
        progressOf(1)(url, opts);
        throw new Error('network');
      })
      .mockImplementationOnce(async (url: string, opts: never) => {
        progressOf(2)(url, opts);
        return { dispose: async () => undefined };
      })
      .mockImplementationOnce(async (url: string, opts: never) => {
        progressOf(3)(url, opts);
        return { dispose: async () => undefined };
      });
    const svc = new CellposeSegmenterService();
    const first: unknown[] = [];
    const second: unknown[] = [];

    await expect(
      svc.getModel(
        (l) => first.push(l),
        (s) => first.push(s),
      ),
    ).rejects.toThrow('network');
    await svc.getModel(
      (l) => second.push(l),
      (s) => second.push(s),
    );
    svc.setModelUrl('https://example.org/other.onnx');
    await svc.getModel();

    expect(first).toEqual([1, 'load 1']); // failed load: unsubscribed, never hears load 2 or 3
    expect(second).toEqual([2, 'load 2']); // successful load: unsubscribed, never hears load 3
  });
});

describe('CellposeSegmenterService.segmentCells — options', () => {
  beforeEach(() => fromPretrained.mockReset());

  it('rescales by the diameter and runs the dynamics back at the input resolution', async () => {
    const segment = jest.fn(async (img: { width: number; height: number }) => ({
      masks: new Uint32Array(img.width * img.height),
      count: 0,
      width: img.width,
      height: img.height,
    }));
    fromPretrained.mockResolvedValue({ segment, dispose: jest.fn(async () => undefined) });
    const svc = new CellposeSegmenterService();
    const image = { data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 };

    await svc.segmentCells(image, undefined, { diameter: 60 });
    expect((segment.mock.calls[0] as unknown[])[1]).toMatchObject({ diameter: 60, resample: true });

    await svc.segmentCells(image);
    expect((segment.mock.calls[1] as unknown[])[1]).toMatchObject({ diameter: undefined, resample: false });
  });
});
