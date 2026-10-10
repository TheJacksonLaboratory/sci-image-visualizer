import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

import { ALL_GENES, SpatialDataPort, TranscriptTileQuery } from '../../contracts/ports/spatial-data.port';
import {
  SpatialColumn,
  SpatialDataset,
  SpatialDensityRaster,
  SpatialEmbedding,
  SpatialPolygonTile,
  SpatialPolygons,
  CategoricalColumnMeta,
  SpatialMarkerGenes,
  SpatialTranscriptCounts,
  SpatialTranscriptSummary,
  SpatialTranscriptTile,
  findColumnMeta,
} from '../../contracts/spatial-dataset.contract';
import {
  SpatialDatasetSummary,
  SpatialManifest,
  assertManifestVersion,
  datasetFromManifest,
  decodeColumn,
  decodeCoords,
  decodeDensity,
  decodeEmbedding,
  decodeFeatureVector,
  decodePolygonTile,
  decodePolygons,
  decodeRadius,
  decodeTranscriptTile,
} from './spatial-wire';
import { searchGeneNames } from '../../spatial/gene-search';
import { Supersede } from '../../util/supersede';

/**
 * A dataset selection that a newer selection (or a `clear`) overtook.
 *
 * Thrown rather than resolved so a caller cannot mistake it for "this dataset is
 * now loaded": nothing was published, on purpose.
 */
export class SupersededError extends Error {
  constructor(id: string) {
    super(`[spatial] selection of "${id}" was superseded by a newer one`);
    this.name = 'SupersededError';
  }
}

/**
 * What the LRU can hold. One alias rather than a union repeated at each use, so adding a payload
 * kind is a single edit instead of four that can drift apart.
 */
type CachedPayload = SpatialColumn | Float32Array | SpatialEmbedding | SpatialDensityRaster;

/**
 * Bytes a decoded payload holds: its own typed-array views, one level deep — every
 * payload here is a typed array or a flat record of them.
 */
function payloadBytes(value: unknown): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  let bytes = 0;
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) if (ArrayBuffer.isView(v)) bytes += v.byteLength;
  }
  return bytes;
}

const MiB = 1024 * 1024;

/**
 * Reference {@link SpatialDataPort} adapter for the wire format the bundled
 * example server speaks (see `spatial-wire.ts` and
 * `examples/tile-server/lib/spatial.mjs`).
 *
 * OPTIONAL AND UNBOUND BY DEFAULT — this service is `@Injectable()` without
 * `providedIn`, so nothing gets it unless a host explicitly provides it:
 *
 * ```ts
 * providers: [
 *   SpatialDataHttpService,
 *   { provide: SPATIAL_DATA_PORT, useExisting: SpatialDataHttpService },
 * ]
 * ```
 *
 * That mirrors `CellposeSegmenterService`: a concrete implementation the
 * library ships for convenience, not a default the port inversion is quietly
 * giving up on. A host with its own backend implements `SpatialDataPort`
 * directly and never touches this class.
 *
 * Requests go through Angular's `HttpClient` (not `fetch`) so the host's
 * interceptors — auth headers above all — apply, matching `tile-client.ts`.
 */
@Injectable()
export class SpatialDataHttpService implements SpatialDataPort {
  /** Server root, normalised to end with exactly one `/`. */
  private baseUrl = '';
  /** Per-request ceiling. Vectors are small; a hung request should not wedge
   *  the picker. */
  private timeoutMs = 30_000;

  private readonly dataset$ = new BehaviorSubject<SpatialDataset | null>(null);
  private manifest: SpatialManifest | null = null;
  /** Advanced by every `selectDataset` and every `clear`, so a selection that
   *  finishes after a newer intent can tell and drop what it fetched. Cache fills
   *  take a {@link Supersede.current snapshot} of it, so a vector or tile that lands
   *  after a switch is returned to its caller but never kept for the next dataset. */
  private readonly selection = new Supersede();

