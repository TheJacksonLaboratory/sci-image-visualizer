import { HeatmapTileStore, tileKey } from './heatmap-tile-store';
import type { HeatmapTileRef } from './heatmap-viewport';

const ref = (tx: number, ty = 0): HeatmapTileRef => ({ cx: 0, gy: 0, tx, ty });

/** A fetch whose answers are released by hand. */
function controlled() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const asked: string[] = [];
  const fetch = (t: HeatmapTileRef) =>
    new Promise<{ rows: number; cols: number; values: Float32Array }>((resolve, reject) => {
      asked.push(tileKey(t));
      pending.set(tileKey(t), {
        resolve: () => resolve({ rows: 1, cols: 2, values: new Float32Array([t.tx, t.ty]) }),
        reject,
      });
    });
  return { fetch, pending, asked };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('HeatmapTileStore', () => {
  it('fetches what is wanted, a few at a time, and keeps it', async () => {
    const c = controlled();
    const loaded: string[] = [];
    const store = new HeatmapTileStore(c.fetch, (t) => loaded.push(tileKey(t)), undefined, 1e6, 2);
    store.want([ref(0), ref(1), ref(2)]);
    expect(c.asked).toEqual(['0/0/0/0', '0/0/1/0']);
    expect(store.pending).toBe(3);
    c.pending.get('0/0/0/0')!.resolve();
    await flush();
    expect(loaded).toEqual(['0/0/0/0']);
    expect(c.asked).toEqual(['0/0/0/0', '0/0/1/0', '0/0/2/0']);
    expect(Array.from(store.get(ref(0))!.values)).toEqual([0, 0]);
    // Loaded: not asked for again.
    store.want([ref(0)]);
    expect(c.asked.length).toBe(3);
  });

  it('drops queued tiles the view no longer wants', async () => {
    const c = controlled();
    const store = new HeatmapTileStore(c.fetch, () => undefined, undefined, 1e6, 1);
    store.want([ref(0), ref(1), ref(2)]);
    store.want([ref(5)]);
    c.pending.get('0/0/0/0')!.resolve();
    await flush();
    expect(c.asked).toEqual(['0/0/0/0', '0/0/5/0']);
  });

  it('evicts the least recently used past its budget', async () => {
    const c = controlled();
    // Each tile is 8 bytes: room for two.
    const store = new HeatmapTileStore(c.fetch, () => undefined, undefined, 16, 3);
    store.want([ref(0), ref(1), ref(2)]);
    c.pending.get('0/0/0/0')!.resolve();
    c.pending.get('0/0/1/0')!.resolve();
    await flush();
    store.get(ref(0));
    c.pending.get('0/0/2/0')!.resolve();
    await flush();
    expect(store.get(ref(1))).toBeUndefined();
    expect(store.get(ref(0))).toBeDefined();
    expect(store.get(ref(2))).toBeDefined();
  });

  it('reports a failure once and does not ask for that tile again', async () => {
    const c = controlled();
    const errors: unknown[] = [];
    const store = new HeatmapTileStore(
      c.fetch,
      () => undefined,
      (e) => errors.push(e),
    );
    store.want([ref(0)]);
    c.pending.get('0/0/0/0')!.reject(new Error('boom'));
    await flush();
    expect(errors.length).toBe(1);
    store.want([ref(0)]);
    expect(c.asked.length).toBe(1);
  });

  it('discards answers that arrive after it is disposed', async () => {
    const c = controlled();
    const loaded: string[] = [];
    const store = new HeatmapTileStore(c.fetch, (t) => loaded.push(tileKey(t)));
    store.want([ref(0)]);
    store.dispose();
    c.pending.get('0/0/0/0')!.resolve();
    await flush();
    expect(loaded).toEqual([]);
    store.want([ref(1)]);
    expect(c.asked.length).toBe(1);
  });
});
