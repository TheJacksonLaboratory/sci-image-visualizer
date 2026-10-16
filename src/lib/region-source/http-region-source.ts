/**
 * A {@link RegionSource} served over HTTP, by a server that tiles a region set as `region-tiles`
 * does (the example tile server's `/regions/…` routes). Relative to the source's base URL:
 *
 *  - `GET  info`                       → {@link RegionSourceInfo}
 *  - `GET  tile/{z}/{level}/{gx}/{gy}` → `{ features: WireTileFeature[] }`
 *  - `POST features` `{ ids }`         → `{ features: SourceFeature[] }`
 *  - `POST index` `{ z, ...query }`    → {@link RegionIndexPage}
 *  - `POST classes` `{ z, exclude }`    → features per class on plane z
 *  - `POST outlines` `{ classes, level, exclude }` → `{ slices: [{ z, rings }] }`
 *  - `POST export` `{ exclude, extra }`→ a GeoJSON FeatureCollection
 *
 * Tile rings travel as flat `[x, y, x, y, …]` arrays, label points as flat `[x, y, room, …]`.
 *
 * Given the host's Angular `HttpClient` (as the visualizer passes it), every request goes through
 * it, so the host's interceptors apply — its auth header above all — as for the image tiles and
 * the spatial data. The library itself knows nothing of authentication.
 */
import type { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { RegionSource, RegionTileCache, SourceFeature, abortable } from './region-source';
import type {
  Bbox,
  ClassOutlines,
  RegionIndexPage,
  RegionIndexQuery,
  RegionSourceInfo,
  RegionTile,
  RegionTileKey,
  TileFeature,
} from './region-tiles';

/** A tile feature on the wire: rings as plain arrays. */
export interface WireTileFeature {
  id: string;
  label: string | null;
  color: string | null;
  bbox: Bbox;
  rings: number[][];
  open?: boolean;
  labels?: number[];
}

/** Options of {@link openHttpRegionSource}. */
export interface HttpRegionSourceOptions {
  /**
   * The host's `HttpClient`: requests then go through it and its interceptors (the host's auth),
   * not `fetch`, and `init` and `fetch` are not used.
   */
  http?: HttpClient;
  /** Extra request options (credentials, headers) for every `fetch` request. */
  init?: RequestInit;
  /** The fetch to use (default the global one). */
  fetch?: typeof fetch;
}

/** Open the region source at `baseUrl` (its `info` is fetched first). */
export async function openHttpRegionSource(
  baseUrl: string,
  options: HttpRegionSourceOptions = {},
): Promise<RegionSource> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const http = new Http(base, options);
  const info = await http.json<RegionSourceInfo>('info');
  return new HttpRegionSource(http, info);
}

class Http {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly base: string,
    private readonly options: HttpRegionSourceOptions,
  ) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async json<T>(path: string, body?: unknown): Promise<T> {
    return JSON.parse(await this.text(path, body)) as T;
  }

  async text(path: string, body?: unknown): Promise<string> {
    const http = this.options.http;
    if (http) {
      const url = this.base + path;
      try {
        return await firstValueFrom(
          body === undefined
            ? http.get(url, { responseType: 'text' })
            : http.post(url, body, { responseType: 'text' }),
        );
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        throw new Error(`Region source ${path}: HTTP ${status ?? 'error'}`);
      }
    }
    const init: RequestInit = { ...this.options.init };
    if (body !== undefined) {
      init.method = 'POST';
      init.body = JSON.stringify(body);
      init.headers = {
        ...(this.options.init?.headers as Record<string, string>),
        'Content-Type': 'application/json',
      };
    }
    const res = await this.fetchFn(this.base + path, init);
    if (!res.ok) throw new Error(`Region source ${path}: HTTP ${res.status}`);
    return res.text();
  }
}

class HttpRegionSource implements RegionSource {
  private readonly cache = new RegionTileCache();

  constructor(
    private readonly http: Http,
    readonly info: RegionSourceInfo,
  ) {}

  getTile(z: number, key: RegionTileKey, signal?: AbortSignal): Promise<RegionTile> {
    // The fetch itself is not aborted: another view (the other backend) may be waiting on the
    // same cached tile, and a tile is small. Only this caller stops waiting.
    const tile = this.cache.get(z, key, async () => {
      const wire = await this.http.json<{ features: WireTileFeature[] }>(
        `tile/${z}/${key.level}/${key.gx}/${key.gy}`,
      );
      return { z, ...key, features: wire.features.map(fromWire) };
    });
    return abortable(tile, signal);
  }

  async getFeatures(ids: readonly string[]): Promise<SourceFeature[]> {
    if (!ids.length) return [];
    return (await this.http.json<{ features: SourceFeature[] }>('features', { ids })).features;
  }

  getIndex(z: number, query: RegionIndexQuery): Promise<RegionIndexPage> {
    return this.http.json<RegionIndexPage>('index', { z, ...query });
  }

  async getClassOutlines(
    classes: readonly string[] | null,
    level: number,
    exclude: readonly string[] = [],
  ): Promise<ClassOutlines[]> {
    const wire = await this.http.json<{
      slices: Array<{
        z: number;
        rings: number[][];
        lines?: number[][];
        ringGroups?: number[];
        ringLabels?: string[];
        lineLabels?: string[];
      }>;
    }>('outlines', { classes, level, exclude });
    return wire.slices.map((s) => ({
      z: s.z,
      rings: s.rings.map((r) => Float32Array.from(r)),
      ...(s.lines?.length ? { lines: s.lines.map((l) => Float32Array.from(l)) } : {}),
      ...(s.ringGroups ? { ringGroups: s.ringGroups } : {}),
      ...(s.ringLabels ? { ringLabels: s.ringLabels } : {}),
      ...(s.lineLabels ? { lineLabels: s.lineLabels } : {}),
    }));
  }

  getClassCounts(z: number | null, exclude: readonly string[] = []): Promise<Record<string, number>> {
    // Every plane is `all` (a plane must be a number: a server that predates it answers 400).
    return this.http.json<Record<string, number>>('classes', z === null ? { all: true, exclude } : { z, exclude });
  }

  exportGeoJson(exclude: readonly string[], extra: readonly object[]): Promise<string> {
    return this.http.text('export', { exclude, extra });
  }

  dispose(): void {
    this.cache.clear();
  }
}

function fromWire(f: WireTileFeature): TileFeature {
  return {
    id: f.id,
    label: f.label ?? null,
    color: f.color ?? null,
    bbox: f.bbox,
    rings: f.rings.map((r) => Float32Array.from(r)),
    open: !!f.open,
    ...(f.labels?.length ? { labels: Float32Array.from(f.labels) } : {}),
  };
}