  /**
   * Loaded vectors, keyed `column:<name>` / `feature:<name>`. Bounded LRU:
   * colouring by cluster → by a gene → back by cluster must not refetch, but an
   * afternoon of browsing genes must not grow without limit either.
   *
   * Bounded by BYTES as well as entries: one vector is `4·N` bytes — 2 MB at 500k
   * cells, but 14.8 MB at 3.7M, where 32 entries (an embedding is two or three
   * vectors) could pin close to half a gigabyte.
   */
  private readonly cache = new Map<string, { value: CachedPayload; bytes: number }>();
  private cachedBytes = 0;
  private static readonly CACHE_LIMIT = 32;
  private cacheBytes = 256 * MiB;

  /** In-flight requests, so double-clicking a gene issues one fetch. */
  private readonly inFlight = new Map<string, Promise<CachedPayload>>();

  /**
   * Tiles get their own, larger cache: panning revisits them constantly, and one screen
   * of a zoomed-out section is dozens of them — far past the vector cache's limit.
   */
  private readonly tileCache = new Map<string, Promise<SpatialPolygonTile | SpatialTranscriptTile>>();
  private static readonly TILE_CACHE_LIMIT = 384;
  /** Bytes of each RESOLVED tile in {@link tileCache}; a pending one counts once it lands. */
  private readonly tileBytes = new Map<string, number>();
  private tileBytesTotal = 0;
  private tileCacheBytes = 128 * MiB;

  private volumePromise: Promise<Uint8Array> | null = null;
  private polygonsPromise: Promise<SpatialPolygons> | null = null;

  constructor(private http: HttpClient) {}

  // ── configuration ───────────────────────────────────────────────────────

  /**
   * Point the adapter at a server. Clears any loaded dataset.
   *
   * `cacheBytes` / `tileCacheBytes` cap the decoded vectors (default 256 MiB) and tiles
   * (default 128 MiB) kept for reuse; the most recent entry is always kept.
   */
  configure(options: { baseUrl: string; timeoutMs?: number; cacheBytes?: number; tileCacheBytes?: number }): void {
    const raw = options.baseUrl ?? '';
    this.baseUrl = raw.endsWith('/') ? raw : `${raw}/`;
    if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
    if (options.cacheBytes !== undefined) this.cacheBytes = options.cacheBytes;
    if (options.tileCacheBytes !== undefined) this.tileCacheBytes = options.tileCacheBytes;
    this.clear();
  }

  /** Datasets this server offers, for a host-side picker. */
  listDatasets(): Promise<SpatialDatasetSummary[]> {
    return this.getJson<{ datasets: SpatialDatasetSummary[] }>('spatial/datasets').then((r) => r.datasets ?? []);
  }

  /**
   * One dataset's manifest, WITHOUT selecting it. Lets a host inspect what a
   * server offers — column and feature metadata, and which image a dataset
   * registers onto — while building a picker, rather than having to load each
   * dataset to find out.
   */
  readManifest(id: string): Promise<SpatialManifest> {
    return this.getJson<SpatialManifest>(`spatial/${encodeURIComponent(id)}/manifest`).then((manifest) => {
      assertManifestVersion(manifest);
      return manifest;
    });
  }

  /**
   * Load a dataset and publish it on {@link getDataset$}. Fetches the manifest,
   * then, in parallel, the vectors that are always needed (coordinates, and
   * ids/radius when the manifest says they exist) — nothing else.
   */
  async selectDataset(id: string): Promise<SpatialDataset> {
    this.clear();
    // Selections are SEQUENCED: this is two awaits deep, so a slower earlier
    // call would otherwise assign `this.manifest` or publish its dataset after a
    // later one — leaving the manifest and the observations from two different
    // datasets, which is worse than either being late.
    const task = this.selection.next();
    const superseded = () => !task.isCurrent();
    const path = `spatial/${encodeURIComponent(id)}`;

    const manifest = await this.getJson<SpatialManifest>(`${path}/manifest`);
    assertManifestVersion(manifest);
    if (superseded()) throw new SupersededError(id);
    this.manifest = manifest;

    // Independent of each other, so requested together: time to first paint is the
    // slowest of them, not their sum (the ids JSON alone is tens of MB on a large dataset).
    const [coordsBuf, ids, radiusBuf] = await Promise.all([
      this.getBinary(`${path}/coords`),
      manifest.hasIds ? this.getJson<{ ids: string[] }>(`${path}/ids`).then((r) => r.ids) : undefined,
      manifest.radius?.mode === 'per-observation' ? this.getBinary(`${path}/radius`) : undefined,
    ]);
    if (superseded()) throw new SupersededError(id);
    const coords = decodeCoords(coordsBuf, manifest.count, !!manifest.hasZ);
    const radius = radiusBuf ? decodeRadius(radiusBuf, manifest.count) : undefined;

    const dataset = datasetFromManifest(manifest, coords, { ids, radius });
    this.dataset$.next(dataset);
    return dataset;
  }

