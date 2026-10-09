const fromPretrained = jest.fn();
jest.mock('cellpose-js', () => ({
  Cellpose: { fromPretrained: (...args: unknown[]) => fromPretrained(...args) },
  configureOrt: jest.fn(),
}), { virtual: true }); // the ESM-only package doesn't resolve under jest's CommonJS resolver

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
    fromPretrained.mockImplementation((_url: string, opts: { onProgress: (p: unknown) => void }) =>
      new Promise((res) => { finish = (m) => { opts.onProgress({ loaded: 5, total: 10 }); res(m); }; }));
    const svc = new CellposeSegmenterService();
    const a: number[] = [], b: number[] = [];
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
});
