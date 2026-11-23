import { ISpatialControls } from '../../contracts/visualizer.contract';
import { SpatialDataset, SpatialEmbedding } from '../../contracts/spatial-dataset.contract';
import { ChartDataModel, HEATMAP_FETCH_CONCURRENCY } from './chart-data-model';

const ds = (id: string, names = ['Ttr', 'Mbp']): SpatialDataset => ({
  id,
  name: id,
  observations: { count: 4, x: new Float32Array(4), y: new Float32Array(4) },
  columns: [],
  features: { count: names.length, names },
});
const umap = { name: 'X_umap', label: 'UMAP', dims: 2 as const };
const pca = { name: 'X_pca', label: 'PCA', dims: 2 as const };

describe('ChartDataModel', () => {
  let data: ChartDataModel;
  let controls: jest.Mocked<ISpatialControls>;
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  beforeEach(() => {
    data = new ChartDataModel();
    controls = {
      categoricalColumns: jest.fn(() => ['region']),
      categoricalView: jest.fn(async () => ({
        name: 'region',
        categories: ['A', 'B'],
        colors: ['#f00', '#00f'],
        codes: new Uint16Array([0, 1, 1, 0]),
      })),
      continuousValues: jest.fn(async () => new Float32Array([1, 2, 3, 4])),
    } as unknown as jest.Mocked<ISpatialControls>;
    data.onDatasetChanged(ds('A'), ['region'], [umap, pca]);
  });

  it("offers the dataset's groupings and embeddings, and says when it switched", () => {
    expect(data.groupOptions.map((o) => o.value)).toEqual([null, 'region']);
    expect(data.embedding).toBe(umap);
    expect(data.onDatasetChanged(ds('A'), ['region'], [umap])).toBe(false);
    expect(data.onDatasetChanged(ds('B'), [], [])).toBe(true);
    expect(data.embedding).toBeNull();
  });

  it("loads a continuous source, or a categorical column's categories", async () => {
    expect(await data.loadValues(controls, { kind: 'feature', name: 'Ttr' })).toBe('continuous');
    expect(data.snapshot().values).toEqual(new Float32Array([1, 2, 3, 4]));
    expect(await data.loadValues(controls, { kind: 'column', name: 'region' })).toBe('categorical');
    expect(data.snapshot().values).toBeNull();
    expect(data.isCategorical).toBe(true);
    expect(await data.loadValues(controls, null)).toBe('none');
    expect(data.notice).toMatch(/Colour the map/);
    controls.continuousValues.mockRejectedValueOnce(new Error('gone'));
    expect(await data.loadValues(controls, { kind: 'feature', name: 'X' })).toBe('failed');
    expect(data.notice).toBe('"X" could not be charted: gone');
  });

  it('drops every vector on a dataset switch, and a load still landing for the old one (SPATIAL-1)', async () => {
    await data.loadGrouping(controls, 'region');
    data.setHeatmapGenes(['Ttr']);
    await data.loadHeatmapGenes(controls);
    const late = deferred<Float32Array>();
    controls.continuousValues.mockReturnValueOnce(late.promise);
    const loading = data.loadValues(controls, { kind: 'feature', name: 'Ttr' });
    expect(data.busy).toBe(true);

    expect(data.onDatasetChanged(ds('B'), ['region'], [])).toBe(true);
    late.resolve(new Float32Array([9, 9, 9, 9]));
    expect(await loading).toBe('superseded');
    expect(data.busy).toBe(false);
    expect(data.snapshot()).toEqual(
      expect.objectContaining({
        values: null,
        categorical: null,
        grouping: null,
        heatmapRows: [],
        embeddingCoords: null,
      }),
    );
    // The same-named grouping is kept as the choice, to be reloaded for the new dataset.
    expect(data.groupBy).toBe('region');
  });

  it('keeps each load on its own sequence, so one cannot cancel another (SPATIAL-2)', async () => {
    const slow = deferred<{ name: string; categories: string[]; colors: string[]; codes: Uint16Array }>();
    controls.categoricalView.mockReturnValueOnce(slow.promise);
    const values = data.loadValues(controls, { kind: 'column', name: 'region' });
    data.setHeatmapGenes(['Mbp']);
    await data.loadHeatmapGenes(controls);
    slow.resolve({ name: 'region', categories: ['A'], colors: ['#f00'], codes: new Uint16Array(4) });
    expect(await values).toBe('categorical');
    expect(data.busy).toBe(false);
  });

  it('keeps the latest grouping, and falls back to none when it fails', async () => {
    const slow = deferred<never>();
    controls.categoricalView.mockReturnValueOnce(slow.promise);
    const first = data.loadGrouping(controls, 'region');
    expect(await data.loadGrouping(controls, null)).toBe(true);
    expect(data.groupBy).toBeNull();
    controls.categoricalView.mockRejectedValueOnce(new Error('x'));
    expect(await data.loadGrouping(controls, 'region')).toBe(true);
    expect(data.groupBy).toBeNull();
    expect(data.hasGrouping).toBe(false);
    void first;
  });

  it('fetches each heatmap gene once, and drops genes the next dataset lacks', async () => {
    data.setHeatmapGenes(['Ttr', 'Mbp']);
    await data.loadHeatmapGenes(controls);
    await data.loadHeatmapGenes(controls);
    expect(controls.continuousValues).toHaveBeenCalledTimes(2);
    expect(data.snapshot().heatmapRows.map((r) => r.name)).toEqual(['Ttr', 'Mbp']);
    data.onDatasetChanged(ds('B', ['Mbp']), [], []);
    expect(data.heatmapGenes).toEqual(['Mbp']);
  });

  describe('fetching many heatmap genes', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `G${i}`);
    /** Holds every request until released, counting how many run at once. */
    function held() {
      const pending: { name: string; resolve: (v: Float32Array) => void; reject: (e: Error) => void }[] = [];
      let inFlight = 0;
      let peak = 0;
      controls.continuousValues = jest.fn(
        (source: { name: string }) =>
          new Promise<Float32Array>((resolve, reject) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            const done = () => inFlight--;
            pending.push({
              name: source.name,
              resolve: (v) => (done(), resolve(v)),
              reject: (e) => (done(), reject(e)),
            });
          }),
      ) as never;
      return { pending, peak: () => peak };
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it(`runs ${HEATMAP_FETCH_CONCURRENCY} requests at once, no more, until every gene is in`, async () => {
      const req = held();
      data.setHeatmapGenes(names(20));
      const load = data.loadHeatmapGenes(controls);
      await tick();
      expect(req.pending).toHaveLength(HEATMAP_FETCH_CONCURRENCY);
      expect(data.busy).toBe(true);
      // Answer each as it comes; the next request starts as a lane frees up.
      for (let i = 0; i < 20; i++) {
        req.pending[i].resolve(new Float32Array([i, 0, 0, 0]));
        await tick();
      }
      await load;
      expect(req.peak()).toBe(HEATMAP_FETCH_CONCURRENCY);
      expect(controls.continuousValues).toHaveBeenCalledTimes(20);
      expect(data.snapshot().heatmapRows.map((r) => r.name)).toEqual(names(20));
      expect(data.busy).toBe(false);
    });

    it('stops asking after a failure, keeps what arrived, and says so', async () => {
      const req = held();
      data.setHeatmapGenes(names(20));
      const load = data.loadHeatmapGenes(controls);
      await tick();
      req.pending[0].reject(new Error('503'));
      for (let i = 1; i < HEATMAP_FETCH_CONCURRENCY; i++) req.pending[i].resolve(new Float32Array(4));
      await load;
      expect(controls.continuousValues).toHaveBeenCalledTimes(HEATMAP_FETCH_CONCURRENCY);
      expect(data.snapshot().heatmapRows).toHaveLength(HEATMAP_FETCH_CONCURRENCY - 1);
      expect(data.notice).toBe('A gene could not be charted: 503');
      expect(data.busy).toBe(false);
    });

    it('drops a load the next one overtook, and asks nothing more for it', async () => {
      const req = held();
      data.setHeatmapGenes(names(20));
      const first = data.loadHeatmapGenes(controls);
      await tick();
      data.setHeatmapGenes(['Ttr']);
      const second = data.loadHeatmapGenes(controls);
      await tick();
      for (const r of req.pending) r.resolve(new Float32Array(4));
      await Promise.all([first, second]);
      // The first load's eight, then the second's one: nothing more for the overtaken load.
      expect(controls.continuousValues).toHaveBeenCalledTimes(HEATMAP_FETCH_CONCURRENCY + 1);
      expect(data.snapshot().heatmapRows.map((r) => r.name)).toEqual(['Ttr']);
      expect(data.busy).toBe(false);
    });
  });

  it('keeps the rows of a whole-transcriptome dataset that does not inline its names', () => {
    // Its genes come from the port's search, so there is no list to check them against:
    // the same dataset re-emitted keeps its rows, another dataset drops them.
    const remote = (id: string): SpatialDataset => ({ ...ds(id), features: { count: 18078 } });
    data.onDatasetChanged(remote('A'), [], []);
    data.setHeatmapGenes(['Gene9001']);
    data.onDatasetChanged(remote('A'), [], []);
    expect(data.heatmapGenes).toEqual(['Gene9001']);
    data.onDatasetChanged(remote('B'), [], []);
    expect(data.heatmapGenes).toEqual([]);
  });

  it('loads an embedding once, and keeps the one chosen last', async () => {
    const coords = (meta: typeof umap): SpatialEmbedding => ({
      meta,
      x: new Float32Array(4),
      y: new Float32Array(4),
    });
    const get = jest.fn(async (name: string) => coords(name === 'X_pca' ? pca : umap));
    expect(await data.loadEmbedding(get, umap)).toBe('ready');
    expect(await data.loadEmbedding(get, umap)).toBe('ready');
    expect(get).toHaveBeenCalledTimes(1);
    expect(data.selectEmbedding('X_pca')).toBe(true);
    expect(data.selectEmbedding('X_pca')).toBe(false);
    expect(data.selectEmbedding('nope')).toBe(false);
    const slow = deferred<SpatialEmbedding>();
    get.mockReturnValueOnce(slow.promise);
    const loading = data.loadEmbedding(get, pca);
    data.supersedeEmbeddingLoad();
    slow.resolve(coords(pca));
    expect(await loading).toBe('superseded');
    get.mockRejectedValueOnce(new Error('404'));
    expect(await data.loadEmbedding(get, pca)).toBe('failed');
    expect(data.notice).toBe('Could not load PCA: 404');
  });
});