  /** Drop the loaded dataset and every cached vector. */
  clear(): void {
    // A clear is itself the newest intent, so it supersedes any selection still
    // in flight rather than letting one land afterwards.
    this.selection.cancel();
    this.manifest = null;
    this.cache.clear();
    this.cachedBytes = 0;
    this.inFlight.clear();
    this.tileCache.clear();
    this.tileBytes.clear();
    this.tileBytesTotal = 0;
    this.summaryCache.clear();
    this.polygonsPromise = null;
    this.volumePromise = null;
    if (this.dataset$.value !== null) this.dataset$.next(null);
  }

  // ── SpatialDataPort ─────────────────────────────────────────────────────

  getDataset$(): Observable<SpatialDataset | null> {
    return this.dataset$.asObservable();
  }

  getColumn(name: string): Promise<SpatialColumn> {
    const manifest = this.requireManifest();
    const dataset = this.dataset$.value!;
    const meta = findColumnMeta(dataset, name);
    if (!meta) {
      // Reject rather than resolve empty: a typo must surface as an error, not
      // as a plot that silently renders every point as "no data".
      return Promise.reject(
        new Error(
          `[spatial] unknown column "${name}". Available: ${dataset.columns.map((c) => c.name).join(', ')}`,
        ),
      );
    }
    return this.fetchCached(`column:${name}`, () =>
      this.getBinary(`spatial/${encodeURIComponent(manifest.id)}/column/${encodeURIComponent(name)}`).then((buf) =>
        decodeColumn(buf, meta, manifest.count),
      ),
    ) as Promise<SpatialColumn>;
  }

  getEmbedding(name: string): Promise<SpatialEmbedding> {
    const manifest = this.requireManifest();
    const meta = manifest.embeddings?.find((e) => e.name === name);
    if (!meta) {
      return Promise.reject(new Error(`[spatial] unknown embedding "${name}"`));
    }
    return this.fetchCached(`embedding:${name}`, () =>
      this.getBinary(`spatial/${encodeURIComponent(manifest.id)}/embedding/${encodeURIComponent(name)}`).then(
        (buf) => decodeEmbedding(buf, meta, manifest.count),
      ),
    ) as Promise<SpatialEmbedding>;
  }

  getFeatureVector(name: string): Promise<Float32Array> {
    const manifest = this.requireManifest();
    const names = manifest.features?.names;
    if (names && !names.includes(name)) {
      return Promise.reject(new Error(`[spatial] unknown feature "${name}"`));
    }
    return this.fetchCached(`feature:${name}`, () =>
      this.getBinary(`spatial/${encodeURIComponent(manifest.id)}/feature/${encodeURIComponent(name)}`).then(
        (buf) => decodeFeatureVector(buf, manifest.count),
      ),
    ) as Promise<Float32Array>;
  }

  async searchFeatures(query: string, limit = 50): Promise<string[]> {
    const manifest = this.requireManifest();
    // A dataset that inlined its names (targeted panel) is filtered locally —
    // no round-trip for a keystroke — and ranked as the picker ranks them.
    const names = manifest.features?.names;
    if (names) return searchGeneNames(names, query, limit);
    const url =
      `spatial/${encodeURIComponent(manifest.id)}/features` + `?q=${encodeURIComponent(query)}&limit=${limit}`;
    return (await this.getJson<{ names: string[] }>(url)).names ?? [];
  }

  getPolygons(): Promise<SpatialPolygons> {
    const manifest = this.requireManifest();
    if (!manifest.polygons) {
      return Promise.reject(new Error('[spatial] this dataset has no polygon geometry'));
    }
    // Geometry is one large blob rather than a per-name vector, so it gets its
    // own single-flight slot instead of a cache entry.
    this.polygonsPromise ??= this.getBinary(`spatial/${encodeURIComponent(manifest.id)}/polygons`)
      .then(decodePolygons)
      .catch((err) => {
        this.polygonsPromise = null;
        throw err;
      });
    return this.polygonsPromise;
  }

