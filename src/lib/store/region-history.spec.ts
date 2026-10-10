import { RegionHistory } from './region-history';

describe('RegionHistory', () => {
  let h: RegionHistory<string>;

  beforeEach(() => {
    jest.useFakeTimers();
    h = new RegionHistory<string>(3, 250);
  });
  afterEach(() => jest.useRealTimers());

  /** Record `before` and let the coalescing window close. */
  function step(before: string): void {
    h.record(before);
    jest.advanceTimersByTime(300);
  }

  it('undoes and redoes by reference, newest first', () => {
    step('a');
    step('b');
    expect(h.undo('c')).toBe('b');
    expect(h.undo('b')).toBe('a');
    expect(h.undo('a')).toBeUndefined();
    expect(h.redo('a')).toBe('b');
    expect(h.redo('b')).toBe('c');
    expect(h.redo('c')).toBeUndefined();
  });

  it('keeps at most `limit` steps', () => {
    for (const s of ['a', 'b', 'c', 'd']) step(s);
    expect([h.undo('e'), h.undo('d'), h.undo('c'), h.undo('b')]).toEqual(['d', 'c', 'b', undefined]);
  });

  it('coalesces commits within the window into one step', () => {
    h.record('a');
    jest.advanceTimersByTime(100);
    h.record('b'); // folds into the step that holds 'a'
    jest.advanceTimersByTime(300);
    h.record('c');
    expect(h.undo('d')).toBe('c');
    expect(h.undo('c')).toBe('a');
  });

  it('a gesture is one step however long it pauses, and never merges with its neighbours', () => {
    h.record('before'); // a timed commit…
    h.beginGesture(); // …that a gesture starting inside its window does not join
    h.record('g1');
    jest.advanceTimersByTime(10_000);
    h.record('g2');
    h.endGesture();
    h.record('after');
    expect([h.undo('now'), h.undo('after'), h.undo('g1')]).toEqual(['after', 'g1', 'before']);
  });

  it('nested gestures end with the outermost', () => {
    h.beginGesture();
    h.beginGesture();
    h.record('a');
    h.endGesture();
    h.record('b');
    h.endGesture();
    h.endGesture(); // unbalanced: harmless
    expect(h.undo('c')).toBe('a');
    expect(h.canUndo()).toBe(false);
  });

  it('a new step drops the redo future', () => {
    step('a');
    h.undo('b');
    expect(h.canRedo()).toBe(true);
    step('a2');
    expect(h.canRedo()).toBe(false);
  });

  it('records nothing while restoring', () => {
    h.restore(() => h.record('ignored'));
    expect(h.canUndo()).toBe(false);
  });

  it('publishes availability and resets', () => {
    const undo: boolean[] = [];
    const redo: boolean[] = [];
    h.canUndo$.subscribe((v) => undo.push(v));
    h.canRedo$.subscribe((v) => redo.push(v));
    step('a');
    h.undo('b');
    h.reset();
    expect(undo).toEqual([false, true, false]);
    expect(redo).toEqual([false, true, false]);
  });
});
