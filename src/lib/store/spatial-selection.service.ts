import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

import {
  SpatialSelectionMask, emptySelection,
} from '../implementations/spatial/spatial-selection';

/**
 * The set of currently-selected spatial observations, shared the way
 * `RegionStore` shares regions: one store, many writers (an ROI selection, a
 * legend click, a future chart brush), one reader per consumer.
 *
 * Deliberately thin — every rule about WHICH observations are selected lives in
 * the pure `spatial-selection.ts`; this only holds the answer and announces it.
 */
@Injectable({ providedIn: 'root' })
export class SpatialSelectionStore {
  private readonly selection$ = new BehaviorSubject<SpatialSelectionMask>(emptySelection());

  /** Emits on every change, including a clear. */
  getSelection$(): Observable<SpatialSelectionMask> {
    return this.selection$.asObservable();
  }

  /** Synchronous read, for a renderer building its first frame. */
  current(): SpatialSelectionMask {
    return this.selection$.value;
  }

  /** True when nothing is selected — the state in which nothing is muted. */
  isEmpty(): boolean {
    return this.selection$.value.count === 0;
  }

  /** Replace the selection. An empty result is published like any other, so a
   *  "selected nothing" ROI visibly clears rather than silently keeping the
   *  previous selection on screen. */
  set(selection: SpatialSelectionMask): void {
    this.selection$.next(selection);
  }

  clear(): void {
    if (this.selection$.value.count === 0 && this.selection$.value.mask.length === 0) return;
    this.selection$.next(emptySelection());
  }
}
