import { Supersede } from './supersede';
import { Supersede as LegacySupersede } from '../spatial/supersede';

describe('Supersede', () => {
  it('keeps a task current until a newer one starts', () => {
    const load = new Supersede();
    const first = load.next();
    expect(first.isCurrent()).toBe(true);
    const second = load.next();
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('is callable as the bare check the first version returned', () => {
    const load = new Supersede();
    const first = load.next();
    expect(first()).toBe(true);
    load.next();
    expect(first()).toBe(false);
  });

  it('aborts the signal of a task the moment a newer one starts', () => {
    const load = new Supersede();
    const first = load.next();
    let currentWhenAborted: boolean | undefined;
    first.signal.addEventListener('abort', () => {
      currentWhenAborted = first.isCurrent();
    });
    expect(first.signal.aborted).toBe(false);
    const second = load.next();
    expect(first.signal.aborted).toBe(true);
    // A listener reacting to the abort already sees the task as stale.
    expect(currentWhenAborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it('makes every task stale and aborts it on cancel, without starting one', () => {
    const load = new Supersede();
    const task = load.next();
    load.cancel();
    expect(task.isCurrent()).toBe(false);
    expect(task.signal.aborted).toBe(true);
    expect(load.next().isCurrent()).toBe(true);
  });

  it('keeps invalidate() as an alias of cancel()', () => {
    const load = new Supersede();
    const task = load.next();
    load.invalidate();
    expect(task.isCurrent()).toBe(false);
    expect(task.signal.aborted).toBe(true);
  });

  it('snapshots the current generation without superseding it', () => {
    const load = new Supersede();
    const started = load.next();
    const snapshot = load.current();
    expect(started.isCurrent()).toBe(true);
    expect(snapshot.isCurrent()).toBe(true);
    expect(snapshot.signal).toBe(started.signal);
    load.next();
    expect(snapshot.isCurrent()).toBe(false);
    expect(snapshot.signal.aborted).toBe(true);
  });

  it('gives a snapshot taken before any task a live generation of its own', () => {
    const load = new Supersede();
    const snapshot = load.current();
    expect(snapshot.isCurrent()).toBe(true);
    load.cancel();
    expect(snapshot.isCurrent()).toBe(false);
  });

  it('keeps separate instances independent', () => {
    const a = new Supersede();
    const b = new Supersede();
    const task = a.next();
    b.next();
    b.cancel();
    expect(task.isCurrent()).toBe(true);
    expect(task.signal.aborted).toBe(false);
  });

  it('is still importable from its old path', () => {
    expect(LegacySupersede).toBe(Supersede);
  });
});
