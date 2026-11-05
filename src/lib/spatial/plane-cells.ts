import type {
  SpatialImageRef,
  SpatialObservations,
  SpatialPolygonTile,
} from '../contracts/spatial-dataset.contract';
import type { TileFeature } from '../region-source/region-tiles';

/**
 * A 3D segmentation's cells on one plane as the 2D view's cell layer draws them: the outlines of a
 * boundary set's region set (`SpatialPolygonTilesMeta.sets[i].regionSource`, every cell outlined on
 * every plane it spans), read from the region source's tiles of that plane, as rings owned by their
 * observations, so the Cells panel's colouring, groups and selection apply to them as to any ring.
 *
 * A feature is a cell by its id: the cell's id among the observations' (`SpatialObservations.ids`),
 * qualified by its slice (`<slice>:<id>`) as a folder region set serves it. Pure, like
 * `spatial-tile-merge.ts`.
 */

/** Memoized per observations object: their ids to their indices. */
const indices = new WeakMap<SpatialObservations, Map<string, number> | null>();

/** Each observation's index by its id, or null when the observations carry no ids. */
export function observationIndex(obs: SpatialObservations): Map<string, number> | null {
  const hit = indices.get(obs);
  if (hit !== undefined) return hit;
  const ids = obs.ids;
  const out = ids ? new Map(ids.map((id, i) => [id, i] as [string, number])) : null;
  indices.set(obs, out);
  return out;
}

/** A feature's cell id: its id without the slice a folder region set qualifies it with. */
export function cellIdOf(featureId: string): string {
  const at = featureId.indexOf(':');
  return at < 0 ? featureId : featureId.slice(at + 1);
}

/**
 * The rings of `tiles`' features (each once, though a feature is in every tile it meets), owned by
 * their cells, in observation units (the region set's are the image's pixels: back through `ref`).
 * A feature of no observation, and an open one (a polyline), is left out; each ring of a feature
 * (its parts and holes) is a ring of its cell.
 */
export function planeCellRings(
  tiles: readonly { features: readonly TileFeature[] }[],
  index: ReadonlyMap<string, number>,
  ref: SpatialImageRef | null | undefined,
): SpatialPolygonTile {
  const [sx, sy] = ref?.scale ?? [1, 1];
  const [tx, ty] = ref?.translate ?? [0, 0];
  const seen = new Set<string>();
  const rings: Float32Array[] = [];
  const owners: number[] = [];
  let vertices = 0;
  for (const tile of tiles) {
    for (const f of tile.features) {
      if (f.open || seen.has(f.id)) continue;
      seen.add(f.id);
      const o = index.get(cellIdOf(f.id));
      if (o === undefined) continue;
      for (const ring of f.rings) {
        if (ring.length < 6) continue;
        rings.push(ring);
        owners.push(o);
        vertices += ring.length / 2;
      }
    }
  }
  const coords = new Float32Array(vertices * 2);
  const offsets = new Uint32Array(rings.length + 1);
  let v = 0;
  rings.forEach((ring, r) => {
    offsets[r] = v;
    for (let i = 0; i < ring.length; i += 2) {
      coords[v * 2] = (ring[i] - tx) / sx;
      coords[v * 2 + 1] = (ring[i + 1] - ty) / sy;
      v++;
    }
  });
  offsets[rings.length] = v;
  return { count: rings.length, coords, offsets, observation: Uint32Array.from(owners) };
}

/** One plane's tiles of a region set: the plane's slice index (its place among the set's planes). */
export interface PlaneTiles {
  slice: number;
  tiles: readonly { features: readonly TileFeature[] }[];
}

/**
 * Each cell's outlines on every plane it spans, from the planes' tiles (a feature once, though in
 * every tile it meets), for the 3D reconstruction of each cell by itself (`CellOutlines`, slice k
 * at z = k). Only cells of `classes` (all when null), whose outlines' centre over all planes is in
 * `within` (`[x0, y0, x1, y1]`, image px; anywhere when absent): the tiles fetched for an area hold
 * the cells crossing its edge too, which belong to the area their centre is in.
 */
export function cellOutlinesFromTiles(
  planes: readonly PlaneTiles[],
  index: ReadonlyMap<string, number>,
  classes: ReadonlySet<string> | null,
  within?: readonly [number, number, number, number],
): { cell: number; label: string | null; slices: { z: number; rings: Float32Array[] }[] }[] {
  const byCell = new Map<
    number,
    { label: string | null; slices: { z: number; rings: Float32Array[] }[]; box: [number, number, number, number] }
  >();
  for (const plane of planes) {
    const seen = new Set<string>();
    for (const tile of plane.tiles) {
      for (const f of tile.features) {
        if (f.open || seen.has(f.id) || !f.rings.length) continue;
        seen.add(f.id);
        if (classes && !classes.has(f.label ?? '')) continue;
        const cell = index.get(cellIdOf(f.id));
        if (cell === undefined) continue;
        let entry = byCell.get(cell);
        if (!entry) {
          entry = { label: f.label, slices: [], box: [Infinity, Infinity, -Infinity, -Infinity] };
          byCell.set(cell, entry);
        }
        entry.slices.push({ z: plane.slice, rings: f.rings });
        const b = entry.box;
        b[0] = Math.min(b[0], f.bbox[0]);
        b[1] = Math.min(b[1], f.bbox[1]);
        b[2] = Math.max(b[2], f.bbox[2]);
        b[3] = Math.max(b[3], f.bbox[3]);
      }
    }
  }
  const out: { cell: number; label: string | null; slices: { z: number; rings: Float32Array[] }[] }[] = [];
  for (const [cell, e] of byCell) {
    if (within) {
      const cx = (e.box[0] + e.box[2]) / 2;
      const cy = (e.box[1] + e.box[3]) / 2;
      if (cx < within[0] || cx >= within[2] || cy < within[1] || cy >= within[3]) continue;
    }
    out.push({ cell, label: e.label, slices: e.slices });
  }
  return out;
}
