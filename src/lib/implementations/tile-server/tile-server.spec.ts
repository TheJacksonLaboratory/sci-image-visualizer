import { HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { Observable, Subject, of, throwError } from 'rxjs';

import {
  FetchJson,
  HISTOGRAM_CACHE_BUSTER,
  JsonResponse,
  TileDescriptor,
  buildTileUrl,
  exportTiffFilename,
  exportTiffUrl,
  fetchJsonWithAuth,
  fetchWithAuth,
  httpFetchJson,
  isAbortError,
  nativeHistogram,
  nativeHistogramUrl,
  pollDescriptor,
  tilesInfoUrl,
} from './index';
import { buildTileUrl as osdBuildTileUrl } from '../osd/tile-client';

const DESC: TileDescriptor = {
  width: 8,
  height: 8,
  tileSize: 512,
  z: 1,
  channels: 1,
  levels: [{ res: 0, width: 8, height: 8 }],
};

describe('tile-server: URLs', () => {
  it('builds the /tiles/info, /histogram and /export/tiff URLs', () => {
    expect(tilesInfoUrl('a/', 'I')).toBe('a/tiles/info?info=I');
    expect(nativeHistogramUrl('a/', 'I', { z: 2, channel: 1, bins: 64 }, 7)).toBe(
      'a/histogram?info=I&channel=1&z=2&bins=64&_=7',
    );
    // The default cache-buster is the per-app-load one.
    expect(nativeHistogramUrl('a/', 'I', { z: 0, channel: 0, bins: 256 })).toContain(
      `&_=${HISTOGRAM_CACHE_BUSTER}`,
    );
  });

  it('sends `channels` only when some, but not all, channels are visible', () => {
    expect(exportTiffUrl('a/', 'I', 3, [0, 2], 3)).toBe('a/export/tiff?info=I&z=3&channels=0,2');
    expect(exportTiffUrl('a/', 'I', 3, [0, 1, 2], 3)).toBe('a/export/tiff?info=I&z=3');
    expect(exportTiffUrl('a/', 'I', 0, [], 3)).toBe('a/export/tiff?info=I&z=0');
  });

  it('names the TIFF export after the file stem', () => {
    expect(exportTiffFilename('slide.ome.tif')).toBe('slide.ome_16bit.ome.tif');
    expect(exportTiffFilename(undefined)).toBe('image_16bit.ome.tif');
  });

  it('keeps buildTileUrl re-exported from the OSD tile client', () => {
    expect(osdBuildTileUrl).toBe(buildTileUrl);
  });
});

describe('tile-server: pollDescriptor', () => {
  const answers = (...rs: Array<JsonResponse<unknown> | Error>) => {
    const fn = jest.fn((_url: string, _signal?: AbortSignal) => {
      const r = rs.length > 1 ? rs.shift()! : rs[0];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    });
    return fn as unknown as jest.Mock & FetchJson;
  };
  const opts = { deadlineMs: 10000, intervalMs: 1000, tag: '[t]' };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  it('issues the first request synchronously and re-polls only on 202', async () => {
    const caching = { status: 202, body: null };
    const fetchJson = answers(caching, caching, { status: 200, body: DESC });
    const p = pollDescriptor(fetchJson, 'u', opts);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual(DESC);
    expect(fetchJson).toHaveBeenCalledTimes(3);
  });

  it('answers null at once on any status other than 202 (OSD used to retry)', async () => {
    const fetchJson = answers({ status: 404, body: null });
    await expect(pollDescriptor(fetchJson, 'u', opts)).resolves.toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('answers null for a 200 without pyramid levels', async () => {
    const fetchJson = answers({ status: 200, body: { ...DESC, levels: [] } });
    await expect(pollDescriptor(fetchJson, 'u', opts)).resolves.toBeNull();
  });

  it('retries a transport failure like a 202', async () => {
    const fetchJson = answers(new Error('network'), { status: 200, body: DESC });
    const p = pollDescriptor(fetchJson, 'u', opts);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual(DESC);
  });

  it('answers null once the deadline passes (OSD used to throw)', async () => {
    const fetchJson = answers({ status: 202, body: null });
    const p = pollDescriptor(fetchJson, 'u', { ...opts, deadlineMs: 2500 });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeNull();
    expect(fetchJson.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('times a hung request out and polls again', async () => {
    let calls = 0;
    const fetchJson = jest.fn((_u: string, signal?: AbortSignal) => {
      calls++;
      if (calls > 1) return Promise.resolve({ status: 200, body: DESC });
      return new Promise((_r, reject) => signal!.addEventListener('abort', () => reject(new Error('timeout'))));
    }) as unknown as FetchJson;
    const p = pollDescriptor(fetchJson, 'u', { ...opts, requestTimeoutMs: 500 });
    await jest.advanceTimersByTimeAsync(1500);
    await expect(p).resolves.toEqual(DESC);
  });

  it('rejects with an AbortError when aborted between polls', async () => {
    const fetchJson = answers({ status: 202, body: null });
    const ctl = new AbortController();
    const p = pollDescriptor(fetchJson, 'u', { ...opts, signal: ctl.signal });
    const settled = p.catch((e) => e);
    await jest.advanceTimersByTimeAsync(10);
    ctl.abort();
    const err = await settled;
    expect(isAbortError(err)).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('rejects with an AbortError when aborted mid-request, passing the abort to the transport', async () => {
    const fetchJson = jest.fn(
      (_u: string, signal?: AbortSignal) =>
        new Promise((_r, reject) => signal!.addEventListener('abort', () => reject(new Error('cancelled')))),
    ) as unknown as FetchJson;
    const ctl = new AbortController();
    const p = pollDescriptor(fetchJson, 'u', { ...opts, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not poll at all under an already-aborted signal', async () => {
    const fetchJson = answers({ status: 202, body: null });
    const ctl = new AbortController();
    ctl.abort();
    await expect(pollDescriptor(fetchJson, 'u', { ...opts, signal: ctl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('tile-server: transports', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('fetchWithAuth adds the host auth headers, and falls back to none when they fail', async () => {
    const fetch = jest.fn().mockResolvedValue({ status: 200 });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    await fetchWithAuth({ getAuthHeaders: () => Promise.resolve({ Authorization: 'Bearer t' }) }, 'u', {
      headers: { Accept: 'x' },
    });
    expect(fetch).toHaveBeenLastCalledWith('u', { headers: { Authorization: 'Bearer t', Accept: 'x' } });
    await fetchWithAuth({ getAuthHeaders: () => Promise.reject(new Error('no token')) }, 'u');
    expect(fetch).toHaveBeenLastCalledWith('u', { headers: {} });
  });

  it('fetchJsonWithAuth parses a 200 and passes other statuses through bodiless', async () => {
    const auth = { getAuthHeaders: () => Promise.resolve({}) };
    globalThis.fetch = jest.fn().mockResolvedValue({ status: 200, json: () => Promise.resolve(DESC) }) as never;
    await expect(fetchJsonWithAuth(auth)('u')).resolves.toEqual({ status: 200, body: DESC });
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue({ status: 202, json: () => Promise.reject(new Error('empty')) }) as never;
    await expect(fetchJsonWithAuth(auth)('u')).resolves.toEqual({ status: 202, body: null });
  });

  it('fetchJsonWithAuth hands the abort signal to fetch', async () => {
    const fetch = jest.fn().mockResolvedValue({ status: 404 });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const ctl = new AbortController();
    await fetchJsonWithAuth({ getAuthHeaders: () => Promise.resolve({}) })('u', ctl.signal);
    expect(fetch.mock.calls[0][1].signal).toBe(ctl.signal);
  });

  it('httpFetchJson resolves the response status, including HTTP error statuses', async () => {
    const http = (o: Observable<unknown>) => ({ get: jest.fn().mockReturnValue(o) }) as never;
    await expect(httpFetchJson(http(of(new HttpResponse({ status: 202, body: null }))))('u')).resolves.toEqual({
      status: 202,
      body: null,
    });
    await expect(
      httpFetchJson(http(throwError(() => new HttpErrorResponse({ status: 500 }))))('u'),
    ).resolves.toEqual({ status: 500, body: null });
    // No response at all (status 0) is a transport failure.
    await expect(
      httpFetchJson(http(throwError(() => new HttpErrorResponse({ status: 0 }))))('u'),
    ).rejects.toBeInstanceOf(HttpErrorResponse);
  });

  it('httpFetchJson cancels the request on abort and rejects with an AbortError', async () => {
    const response = new Subject<unknown>();
    const http = { get: jest.fn().mockReturnValue(response) } as never;
    const ctl = new AbortController();
    const p = httpFetchJson(http)('u', ctl.signal);
    expect(response.observed).toBe(true);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(response.observed).toBe(false); // unsubscribed → the XHR is cancelled
  });
});

describe('tile-server: nativeHistogram', () => {
  const WIRE = {
    bitDepth: 16,
    rangeMin: 96,
    rangeMax: 150,
    observedMin: 96,
    observedMax: 150,
    binWidth: 0.5,
    counts: [4, 0, 8],
  };

  it('maps HistogramInfo to native bin edges, from the cache-busted URL', async () => {
    const fetchJson = jest.fn().mockResolvedValue({ status: 200, body: WIRE }) as unknown as jest.Mock & FetchJson;
    const h = (await nativeHistogram(fetchJson, 'a/', 'I', { z: 1, channel: 2, bins: 3 }))!;
    expect(fetchJson.mock.calls[0][0]).toBe(`a/histogram?info=I&channel=2&z=1&bins=3&_=${HISTOGRAM_CACHE_BUSTER}`);
    expect(h.bins).toEqual([96, 96.5, 97]);
    expect(h.max).toBe(8);
    expect(h).toMatchObject({ bitDepth: 16, rangeMin: 96, rangeMax: 150, observedMin: 96, observedMax: 150 });
  });

  it('answers null while the server is caching (202) or has no counts', async () => {
    const fetchJson = jest
      .fn()
      .mockResolvedValueOnce({ status: 202, body: null })
      .mockResolvedValueOnce({ status: 200, body: {} }) as unknown as FetchJson;
    await expect(nativeHistogram(fetchJson, 'a/', 'I', { z: 0, channel: 0, bins: 3 })).resolves.toBeNull();
    await expect(nativeHistogram(fetchJson, 'a/', 'I', { z: 0, channel: 0, bins: 3 })).resolves.toBeNull();
  });
});
