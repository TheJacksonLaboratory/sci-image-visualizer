import { SpatialEmbedding, SpatialEmbeddingMeta } from '../contracts/spatial-dataset.contract';
import { EmbeddingComputeRun } from './embedding-compute';
import {
  BROWSER_TSNE_MAX_OBSERVATIONS,
  EmbeddingComputeCoordinator,
  estimateLabel,
  loadPcaScores,
  tsneEstimateSeconds,
} from './embedding-compute-coordinator';

const pca2: SpatialEmbeddingMeta = { name: 'X_pca', label: 'PCA', dims: 2 };
const pca3: SpatialEmbeddingMeta = { name: 'X_pca3', label: 'PCA 3D', dims: 3 };
const umap: SpatialEmbeddingMeta = { name: 'X_umap', label: 'UMAP', dims: 2 };
const tsne: SpatialEmbeddingMeta = { name: 'local:tsne', label: 't-SNE (compute)', dims: 2, derived: true };

const coords = (meta: SpatialEmbeddingMeta, n = 3): SpatialEmbedding => ({
  meta,
  x: Float32Array.from({ length: n }, (_, i) => i),
  y: Float32Array.from({ length: n }, (_, i) => 10 + i),
  ...(meta.dims === 3 ? { z: Float32Array.from({ length: n }, (_, i) => 20 + i) } : {}),
});

describe('EmbeddingComputeCoordinator', () => {
  let compute: EmbeddingComputeCoordinator;
  let getEmbedding: jest.Mock;

  beforeEach(() => {
    compute = new EmbeddingComputeCoordinator();
    getEmbedding = jest.fn(async (name: string) => coords(name === 'X_pca3' ? pca3 : pca2));
  });

  afterEach(() => jest.restoreAllMocks());

  describe('what it offers', () => {
    it('offers a t-SNE where there is a PCA and no t-SNE, small enough to run here', () => {
      expect(compute.setDataset([umap, pca2], 100).map((e) => e.name)).toEqual([
        'X_umap',
        'X_pca',
        'local:tsne',
        'local:tsne3d',
      ]);
      expect(compute.tooLarge).toBe(false);
      expect(compute.setDataset([umap], 100).map((e) => e.name)).toEqual(['X_umap']);
      expect(compute.setDataset([pca2, { name: 'X_tsne', dims: 2 }], 100)).toHaveLength(2);
    });

    it('withholds it past the threshold, and says why', () => {
      expect(compute.setDataset([pca2], BROWSER_TSNE_MAX_OBSERVATIONS + 1)).toEqual([pca2]);
      expect(compute.tooLarge).toBe(true);
      expect(compute.tooLargeNote).toContain('5,001');
      expect(compute.tooLargeNote).toContain('offline');
    });

    it('estimates quadratically from the measured anchor', () => {
      expect(tsneEstimateSeconds(2688)).toBe(95);
      expect(tsneEstimateSeconds(5376)).toBe(380);
      expect(tsneEstimateSeconds(1)).toBe(1);
      expect(estimateLabel(42)).toBe('~42s');
      expect(estimateLabel(380)).toBe('~6 min');
    });
  });

  describe('running', () => {
    let resolveRun: (r: SpatialEmbedding | null) => void;
    let run: jest.SpyInstance;

    beforeEach(() => {
      compute.setDataset([pca2, pca3], 3);
      run = jest.spyOn(EmbeddingComputeRun.prototype, 'run').mockImplementation(function (
        this: EmbeddingComputeRun,
        _req,
        meta,
        onProgress,
      ) {
        onProgress({ fraction: 0.5, backend: 'cpu', message: 'slow path' });
        return new Promise((r) => {
          resolveRun = (v) => r(v ? { ...v, meta } : v);
        });
      });
    });

    it('embeds the widest PCA, reports progress, and keeps the result', async () => {
      const started = compute.start(tsne, [pca2, pca3], getEmbedding);
      await Promise.resolve();
      await Promise.resolve();
      expect(getEmbedding).toHaveBeenCalledWith('X_pca3');
      expect(run.mock.calls[0][0]).toEqual(expect.objectContaining({ nObs: 3, nDims: 3, dims: 2 }));
      // The compute suffix is the menu's, not the result's name.
      expect(run.mock.calls[0][1].label).toBe('t-SNE');
      expect(compute.state).toEqual(
        expect.objectContaining({
          fraction: 0.5,
          backend: 'cpu',
          message: 'slow path',
        }),
      );
      // (`running` asks the run, which is mocked here; the published state says it too.)
      expect(compute.state.running).toBe(true);
      resolveRun(coords(tsne));
      const result = await started;
      expect(result?.meta.label).toBe('t-SNE');
      expect(compute.isComputed(tsne)).toBe(true);
      expect(compute.result('local:tsne')).toBe(result);
      expect(compute.state.running).toBe(false);
      expect(compute.state.fraction).toBeNull();
    });

    it('drops a result that lands after the dataset changed, and forgets what was computed', async () => {
      const started = compute.start(tsne, [pca2], getEmbedding);
      await Promise.resolve();
      await Promise.resolve();
      compute.setDataset([pca2], 3);
      resolveRun(coords(tsne));
      expect(await started).toBeNull();
      expect(compute.isComputed(tsne)).toBe(false);
    });

    it('never starts a worker when abandoned during the PCA fetch', async () => {
      let resolvePca!: (e: SpatialEmbedding) => void;
      getEmbedding.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolvePca = r;
          }),
      );
      const started = compute.start(tsne, [pca2], getEmbedding);
      compute.abandon();
      resolvePca(coords(pca2));
      expect(await started).toBeNull();
      expect(run).not.toHaveBeenCalled();
    });

    it('says so when there is no PCA, and reports a failed run', async () => {
      expect(await compute.start(tsne, [umap], getEmbedding)).toBeNull();
      expect(compute.state.error).toBe('This dataset serves no PCA to embed.');
      run.mockRejectedValueOnce(new Error('GPU lost'));
      expect(await compute.start(tsne, [pca2], getEmbedding)).toBeNull();
      expect(compute.state.error).toBe('GPU lost');
    });

    it("passes the user's Cancel to the run", async () => {
      const cancel = jest.spyOn(EmbeddingComputeRun.prototype, 'cancel').mockImplementation(() => undefined);
      void compute.start(tsne, [pca2], getEmbedding);
      await Promise.resolve();
      await Promise.resolve();
      compute.cancel();
      expect(cancel).toHaveBeenCalled();
      resolveRun(null);
    });
  });

  it('assembles row-major scores from the PCA planes, skipping one that fails', async () => {
    getEmbedding.mockRejectedValueOnce(new Error('missing'));
    const scores = await loadPcaScores([pca2, pca3], getEmbedding);
    expect(getEmbedding.mock.calls.map((c) => c[0])).toEqual(['X_pca3', 'X_pca']);
    expect(scores).toEqual({ scores: Float32Array.from([0, 10, 1, 11, 2, 12]), nObs: 3, nDims: 2 });
    expect(await loadPcaScores([umap], getEmbedding)).toBeNull();
  });
});
