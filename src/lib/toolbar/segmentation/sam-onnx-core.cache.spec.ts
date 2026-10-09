jest.mock('onnxruntime-web', () => ({})); // sam-onnx-core imports it; the cache code doesn't use it

import { clearSamModelCache, fetchModel, modelCacheKey } from './sam-onnx-core';

/** Just enough of `Response` for the model cache: a body that reads back as bytes. */
class FakeResponse {
  constructor(private readonly body: ArrayBuffer | Uint8Array) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.body instanceof Uint8Array ? this.body : new Uint8Array(this.body);
    return bytes.slice().buffer;
  }
}

/** One Cache API store keyed by URL, honouring `ignoreSearch` on delete. */
class FakeCache {
  readonly entries = new Map<string, FakeResponse>();
  async match(key: string) { return this.entries.get(key); }
  async put(key: string, value: FakeResponse) { this.entries.set(key, value); }
  async delete(key: string, opts?: { ignoreSearch?: boolean }) {
    const strip = (k: string) => (opts?.ignoreSearch ? k.split('?')[0] : k);
    let removed = false;
    for (const k of [...this.entries.keys()]) {
      if (strip(k) === strip(key)) removed = this.entries.delete(k) || removed;
    }
    return removed;
  }
}

describe('SAM model cache', () => {
  let stores: Map<string, FakeCache>;
  let fetchMock: jest.Mock;
  const g = globalThis as unknown as Record<string, unknown>;

  const served = (bytes: number[]) => ({
    ok: true, status: 200, body: null,
    headers: { get: () => null },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  });

  beforeEach(() => {
    stores = new Map();
    g['caches'] = {
      keys: async () => [...stores.keys()],
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new FakeCache());
        return stores.get(name);
      },
      delete: async (name: string) => stores.delete(name),
    };
    g['Response'] = FakeResponse;
    fetchMock = jest.fn();
    g['fetch'] = fetchMock;
  });

  afterEach(() => {
    delete g['caches'];
    delete g['Response'];
    delete g['fetch'];
  });

  describe('modelCacheKey', () => {
    it('is the bare URL for a model without a revision', () => {
      expect(modelCacheKey('https://hf.co/m/encoder.onnx')).toBe('https://hf.co/m/encoder.onnx');
    });

    it('adds the revision as a query parameter, after any the URL already has', () => {
      expect(modelCacheKey('https://hf.co/m/encoder.onnx', '2')).toBe('https://hf.co/m/encoder.onnx?siv-model-rev=2');
      expect(modelCacheKey('https://x/e.onnx?sig=a', 'r 1')).toBe('https://x/e.onnx?sig=a&siv-model-rev=r%201');
    });
  });

  describe('fetchModel', () => {
    const url = 'https://hf.co/m/encoder.onnx';
    const store = () => [...stores.values()][0];

    it('serves a second load of the same revision from the cache', async () => {
      fetchMock.mockResolvedValue(served([1, 2, 3]));
      await fetchModel(url, undefined, '1');
      const progress = jest.fn();
      const again = await fetchModel(url, progress, '1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect([...new Uint8Array(again)]).toEqual([1, 2, 3]);
      expect(progress).toHaveBeenCalledWith(1);
    });

    it('re-downloads when the revision changes, and drops the older copy', async () => {
      fetchMock.mockResolvedValueOnce(served([1])).mockResolvedValueOnce(served([2]));
      await fetchModel(url, undefined, '1');
      const fresh = await fetchModel(url, undefined, '2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect([...new Uint8Array(fresh)]).toEqual([2]);
      expect([...store().entries.keys()]).toEqual([modelCacheKey(url, '2')]);
    });

    it('re-downloads a model cached before it had a revision', async () => {
      fetchMock.mockResolvedValueOnce(served([1])).mockResolvedValueOnce(served([2]));
      await fetchModel(url);
      await fetchModel(url, undefined, '1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect([...store().entries.keys()]).toEqual([modelCacheKey(url, '1')]);
    });
  });

  describe('clearSamModelCache', () => {
    it('deletes every SAM model store and leaves other caches alone', async () => {
      stores.set('sam-onnx-v2', new FakeCache());
      stores.set('sam-onnx-v1', new FakeCache());
      stores.set('host-assets', new FakeCache());
      expect(await clearSamModelCache()).toBe(true);
      expect([...stores.keys()]).toEqual(['host-assets']);
      expect(await clearSamModelCache()).toBe(false);
    });

    it('reports false where the Cache API is unavailable', async () => {
      delete g['caches'];
      expect(await clearSamModelCache()).toBe(false);
    });
  });
});
