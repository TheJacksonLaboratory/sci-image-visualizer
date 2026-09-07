import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { SpatialDataHttpService } from './spatial-data-http.service';
import { SPATIAL_WIRE_VERSION, SpatialManifest } from './spatial-wire';
import { isCategoricalColumn, isContinuousColumn } from '../../contracts/spatial-dataset.contract';

const BASE = 'http://localhost:8090';

function f32(...values: number[]): ArrayBuffer {
  return new Float32Array(values).buffer;
}
function u16(...values: number[]): ArrayBuffer {
  return new Uint16Array(values).buffer;
}

const MANIFEST: SpatialManifest = {
  version: SPATIAL_WIRE_VERSION,
  id: 'visium-brain',
  name: 'Visium mouse brain',
  count: 3,
  columns: [
    { kind: 'categorical', name: 'cluster', categories: ['Cortex', 'Hippocampus'] },
    { kind: 'continuous', name: 'total_counts', logScaleHint: true },
  ],
  features: { count: 2, names: ['Ttr', 'Fth1'] },
  radius: { mode: 'uniform', value: 27.5 },
};

describe('SpatialDataHttpService', () => {
  let service: SpatialDataHttpService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [SpatialDataHttpService],
    });
    service = TestBed.inject(SpatialDataHttpService);
    http = TestBed.inject(HttpTestingController);
    service.configure({ baseUrl: BASE });
  });

  afterEach(() => http.verify());

  /** Drive selectDataset() to completion against the mock backend. */
  async function loadDataset(manifest: SpatialManifest = MANIFEST) {
    const promise = service.selectDataset(manifest.id);
    http.expectOne(`${BASE}/spatial/${manifest.id}/manifest`).flush(manifest);
    await Promise.resolve();
    http.expectOne(`${BASE}/spatial/${manifest.id}/coords`).flush(f32(1, 2, 3, 4, 5, 6));
    if (manifest.hasIds) {
      await Promise.resolve();
      http.expectOne(`${BASE}/spatial/${manifest.id}/ids`).flush({ ids: ['a', 'b', 'c'] });
    }
    if (manifest.radius?.mode === 'per-observation') {
      await Promise.resolve();
      http.expectOne(`${BASE}/spatial/${manifest.id}/radius`).flush(f32(9, 9, 9));
    }
    return promise;
  }

  describe('configure', () => {
    it('normalises a base URL without a trailing slash', async () => {
      service.configure({ baseUrl: 'http://example.test/api' });
      const promise = service.selectDataset('d');
      http.expectOne('http://example.test/api/spatial/d/manifest')
        .flush({ ...MANIFEST, id: 'd' });
      await Promise.resolve();
      http.expectOne('http://example.test/api/spatial/d/coords').flush(f32(1, 2, 3, 4, 5, 6));
      await promise;
    });

    it('does not double the slash when one is already there', async () => {
      service.configure({ baseUrl: 'http://example.test/api/' });
      const promise = service.selectDataset('d');
      http.expectOne('http://example.test/api/spatial/d/manifest')
        .flush({ ...MANIFEST, id: 'd' });
      await Promise.resolve();
      http.expectOne('http://example.test/api/spatial/d/coords').flush(f32(1, 2, 3, 4, 5, 6));
      await promise;
    });
  });

  describe('selectDataset', () => {
    it('fetches only the manifest and coords when ids/radius are not per-observation', async () => {
      const dataset = await loadDataset();
      expect(dataset.observations.count).toBe(3);
      expect(Array.from(dataset.observations.x)).toEqual([1, 2, 3]);
      expect(Array.from(dataset.observations.y)).toEqual([4, 5, 6]);
      expect(dataset.observations.radius).toBe(27.5);
      expect(dataset.observations.ids).toBeUndefined();
      http.verify(); // no ids/radius requests were made
    });

    it('fetches ids and a radius vector when the manifest declares them', async () => {
      const dataset = await loadDataset({
        ...MANIFEST, hasIds: true, radius: { mode: 'per-observation' },
      });
      expect(dataset.observations.ids).toEqual(['a', 'b', 'c']);
      expect(Array.from(dataset.observations.radius as Float32Array)).toEqual([9, 9, 9]);
    });

    it('publishes the dataset on getDataset$', async () => {
      const seen: (string | null)[] = [];
      service.getDataset$().subscribe((d) => seen.push(d?.id ?? null));
      await loadDataset();
      expect(seen).toEqual([null, 'visium-brain']);
    });

    it('rejects a manifest from a newer wire version instead of mis-decoding it', async () => {
      const promise = service.selectDataset('x');
      http.expectOne(`${BASE}/spatial/x/manifest`).flush({ ...MANIFEST, id: 'x', version: 99 });
      await expect(promise).rejects.toThrow(/unsupported wire version 99/);
    });
  });

  describe('concurrent selections', () => {
    it('publishes only the newest, and rejects the one it overtook', async () => {
      // Two selections in flight, the FIRST answering last: without sequencing it
      // publishes after the second, leaving `manifest` and the observations from
      // two different datasets — which is worse than either arriving late.
      const other: SpatialManifest = { ...MANIFEST, id: 'other', count: 2 };
      const published: (string | null)[] = [];
      const sub = service.getDataset$().subscribe((d) => published.push(d?.id ?? null));

      const slow = service.selectDataset(MANIFEST.id);
      // Handled from the moment it exists: it rejects during a flush below, and an
      // unhandled rejection there fails the run before any assertion is reached.
      const slowSettled = slow.then(() => 'resolved', (e: Error) => e.name);
      const slowManifest = http.expectOne(`${BASE}/spatial/${MANIFEST.id}/manifest`);
      const fast = service.selectDataset(other.id);
      const fastManifest = http.expectOne(`${BASE}/spatial/${other.id}/manifest`);

      // The newer one completes first…
      fastManifest.flush(other);
      await Promise.resolve();
      http.expectOne(`${BASE}/spatial/${other.id}/coords`).flush(f32(1, 2, 4, 5));
      await expect(fast).resolves.toMatchObject({ id: 'other' });

      // …then the older one's manifest arrives, and it stops there: no coords
      // request follows, so a dataset nobody wants costs one response, not four.
      slowManifest.flush(MANIFEST);
      await Promise.resolve();
      http.expectNone(`${BASE}/spatial/${MANIFEST.id}/coords`);
      expect(await slowSettled).toBe('SupersededError');

      // The last thing published is the newer dataset, not the older one.
      expect(published.filter((id) => id !== null).at(-1)).toBe('other');
      sub.unsubscribe();
    });

    it('lets a clear supersede a selection still in flight', async () => {
      const pending = service.selectDataset(MANIFEST.id);
      const settled = pending.then(() => 'resolved', (e: Error) => e.name);
      const manifest = http.expectOne(`${BASE}/spatial/${MANIFEST.id}/manifest`);

      service.clear();
      manifest.flush(MANIFEST);
      await Promise.resolve();

      expect(await settled).toBe('SupersededError');
      // Nothing published: a clear is the newest intent, not a slower request.
      let latest: string | null | undefined;
      service.getDataset$().subscribe((d) => { latest = d?.id ?? null; }).unsubscribe();
      expect(latest).toBeNull();
    });
  });

  describe('getColumn', () => {
    it('decodes a categorical column', async () => {
      await loadDataset();
      const promise = service.getColumn('cluster');
      http.expectOne(`${BASE}/spatial/visium-brain/column/cluster`).flush(u16(0, 1, 1));
      const col = await promise;
      expect(isCategoricalColumn(col)).toBe(true);
      if (isCategoricalColumn(col)) {
        expect(Array.from(col.codes)).toEqual([0, 1, 1]);
        expect(col.meta.categories).toEqual(['Cortex', 'Hippocampus']);
      }
    });

    it('decodes a continuous column and keeps its metadata', async () => {
      await loadDataset();
      const promise = service.getColumn('total_counts');
      http.expectOne(`${BASE}/spatial/visium-brain/column/total_counts`).flush(f32(10, 20, 30));
      const col = await promise;
      if (isContinuousColumn(col)) {
        expect(Array.from(col.values)).toEqual([10, 20, 30]);
        expect(col.meta.logScaleHint).toBe(true);
      }
    });

    it('serves a repeat request from cache without a second round-trip', async () => {
      await loadDataset();
      const first = service.getColumn('cluster');
      http.expectOne(`${BASE}/spatial/visium-brain/column/cluster`).flush(u16(0, 1, 1));
      await first;

      const second = await service.getColumn('cluster');
      expect(isCategoricalColumn(second)).toBe(true);
      http.verify(); // no second request
    });

    it('rejects an unknown column, naming the ones that exist', async () => {
      await loadDataset();
      await expect(service.getColumn('nope')).rejects
        .toThrow(/unknown column "nope".*cluster, total_counts/s);
    });

    it('throws before a dataset is selected', () => {
      expect(() => service.getColumn('cluster')).toThrow(/no dataset selected/);
    });
  });

  describe('getFeatureVector', () => {
    it('fetches and decodes a gene vector', async () => {
      await loadDataset();
      const promise = service.getFeatureVector('Ttr');
      http.expectOne(`${BASE}/spatial/visium-brain/feature/Ttr`).flush(f32(0, 5, 12));
      expect(Array.from(await promise)).toEqual([0, 5, 12]);
    });

    it('coalesces concurrent requests for the same gene into one fetch', async () => {
      await loadDataset();
      const a = service.getFeatureVector('Ttr');
      const b = service.getFeatureVector('Ttr');
      http.expectOne(`${BASE}/spatial/visium-brain/feature/Ttr`).flush(f32(0, 5, 12));
      expect(Array.from(await a)).toEqual([0, 5, 12]);
      expect(await b).toBe(await a); // same instance, one request
    });

    it('rejects a gene the manifest does not list', async () => {
      await loadDataset();
      await expect(service.getFeatureVector('NotAGene')).rejects.toThrow(/unknown feature/);
    });

    it('bounds the cache, evicting least-recently-used entries', async () => {
      const wide = {
        ...MANIFEST,
        features: { count: 40, names: Array.from({ length: 40 }, (_, i) => `G${i}`) },
      };
      await loadDataset(wide);

      // 33 distinct genes with a 32-entry cache: G0 must have been evicted.
      for (let i = 0; i < 33; i++) {
        const p = service.getFeatureVector(`G${i}`);
        http.expectOne(`${BASE}/spatial/visium-brain/feature/G${i}`).flush(f32(i, i, i));
        await p;
      }
      const refetch = service.getFeatureVector('G0');
      http.expectOne(`${BASE}/spatial/visium-brain/feature/G0`).flush(f32(0, 0, 0));
      await refetch;

      // ...while a recently used one is still resident.
      await service.getFeatureVector('G32');
      http.verify();
    });
  });

  describe('searchFeatures', () => {
    it('filters inlined names locally, with no round-trip', async () => {
      await loadDataset();
      expect(await service.searchFeatures('tt')).toEqual(['Ttr']);
      http.verify();
    });

    it('asks the server when the manifest did not inline the names', async () => {
      await loadDataset({ ...MANIFEST, features: { count: 31053 } });
      const promise = service.searchFeatures('Ttr', 5);
      http.expectOne(`${BASE}/spatial/visium-brain/features?q=Ttr&limit=5`)
        .flush({ names: ['Ttr', 'Ttry'] });
      expect(await promise).toEqual(['Ttr', 'Ttry']);
    });
  });

  describe('getPolygons', () => {
    it('rejects for a dataset with no boundary geometry', async () => {
      await loadDataset();
      await expect(service.getPolygons()).rejects.toThrow(/no polygon geometry/);
    });

    it('fetches once and reuses the result', async () => {
      await loadDataset({ ...MANIFEST, polygons: { count: 1 } });
      const blob = new Uint8Array(new ArrayBuffer(4 + 8 + 6 * 4));
      new Uint32Array(blob.buffer, 0, 1)[0] = 1;
      new Uint32Array(blob.buffer, 4, 2).set([0, 3]);
      new Float32Array(blob.buffer, 12, 6).set([0, 0, 1, 0, 0, 1]);

      const first = service.getPolygons();
      http.expectOne(`${BASE}/spatial/visium-brain/polygons`).flush(blob.buffer);
      const poly = await first;
      expect(poly.count).toBe(1);
      expect(Array.from(poly.offsets)).toEqual([0, 3]);

      expect(await service.getPolygons()).toBe(poly);
      http.verify();
    });
  });

  describe('clear', () => {
    it('drops the dataset and the cache, so the next read refetches', async () => {
      await loadDataset();
      const p = service.getColumn('cluster');
      http.expectOne(`${BASE}/spatial/visium-brain/column/cluster`).flush(u16(0, 1, 1));
      await p;

      service.clear();
      expect(() => service.getColumn('cluster')).toThrow(/no dataset selected/);

      await loadDataset();
      const again = service.getColumn('cluster');
      http.expectOne(`${BASE}/spatial/visium-brain/column/cluster`).flush(u16(1, 1, 1));
      await again; // cache was cleared, so the request happened again
    });
  });

  /**
   * Embeddings, fetched lazily like a column or a gene.
   *
   * `getEmbedding` is OPTIONAL on the port, so a host with none omits it; this adapter has it, and
   * gates on the manifest so an unknown name fails loudly rather than plotting nothing.
   */
  describe('getEmbedding', () => {
    const withUmap: SpatialManifest = {
      ...MANIFEST,
      embeddings: [{ name: 'X_umap', label: 'UMAP', dims: 2 }],
    };

    it('fetches the coordinates and decodes them per dimension', async () => {
      await loadDataset(withUmap);
      const promise = service.getEmbedding('X_umap');
      // count=3, dims=2 -> every d0 then every d1.
      http.expectOne(`${BASE}/spatial/${withUmap.id}/embedding/X_umap`)
        .flush(f32(1, 2, 3, 40, 50, 60));
      const e = await promise;
      expect(Array.from(e.x)).toEqual([1, 2, 3]);
      expect(Array.from(e.y)).toEqual([40, 50, 60]);
      expect(e.meta.label).toBe('UMAP');
    });

    it('rejects an embedding the manifest does not advertise, without a request', () => {
      // http.verify() in afterEach is what proves no request went out: a typo must not
      // reach the network and come back as a 404 the user has to interpret.
      return loadDataset(withUmap).then(async () => {
        await expect(service.getEmbedding('X_tsne')).rejects.toThrow(/unknown embedding "X_tsne"/);
      });
    });

    it('rejects when the dataset advertises no embeddings at all', async () => {
      await loadDataset();
      await expect(service.getEmbedding('X_umap')).rejects.toThrow(/unknown embedding/);
    });

    it('fetches once, however often it is asked', async () => {
      await loadDataset(withUmap);
      const first = service.getEmbedding('X_umap');
      // Asked again while the first is still in flight: one request, both resolve.
      const second = service.getEmbedding('X_umap');
      http.expectOne(`${BASE}/spatial/${withUmap.id}/embedding/X_umap`)
        .flush(f32(1, 2, 3, 40, 50, 60));
      await Promise.all([first, second]);
      const third = await service.getEmbedding('X_umap');
      expect(Array.from(third.x)).toEqual([1, 2, 3]);
      // No further expectOne; afterEach's verify() fails if another request was made.
    });

    it('carries the embeddings through onto the dataset', async () => {
      const ds = await loadDataset(withUmap);
      expect(ds?.embeddings).toEqual([{ name: 'X_umap', label: 'UMAP', dims: 2 }]);
    });
  });

});
