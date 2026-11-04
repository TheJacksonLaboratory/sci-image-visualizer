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