  getPolygonTile(set: string, level: number, gx: number, gy: number): Promise<SpatialPolygonTile> {
    const manifest = this.requireManifest();
    if (!manifest.polygonTiles) {
      return Promise.reject(new Error('[spatial] this dataset has no tiled polygons'));
    }
    const path =
      `spatial/${encodeURIComponent(manifest.id)}/polygon-tile/` +
      `${encodeURIComponent(set)}/${level}/${gx}/${gy}`;
    return this.cachedTile(path, () =>
      this.getBinary(path).then((buf) => decodePolygonTile(buf, manifest.count)),
    ) as Promise<SpatialPolygonTile>;
  }

  getTranscriptTile(
    level: number,
    gx: number,
    gy: number,
    query: TranscriptTileQuery,
  ): Promise<SpatialTranscriptTile> {
    const manifest = this.requireManifest();
    if (!manifest.transcriptTiles) {
      return Promise.reject(new Error('[spatial] this dataset has no tiled transcripts'));
    }
    const genes = query.genes.map(encodeURIComponent).join(',');
    const box = query.box ? `&box=${query.box.join(',')}` : '';
    const path =
      `spatial/${encodeURIComponent(manifest.id)}/transcript-tile/${level}/${gx}/${gy}` +
      `?genes=${genes}&quality=${query.quality ?? 'high'}${box}`;
    // The codes index the genes asked for — except for ALL_GENES, whose list the
    // server owns, so only the observations can be bounded there.
    const limits = {
      observations: manifest.count,
      ...(query.genes.includes(ALL_GENES) ? {} : { genes: query.genes.length }),
    };
    return this.cachedTile(path, () =>
      this.getBinary(path).then((buf) => decodeTranscriptTile(buf, limits)),
    ) as Promise<SpatialTranscriptTile>;
  }

  getTranscriptGeneBins(level: number, tx: number, ty: number, genes: string[]): Promise<SpatialTranscriptTile> {
    const manifest = this.requireManifest();
    if (!manifest.transcriptGeneBins) {
      return Promise.reject(new Error('[spatial] this dataset has no per-gene bins'));
    }
    const path =
      `spatial/${encodeURIComponent(manifest.id)}/gene-bins/${level}/${tx}/${ty}` +
      `?genes=${genes.map(encodeURIComponent).join(',')}`;
    const limits = {
      observations: manifest.count,
      ...(genes.includes(ALL_GENES) ? {} : { genes: genes.length }),
    };
    return this.cachedTile(path, () =>
      this.getBinary(path).then((buf) => decodeTranscriptTile(buf, limits)),
    ) as Promise<SpatialTranscriptTile>;
  }

  getTranscriptBins(level: number, tx: number, ty: number): Promise<SpatialTranscriptTile> {
    const manifest = this.requireManifest();
    if (!manifest.transcriptBins) {
      return Promise.reject(new Error('[spatial] this dataset has no transcript pyramid'));
    }
    const path = `spatial/${encodeURIComponent(manifest.id)}/transcript-bins/${level}/${tx}/${ty}`;
    return this.cachedTile(path, () =>
      this.getBinary(path).then((buf) => decodeTranscriptTile(buf, { observations: manifest.count })),
    ) as Promise<SpatialTranscriptTile>;
  }

  /** Small JSON answers, keyed by URL — hovering back and forth must not refetch. */
  private readonly summaryCache = new Map<string, Promise<SpatialTranscriptSummary>>();

  getTranscriptSummary(query: {
    box?: [number, number, number, number];
    genes?: string[];
    cells?: number[];
  }): Promise<SpatialTranscriptSummary> {
    const manifest = this.requireManifest();
    const params: string[] = [];
    if (query.box) params.push(`box=${query.box.map((v) => +v.toFixed(3)).join(',')}`);
    if (query.genes?.length) params.push(`genes=${query.genes.map(encodeURIComponent).join(',')}`);
    if (query.cells?.length) params.push(`cells=${query.cells.join(',')}`);
    const url = `spatial/${encodeURIComponent(manifest.id)}/transcript-summary?${params.join('&')}`;
    let hit = this.summaryCache.get(url);
    if (!hit) {
      hit = this.getJson<SpatialTranscriptSummary>(url);
      hit.catch(() => this.summaryCache.delete(url));
      this.summaryCache.set(url, hit);
      if (this.summaryCache.size > 256) this.summaryCache.delete(this.summaryCache.keys().next().value!);
    }
    return hit;
  }

