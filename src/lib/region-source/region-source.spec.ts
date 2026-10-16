import { HTTP_INTERCEPTORS, HttpClient, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { openHttpRegionSource } from './http-region-source';
import { RegionTileCache, isAbortError } from './region-source';
import { RegionSourceMessage, RegionSourceReply, RegionSourceTables } from './region-source-ops';
import { RegionFeatureTable, RegionTile } from './region-tiles';
import { RegionSourceWorkerClient, openGeoJsonRegionSource } from './worker-region-source';

const square = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'a',
      properties: { classification: { name: 'A', color: [0, 255, 0] } },
      geometry: { type: 'Polygon', coordinates: [square(0, 0, 100)] },
    },
    {
      type: 'Feature',
      id: 'b',
      properties: { classification: 'B' },
      geometry: { type: 'Polygon', coordinates: [square(600, 0, 100)] },
    },
  ],
});

/** A worker that answers from a real table set, asynchronously, until it is told to crash. */
class FakeWorker {
  onmessage: ((e: MessageEvent<RegionSourceReply>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readonly tables = new RegionSourceTables();
  readonly posted: RegionSourceMessage[] = [];
  terminated = false;
  hold = false;

  postMessage(msg: RegionSourceMessage): void {
    this.posted.push(msg);
    if (this.hold) return;
    setTimeout(() => this.answer(msg));
  }

  answer(msg: RegionSourceMessage): void {
    let reply: RegionSourceReply;
    try {
      reply = { id: msg.id, ok: true, result: this.tables.run(msg) };
    } catch (err) {
      reply = { id: msg.id, ok: false, error: (err as Error).message };
    }
    this.onmessage?.({ data: reply } as MessageEvent<RegionSourceReply>);
  }

  crash(): void {
    this.onerror?.(new Event('error'));
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('RegionTileCache', () => {
  const tile = (gx: number): RegionTile => ({ z: 0, level: 0, gx, gy: 0, features: [] });

  it('loads a tile once and evicts the least recently used', async () => {
    const cache = new RegionTileCache(2);
    const load = jest.fn((gx: number) => Promise.resolve(tile(gx)));
    await cache.get(0, { level: 0, gx: 1, gy: 0 }, () => load(1));
    await cache.get(0, { level: 0, gx: 1, gy: 0 }, () => load(1));
    await cache.get(0, { level: 0, gx: 2, gy: 0 }, () => load(2));
    await cache.get(0, { level: 0, gx: 1, gy: 0 }, () => load(1)); // 1 is now the most recent
    await cache.get(0, { level: 0, gx: 3, gy: 0 }, () => load(3)); // evicts 2
    await cache.get(0, { level: 0, gx: 1, gy: 0 }, () => load(1));
    await cache.get(0, { level: 0, gx: 2, gy: 0 }, () => load(2));
    expect(load.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 2]);
  });

  it('forgets a tile that failed', async () => {
    const cache = new RegionTileCache();
    const load = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(tile(0));
    await expect(cache.get(0, { level: 0, gx: 0, gy: 0 }, load)).rejects.toThrow('x');
    await expect(cache.get(0, { level: 0, gx: 0, gy: 0 }, load)).resolves.toEqual(tile(0));
  });
});

describe('openGeoJsonRegionSource', () => {
  it('tiles on the main thread where there is no worker', async () => {
    const source = await openGeoJsonRegionSource(GEOJSON, new RegionSourceWorkerClient());
    expect(source.info.featureCount).toBe(2);
    expect(source.info.classColors).toEqual({ A: '#00ff00' });
    const t = await source.getTile(0, { level: 0, gx: 1, gy: 0 });
    expect(t.features.map((f) => f.id)).toEqual(['b']);
    expect((await source.getFeatures(['a']))[0].feature.id).toBe('a');
    expect((await source.getIndex(0, { offset: 0, limit: 10, exclude: ['a'] })).total).toBe(1);
    expect(JSON.parse(await source.exportGeoJson(['b'], [])).features).toHaveLength(1);
  });

  it('rejects text that is not a feature collection', async () => {
    await expect(openGeoJsonRegionSource('{"a":1}', new RegionSourceWorkerClient())).rejects.toThrow('features');
  });

  it('caches tiles and lets a caller stop waiting', async () => {
    const worker = new FakeWorker();
    const source = await openGeoJsonRegionSource(
      GEOJSON,
      new RegionSourceWorkerClient(() => worker as unknown as Worker),
    );
    await source.getTile(0, { level: 0, gx: 0, gy: 0 });
    await source.getTile(0, { level: 0, gx: 0, gy: 0 });
    expect(worker.posted.filter((m) => m.op === 'tile')).toHaveLength(1);

    const ctrl = new AbortController();
    const pending = source.getTile(0, { level: 0, gx: 1, gy: 0 }, ctrl.signal);
    ctrl.abort();
    const err = await pending.catch((e) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it('re-opens on the main thread when the worker dies, once for every interrupted call', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = new FakeWorker();
    const client = new RegionSourceWorkerClient(() => worker as unknown as Worker);
    const source = await openGeoJsonRegionSource(GEOJSON, client);
    worker.hold = true;
    const a = source.getFeatures(['a']);
    const b = source.getIndex(0, { offset: 0, limit: 5 });
    await Promise.resolve();
    await Promise.resolve();
    worker.crash();
    expect(worker.terminated).toBe(true);
    expect(client.inThread).toBe(true);
    expect((await a)[0].id).toBe('a');
    expect((await b).total).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('re-opens a source that was idle when the worker died, and never reads another source by its old handle', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = new FakeWorker();
    const client = new RegionSourceWorkerClient(() => worker as unknown as Worker);
    const first = await openGeoJsonRegionSource(GEOJSON, client);
    const other = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'a',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [square(5, 5, 1)] },
        },
      ],
    });
    const second = await openGeoJsonRegionSource(other, client);
    // Nothing in flight: no call is told the worker is gone.
    worker.crash();
    // A source opened since lives in the main-thread tables, under a handle the old ones may share.
    const third = await openGeoJsonRegionSource(GEOJSON, client);
    const [a1, a2, a3] = await Promise.all([first, second, third].map((s) => s.getFeatures(['a'])));
    expect(a1).toEqual(a3);
    expect(a2).not.toEqual(a1);
    // Concurrent calls after the crash share one re-open.
    const opens = () => worker.posted.filter((m) => m.op === 'open').length;
    const before = opens();
    await Promise.all([second.getFeatures(['a']), second.getIndex(0, { offset: 0, limit: 5 })]);
    expect(opens()).toBe(before);
    warn.mockRestore();
  });

  it('opens on the main thread when the worker dies under the open', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = new FakeWorker();
    const client = new RegionSourceWorkerClient(() => worker as unknown as Worker);
    worker.hold = true;
    const opening = openGeoJsonRegionSource(GEOJSON, client);
    await new Promise((r) => setTimeout(r));
    worker.crash();
    const source = await opening;
    expect((await source.getFeatures(['b']))[0].id).toBe('b');
    warn.mockRestore();
  });

  it('closes its table on dispose', async () => {
    const worker = new FakeWorker();
    const source = await openGeoJsonRegionSource(
      GEOJSON,
      new RegionSourceWorkerClient(() => worker as unknown as Worker),
    );
    source.dispose();
    await new Promise((r) => setTimeout(r));
    expect(worker.posted.some((m) => m.op === 'close')).toBe(true);
  });
});

