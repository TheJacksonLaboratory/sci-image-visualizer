/**
 * The region-source worker's protocol and the tables it holds, shared by the worker and the
 * main-thread fallback (which runs the very same {@link RegionSourceTables} where no worker can
 * start).
 *
 * Protocol: `{ id, op, ...args }` → `{ id, ok: true, result }` | `{ id, ok: false, error }`.
 */
import { ReconstructOptions, SliceOutlines, reconstruct } from '../geometry/reconstruct';
import type { Mesh } from 'napari-js/geometry';
import {
  ClassOutlines,
  RegionFeatureTable,
  RegionIndexPage,
  RegionIndexQuery,
  RegionSourceInfo,
  RegionTile,
} from './region-tiles';
import type { SourceFeature } from './region-source';

export type RegionSourceRequest =
  | { op: 'open'; text: string; tileSize?: number }
  | { op: 'tile'; handle: number; z: number; level: number; gx: number; gy: number }
  | { op: 'features'; handle: number; ids: readonly string[] }
  | { op: 'index'; handle: number; z: number; query: RegionIndexQuery }
  | { op: 'classes'; handle: number; z: number | null; exclude?: readonly string[] }
  | {
      op: 'outlines';
      handle: number;
      classes: readonly string[] | null;
      level: number;
      exclude?: readonly string[];
    }
  | { op: 'mesh'; slices: readonly SliceOutlines[]; options?: ReconstructOptions }
  | { op: 'export'; handle: number; exclude: readonly string[]; extra: readonly object[] }
  | { op: 'close'; handle: number };

export interface RegionSourceResults {
  open: { handle: number; info: RegionSourceInfo };
  tile: RegionTile;
  features: SourceFeature[];
  index: RegionIndexPage;
  classes: Record<string, number>;
  outlines: ClassOutlines[];
  mesh: Mesh;
  export: string;
  close: null;
}

export type RegionSourceMessage = RegionSourceRequest & { id: number };

export type RegionSourceReply =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** The open tables, by handle. */
export class RegionSourceTables {
  private readonly tables = new Map<number, RegionFeatureTable>();
  private nextHandle = 1;

  run<R extends RegionSourceRequest>(request: R): RegionSourceResults[R['op']] {
    return this.dispatch(request) as RegionSourceResults[R['op']];
  }

  private dispatch(r: RegionSourceRequest): RegionSourceResults[keyof RegionSourceResults] {
    switch (r.op) {
      case 'open': {
        const table = RegionFeatureTable.fromGeoJson(r.text, r.tileSize);
        const handle = this.nextHandle++;
        this.tables.set(handle, table);
        return { handle, info: table.info() };
      }
      case 'tile':
        return this.table(r.handle).tile(r.z, r.level, r.gx, r.gy);
      case 'features':
        return this.table(r.handle).features(r.ids);
      case 'index':
        return this.table(r.handle).index(r.z, r.query);
      case 'classes':
        return this.table(r.handle).classCounts(r.z, r.exclude);
      case 'outlines':
        return this.table(r.handle).classOutlines(r.classes, r.level, r.exclude);
      case 'mesh':
        return reconstruct(r.slices, r.options);
      case 'export':
        return this.table(r.handle).exportGeoJson(r.exclude, r.extra);
      case 'close':
        this.tables.delete(r.handle);
        return null;
    }
  }

  private table(handle: number): RegionFeatureTable {
    const table = this.tables.get(handle);
    if (!table) throw new Error(`No open region source ${handle}.`);
    return table;
  }
}
