import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { NativeHistogramRequest, nativeHistogramUrl } from './tile-protocol';
import { FetchJson } from './transport';

/** The server's `/histogram` answer (HistogramInfo). */
export interface NativeHistogramWire {
  bitDepth: number;
  rangeMin: number;
  rangeMax: number;
  observedMin: number;
  observedMax: number;
  binWidth: number;
  counts: number[];
}

/** Map the server's HistogramInfo to an {@link IHistogram} with native bin left-edges
 *  (`rangeMin + i * binWidth`). */
export function toNativeHistogram(hi: NativeHistogramWire): IHistogram {
  return {
    bins: hi.counts.map((_, i) => hi.rangeMin + i * hi.binWidth),
    counts: hi.counts,
    max: hi.counts.reduce((m, c) => (c > m ? c : m), 0),
    bitDepth: hi.bitDepth,
    rangeMin: hi.rangeMin,
    rangeMax: hi.rangeMax,
    observedMin: hi.observedMin,
    observedMax: hi.observedMax,
  };
}

/**
 * One channel's native-bit-depth histogram from `GET /histogram` (>8-bit images: the 8-bit display
 * tiles cannot carry 16-bit values). The URL carries the per-app-load cache-buster.
 *
 * Resolves null when the server has no answer yet (202 while caching, or another status, or no
 * counts) — the caller's pane retries. Transport failures propagate, so each backend keeps its
 * own tagged catch; caching is the caller's too.
 */
export async function nativeHistogram(
  fetchJson: FetchJson,
  api: string,
  infoB64: string,
  req: NativeHistogramRequest,
  signal?: AbortSignal,
): Promise<IHistogram | null> {
  const resp = await fetchJson<NativeHistogramWire>(nativeHistogramUrl(api, infoB64, req), signal);
  if (resp.status !== 200 || !resp.body?.counts) return null;
  return toNativeHistogram(resp.body);
}
