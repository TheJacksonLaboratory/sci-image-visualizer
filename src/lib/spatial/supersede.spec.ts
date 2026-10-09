import { Supersede } from './supersede';

describe('Supersede', () => {
  it('keeps a task current until a newer one starts', () => {
    const load = new Supersede();
    const first = load.next();
    expect(first()).toBe(true);
    const second = load.next();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('makes every task stale on invalidate, without starting one', () => {
    const load = new Supersede();
    const task = load.next();
    load.invalidate();
    expect(task()).toBe(false);
    expect(load.next()()).toBe(true);
  });

  it('keeps separate instances independent', () => {
    const a = new Supersede();
    const b = new Supersede();
    const task = a.next();
    b.next();
    b.invalidate();
    expect(task()).toBe(true);
  });
});
