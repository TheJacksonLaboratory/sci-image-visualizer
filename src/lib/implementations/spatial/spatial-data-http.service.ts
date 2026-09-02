import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

import { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import {
  SpatialColumn, SpatialDataset, SpatialPolygons, findColumnMeta,
} from '../../contracts/spatial-dataset.contract';
import {
  SpatialDatasetSummary, SpatialManifest, assertManifestVersion, datasetFromManifest,
  decodeColumn, decodeCoords, decodeFeatureVector, decodePolygons, decodeRadius,
} from './spatial-wire';

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

  /**
   * Loaded vectors, keyed `column:<name>` / `feature:<name>`. Bounded LRU:
   * colouring by cluster → by a gene → back by cluster must not refetch, but an
   * afternoon of browsing genes must not grow without limit either (one vector
   * is `4·N` bytes — 2 MB at 500k cells).
   */
  private readonly cache = new Map<string, SpatialColumn | Float32Array>();
  private static readonly CACHE_LIMIT = 32;

  /** In-flight requests, so double-clicking a gene issues one fetch. */
  private readonly inFlight = new Map<string, Promise<SpatialColumn | Float32Array>>();

  private polygonsPromise: Promise<SpatialPolygons> | null = null;

  constructor(private http: HttpClient) {}

  // ── configuration ───────────────────────────────────────────────────────

  /** Point the adapter at a server. Clears any loaded dataset. */
  configure(options: { baseUrl: string; timeoutMs?: number }): void {
    const raw = options.baseUrl ?? '';
    this.baseUrl = raw.endsWith('/') ? raw : `${raw}/`;
    if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
    this.clear();
  }

  /** Datasets this server offers, for a host-side picker. */
  listDatasets(): Promise<SpatialDatasetSummary[]> {
    return this.getJson<{ datasets: SpatialDatasetSummary[] }>('spatial/datasets')
      .then((r) => r.datasets ?? []);
  }

  /**
   * Load a dataset and publish it on {@link getDataset$}. Fetches the manifest,
   * then the vectors that are always needed (coordinates, and ids/radius when
   * the manifest says they exist) — nothing else.
   */
  async selectDataset(id: string): Promise<SpatialDataset> {
    this.clear();
    const manifest = await this.getJson<SpatialManifest>(`spatial/${encodeURIComponent(id)}/manifest`);
    assertManifestVersion(manifest);
    this.manifest = manifest;

    const coordsBuf = await this.getBinary(`spatial/${encodeURIComponent(id)}/coords`);
    const coords = decodeCoords(coordsBuf, manifest.count, !!manifest.hasZ);

    const ids = manifest.hasIds
      ? (await this.getJson<{ ids: string[] }>(`spatial/${encodeURIComponent(id)}/ids`)).ids
      : undefined;
    const radius = manifest.radius?.mode === 'per-observation'
      ? decodeRadius(await this.getBinary(`spatial/${encodeURIComponent(id)}/radius`), manifest.count)
      : undefined;

    const dataset = datasetFromManifest(manifest, coords, { ids, radius });
    this.dataset$.next(dataset);
    return dataset;
  }

  /** Drop the loaded dataset and every cached vector. */
  clear(): void {
    this.manifest = null;
    this.cache.clear();
    this.inFlight.clear();
    this.polygonsPromise = null;
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
      return Promise.reject(new Error(
        `[spatial] unknown column "${name}". Available: ${dataset.columns.map((c) => c.name).join(', ')}`,
      ));
    }
    return this.fetchCached(
      `column:${name}`,
      () => this.getBinary(`spatial/${encodeURIComponent(manifest.id)}/column/${encodeURIComponent(name)}`)
        .then((buf) => decodeColumn(buf, meta, manifest.count)),
    ) as Promise<SpatialColumn>;
  }

  getFeatureVector(name: string): Promise<Float32Array> {
    const manifest = this.requireManifest();
    const names = manifest.features?.names;
    if (names && !names.includes(name)) {
      return Promise.reject(new Error(`[spatial] unknown feature "${name}"`));
    }
    return this.fetchCached(
      `feature:${name}`,
      () => this.getBinary(`spatial/${encodeURIComponent(manifest.id)}/feature/${encodeURIComponent(name)}`)
        .then((buf) => decodeFeatureVector(buf, manifest.count)),
    ) as Promise<Float32Array>;
  }

  async searchFeatures(query: string, limit = 50): Promise<string[]> {
    const manifest = this.requireManifest();
    // A dataset that inlined its names (targeted panel) is filtered locally —
    // no round-trip for a keystroke.
    const names = manifest.features?.names;
    if (names) {
      const q = query.toLowerCase();
      return names.filter((n) => n.toLowerCase().includes(q)).slice(0, limit);
    }
    const url = `spatial/${encodeURIComponent(manifest.id)}/features`
      + `?q=${encodeURIComponent(query)}&limit=${limit}`;
    return (await this.getJson<{ names: string[] }>(url)).names ?? [];
  }

  getPolygons(): Promise<SpatialPolygons> {
    const manifest = this.requireManifest();
    if (!manifest.polygons) {
      return Promise.reject(new Error('[spatial] this dataset has no polygon geometry'));
    }
    // Geometry is one large blob rather than a per-name vector, so it gets its
    // own single-flight slot instead of a cache entry.
    this.polygonsPromise ??= this
      .getBinary(`spatial/${encodeURIComponent(manifest.id)}/polygons`)
      .then(decodePolygons)
      .catch((err) => { this.polygonsPromise = null; throw err; });
    return this.polygonsPromise;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private requireManifest(): SpatialManifest {
    if (!this.manifest || !this.dataset$.value) {
      throw new Error('[spatial] no dataset selected — call selectDataset() first');
    }
    return this.manifest;
  }

  /** Cache + single-flight around a vector fetch. */
  private fetchCached(
    key: string, load: () => Promise<SpatialColumn | Float32Array>,
  ): Promise<SpatialColumn | Float32Array> {
    const hit = this.cache.get(key);
    if (hit) {
      // Re-insert to mark most-recently-used (Map preserves insertion order).
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.cache.set(key, value);
        this.evict();
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private evict(): void {
    while (this.cache.size > SpatialDataHttpService.CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private getJson<T>(path: string): Promise<T> {
    return firstValueFrom(
      this.http.get<T>(`${this.baseUrl}${path}`).pipe(timeout(this.timeoutMs)),
    );
  }

  private getBinary(path: string): Promise<ArrayBuffer> {
    return firstValueFrom(
      this.http.get(`${this.baseUrl}${path}`, { responseType: 'arraybuffer' })
        .pipe(timeout(this.timeoutMs)),
    );
  }
}