  getDensity(genes: string[], binSize?: number): Promise<SpatialDensityRaster> {
    const manifest = this.requireManifest();
    if (!manifest.density) return Promise.reject(new Error('[spatial] this dataset has no density raster'));
    const list = [...genes];
    const bin = binSize ? `&bin=${binSize}` : '';
    return this.fetchCached(`density:${list.join(',')}:${binSize ?? ''}`, () =>
      this.getBinary(
        `spatial/${encodeURIComponent(manifest.id)}/density?genes=${list.map(encodeURIComponent).join(',')}${bin}`,
      ).then((buf) => decodeDensity(buf, list)),
    ) as Promise<SpatialDensityRaster>;
  }

  async importGroups(label: string, table: string): Promise<{ column: CategoricalColumnMeta; matched: number }> {
    const manifest = this.requireManifest();
    const url = `${this.baseUrl}spatial/${encodeURIComponent(manifest.id)}/groups?name=${encodeURIComponent(label)}`;
    // HttpClient, not fetch: a host's interceptors (its auth header) must apply to the
    // upload as they do to every read, or a protected server refuses it.
    let body: { column: CategoricalColumnMeta; matched: number };
    try {
      body = await firstValueFrom(
        this.http
          .post<{ column: CategoricalColumnMeta; matched: number }>(url, table, {
            headers: { 'Content-Type': 'text/csv' },
          })
          .pipe(timeout(this.timeoutMs)),
      );
    } catch (err) {
      const e = err as HttpErrorResponse;
      throw new Error(e?.error?.error ?? `[spatial] import failed (HTTP ${e?.status ?? '?'})`);
    }
    const column = body.column;
    // The new column joins the dataset: re-emit so every panel sees it.
    const current = this.dataset$.value;
    if (current && this.manifest?.id === manifest.id) {
      const columns = current.columns.filter((c) => c.name !== column.name).concat(column);
      this.manifest = { ...this.manifest, columns };
      this.uncache(`column:${column.name}`);
      this.dataset$.next({ ...current, columns });
    }
    return { column, matched: body.matched };
  }

  getMarkerGenes(column: string, perGroup = 5): Promise<SpatialMarkerGenes> {
    const manifest = this.requireManifest();
    // No per-request timeout: the first computation is a pass over the whole matrix.
    return firstValueFrom(
      this.http.get<SpatialMarkerGenes>(
        `${this.baseUrl}spatial/${encodeURIComponent(manifest.id)}/markers/${encodeURIComponent(column)}?n=${perGroup}`,
      ),
    );
  }

  getTranscriptCounts(genes: string[]): Promise<SpatialTranscriptCounts> {
    const manifest = this.requireManifest();
    return this.getJson<SpatialTranscriptCounts>(
      `spatial/${encodeURIComponent(manifest.id)}/transcript-counts?genes=${genes.map(encodeURIComponent).join(',')}`,
    );
  }

  /** LRU over tile promises, so concurrent asks share one request and a failure is not kept. */
  private cachedTile<T extends SpatialPolygonTile | SpatialTranscriptTile>(
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = this.tileCache.get(key);
    if (hit) {
      this.tileCache.delete(key);
      this.tileCache.set(key, hit);
      return hit as Promise<T>;
    }
    const generation = this.selection.current();
    const promise: Promise<T> = load().then(
      (tile) => {
        // Sized once it lands, and only while it is still the entry under its key.
        if (this.tileCache.get(key) === promise && !this.tileBytes.has(key)) {
          const bytes = payloadBytes(tile);
          this.tileBytes.set(key, bytes);
          this.tileBytesTotal += bytes;
          this.evictTiles();
        }
        return tile;
      },
      (err) => {
        if (this.tileCache.get(key) === promise) this.dropTile(key);
        throw err;
      },
    );
    if (generation.isCurrent()) {
      this.tileCache.set(key, promise);
      this.evictTiles();
    }
    return promise;
  }

