import { BehaviorSubject, Subject } from 'rxjs';

import { SegmentationRunner } from './segmentation-runner';

describe('SegmentationRunner', () => {
  let messages: { add: jest.Mock; clear: jest.Mock };
  let runner: SegmentationRunner;
  let changed: jest.Mock;

  beforeEach(() => {
    messages = { add: jest.fn(), clear: jest.fn() };
    changed = jest.fn();
    runner = new SegmentationRunner(messages, 'sam-1', 'sam-1-result', changed);
  });

  const feeds = () => ({ status$: new Subject<string>(), progress$: new Subject<number>() });

  it('shows one sticky toast for the run, tracks progress, and reports the count to the result outlet', async () => {
    const tool = feeds();
    let finish!: (n: number) => void;
    const done = runner.run(
      'SAM',
      tool,
      () =>
        new Promise<number>((r) => {
          finish = r;
        }),
    );
    expect(messages.add).toHaveBeenCalledWith({ key: 'sam-1', sticky: true, severity: 'info', summary: 'SAM' });
    expect(runner.busy).toBe(true);
    tool.progress$.next(0.5);
    expect(runner).toMatchObject({ downloading: true, progress: 50 });
    finish(3);
    await done;
    expect(messages.add).toHaveBeenLastCalledWith({
      key: 'sam-1-result',
      severity: 'success',
      summary: 'SAM',
      detail: 'Added 3 region(s).',
    });
    expect(messages.clear).toHaveBeenCalledWith('sam-1');
    expect(runner).toMatchObject({ busy: false, downloading: false, progress: 0 });
    expect(tool.progress$.observed).toBe(false);
  });

  it("reports the tool's last status line, and a warning when nothing was added", async () => {
    const tool = feeds();
    await runner.run('Detect', tool, async () => {
      tool.status$.next('12 nuclei below threshold');
      tool.status$.next('');
      return 0;
    });
    expect(messages.add).toHaveBeenLastCalledWith({
      key: 'sam-1-result',
      severity: 'warn',
      summary: 'Detect',
      detail: '12 nuclei below threshold',
    });
  });

  it('reports a failure and still takes the toast down', async () => {
    await runner.run('Cellpose', feeds(), () => Promise.reject(new Error('no WebGPU')));
    expect(messages.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: 'sam-1-result',
        severity: 'error',
        summary: 'Cellpose failed',
      }),
    );
    expect(messages.clear).toHaveBeenCalledWith('sam-1');
  });

  it('bridges the SAM point tool: busy raises the toast once, and the feeds stop with until$', () => {
    const until$ = new Subject<void>();
    const point = {
      status$: new BehaviorSubject(''),
      busy$: new BehaviorSubject(false),
      progress$: new BehaviorSubject(-1),
    };
    runner.bindPointTool(point, until$);
    point.busy$.next(true);
    point.busy$.next(true);
    expect(messages.add).toHaveBeenCalledTimes(1);
    point.status$.next('Encoding…');
    expect(runner.status).toBe('Encoding…');
    until$.next();
    expect(point.busy$.observed || point.status$.observed || point.progress$.observed).toBe(false);
  });
});
