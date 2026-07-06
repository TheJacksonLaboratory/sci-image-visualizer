import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { SimpleSliceAccessService } from './simple-slice-access.service';
import { IImageInfo } from '../contracts/image.contract';

describe('SimpleSliceAccessService', () => {
  let service: SimpleSliceAccessService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(SimpleSliceAccessService);
    http = TestBed.inject(HttpTestingController);
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = jest
      .fn()
      .mockResolvedValue({ width: 1, height: 1, close: () => undefined });
  });

  afterEach(() => http.verify());

  describe('isSimple / urlFor', () => {
    it('isSimple is true only when tiled === false', () => {
      expect(service.isSimple({ tiled: false } as IImageInfo)).toBe(true);
      expect(service.isSimple({ tiled: true } as IImageInfo)).toBe(false);
      expect(service.isSimple({} as IImageInfo)).toBe(false);
      expect(service.isSimple(null)).toBe(false);
      expect(service.isSimple(undefined)).toBe(false);
    });

    it('urlFor resolves the slice at z, falling back to urls[0] when out of range', () => {
      const info = { urls: ['a', 'b', 'c'] } as IImageInfo;
      expect(service.urlFor(info, 1)).toBe('b');
      expect(service.urlFor(info, 99)).toBe('a'); // out of range -> urls[0]
      expect(service.urlFor({ urls: [] } as unknown as IImageInfo, 0)).toBeUndefined();
    });
  });

  describe('fetchAsBlobUrl', () => {
    it('fetches a real server URL through HttpClient and returns a blob: URL', async () => {
      const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
      const promise = service.fetchAsBlobUrl('/api/preview?info=abc');

      const req = http.expectOne('/api/preview?info=abc');
      expect(req.request.method).toBe('GET');
      const blob = new Blob(['x']);
      req.flush(blob);

      expect(await promise).toBe('blob:mock');
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      createObjectURL.mockRestore();
    });

    it('passes a blob: URL through unchanged, with no HTTP request', async () => {
      expect(await service.fetchAsBlobUrl('blob:abc')).toBe('blob:abc');
    });

    it('passes a data: URL through unchanged, with no HTTP request', async () => {
      expect(await service.fetchAsBlobUrl('data:image/png;base64,AA==')).toBe(
        'data:image/png;base64,AA==',
      );
    });

    it('caches by raw URL — a second fetch of the same slice does not re-request it', async () => {
      jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
      const first = service.fetchAsBlobUrl('/api/preview?info=abc');
      http.expectOne('/api/preview?info=abc').flush(new Blob());
      await first;

      const second = await service.fetchAsBlobUrl('/api/preview?info=abc');
      expect(second).toBe('blob:mock');
      http.verify(); // no second outstanding request
    });
  });

  describe('fetchAsBitmap', () => {
    it('fetches a URL through HttpClient and decodes it as an ImageBitmap', async () => {
      const promise = service.fetchAsBitmap('/api/preview?info=abc');
      const req = http.expectOne('/api/preview?info=abc');
      const blob = new Blob(['x']);
      req.flush(blob);

      await promise;
      expect(createImageBitmap).toHaveBeenCalledWith(blob);
    });

    it('reads a blob:/data: URL directly (browser fetch), never through HttpClient', async () => {
      // The processing-pipeline preview emits tiled:false with an in-memory
      // blob: URL — it needs no auth and isn't a server URL. Routing it through
      // HttpClient's interceptor would break it; read it directly instead.
      // jsdom has no global fetch, so assign one for this test and restore it.
      const blob = new Blob(['x']);
      const fetchMock = jest.fn().mockResolvedValue({ blob: () => Promise.resolve(blob) });
      const original = (globalThis as { fetch?: unknown }).fetch;
      (globalThis as { fetch?: unknown }).fetch = fetchMock;
      try {
        await service.fetchAsBitmap('blob:abc-123');
        expect(fetchMock).toHaveBeenCalledWith('blob:abc-123');
        expect(createImageBitmap).toHaveBeenCalledWith(blob);
        http.verify(); // no HttpClient request was issued
      } finally {
        (globalThis as { fetch?: unknown }).fetch = original;
      }
    });
  });

  describe('noteActiveFile', () => {
    it('revokes cached blob URLs when a genuinely different file is noted', async () => {
      const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
      const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

      service.noteActiveFile('a.dcm');
      const fetched = service.fetchAsBlobUrl('/api/preview?info=a');
      http.expectOne('/api/preview?info=a').flush(new Blob());
      await fetched;

      service.noteActiveFile('b.dcm'); // different file — evicts a.dcm's cached blob
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');

      // Re-fetching the same URL after eviction issues a fresh request.
      const refetched = service.fetchAsBlobUrl('/api/preview?info=a');
      http.expectOne('/api/preview?info=a').flush(new Blob());
      await refetched;

      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    });

    it('does not evict when the same file is noted again (e.g. a second backend loading it)', async () => {
      const createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
      const revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

      service.noteActiveFile('a.dcm');
      const fetched = service.fetchAsBlobUrl('/api/preview?info=a');
      http.expectOne('/api/preview?info=a').flush(new Blob());
      await fetched;

      service.noteActiveFile('a.dcm'); // same file — cache stays warm
      expect(revokeObjectURL).not.toHaveBeenCalled();

      expect(await service.fetchAsBlobUrl('/api/preview?info=a')).toBe('blob:mock');
      http.verify(); // no re-request — still cached

      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    });
  });
});
