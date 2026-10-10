import { BehaviorSubject, Observable } from 'rxjs';

/** The part of a region the selection reads: its stable id. */
interface HasId { id: number }

/**
 * Region selection, held by region *id* (stable across edits, reorders and
 * delete/add cycles) and projected to array indices for the IRegionStore
 * boundary. Changing the ids ({@link replace}, {@link retain}) is silent; the
 * owner calls {@link sync} once the region array it projects onto is final,
 * which prunes ids that no longer exist and emits {@link indices$} only when
 * the index set changed.
 */
export class RegionSelection {
  private selected: number[] = [];
  private readonly indicesSubject = new BehaviorSubject<number[]>([]);

  /** The selected regions' current array indices (emits on change only). */
  readonly indices$: Observable<number[]> = this.indicesSubject.asObservable();

  /** The selected indices as last projected by {@link sync}. */
  get indices(): number[] { return this.indicesSubject.value; }

  /** The selected ids, in selection order. */
  get ids(): readonly number[] { return this.selected; }

  /** Replace the selected ids (no emit until {@link sync}). */
  replace(ids: number[]): void {
    this.selected = ids.slice();
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
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    this.selected = ids;
    this.sync(regions);
  }

  /** Project the selected ids onto `regions`, pruning ids it no longer holds,
   *  and emit if the index set changed. */
  sync(regions: readonly HasId[]): void {
    const indexOf = new Map<number, number>();
    regions.forEach((r, i) => { if (!indexOf.has(r.id)) indexOf.set(r.id, i); });
    const indices: number[] = [];
    const live: number[] = [];
    for (const id of this.selected) {
      const idx = indexOf.get(id);
      if (idx !== undefined) { indices.push(idx); live.push(id); }
    }
    this.selected = live;
    if (!sameIndices(this.indicesSubject.value, indices)) this.indicesSubject.next(indices);
  }
}

function sameIndices(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