describe('openHttpRegionSource', () => {
  const table = RegionFeatureTable.fromGeoJson(GEOJSON);

  function server() {
    return jest.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('http://x/regions/', '');
      const body = init?.body ? JSON.parse(init.body as string) : null;
      let out: unknown;
      if (path === 'info') out = table.info();
      else if (path.startsWith('tile/')) {
        const [z, level, gx, gy] = path.slice(5).split('/').map(Number);
        out = {
          features: table
            .tile(z, level, gx, gy)
            .features.map((f) => ({ ...f, rings: f.rings.map((r) => Array.from(r)) })),
        };
      } else if (path === 'features') out = { features: table.features(body.ids) };
      else if (path === 'index') out = table.index(body.z, body);
      else if (path === 'classes') out = table.classCounts(body.all === true ? null : body.z, body.exclude);
      else if (path === 'export')
        return { ok: true, status: 200, text: async () => table.exportGeoJson(body.exclude, body.extra) };
      else return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => JSON.stringify(out) };
    });
  }

  it('reads info, tiles, features, the index and the export from the server', async () => {
    const fetchFn = server();
    const source = await openHttpRegionSource('http://x/regions', { fetch: fetchFn as unknown as typeof fetch });
    expect(source.info.featureCount).toBe(2);
    const t = await source.getTile(0, { level: 0, gx: 0, gy: 0 });
    expect(t.features[0].id).toBe('a');
    expect(t.features[0].rings[0]).toBeInstanceOf(Float32Array);
    await source.getTile(0, { level: 0, gx: 0, gy: 0 });
    expect(fetchFn.mock.calls.filter((c) => c[0].includes('/tile/'))).toHaveLength(1);
    expect((await source.getFeatures(['b']))[0].id).toBe('b');
    expect(await source.getFeatures([])).toEqual([]);
    expect((await source.getIndex(0, { offset: 0, limit: 1 })).rows).toHaveLength(1);
    expect(JSON.parse(await source.exportGeoJson(['a'], [])).features.map((f: { id: string }) => f.id)).toEqual([
      'b',
    ]);
    const post = fetchFn.mock.calls.find((c) => c[0].endsWith('/features'))![1] as RequestInit;
    expect(post.method).toBe('POST');
  });

  it("asks for one plane's class counts, or every plane's as `all`", async () => {
    const fetchFn = server();
    const source = await openHttpRegionSource('http://x/regions', { fetch: fetchFn as unknown as typeof fetch });
    expect(await source.getClassCounts(0)).toEqual(table.classCounts(0));
    expect(await source.getClassCounts(null, ['a'])).toEqual(table.classCounts(null, ['a']));
    const bodies = fetchFn.mock.calls
      .filter((c) => c[0].endsWith('/classes'))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies).toEqual([
      { z: 0, exclude: [] },
      { all: true, exclude: ['a'] },
    ]);
  });

  it('fails on an HTTP error', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 500, text: async () => '' }));
    await expect(
      openHttpRegionSource('http://x/regions/', { fetch: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow('500');
  });
  describe("through the host's HttpClient", () => {
    /** A host's auth interceptor, as jit-ui's adds its bearer token. */
    class Auth implements HttpInterceptor {
      intercept(req: HttpRequest<unknown>, next: HttpHandler) {
        return next.handle(req.clone({ setHeaders: { Authorization: 'Bearer t' } }));
      }
    }
    let http: HttpClient;
    let server: HttpTestingController;
    const settle = () => new Promise((r) => setTimeout(r));

    beforeEach(() => {
      TestBed.configureTestingModule({
        imports: [HttpClientTestingModule],
        providers: [{ provide: HTTP_INTERCEPTORS, useClass: Auth, multi: true }],
      });
      http = TestBed.inject(HttpClient);
      server = TestBed.inject(HttpTestingController);
    });

    afterEach(() => server.verify());

    it('sends every request through it, so the host’s interceptors apply', async () => {
      const opening = openHttpRegionSource('http://x/regions', { http });
      const info = server.expectOne('http://x/regions/info');
      expect(info.request.method).toBe('GET');
      expect(info.request.headers.get('Authorization')).toBe('Bearer t');
      info.flush(JSON.stringify(table.info()));
      const source = await opening;
      expect(source.info.featureCount).toBe(2);

      const tile = source.getTile(0, { level: 0, gx: 0, gy: 0 });
      await settle();
      const t = server.expectOne('http://x/regions/tile/0/0/0/0');
      expect(t.request.headers.get('Authorization')).toBe('Bearer t');
      t.flush(
        JSON.stringify({
          features: table
            .tile(0, 0, 0, 0)
            .features.map((f) => ({ ...f, rings: f.rings.map((r) => Array.from(r)) })),
        }),
      );
      expect((await tile).features[0].rings[0]).toBeInstanceOf(Float32Array);

      const features = source.getFeatures(['b']);
      await settle();
      const post = server.expectOne('http://x/regions/features');
      expect(post.request.method).toBe('POST');
      expect(post.request.body).toEqual({ ids: ['b'] });
      expect(post.request.headers.get('Authorization')).toBe('Bearer t');
      post.flush(JSON.stringify({ features: table.features(['b']) }));
      expect((await features)[0].id).toBe('b');
    });

    it('fails on an HTTP error with its status', async () => {
      const opening = openHttpRegionSource('http://x/regions', { http });
      server.expectOne('http://x/regions/info').flush('no', { status: 401, statusText: 'Unauthorized' });
      await expect(opening).rejects.toThrow('HTTP 401');
    });
  });
});
