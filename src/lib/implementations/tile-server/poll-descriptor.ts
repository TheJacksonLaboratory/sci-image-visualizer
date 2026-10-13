import { TileDescriptor } from './tile-protocol';
import { FetchJson, abortError, abortableDelay, timeoutSignal } from './transport';

/** Timing of one {@link pollDescriptor} run. */
export interface PollDescriptorOptions {
  /** Give up (resolve null) once this long has passed without a descriptor. */
  deadlineMs: number;
  /** Wait between two polls while the server answers 202. */
  intervalMs: number;
  /** Per-request timeout, so a hung request cannot outlive the deadline. Default 45 s. */
  requestTimeoutMs?: number;
  /** Abort the whole poll: it then rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Log prefix for the poll's warnings, e.g. `[OSD]`. */
  tag?: string;
}

/** Default per-request timeout of {@link pollDescriptor}. */
export const DESCRIPTOR_REQUEST_TIMEOUT_MS = 45000;

/**
 * Poll `GET /tiles/info` until the server describes the source.
 *
 * The server answers 202 while it is still caching the source (GCS → PVC, which can take minutes
 * for a cold whole-slide image) and 200 with the descriptor once ready. So:
 *  - **202** → wait `intervalMs` and poll again, until `deadlineMs`;
 *  - **200 with levels** → the descriptor;
 *  - **any other status**, or a 200 without levels → `null` at once: this server will not describe
 *    the source, and polling it for minutes only delays the caller's fallback (NAPARI-SVC-3);
 *  - a **transport failure** (network error, per-request timeout) → retried like a 202: a large
 *    image always passes through a busy window, and one bad poll must not abandon it;
 *  - the **deadline** passing → `null`.
 *
 * The first request is issued synchronously, before the returned promise first awaits. Rejects
 * with an `AbortError` as soon as `signal` aborts (between polls, or mid-request when the
 * transport honours the signal).
 *
 * These are the napari-js backend's hardened semantics; the OpenSeadragon backend used to throw on
 * the deadline and to retry every error status. It now shares this answer and turns `null` into
 * its own load failure (see `OpenSeadragonVisualizerService.load`).
 */
export async function pollDescriptor(
  fetchJson: FetchJson,
  url: string,
  opts: PollDescriptorOptions,
): Promise<TileDescriptor | null> {
  const { signal } = opts;
  const tag = opts.tag ?? '[tiles]';
  const requestTimeoutMs = opts.requestTimeoutMs ?? DESCRIPTOR_REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + opts.deadlineMs;
  for (;;) {
    if (signal?.aborted) throw abortError();
    const req = timeoutSignal(signal, requestTimeoutMs);
    try {
      const resp = await fetchJson<TileDescriptor>(url, req.signal);
      if (signal?.aborted) throw abortError();
      if (resp.status === 200) {
        if (resp.body?.levels?.length) return resp.body;
        console.warn(`${tag} tiles/info answered without levels`);
        return null;
      }
      if (resp.status !== 202) {
        console.warn(`${tag} tiles/info → ${resp.status}`);
        return null;
      }
      // 202: still caching → re-poll until the deadline.
    } catch (err) {
      if (signal?.aborted) throw abortError();
      console.warn(`${tag} tiles/info poll retry`, err);
    } finally {
      req.done();
    }
    if (Date.now() > deadline) {
      console.warn(`${tag} tiles/info not ready before the deadline — file still caching`);
      return null;
    }
    await abortableDelay(opts.intervalMs, signal);
  }
}
