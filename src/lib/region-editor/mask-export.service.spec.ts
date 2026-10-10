import { Rectangle, Region } from '../models/region';
import { MaskExportEvent, MaskExportService } from './mask-export.service';

jest.mock('./mask-worker', () => ({ createMaskWorker: jest.fn() }));

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage = jest.fn();
  terminate = jest.fn();
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MaskExportService', () => {
  let service: MaskExportService;
  let worker: FakeWorker;
  const region = Object.assign(new Region(), {
    bounds: Object.assign(new Rectangle(), { x: 1, y: 1, width: 2, height: 2 }),
  });

  beforeEach(() => {
    service = new MaskExportService();
    worker = new FakeWorker();
    const factory = service as unknown as { createWorker: () => Promise<FakeWorker> };
    factory.createWorker = () => Promise.resolve(worker);
  });

  it('plans the size, posts the job, reports progress, and completes with the PNG', async () => {
    const events: MaskExportEvent[] = [];
    let completed = false;
    const request = { regions: [region], imageSize: { width: 8, height: 4 }, sourceName: 'a.tif' };
    service.export({ ...request, mode: 'multiclass' }).subscribe({
      next: (e) => events.push(e),
      complete: () => {
        completed = true;
      },
    });
    expect(events).toEqual([{ type: 'planned', width: 8, height: 4, scale: 1 }]);
    await flush();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 8,
        height: 4,
        originalWidth: 8,
        originalHeight: 4,
        scale: 1,
        mode: 'multiclass',
        sourceName: 'a.tif',
      }),
    );
    worker.emit({ type: 'progress', done: 1, total: 4 });
    worker.emit({ type: 'encoding' });
    worker.emit({ type: 'done', png: new Uint8Array([1]) });
    expect(events.slice(1, 3)).toEqual([{ type: 'progress', percent: 25 }, { type: 'encoding' }]);
    expect(events[3]).toEqual({ type: 'done', blob: expect.any(Blob) });
    expect(completed).toBe(true);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('downscales a whole-slide image to the pixel budget', () => {
    const events: MaskExportEvent[] = [];
    const sub = service
      .export({ regions: [], imageSize: { width: 100_000, height: 100_000 }, mode: 'binary' })
      .subscribe((e) => events.push(e));
    const planned = events[0] as Extract<MaskExportEvent, { type: 'planned' }>;
    expect(planned.scale).toBeLessThan(1);
    expect(planned.width * planned.height).toBeLessThanOrEqual(100_000_000);
    sub.unsubscribe();
  });

  it('unsubscribing before the worker loads terminates it unused', async () => {
    const sub = service
      .export({ regions: [region], imageSize: { width: 8, height: 8 }, mode: 'binary' })
      .subscribe();
    sub.unsubscribe();
    await flush();
    expect(worker.terminate).toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('a worker error is an error with its message; the worker is terminated', async () => {
    const errors: string[] = [];
    service
      .export({ regions: [region], imageSize: { width: 8, height: 8 }, mode: 'binary' })
      .subscribe({ error: (e: Error) => errors.push(e.message) });
    await flush();
    worker.emit({ type: 'error', error: 'boom' });
    expect(errors).toEqual(['boom']);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('a worker that fails to start is reported', async () => {
    const factory = service as unknown as { createWorker: () => Promise<never> };
    factory.createWorker = () => Promise.reject(new Error('x'));
    const errors: string[] = [];
    service
      .export({ regions: [region], imageSize: { width: 8, height: 8 }, mode: 'binary' })
      .subscribe({ error: (e: Error) => errors.push(e.message) });
    await flush();
    expect(errors).toEqual(['The mask worker failed to start.']);
  });
});
