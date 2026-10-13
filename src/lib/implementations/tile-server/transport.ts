import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';

/**
 * Transport for the jit-service tile protocol.
 *
 * Two transports exist on purpose, and each backend uses exactly one:
 *  - **napari-js** fetches with the browser's `fetch` (its tile loader, the worker-free slice
 *    stitcher and the volume preload all need a `Response`), through {@link fetchWithAuth}: the one
 *    place the host's `getAuthHeaders()` is resolved, with its "no token → cookie auth" fallback.
 *  - **OpenSeadragon** keeps Angular's `HttpClient`, so the host's interceptors (auth, retry,
 *    logging) apply exactly as before; {@link httpFetchJson} adapts it.
 *
 * The protocol helpers ({@link pollDescriptor}, {@link nativeHistogram}) take a {@link FetchJson}
 * and so run the same code over either one.
 */

/** Auth header provider — the subset of `TileAccessPort` the transport needs. */
export interface AuthHeaderSource {
  getAuthHeaders(): Promise<Record<string, string>>;
}

/** Resolve the host's auth headers; a failure means cookie / anonymous auth (`{}`). */
export function resolveAuthHeaders(src: AuthHeaderSource): Promise<Record<string, string>> {
  return src.getAuthHeaders().catch(() => ({}) as Record<string, string>);
}

/** `fetch` with the host's auth headers (merged under any `init.headers`). */
export async function fetchWithAuth(
  auth: AuthHeaderSource,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = await resolveAuthHeaders(auth);
  return fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
}

/** A JSON GET's status and parsed body (null when there is none, or it is not JSON). */
export interface JsonResponse<T> {
  status: number;
  body: T | null;
}

/**
 * A JSON GET. Resolves with any HTTP status the server answered (2xx or not); rejects on a
 * transport failure (network error, CORS) and as soon as `signal` aborts.
 */
export type FetchJson = <T>(url: string, signal?: AbortSignal) => Promise<JsonResponse<T>>;

/** {@link FetchJson} over {@link fetchWithAuth}. */
export function fetchJsonWithAuth(auth: AuthHeaderSource): FetchJson {
  return async <T>(url: string, signal?: AbortSignal): Promise<JsonResponse<T>> => {
    const resp = await fetchWithAuth(auth, url, signal ? { signal } : {});
    if (resp.status !== 200) return { status: resp.status, body: null };
    return { status: resp.status, body: ((await resp.json()) as T) ?? null };
  };
}

/**
 * {@link FetchJson} over Angular's `HttpClient` (its interceptors apply). An HTTP error status is
 * resolved, not thrown; status 0 (no response at all) stays a rejection. An abort unsubscribes,
 * which cancels the XHR.
 */
export function httpFetchJson(http: HttpClient): FetchJson {
  return async <T>(url: string, signal?: AbortSignal): Promise<JsonResponse<T>> => {
    try {
      const resp = await firstValueFromAbortable(http.get<T>(url, { observe: 'response' }), signal);
      return { status: resp.status, body: resp.body ?? null };
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status > 0) return { status: err.status, body: null };
      throw err;
    }
  };
}

/**
 * `firstValueFrom` that unsubscribes (for `HttpClient`, cancels the XHR) and rejects with an
 * {@link abortError} as soon as `signal` aborts. The subscription is made synchronously.
 */
export function firstValueFromAbortable<T>(source: Observable<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const settle = (): void => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      settle();
      sub.unsubscribe();
      reject(abortError());
    };
    const sub = source.subscribe({
      next: (v) => {
        if (settled) return;
        settle();
        resolve(v);
        queueMicrotask(() => sub?.unsubscribe());
      },
      error: (err: unknown) => {
        if (settled) return;
        settle();
        reject(err);
      },
      complete: () => {
        if (settled) return;
        settle();
        reject(new Error('no elements in sequence'));
      },
    });
    if (!settled) signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── AbortSignal helpers ─────────────────────────────────────────────────────

/** The error an aborted operation rejects with (`name === 'AbortError'`, as `fetch` uses). */
export function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Whether `err` is an abort (from {@link abortError}, `fetch`, or `AbortSignal.reason`). */
export function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/** Throw an {@link abortError} when `signal` has aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Resolve after `ms`, or reject with an {@link abortError} as soon as `signal` aborts. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A signal that aborts when `parent` does, or after `timeoutMs`. Call `done()` once the guarded
 * request settles, to clear the timer and the parent listener.
 */
export function timeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; done(): void } {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  if (parent?.aborted) ctl.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
