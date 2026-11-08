import { detectWebGpu, probeWebGpu, resetWebGpuProbe } from './webgpu-support';

describe('detectWebGpu', () => {
  it('is false without navigator.gpu', async () => {
    expect(await detectWebGpu({})).toBe(false);
    expect(await detectWebGpu(undefined)).toBe(false);
  });

  it('is true once an adapter is granted', async () => {
    expect(await detectWebGpu({ gpu: { requestAdapter: () => Promise.resolve({}) } })).toBe(true);
  });

  it('is false when the browser offers no adapter', async () => {
    expect(await detectWebGpu({ gpu: { requestAdapter: () => Promise.resolve(null) } })).toBe(false);
  });

  it('is false when the request fails', async () => {
    expect(await detectWebGpu({ gpu: { requestAdapter: () => Promise.reject(new Error('blocked')) } })).toBe(
      false,
    );
  });

  it('is false when the request never answers', async () => {
    jest.useFakeTimers();
    try {
      const answer = detectWebGpu({ gpu: { requestAdapter: () => new Promise(() => undefined) } }, 50);
      jest.advanceTimersByTime(50);
      expect(await answer).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('probeWebGpu', () => {
  afterEach(() => resetWebGpuProbe());

  it('asks once per page', () => {
    resetWebGpuProbe();
    expect(probeWebGpu()).toBe(probeWebGpu());
  });

  it('is false in jsdom, which has no WebGPU', async () => {
    resetWebGpuProbe();
    expect(await probeWebGpu()).toBe(false);
  });
});
