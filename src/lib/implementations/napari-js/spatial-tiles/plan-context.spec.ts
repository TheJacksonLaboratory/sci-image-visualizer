import { LoadTracker, PlanContext } from './plan-context';

describe('LoadTracker', () => {
  it('reports a label while any load of it is in flight', async () => {
    const reports: string[][] = [];
    const loads = new LoadTracker((l) => reports.push(l));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = loads.track('Cells', gate);
    const second = loads.track('Cells', Promise.resolve());
    await second;
    expect(reports.at(-1)).toEqual(['Cells']); // the first is still loading
    release();
    await first;
    expect(reports.at(-1)).toEqual([]);
  });

  it('reports nothing after a clear', () => {
    const changed = jest.fn();
    const loads = new LoadTracker(changed);
    void loads.track('Transcripts', new Promise(() => undefined));
    loads.clear();
    expect(changed).toHaveBeenLastCalledWith([]);
  });
});

describe('PlanContext', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('keeps what arrived and marks only its own run incomplete when a tile fails', async () => {
    const loads = new LoadTracker(() => undefined);
    const mine = new PlanContext(() => false, loads);
    const other = new PlanContext(() => false, loads);
    const got = await mine.fetchAll([1, 2, 3], (k) =>
      k === 2 ? Promise.reject(new Error('503')) : Promise.resolve(k),
    );
    expect(got).toEqual([1, 3]);
    expect(mine.incomplete).toBe(true);
    expect(other.incomplete).toBe(false);
  });

  it('is complete when every tile arrives, and asks its staleness of the caller', async () => {
    let stale = false;
    const ctx = new PlanContext(() => stale, new LoadTracker(() => undefined));
    await ctx.fetchAll([1], (k) => Promise.resolve(k));
    expect(ctx.incomplete).toBe(false);
    expect(ctx.stale()).toBe(false);
    stale = true;
    expect(ctx.stale()).toBe(true);
  });
});
