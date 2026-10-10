import { PendingCalls } from './pending-calls';

describe('PendingCalls', () => {
  it('resolves a call on its reply and forwards progress', async () => {
    const calls = new PendingCalls();
    const progress: number[] = [];
    const { id, promise } = calls.open((f) => progress.push(f));
    calls.handle({ id, type: 'progress', fraction: 0.25 });
    calls.handle({ id, type: 'done', value: 7 });
    await expect(promise).resolves.toEqual({ id, type: 'done', value: 7 });
    expect(progress).toEqual([0.25]);
  });

  it('rejects a call on an error reply', async () => {
    const calls = new PendingCalls();
    const { id, promise } = calls.open();
    calls.handle({ id, type: 'error', error: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('rejectAll settles every pending call, so awaiting callers reach their finally (RT-8)', async () => {
    const calls = new PendingCalls();
    const a = calls.open().promise;
    const b = calls.open().promise;
    calls.rejectAll(new Error('SAM session disposed'));
    await expect(a).rejects.toThrow('disposed');
    await expect(b).rejects.toThrow('disposed');
    expect(calls.size).toBe(0);
  });

  it('ignores replies for unknown ids', () => {
    const calls = new PendingCalls();
    expect(() => calls.handle({ id: 99, type: 'done' })).not.toThrow();
  });
});
