import type { HeatmapTileRef } from './heatmap-viewport';

/** A loaded tile: its place, its size in level pixels and its values (row-major). */
export interface HeatmapTile extends HeatmapTileRef {
  rows: number;
  cols: number;
  values: Float32Array;
}

/** Fetches one tile. */
export type HeatmapTileFetch = (
  t: HeatmapTileRef,
) => Promise<{ rows: number; cols: number; values: Float32Array }>;

export function tileKey(t: HeatmapTileRef): string {
  return `${t.cx}/${t.gy}/${t.tx}/${t.ty}`;
}

/**
 * The gene heatmap's tiles for one column and scale: fetched as the view asks for them, a few
 * at a time, and kept most recently used first within a byte budget.
 *
 * {@link want} replaces what is wanted: a tile still queued that the view no longer shows is
 * dropped before it is fetched, so panning across a large matrix does not leave a backlog of
 * requests for places already passed. Tiles in flight finish and are kept.
 */
export class HeatmapTileStore {
  private readonly tiles = new Map<string, HeatmapTile>();
  private bytes = 0;
  private queue: HeatmapTileRef[] = [];
  private readonly inFlight = new Set<string>();
  private readonly failed = new Set<string>();
  private disposed = false;

  constructor(
    private readonly fetch: HeatmapTileFetch,
    private readonly onLoad: (t: HeatmapTile) => void,
    private readonly onError: (err: unknown) => void = () => undefined,
    private readonly maxBytes = 96 * 1024 * 1024,
    private readonly concurrency = 6,
  ) {}

  /** A loaded tile, marked recently used. */
  get(t: HeatmapTileRef): HeatmapTile | undefined {
    const key = tileKey(t);
    const hit = this.tiles.get(key);
    if (hit) {
      this.tiles.delete(key);
      this.tiles.set(key, hit);
    }
    return hit;
  }

  /** Every loaded tile, least recently used first. */
  loaded(): IterableIterator<HeatmapTile> {
    return this.tiles.values();
  }

  /** Tiles wanted now, most wanted first; what is queued and not among them is dropped. */
  want(refs: readonly HeatmapTileRef[]): void {
    if (this.disposed) return;
    this.queue = refs.filter((t) => {
      const key = tileKey(t);
      return !this.tiles.has(key) && !this.inFlight.has(key) && !this.failed.has(key);
    });
    this.pump();
  }

  /** Requests in flight or queued. */
  get pending(): number {
    return this.inFlight.size + this.queue.length;
  }

  /** Stop fetching; results still arriving are discarded. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.tiles.clear();
    this.bytes = 0;
  }

  private pump(): void {
    while (!this.disposed && this.inFlight.size < this.concurrency && this.queue.length) {
      const t = this.queue.shift()!;
      const key = tileKey(t);
      this.inFlight.add(key);
      this.fetch(t)
        .then(({ rows, cols, values }) => {
          if (this.disposed) return;
          const tile: HeatmapTile = { ...t, rows, cols, values };
          this.tiles.set(key, tile);
          this.bytes += values.byteLength;
          this.evict();
          this.onLoad(tile);
        })
        .catch((err) => {
          if (this.disposed) return;
          // Not asked for again while this store lasts: a tile that failed once would
          // otherwise be refetched on every redraw.
          this.failed.add(key);
          this.onError(err);
        })
        .finally(() => {
          this.inFlight.delete(key);
          this.pump();
        });
    }
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.tiles.size > 1) {
      const [key, oldest] = this.tiles.entries().next().value as [string, HeatmapTile];
      this.tiles.delete(key);
      this.bytes -= oldest.values.byteLength;
    }
  }
}
