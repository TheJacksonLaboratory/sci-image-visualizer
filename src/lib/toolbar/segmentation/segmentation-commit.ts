import { Region } from '../../models/region';

/**
 * `regions` minus `remove`, matched by id (identity for a region without one).
 * Async tools use it to drop their consumed prompts from the *current* region
 * list at commit time, instead of overwriting the list they read before a long
 * download or inference (RT-6).
 */
export function withoutRegions(regions: Region[], remove: Region[]): Region[] {
  const ids = new Set(remove.map((r) => r.id).filter((id) => id != null));
  const objs = new Set(remove);
  return regions.filter((r) => !objs.has(r) && !(r.id != null && ids.has(r.id)));
}
