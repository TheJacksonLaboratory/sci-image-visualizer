import { BehaviorSubject, Observable } from 'rxjs';

/** The part of a region the selection reads: its stable id. */
interface HasId {
  id: number;
}

/**
 * Region selection, held by region *id* (stable across edits, reorders and
 * delete/add cycles) and projected to array indices for the IRegionStore
 * boundary. Changing the ids ({@link replace}, {@link retain}) is silent; the
 * owner calls {@link sync} once the region array it projects onto is final,
 * which prunes ids that no longer exist and emits {@link indices$} only when
 * the index set changed.
 *
 * A selection made by picking classes (the class tree, a surface in 3D) also
 * holds those classes: a class is a volume through the whole stack, whether or
 * not it has a region on the slice. Any other selection drops them; an edit
 * ({@link retain}, {@link sync}) keeps them.
 */
export class RegionSelection {
  private selected: number[] = [];
  private picked: readonly string[] = [];
  private readonly indicesSubject = new BehaviorSubject<number[]>([]);
  private readonly classesSubject = new BehaviorSubject<readonly string[]>([]);

  /** The selected regions' current array indices (emits on change only). */
  readonly indices$: Observable<number[]> = this.indicesSubject.asObservable();

  /** The classes the selection was picked as ([] for any other selection; emits on change only). */
  readonly classes$: Observable<readonly string[]> = this.classesSubject.asObservable();

  /** The classes the selection was picked as, as last emitted by {@link sync}. */
  get classes(): readonly string[] {
    return this.classesSubject.value;
  }

  /** The selected indices as last projected by {@link sync}. */
  get indices(): number[] {
    return this.indicesSubject.value;
  }

  /** The selected ids, in selection order. */
  get ids(): readonly number[] {
    return this.selected;
  }

  /** Replace the selected ids, picked as `classes` if they were (no emit until {@link sync}). */
  replace(ids: number[], classes: readonly string[] = []): void {
    this.selected = ids.slice();
    this.picked = classes.slice();
  }

  /** Keep only the ids `keep` accepts (no emit until {@link sync}). */
  retain(keep: (id: number) => boolean): void {
    this.selected = this.selected.filter(keep);
  }

  /**
   * Select by array index into `regions`: invalid and duplicate indices are
   * dropped, the given order is kept. Projects and emits.
   */
  selectIndices(indices: number[], regions: readonly HasId[]): void {
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const i of indices || []) {
      if (!Number.isFinite(i) || i < 0 || i >= regions.length) continue;
      const id = regions[i].id;
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    this.selected = ids;
    this.picked = [];
    this.sync(regions);
  }

  /** Project the selected ids onto `regions`, pruning ids it no longer holds,
   *  and emit if the index set (or the picked classes) changed. */
  sync(regions: readonly HasId[]): void {
    const indexOf = new Map<number, number>();
    regions.forEach((r, i) => {
      if (!indexOf.has(r.id)) indexOf.set(r.id, i);
    });
    const indices: number[] = [];
    const live: number[] = [];
    for (const id of this.selected) {
      const idx = indexOf.get(id);
      if (idx !== undefined) {
        indices.push(idx);
        live.push(id);
      }
    }
    this.selected = live;
    if (!sameIndices(this.indicesSubject.value, indices)) this.indicesSubject.next(indices);
    if (!sameIndices(this.classesSubject.value, this.picked)) this.classesSubject.next(this.picked);
  }
}

function sameIndices<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