  /** Oldest first, past the entry cap or the byte budget, keeping the newest. */
  private evictTiles(): void {
    while (
      this.tileCache.size > 1 &&
      (this.tileCache.size > SpatialDataHttpService.TILE_CACHE_LIMIT || this.tileBytesTotal > this.tileCacheBytes)
    ) {
      this.dropTile(this.tileCache.keys().next().value!);
    }
  }

  private dropTile(key: string): void {
    this.tileCache.delete(key);
    this.tileBytesTotal -= this.tileBytes.get(key) ?? 0;
    this.tileBytes.delete(key);
  }

  /**
   * The reference volume's voxels, single-flighted like the polygons.
   *
   * Validated against the manifest's declared dimensions before it is handed
   * back: a short or long buffer read as a 3D texture does not fail, it shears
   * the anatomy into diagonal streaks, and that is far harder to recognise as a
   * transport problem than an error is.
   */
  getVolume(): Promise<Uint8Array> {
    const manifest = this.requireManifest();
    const meta = manifest.volume;
    if (!meta) {
      return Promise.reject(new Error('[spatial] this dataset has no reference volume'));
    }
    this.volumePromise ??= this.getBinary(`spatial/${encodeURIComponent(manifest.id)}/volume`)
      .then((buf) => {
        const want = meta.width * meta.height * meta.depth;
        if (buf.byteLength !== want) {
          throw new Error(
            `[spatial] volume is ${buf.byteLength} bytes, expected ${want} ` +
              `(${meta.width}x${meta.height}x${meta.depth})`,
          );
        }
        return new Uint8Array(buf);
      })
      .catch((err) => {
        this.volumePromise = null;
        throw err;
      });
    return this.volumePromise;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private requireManifest(): SpatialManifest {
    if (!this.manifest || !this.dataset$.value) {
      throw new Error('[spatial] no dataset selected — call selectDataset() first');
    }
    return this.manifest;
  }

  /**
   * Cache + single-flight around a vector fetch.
   *
   * Keys are LOGICAL — `feature:GAPDH`, not `<dataset>/feature:GAPDH` — because `clear()`
   * empties the maps on every switch, so two datasets never hold entries at once. What
   * that does not cover is a request still in the air when the switch happens: `clear()`
   * cannot cancel an HTTP call, so a vector fetched for dataset A can resolve after B has
   * been selected and write itself into B's cache under a key B would read. Both datasets
   * having a gene of that name is the common case, not the unlucky one, and the result is
   * a plot of A's expression over B's cells — which looks like data, not like a fault.
   *
   * So the generation is checked after the await, and the in-flight slot is cleared only
   * when the promise still sitting in it is this one: a late arrival must not evict the
   * entry a newer request for the same key is already sharing.
   */
  private fetchCached(key: string, load: () => Promise<CachedPayload>): Promise<CachedPayload> {
    const hit = this.cache.get(key);
    if (hit) {
      // Re-insert to mark most-recently-used (Map preserves insertion order).
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit.value);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const generation = this.selection.current();
    const promise: Promise<CachedPayload> = load()
      .then((value) => {
        // Still returned to the caller that asked: it may well be a component that is
        // itself being torn down, and rejecting here would surface a switch as an error.
        // What must not happen is the value being kept for whoever comes next.
        if (generation.isCurrent()) {
          this.uncache(key);
          const bytes = payloadBytes(value);
          this.cache.set(key, { value, bytes });
          this.cachedBytes += bytes;
          this.evict();
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Oldest first, past the entry cap or the byte budget, keeping the newest. */
  private evict(): void {
    while (
      this.cache.size > 1 &&
      (this.cache.size > SpatialDataHttpService.CACHE_LIMIT || this.cachedBytes > this.cacheBytes)
    ) {
      this.uncache(this.cache.keys().next().value!);
    }
  }

  private uncache(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cachedBytes -= entry.bytes;
  }

  private getJson<T>(path: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(`${this.baseUrl}${path}`).pipe(timeout(this.timeoutMs)));
  }

  private getBinary(path: string): Promise<ArrayBuffer> {
    return firstValueFrom(
      this.http.get(`${this.baseUrl}${path}`, { responseType: 'arraybuffer' }).pipe(timeout(this.timeoutMs)),
    );
  }
}
