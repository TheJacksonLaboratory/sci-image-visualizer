/**
 * A tiled region source: one image's large region set, served as level-of-detail tiles so a view
 * never holds or draws the whole set (see `region-tiles` for the levels and tiles).
 *
 * Two implementations behind {@link RegionSource}: a GeoJSON source parsed and tiled in a Web
 * Worker (`openGeoJsonRegionSource`, the main thread only ever sees tiles), and an HTTP source
 * for a server that serves the same tiles (`openHttpRegionSource`).
 */
import type {
  GeoJsonFeatureLike,
  RegionIndexPage,
  RegionIndexQuery,
  RegionSourceInfo,
  RegionTile,
  RegionTileKey,
  TileFeature,
} from './region-tiles';
import type { RegionStyle } from '../region-overlay/region-style';

/** A feature's exact GeoJSON with the source's id for it. */
export interface SourceFeature {
  id: string;
  feature: GeoJsonFeatureLike;
}

/** One image's tiled region set. */
export interface RegionSource {
  /** What the source holds; known once it is open. */
  readonly info: RegionSourceInfo;
  /** One tile of plane `z`. Cached: asking again for a tile in view costs nothing. */
  getTile(z: number, key: RegionTileKey, signal?: AbortSignal): Promise<RegionTile>;
  /** The exact features with these ids (unknown ids are skipped). */
  getFeatures(ids: readonly string[]): Promise<SourceFeature[]>;
  /** A page of plane `z`'s feature index. */
  getIndex(z: number, query: RegionIndexQuery): Promise<RegionIndexPage>;
  /** How many features of each class plane `z` has, without the `exclude`d ids. */
  getClassCounts(z: number, exclude?: readonly string[]): Promise<Record<string, number>>;
  /**
   * The whole set as a GeoJSON FeatureCollection string, through the working set: `exclude`d
   * features (taken for editing, or deleted) left out, `extra` features appended.
   */
  exportGeoJson(exclude: readonly string[], extra: readonly object[]): Promise<string>;
  /** Release the source (its worker table, its cache). */
  dispose(): void;
}

/** What the store shows of the current slice's region source: what a source layer draws. */
export interface RegionSourceView {
  source: RegionSource;
  /** The source plane the slice shows. */
  plane: number;
  /** Ids the source no longer draws: taken into the working set, or deleted. */
  taken: ReadonlySet<string>;
  /** The colour a feature is drawn in (its class colour, as a region of that class gets). */
  colorOf(feature: Pick<TileFeature, 'label' | 'color'>): string;
  /** The region look, the regions' own (so a feature looks the same once taken). */
  style: RegionStyle;
  /** Whether class labels are shown. */
  labels: boolean;
}

/**
 * ROI GeoJSON at least this many characters long loads as a tiled region source rather than as
 * regions (see `VizConfig.regionSourceMinChars`).
 */
export const REGION_SOURCE_MIN_CHARS = 1_000_000;

/** Tiles a source keeps, most recently used last. */
export const REGION_TILE_CACHE_SIZE = 384;

/** A least-recently-used cache of tile requests. A request that fails is forgotten. */
export class RegionTileCache {
  private readonly tiles = new Map<string, Promise<RegionTile>>();

  constructor(private readonly limit = REGION_TILE_CACHE_SIZE) {}

  /** The cached tile, else `load()`'s, cached. */
  get(z: number, key: RegionTileKey, load: () => Promise<RegionTile>): Promise<RegionTile> {
    const id = `${z}/${key.level}/${key.gx}/${key.gy}`;
    const hit = this.tiles.get(id);
    if (hit) {
      this.tiles.delete(id);
      this.tiles.set(id, hit);
      return hit;
    }
    const tile = load();
    this.tiles.set(id, tile);
    tile.catch(() => {
      if (this.tiles.get(id) === tile) this.tiles.delete(id);
    });
    while (this.tiles.size > this.limit) this.tiles.delete(this.tiles.keys().next().value as string);
    return tile;
  }

  clear(): void {
    this.tiles.clear();
  }
}

/** An `AbortError`, as `fetch` and the workers reject with. */
export function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('The request was aborted.', 'AbortError');
  const err = new Error('The request was aborted.');
  err.name = 'AbortError';
  return err;
}

/** True for the rejection of an aborted request. */
export function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/** `promise`, rejected with an `AbortError` as soon as `signal` fires (the work goes on). */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
