import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { SpatialSelectionStore } from './spatial-selection.service';
import { emptySelection } from '../implementations/spatial/spatial-selection';

describe('SpatialSelectionStore', () => {
  let store: SpatialSelectionStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [SpatialSelectionStore] });
    store = TestBed.inject(SpatialSelectionStore);
  });

  it('starts empty', async () => {
    expect(store.isEmpty()).toBe(true);
    expect((await firstValueFrom(store.getSelection$())).count).toBe(0);
  });

  it('publishes a new selection', async () => {
    const seen: number[] = [];
    store.getSelection$().subscribe((s) => seen.push(s.count));
    store.set({ mask: new Uint8Array([1, 0, 1]), count: 2 });
    expect(store.current().count).toBe(2);
    expect(store.isEmpty()).toBe(false);
    expect(seen).toEqual([0, 2]);
  });

  it('publishes an EMPTY result too, so a miss visibly clears the previous one', () => {
    store.set({ mask: new Uint8Array([1, 0]), count: 1 });
    const seen: number[] = [];
    store.getSelection$().subscribe((s) => seen.push(s.count));
    store.set(emptySelection(2));
    expect(seen).toEqual([1, 0]);
    expect(store.isEmpty()).toBe(true);
  });

  it('clear resets to empty', () => {
    store.set({ mask: new Uint8Array([1]), count: 1 });
    store.clear();
    expect(store.isEmpty()).toBe(true);
    expect(store.current().mask).toHaveLength(0);
  });

  it('clear on an already-empty store does not churn subscribers', () => {
    const seen: number[] = [];
    store.getSelection$().subscribe((s) => seen.push(s.count));
    store.clear();
    store.clear();
    expect(seen).toEqual([0]); // only the initial emission
  });
});
